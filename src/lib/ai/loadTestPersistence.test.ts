import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  audioCacheDisabled,
  bypassesAudioCache,
  loadTestPersistencePrefix,
  skipsPostResponsePersistence,
} from "./loadTestPersistence";

const ENV = "LOAD_TEST_SKIP_PERSISTENCE_CLIENT_PREFIX";

afterEach(() => {
  delete process.env[ENV];
});

test("persists every installation when the prefix is unset", () => {
  assert.equal(loadTestPersistencePrefix(), undefined);
  assert.equal(skipsPostResponsePersistence("web_k6_abc123"), false);
});

test("skips only installations whose clientId starts with the prefix", () => {
  process.env[ENV] = " web_k6_ ";
  assert.equal(skipsPostResponsePersistence("web_k6_abc123"), true);
  assert.equal(skipsPostResponsePersistence("web_real-device"), false);
  assert.equal(skipsPostResponsePersistence("android_web_k6_abc"), false);
  assert.equal(skipsPostResponsePersistence(undefined), false);
});

test("ignores a prefix too short to single out test installations", () => {
  for (const value of ["", "   ", "web_", "web"]) {
    process.env[ENV] = value;
    assert.equal(loadTestPersistencePrefix(), undefined);
    assert.equal(skipsPostResponsePersistence("web_real-device"), false);
  }
});

test("the audio cache is bypassed only for load-test installations with the flag on", () => {
  process.env[ENV] = "web_k6_";
  for (const value of [undefined, "", "false", "1"]) {
    if (value === undefined) delete process.env.LOAD_TEST_BYPASS_AUDIO_CACHE;
    else process.env.LOAD_TEST_BYPASS_AUDIO_CACHE = value;
    assert.equal(bypassesAudioCache("web_k6_abc123"), false);
  }
  process.env.LOAD_TEST_BYPASS_AUDIO_CACHE = " TRUE ";
  assert.equal(bypassesAudioCache("web_k6_abc123"), true);
  assert.equal(bypassesAudioCache("web_real-device"), false);
  assert.equal(bypassesAudioCache(undefined), false);
  // Without a valid prefix nobody bypasses, even with the flag on.
  process.env[ENV] = "web_";
  assert.equal(bypassesAudioCache("web_k6_abc123"), false);
  delete process.env.LOAD_TEST_BYPASS_AUDIO_CACHE;
});

test("AUDIO_CACHE_DISABLED bypasses the audio cache for every installation, but keeps their history", () => {
  for (const value of [undefined, "", "false", "1"]) {
    if (value === undefined) delete process.env.AUDIO_CACHE_DISABLED;
    else process.env.AUDIO_CACHE_DISABLED = value;
    assert.equal(audioCacheDisabled(), false);
    assert.equal(bypassesAudioCache("ios_real-device-1"), false);
  }
  process.env.AUDIO_CACHE_DISABLED = " TRUE ";
  assert.equal(audioCacheDisabled(), true);
  assert.equal(bypassesAudioCache("ios_real-device-1"), true);
  assert.equal(bypassesAudioCache("android_real-device-1"), true);
  assert.equal(bypassesAudioCache(undefined), true);
  // Only the cache is skipped: real installations still save their history.
  process.env[ENV] = "web_k6_";
  assert.equal(skipsPostResponsePersistence("ios_real-device-1"), false);
  delete process.env.AUDIO_CACHE_DISABLED;
});
