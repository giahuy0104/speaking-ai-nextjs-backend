import assert from "node:assert/strict";
import { test } from "node:test";
import { createTargetAudioUrl, verifyTargetAudioUrl } from "./targetAudioUrl";
import { consumeAudioStreamToken, getUncachedEnglishAudioStreamUrl } from "./tts";
import { createTargetSpeechStreams } from "./targetSpeechStreams";
import { signUncachedEnglishAudio, verifyUncachedEnglishAudio } from "./loadTestPersistence";

const env = { INSTALLATION_AUTH_SECRET: "s".repeat(40), AUDIO_STREAM_NODE: "3001" };
const now = 1_800_000_000_000;
const paramsOf = (url: string) => new URL(url, "https://api.test").searchParams;

test("a load-test target URL carries a signed job id; URLs without one still verify", () => {
  const withJob = createTargetAudioUrl("zh", "今天天气晴朗好看", { env, now, jobId: "job_abc123" })!;
  assert.equal(paramsOf(withJob).get("job"), "job_abc123");
  assert.deepEqual(verifyTargetAudioUrl(paramsOf(withJob), { env, now }),
    { language: "zh", text: "今天天气晴朗好看", jobId: "job_abc123" });

  const plain = createTargetAudioUrl("zh", "今天天气晴朗好看", { env, now })!;
  assert.equal(paramsOf(plain).get("job"), null);
  assert.deepEqual(verifyTargetAudioUrl(paramsOf(plain), { env, now }), { language: "zh", text: "今天天气晴朗好看" });
});

test("the job id cannot be added, removed or changed without breaking the signature", () => {
  const withJob = paramsOf(createTargetAudioUrl("ja", "こんにちは", { env, now, jobId: "job_a" })!);
  const changed = new URLSearchParams(withJob);
  changed.set("job", "job_b");
  assert.equal(verifyTargetAudioUrl(changed, { env, now }), undefined);
  const removed = new URLSearchParams(withJob);
  removed.delete("job");
  assert.equal(verifyTargetAudioUrl(removed, { env, now }), undefined);
  const added = paramsOf(createTargetAudioUrl("ja", "こんにちは", { env, now })!);
  added.set("job", "job_a");
  assert.equal(verifyTargetAudioUrl(added, { env, now }), undefined);
  assert.equal(createTargetAudioUrl("ja", "こんにちは", { env, now, jobId: "bad id!" }), undefined);
});

test("an uncached English stream URL carries a single-use token that bypasses every cache", () => {
  const result = getUncachedEnglishAudioStreamUrl("Today the weather is sunny.");
  assert.equal(result.cacheReady, false);
  const params = paramsOf(result.audioUrl!);
  const token = params.get("missToken");
  assert.ok(token);
  assert.deepEqual(consumeAudioStreamToken(token, params.get("text") ?? ""), { knownCacheMiss: true, bypassCache: true });
  assert.deepEqual(consumeAudioStreamToken(token, params.get("text") ?? ""), { knownCacheMiss: false, bypassCache: false },
    "the token is single-use");
});

test("an uncached English token does not work for a different sentence", () => {
  const params = paramsOf(getUncachedEnglishAudioStreamUrl("Hello there.").audioUrl!);
  assert.deepEqual(consumeAudioStreamToken(params.get("missToken"), "Something else."), { knownCacheMiss: false, bypassCache: false });
});

test("a stream started under its own key is not shared with the same sentence's key", async () => {
  const streams = createTargetSpeechStreams({
    openPcm: async () => ({
      pcm: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4800)); } }),
      sampleRate: 24_000,
    }),
    fallback: async () => new ArrayBuffer(0),
    log: () => undefined,
  });
  void streams.start("今天天气晴朗好看", "zh", "uncached\njob_1").catch(() => undefined);
  assert.equal(streams.subscribe("今天天气晴朗好看", "zh"), null, "a real user's request cannot join a load-test turn");
  assert.ok(streams.subscribeKey("uncached\njob_1"));
});

test("the English no-cache signature survives retries and other backends, and only while the bypass is on", () => {
  const on = { INSTALLATION_AUTH_SECRET: "s".repeat(40), LOAD_TEST_BYPASS_AUDIO_CACHE: "true" };
  const signed = signUncachedEnglishAudio("Today the weather is sunny.", { env: on, now })!;
  assert.ok(signed);
  // Verifying again (a retry) still works: the signature is not single-use.
  assert.equal(verifyUncachedEnglishAudio(signed, "Today the weather is sunny.", { env: on, now }), true);
  assert.equal(verifyUncachedEnglishAudio(signed, " Today the weather is sunny. ", { env: on, now: now + 1000 }), true);
  assert.equal(verifyUncachedEnglishAudio(signed, "Another sentence.", { env: on, now }), false);
  assert.equal(verifyUncachedEnglishAudio(signed, "Today the weather is sunny.", { env: on, now: now + 16 * 60_000 }), false, "expired");
  assert.equal(verifyUncachedEnglishAudio(signed, "Today the weather is sunny.", { env: { ...on, LOAD_TEST_BYPASS_AUDIO_CACHE: "" }, now }), false,
    "useless once the dev bypass is off");
  assert.equal(verifyUncachedEnglishAudio("123.forged", "Today the weather is sunny.", { env: on, now }), false);
  assert.equal(signUncachedEnglishAudio("x", { env: { INSTALLATION_AUTH_SECRET: "s".repeat(40) }, now }), undefined);
});
