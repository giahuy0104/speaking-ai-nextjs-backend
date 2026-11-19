import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Each scenario runs in its own child: the speech modules read their settings once.
// Google is a fake gRPC client; only Next's server-only marker is adapted for Node.
const harness = String.raw`
const Module = require('node:module');
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'server-only') return {};
  return load.call(this, specifier, ...args);
};
const { Duplex } = require('node:stream');
const scenario = process.env.TARGET_ROUTE_TEST_SCENARIO;
process.env.PERSISTENCE_BACKEND = 'local';
process.env.AUDIO_STORAGE_BACKEND = 'local';
process.env.DATABASE_URL = '';
process.env.INSTALLATION_AUTH_SECRET = 'route-test-auth-secret-at-least-32-characters';
process.env.AUDIO_TARGET_TTS_PROVIDER = 'google';
process.env.AUDIO_TARGET_TTS_DEFERRED = 'true';
process.env.AUDIO_TARGET_TTS_STREAM = 'true';
process.env.AUDIO_STREAM_NODE = '';
if (scenario === 'fallback-voice' || scenario === 'uncached-fallback-voice') process.env.GOOGLE_TTS_FALLBACK_VOICE_ZH = 'Wavenet-A';
// Load-test turns: signed with a job id, never cached.
if (scenario === 'uncached-fallback-voice') process.env.LOAD_TEST_BYPASS_AUDIO_CACHE = 'true';
// Every short clip is routed to DeepInfra, which has no key here: Google speaks instead.
if (scenario === 'deepinfra-clip-fallback') {
  process.env.AUDIO_TARGET_CLIP_DEEPINFRA_SHARE = '1';
  delete process.env.DEEPINFRA_API_KEY;
}

(async () => {
  const { setGoogleTtsClientForTests } = require('./src/lib/ai/googleTts.ts');
  const { createTargetAudioUrl } = require('./src/lib/ai/targetAudioUrl.ts');
  const { GET } = require('./src/app/api/audio/target/route.ts');
  let streams = 0;
  const clipVoices = [];
  setGoogleTtsClientForTests({
    streamingSynthesize() {
      streams++;
      const duplex = new Duplex({
        objectMode: true,
        read() {},
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
          callback();
          // Before any audio: Google's quota refusal, or (network) the channel dropping.
          duplex.destroy(Object.assign(new Error('refused'), { code: scenario === 'network' ? 14 : 8 }));
        },
      });
      return duplex;
    },
    async synthesizeSpeech(request) {
      clipVoices.push(request.voice.name);
      if (scenario === 'network') throw Object.assign(new Error('unavailable'), { code: 14 });
      // A 44-byte WAV header plus two samples.
      const wav = new Uint8Array(48);
      wav.set([0x52, 0x49, 0x46, 0x46], 0);
      wav.set([0x57, 0x41, 0x56, 0x45], 8);
      return [{ audioContent: wav }];
    },
  });
  // Long enough (>= 20 characters) to stream; the clip scenario uses a short sentence.
  const text = scenario === 'deepinfra-clip-fallback'
    ? '我很开心。'
    : '今天我在学校和朋友们一起玩得非常开心，我们还一起唱歌。';
  const jobId = scenario === 'uncached-fallback-voice' ? 'load-test-turn-1' : undefined;
  const url = 'http://localhost' + createTargetAudioUrl('zh', text, { jobId });
  const responses = [];
  for (let i = 0; i < 2; i++) {
    const response = await GET(new Request(url));
    const body = new Uint8Array(await response.arrayBuffer());
    responses.push({ status: response.status, type: response.headers.get('content-type'), bytes: body.byteLength });
  }
  // Saving runs after the response; give it time, then look the sentence up.
  await new Promise(resolve => setTimeout(resolve, 100));
  const { getReusableAudioUrl } = require('./src/lib/storage/audio.ts');
  const { targetSpeechDescriptor, fallbackVoiceMarkCountForTests } = require('./src/lib/ai/targetSpeech.ts');
  const cached = await getReusableAudioUrl(targetSpeechDescriptor('zh', text));
  const fallbackMarks = fallbackVoiceMarkCountForTests();
  process.stdout.write(JSON.stringify({ responses, streams, clipVoices, cached, fallbackMarks }));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`;

function run(scenario: string) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", harness], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET_ROUTE_TEST_SCENARIO: scenario, LOG_LEVEL: "silent" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as {
    responses: Array<{ status: number; type: string | null; bytes: number }>;
    streams: number;
    clipVoices: string[];
    cached: string | null;
    fallbackMarks: number;
  };
}

test("a stream Google refuses before any audio is an HTTP 429, and the repeat download does not call Google again", () => {
  const result = run("quota");
  assert.deepEqual(result.responses.map(response => response.status), [429, 429]);
  assert.equal(result.streams, 1, "the second download joins the remembered failure");
  assert.deepEqual(result.clipVoices, [], "the same Chirp 3 HD quota would refuse the stand-in too");
});

test("with a fallback voice, a refused stream is spoken by that voice and served as WAV", () => {
  const result = run("fallback-voice");
  assert.equal(result.responses[0].status, 200);
  assert.equal(result.responses[0].type, "audio/wav");
  assert.equal(result.responses[0].bytes, 48);
  assert.deepEqual(result.clipVoices, ["cmn-CN-Wavenet-A"]);
  assert.equal(result.streams, 1);
  assert.equal(result.cached, null, "the Wavenet take is not cached under the Chirp 3 HD key");
  assert.equal(result.fallbackMarks, 0, "save() consumed the mark");
});

test("a load-test turn spoken by the fallback voice leaves no mark behind", () => {
  const result = run("uncached-fallback-voice");
  assert.equal(result.responses[0].status, 200);
  assert.deepEqual(result.clipVoices, ["cmn-CN-Wavenet-A"]);
  // Uncached turns are never saved, so nothing would ever clear a mark: one per turn leaked.
  assert.equal(result.fallbackMarks, 0);
});

test("a DeepInfra clip that Google spoke instead is served but not cached under DeepInfra's voice", () => {
  const result = run("deepinfra-clip-fallback");
  assert.deepEqual(result.responses.map(response => response.status), [200, 200]);
  assert.deepEqual(result.clipVoices, ["cmn-CN-Chirp3-HD-Aoede"], "spoken once; the second download joins it");
  assert.equal(result.cached, null);
});

test("a network failure is not remembered: the repeat download asks Google again", () => {
  const result = run("network");
  assert.deepEqual(result.responses.map(response => response.status), [502, 502]);
  assert.equal(result.streams, 2, "each download tries Google again");
  assert.equal(result.clipVoices.length, 2, "and its stand-in clip");
});
