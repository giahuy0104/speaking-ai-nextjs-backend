import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPoolRuntime } from "./runtime";
import { MemoryAdmissionStore } from "./memoryAdmissionStore";
import { ASR_MODEL, poolEnv } from "./poolTestFixtures";

test("flag OFF does not parse pool configuration, initialize or connect store", async () => {
  let initialized = 0;
  const runtime = createPoolRuntime({ env: { CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false", CLOUDFLARE_ACCOUNTS_JSON: "broken secret" },
    storeFactory: () => { initialized++; throw new Error(); } });
  assert.equal(runtime.createAudioTranslationExecution({ requestId: "legacy" }), undefined);
  assert.equal(initialized, 0); await runtime.close();
});

test("enabled config errors are lazy and sanitized", () => {
  const runtime = createPoolRuntime({ env: { CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", CLOUDFLARE_ACCOUNTS_JSON: "secret" } });
  assert.throws(() => runtime.createAudioTranslationExecution({ requestId: "bad" }), { reason: "configuration", status: 503 });
});

test("pool needs no legacy token, shares one lazy store and keeps request state isolated", async () => {
  let initialized = 0; const env = poolEnv(); env.CLOUDFLARE_POOL_MAX_IN_FLIGHT = "2";
  const runtime = createPoolRuntime({ env, storeFactory: () => { initialized++; return new MemoryAdmissionStore(); } });
  const first = runtime.createAudioTranslationExecution({ requestId: "one" })!;
  const second = runtime.createAudioTranslationExecution({ requestId: "two" })!;
  assert.equal(initialized, 0);
  assert.throws(() => runtime.createAudioTranslationExecution({ requestId: "three" }), { reason: "capacity", status: 429 });
  await Promise.all([first, second].map(({ execution }) => execution.dispatcher.execute({ context: execution, operation: "audio_translation_asr", model: ASR_MODEL }, async () => "okay")));
  assert.equal(initialized, 1);
  assert.notEqual(first.execution.signal, second.execution.signal);
  assert.notEqual(first.execution.attempts, second.execution.attempts);
  assert.equal(first.execution.attempts.used, 1); assert.equal(second.execution.requestId, "two");
  first.release(); first.release();
  const third = runtime.createAudioTranslationExecution({ requestId: "three" })!;
  assert.throws(() => runtime.createAudioTranslationExecution({ requestId: "four" }), { reason: "capacity" });
  second.release(); third.release(); await runtime.close();
});

test("failed Redis initialization never falls back to memory or legacy provider", async () => {
  let initialized = 0; const runtime = createPoolRuntime({ env: poolEnv(), storeFactory: () => { initialized++; throw new Error("redis://password"); } });
  const first = runtime.createAudioTranslationExecution({ requestId: "failure" })!;
  let calls = 0;
  await assert.rejects(first.execution.dispatcher.execute({ context: first.execution, operation: "audio_translation_asr", model: ASR_MODEL }, async () => { calls++; }), { reason: "store_unavailable" });
  assert.equal(initialized, 1); assert.equal(calls, 0); first.release(); await runtime.close();
});

test("an established failed connection is replaced only on a later request", async () => {
  let initialized = 0; let closed = 0;
  const broken = new MemoryAdmissionStore();
  const originalSnapshot = broken.snapshot.bind(broken);
  let fail = false;
  broken.snapshot = async (...args) => { if (fail) throw new Error("dead socket credentials"); return originalSnapshot(...args); };
  broken.close = async () => { closed++; };
  const runtime = createPoolRuntime({ env: poolEnv(), storeFactory: () => ++initialized === 1 ? broken : new MemoryAdmissionStore() });
  const run = async () => {
    const handle = runtime.createAudioTranslationExecution({ requestId: "recover" })!;
    try { return await handle.execution.dispatcher.execute({ context: handle.execution, operation: "audio_translation_asr", model: ASR_MODEL }, async () => "okay"); }
    finally { handle.release(); }
  };
  assert.equal(await run(), "okay");
  fail = true;
  await assert.rejects(run(), { reason: "store_unavailable" });
  assert.equal(initialized, 1);
  assert.equal(await run(), "okay");
  assert.equal(initialized, 2); assert.equal(closed, 1); await runtime.close();
});

test("local two-account requests distribute work while production rejects shared legacy", async () => {
  const env = {
    ...poolEnv(), NODE_ENV: "development", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_WORKERS_AI_API_TOKEN: "unchanged-legacy-token",
    CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST: "true",
  };
  const runtime = createPoolRuntime({ env, storeFactory: () => new MemoryAdmissionStore() });
  const sessions = ["first", "second"].map(requestId => runtime.createAudioTranslationExecution({ requestId })!);
  try {
    const aliases = await Promise.all(sessions.map(({ execution }) => execution.dispatcher.execute(
      { context: execution, operation: "audio_translation_asr", model: ASR_MODEL },
      async ({ account }) => { await delay(10); return account.alias; },
    )));
    assert.deepEqual([...aliases].sort(), ["audio-a", "audio-b"]);
    assert.equal(env.CLOUDFLARE_WORKERS_AI_API_TOKEN, "unchanged-legacy-token");
  } finally { sessions.forEach(session => session.release()); await runtime.close(); }
  const production = createPoolRuntime({ env: { ...env, NODE_ENV: "production", CLOUDFLARE_POOL_STORE: "redis", CLOUDFLARE_POOL_REDIS_URL: "redis://127.0.0.1:6379" } });
  assert.throws(() => production.createAudioTranslationExecution({ requestId: "production" }), { reason: "configuration", status: 503 });
  const disabled = createPoolRuntime({ env: { ...env, NODE_ENV: "production", CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false" } });
  assert.equal(disabled.createAudioTranslationExecution({ requestId: "legacy-off" }), undefined);
});

test("request bursts wait FIFO with one total deadline and cancellation frees a pending place", async () => {
  const env = { ...poolEnv(), CLOUDFLARE_POOL_MAX_IN_FLIGHT: "1", CLOUDFLARE_POOL_MAX_QUEUED: "1", CLOUDFLARE_POOL_MAX_WAIT_MS: "1000" };
  const runtime = createPoolRuntime({ env, storeFactory: () => new MemoryAdmissionStore() });
  const first = await runtime.acquireAudioTranslationExecution({ requestId: "active" });
  const controller = new AbortController();
  const cancelled = runtime.acquireAudioTranslationExecution({ requestId: "cancel", signal: controller.signal });
  await assert.rejects(runtime.acquireAudioTranslationExecution({ requestId: "overflow" }), { reason: "queue_full" });
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  const began = Date.now();
  const next = runtime.acquireAudioTranslationExecution({ requestId: "wait" });
  await delay(15); first!.release();
  const handle = (await next)!;
  assert.ok(handle.execution.deadlineAt <= began + 20_005);
  assert.ok(handle.execution.admissionWait!.usedMs >= 10);
  handle.release(); await runtime.close();
});

test("upload reservations cap counts and bytes before parsing and are released idempotently", () => {
  const env = { ...poolEnv(), CLOUDFLARE_POOL_MAX_IN_FLIGHT: "1", CLOUDFLARE_POOL_MAX_QUEUED: "1", CLOUDFLARE_POOL_MAX_BUFFERED_BYTES: "1024" };
  const runtime = createPoolRuntime({ env });
  const reserve = (requestBytes: number) => runtime.reserveAudioTranslationUpload({ requestId: "upload", requestBytes })!;
  const first = reserve(600);
  assert.throws(() => reserve(500), { reason: "queue_full" });
  const second = reserve(1);
  assert.throws(() => reserve(1), { reason: "queue_full" });
  first.release(); first.release(); second.release();
  reserve(1024).release();
  const off = createPoolRuntime({ env: { CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "false", CLOUDFLARE_POOL_MAX_BUFFERED_BYTES: "broken" } });
  assert.equal(off.reserveAudioTranslationUpload({ requestId: "off", requestBytes: 1 }), undefined);
});
