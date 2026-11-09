import assert from "node:assert/strict";
import test from "node:test";
import { checkReadiness } from "./readinessCore";

test("readiness requires both reachable database/schema and storage configuration", async () => {
  const probes = { database: async () => true, storage: async () => true, redis: async () => { throw Error("disabled Redis must not be contacted"); } };
  assert.equal((await checkReadiness({}, probes)).ready, true);
  assert.equal((await checkReadiness({}, { ...probes, database: async () => false })).ready, false);
  assert.equal((await checkReadiness({}, { ...probes, storage: async () => false })).ready, false);
});
test("enabled dependencies fail readiness and errors never escape as provider diagnostics", async () => {
  const calls: string[] = [];
  const result = await checkReadiness({ CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", AUDIO_TRANSLATION_CACHE_ENABLED: "true", AUDIO_TRANSLATION_JOBS_ENABLED: "true", CLOUDFLARE_POOL_REDIS_URL: "quota", AUDIO_TRANSLATION_CACHE_REDIS_URL: "cache", AUDIO_TRANSLATION_JOBS_REDIS_URL: "jobs" }, {
    database: async signal => { assert.equal(signal.aborted, false); return true; }, storage: async () => true,
    redis: async url => { calls.push(url); if (url === "jobs") throw Error("credential-bearing-secret"); return true; },
  });
  assert.deepEqual(calls.sort(), ["cache", "jobs", "quota"]); assert.equal(result.ready, false);
  assert.deepEqual(result.checks, { database: true, storage: true, quota: true, cache: true, jobs: false });
  assert.equal(JSON.stringify(result).includes("credential-bearing-secret"), false);
});
