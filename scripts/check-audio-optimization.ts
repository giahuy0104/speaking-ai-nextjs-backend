import { createRedisClient } from "../src/lib/ai/cloudflare/redisClient";
import { closeJobQueue, jobQueue, jobsEnabled } from "../src/lib/ai/audioTranslationJobs";
import { cacheEnabled } from "../src/lib/ai/audioTranslationCache";

async function main() {
  const report: Record<string, unknown> = { cacheEnabled: cacheEnabled(), jobsEnabled: jobsEnabled(), usesInference: false };
  if (cacheEnabled()) {
    const cacheUrl = process.env.AUDIO_TRANSLATION_CACHE_REDIS_URL;
    if (!cacheUrl) throw new Error("cache_not_configured");
    if (process.env.CLOUDFLARE_POOL_REDIS_URL && new URL(cacheUrl).host === new URL(process.env.CLOUDFLARE_POOL_REDIS_URL).host) throw new Error("cache_not_isolated");
    const client = await createRedisClient(cacheUrl);
    try { report.cachePing = await client.sendCommand(["PING"]) === "PONG"; }
    finally { await client.close(); }
  }
  if (jobsEnabled()) {
    const { raw } = await jobQueue();
    const prefix = process.env.AUDIO_TRANSLATION_JOB_NAMESPACE || "speaking-ai-audio-jobs";
    let cursor = "0"; let workers = 0;
    do { const page = await raw.scan(cursor, { MATCH: `${prefix}:worker:*`, COUNT: 100 }); cursor = page.cursor; workers += page.keys.length; } while (cursor !== "0");
    report.jobsPing = await raw.ping() === "PONG"; report.activeWorkerHeartbeats = workers;
    report.jobAudioStorage = process.env.AUDIO_TRANSLATION_JOB_STORAGE || "local";
    if (!workers) process.exitCode = 1;
    await closeJobQueue();
  }
  console.info(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error("Audio optimization check failed. Check isolated Redis URLs and storage configuration. No credentials printed."); process.exitCode = 1; });
