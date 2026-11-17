import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  DeepInfraProviderError,
  resetDeepInfraTtsLimiterForTests,
  setDeepInfraTransportForTests,
  streamSpeechWithDeepInfra,
  synthesizeWithDeepInfra,
  toDeepInfraTtsAppError,
} from "./deepInfra";
import { AppError } from "../appError";

const KEYS = ["DEEPINFRA_API_KEY", "DEEPINFRA_TTS_MAX_CONCURRENCY", "DEEPINFRA_TTS_QUEUE_WAIT_MS", "DEEPINFRA_TTS_STREAM_TIMEOUT_MS"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  process.env.DEEPINFRA_API_KEY = "test-key";
  process.env.DEEPINFRA_TTS_MAX_CONCURRENCY = "1";
  process.env.DEEPINFRA_TTS_QUEUE_WAIT_MS = "2000";
  resetDeepInfraTtsLimiterForTests();
});

afterEach(() => {
  setDeepInfraTransportForTests(undefined);
  resetDeepInfraTtsLimiterForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const mp3 = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });

test("a speech call over the cap waits for a free slot instead of reaching DeepInfra", async () => {
  const firstResponse = deferred<Response>();
  let calls = 0;
  setDeepInfraTransportForTests(async () => {
    calls++;
    return calls === 1 ? firstResponse.promise : mp3();
  });

  const first = synthesizeWithDeepInfra("一");
  const second = synthesizeWithDeepInfra("二");
  await tick();
  assert.equal(calls, 1, "second call is held back while the first holds the only slot");

  firstResponse.resolve(mp3());
  await first;
  await second;
  assert.equal(calls, 2);
});

test("a call that waits longer than the queue limit fails as busy (429), without calling DeepInfra", async () => {
  process.env.DEEPINFRA_TTS_QUEUE_WAIT_MS = "30";
  resetDeepInfraTtsLimiterForTests();
  const firstResponse = deferred<Response>();
  let calls = 0;
  setDeepInfraTransportForTests(async () => {
    calls++;
    return firstResponse.promise;
  });

  const first = synthesizeWithDeepInfra("一");
  await assert.rejects(synthesizeWithDeepInfra("二"), (error: unknown) => {
    assert.ok(error instanceof DeepInfraProviderError && error.reason === "queue_timeout");
    const appError = toDeepInfraTtsAppError(error);
    assert.ok(appError instanceof AppError && appError.status === 429 && appError.details?.reason === "queue_timeout");
    return true;
  });
  assert.equal(calls, 1);
  firstResponse.resolve(mp3());
  await first;
});

test("a failed call frees its slot", async () => {
  let calls = 0;
  setDeepInfraTransportForTests(async () => {
    calls++;
    return calls === 1 ? new Response("busy", { status: 429 }) : mp3();
  });
  await assert.rejects(synthesizeWithDeepInfra("一"), (error: unknown) =>
    error instanceof DeepInfraProviderError && error.reason === "rate_limited");
  await synthesizeWithDeepInfra("二");
  assert.equal(calls, 2);
});

test("a stream holds its slot until it has been read to the end", async () => {
  let streamed = 0;
  let spoken = 0;
  setDeepInfraTransportForTests(async url => {
    if (String(url).includes("/stream")) {
      streamed++;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Type": "audio/pcm" } });
    }
    spoken++;
    return mp3();
  });

  const speech = await streamSpeechWithDeepInfra("一", "zh");
  const waiting = synthesizeWithDeepInfra("二");
  await tick();
  assert.equal(spoken, 0, "the open stream still holds the slot");

  const reader = speech.pcm.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  await waiting;
  assert.equal(streamed, 1);
  assert.equal(spoken, 1);
});

test("a cancelled stream frees its slot", async () => {
  setDeepInfraTransportForTests(async url => String(url).includes("/stream")
    ? new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), {
      status: 200, headers: { "Content-Type": "audio/pcm" } })
    : mp3());

  const speech = await streamSpeechWithDeepInfra("一", "zh");
  const waiting = synthesizeWithDeepInfra("二");
  await speech.pcm.cancel();
  await waiting;
});

test("a stream refused by DeepInfra frees its slot", async () => {
  let calls = 0;
  setDeepInfraTransportForTests(async url => {
    calls++;
    return String(url).includes("/stream") ? new Response("busy", { status: 429 }) : mp3();
  });
  await assert.rejects(streamSpeechWithDeepInfra("一", "zh"), (error: unknown) =>
    error instanceof DeepInfraProviderError && error.reason === "rate_limited");
  await synthesizeWithDeepInfra("二");
  assert.equal(calls, 2);
});

test("a stream nobody reads after its first chunk frees its slot at the stream deadline", async () => {
  process.env.DEEPINFRA_TTS_STREAM_TIMEOUT_MS = "50";
  let spoken = 0;
  setDeepInfraTransportForTests(async (url, init) => {
    if (!String(url).includes("/stream")) {
      spoken++;
      return mp3();
    }
    const signal = (init as RequestInit).signal!;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      pull: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    }), { status: 200, headers: { "Content-Type": "audio/pcm" } });
  });

  // Nobody reads: the stream buffers its first chunk and then has no pull pending.
  await streamSpeechWithDeepInfra("一", "zh");
  await synthesizeWithDeepInfra("二"); // would time out in the queue if the stalled stream kept its slot
  assert.equal(spoken, 1);
});
