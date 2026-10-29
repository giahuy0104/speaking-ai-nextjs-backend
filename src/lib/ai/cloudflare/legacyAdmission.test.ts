import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLegacyCloudflareFetch } from "./legacyAdmission";
import { createPoolRuntime } from "./runtime";
import { MemoryAdmissionStore } from "./memoryAdmissionStore";
import { parsePoolConfig } from "./accountConfig";
import { ASR_MODEL, poolEnv } from "./poolTestFixtures";
import { quotaRules } from "./quotaPolicy";
import { getFailureDiagnostics } from "./providerError";

const tts = "@cf/deepgram/aura-1";
function setup(overrides: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...poolEnv(), CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT: "true", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_POOL_MAX_WAIT_MS: "50", CLOUDFLARE_POOL_MIN_ATTEMPT_MS: "1", ...overrides };
  const accounts = JSON.parse(env.CLOUDFLARE_ACCOUNTS_JSON!);
  accounts[0].capabilities.tts = [tts, "xai/grok-tts"];
  accounts[0].capabilities.text.push("@cf/qwen/qwen3-30b-a3b-fp8");
  accounts[0].limits.tts = { rpm: 60, burst: 10, maxConcurrent: 2 };
  accounts[0].limits.accountMaxConcurrent = 1;
  env.CLOUDFLARE_ACCOUNTS_JSON = JSON.stringify(accounts);
  const store = new MemoryAdmissionStore();
  const runtime = createPoolRuntime({ env, storeFactory: () => store, telemetry: () => {} });
  const config = parsePoolConfig(env);
  const active = async (task: "asr" | "tts" = "tts") => (await store.snapshot(config.accounts[0].identity,
    quotaRules(config.accounts[0], task === "asr" ? "legacy_asr" : "legacy_tts", task === "asr" ? ASR_MODEL : tts))).active;
  return { env, runtime, store, config, active, fetch: createLegacyCloudflareFetch(runtime) };
}
const url = (model = tts) => `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/${model}`;

test("legacy off ignores invalid pool config and preserves the original fetch", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const runtime = createPoolRuntime({ env: { CLOUDFLARE_ACCOUNTS_JSON: "invalid" }, storeFactory: () => { throw Error("must not connect"); } });
  const response = Response.json({ result: { text: "hello" } });
  globalThis.fetch = async () => response;
  assert.equal(await createLegacyCloudflareFetch(runtime)(url(), {}, { task: "tts", model: tts, timeoutMs: 1000 }), response);
  await runtime.close();
});

test("pooled ASR and pinned legacy TTS share account concurrency without switching legacy accounts", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = setup(); t.after(() => s.runtime.close());
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  const permit = await s.store.acquire({ accountIdentity: s.config.accounts[0].identity,
    rules: quotaRules(s.config.accounts[0], "audio_translation_asr", ASR_MODEL), leaseId: "held-asr", ttlMs: 1000 });
  assert.equal(permit.granted, true);
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(s.fetch(url(), {}, { task: "tts", model: tts, timeoutMs: 500 }), { status: 429, code: "TTS_FAILED" });
  assert.equal(calls, 0);
  assert.equal(await s.active(), 1);
  if (permit.granted) await s.store.complete(permit.permit, {});
});

test("JSON body is read under the permit and canonical registry credentials are used", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = setup(); t.after(() => s.runtime.close());
  let complete!: () => void;
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token-a");
    return new Response(new ReadableStream({ start(controller) { complete = () => { controller.enqueue(new TextEncoder().encode('{"result":{"text":"hello"}}')); controller.close(); }; } }));
  };
  const pending = s.fetch(url(ASR_MODEL), { headers: { Authorization: "Bearer obsolete" } }, { task: "asr", model: ASR_MODEL, timeoutMs: 1000 });
  while (!complete) await delay(1);
  assert.equal(await s.active("asr"), 1); complete();
  assert.equal((await (await pending).json()).result.text, "hello");
  await delay(1); assert.equal(await s.active(), 0);
});

test("streaming returns headers promptly and holds the permit until EOF or cancellation", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const cancel of [false, true]) {
    const s = setup();
    let finish!: () => void;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); finish = () => controller.close(); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "audio/mpeg" } });
    const response = await s.fetch(url(), {}, { task: "tts", model: tts, timeoutMs: 1000, stream: true });
    assert.equal(await s.active(), 1);
    if (cancel) await response.body!.cancel();
    else { finish(); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1])); }
    await delay(5); assert.equal(await s.active(), 0);
    assert.equal(cancelled, cancel); await s.runtime.close();
  }
});

test("client abort and deadline cancel a stalled stream and free the permit", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  for (const clientAbort of [true, false]) {
    const s = setup();
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController();
    const response = await s.fetch(url(), { signal: controller.signal }, { task: "tts", model: tts, timeoutMs: clientAbort ? 500 : 30, stream: true });
    const body = response.arrayBuffer();
    if (clientAbort) controller.abort();
    await assert.rejects(body, (error: unknown) => {
      assert.equal(getFailureDiagnostics(error).failureSource, clientAbort ? "client" : "backend"); return true;
    });
    await delay(5); assert.equal(await s.active(), 0); assert.equal(cancelled, true);
    await s.runtime.close();
  }
});

test("legacy HTTP failures do not retry; a model-specific 403 does not disable ASR", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = setup(); t.after(() => s.runtime.close());
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ errors: [{ code: 1234 }] }, { status: 403 }); };
  assert.equal((await s.fetch(url(), {}, { task: "tts", model: tts, timeoutMs: 1000 })).status, 403);
  assert.equal(calls, 1);
  await delay(1);
  const session = s.runtime.createAudioTranslationExecution({ requestId: "asr-after-tts" })!;
  assert.equal(await session.execution.dispatcher.execute({ context: session.execution, operation: "audio_translation_asr", model: ASR_MODEL,
    accountIdentity: s.config.accounts[0].identity }, async () => "okay"), "okay");
  session.release();
});

test("Redis failure fails closed without calling the provider or exposing details", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = setup(); t.after(() => s.runtime.close());
  s.store.snapshot = async () => { throw Error("redis://private-password"); };
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(s.fetch(url(), {}, { task: "tts", model: tts, timeoutMs: 1000 }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503); assert.doesNotMatch(String(error), /private-password/); return true;
  });
  assert.equal(calls, 0);
});

test("migration reserves legacy account first, then routes pooled traffic to both accounts", async t => {
  for (const enabled of [false, true]) {
    const s = setup({ CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT: String(enabled) });
    t.after(() => s.runtime.close());
    const aliases = new Set<string>();
    for (let index = 0; index < 4; index++) {
      const handle = s.runtime.createAudioTranslationExecution({ requestId: `migration-${index}` })!;
      try {
        aliases.add(await handle.execution.dispatcher.execute({ context: handle.execution, operation: "audio_translation_asr", model: ASR_MODEL },
          async ({ account }) => account.alias));
      } finally { handle.release(); }
    }
    assert.deepEqual([...aliases].sort(), enabled ? ["audio-a", "audio-b"] : ["audio-b"]);
  }
});

test("all legacy ASR, text and TTS callers use shared admission and preserve their contracts", async t => {
  const originalFetch = globalThis.fetch;
  const s = setup();
  const originalEnv = { ...process.env };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    return s.runtime.close();
  });
  Object.assign(process.env, s.env, { CLOUDFLARE_WORKERS_AI_API_TOKEN: "obsolete-legacy-token" });
  const workers = await import("../cloudflareWorkersAi");
  const text = await import("../cloudflareText");
  const provider = await import("../aiProvider");
  let inferences = 0;
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (target === "https://audio.r2.dev/result.mp3") return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "audio/mpeg" } });
    inferences++;
    assert.ok(target.includes(`/accounts/${"a".repeat(32)}/`));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token-a");
    if (target.endsWith("/ai/run")) return Response.json({ result: { audio: "https://audio.r2.dev/result.mp3" } });
    if (target.includes("aura-1")) return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "audio/mpeg" } });
    if (target.includes("chat/completions")) return Response.json({ choices: [{ message: { content: "I feel better." } }] });
    return Response.json({ success: true, result: { text: "I feel better." } });
  };
  const audio = new File(["audio"], "speech.wav", { type: "audio/wav" });
  assert.equal((await workers.transcribeAudioToVietnamese(audio)).vietnameseText, "I feel better.");
  assert.equal((await workers.transcribeAudioToEnglish(audio)).englishText, "I feel better.");
  assert.equal((await workers.translateAudioToEnglish(audio, "en")).englishText, "I feel better.");
  assert.equal((await text.translateVietnameseWithCloudflare("Con khỏe rồi.", "Translate.")).englishText, "I feel better.");
  assert.equal((await provider.generateAiText({ input: "Con khỏe rồi.", instructions: "Translate.", maxOutputTokens: 64, timeoutMs: 1000 })).text, "I feel better.");
  assert.equal((await provider.transcribeVietnameseAudio(audio)).text, "I feel better.");
  const speech = await provider.requestEnglishSpeech("Hello.", provider.getConfiguredTtsProfile());
  assert.equal((await speech.response.arrayBuffer()).byteLength, 2);
  assert.equal((await provider.requestTargetSpeech("Bonjour.", "fr")).byteLength, 2);
  assert.equal(inferences, 8);
});
