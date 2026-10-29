import { isLegacyAdmissionEnabled, isPoolEnabled, parsePoolConfig, parseQueueSettings, type PoolEnvironment } from "./accountConfig";
import { abortError, assertExecutionActive, createDeadline } from "./deadline";
import { clientAbortSignal } from "./abortDiagnostics";
import { AccountDispatcher } from "./dispatcher";
import { MemoryAdmissionStore } from "./memoryAdmissionStore";
import { PoolError } from "./providerError";
import { emitTelemetry, type TelemetrySink } from "./telemetry";
import { RequestQueue } from "./requestQueue";
import type { AdmissionStore, CloudflareExecutionContext, CloudflareTask, PoolConfig } from "./types";

export { isPoolFailure, publicPoolError, getPoolRetryAfterMs } from "./providerError";

type RuntimeOptions = {
  env?: PoolEnvironment;
  storeFactory?: (config: PoolConfig) => AdmissionStore | Promise<AdmissionStore>;
  telemetry?: TelemetrySink;
  clock?: () => number;
};
type ExecutionInput = { requestId: string; signal?: AbortSignal; telemetry?: TelemetrySink;
  timing?: ReturnType<typeof createDeadline> };

async function defaultStore(config: PoolConfig): Promise<AdmissionStore> {
  if (config.store === "memory") return new MemoryAdmissionStore();
  const [{ createRedisClient }, { RedisAdmissionStore }] = await Promise.all([
    import("./redisClient"), import("./redisAdmissionStore"),
  ]);
  return new RedisAdmissionStore(await createRedisClient(config.redisUrl!), config.namespace);
}

// No configuration, credentials or connections are touched until the enabled
// workload arrives. A failed connection is retried only by a subsequent request.
export function createPoolRuntime(options: RuntimeOptions = {}) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? Date.now;
  let config: PoolConfig | undefined;
  let dispatcher: AccountDispatcher | undefined;
  let store: AdmissionStore | undefined;
  let pending: Promise<AdmissionStore> | undefined;
  let queue: RequestQueue | undefined;
  let uploadSettings: ReturnType<typeof parseQueueSettings> | undefined;
  let bufferedRequests = 0;
  let bufferedBytes = 0;
  const loadConfig = () => {
    try {
      if (!isPoolEnabled(env)) return undefined;
      config ??= parsePoolConfig(env);
      queue ??= new RequestQueue(config.maxInFlight, config.maxQueued, clock);
      return config;
    } catch { throw new PoolError("configuration"); }
  };
  const deadline = (input: ExecutionInput) => {
    if (input.timing) return input.timing;
    const parsed = Number(env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS);
    const timeoutMs = Math.min(30_000, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20_000);
    return createDeadline(timeoutMs, input.signal, clock());
  };
  const session = (input: ExecutionInput, timing: ReturnType<typeof createDeadline>, slot: { release: () => void; waitedMs: number },
    workload: CloudflareExecutionContext["workload"] = "audio-translate") => {
    try {
      assertExecutionActive(timing, clock());
      dispatcher ??= new AccountDispatcher(config!, lazyStore, options.telemetry ?? input.telemetry, clock);
      const execution: CloudflareExecutionContext = Object.freeze({
        requestId: input.requestId, workload, ...timing,
        // Legacy requests remain pinned and never gain automatic inference retry.
        attempts: { used: 0, max: workload === "audio-translate" ? config!.maxAttemptsPerRequest : 1 }, dispatcher,
        admissionWait: { usedMs: slot.waitedMs },
      });
      return { execution, release: slot.release };
    } catch (error) { slot.release(); throw error; }
  };
  const ensureStore = async () => {
    if (store) return store;
    const initializing = pending ??= Promise.resolve().then(() => (options.storeFactory ?? defaultStore)(config!));
    try { store = await initializing; return store; }
    catch { if (pending === initializing) pending = undefined; throw new PoolError("store_unavailable"); }
  };
  async function runWithStore<T>(operation: (current: AdmissionStore) => Promise<T>) {
    const current = await ensureStore();
    try { return await operation(current); }
    catch {
      // A closed socket must recover on a later request. Never retry an
      // uncertain acquisition in this request or invalidate a newer connection.
      if (store === current) {
        store = undefined; pending = undefined;
        Promise.resolve().then(() => current.close?.()).catch(() => {});
      }
      throw new PoolError("store_unavailable");
    }
  }
  const lazyStore: AdmissionStore = {
    acquire: input => runWithStore(current => current.acquire(input)),
    complete: (permit, outcome) => runWithStore(current => current.complete(permit, outcome)),
    snapshot: (accountIdentity, rules) => runWithStore(current => current.snapshot(accountIdentity, rules)),
  };
  return {
    async acquireLegacyExecution(input: ExecutionInput & { task: CloudflareTask; timeoutMs: number }) {
      try {
        if (!isLegacyAdmissionEnabled(env)) return undefined;
      } catch { throw new PoolError("configuration"); }
      const current = loadConfig();
      if (!current?.legacyAccountIdentity || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new PoolError("configuration");
      }
      const timing = createDeadline(input.timeoutMs, input.signal, clock());
      const workload = `legacy-${input.task}` as const;
      const sink = options.telemetry ?? input.telemetry;
      const base = { requestId: input.requestId, workload, stage: "request", configVersion: current.configVersion };
      try {
        const slot = await queue!.acquire(timing.signal, current.maxWaitMs, queueDepth =>
          emitTelemetry(sink, "cloudflare_pool_queued", { ...base, queueDepth }));
        const handle = session(input, timing, slot, workload);
        emitTelemetry(sink, "cloudflare_pool_request_admitted", { ...base, admissionWaitMs: slot.waitedMs });
        return { ...handle, accountIdentity: current.legacyAccountIdentity };
      } catch (error) {
        emitTelemetry(sink, "cloudflare_pool_unavailable", { ...base, safeReason: error instanceof PoolError ? error.reason : "configuration" });
        throw error;
      }
    },
    // Bound buffered uploads before formData() allocates audio. Unknown lengths
    // are reserved at the route's maximum request size, not assumed to be zero.
    reserveAudioTranslationUpload(input: { requestId: string; requestBytes: number; signal?: AbortSignal; telemetry?: TelemetrySink }) {
      try {
        if (!isPoolEnabled(env)) return undefined;
        uploadSettings ??= parseQueueSettings(env);
      } catch { throw new PoolError("configuration"); }
      const settings = uploadSettings;
      if (!Number.isSafeInteger(input.requestBytes) || input.requestBytes <= 0) throw new PoolError("configuration");
      if (bufferedRequests >= settings.maxInFlight + settings.maxQueued ||
          bufferedBytes + input.requestBytes > settings.maxBufferedBytes) {
        emitTelemetry(options.telemetry ?? input.telemetry, "cloudflare_pool_unavailable", {
          requestId: input.requestId, workload: "audio-translate", stage: "request", safeReason: "buffer_capacity",
        });
        throw new PoolError("queue_full", 429, 1_000);
      }
      bufferedRequests++; bufferedBytes += input.requestBytes;
      let released = false;
      return { timing: deadline(input), release() {
        if (!released) { released = true; bufferedRequests--; bufferedBytes -= input.requestBytes; }
      } };
    },
    createAudioTranslationExecution(input: ExecutionInput): { execution: CloudflareExecutionContext; release: () => void } | undefined {
      if (!loadConfig()) return undefined;
      if (input.signal?.aborted) throw abortError(clientAbortSignal(input.signal));
      return session(input, deadline(input), queue!.tryAcquire());
    },
    async acquireAudioTranslationExecution(input: ExecutionInput) {
      const current = loadConfig();
      if (!current) return undefined;
      const timing = deadline(input);
      const sink = options.telemetry ?? input.telemetry;
      const base = { requestId: input.requestId, workload: "audio-translate", stage: "request", configVersion: current.configVersion };
      try {
        const slot = await queue!.acquire(timing.signal, current.maxWaitMs, queueDepth =>
          emitTelemetry(sink, "cloudflare_pool_queued", { ...base, queueDepth }));
        const handle = session(input, timing, slot);
        emitTelemetry(sink, "cloudflare_pool_request_admitted", { ...base, admissionWaitMs: slot.waitedMs });
        return handle;
      } catch (error) {
        emitTelemetry(sink, "cloudflare_pool_unavailable", {
          ...base, safeReason: error instanceof PoolError ? error.reason : "configuration",
        });
        throw error;
      }
    },
    async close() {
      queue?.cancelPending();
      if (pending) { try { await pending; } catch { /* Already sanitized at the request boundary. */ } }
      await store?.close?.();
      store = undefined;
      pending = undefined;
    },
  };
}

const runtime = createPoolRuntime();
export const createAudioTranslationExecution = runtime.createAudioTranslationExecution;
export const acquireAudioTranslationExecution = runtime.acquireAudioTranslationExecution;
export const reserveAudioTranslationUpload = runtime.reserveAudioTranslationUpload;
export const acquireLegacyExecution = runtime.acquireLegacyExecution;
