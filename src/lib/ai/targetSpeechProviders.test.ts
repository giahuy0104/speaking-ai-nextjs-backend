import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { afterEach, test } from "node:test";
import { AppError } from "../appError";
import { DeepInfraProviderError } from "./deepInfra";
import { GoogleTtsProviderError, resetGoogleTtsForTests, setGoogleTtsClientForTests } from "./googleTts";
import { speechStreamProvider } from "./targetSpeechProviders";

afterEach(() => {
  setGoogleTtsClientForTests(undefined);
  resetGoogleTtsForTests();
  delete process.env.GOOGLE_TTS_VOICE;
  delete process.env.GOOGLE_TTS_FALLBACK_VOICE_ZH;
});

test("google streams only while its stream voice is Chirp 3 HD; DeepInfra always can", () => {
  assert.equal(speechStreamProvider("google").canStream("ko"), true);
  process.env.GOOGLE_TTS_VOICE = "Neural2-A";
  assert.equal(speechStreamProvider("google").canStream("ko"), false);
  assert.equal(speechStreamProvider("deepinfra").canStream("ko"), true);
});

test("google streams PCM through StreamingSynthesize and falls back to a LINEAR16 WAV clip", async () => {
  const unary: unknown[] = [];
  setGoogleTtsClientForTests({
    streamingSynthesize() {
      const duplex = new Duplex({
        objectMode: true,
        read() {},
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
          callback();
          duplex.push({ audioContent: new Uint8Array([1, 2]) });
          duplex.push(null);
        },
      });
      return duplex;
    },
    async synthesizeSpeech(request) { unary.push(request); return [{ audioContent: new Uint8Array([9]) }]; },
  });
  const provider = speechStreamProvider("google");
  const speech = await provider.openPcm("今天我很开心。", "zh");
  assert.equal(speech.sampleRate, 24_000);
  assert.deepEqual(new Uint8Array(await new Response(speech.pcm).arrayBuffer()), new Uint8Array([1, 2]));
  assert.deepEqual(new Uint8Array(await provider.fallback("今天我很开心。", "zh")), new Uint8Array([9]));
  assert.deepEqual((unary[0] as { audioConfig: unknown }).audioConfig, { audioEncoding: "LINEAR16", sampleRateHertz: 24_000 });
});

test("google's stand-in clip uses GOOGLE_TTS_FALLBACK_VOICE_<LANG> when set", async () => {
  const unary: Array<{ voice: { name: string } }> = [];
  setGoogleTtsClientForTests({
    streamingSynthesize() { throw new Error("unused"); },
    async synthesizeSpeech(request) { unary.push(request as { voice: { name: string } }); return [{ audioContent: new Uint8Array([9]) }]; },
  });
  const provider = speechStreamProvider("google");
  assert.equal(provider.fallbackKeepsVoice("zh"), true);
  await provider.fallback("今天我很开心。", "zh");
  process.env.GOOGLE_TTS_FALLBACK_VOICE_ZH = "Wavenet-A";
  assert.equal(provider.fallbackKeepsVoice("zh"), false);
  assert.equal(provider.fallbackKeepsVoice("ja"), true, "only the configured language changes voice");
  await provider.fallback("今天我很开心。", "zh");
  assert.deepEqual(unary.map(request => request.voice.name), ["cmn-CN-Chirp3-HD-Aoede", "cmn-CN-Wavenet-A"]);
});

test("google falls back after its own 429 only to another voice, never after a full local queue", () => {
  const google = speechStreamProvider("google");
  const rateLimited = new GoogleTtsProviderError("rate_limited");
  const queueFull = new GoogleTtsProviderError("queue_timeout");

  assert.equal(google.canFallback(rateLimited, "zh"), false, "the same Chirp 3 HD voice would be refused again");
  assert.equal(google.canFallback(new GoogleTtsProviderError("provider_error"), "zh"), true);
  process.env.GOOGLE_TTS_FALLBACK_VOICE_ZH = "Wavenet-A";
  assert.equal(google.canFallback(rateLimited, "zh"), true);
  assert.equal(google.canFallback(new GoogleTtsProviderError("quota_exceeded", undefined, "chirp3_rpm"), "zh"), true,
    "our own count of the Chirp 3 HD quota leaves the fallback voice's quota");
  assert.equal(google.canFallback(queueFull, "zh"), false, "the stand-in would wait in the same local queue");
  assert.equal(google.canFallback(rateLimited, "ja"), false);
});

test("each provider recognises only its own busy errors and maps only its own errors", () => {
  const google = speechStreamProvider("google");
  const deepinfra = speechStreamProvider("deepinfra");
  const googleBusy = new GoogleTtsProviderError("rate_limited");
  const deepInfraBusy = new DeepInfraProviderError("rate_limited");

  assert.equal(google.canFallback(googleBusy, "ko"), false);
  assert.equal(deepinfra.canFallback(deepInfraBusy, "ko"), false);
  assert.equal(deepinfra.canFallback(new DeepInfraProviderError("provider_error"), "ko"), true);

  const mapped = google.toPublicError(googleBusy);
  assert.ok(mapped instanceof AppError && mapped.details?.provider === "google" && mapped.status === 429);
  const mappedDeepInfra = deepinfra.toPublicError(deepInfraBusy);
  assert.ok(mappedDeepInfra instanceof AppError && mappedDeepInfra.details?.provider === "deepinfra");
});
