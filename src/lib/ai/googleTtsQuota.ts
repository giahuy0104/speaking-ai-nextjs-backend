import { randomUUID } from "node:crypto";

/**
 * Google Cloud TTS project quotas, counted for every backend together (Redis), so a
 * call over quota is refused here at once instead of by Google (RESOURCE_EXHAUSTED)
 * after the request was sent. Project limits (checked 2026-11-19):
 * - Chirp 3 HD: 200 requests/minute and 100 concurrent StreamingSynthesize sessions;
 * - Neural2: 1,000 requests/minute;
 * - all voices together (Chirp 3 HD, Neural2, WaveNet, Standard): 1,000 requests/minute.
 * Defaults stay ~10% under each limit (Google's own window is not exactly ours).
 * Without GOOGLE_TTS_QUOTA_REDIS_URL the counts are per process (one backend only).
 */

export type GoogleQuotaRuleName = "chirp3_rpm" | "chirp3_streams" | "neural2_rpm" | "all_rpm";

type Rule = Readonly<{ name: GoogleQuotaRuleName; kind: "rate" | "lease"; limit: number }>;

export type GoogleQuotaRequest = Readonly<{ voiceName: string; stream: boolean }>;

export type GoogleQuotaGrant = Readonly<{ release: () => void }>;

export class GoogleQuotaExceededError extends Error {
  constructor(readonly rule: GoogleQuotaRuleName) {
    super(`Google TTS quota exceeded: ${rule}`);
    this.name = "GoogleQuotaExceededError";
  }
}

export interface GoogleQuotaStore {
  /** Admits the call under every rule at once, or names the first rule that is full. */
  acquire(rules: readonly Rule[], member: string, leaseMs: number): Promise<GoogleQuotaRuleName | null>;
  releaseLease(rule: GoogleQuotaRuleName, member: string): Promise<void>;
}

const WINDOW_MS = 60_000;
// A stream lease outlives the longest stream (GOOGLE_TTS_STREAM_TIMEOUT_MS, 20 s) and
// expires on its own if a backend dies holding it.
const DEFAULT_LEASE_MS = 30_000;

const DEFAULT_LIMITS: Readonly<Record<GoogleQuotaRuleName, number>> = {
  chirp3_rpm: 180,
  chirp3_streams: 90,
  neural2_rpm: 900,
  all_rpm: 900,
};

const ENV_NAMES: Readonly<Record<GoogleQuotaRuleName, string>> = {
  chirp3_rpm: "GOOGLE_TTS_QUOTA_CHIRP3_RPM",
  chirp3_streams: "GOOGLE_TTS_QUOTA_CHIRP3_STREAMS",
  neural2_rpm: "GOOGLE_TTS_QUOTA_NEURAL2_RPM",
  all_rpm: "GOOGLE_TTS_QUOTA_ALL_RPM",
};

type EnvSource = Readonly<Record<string, string | undefined>>;

function limitFor(rule: GoogleQuotaRuleName, env: EnvSource) {
  const value = Number(env[ENV_NAMES[rule]]);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMITS[rule];
}

export function googleQuotaEnabled(env: EnvSource = process.env) {
  return env.GOOGLE_TTS_QUOTA_ENABLED?.trim().toLowerCase() !== "false";
}

/** The quota rules one call counts against, from its full voice name (e.g. cmn-CN-Chirp3-HD-Aoede). */
export function googleQuotaRules(request: GoogleQuotaRequest, env: EnvSource = process.env): Rule[] {
  const rule = (name: GoogleQuotaRuleName, kind: Rule["kind"]): Rule => ({ name, kind, limit: limitFor(name, env) });
  const rules = [rule("all_rpm", "rate")];
  if (request.voiceName.includes("-Chirp3-HD-")) {
    rules.push(rule("chirp3_rpm", "rate"));
    if (request.stream) rules.push(rule("chirp3_streams", "lease"));
  } else if (request.voiceName.includes("-Neural2-")) {
    rules.push(rule("neural2_rpm", "rate"));
  }
  return rules;
}

/** One process only: counts are not shared with other backends. */
export function createMemoryGoogleQuotaStore(now: () => number = Date.now): GoogleQuotaStore {
  const entries = new Map<GoogleQuotaRuleName, Map<string, number>>();
  const entriesOf = (name: GoogleQuotaRuleName) => {
    let map = entries.get(name);
    if (!map) entries.set(name, map = new Map());
    return map;
  };
  const prune = (rule: Rule, at: number) => {
    const map = entriesOf(rule.name);
    // Rate entries hold their start time; leases hold their expiry.
    for (const [member, score] of map) {
      if (rule.kind === "rate" ? score <= at - WINDOW_MS : score <= at) map.delete(member);
    }
    return map;
  };
  return {
    async acquire(rules, member, leaseMs) {
      const at = now();
      for (const rule of rules) if (prune(rule, at).size >= rule.limit) return rule.name;
      for (const rule of rules) entriesOf(rule.name).set(member, rule.kind === "rate" ? at : at + leaseMs);
      return null;
    },
    async releaseLease(name, member) {
      entriesOf(name).delete(member);
    },
  };
}

// Sliding one-minute log per rate rule and expiring leases per lease rule, all checked
// and recorded in one atomic step. Keys share a hash tag for Redis Cluster.
const ACQUIRE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local rules = cjson.decode(ARGV[1])
local member = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
for index, rule in ipairs(rules) do
  local key = KEYS[index]
  if rule.kind == 'rate' then
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
  else
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  end
  if redis.call('ZCARD', key) >= rule.limit then return rule.name end
end
for index, rule in ipairs(rules) do
  local key = KEYS[index]
  if rule.kind == 'rate' then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, windowMs + 1000)
  else
    redis.call('ZADD', key, now + leaseMs, member)
    redis.call('PEXPIRE', key, leaseMs + 1000)
  end
end
return ''
`;

export type QuotaRedisClient = Readonly<{ sendCommand(args: readonly string[]): Promise<unknown> }>;

export function createRedisGoogleQuotaStore(client: () => Promise<QuotaRedisClient>, namespace = "homi:google-tts"): GoogleQuotaStore {
  const keyOf = (name: GoogleQuotaRuleName) => `{${namespace}}:${name}`;
  return {
    async acquire(rules, member, leaseMs) {
      const reply = await (await client()).sendCommand([
        "EVAL", ACQUIRE_SCRIPT, String(rules.length), ...rules.map(rule => keyOf(rule.name)),
        JSON.stringify(rules), member, String(leaseMs), String(WINDOW_MS),
      ]);
      return typeof reply === "string" && reply !== "" ? reply as GoogleQuotaRuleName : null;
    },
    async releaseLease(name, member) {
      await (await client()).sendCommand(["ZREM", keyOf(name), member]);
    },
  };
}

export type GoogleQuotaOptions = Readonly<{
  store: GoogleQuotaStore;
  leaseMs?: number;
  /** Redis unreachable: the call goes on (speech matters more than an exact count). */
  onStoreError?: (error: unknown) => void;
  env?: EnvSource;
}>;

export function createGoogleQuota(options: GoogleQuotaOptions) {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const env = options.env ?? process.env;
  return {
    /** Resolves with a grant (release it when a stream ends); throws GoogleQuotaExceededError when full. */
    async acquire(request: GoogleQuotaRequest): Promise<GoogleQuotaGrant> {
      const rules = googleQuotaRules(request, env);
      const member = randomUUID();
      let full: GoogleQuotaRuleName | null;
      try {
        full = await options.store.acquire(rules, member, leaseMs);
      } catch (error) {
        options.onStoreError?.(error);
        return { release: () => undefined };
      }
      if (full) throw new GoogleQuotaExceededError(full);
      const lease = rules.find(rule => rule.kind === "lease");
      let released = false;
      return {
        release: () => {
          if (released || !lease) return;
          released = true;
          options.store.releaseLease(lease.name, member).catch(error => options.onStoreError?.(error));
        },
      };
    },
  };
}
