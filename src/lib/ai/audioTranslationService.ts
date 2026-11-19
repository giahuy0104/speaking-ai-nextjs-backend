import { cacheEnabled, audioTranslationCache, translationCacheKey } from "./audioTranslationCache";
import { abortError, assertExecutionActive, createDeadline, withSignal } from "./cloudflare/deadline";
import { combineAbortSignals, tagAbortSignal, timeoutSignal } from "./cloudflare/abortDiagnostics";
import { getFailureDiagnostics, isTransientPoolFailure, PoolError } from "./cloudflare/providerError";
import type { AudioTranslationResult } from "./cloudflareWorkersAi";

type Timing = ReturnType<typeof createDeadline>;
type Result = { result: AudioTranslationResult; cacheStatus: "disabled" | "hit" | "miss" | "coalesced" };
type Flight = { promise: Promise<AudioTranslationResult>; controller: AbortController; subscribers: number;
  settled: boolean; requestId?: string };
type RunInput = {
  audio: File; sourceLanguage: string; owner: string; timing: Timing; cacheAllowed?: boolean; flightScope?: string;
  requestId?: string;
  onState?: (state: "cache_lookup" | "single_flight_wait") => void;
  onSharedWork?: (requestId: string) => void;
  onWorkCancelled?: () => void;
  /** A joined caller is re-running after the shared leader failed transiently. */
  onSharedWorkRetry?: (error: unknown) => void;
  operation: (timing: Timing, bytes?: ArrayBuffer) => Promise<AudioTranslationResult>;
};

/** A joined caller re-runs only when enough of its own deadline remains for ASR + text. */
const SHARED_RETRY_MIN_REMAINING_MS = 6_000;

function notify(callback: (() => void) | undefined) {
  try { callback?.(); } catch { /* Diagnostic observers cannot change request results. */ }
}

export function createAudioTranslationService(cache = audioTranslationCache) {
  const flights = new Map<string, Flight>();
  const owners = new Map<string, number>();

  async function attach(input: RunInput, key: string, flightKey: string, bytes: ArrayBuffer,
    onJoined?: (joined: boolean) => void): Promise<Result> {
    let flight = flights.get(flightKey);
    const joined = !!flight;
    onJoined?.(joined);
    if (!flight) {
      const ownerLimit = Math.max(1, Math.min(20, Number(process.env.AUDIO_TRANSLATION_MAX_IN_FLIGHT_PER_CLIENT) || 4));
      if ((owners.get(input.owner) || 0) >= ownerLimit || flights.size >= 60) throw new PoolError("queue_full", 429, 1000);
      const controller = new AbortController();
      tagAbortSignal(controller.signal, { failureSource: "backend", abortCause: "no_subscribers" });
      const deadlineAt = input.timing.deadlineAt;
      const signal = combineAbortSignals([controller.signal, timeoutSignal(deadlineAt - Date.now(), "request_deadline")]);
      owners.set(input.owner, (owners.get(input.owner) || 0) + 1);
      const created: Flight = { controller, subscribers: 0, settled: false, requestId: input.requestId,
        promise: Promise.resolve().then(async () => {
        // Recheck after joining the local flight: another replica may have filled the cache.
        const shared = await cache.get(key);
        if (shared) return { ...shared, timings: { asrMs: 0, translationMs: 0 } };
        const result = await input.operation({ deadlineAt, signal }, bytes);
        await cache.set(key, result);
        return result;
      }) };
      created.promise = created.promise.finally(() => {
        created.settled = true;
        if (flights.get(flightKey) === created) flights.delete(flightKey);
        const active = (owners.get(input.owner) || 1) - 1;
        if (active) owners.set(input.owner, active); else owners.delete(input.owner);
      });
      flights.set(flightKey, created); flight = created;
    }
    notify(() => input.onState?.("single_flight_wait"));
    if (joined && flight.requestId) notify(() => input.onSharedWork?.(flight!.requestId!));
    flight.subscribers++;
    try {
      return { result: await withSignal(input.timing.signal, () => flight!.promise), cacheStatus: joined ? "coalesced" : "miss" };
    } finally {
      if (--flight.subscribers === 0) {
        if (!flight.settled) {
          flight.controller.abort();
          notify(input.onWorkCancelled);
        }
        if (flights.get(flightKey) === flight) flights.delete(flightKey);
      }
    }
  }

  return {
    async run(input: RunInput): Promise<Result> {
      if (!cacheEnabled() || input.cacheAllowed === false) return { result: await input.operation(input.timing), cacheStatus: "disabled" };
      assertExecutionActive(input.timing);
      const bytes = await input.audio.arrayBuffer();
      const key = translationCacheKey(input.owner, input.sourceLanguage, "audio", bytes);
      const flightKey = `${key}:${input.flightScope || "sync"}`;
      notify(() => input.onState?.("cache_lookup"));
      const cached = await cache.get(key);
      assertExecutionActive(input.timing);
      if (cached) {
        if (input.timing.signal.aborted) throw abortError(input.timing.signal);
        return { result: { ...cached, timings: { asrMs: 0, translationMs: 0 } }, cacheStatus: "hit" };
      }
      // A joined caller never ran inference itself. When the shared leader fails
      // transiently, it gets one fresh pass (joining a new flight if another
      // caller already started one) instead of inheriting the leader's error.
      // The leader does not re-run here: its provider retries already happened.
      let joinedFirstPass = false;
      try {
        return await attach(input, key, flightKey, bytes, joined => { joinedFirstPass = joined; });
      } catch (error) {
        if (!joinedFirstPass || !isTransientPoolFailure(error) || input.timing.signal.aborted ||
          input.timing.deadlineAt - Date.now() < SHARED_RETRY_MIN_REMAINING_MS) throw error;
        notify(() => input.onSharedWorkRetry?.(error));
        try {
          return await attach(input, key, flightKey, bytes);
        } catch (retryError) {
          // Load shedding or running out of time on the retry must not hide why
          // the first pass failed; a new transient fault is still reported as is.
          if (retryError instanceof PoolError && retryError.reason === "queue_full") throw error;
          if (!isTransientPoolFailure(retryError) && getFailureDiagnostics(retryError).abortCause === "request_deadline") throw error;
          throw retryError;
        }
      }
    },
  };
}
export const audioTranslationService = createAudioTranslationService();
