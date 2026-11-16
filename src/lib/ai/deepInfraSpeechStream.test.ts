import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DeepInfraProviderError, setDeepInfraTransportForTests, streamSpeechWithDeepInfra } from "./deepInfra";

const KEYS = ["DEEPINFRA_API_KEY", "DEEPINFRA_BASE_URL", "DEEPINFRA_TTS_MODEL", "DEEPINFRA_TTS_VOICE", "DEEPINFRA_TTS_TIMEOUT_MS", "DEEPINFRA_TTS_STREAM_TIMEOUT_MS"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  process.env.DEEPINFRA_API_KEY = "test-key";
  delete process.env.DEEPINFRA_BASE_URL;
  delete process.env.DEEPINFRA_TTS_MODEL;
  delete process.env.DEEPINFRA_TTS_VOICE;
  delete process.env.DEEPINFRA_TTS_TIMEOUT_MS;
  delete process.env.DEEPINFRA_TTS_STREAM_TIMEOUT_MS;
});

afterEach(() => {
  setDeepInfraTransportForTests(undefined);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

function pcmResponse(chunks: Uint8Array[], headers: Record<string, string> = { "Content-Type": "audio/pcm" }, status = 200) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }), { status, headers });
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const parts: number[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(...chunk);
  return parts;
}

const isReason = (reason: string, status?: number) => (error: unknown) =>
  error instanceof DeepInfraProviderError && error.reason === reason && (status === undefined || error.status === status);

test("streams PCM from the ElevenLabs-style endpoint with Qwen3-TTS and the Sohee voice", async () => {
  let calls = 0;
  setDeepInfraTransportForTests(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepinfra.com/v1/text-to-speech/Sohee/stream?output_format=pcm");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(String(init.body)), {
      text: "今天我很开心。", model_id: "Qwen/Qwen3-TTS", output_format: "pcm", language_code: "zh",
    });
    return pcmResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  });
  const speech = await streamSpeechWithDeepInfra("今天我很开心。", "zh");
  assert.equal(speech.sampleRate, 24_000);
  assert.deepEqual(await readAll(speech.pcm), [1, 2, 3, 4]);
  assert.equal(calls, 1);
});

test("upstream errors, a non-PCM body and an empty stream are provider errors", async () => {
  setDeepInfraTransportForTests(async () => pcmResponse([new TextEncoder().encode("echoed text")], { "Content-Type": "text/plain" }, 500));
  await assert.rejects(streamSpeechWithDeepInfra("Bonjour.", "fr"), isReason("provider_error", 500));

  setDeepInfraTransportForTests(async () => pcmResponse([], { "Content-Type": "text/plain" }, 429));
  await assert.rejects(streamSpeechWithDeepInfra("Bonjour.", "fr"), isReason("rate_limited", 429));

  setDeepInfraTransportForTests(async () => pcmResponse([new Uint8Array([1])], { "Content-Type": "audio/mpeg" }));
  await assert.rejects(streamSpeechWithDeepInfra("Bonjour.", "fr"), isReason("invalid_response"));

  setDeepInfraTransportForTests(async () => pcmResponse([]));
  const empty = await streamSpeechWithDeepInfra("Bonjour.", "fr");
  await assert.rejects(readAll(empty.pcm), isReason("empty_response"));
});

test("a stream that stalls past the deadline fails with a timeout", async () => {
  process.env.DEEPINFRA_TTS_STREAM_TIMEOUT_MS = "50";
  setDeepInfraTransportForTests(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
    },
  }), { headers: { "Content-Type": "audio/pcm" } }));
  const speech = await streamSpeechWithDeepInfra("안녕.", "ko");
  await assert.rejects(readAll(speech.pcm), isReason("timeout"));
});

test("an invalid voice setting is rejected before any request", async () => {
  process.env.DEEPINFRA_TTS_VOICE = "../admin";
  setDeepInfraTransportForTests(async () => assert.fail("must not call DeepInfra"));
  await assert.rejects(streamSpeechWithDeepInfra("今日は。", "ja"), isReason("invalid_voice"));
});

test("chunks are re-aligned to whole 16-bit samples when upstream splits one", async () => {
  setDeepInfraTransportForTests(async () => pcmResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6, 7])]));
  const speech = await streamSpeechWithDeepInfra("今日は。", "ja");
  const lengths: number[] = [];
  const bytes: number[] = [];
  for await (const chunk of speech.pcm as unknown as AsyncIterable<Uint8Array>) { lengths.push(chunk.byteLength); bytes.push(...chunk); }
  assert.ok(lengths.every(length => length % 2 === 0), `odd chunk in ${lengths}`);
  // The trailing half sample is dropped rather than played as noise.
  assert.deepEqual(bytes, [1, 2, 3, 4, 5, 6]);
});

test("cancelling the PCM stream cancels the upstream body", async () => {
  let cancelled = false;
  setDeepInfraTransportForTests(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "audio/pcm" } }));
  const speech = await streamSpeechWithDeepInfra("안녕.", "ko");
  const reader = speech.pcm.getReader();
  await reader.read();
  await reader.cancel("listener left");
  assert.equal(cancelled, true);
});

test("a transport failure is a network error and a caller abort is not reported as a timeout", async () => {
  setDeepInfraTransportForTests(async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(streamSpeechWithDeepInfra("Bonjour.", "fr"), isReason("network_error"));

  const caller = new AbortController();
  setDeepInfraTransportForTests(async (_url, init) => {
    caller.abort();
    throw init.signal?.reason ?? new Error("aborted");
  });
  await assert.rejects(streamSpeechWithDeepInfra("Bonjour.", "fr", { signal: caller.signal }), isReason("network_error"));
});

test("a custom base URL keeps its host and drops only the /openai suffix", async () => {
  process.env.DEEPINFRA_BASE_URL = "http://127.0.0.1:9999/v1/openai/";
  let requested = "";
  setDeepInfraTransportForTests(async url => { requested = url; return pcmResponse([new Uint8Array([0, 0])]); });
  await (await streamSpeechWithDeepInfra("Hi.", "en")).pcm.cancel();
  assert.equal(requested, "http://127.0.0.1:9999/v1/text-to-speech/Sohee/stream?output_format=pcm");
});
