import assert from "node:assert/strict";
import test from "node:test";
import { jobRedisUrl } from "./audioTranslationJobs";
import { redisEndpointIdentity } from "./cloudflare/redisClient";

test("Redis identity normalizes host/default port and ignores logical DB", () => {
  assert.equal(redisEndpointIdentity("redis://same/0"), redisEndpointIdentity("rediss://same:6379/1"));
});
test("disabled cache URL does not block jobs but enabled shared cache always does", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", AUDIO_TRANSLATION_CACHE_ENABLED: "false", CLOUDFLARE_POOL_REDIS_URL: "redis://quota", AUDIO_TRANSLATION_JOBS_REDIS_URL: "redis://jobs", AUDIO_TRANSLATION_CACHE_REDIS_URL: "redis://jobs:6379/1" });
    assert.equal(jobRedisUrl(), "redis://jobs");
    process.env.AUDIO_TRANSLATION_CACHE_ENABLED = "true";
    assert.throws(jobRedisUrl, /Hàng chờ/);
    process.env.AUDIO_TRANSLATION_CACHE_ENABLED = "false";
    process.env.CLOUDFLARE_POOL_REDIS_URL = "redis://jobs:6379/9";
    assert.throws(jobRedisUrl, /Hàng chờ/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
