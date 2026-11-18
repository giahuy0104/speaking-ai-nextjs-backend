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

test("each provider recognises only its own busy errors and maps only its own errors", () => {
  const google = speechStreamProvider("google");
  const deepinfra = speechStreamProvider("deepinfra");
  const googleBusy = new GoogleTtsProviderError("rate_limited");
  const deepInfraBusy = new DeepInfraProviderError("rate_limited");

  assert.equal(google.isBusy(googleBusy), true);
  assert.equal(google.isBusy(new GoogleTtsProviderError("provider_error")), false);
  assert.equal(deepinfra.isBusy(deepInfraBusy), true);

  const mapped = google.toPublicError(googleBusy);
  assert.ok(mapped instanceof AppError && mapped.details?.provider === "google" && mapped.status === 429);
  const mappedDeepInfra = deepinfra.toPublicError(deepInfraBusy);
  assert.ok(mappedDeepInfra instanceof AppError && mappedDeepInfra.details?.provider === "deepinfra");
});
