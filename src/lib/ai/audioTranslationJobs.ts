import { createHash, randomUUID } from "node:crypto";
import { Queue, createNodeRedisClient } from "bullmq";
import { createClient } from "redis";
import { AppError } from "../appError";
import { cacheEnabled, translationCacheKey } from "./audioTranslationCache";
import { redisEndpointIdentity } from "./cloudflare/redisClient";
import { storeJobAudio, type JobAudio } from "./audioTranslationJobStorage";
import type { AudioTranslationCheckpoint, AudioTranslationResult } from "./cloudflareWorkersAi";

export type TranslationJobData = {
  owner: string; fingerprint: string; audio: JobAudio; sourceLanguage: string; createdAt: number; expiresAt: number;
  checkpoint?: AudioTranslationCheckpoint; providerAttempts: number; phase?: "asr_inflight" | "text_inflight" | "ready_text";
  result?: AudioTranslationResult;
};
export const JOB_QUEUE_NAME = "audio-translation-v1";
const prefix = () => process.env.AUDIO_TRANSLATION_JOB_NAMESPACE || "speaking-ai-audio-jobs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const jobsEnabled = () => process.env.AUDIO_TRANSLATION_JOBS_ENABLED === "true";
const unavailable = () => new AppError("AUDIO_JOB_UNAVAILABLE", "Hàng chờ dịch audio tạm thời không khả dụng.", 503, { reason: "job_store_unavailable" });
let pending: ReturnType<typeof openQueue> | undefined;

export function jobRedisUrl() {
  const value = process.env.AUDIO_TRANSLATION_JOBS_REDIS_URL;
  if (!value || !/^[a-zA-Z0-9:_-]{1,100}$/.test(prefix())) throw unavailable();
  try {
    const endpoint = redisEndpointIdentity(value);
    for (const other of [process.env.CLOUDFLARE_POOL_REDIS_URL, cacheEnabled() ? process.env.AUDIO_TRANSLATION_CACHE_REDIS_URL : undefined]) {
      if (other && endpoint === redisEndpointIdentity(other)) throw unavailable();
    }
  } catch { throw unavailable(); }
  return value;
}
export function createJobRedisConnection(worker = false) {
  const raw = createClient({ url: jobRedisUrl(), socket: { connectTimeout: 1000, reconnectStrategy: worker ? retries => Math.min(2000, 100 * (retries + 1)) : false },
    disableOfflineQueue: !worker, commandsQueueMaxLength: 1000, commandOptions: worker ? undefined : { timeout: 2000 } });
  raw.on("error", () => {});
  return { raw, connection: createNodeRedisClient(raw) };
}
async function openQueue() {
  const { raw, connection } = createJobRedisConnection();
  const queue = new Queue<TranslationJobData, AudioTranslationResult, "translate">(JOB_QUEUE_NAME, {
    connection, prefix: prefix(), streams: { events: { maxLen: 1000 } },
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 2000, jitter: .5 },
      removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 86_400, count: 1000 }, keepLogs: 0, stackTraceLimit: 0, sizeLimit: 65_536 },
  });
  queue.on("error", () => {});
  try { await queue.waitUntilReady(); }
  catch { if (raw.isOpen) raw.destroy(); throw unavailable(); }
  return { queue, raw };
}
export async function jobQueue() {
  if (!jobsEnabled()) throw new AppError("AUDIO_JOB_NOT_FOUND", "Chức năng job audio chưa được bật.", 404);
  if (process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED !== "true") throw unavailable();
  try {
    const current = await (pending ??= openQueue());
    if (!current.raw.isReady) { pending = undefined; if (current.raw.isOpen) current.raw.destroy(); throw unavailable(); }
    return current;
  }
  catch { pending = undefined; throw unavailable(); }
}
export async function closeJobQueue() {
  const current = pending; pending = undefined;
  if (current) { const { queue, raw } = await current; await queue.close(); if (raw.isOpen) raw.destroy(); }
}
export const capacityKeys = (owner: string) => [`${prefix()}:{admission}:pending`, `${prefix()}:{admission}:bytes`, `${prefix()}:{admission}:owner:${hash(owner)}`, `${prefix()}:{admission}:fingerprints`];
const RESERVE = `
local time=redis.call('TIME'); local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local expired=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now)
for _,id in ipairs(expired) do
 local jobKey=ARGV[8]..id
 if redis.call('EXISTS',jobKey)==1 and redis.call('HEXISTS',jobKey,'finishedOn')==0 then
  redis.call('ZADD',KEYS[1],now+tonumber(ARGV[6]),id)
 else
  redis.call('HDEL',KEYS[2],id); redis.call('HDEL',KEYS[4],id); redis.call('ZREM',KEYS[1],id)
 end
end
for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[3],'-inf',now)) do
 local score=redis.call('ZSCORE',KEYS[1],id)
 if score then redis.call('ZADD',KEYS[3],score,id) else redis.call('ZREM',KEYS[3],id) end
end
if redis.call('ZSCORE',KEYS[1],ARGV[1]) then if redis.call('HGET',KEYS[4],ARGV[1])~=ARGV[7] then return -1 end; return 1 end
local bytes=0; for _,n in ipairs(redis.call('HVALS',KEYS[2])) do bytes=bytes+tonumber(n) end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) or redis.call('ZCARD',KEYS[3])>=tonumber(ARGV[4]) or bytes+tonumber(ARGV[2])>tonumber(ARGV[5]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[6]),ARGV[1]); redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[6]),ARGV[1])
redis.call('HSET',KEYS[4],ARGV[1],ARGV[7])
-- Accepted unfinished jobs keep capacity while workers are offline. Empty
-- hashes/zsets disappear on release; stale uncertain reservations reconcile above.
return 1`;
export async function releaseJobCapacity(owner: string, id: string) {
  const { raw } = await jobQueue();
  const keys = capacityKeys(owner);
  await raw.sendCommand(["EVAL", "redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('HDEL',KEYS[2],ARGV[1]); redis.call('ZREM',KEYS[3],ARGV[1]); redis.call('HDEL',KEYS[4],ARGV[1]); return 1", "4", ...keys, id]);
}
export function validateIdempotencyKey(value: string | null) {
  if (value !== null && !/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) throw new AppError("BAD_REQUEST", "Idempotency-Key phải có 8–128 ký tự hợp lệ.", 400);
  return value || randomUUID();
}
type EnqueueInput = { audio: File; sourceLanguage: string; owner: string; idempotencyKey: string; checkpoint?: AudioTranslationCheckpoint };
export async function enqueueTranslationJob(input: EnqueueInput) {
  try { return await enqueueJob(input); }
  catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}
async function enqueueJob(input: EnqueueInput) {
  const { queue, raw } = await jobQueue();
  const jobId = hash(JSON.stringify([input.owner, input.idempotencyKey]));
  const fingerprint = translationCacheKey(input.owner, input.sourceLanguage, "audio", await input.audio.arrayBuffer());
  const existing = await queue.getJob(jobId);
  if (existing) {
    if (existing.data.fingerprint !== fingerprint || existing.data.owner !== input.owner) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã được dùng cho audio khác.", 409);
    return { jobId, statusUrl: `/api/audio/jobs/${jobId}`, nextPollMs: 2000 };
  }
  const maxPending = Math.max(1, Math.min(1000, Number(process.env.AUDIO_TRANSLATION_JOB_MAX_PENDING) || 100));
  const maxPerOwner = Math.max(1, Math.min(maxPending, Number(process.env.AUDIO_TRANSLATION_JOB_MAX_PER_CLIENT) || 10));
  const ttlMs = 15 * 60_000;
  const granted = await raw.sendCommand(["EVAL", RESERVE, "4", ...capacityKeys(input.owner), jobId, String(input.audio.size),
    String(maxPending), String(maxPerOwner), String(128 * 1024 * 1024), String(ttlMs), fingerprint, `${prefix()}:${JOB_QUEUE_NAME}:`]);
  if (Number(granted) === -1) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã được dùng cho audio khác.", 409);
  if (Number(granted) !== 1) throw new AppError("RATE_LIMITED", "Hàng chờ dịch audio đã đầy. Vui lòng thử lại sau.", 429, { reason: "job_queue_full" });
  // No client 202 until both the audio/checkpoint and queue insertion are acknowledged.
  // An uncertain insertion is not retried or deleted here: the same key recovers it.
  try {
    const audio = await storeJobAudio(jobId, input.audio);
    await queue.add("translate", { owner: input.owner, fingerprint, audio, sourceLanguage: input.sourceLanguage,
      createdAt: Date.now(), expiresAt: Date.now() + ttlMs, checkpoint: input.checkpoint, providerAttempts: input.checkpoint?.providerAttempts ?? (input.checkpoint ? 1 : 0),
      ...(input.checkpoint ? { phase: "ready_text" as const } : {}) }, { jobId });
    const confirmed = await queue.getJob(jobId);
    if (!confirmed) throw unavailable();
    if (confirmed.data.fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã được dùng cho audio khác.", 409);
    return { jobId, statusUrl: `/api/audio/jobs/${jobId}`, nextPollMs: 2000 };
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}

export async function findExistingTranslationJob(input: EnqueueInput) {
  try {
    const { queue } = await jobQueue();
    const jobId = hash(JSON.stringify([input.owner, input.idempotencyKey]));
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const fingerprint = translationCacheKey(input.owner, input.sourceLanguage, "audio", await input.audio.arrayBuffer());
    if (job.data.fingerprint !== fingerprint || job.data.owner !== input.owner) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã được dùng cho audio khác.", 409);
    return { jobId, statusUrl: `/api/audio/jobs/${jobId}`, nextPollMs: 2000 };
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}

export async function readTranslationJob(jobId: string, owner: string) {
  try { return await readJob(jobId, owner); }
  catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
}
async function readJob(jobId: string, owner: string) {
  if (!/^[a-f0-9]{64}$/.test(jobId)) throw new AppError("AUDIO_JOB_NOT_FOUND", "Không tìm thấy job.", 404);
  const { queue } = await jobQueue();
  const job = await queue.getJob(jobId);
  if (!job || job.data.owner !== owner) throw new AppError("AUDIO_JOB_NOT_FOUND", "Không tìm thấy job.", 404);
  const state = await job.getState();
  const terminal = state === "completed" || state === "failed";
  if (terminal ? Date.now() > (job.finishedOn || job.data.expiresAt) + 3_600_000 : Date.now() > job.data.expiresAt) {
    throw new AppError("AUDIO_JOB_EXPIRED", "Job đã hết thời hạn lưu.", 410);
  }
  const status = state === "completed" ? "completed" : state === "failed" ? "failed" : state === "active" ? "running" : state === "delayed" ? "retrying" : "queued";
  return { jobId, status, nextPollMs: terminal ? undefined : 2000, createdAt: new Date(job.data.createdAt).toISOString(),
    startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
    completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    ...(status === "completed" ? { result: { sourceLanguage: job.data.sourceLanguage, targetLanguage: "en", ...job.returnvalue } } : {}),
    ...(status === "failed" ? { error: { code: "AUDIO_JOB_FAILED", message: "Không thể hoàn tất bản dịch. Vui lòng gửi lại audio nếu cần." } } : {}) };
}
