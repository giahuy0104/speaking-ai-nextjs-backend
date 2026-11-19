import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import {
  englishSpeechFallbackProfiles,
  englishSpeechMode,
  englishTtsProvider,
  getEnglishTtsProfile,
  requestEnglishSpeechAudio,
} from "./englishSpeech";
import { AppError } from "../appError";
import { resetGoogleTtsForTests, setGoogleTtsClientForTests, type GoogleTtsClient } from "./googleTts";

const KEYS = [
  "AUDIO_ENGLISH_TTS_PROVIDER", "AUDIO_ENGLISH_STREAM_MIN_CHARS", "AUDIO_ENGLISH_CLOUDFLARE_FALLBACK", "GOOGLE_TTS_VOICE", "GOOGLE_TTS_CLIP_VOICE_EN",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_AI_API_TOKEN", "CLOUDFLARE_TTS_MODEL", "CLOUDFLARE_TTS_SPEAKER",
] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

// 17 and 50 characters: about 1 s and 3 s of English.
const SHORT = "I like ice cream!";
const LONG = "This morning I woke up early and opened the window";

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  resetGoogleTtsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setGoogleTtsClientForTests(undefined);
  resetGoogleTtsForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

function useGoogle() {
  process.env.AUDIO_ENGLISH_TTS_PROVIDER = "google";
  process.env.GOOGLE_TTS_CLIP_VOICE_EN = "Neural2-F";
}

const grpcError = (code: number) => Object.assign(new Error(`grpc ${code}`), { code });

/** Google's two calls; `stream` plays StreamingSynthesize, `clip` answers SynthesizeSpeech. */
function fakeGoogle(handlers: {
  stream?: (duplex: Duplex) => void;
  clip?: (request: Parameters<GoogleTtsClient["synthesizeSpeech"]>[0]) => Promise<Uint8Array>;
}) {
  const calls = { stream: [] as unknown[][], clip: [] as string[] };
  const client: GoogleTtsClient = {
    streamingSynthesize() {
      const requests: unknown[] = [];
      calls.stream.push(requests);
      const duplex = new Duplex({
        objectMode: true,
        read() {},
        write(chunk, _encoding, callback) { requests.push(chunk); callback(); },
        final(callback) { queueMicrotask(() => handlers.stream?.(duplex)); callback(); },
      });
      return duplex;
    },
    async synthesizeSpeech(request) {
      calls.clip.push(request.voice.name);
      if (!handlers.clip) return assert.fail("clip not expected");
      return [{ audioContent: await handlers.clip(request) }];
    },
  };
  setGoogleTtsClientForTests(client);
  return calls;
}

function fakeCloudflare() {
  const urls: string[] = [];
  globalThis.fetch = async input => {
    urls.push(String(input));
    return new Response(new Uint8Array([7, 7, 7]), { headers: { "Content-Type": "audio/mpeg" } });
  };
  return urls;
}

test("English speech stays on Cloudflare unless AUDIO_ENGLISH_TTS_PROVIDER=google", () => {
  assert.equal(englishTtsProvider(), "cloudflare");
  process.env.AUDIO_ENGLISH_TTS_PROVIDER = " Google ";
  assert.equal(englishTtsProvider(), "google");
  process.env.AUDIO_ENGLISH_TTS_PROVIDER = "deepinfra";
  assert.throws(() => englishTtsProvider(), /không hợp lệ/);
});

test("with Cloudflare every sentence keeps the aura-1 profile", () => {
  assert.deepEqual(getEnglishTtsProfile(LONG), {
    provider: "cloudflare", model: "@cf/deepgram/aura-1", voice: "luna", speed: 1, extension: "mp3",
  });
  assert.deepEqual(getEnglishTtsProfile(), getEnglishTtsProfile(SHORT));
});

test("Google: under 50 characters (about 3 s) is a Neural2 clip, longer sentences stream Chirp 3 HD", () => {
  useGoogle();
  assert.equal(englishSpeechMode(SHORT), "clip");
  assert.equal(englishSpeechMode(LONG.slice(0, 49)), "clip");
  assert.equal(englishSpeechMode(LONG), "stream");
  assert.deepEqual(getEnglishTtsProfile(SHORT), {
    provider: "google", model: "google-cloud-tts", voice: "Neural2-F-en", speed: 1, extension: "mp3",
  });
  assert.deepEqual(getEnglishTtsProfile(LONG), {
    provider: "google", model: "google-cloud-tts", voice: "Chirp3-HD-Aoede-en", speed: 1, extension: "wav",
  });
  assert.deepEqual(getEnglishTtsProfile(), getEnglishTtsProfile(SHORT), "no sentence: the clip profile");
});

test("AUDIO_ENGLISH_STREAM_MIN_CHARS moves the threshold; a voice that cannot stream always makes clips", () => {
  useGoogle();
  process.env.AUDIO_ENGLISH_STREAM_MIN_CHARS = "10";
  assert.equal(englishSpeechMode(SHORT), "stream");
  process.env.AUDIO_ENGLISH_STREAM_MIN_CHARS = "zero";
  assert.equal(englishSpeechMode(SHORT), "clip", "an invalid value keeps the default");
  process.env.GOOGLE_TTS_VOICE = "Neural2-F";
  assert.equal(englishSpeechMode(LONG), "clip");
});

test("fallback profiles list what a refused sentence may have been spoken and cached as", () => {
  assert.deepEqual(englishSpeechFallbackProfiles(SHORT), [], "Cloudflare: no fallback");
  useGoogle();
  const cloudflare = { provider: "cloudflare", model: "@cf/deepgram/aura-1", voice: "luna", speed: 1, extension: "mp3" };
  assert.deepEqual(englishSpeechFallbackProfiles(LONG), [getEnglishTtsProfile(SHORT), cloudflare]);
  assert.deepEqual(englishSpeechFallbackProfiles(SHORT), [cloudflare]);
  delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  assert.deepEqual(englishSpeechFallbackProfiles(LONG), [getEnglishTtsProfile(SHORT)], "no Cloudflare config: no Cloudflare fallback");
});

test("Cloudflare provider: the request goes to aura-1 as before", async () => {
  const urls = fakeCloudflare();
  const speech = await requestEnglishSpeechAudio(SHORT);
  assert.equal(speech.profile.provider, "cloudflare");
  assert.match(urls[0], /@cf\/deepgram\/aura-1$/);
  assert.deepEqual([...new Uint8Array(await speech.response.arrayBuffer())], [7, 7, 7]);
});

test("Google clip: a short sentence is an en-US Neural2 MP3", async () => {
  useGoogle();
  const calls = fakeGoogle({ clip: async request => {
    assert.deepEqual(request.audioConfig, { audioEncoding: "MP3" });
    return new Uint8Array([1, 2, 3]);
  } });
  const speech = await requestEnglishSpeechAudio(SHORT);
  assert.deepEqual(calls.clip, ["en-US-Neural2-F"]);
  assert.equal(speech.response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(speech.profile, getEnglishTtsProfile(SHORT));
  assert.deepEqual([...new Uint8Array(await speech.response.arrayBuffer())], [1, 2, 3]);
});

test("Google stream: a long sentence is streamed Chirp 3 HD as WAV", async () => {
  useGoogle();
  const calls = fakeGoogle({ stream: duplex => {
    duplex.push({ audioContent: new Uint8Array([5, 6]) });
    duplex.push(null);
  } });
  const speech = await requestEnglishSpeechAudio(LONG);
  assert.equal(speech.response.headers.get("content-type"), "audio/wav");
  assert.deepEqual(speech.profile, getEnglishTtsProfile(LONG));
  const bytes = new Uint8Array(await speech.response.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
  assert.deepEqual([...bytes.subarray(44)], [5, 6]);
  assert.deepEqual((calls.stream[0][0] as { streamingConfig: { voice: unknown } }).streamingConfig.voice,
    { languageCode: "en-US", name: "en-US-Chirp3-HD-Aoede" });
});

test("a Chirp 3 HD stream that Google refuses (429) is spoken as a Neural2 clip instead", async () => {
  useGoogle();
  const calls = fakeGoogle({
    stream: duplex => { duplex.destroy(grpcError(8)); },
    clip: async () => new Uint8Array([9]),
  });
  const speech = await requestEnglishSpeechAudio(LONG);
  assert.equal(calls.stream.length, 1);
  assert.deepEqual(calls.clip, ["en-US-Neural2-F"]);
  assert.equal(speech.response.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(speech.profile, getEnglishTtsProfile(SHORT), "cached as the clip it is");
});

test("AUDIO_ENGLISH_CLOUDFLARE_FALLBACK=false: a failed Google clip is an error, never Cloudflare", async () => {
  useGoogle();
  process.env.AUDIO_ENGLISH_CLOUDFLARE_FALLBACK = "false";
  fakeGoogle({ clip: async () => { throw grpcError(8); } });
  const urls = fakeCloudflare();
  await assert.rejects(requestEnglishSpeechAudio(SHORT), (error: unknown) =>
    error instanceof AppError && error.code === "TTS_FAILED" && error.status === 429 && error.details?.provider === "google");
  assert.equal(urls.length, 0);
  assert.deepEqual(englishSpeechFallbackProfiles(LONG), [getEnglishTtsProfile(SHORT)], "nothing is ever cached as Cloudflare");
  assert.deepEqual(englishSpeechFallbackProfiles(SHORT), []);
});

test("when Google fails altogether the sentence falls back to Cloudflare aura-1", async () => {
  useGoogle();
  fakeGoogle({ clip: async () => { throw grpcError(8); } });
  const urls = fakeCloudflare();
  const speech = await requestEnglishSpeechAudio(SHORT);
  assert.equal(speech.profile.provider, "cloudflare");
  assert.equal(urls.length, 1);
  assert.deepEqual([...new Uint8Array(await speech.response.arrayBuffer())], [7, 7, 7]);
});
