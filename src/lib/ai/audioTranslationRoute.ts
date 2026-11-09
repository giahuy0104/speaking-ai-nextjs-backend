import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getCloudflareAudioMaxBytes,
  translateAudioToEnglish,
  type AudioTranslationCheckpoint,
} from "@/lib/ai/cloudflareWorkersAi";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { readBoundedAudioFormData } from "@/lib/ai/cloudflare/upload";
import { audioTranslationService } from "@/lib/ai/audioTranslationService";
import { createDeadline } from "@/lib/ai/cloudflare/deadline";
import { clientAbortSignal } from "@/lib/ai/cloudflare/abortDiagnostics";
import { getFailureDiagnostics } from "@/lib/ai/cloudflare/providerError";
import { enqueueTranslationJob, findExistingTranslationJob, jobsEnabled, validateIdempotencyKey } from "@/lib/ai/audioTranslationJobs";
import {
  acquireAudioTranslationExecution,
  reserveAudioTranslationUpload,
  isPoolFailure,
  publicPoolError,
  getPoolRetryAfterMs,
} from "@/lib/ai/cloudflare/runtime";


const supportedExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
]);

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function validateAudio(audio: FormDataEntryValue | null) {
  if (!(audio instanceof File) || audio.size === 0) {
    throw new AppError("AUDIO_TOO_SHORT", "Vui lòng gửi tệp audio hợp lệ.");
  }

  if (audio.size > getCloudflareAudioMaxBytes()) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Tệp audio vượt quá dung lượng cho phép.",
      413,
    );
  }

  const isAudioMime = audio.type.toLowerCase().startsWith("audio/");
  const hasSupportedExtension = supportedExtensions.has(
    getExtension(audio.name),
  );

  if (!isAudioMime && !hasSupportedExtension) {
    throw new AppError(
      "BAD_REQUEST",
      "Định dạng audio không được hỗ trợ. Hãy dùng AAC, FLAC, M4A, MP3, MP4, OGG, WAV hoặc WebM.",
      415,
    );
  }

  return audio;
}

function validateSourceLanguage(value: string) {
  const language = value.toLowerCase() || "vi";

  if (!/^[a-z]{2,3}$/.test(language)) {
    throw new AppError(
      "BAD_REQUEST",
      "sourceLanguage phải là mã ngôn ngữ ISO, ví dụ vi hoặc zh.",
    );
  }

  return language;
}

export async function handleAudioTranslation(request: Request, options: { forceAsync?: boolean } = {}) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const clientSignal = clientAbortSignal(request.signal);
  let requestStage = "validation";
  let providerAttempts = 0;
  let sharedWorkRequestId: string | undefined;
  let upload: ReturnType<typeof reserveAudioTranslationUpload>;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      throw new AppError(
        "BAD_REQUEST",
        "Yêu cầu phải dùng multipart/form-data.",
        415,
      );
    }

    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes = getCloudflareAudioMaxBytes() + 256 * 1024;

    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        "Tệp audio vượt quá dung lượng cho phép.",
        413,
      );
    }

    requestStage = "upload";
    upload = reserveAudioTranslationUpload({
      requestId,
      signal: clientSignal,
      requestBytes: Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : maxRequestBytes,
      telemetry: (event, fields) => logEvent("info", event, fields),
    });
    const formData = upload
      ? await readBoundedAudioFormData(request,
        Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : maxRequestBytes, upload.timing.signal)
      : await request.formData();
    requestStage = "authentication";
    const access = await requireInstallationAccess(
      request,
      getFormString(formData, "clientId"),
    );
    requestStage = "validation";
    const audio = validateAudio(formData.get("audio"));
    const sourceLanguage = validateSourceLanguage(
      getFormString(formData, "sourceLanguage"),
    );
    const wantsJobs = jobsEnabled() && (options.forceAsync || /(?:^|,)\s*respond-async\s*(?:,|$)/i.test(request.headers.get("prefer") || ""));
    if (options.forceAsync && !jobsEnabled()) throw new AppError("AUDIO_JOB_NOT_FOUND", "Chức năng job audio chưa được bật.", 404);
    if (wantsJobs && access.legacy) throw new AppError("UNAUTHORIZED", "Job audio cần installation access token.", 401);
    const idempotencyKey = wantsJobs ? validateIdempotencyKey(request.headers.get("idempotency-key")) : undefined;
    const jobInput = { audio, sourceLanguage, owner: access.clientId, idempotencyKey: idempotencyKey || "" };
    const accepted = (job: { jobId: string; statusUrl: string; nextPollMs: number }) => withRequestId(Response.json(
      { requestId, ...job, status: "queued" }, { status: 202, headers: { Location: job.statusUrl, "Retry-After": "2", "Cache-Control": "private, no-store", "Preference-Applied": "respond-async" } }), requestId);
    if (wantsJobs) {
      requestStage = "job_lookup";
      const existing = await findExistingTranslationJob(jobInput);
      if (existing) return accepted(existing);
      if (options.forceAsync) { requestStage = "job_enqueue"; return accepted(await enqueueTranslationJob(jobInput)); }
    }
    const cacheScope = !access.legacy || process.env.NODE_ENV !== "production" ? access.clientId : undefined;
    const timeoutMs = Math.min(30_000, Math.max(1, Number(process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS) || 20_000));
    const { result, cacheStatus } = await audioTranslationService.run({
      audio, sourceLanguage, owner: access.clientId, cacheAllowed: !!cacheScope, flightScope: wantsJobs ? `jobs:${idempotencyKey}` : "sync",
      requestId,
      onState: state => { requestStage = state; },
      onSharedWork: leaderId => { sharedWorkRequestId = leaderId; },
      onWorkCancelled: () => logEvent("info", "audio_translation_work_cancelled", {
        requestId, requestStage, failureSource: "backend", abortCause: "no_subscribers",
        providerCallStarted: providerAttempts > 0,
        ...(sharedWorkRequestId ? { sharedWorkRequestId } : {}),
      }),
      timing: upload?.timing ?? createDeadline(timeoutMs, clientSignal),
      async operation(timing, bytes) {
        let checkpoint: AudioTranslationCheckpoint | undefined;
        let session: Awaited<ReturnType<typeof acquireAudioTranslationExecution>>;
        try {
          requestStage = "request_admission";
          session = await acquireAudioTranslationExecution({ requestId, timing, signal: timing.signal,
            telemetry: (event, fields) => logEvent("info", event, fields) });
          requestStage = "asr_admission";
          return await translateAudioToEnglish(audio, sourceLanguage, { execution: session?.execution, preparedAudio: bytes, cacheScope,
            beforeProviderCall: async stage => { requestStage = stage === "asr" ? "asr" : "text_translation"; providerAttempts++; },
            onCheckpoint: value => { checkpoint = value; requestStage = sourceLanguage === "en" ? "validation" : "text_admission"; } });
        } catch (error) {
          const safe = isPoolFailure(error) ? publicPoolError(error) : error;
          const reason = safe instanceof AppError ? safe.details?.reason : undefined;
          if (wantsJobs && ["capacity", "queue_full", "queue_timeout"].includes(String(reason)) && !timing.signal.aborted) {
            // Release the HTTP process slot before durable handoff. ASR is not repeated.
            session?.release(); session = undefined;
            requestStage = "job_enqueue";
            const job = await enqueueTranslationJob({ ...jobInput, checkpoint });
            throw new AudioTranslationAccepted(job);
          }
          throw error;
        } finally { session?.release(); }
      },
    });

    logEvent("info", "cloudflare_audio_translation_completed", {
      requestId,
      sourceLanguage,
      audioBytes: audio.size,
      model: result.model,
      textModel: result.textModel,
      timings: result.timings,
      cacheStatus,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return withRequestId(
      Response.json({
        requestId,
        sourceLanguage,
        targetLanguage: "en",
        ...result,
      }, { headers: { "X-Audio-Cache": cacheStatus, "Cache-Control": "private, no-store" } }),
      requestId,
    );
  } catch (error) {
    if (error instanceof AudioTranslationAccepted) return withRequestId(Response.json({ requestId, ...error.job, status: "queued" },
      { status: 202, headers: { Location: error.job.statusUrl, "Retry-After": "2", "Cache-Control": "private, no-store", "Preference-Applied": "respond-async" } }), requestId);
    const responseError = isPoolFailure(error) ? publicPoolError(error) : error;
    const response = toErrorResponse(responseError, requestId);
    logEvent("warn", "cloudflare_audio_translation_failed", {
      requestId,
      error: responseError,
      ...(responseError instanceof AppError ? { details: responseError.details } : {}),
      ...getFailureDiagnostics(responseError),
      requestStage,
      clientAborted: clientSignal.aborted,
      providerCallStarted: providerAttempts > 0,
      providerAttempts,
      elapsedMs: Math.round(performance.now() - startedAt),
      httpStatus: response.status,
      ...(sharedWorkRequestId ? { sharedWorkRequestId } : {}),
    });
    // Do not make clients guess when a bounded queue is full or expires.
    const retryAfterMs = getPoolRetryAfterMs(responseError);
    if (retryAfterMs !== undefined) {
      response.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
    }
    if (response.status === 429 && !response.headers.has("Retry-After")) response.headers.set("Retry-After", "2");
    return withRequestId(response, requestId);
  } finally {
    upload?.release();
  }
}

class AudioTranslationAccepted extends Error {
  constructor(readonly job: { jobId: string; statusUrl: string; nextPollMs: number }) { super("audio_translation_accepted"); }
}
