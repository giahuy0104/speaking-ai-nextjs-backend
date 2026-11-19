import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Runs in its own child: the speech modules read their settings once.
// Google is a fake gRPC client; only Next's server-only marker is adapted for Node.
const harness = String.raw`
const Module = require('node:module');
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'server-only') return {};
  return load.call(this, specifier, ...args);
};
process.env.PERSISTENCE_BACKEND = 'local';
process.env.AUDIO_STORAGE_BACKEND = 'local';
process.env.DATABASE_URL = '';
process.env.INSTALLATION_AUTH_SECRET = 'route-test-auth-secret-at-least-32-characters';
process.env.AUDIO_ENGLISH_TTS_PROVIDER = 'google';
process.env.AUDIO_STREAM_NODE = '';
// The dev switch under test: no audio cache for anyone, not only load tests.
process.env.AUDIO_CACHE_DISABLED = 'true';

(async () => {
  const { setGoogleTtsClientForTests } = require('./src/lib/ai/googleTts.ts');
  const { getUncachedEnglishAudioStreamUrl } = require('./src/lib/ai/tts.ts');
  const { GET } = require('./src/app/api/audio/stream/route.ts');
  let clips = 0;
  setGoogleTtsClientForTests({
    streamingSynthesize() { throw new Error('a short sentence is a clip'); },
    async synthesizeSpeech() {
      clips++;
      await new Promise(resolve => setTimeout(resolve, 50));
      return [{ audioContent: new Uint8Array(48).fill(7) }];
    },
  });
  // Short (under 50 characters): one finished MP3 clip.
  const url = 'http://localhost' + getUncachedEnglishAudioStreamUrl('Today the weather is sunny.').audioUrl;
  const describe = async response => {
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      length: response.headers.get('content-length'),
      range: response.headers.get('content-range'),
      cache: response.headers.get('x-audio-cache'),
      type: response.headers.get('content-type'),
      bytes: body.byteLength,
    };
  };
  // Both at once, like AVPlayer: the range probe and the ?format=caf request.
  const ios = await Promise.all([
    GET(new Request(url, { headers: { Range: 'bytes=0-1' } })),
    GET(new Request(url + '&format=caf')),
  ].map(async pending => describe(await pending)));
  const iosClips = clips;
  const web = await describe(await GET(new Request(url)));
  // An unsigned URL (offline-intent manifest, old app builds) must not reach the cache either.
  const unsigned = await describe(await GET(new Request('http://localhost/api/audio/stream?text=Good%20morning.')));
  process.stdout.write(JSON.stringify({ ios, iosClips, web, unsigned, clips }));
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`;

type Described = {
  status: number; length: string | null; range: string | null; cache: string | null; type: string | null; bytes: number;
};

function run() {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--eval", harness], {
    cwd: process.cwd(),
    env: { ...process.env, LOG_LEVEL: "silent" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as {
    ios: Described[]; iosClips: number; web: Described; unsigned: Described; clips: number;
  };
}

// iOS (AVPlayer) cannot play a live stream of unknown length (-11850). With the
// audio cache disabled for everyone, real iPhones take the uncached English path,
// so it must give them the finished clip with Content-Length and byte ranges.
test("cache disabled: iOS gets the finished uncached English clip with byte ranges, from one synthesis", () => {
  const result = run();
  const [probe, caf] = result.ios;
  assert.equal(probe.status, 206);
  assert.equal(probe.range, "bytes 0-1/48");
  assert.equal(probe.length, "2");
  assert.equal(caf.status, 200);
  assert.equal(caf.length, "48");
  assert.equal(caf.bytes, 48);
  assert.equal(caf.type, "audio/mpeg");
  for (const response of result.ios) assert.equal(response.cache, "bypass");
  assert.equal(result.iosClips, 1, "the probe and the download share one synthesis");
});

test("cache disabled: other players still get the uncached English speech straight from the provider", () => {
  const { web } = run();
  assert.equal(web.status, 200);
  assert.equal(web.cache, "bypass");
  assert.equal(web.bytes, 48);
});

test("cache disabled: a URL without the no-cache signature is served uncached too", () => {
  const { unsigned } = run();
  assert.equal(unsigned.status, 200);
  assert.equal(unsigned.cache, "bypass");
});
