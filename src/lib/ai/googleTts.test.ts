import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { AppError } from "../appError";
import {
  GoogleTtsProviderError,
  googleTtsVoiceName,
  isGoogleTtsBusy,
  resetGoogleTtsForTests,
  setGoogleTtsClientForTests,
  streamSpeechWithGoogle,
  synthesizeWithGoogle,
  toGoogleTtsAppError,
  type GoogleTtsClient,
} from "./googleTts";

const KEYS = ["GOOGLE_TTS_VOICE", "GOOGLE_TTS_TIMEOUT_MS", "GOOGLE_TTS_STREAM_TIMEOUT_MS", "GOOGLE_TTS_MAX_CONCURRENCY", "GOOGLE_TTS_QUEUE_WAIT_MS"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  resetGoogleTtsForTests();
});

afterEach(() => {
  setGoogleTtsClientForTests(undefined);
  resetGoogleTtsForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

type FakeCall = { requests: unknown[]; duplex: Duplex; ended: Promise<void> };

/** A StreamingSynthesize call: records what we send, `respond` plays Google's side. */
function fakeStreamingClient(respond: (call: FakeCall) => void): { client: GoogleTtsClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const client: GoogleTtsClient = {
    streamingSynthesize() {
      const requests: unknown[] = [];
      let markEnded: () => void = () => undefined;
      const ended = new Promise<void>(resolve => { markEnded = resolve; });
      const duplex = new Duplex({
        objectMode: true,
        read() {},
        write(chunk, _encoding, callback) { requests.push(chunk); callback(); },
        final(callback) { markEnded(); callback(); },
      });
      const call = { requests, duplex, ended };
      calls.push(call);
      queueMicrotask(() => respond(call));
      return duplex;
    },
    async synthesizeSpeech() { return assert.fail("unary call not expected"); },
  };
  return { client, calls };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const parts: number[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(...chunk);
  return parts;
}

const grpcError = (code: number) => Object.assign(new Error(`grpc ${code} echoed text`), { code });
const isReason = (reason: string) => (error: unknown) =>
  error instanceof GoogleTtsProviderError && error.reason === reason;

test("voice names join the Google locale of the language and the configured voice", () => {
  assert.equal(googleTtsVoiceName("zh"), "cmn-CN-Chirp3-HD-Aoede");
  assert.equal(googleTtsVoiceName("ja"), "ja-JP-Chirp3-HD-Aoede");
  assert.equal(googleTtsVoiceName("ko"), "ko-KR-Chirp3-HD-Aoede");
  assert.equal(googleTtsVoiceName("fr"), "fr-FR-Chirp3-HD-Aoede");
  process.env.GOOGLE_TTS_VOICE = "Chirp3-HD-Kore";
  assert.equal(googleTtsVoiceName("ko"), "ko-KR-Chirp3-HD-Kore");
});

test("streams PCM: config first, then the text, then half-close; odd bytes carry over", async () => {
  const { client, calls } = fakeStreamingClient(async call => {
    await call.ended;
    call.duplex.push({ audioContent: new Uint8Array([1, 2, 3]) });
    call.duplex.push({ audioContent: new Uint8Array([4]) });
    call.duplex.push(null);
  });
  setGoogleTtsClientForTests(client);
  const speech = await streamSpeechWithGoogle("今天我很开心。", "zh");
  assert.equal(speech.sampleRate, 24_000);
  assert.deepEqual(await readAll(speech.pcm), [1, 2, 3, 4]);
  assert.deepEqual(calls[0].requests, [
    {
      streamingConfig: {
        voice: { languageCode: "cmn-CN", name: "cmn-CN-Chirp3-HD-Aoede" },
        streamingAudioConfig: { audioEncoding: "PCM", sampleRateHertz: 24_000 },
      },
    },
    { input: { text: "今天我很开心。" } },
  ]);
});

test("a failure before the first audio rejects; RESOURCE_EXHAUSTED counts as busy", async () => {
  const { client } = fakeStreamingClient(call => { call.duplex.destroy(grpcError(8)); });
  setGoogleTtsClientForTests(client);
  const failure = await streamSpeechWithGoogle("Bonjour.", "fr").then(() => assert.fail("must reject"), (error: unknown) => error);
  assert.ok(isReason("rate_limited")(failure));
  assert.equal(isGoogleTtsBusy(failure), true);
  const publicError = toGoogleTtsAppError(failure);
  assert.ok(publicError instanceof AppError);
  assert.equal(publicError.code, "TTS_FAILED");
  assert.equal(publicError.status, 429);
  assert.equal(publicError.details?.provider, "google");
  assert.equal(publicError.details?.reason, "rate_limited");
  assert.ok(!publicError.message.includes("echoed text"));
});

test("an empty stream is an empty_response", async () => {
  const { client } = fakeStreamingClient(async call => { await call.ended; call.duplex.push(null); });
  setGoogleTtsClientForTests(client);
  await assert.rejects(streamSpeechWithGoogle("안녕.", "ko"), isReason("empty_response"));
});

test("a failure after the first audio errors the PCM stream", async () => {
  const { client } = fakeStreamingClient(async call => {
    await call.ended;
    call.duplex.push({ audioContent: new Uint8Array([1, 2]) });
    setTimeout(() => call.duplex.destroy(grpcError(13)), 5);
  });
  setGoogleTtsClientForTests(client);
  const speech = await streamSpeechWithGoogle("Bonjour.", "fr");
  await assert.rejects(readAll(speech.pcm), isReason("provider_error"));
});

test("the stream deadline ends a stalled call as a timeout", async () => {
  process.env.GOOGLE_TTS_STREAM_TIMEOUT_MS = "20";
  const { client, calls } = fakeStreamingClient(() => undefined);
  setGoogleTtsClientForTests(client);
  await assert.rejects(streamSpeechWithGoogle("Bonjour.", "fr"), isReason("timeout"));
  assert.equal(calls[0].duplex.destroyed, true);
});

test("a full queue refuses with queue_timeout instead of calling Google", async () => {
  process.env.GOOGLE_TTS_MAX_CONCURRENCY = "1";
  process.env.GOOGLE_TTS_QUEUE_WAIT_MS = "10";
  const { client, calls } = fakeStreamingClient(async call => {
    await call.ended;
    call.duplex.push({ audioContent: new Uint8Array([1, 2]) });
  });
  setGoogleTtsClientForTests(client);
  const held = await streamSpeechWithGoogle("一。", "zh");
  const refused = await streamSpeechWithGoogle("二。", "zh").then(() => assert.fail("must reject"), (error: unknown) => error);
  assert.ok(isReason("queue_timeout")(refused));
  assert.equal(isGoogleTtsBusy(refused), true);
  assert.equal(calls.length, 1);
  await held.pcm.cancel();
});

test("a call that cannot open frees its slot", async () => {
  process.env.GOOGLE_TTS_MAX_CONCURRENCY = "1";
  process.env.GOOGLE_TTS_QUEUE_WAIT_MS = "10";
  setGoogleTtsClientForTests({
    streamingSynthesize: () => { throw grpcError(14); },
    synthesizeSpeech: async () => assert.fail("unary call not expected"),
  });
  await assert.rejects(streamSpeechWithGoogle("一。", "zh"), isReason("network_error"));
  await assert.rejects(streamSpeechWithGoogle("二。", "zh"), isReason("network_error"), "the slot was released, so no queue_timeout");
});

test("a call closed without end or error fails at once, not at the deadline", async () => {
  const { client } = fakeStreamingClient(call => { call.duplex.destroy(); });
  setGoogleTtsClientForTests(client);
  const started = Date.now();
  await assert.rejects(streamSpeechWithGoogle("Bonjour.", "fr"), isReason("network_error"));
  assert.ok(Date.now() - started < 1_000);
});

test("a signal already aborted while the client starts ends the call", async () => {
  const { client, calls } = fakeStreamingClient(() => undefined);
  setGoogleTtsClientForTests(client);
  const controller = new AbortController();
  const pending = streamSpeechWithGoogle("Bonjour.", "fr", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, isReason("network_error"));
  assert.equal(calls[0]?.duplex.destroyed ?? true, true);
});

test("finished clips use SynthesizeSpeech: MP3, or LINEAR16 WAV at the stream's rate", async () => {
  const requests: unknown[] = [];
  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    async synthesizeSpeech(request) {
      requests.push(request);
      return [{ audioContent: new Uint8Array([7, 8, 9]) }];
    },
  });
  assert.deepEqual(new Uint8Array(await synthesizeWithGoogle("こんにちは。", "ja")), new Uint8Array([7, 8, 9]));
  await synthesizeWithGoogle("こんにちは。", "ja", { format: "wav" });
  assert.deepEqual(requests, [
    {
      input: { text: "こんにちは。" },
      voice: { languageCode: "ja-JP", name: "ja-JP-Chirp3-HD-Aoede" },
      audioConfig: { audioEncoding: "MP3" },
    },
    {
      input: { text: "こんにちは。" },
      voice: { languageCode: "ja-JP", name: "ja-JP-Chirp3-HD-Aoede" },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24_000 },
    },
  ]);
});

test("unary failures and empty audio become provider errors; bad voices are refused before calling", async () => {
  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    async synthesizeSpeech() { throw grpcError(4); },
  });
  await assert.rejects(synthesizeWithGoogle("Bonjour.", "fr"), isReason("timeout"));

  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    async synthesizeSpeech() { return [{ audioContent: new Uint8Array() }]; },
  });
  await assert.rejects(synthesizeWithGoogle("Bonjour.", "fr"), isReason("invalid_response"));

  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    synthesizeSpeech: async () => assert.fail("Google must not be called"),
  });
  process.env.GOOGLE_TTS_VOICE = "Aoede; drop";
  await assert.rejects(synthesizeWithGoogle("Bonjour.", "fr"), isReason("invalid_voice"));
  const publicError = toGoogleTtsAppError(new GoogleTtsProviderError("invalid_voice"));
  assert.ok(publicError instanceof AppError && publicError.status === 500);
});
