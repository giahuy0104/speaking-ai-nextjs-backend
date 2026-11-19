import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTranslationCache, translationCacheKey } from "./audioTranslationCache";
import { createAudioTranslationService } from "./audioTranslationService";
import { createDeadline } from "./cloudflare/deadline";
import { getAbortDiagnostics } from "./cloudflare/abortDiagnostics";
import { isTransientPoolFailure, PoolError, ProviderFault, publicPoolError } from "./cloudflare/providerError";

const translated = { sourceText: "I feel better.", englishText: "I feel better.", model: "asr", textModel: "text" };
function setup() {
  process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED = "true";
  process.env.AUDIO_TRANSLATION_CACHE_ENABLED = "true";
  const values = new Map<string, string>();
  const cache = createTranslationCache({ get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); } });
  return { service: createAudioTranslationService(cache), cache, values };
}
const audio = () => new File(["audio"], "speech.wav", { type: "audio/wav" });

test("twenty identical cold requests share one inference; warm cache invokes no provider", async () => {
  const { service } = setup(); let calls = 0;
  const run = () => service.run({ audio: audio(), owner: "owner-a", sourceLanguage: "vi", timing: createDeadline(2000),
    operation: async () => { calls++; await delay(20); return translated; } });
  const first = await Promise.all(Array.from({ length: 20 }, run));
  assert.equal(calls, 1);
  assert.equal(first.filter(r => r.cacheStatus === "coalesced").length, 19);
  const warm = await run();
  assert.equal(warm.cacheStatus, "hit"); assert.equal(calls, 1);
  assert.deepEqual(warm.result.timings, { asrMs: 0, translationMs: 0 });
});

test("tenant, language, model and audio bytes do not share cached results", async () => {
  setup(); const bytes = await audio().arrayBuffer();
  const base = translationCacheKey("a", "vi", "audio", bytes);
  assert.notEqual(base, translationCacheKey("b", "vi", "audio", bytes));
  assert.notEqual(base, translationCacheKey("a", "en", "audio", bytes));
  assert.notEqual(base, translationCacheKey("a", "vi", "audio", new ArrayBuffer(2)));
  const oldModel = process.env.CLOUDFLARE_TEXT_MODEL;
  process.env.CLOUDFLARE_TEXT_MODEL = "@cf/test/other";
  assert.notEqual(base, translationCacheKey("a", "vi", "audio", bytes));
  if (oldModel === undefined) delete process.env.CLOUDFLARE_TEXT_MODEL; else process.env.CLOUDFLARE_TEXT_MODEL = oldModel;
});

test("cancelled owner does not cancel a joined subscriber", async () => {
  const { service } = setup(); const cancelled = new AbortController();
  let sharedSignal: AbortSignal | undefined; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const operation = async (timing: ReturnType<typeof createDeadline>) => { sharedSignal = timing.signal; started(); await delay(40); return translated; };
  const first = service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(2000, cancelled.signal), operation });
  await ready;
  const second = service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(2000), operation });
  await delay(5); cancelled.abort();
  await assert.rejects(first, { reason: "cancelled" });
  assert.equal(sharedSignal?.aborted, false);
  assert.equal((await second).result.englishText, translated.englishText);
});

test("all subscribers leaving cancels their work and a new caller never joins the cancelled flight", async () => {
  const { service } = setup(); const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); let signal: AbortSignal | undefined;
  let cancellationEvents = 0;
  const first = service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000, controller.signal),
    onWorkCancelled: () => { cancellationEvents++; },
    operation: async timing => { signal = timing.signal; started(); await delay(1000, undefined, { signal: timing.signal }); return translated; } });
  const rejected = assert.rejects(first, { reason: "cancelled" });
  await ready; controller.abort(); await rejected; assert.equal(signal?.aborted, true);
  assert.deepEqual(getAbortDiagnostics(signal!), { failureSource: "backend", abortCause: "no_subscribers" });
  assert.equal(cancellationEvents, 1);
  const next = await service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000), operation: async () => translated });
  assert.equal(next.result.englishText, translated.englishText);
});

test("shared work correlation is observable and successful work emits no cancellation", async () => {
  const { service } = setup(); let cancelled = 0;
  const leaders: string[] = [];
  const run = (requestId: string) => service.run({ audio: audio(), owner: "correlation", sourceLanguage: "vi", requestId,
    timing: createDeadline(1000), onSharedWork: id => leaders.push(id), onWorkCancelled: () => { cancelled++; },
    operation: async () => { await delay(20); return translated; } });
  await Promise.all([run("leader-request"), run("joined-request")]);
  assert.deepEqual(leaders, ["leader-request"]);
  assert.equal(cancelled, 0);
});

test("sync-only and async-capable callers do not share a response contract", async () => {
  const { service } = setup(); let calls = 0;
  const run = (flightScope: string) => service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000), flightScope,
    operation: async () => { calls++; await delay(20); return translated; } });
  await Promise.all([run("sync"), run("jobs:one-key")]); assert.equal(calls, 2);
});

test("corrupt cache and cache outages fail open; failures never become cached successes", async () => {
  const { cache, values } = setup(); values.set("invalid", '{"englishText":"xin chào"}');
  assert.equal(await cache.get("invalid"), null);
  const broken = createTranslationCache({ get: async () => { throw new Error("offline"); }, set: async () => { throw new Error("offline"); } });
  const service = createAudioTranslationService(broken);
  let calls = 0;
  const run = () => service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000),
    operation: async () => { calls++; throw new Error("provider failed"); } });
  await assert.rejects(run(), /provider failed/); await assert.rejects(run(), /provider failed/);
  assert.equal(calls, 2);
});

const transient = () => new PoolError("timeout", 504, undefined, { failureSource: "backend", abortCause: "attempt_timeout" });

test("joined callers re-run once together when the shared leader fails transiently", async () => {
  const { service } = setup(); let calls = 0; let retries = 0;
  const run = () => service.run({ audio: audio(), owner: "retry", sourceLanguage: "vi", timing: createDeadline(10_000),
    onSharedWorkRetry: () => { retries++; },
    operation: async () => { calls++; await delay(20); if (calls === 1) throw transient(); return translated; } });
  const results = await Promise.allSettled(Array.from({ length: 20 }, run));
  // The leader already had its provider retry inside the dispatcher; it reports its own failure.
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 19);
  // The 19 joined callers share one fresh flight rather than calling the provider 19 times.
  assert.equal(calls, 2);
  assert.equal(retries, 19);
});

test("joined callers do not re-run after non-transient failures or with too little time left", async () => {
  for (const failure of [new ProviderFault("provider_error", 400), new ProviderFault("credentials", 401), new Error("bad audio")]) {
    const { service } = setup(); let calls = 0;
    const run = () => service.run({ audio: audio(), owner: "no-retry", sourceLanguage: "vi", timing: createDeadline(10_000),
      operation: async () => { calls++; await delay(20); throw failure; } });
    const results = await Promise.allSettled([run(), run(), run()]);
    assert.equal(results.every(r => r.status === "rejected"), true);
    assert.equal(calls, 1);
  }
  const { service } = setup(); let calls = 0;
  const run = () => service.run({ audio: audio(), owner: "late", sourceLanguage: "vi", timing: createDeadline(3_000),
    operation: async () => { calls++; await delay(20); throw transient(); } });
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.every(r => r.status === "rejected"), true);
  assert.equal(calls, 1);
});

test("public AppError projections keep the transient classification", () => {
  assert.equal(isTransientPoolFailure(publicPoolError(new ProviderFault("provider_error", 503), "text_translation")), true);
  assert.equal(isTransientPoolFailure(publicPoolError(new ProviderFault("network_error"), "asr")), true);
  assert.equal(isTransientPoolFailure(publicPoolError(transient(), "text_translation")), true);
  assert.equal(isTransientPoolFailure(publicPoolError(new ProviderFault("provider_error", 400), "text_translation")), false);
  assert.equal(isTransientPoolFailure(publicPoolError(new ProviderFault("rate_limited", 429), "asr")), false);
  assert.equal(isTransientPoolFailure(new PoolError("timeout", 504, undefined, { failureSource: "client", abortCause: "client_disconnect" })), false);
  assert.equal(isTransientPoolFailure(new PoolError("timeout", 504, undefined, { failureSource: "backend", abortCause: "request_deadline" })), false);
  assert.equal(isTransientPoolFailure(new PoolError("queue_full", 429)), false);
});

test("per-client distinct cold work is bounded while duplicate subscribers still join", async () => {
  const { service } = setup(); process.env.AUDIO_TRANSLATION_MAX_IN_FLIGHT_PER_CLIENT = "1";
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const first = service.run({ audio: audio(), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000), operation: async () => { await held; return translated; } });
  await delay(5);
  await assert.rejects(service.run({ audio: new File(["other"], "other.wav"), owner: "a", sourceLanguage: "vi", timing: createDeadline(1000), operation: async () => translated }), { reason: "queue_full" });
  release(); await first; delete process.env.AUDIO_TRANSLATION_MAX_IN_FLIGHT_PER_CLIENT;
});
