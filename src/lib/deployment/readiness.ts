import "server-only";
import { probeDatabase } from "@/lib/db";
import { createRedisClient } from "@/lib/ai/cloudflare/redisClient";
import { checkReadiness } from "./readinessCore";
import { getAudioSessionChunkStorageBackend, getAudioStorageBackend, getGeneratedAudioBlobToken, getR2StorageConfig, getR2CredentialsConfig } from "@/lib/storage/config";
import { getCloudinaryTtsConfig } from "@/lib/storage/cloudinaryTts";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { getR2Client } from "@/lib/storage/r2";

let pending: ReturnType<typeof checkReadiness> | undefined;
let cached: Awaited<ReturnType<typeof checkReadiness>> | undefined;
let expiresAt = 0;

export async function deploymentReadiness() {
  if (cached && Date.now() < expiresAt) return cached;
  // Coalesce public probes and cache briefly to bound connection churn.
  pending ??= checkReadiness(process.env, {
    database: probeDatabase,
    async redis(url) {
      const client = await createRedisClient(url, { connectTimeoutMs: 1000, commandTimeoutMs: 1000 });
      try { return await client.sendCommand(["PING"]) === "PONG"; }
      finally { await client.close(); }
    },
    async storage() {
      const audio = getAudioStorageBackend();
      const chunks = getAudioSessionChunkStorageBackend();
      if (audio === "local") return false;
      if (audio === "r2" && (chunks === "r2" || (process.env.AUDIO_TRANSLATION_JOBS_ENABLED === "true" && process.env.AUDIO_TRANSLATION_JOB_STORAGE === "r2"))) return false;
      if (audio === "r2") getR2StorageConfig();
      if (audio === "r2" || chunks === "r2" || (process.env.AUDIO_TRANSLATION_JOBS_ENABLED === "true" && process.env.AUDIO_TRANSLATION_JOB_STORAGE === "r2")) {
        const config = getR2CredentialsConfig();
        await getR2Client().send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: AbortSignal.timeout(2000) });
      }
      if (audio === "cloudinary") getCloudinaryTtsConfig();
      if (audio === "vercel-blob") getGeneratedAudioBlobToken();
      return true;
    },
  }).then(result => { cached = result; expiresAt = Date.now() + 2000; return result; })
    .finally(() => { pending = undefined; });
  return pending;
}
