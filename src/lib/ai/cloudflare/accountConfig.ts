import { createHash } from "node:crypto";
import type { CloudflareAccount, PoolConfig, RateLimit } from "./types";

const DEFAULT_ASR_MODEL = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MODEL_PATTERN = /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i;
const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/i;
const MAX_ACCOUNTS = 32;
const MAX_MODELS_PER_TASK = 32;

export type PoolEnvironment = Readonly<Record<string, string | undefined>>;

/** Contains only a fixed reason code, never an input value or credential. */
export class PoolConfigurationError extends Error {
  constructor(readonly reason: string) {
    super("Cloudflare pool configuration is invalid.");
    this.name = "PoolConfigurationError";
  }
}

function fail(reason: string): never {
  throw new PoolConfigurationError(reason);
}

function record(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("unknown_config_field");
  }
}

function integer(value: unknown, max: number, reason: string, min = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(reason);
  }
  return value;
}

function envInteger(
  env: PoolEnvironment,
  name: string,
  fallback: number,
  max: number,
  min = 1,
) {
  const raw = env[name]?.trim();
  return raw ? integer(Number(raw), max, "invalid_numeric_setting", min) : fallback;
}

function rateLimit(value: unknown): RateLimit {
  const source = record(value, "invalid_quota");
  knownKeys(source, ["rpm", "burst", "maxConcurrent"]);
  return Object.freeze({
    rpm: integer(source.rpm, 1_000_000, "invalid_quota"),
    burst: integer(source.burst, 10_000, "invalid_quota"),
    maxConcurrent: integer(source.maxConcurrent, 10_000, "invalid_quota"),
  });
}

function models(value: unknown, tts = false): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS_PER_TASK) fail("invalid_capabilities");
  const result = value.map((entry: unknown) => {
    if (typeof entry !== "string" || entry.length > 160 || (!MODEL_PATTERN.test(entry) && !(tts && entry === "xai/grok-tts"))) {
      fail("invalid_capabilities");
    }
    return entry;
  });
  if (new Set(result).size !== result.length) fail("duplicate_model");
  return Object.freeze(result);
}

function modelSetting(env: PoolEnvironment, key: string, fallback: string) {
  const value = env[key]?.trim() || fallback;
  if (!MODEL_PATTERN.test(value) || value.length > 160) fail("invalid_model");
  return value;
}

export function isPoolEnabled(env: PoolEnvironment = process.env): boolean {
  const value = env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  return fail("invalid_feature_flag");
}

/** Explicit production migration; never bypass admission when it is enabled. */
export function isLegacyAdmissionEnabled(env: PoolEnvironment = process.env): boolean {
  const value = env.CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value !== "true") fail("invalid_shared_account_flag");
  if (!isPoolEnabled(env)) fail("shared_account_requires_pool");
  return true;
}

/** Safe to read before parsing an upload; does not inspect credentials or connect Redis. */
export function parseQueueSettings(env: PoolEnvironment = process.env) {
  return {
    maxWaitMs: envInteger(env, "CLOUDFLARE_POOL_MAX_WAIT_MS", 0, 10_000, 0),
    maxInFlight: envInteger(env, "CLOUDFLARE_POOL_MAX_IN_FLIGHT", 20, 1_000),
    maxQueued: envInteger(env, "CLOUDFLARE_POOL_MAX_QUEUED", 40, 1_000, 0),
    maxBufferedBytes: envInteger(env, "CLOUDFLARE_POOL_MAX_BUFFERED_BYTES", 32 * 1024 * 1024, 256 * 1024 * 1024, 1024),
  };
}

/** Called lazily by the pooled workload. Legacy paths must not call this. */
export function parsePoolConfig(env: PoolEnvironment = process.env): PoolConfig {
  const localSharingValue = env.CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST?.trim().toLowerCase();
  if (localSharingValue && localSharingValue !== "true" && localSharingValue !== "false") {
    fail("invalid_local_shared_account_flag");
  }
  const allowLegacyAccountLocalTest = localSharingValue === "true";
  const shareLegacyAccount = isLegacyAdmissionEnabled(env);
  const routingValue = env.CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT?.trim().toLowerCase();
  if (routingValue && routingValue !== "true" && routingValue !== "false") fail("invalid_legacy_routing_flag");
  const routeLegacyAccount = routingValue === "true";
  if (routeLegacyAccount && !shareLegacyAccount) fail("legacy_routing_requires_shared_quota");
  if (shareLegacyAccount && allowLegacyAccountLocalTest) fail("conflicting_shared_account_flags");
  if (allowLegacyAccountLocalTest && env.NODE_ENV && env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    fail("local_shared_account_requires_development");
  }
  const raw = env.CLOUDFLARE_ACCOUNTS_JSON;
  if (!raw || raw.length > 131_072) fail("invalid_registry");
  let registry: unknown;
  try { registry = JSON.parse(raw); } catch { fail("invalid_registry"); }
  if (!Array.isArray(registry) || !registry.length || registry.length > MAX_ACCOUNTS) {
    fail("invalid_registry");
  }

  const aliases = new Set<string>();
  const accountIds = new Set<string>();
  const legacyId = env.CLOUDFLARE_ACCOUNT_ID?.trim().toLowerCase();
  const asrModel = modelSetting(env, "CLOUDFLARE_WORKERS_AI_MODEL", DEFAULT_ASR_MODEL);
  const textModel = modelSetting(env, "CLOUDFLARE_TEXT_MODEL", DEFAULT_TEXT_MODEL);
  const accounts: CloudflareAccount[] = registry.map((value: unknown) => {
    const source = record(value, "invalid_account");
    knownKeys(source, ["alias", "accountId", "apiTokenEnv", "enabled", "capabilities", "limits"]);
    if (typeof source.alias !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(source.alias)) {
      fail("invalid_alias");
    }
    if (aliases.has(source.alias)) fail("duplicate_alias");
    aliases.add(source.alias);
    if (typeof source.accountId !== "string" || !ACCOUNT_PATTERN.test(source.accountId)) {
      fail("invalid_account_id");
    }
    const accountId = source.accountId.toLowerCase();
    if (accountIds.has(accountId)) fail("duplicate_account_id");
    if (legacyId === accountId && !allowLegacyAccountLocalTest && !shareLegacyAccount) fail("legacy_account_in_pool");
    accountIds.add(accountId);
    if (typeof source.enabled !== "boolean") fail("invalid_enabled");
    if (typeof source.apiTokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(source.apiTokenEnv)) {
      fail("invalid_token_reference");
    }
    if (source.apiTokenEnv === "CLOUDFLARE_WORKERS_AI_API_TOKEN") fail("legacy_token_in_pool");
    const apiToken = env[source.apiTokenEnv]?.trim() || "";
    if (source.enabled && (!apiToken || /[\r\n]/.test(apiToken))) fail("missing_or_invalid_token");
    const capabilities = record(source.capabilities, "invalid_capabilities");
    knownKeys(capabilities, ["asr", "text", "tts"]);
    const asr = models(capabilities.asr);
    const text = models(capabilities.text);
    const tts = capabilities.tts === undefined ? undefined : models(capabilities.tts, true);
    if (source.enabled && !asr.includes(asrModel) && !text.includes(textModel) && !tts?.length) {
      fail("no_configured_model_capability");
    }
    const limits = record(source.limits, "invalid_quota");
    knownKeys(limits, ["asr", "text", "tts", "accountMaxConcurrent", "models"]);
    if (Boolean(tts?.length) !== (limits.tts !== undefined)) fail("missing_tts_quota_or_capability");
    let modelLimits: Readonly<Record<string, RateLimit>> | undefined;
    if (limits.models !== undefined) {
      const input = record(limits.models, "invalid_model_quota");
      if (Object.keys(input).length > MAX_MODELS_PER_TASK * 2) fail("invalid_model_quota");
      const result: Record<string, RateLimit> = Object.create(null);
      for (const [model, rule] of Object.entries(input)) {
        if (!asr.includes(model) && !text.includes(model) && !tts?.includes(model)) fail("unsupported_model_quota");
        result[model] = rateLimit(rule);
      }
      modelLimits = Object.freeze(result);
    }
    return Object.freeze({
      alias: source.alias,
      accountId,
      identity: createHash("sha256").update(accountId).digest("hex"),
      apiToken,
      enabled: source.enabled,
      capabilities: Object.freeze({ asr, text, ...(tts ? { tts } : {}) }),
      limits: Object.freeze({
        asr: rateLimit(limits.asr),
        text: rateLimit(limits.text),
        ...(limits.tts !== undefined ? { tts: rateLimit(limits.tts) } : {}),
        accountMaxConcurrent: integer(limits.accountMaxConcurrent, 10_000, "invalid_quota"),
        ...(modelLimits ? { models: modelLimits } : {}),
      }),
    });
  });
  const legacyAccount = shareLegacyAccount ? accounts.find(account => account.enabled && account.accountId === legacyId) : undefined;
  if (shareLegacyAccount && !legacyAccount) fail("missing_shared_legacy_account");
  if (legacyAccount) {
    const legacyModels = {
      asr: [asrModel, modelSetting(env, "CLOUDFLARE_ASR_MODEL", asrModel)],
      text: env.CLOUDFLARE_TEXT_MODEL?.trim() ? [textModel] : [textModel, "@cf/qwen/qwen3-30b-a3b-fp8"],
      tts: [modelSetting(env, "CLOUDFLARE_TTS_MODEL", "@cf/deepgram/aura-1"), "xai/grok-tts"],
    };
    for (const task of ["asr", "text", "tts"] as const) {
      if (!legacyModels[task].every(model => legacyAccount.capabilities[task]?.includes(model))) {
        fail("missing_legacy_model_capability");
      }
    }
  }
  if (!accounts.some((account) => account.enabled && account.capabilities.asr.includes(asrModel)) ||
      !accounts.some((account) => account.enabled && account.capabilities.text.includes(textModel))) {
    fail("missing_model_capability");
  }

  const store = env.CLOUDFLARE_POOL_STORE?.trim() || "redis";
  if (store !== "redis" && store !== "memory") fail("invalid_store");
  if (store === "memory" && env.NODE_ENV === "production") fail("memory_store_in_production");
  let redisUrl: string | undefined;
  if (store === "redis") {
    redisUrl = env.CLOUDFLARE_POOL_REDIS_URL?.trim();
    if (!redisUrl) fail("missing_redis_url");
    try {
      const parsed = new URL(redisUrl);
      if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search) {
        fail("invalid_redis_url");
      }
    } catch { fail("invalid_redis_url"); }
    if (allowLegacyAccountLocalTest && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redisUrl).hostname)) {
      fail("local_shared_account_requires_loopback_store");
    }
  }
  const namespace = env.CLOUDFLARE_POOL_NAMESPACE?.trim() || "speaking-ai-cf-quota-v1";
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(namespace)) fail("invalid_namespace");
  const { maxWaitMs, maxInFlight, maxQueued, maxBufferedBytes } = parseQueueSettings(env);
  const textBacklogThreshold = envInteger(env, "CLOUDFLARE_POOL_TEXT_BACKLOG_THRESHOLD", 0, 1000, 0);
  const maxAttemptsPerStage = envInteger(env, "CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_STAGE", 2, 2);
  const maxAttemptsPerRequest = envInteger(env, "CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_REQUEST", 3, 3);
  const minAttemptMs = envInteger(env, "CLOUDFLARE_POOL_MIN_ATTEMPT_MS", 250, 30_000);
  const suppliedVersion = env.CLOUDFLARE_POOL_CONFIG_VERSION?.trim();
  if (suppliedVersion && !/^[a-zA-Z0-9._-]{1,64}$/.test(suppliedVersion)) fail("invalid_config_version");
  const configVersion = suppliedVersion || createHash("sha256").update(JSON.stringify({
    accounts: accounts.map(({ identity, alias, enabled, capabilities, limits }) => ({ identity, alias, enabled, capabilities, limits })),
    store, namespace, maxAttemptsPerStage, maxAttemptsPerRequest, maxWaitMs, maxInFlight, maxQueued, maxBufferedBytes, minAttemptMs, textBacklogThreshold,
    allowLegacyAccountLocalTest,
    shareLegacyAccount,
    routeLegacyAccount,
  })).digest("hex").slice(0, 16);
  return Object.freeze({
    accounts: Object.freeze(accounts), store, redisUrl, namespace, configVersion,
    ...(legacyAccount ? { legacyAccountIdentity: legacyAccount.identity, routeLegacyAccount } : {}),
    maxAttemptsPerStage, maxAttemptsPerRequest, maxWaitMs, maxInFlight, maxQueued, maxBufferedBytes, minAttemptMs, textBacklogThreshold,
  });
}
