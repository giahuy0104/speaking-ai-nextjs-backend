import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Each scenario runs in its own child: the speech modules read their settings once.
// Google is a fake gRPC client that streams a different sample value per segment.
const harness = String.raw`
const Module = require('node:module');
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'server-only') return {};
  return load.call(this, specifier, ...args);
};
const { Duplex } = require('node:stream');
const scenario = process.env.SEGMENTS_ROUTE_TEST_SCENARIO;
process.env.PERSISTENCE_BACKEND = 'local';
process.env.AUDIO_STORAGE_BACKEND = 'local';
process.env.DATABASE_URL = '';
process.env.INSTALLATION_AUTH_SECRET = 'route-test-auth-secret-at-least-32-characters';
process.env.AUDIO_TARGET_TTS_PROVIDER = 'google';
process.env.AUDIO_TARGET_TTS_DEFERRED = 'true';
process.env.AUDIO_TARGET_TTS_STREAM = 'true';
process.env.AUDIO_STREAM_NODE = '';
process.env.AUDIO_SEGMENTED_SPEECH_TEST = scenario === 'disabled' ? 'false' : 'true';

(async () => {
  const { setGoogleTtsClientForTests } = require('./src/lib/ai/googleTts.ts');
  const { startSegmentedSpeechUrl } = require('./src/lib/ai/segmentedSpeech.ts');
  const { GET } = require('./src/app/api/audio/segments/route.ts');
  const texts = [];
  setGoogleTtsClientForTests({
    streamingSynthesize() {
      let value = 0;
      const duplex = new Duplex({
        objectMode: true,
        read() {},
        write(chunk, _encoding, callback) {
          if (chunk.input) { texts.push(chunk.input.text); value = texts.length; }
          callback();
        },
        final(callback) {
          callback();
          // Segment n: 100 samples of value n (1-based), half now, half later (later for later segments).
          const half = new Uint8Array(100);
          for (let i = 0; i < 100; i += 2) half[i] = value;
          duplex.push({ audioContent: half });
          setTimeout(() => { duplex.push({ audioContent: half.slice() }); duplex.push(null); }, 30 * value);
        },
      });
      return duplex;
    },
    async synthesizeSpeech() { throw Object.assign(new Error('not used'), { code: 14 }); },
  });

  const audioUrl = startSegmentedSpeechUrl('zh', '我现在很累，我想去睡觉，明天再工作。', 'req-1');
  const single = startSegmentedSpeechUrl('zh', '我很开心。', 'req-2');
  if (scenario === 'disabled') {
    process.stdout.write(JSON.stringify({ audioUrl: audioUrl ?? null, texts }));
    process.exit(0);
  }
  const url = 'http://localhost' + audioUrl;
  const read = async (request) => {
    const response = await GET(request);
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      length: response.headers.get('content-length'),
      range: response.headers.get('content-range'),
      bytes: body.byteLength,
      body: Array.from(body),
    };
  };
  let result = {};
  if (scenario === 'android') {
    result = { stream: await read(new Request(url)) };
  } else if (scenario === 'ios') {
    result = { ios: await Promise.all([
      read(new Request(url, { headers: { Range: 'bytes=0-1' } })),
      read(new Request(url + '&format=caf')),
    ]) };
  } else if (scenario === 'forged') {
    result = { forged: await read(new Request(url.replace('sig=', 'sig=x'))) };
  }
  process.stdout.write(JSON.stringify({ ...result, texts, audioUrl, single: single ?? null }));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`;

type Served = { status: number; type: string | null; length: string | null; range: string | null; bytes: number; body: number[] };

function run(scenario: string) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", harness], {
    cwd: process.cwd(),
    env: { ...process.env, SEGMENTS_ROUTE_TEST_SCENARIO: scenario, LOG_LEVEL: "silent" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as {
    stream?: Served; ios?: Served[]; forged?: Served; texts: string[]; audioUrl: string | null; single: string | null;
  };
}

// Three segments of 200 bytes (100 samples) each, 80 ms gaps at 24 kHz (3840 bytes).
const SEGMENT_BYTES = 200;
const GAP_BYTES = 3_840;
const TOTAL_BYTES = 44 + 3 * SEGMENT_BYTES + 2 * GAP_BYTES;

test("a sentence with clauses is synthesized as one parallel segment per clause", () => {
  const result = run("android");
  assert.match(result.audioUrl ?? "", /^\/api\/audio\/segments\?/);
  assert.deepEqual(result.texts, ["我现在很累，", "我想去睡觉，", "明天再工作。"]);
  assert.equal(result.single, null, "one clause keeps the usual speech path");
});

test("a streaming player gets one WAV: segment 1, a gap, segment 2, a gap, segment 3", () => {
  const { stream } = run("android");
  assert.equal(stream?.status, 200);
  assert.equal(stream?.type, "audio/wav");
  assert.equal(stream?.bytes, TOTAL_BYTES);
  const body = stream!.body;
  assert.equal(String.fromCharCode(...body.slice(0, 4)), "RIFF");
  assert.deepEqual(
    [body[44], body[44 + SEGMENT_BYTES + GAP_BYTES], body[44 + 2 * (SEGMENT_BYTES + GAP_BYTES)]],
    [1, 2, 3],
    "segments in sentence order",
  );
  assert.equal(body[44 + SEGMENT_BYTES + 10], 0, "silence between segments");
});

test("iOS gets the finished joined file with Content-Length and byte ranges", () => {
  const { ios, texts } = run("ios");
  const [probe, caf] = ios!;
  assert.equal(probe.status, 206);
  assert.equal(probe.range, `bytes 0-1/${TOTAL_BYTES}`);
  assert.equal(caf.status, 200);
  assert.equal(caf.length, String(TOTAL_BYTES));
  assert.equal(texts.length, 3, "both requests share the job the pipeline started");
});

test("forged URLs and a disabled flag never synthesize", () => {
  assert.equal(run("forged").forged?.status, 403);
  const disabled = run("disabled");
  assert.equal(disabled.audioUrl, null);
  assert.deepEqual(disabled.texts, []);
});
