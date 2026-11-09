import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AccountDispatcher } from "./dispatcher";
import { createDeadline } from "./deadline";
import { MemoryAdmissionStore } from "./memoryAdmissionStore";
import { PoolError, ProviderFault } from "./providerError";
import { ASR_MODEL, poolConfig, TEXT_MODEL } from "./poolTestFixtures";
import type { AdmissionStore, CloudflareExecutionContext, PoolConfig } from "./types";

function harness(store: AdmissionStore = new MemoryAdmissionStore(), config: PoolConfig = poolConfig()) {
  const events: unknown[] = [];
  const dispatcher = new AccountDispatcher(config, store, (event, fields) => events.push({ event, ...fields }));
  const context: CloudflareExecutionContext = { requestId: "test-request", workload: "audio-translate",
    ...createDeadline(1000), attempts: { used: 0, max: config.maxAttemptsPerRequest }, dispatcher };
  return { dispatcher, context, events };
}

test("429 retries another account once and text retries cannot repeat completed ASR", async () => {
  const { dispatcher, context } = harness();
  let asr = 0; const accounts: string[] = [];
  assert.equal(await dispatcher.execute({ context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { asr++; return "source"; }), "source");
  assert.equal(await dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async ({ account }) => {
    accounts.push(account.alias); if (accounts.length === 1) throw new ProviderFault("rate_limited", 429); return "English";
  }), "English");
  assert.equal(asr, 1); assert.equal(context.attempts.used, 3);
  assert.equal(new Set(accounts).size, 2);
  await assert.rejects(dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async () => "extra"), { reason: "attempt_budget" });
});

test("timeouts, network, input, credentials and callback errors do not retry", async () => {
  for (const error of [new ProviderFault("timeout"), new ProviderFault("network_error"),
    new ProviderFault("provider_error", 400), new ProviderFault("provider_error", 503),
    new ProviderFault("credentials", 401), new Error("callback failed")]) {
    const { dispatcher, context } = harness(); let calls = 0;
    await assert.rejects(dispatcher.execute({ context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { calls++; throw error; }), e => e === error);
    assert.equal(calls, 1);
  }
});

test("client abort before admission makes zero calls and body read shares attempt deadline", async () => {
  const { dispatcher, context } = harness(); let calls = 0;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(dispatcher.execute({ context: { ...context, signal: cancelled.signal }, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { calls++; }), { reason: "cancelled" });
  assert.equal(calls, 0);
  await assert.rejects(dispatcher.execute({ context, operation: "audio_translation_asr", model: ASR_MODEL, timeoutMs: 5 }, async () => { calls++; await delay(30); }), { reason: "timeout" });
  assert.equal(calls, 1);
});

test("deadline never resets on retry and too little time prevents additional inference", async () => {
  const { dispatcher, context } = harness(); const deadlineAt = context.deadlineAt; let calls = 0;
  await assert.rejects(dispatcher.execute({ context: { ...context, deadlineAt: Date.now() + 300 }, operation: "audio_translation_asr", model: ASR_MODEL }, async () => {
    calls++; await delay(70); throw new ProviderFault("rate_limited", 429);
  }), { reason: "rate_limited" });
  assert.equal(calls, 1); assert.equal(context.deadlineAt, deadlineAt);
});

test("store failure fails closed and complete failure preserves success without retry", async () => {
  const unavailable: AdmissionStore = { snapshot: async () => { throw new Error("secret redis URL"); }, acquire: async () => { throw new Error(); }, complete: async () => {} };
  const h = harness(unavailable); let calls = 0;
  await assert.rejects(h.dispatcher.execute({ context: h.context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { calls++; }), { reason: "store_unavailable" });
  assert.equal(calls, 0);
  const store = new MemoryAdmissionStore(); store.complete = async () => { throw new Error("secret token"); };
  const h2 = harness(store);
  assert.equal(await h2.dispatcher.execute({ context: h2.context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => "okay"), "okay");
  assert.match(JSON.stringify(h2.events), /cleanup_failed/);
  assert.doesNotMatch(JSON.stringify(h2.events), /secret token/);
  const h3 = harness(store); calls = 0;
  await assert.rejects(h3.dispatcher.execute({ context: h3.context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { calls++; throw new ProviderFault("rate_limited", 429); }), { reason: "rate_limited" });
  assert.equal(calls, 1);
});

test("no permit or unsupported capability cannot invoke provider", async () => {
  const { dispatcher, context } = harness(); let calls = 0;
  await assert.rejects(dispatcher.execute({ context, operation: "audio_translation_asr", model: "@cf/unknown/model" }, async () => { calls++; }), e => e instanceof PoolError && e.status === 429);
  assert.equal(calls, 0);
});

test("failed half-open probe re-arms cooldown before admitting more work", async () => {
  let now = Date.now(); const store = new MemoryAdmissionStore(() => now);
  const config = { ...poolConfig(), accounts: [poolConfig().accounts[0]] };
  const dispatcher = new AccountDispatcher(config, store, undefined, () => now);
  const context: CloudflareExecutionContext = { requestId: "probe", workload: "audio-translate", ...createDeadline(5000, undefined, now),
    attempts: { used: 0, max: 3 }, dispatcher };
  const input = { context, operation: "audio_translation_asr" as const, model: ASR_MODEL };
  await assert.rejects(dispatcher.execute(input, async () => { throw new ProviderFault("rate_limited", 429, 100); }), { reason: "rate_limited" });
  now += 101;
  await assert.rejects(dispatcher.execute(input, async () => { throw new ProviderFault("provider_error", 503); }), { reason: "provider_error" });
  let called = false;
  await assert.rejects(dispatcher.execute(input, async () => { called = true; }), { reason: "capacity" });
  assert.equal(called, false);
});

test("completion timeout remains bounded and preserves a successful answer", async (t) => {
  const store = new MemoryAdmissionStore();
  store.complete = async () => new Promise<void>(() => {});
  const { dispatcher, context, events } = harness(store);
  let calls = 0;
  // AbortSignal.timeout uses an unreferenced timer; a hanging mocked store does
  // not provide the live socket that exists in a real Redis command.
  const keepAlive = setTimeout(() => {}, 3000);
  t.after(() => clearTimeout(keepAlive));
  const started = Date.now();
  assert.equal(await dispatcher.execute(
    { context, operation: "audio_translation_asr", model: ASR_MODEL },
    async () => { calls++; return "success"; },
  ), "success");
  assert.ok(Date.now() - started < 2500);
  assert.equal(calls, 1);
  assert.match(JSON.stringify(events), /cleanup_failed/);
});

test("client cancellation during an uncertain admission prevents inference", async () => {
  const memory = new MemoryAdmissionStore();
  const controller = new AbortController();
  const store: AdmissionStore = {
    snapshot: memory.snapshot.bind(memory),
    complete: memory.complete.bind(memory),
    async acquire(input) {
      await delay(5);
      controller.abort();
      // An admission may have committed before the client observes its result.
      return memory.acquire(input);
    },
  };
  const { dispatcher, context } = harness(store);
  let calls = 0;
  await assert.rejects(dispatcher.execute(
    { context: { ...context, signal: controller.signal }, operation: "audio_translation_asr", model: ASR_MODEL },
    async () => { calls++; return "unexpected"; },
  ), { reason: "cancelled" });
  assert.equal(calls, 0);
  assert.equal(context.attempts.used, 0);
});

test("concurrent stages sharing a context cannot overspend the request attempt budget", async () => {
  const config = { ...poolConfig(), maxAttemptsPerRequest: 1 };
  const { dispatcher, context } = harness(new MemoryAdmissionStore(), config);
  let calls = 0;
  const execute = () => dispatcher.execute(
    { context, operation: "audio_translation_asr", model: ASR_MODEL },
    async () => { calls++; await delay(5); return "success"; },
  );
  const outcomes = await Promise.allSettled([execute(), execute()]);
  assert.equal(calls, 1);
  assert.equal(context.attempts.used, 1);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal(rejected.reason.reason, "attempt_budget");
});

test("stage bursts wait on shared permits without retrying completed ASR", async () => {
  const original = poolConfig();
  const config = { ...original, maxWaitMs: 2000, maxQueued: 16, minAttemptMs: 1,
    accounts: original.accounts.map(account => ({ ...account, limits: {
      asr: { rpm: 60000, burst: 100, maxConcurrent: 2 },
      text: { rpm: 60000, burst: 100, maxConcurrent: 1 }, accountMaxConcurrent: 3,
    } })),
  };
  const { dispatcher, events } = harness(new MemoryAdmissionStore(), config);
  let asr = 0; let text = 0; let activeText = 0; let peakText = 0;
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const context: CloudflareExecutionContext = { requestId: `burst-${i}`, workload: "audio-translate", ...createDeadline(5000),
      attempts: { used: 0, max: 3 }, admissionWait: { usedMs: 0 }, dispatcher };
    await dispatcher.execute({ context, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { asr++; await delay(5); });
    await dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async () => {
      text++; peakText = Math.max(peakText, ++activeText); await delay(10); activeText--;
    });
    assert.equal(context.attempts.used, 2);
  }));
  assert.equal(asr, 8); assert.equal(text, 8); assert.equal(peakText, 2);
  assert.match(JSON.stringify(events), /cloudflare_pool_queued/);
  assert.ok((events as Array<{ admissionWaitMs?: number }>).some(event => (event.admissionWaitMs ?? 0) > 0));
});

test("stage waiting is bounded, cancellable, and never spends inference attempts", async () => {
  const denied: AdmissionStore = { snapshot: async () => ({ active: 1, retryAfterMs: 1000 }),
    acquire: async () => ({ granted: false, retryAfterMs: 1000 }), complete: async () => {} };
  const { dispatcher, context } = harness(denied, { ...poolConfig(), maxWaitMs: 100, maxQueued: 1, minAttemptMs: 1 });
  const controller = new AbortController();
  const first = dispatcher.execute({ context: { ...context, signal: controller.signal }, operation: "audio_translation_text", model: TEXT_MODEL }, async () => assert.fail("no permit"));
  await delay(5);
  await assert.rejects(dispatcher.execute({ context: { ...context, requestId: "overflow" }, operation: "audio_translation_text", model: TEXT_MODEL }, async () => {}), { reason: "queue_full" });
  controller.abort();
  await assert.rejects(first, { reason: "cancelled" });
  await assert.rejects(dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async () => {}), { reason: "queue_timeout", status: 429 });
  assert.equal(context.attempts.used, 0);
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("text backlog pauses new ASR without consuming attempts and wakes it after text admission", async () => {
  const memory = new MemoryAdmissionStore(); const queued = latch();
  let textAvailable = false; let asrCalls = 0;
  const store: AdmissionStore = { snapshot: memory.snapshot.bind(memory), complete: memory.complete.bind(memory),
    acquire: input => !textAvailable && input.rules.some(rule => rule.key === "task:text")
      ? Promise.resolve({ granted: false, retryAfterMs: 1000 }) : memory.acquire(input),
  };
  const config = { ...poolConfig(), maxWaitMs: 1000, minAttemptMs: 1, textBacklogThreshold: 1 };
  const dispatcher = new AccountDispatcher(config, store, event => { if (event === "cloudflare_pool_queued") queued.resolve(); });
  const context = (id: string): CloudflareExecutionContext => ({ requestId: id, workload: "audio-translate", ...createDeadline(2000),
    attempts: { used: 0, max: 3 }, admissionWait: { usedMs: 0 }, dispatcher });
  const text = dispatcher.execute({ context: context("text"), operation: "audio_translation_text", model: TEXT_MODEL }, async () => {});
  await queued.promise;
  const asrContext = context("asr");
  const asr = dispatcher.execute({ context: asrContext, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { asrCalls++; });
  await delay(10); assert.equal(asrCalls, 0); assert.equal(asrContext.attempts.used, 0);
  textAvailable = true;
  await Promise.all([text, asr]); assert.equal(asrCalls, 1);
});

test("new text requests cannot overtake an older request polling for a permit", async () => {
  const memory = new MemoryAdmissionStore();
  const queued = latch();
  let available = false;
  const store: AdmissionStore = {
    snapshot: memory.snapshot.bind(memory), complete: memory.complete.bind(memory),
    acquire: input => available ? memory.acquire(input) : Promise.resolve({ granted: false, retryAfterMs: 1000 }),
  };
  const config = { ...poolConfig(), maxWaitMs: 1000, minAttemptMs: 1 };
  const dispatcher = new AccountDispatcher(config, store, (event, fields) => {
    if (event === "cloudflare_pool_queued" && fields.requestId === "older") queued.resolve();
  });
  const order: string[] = [];
  const execute = (requestId: string) => {
    const context: CloudflareExecutionContext = { requestId, workload: "audio-translate", ...createDeadline(3000),
      attempts: { used: 0, max: 3 }, admissionWait: { usedMs: 0 }, dispatcher };
    return dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async () => {
      order.push(requestId);
    });
  };
  const older = execute("older");
  await queued.promise;
  available = true;
  await Promise.all([older, execute("newer")]);
  assert.deepEqual(order, ["older", "newer"]);
});

test("FIFO starts before the first asynchronous Redis snapshot and does not block ASR behind text", async () => {
  const memory = new MemoryAdmissionStore();
  const probing = latch(); const release = latch();
  let first = true;
  const store: AdmissionStore = {
    acquire: memory.acquire.bind(memory), complete: memory.complete.bind(memory),
    async snapshot(identity, rules) {
      if (first) { first = false; probing.resolve(); await release.promise; }
      return memory.snapshot(identity, rules);
    },
  };
  const config = { ...poolConfig(), maxWaitMs: 1000, minAttemptMs: 1 };
  const { dispatcher } = harness(store, config);
  const order: string[] = [];
  const execute = (requestId: string, operation: "audio_translation_asr" | "audio_translation_text") => {
    const context: CloudflareExecutionContext = { requestId, workload: "audio-translate", ...createDeadline(3000),
      attempts: { used: 0, max: 3 }, admissionWait: { usedMs: 0 }, dispatcher };
    return dispatcher.execute({ context, operation, model: operation === "audio_translation_asr" ? ASR_MODEL : TEXT_MODEL }, async () => {
      order.push(requestId);
    });
  };
  const older = execute("older", "audio_translation_text");
  await probing.promise;
  const newer = execute("newer", "audio_translation_text");
  await execute("asr", "audio_translation_asr");
  release.resolve();
  await Promise.all([older, newer]);
  assert.deepEqual(order, ["asr", "older", "newer"]);
});

test("cancelling the head wakes its successor and returns all queue places", async () => {
  const memory = new MemoryAdmissionStore();
  const olderQueued = latch(); const newerQueued = latch();
  const nextCancelled = new AbortController();
  let nextQueued = 0;
  let available = false;
  const store: AdmissionStore = {
    snapshot: memory.snapshot.bind(memory), complete: memory.complete.bind(memory),
    acquire: input => available ? memory.acquire(input) : Promise.resolve({ granted: false, retryAfterMs: 1000 }),
  };
  const config = { ...poolConfig(), maxWaitMs: 1000, maxQueued: 2, minAttemptMs: 1 };
  const dispatcher = new AccountDispatcher(config, store, (event, fields) => {
    if (event === "cloudflare_pool_queued") {
      if (fields.requestId === "older") olderQueued.resolve();
      if (fields.requestId === "newer") newerQueued.resolve();
      if (String(fields.requestId).startsWith("next-") && ++nextQueued === 2) nextCancelled.abort();
    }
  });
  const cancelled = new AbortController();
  const contexts = new Map<string, CloudflareExecutionContext>();
  const order: string[] = [];
  const execute = (requestId: string, signal?: AbortSignal) => {
    const context: CloudflareExecutionContext = { requestId, workload: "audio-translate", ...createDeadline(3000, signal),
      attempts: { used: 0, max: 3 }, admissionWait: { usedMs: 0 }, dispatcher };
    contexts.set(requestId, context);
    return dispatcher.execute({ context, operation: "audio_translation_text", model: TEXT_MODEL }, async () => {
      order.push(requestId);
    });
  };
  const older = assert.rejects(execute("older", cancelled.signal), { reason: "cancelled" });
  await olderQueued.promise;
  const newer = execute("newer");
  await newerQueued.promise;
  available = true;
  cancelled.abort();
  await Promise.all([older, newer]);
  assert.deepEqual(order, ["newer"]);
  assert.equal(contexts.get("older")!.attempts.used, 0);
  // A second full queue must have both of its places available after cleanup.
  available = false;
  await Promise.all(["next-a", "next-b"].map(id =>
    assert.rejects(execute(id, nextCancelled.signal), { reason: "cancelled" })));
  assert.equal(nextQueued, 2);
  assert.equal(contexts.get("next-a")!.attempts.used, 0);
  assert.equal(contexts.get("next-b")!.attempts.used, 0);
});
