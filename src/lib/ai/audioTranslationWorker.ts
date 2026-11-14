import { Worker, UnrecoverableError, type Job } from "bullmq";
import { AppError } from "../appError";
import { audioTranslationCache, cacheEnabled } from "./audioTranslationCache";
import { loadJobAudio, removeJobAudio, cleanExpiredLocalJobAudio } from "./audioTranslationJobStorage";
import { createJobRedisConnection, JOB_QUEUE_NAME, jobQueue, releaseJobCapacity, type TranslationJobData } from "./audioTranslationJobs";
import { translateAudioToEnglish, type AudioTranslationResult } from "./cloudflareWorkersAi";
import { createPoolRuntime } from "./cloudflare/runtime";
import { isPoolFailure, publicPoolError } from "./cloudflare/providerError";
import { randomUUID } from "node:crypto";
import { createDeadline } from "./cloudflare/deadline";
import { parsePoolConfig } from "./cloudflare/accountConfig";
import { resolveWorkerAccountAlias, shouldRequeuePinnedJob } from "./audioTranslationWorkerAccount";

export async function startAudioTranslationWorker() {
  if (process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED !== "true") throw new Error("job_worker_requires_shared_pool");
  const poolConfig = parsePoolConfig();
  const accountAlias = resolveWorkerAccountAlias(process.env, poolConfig.accounts);
  if (accountAlias) console.info(JSON.stringify({ event: "audio_translation_worker_pinned", accountAlias }));
  const producer = await jobQueue();
  const heartbeatKey = `${process.env.AUDIO_TRANSLATION_JOB_NAMESPACE || "speaking-ai-audio-jobs"}:worker:${randomUUID()}`;
  await producer.raw.set(heartbeatKey, "ready", { PX: 15_000 });
  const runtime = createPoolRuntime({ telemetry: (event, fields) => console.info(JSON.stringify({ event, ...fields })) });
  const { raw, connection } = createJobRedisConnection(true);
  const worker = new Worker<TranslationJobData, AudioTranslationResult, "translate">(JOB_QUEUE_NAME,
    async (job: Job<TranslationJobData, AudioTranslationResult, "translate">) => {
      let terminal = false;
      let providerAttempts: { used: number; max: number } | undefined;
      try {
        if (job.data.result) { terminal = true; return job.data.result; }
        if (Date.now() > job.data.expiresAt) throw new UnrecoverableError("job_expired");
        // A process died after starting inference. Its outcome is uncertain:
        // never repeat that provider call automatically after a stalled recovery.
        if (job.data.phase === "asr_inflight" || job.data.phase === "text_inflight") throw new UnrecoverableError("provider_outcome_uncertain");
        const cached = cacheEnabled() ? await audioTranslationCache.get(job.data.fingerprint) : null;
        if (cached) { await job.updateData({ ...job.data, result: cached }); terminal = true; return cached; }
        const audio = await loadJobAudio(job.data.audio);
        const timeoutMs = Math.min(30_000, Number(process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS) || 20_000, job.data.expiresAt - Date.now());
        const session = await runtime.acquireAudioTranslationExecution({ requestId: `job-${job.id!.slice(0, 40)}`, timing: createDeadline(timeoutMs),
          ...(accountAlias ? { accountAlias } : {}) });
        if (!session) throw new UnrecoverableError("job_pool_disabled");
        session.execution.attempts.used = job.data.providerAttempts;
        providerAttempts = session.execution.attempts;
        try {
          const result = await translateAudioToEnglish(audio, job.data.sourceLanguage, {
            execution: session.execution, cacheScope: job.data.owner, checkpoint: job.data.checkpoint,
            async beforeProviderCall(stage) {
              await job.updateData({ ...job.data, providerAttempts: session.execution.attempts.used,
                phase: stage === "asr" ? "asr_inflight" : "text_inflight" });
            },
            async onCheckpoint(checkpoint) {
              await job.updateData({ ...job.data, checkpoint, phase: "ready_text", providerAttempts: session.execution.attempts.used });
              await job.updateProgress({ stage: "text_translation" });
            },
          });
          await job.updateData({ ...job.data, result });
          if (cacheEnabled()) await audioTranslationCache.set(job.data.fingerprint, result);
          terminal = true;
          return result;
        } finally { session.release(); }
      } catch (error) {
        // A worker pinned to one account cannot use the dispatcher's retry on another
        // account. A rejected (429) or transiently failed call goes back to the queue
        // instead, so any worker - normally another account - continues the job. The
        // request's provider attempt budget still caps the total number of calls.
        if (providerAttempts && job.attemptsMade + 1 < 3 && Date.now() < job.data.expiresAt && shouldRequeuePinnedJob({
          accountAlias, error, retryTransientFaults: poolConfig.retryTransientFaults === true,
          providerAttemptsUsed: providerAttempts.used, providerAttemptsMax: providerAttempts.max })) {
          // That call is over: clear the in-flight marker, or the retry is refused as a crashed inference.
          await job.updateData({ ...job.data, providerAttempts: providerAttempts.used, phase: job.data.checkpoint ? "ready_text" : undefined });
          console.info(JSON.stringify({ event: "audio_translation_job_requeued", jobId: job.id, accountAlias }));
          throw new Error("account_fault_requeued");
        }
        const safe = isPoolFailure(error) ? publicPoolError(error) : error;
        // Only retry the job on a confirmed admission rejection. Inside one job,
        // the dispatcher may already have retried a transient provider fault once
        // on another account (CLOUDFLARE_POOL_RETRY_TRANSIENT); the job itself never
        // repeats inference that may still be running or billed upstream.
        const reason = safe instanceof AppError ? safe.details?.reason : undefined;
        const retryable = ["capacity", "queue_full", "queue_timeout"].includes(String(reason)) &&
          job.attemptsMade + 1 < 3 && Date.now() < job.data.expiresAt;
        if (retryable) throw new Error("admission_busy");
        terminal = true;
        throw new UnrecoverableError(safe instanceof AppError ? safe.code : "job_failed");
      } finally {
        if (terminal) {
          await releaseJobCapacity(job.data.owner, job.id!).catch(() => {});
          await removeJobAudio(job.data.audio).catch(() => {});
        }
      }
    }, {
      connection, prefix: process.env.AUDIO_TRANSLATION_JOB_NAMESPACE || "speaking-ai-audio-jobs",
      concurrency: Math.max(1, Math.min(20, Number(process.env.AUDIO_TRANSLATION_JOB_WORKER_CONCURRENCY) || 4)),
      maxStalledCount: 1, maxStartedAttempts: 4, lockDuration: 60_000, stalledInterval: 30_000,
    });
  worker.on("error", () => console.info(JSON.stringify({ event: "audio_translation_worker_error", reason: "queue_unavailable" })));
  worker.on("completed", job => console.info(JSON.stringify({ event: "audio_translation_job_completed", jobId: job.id })));
  worker.on("failed", job => console.info(JSON.stringify({ event: "audio_translation_job_attempt_failed", jobId: job?.id, attempt: job?.attemptsMade })));
  const cleanup = setInterval(() => {
    void cleanExpiredLocalJobAudio().catch(() => {});
    void producer.queue.clean(86_400_000, 100, "completed").catch(() => {});
    void producer.queue.clean(86_400_000, 100, "failed").catch(() => {});
  }, 60_000);
  cleanup.unref();
  const heartbeat = setInterval(() => { void jobQueue().then(current => current.raw.set(heartbeatKey, "ready", { PX: 15_000 })).catch(() => {}); }, 5000);
  heartbeat.unref();
  return { worker, async close() { clearInterval(cleanup); clearInterval(heartbeat); await worker.close(); await runtime.close();
    await producer.raw.del(heartbeatKey).catch(() => {}); if (raw.isOpen) raw.destroy(); } };
}
