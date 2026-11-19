import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGoogleQuota,
  createMemoryGoogleQuotaStore,
  createRedisGoogleQuotaStore,
  GoogleQuotaExceededError,
  googleQuotaRules,
} from "./googleTtsQuota";

test("each voice counts against its own quota and the shared all-voices quota", () => {
  const names = (voiceName: string, stream: boolean) => googleQuotaRules({ voiceName, stream }, {}).map(rule => `${rule.name}:${rule.limit}`);
  assert.deepEqual(names("cmn-CN-Chirp3-HD-Aoede", true), ["all_rpm:900", "chirp3_rpm:180", "chirp3_streams:90"]);
  assert.deepEqual(names("cmn-CN-Chirp3-HD-Aoede", false), ["all_rpm:900", "chirp3_rpm:180"]);
  assert.deepEqual(names("ja-JP-Neural2-B", false), ["all_rpm:900", "neural2_rpm:900"]);
  // WaveNet has no quota of its own, only the shared one.
  assert.deepEqual(names("cmn-CN-Wavenet-A", false), ["all_rpm:900"]);
  const custom = googleQuotaRules({ voiceName: "ko-KR-Chirp3-HD-Aoede", stream: true },
    { GOOGLE_TTS_QUOTA_CHIRP3_RPM: "20", GOOGLE_TTS_QUOTA_CHIRP3_STREAMS: "0", GOOGLE_TTS_QUOTA_ALL_RPM: "x" });
  assert.deepEqual(custom.map(rule => rule.limit), [900, 20, 90], "invalid values keep the default");
});

test("a full per-minute quota refuses at once and frees up as the minute slides", async () => {
  let now = 1_000_000;
  const quota = createGoogleQuota({ store: createMemoryGoogleQuotaStore(() => now), env: { GOOGLE_TTS_QUOTA_CHIRP3_RPM: "2" } });
  const chirp = { voiceName: "fr-FR-Chirp3-HD-Aoede", stream: false };
  await quota.acquire(chirp);
  now += 30_000;
  await quota.acquire(chirp);
  await assert.rejects(quota.acquire(chirp), (error: unknown) => error instanceof GoogleQuotaExceededError && error.rule === "chirp3_rpm");
  // A refused call is not counted, and other voices still have their quota.
  await quota.acquire({ voiceName: "fr-FR-Neural2-A", stream: false });
  now += 30_001;
  await quota.acquire(chirp);
});

test("concurrent streams hold a lease until released, and a lost lease expires", async () => {
  let now = 0;
  const quota = createGoogleQuota({
    store: createMemoryGoogleQuotaStore(() => now),
    leaseMs: 10_000,
    env: { GOOGLE_TTS_QUOTA_CHIRP3_STREAMS: "1" },
  });
  const stream = { voiceName: "ja-JP-Chirp3-HD-Aoede", stream: true };
  const first = await quota.acquire(stream);
  await assert.rejects(quota.acquire(stream), (error: unknown) => (error as GoogleQuotaExceededError).rule === "chirp3_streams");
  first.release();
  first.release();
  const second = await quota.acquire(stream);
  void second; // never released, as if its backend died
  now += 10_001;
  await quota.acquire(stream);
});

test("a call is admitted only when every quota has room, and nothing is counted otherwise", async () => {
  const quota = createGoogleQuota({
    store: createMemoryGoogleQuotaStore(() => 0),
    env: { GOOGLE_TTS_QUOTA_ALL_RPM: "1", GOOGLE_TTS_QUOTA_CHIRP3_RPM: "5" },
  });
  await quota.acquire({ voiceName: "cmn-CN-Wavenet-A", stream: false });
  await assert.rejects(quota.acquire({ voiceName: "cmn-CN-Chirp3-HD-Aoede", stream: false }),
    (error: unknown) => (error as GoogleQuotaExceededError).rule === "all_rpm");
});

test("an unreachable store lets the call through and reports it", async () => {
  const errors: unknown[] = [];
  const quota = createGoogleQuota({
    store: { acquire: async () => { throw new Error("redis down"); }, releaseLease: async () => undefined },
    onStoreError: error => errors.push(error),
  });
  const grant = await quota.acquire({ voiceName: "en-US-Chirp3-HD-Aoede", stream: true });
  grant.release();
  assert.equal(errors.length, 1);
});

// A real Redis, only when given (e.g. GOOGLE_TTS_QUOTA_TEST_REDIS_URL=redis://:pass@127.0.0.1:16379).
const testRedisUrl = process.env.GOOGLE_TTS_QUOTA_TEST_REDIS_URL?.trim();
test("the Redis script admits up to each limit, shares counts between stores and frees released leases", { skip: !testRedisUrl }, async () => {
  const { createRedisClient } = await import("./cloudflare/redisClient");
  const client = await createRedisClient(testRedisUrl!);
  const namespace = `homi:google-tts-test:${Date.now()}`;
  try {
    const env = { GOOGLE_TTS_QUOTA_CHIRP3_RPM: "2", GOOGLE_TTS_QUOTA_CHIRP3_STREAMS: "1" };
    // Two backends: two stores, one Redis.
    const [a, b] = [0, 1].map(() => createGoogleQuota({ store: createRedisGoogleQuotaStore(async () => client, namespace), env }));
    const stream = { voiceName: "cmn-CN-Chirp3-HD-Aoede", stream: true };
    const first = await a.acquire(stream);
    await assert.rejects(b.acquire(stream), (error: unknown) => (error as GoogleQuotaExceededError).rule === "chirp3_streams");
    first.release();
    await new Promise(resolve => setTimeout(resolve, 50));
    (await b.acquire(stream)).release();
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(a.acquire(stream), (error: unknown) => (error as GoogleQuotaExceededError).rule === "chirp3_rpm");
  } finally {
    for (const rule of ["all_rpm", "chirp3_rpm", "chirp3_streams"]) await client.sendCommand(["DEL", `{${namespace}}:${rule}`]);
    await client.close();
  }
});

test("the Redis store sends one atomic script with every rule's key and maps its answer", async () => {
  const commands: string[][] = [];
  const replies: unknown[] = ["", "chirp3_streams", 1];
  const store = createRedisGoogleQuotaStore(async () => ({
    sendCommand: async args => { commands.push([...args]); return replies.shift(); },
  }), "test-ns");
  const rules = googleQuotaRules({ voiceName: "ko-KR-Chirp3-HD-Aoede", stream: true }, {});
  assert.equal(await store.acquire(rules, "m1", 30_000), null);
  assert.equal(await store.acquire(rules, "m2", 30_000), "chirp3_streams");
  await store.releaseLease("chirp3_streams", "m1");
  const [eval1] = commands;
  assert.equal(eval1[0], "EVAL");
  assert.equal(eval1[2], "3");
  assert.deepEqual(eval1.slice(3, 6), ["{test-ns}:all_rpm", "{test-ns}:chirp3_rpm", "{test-ns}:chirp3_streams"]);
  assert.deepEqual(JSON.parse(eval1[6]).map((rule: { name: string }) => rule.name), ["all_rpm", "chirp3_rpm", "chirp3_streams"]);
  assert.deepEqual(eval1.slice(7), ["m1", "30000", "60000"]);
  assert.deepEqual(commands[2], ["ZREM", "{test-ns}:chirp3_streams", "m1"]);
});
