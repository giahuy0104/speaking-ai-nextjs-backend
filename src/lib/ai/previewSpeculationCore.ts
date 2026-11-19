import { createHash, randomUUID } from "node:crypto";
import type {
  AsrMode,
  ConversationRequest,
  ConversationResponse,
  PracticeContext,
  TargetLanguage,
} from "@/types/conversation";

/**
 * Early translation from /api/conversation/preview.
 *
 * The app recognizes speech on the phone and posts the growing transcript to the
 * preview route while the child is still talking. The final /api/conversation
 * request only arrives after the microphone stops (700 ms of silence), and its
 * text is almost always the last preview's text. When a preview's text stays the
 * same for `debounceMs`, one backend runs the whole turn (translation + speech)
 * and stores the result in the cache Redis, so the final request, whichever of
 * the backends it reaches, returns it instead of starting from scratch.
 *
 * Nothing here is persisted: history and learning still run once, for the final
 * request. A speculation is only reused when the final transcript, after the
 * usual validation and repair, is exactly the speculated one, and each run
 * (`runId`) serves at most one final request: its audio URL may be single-use.
 */

export type SpeculationStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** SET NX: true when this caller created the key. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Atomic compare-and-set: replaces the value only while it is still `expected`. */
  replaceIf(key: string, expected: string, value: string, ttlMs: number): Promise<boolean>;
};

export type SpeculationConfig = {
  enabled: boolean;
  /** How long a preview's text must stay unchanged before its turn is run. */
  debounceMs: number;
  /** How long the final request waits for a speculation that is still running. */
  maxWaitMs: number;
  /** Speculative runs at once on this backend; more previews are skipped (provider quota). */
  maxConcurrent: number;
  pollMs: number;
};

export type PreviewInput = {
  requestId: string;
  clientId: string;
  context: PracticeContext;
  childAge: number;
  sourceText: string;
  /** Sent by newer apps; otherwise the language of this client's last final turn. */
  targetLanguage?: TargetLanguage;
  asrMode?: AsrMode;
};

export type FinalTurnInput = ConversationRequest & {
  requestId: string;
  clientId: string;
};

export type SpeculationFlight = Promise<{ runId: string; result: ConversationResponse } | null>;

type LogLevel = "info" | "warn" | "error";

export type PreviewSpeculationDeps = {
  store: SpeculationStore;
  runPipeline: (input: ConversationRequest) => Promise<ConversationResponse>;
  /** The final request's own transcript validation and repair (transcribeVietnamese). */
  transcribe: (input: ConversationRequest) => Promise<string>;
  config: () => SpeculationConfig;
  /** Load-test installations never speculate (see loadTestPersistence.ts). */
  isLoadTestClient: (clientId: string) => boolean;
  log: (level: LogLevel, event: string, fields: Record<string, unknown>) => void;
  /** Same-process flights, shared by every route bundle of this backend. */
  flights: Map<string, SpeculationFlight>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  createId?: (prefix: string) => string;
};

const KEY_PREFIX = "preview-speculation:v1";
const PENDING_TTL_MS = 15_000;
// The final request normally follows the last preview within a few seconds. Keep
// a result short-lived: its audio URL may be single-use or backed by a job that expires.
const READY_TTL_MS = 15_000;
// Long enough for previews that trail the final request, short enough that the
// child can say the same sentence again a few seconds later and get a new head start.
const DONE_TTL_MS = 3_000;
const LATEST_TTL_MS = 10_000;
const LANGUAGE_TTL_MS = 12 * 60 * 60_000;
const MAX_LOCAL_FLIGHTS = 200;
const MAX_SOURCE_TEXT_LENGTH = 500;
const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_WAIT_MS = 2_500;
const DEFAULT_POLL_MS = 40;
const DEFAULT_MAX_CONCURRENT = 8;
/** Only phones that recognize speech themselves send previews. */
const SPEECH_ASR_MODES = new Set<AsrMode>(["android_streaming", "browser_streaming"]);
const TARGET_LANGUAGES = new Set<TargetLanguage>(["en", "zh", "ja", "ko", "fr"]);

type StoredTurn =
  | { state: "pending"; runId: string; startedAt: number }
  | { state: "ready"; runId: string; startedAt: number; readyAt: number; result: ConversationResponse }
  /** The run failed: the final request runs its own pipeline without waiting. */
  | { state: "failed"; runId: string }
  /** The final request has run: later previews of this turn are not speculated. */
  | { state: "done" };

type EnvSource = Readonly<Record<string, string | undefined>>;

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw);
  return raw?.trim() && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function previewSpeculationConfig(env: EnvSource = process.env): SpeculationConfig {
  return {
    enabled: env.AUDIO_PREVIEW_SPECULATION_ENABLED?.trim().toLowerCase() === "true",
    debounceMs: boundedInteger(env.AUDIO_PREVIEW_SPECULATION_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS, 0, 3_000),
    maxWaitMs: boundedInteger(env.AUDIO_PREVIEW_SPECULATION_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, 0, 8_000),
    maxConcurrent: boundedInteger(env.AUDIO_PREVIEW_SPECULATION_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1, 64),
    pollMs: DEFAULT_POLL_MS,
  };
}

function digest(parts: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Spacing never changes a sentence; everything else is checked exactly on reuse. */
function normalizeSpeculationText(text: string) {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function turnKey(turn: {
  clientId: string; targetLanguage: TargetLanguage; context: PracticeContext; childAge: number; sourceText: string;
}) {
  return `${KEY_PREFIX}:turn:${digest([
    turn.clientId, turn.targetLanguage, turn.context, turn.childAge, normalizeSpeculationText(turn.sourceText),
  ])}`;
}

const latestKey = (clientId: string) => `${KEY_PREFIX}:latest:${digest([clientId])}`;
const languageKey = (clientId: string) => `${KEY_PREFIX}:lang:${digest([clientId])}`;
const claimKey = (key: string, runId: string) => `${key}:claim:${runId}`;

function parseStoredTurn(raw: string | null): StoredTurn | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredTurn;
    if (value?.state === "done") return value;
    if (typeof value?.runId !== "string") return null;
    if (value.state === "pending" || value.state === "failed") return value;
    if (value.state === "ready" && typeof value.readyAt === "number" &&
        value.result && typeof value.result.vietnameseText === "string") return value;
  } catch {
    // A corrupt entry is a miss.
  }
  return null;
}

function parseTargetLanguage(raw: string | null): TargetLanguage | undefined {
  return raw && TARGET_LANGUAGES.has(raw as TargetLanguage) ? (raw as TargetLanguage) : undefined;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultCreateId(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

type Found = { runId: string; result: ConversationResponse; origin: "local" | "shared"; readyAt?: number };

export function createPreviewSpeculation(deps: PreviewSpeculationDeps) {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? defaultCreateId;
  let activeRuns = 0;

  /** Store errors fail open: a broken cache only means no head start. */
  async function safely<T>(operation: () => Promise<T>, fallback: T, requestId: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      deps.log("warn", "preview_speculation_store_failed", { requestId, error });
      return fallback;
    }
  }

  function eligible(clientId: string) {
    return deps.config().enabled && !deps.isLoadTestClient(clientId);
  }

  function trackLocalFlight(key: string, flight: SpeculationFlight) {
    if (deps.flights.size >= MAX_LOCAL_FLIGHTS) {
      const oldest = deps.flights.keys().next().value;
      if (oldest !== undefined) deps.flights.delete(oldest);
    }
    deps.flights.set(key, flight);
    void flight.then(() => {
      const timer = setTimeout(() => {
        if (deps.flights.get(key) === flight) deps.flights.delete(key);
      }, READY_TTL_MS);
      timer.unref?.();
    });
  }

  async function runSpeculation(key: string, pendingRaw: string, runId: string, input: ConversationRequest) {
    const requestId = input.requestId ?? runId;
    const startedAt = now();
    // A synchronous throw becomes a failed run too (the pending key is never left behind).
    const flight: SpeculationFlight = Promise.resolve().then(() => deps.runPipeline(input)).then(
      async (result) => {
        const ready: StoredTurn = { state: "ready", runId, startedAt, readyAt: now(), result };
        // Only while this run is still pending: a final request that gave up waiting
        // has marked the turn done, and its own pipeline answered it.
        const stored = await safely(
          () => deps.store.replaceIf(key, pendingRaw, JSON.stringify(ready), READY_TTL_MS), false, requestId);
        deps.log("info", stored ? "preview_speculation_completed" : "preview_speculation_discarded", {
          requestId,
          targetLanguage: input.targetLanguage,
          textSource: result.textSource,
          audioSource: result.audioSource,
          speculationMs: Math.round(now() - startedAt),
        });
        return stored ? { runId, result } : null;
      },
      async (error: unknown) => {
        // The final request runs its own pipeline instead of waiting for this one.
        const failed: StoredTurn = { state: "failed", runId };
        await safely(() => deps.store.replaceIf(key, pendingRaw, JSON.stringify(failed), DONE_TTL_MS), false, requestId);
        deps.log("warn", "preview_speculation_failed", { requestId, targetLanguage: input.targetLanguage, error });
        return null;
      },
    ).catch(() => null); // A flight never rejects: final requests that wait on it fail open.
    trackLocalFlight(key, flight);
    await flight;
  }

  /** Called after the preview response; resolves once this preview is handled. */
  async function speculate(preview: PreviewInput): Promise<void> {
    const sourceText = preview.sourceText.trim();
    if (!eligible(preview.clientId) || !sourceText || sourceText.length > MAX_SOURCE_TEXT_LENGTH) return;
    const { requestId, clientId } = preview;
    const targetLanguage = preview.targetLanguage ??
      parseTargetLanguage(await safely(() => deps.store.get(languageKey(clientId)), null, requestId));
    if (!targetLanguage) {
      deps.log("info", "preview_speculation_skipped", { requestId, reason: "unknown_target_language" });
      return;
    }
    const key = turnKey({ clientId, targetLanguage, context: preview.context, childAge: preview.childAge, sourceText });
    // Newest preview wins: every backend sees the same "latest" entry for this client.
    const recorded = await safely(
      () => deps.store.set(latestKey(clientId), key, LATEST_TTL_MS).then(() => true), false, requestId);
    if (!recorded) return;
    const { debounceMs } = deps.config();
    if (debounceMs > 0) await sleep(debounceMs);
    const latest = await safely(() => deps.store.get(latestKey(clientId)), null, requestId);
    if (latest !== key) {
      deps.log("info", "preview_speculation_skipped", { requestId, reason: "superseded" });
      return;
    }
    if (activeRuns >= deps.config().maxConcurrent) {
      deps.log("info", "preview_speculation_skipped", { requestId, reason: "busy", activeRuns });
      return;
    }
    // Reserved before the first await, so concurrent previews cannot overshoot the cap.
    activeRuns += 1;
    try {
      const runId = createId("spec");
      const pendingRaw = JSON.stringify({ state: "pending", runId, startedAt: now() } satisfies StoredTurn);
      const claimed = await safely(() => deps.store.setIfAbsent(key, pendingRaw, PENDING_TTL_MS), false, requestId);
      if (!claimed) {
        deps.log("info", "preview_speculation_skipped", { requestId, reason: "already_claimed" });
        return;
      }
      deps.log("info", "preview_speculation_started", { requestId, targetLanguage, context: preview.context });
      await runSpeculation(key, pendingRaw, runId, {
        requestId,
        clientId,
        context: preview.context,
        childAge: preview.childAge,
        targetLanguage,
        sourceText,
        asrMode: preview.asrMode ?? "android_streaming",
      });
    } finally {
      activeRuns -= 1;
    }
  }

  /**
   * The finished speculation, waiting until `deadline` for one that is still running.
   * Redis always decides which run is current: a flight on this backend only means
   * "wake up now" instead of polling, since it may be an older run of the same words.
   */
  async function awaitSpeculation(
    key: string, requestId: string, deadline: number,
  ): Promise<Found | "timeout" | null> {
    const local = deps.flights.get(key);
    if (local) {
      const timedOut = Symbol("timeout");
      const settled = await Promise.race([local, sleep(Math.max(0, deadline - now())).then(() => timedOut)]);
      if (settled === timedOut) return "timeout";
    }
    const origin = local ? "local" : "shared";
    for (;;) {
      const stored = parseStoredTurn(await safely(() => deps.store.get(key), null, requestId));
      if (!stored || stored.state === "done" || stored.state === "failed") return null;
      if (stored.state === "ready") {
        return { runId: stored.runId, result: stored.result, origin, readyAt: stored.readyAt };
      }
      if (now() >= deadline) return "timeout";
      await sleep(Math.min(deps.config().pollMs, Math.max(1, deadline - now())));
    }
  }

  function adopt(speculated: ConversationResponse, input: FinalTurnInput, waitMs: number): ConversationResponse {
    return {
      ...speculated,
      requestId: input.requestId,
      clientId: input.clientId,
      conversationId: createId("conv"),
      sessionId: input.sessionId ?? createId("sess"),
      context: input.context,
      asrMode: input.asrMode ?? speculated.asrMode,
      benchmark: { ...input.benchmark, previewSpeculationUsed: true, previewSpeculationWaitMs: waitMs },
    };
  }

  function missed(requestId: string, reason: string, waitMs: number) {
    deps.log("info", "preview_speculation_missed", { requestId, reason, waitMs });
    return null;
  }

  /**
   * The final request's turn: the speculated result when the transcript matches,
   * otherwise null (the caller runs its pipeline). Validation errors from
   * `transcribe` propagate exactly as they would from the pipeline.
   */
  async function takeForTurn(input: FinalTurnInput): Promise<ConversationResponse | null> {
    const sourceText = input.sourceText?.trim() ?? "";
    if (!eligible(input.clientId) || input.audioFile || !sourceText ||
        !input.asrMode || !SPEECH_ASR_MODES.has(input.asrMode)) return null;
    const { requestId, clientId } = input;
    const startedAt = now();
    void safely(() => deps.store.set(languageKey(clientId), input.targetLanguage, LANGUAGE_TTL_MS), undefined, requestId);
    const key = turnKey({
      clientId, targetLanguage: input.targetLanguage, context: input.context,
      childAge: input.childAge ?? 6, sourceText,
    });
    const found = await awaitSpeculation(key, requestId, startedAt + deps.config().maxWaitMs);
    const waitMs = Math.round(now() - startedAt);
    if (found && found !== "timeout") deps.flights.delete(key);
    // Previews of this turn can trail the final request: do not run them any more.
    // A run still pending stays unused: it can no longer store its result. Not
    // awaited: a miss must start its own pipeline without another Redis round trip.
    const done: StoredTurn = { state: "done" };
    void safely(() => deps.store.set(key, JSON.stringify(done), DONE_TTL_MS), undefined, requestId);
    if (!found || found === "timeout") return missed(requestId, found ? "wait_timeout" : "no_speculation", waitMs);
    // One final request per run, on every backend: a retry, a racing request or a
    // later turn with the same words never receives the same (single-use) audio URL.
    const claimed = await safely(
      () => deps.store.setIfAbsent(claimKey(key, found.runId), requestId, READY_TTL_MS), false, requestId);
    if (!claimed) return missed(requestId, "already_used", waitMs);
    const finalTranscript = await deps.transcribe({ ...input, sourceText });
    if (finalTranscript.trim() !== found.result.vietnameseText.trim()) {
      return missed(requestId, "transcript_changed", waitMs);
    }
    deps.log("info", "preview_speculation_used", {
      requestId,
      origin: found.origin,
      targetLanguage: input.targetLanguage,
      waitMs,
      speculationAgeMs: found.readyAt === undefined ? undefined : Math.round(now() - found.readyAt),
    });
    return adopt(found.result, input, waitMs);
  }

  return { speculate, takeForTurn };
}

export type PreviewSpeculation = ReturnType<typeof createPreviewSpeculation>;
