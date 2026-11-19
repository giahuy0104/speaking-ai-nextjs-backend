import { AppError } from "@/lib/appError";
import { translateVietnameseWithCloudflare, CloudflareTextProviderError } from "./cloudflareText";
import { isEnglishAudioTranslation, isSuspiciousAudioTranscript } from "./audioTranslationQuality";
import { assertVietnameseTranscriptIsUsable } from "./vietnameseTranscriptValidation";
import type { CloudflareExecutionContext } from "./cloudflare/types";
import {
  AUDIO_TRANSLATION_MAX_TOKENS, audioTranslationCache, audioTranslationInstructions, cacheEnabled, sharedTextCacheEnabled,
  sharedTextCacheKey, sharedTextCacheTtlSeconds, translationCacheKey,
} from "./audioTranslationCache";
import { trimPcmWav } from "../audio/trimPcmWav";
import { combineAbortSignals, timeoutSignal } from "./cloudflare/abortDiagnostics";
import { fetchLegacyCloudflare } from "./cloudflare/legacyAdmission";
import {
  attachFailureDiagnostics,
  getFailureDiagnostics,
  isPoolFailure,
  networkFault,
  providerFaultFromResponse,
  publicPoolError,
} from "./cloudflare/providerError";
import {
  buildCloudflareAudioTranslationBody,
  buildCloudflareAudioTranscriptionBody,
  classifyCloudflareTranscriptionResponse,
  type CloudflareWorkersAiEnvelope,
} from "./cloudflareWorkersAiRequest";
import {
  resolveAudioProviders, toDeepInfraAppError, transcribeWithDeepInfra, translateWithDeepInfra, type AudioProvider,
} from "./deepInfra";

const DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_TIMEOUT_MS = 6_000;

export type AudioTranslationResult = {
  englishText: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
  sourceText?: string;
  textModel?: string;
  timings?: { asrMs: number; translationMs: number };
};

export type AudioTranslationCheckpoint = {
  sourceText: string; sourceLanguage: string; model: string; asrMs: number; policyKey: string; providerAttempts?: number;
};
export type AudioTranslationOptions = {
  execution?: CloudflareExecutionContext;
  preparedAudio?: ArrayBuffer;
  cacheScope?: string;
  /** Sentence-level translation cache; defaults to the Redis-backed one. */
  textCache?: Pick<typeof audioTranslationCache, "get" | "set">;
  checkpoint?: AudioTranslationCheckpoint;
  onCheckpoint?: (checkpoint: AudioTranslationCheckpoint) => void | Promise<void>;
  beforeProviderCall?: (stage: "asr" | "text") => Promise<void>;
  /** Called when a stage starts its next provider, after an error or a slow answer (for logging only). */
  onProviderFallback?: (event: ProviderFallbackEvent) => void;
};

export type ProviderFallbackEvent = Readonly<{
  stage: "asr" | "text";
  from: AudioProvider;
  to: AudioProvider;
  /** "error": the previous provider failed. "slow": it had not answered within the hedge delay. */
  trigger: "error" | "slow";
  status?: number;
  reason?: unknown;
  upstreamStatus?: unknown;
}>;

export type AudioTranscriptionResult = {
  vietnameseText: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
};

export type EnglishAudioTranscriptionResult = {
  englishText: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
};

type RawAudioTranscriptionResult = {
  text: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
};

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getCloudflareAudioTranslationConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();
  const model =
    process.env.CLOUDFLARE_WORKERS_AI_MODEL?.trim() || DEFAULT_MODEL;

  if (!accountId || !apiToken) {
    throw new AppError(
      "ASR_FAILED",
      "Máy chủ chưa được cấu hình Cloudflare Workers AI.",
      503,
    );
  }

  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new AppError(
      "ASR_FAILED",
      "Model Cloudflare Workers AI không hợp lệ.",
      500,
    );
  }

  return {
    accountId,
    apiToken,
    model,
    timeoutMs: positiveInteger(
      "CLOUDFLARE_WORKERS_AI_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

export function getCloudflareAudioMaxBytes() {
  return positiveInteger("CLOUDFLARE_AUDIO_MAX_BYTES", 10 * 1024 * 1024);
}

export async function translateAudioToEnglish(
  audio: File,
  sourceLanguage: string,
  options: AudioTranslationOptions = {},
): Promise<AudioTranslationResult> {
  if (options.checkpoint) {
    if (options.checkpoint.sourceLanguage !== sourceLanguage ||
        options.checkpoint.policyKey !== translationCacheKey("checkpoint", sourceLanguage, "text", "")) {
      throw new AppError("BAD_REQUEST", "Cấu hình dịch đã thay đổi; vui lòng gửi lại audio.", 409);
    }
    return translateAudioTranscript(options.checkpoint, options);
  }
  // This route translates into English, so AUDIO_ASR_PROVIDER_EN applies when set.
  const asrProviders = resolveAudioProviders("asr", "en");
  // Batch translation must tolerate provider queueing under load. Keep the
  // interactive ASR budget independent, and stay below the route's 35s limit.
  const timeoutMs = Math.min(30_000, positiveInteger("CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS", 20_000));
  const signal = options.execution?.signal ?? timeoutSignal(timeoutMs, "request_deadline");
  const startedAt = performance.now();
  const originalAudio = options.preparedAudio ?? await audio.arrayBuffer();
  const providerAudio = process.env.AUDIO_TRANSLATION_TRIM_WAV === "true" ? trimPcmWav(originalAudio).bytes : originalAudio;
  const run: AsrRun = { audio, providerAudio, sourceLanguage, signal, startedAt, timeoutMs, options };
  // Only the ASR call falls back or is hedged; transcript checks below run once on the winner.
  const transcription = await runProviders("asr", asrProviders, signal, options, (provider, cancel) => {
    const call = { ...run, signal: combineAbortSignals([signal, cancel]) };
    return provider === "deepinfra" ? transcribeAudioWithDeepInfra(call) : transcribeAudioWithCloudflare(call);
  });
  return completeAudioTranscription({ ...transcription, sourceLanguage, startedAt, signal, options });
}

type AsrRun = {
  audio: File;
  providerAudio: ArrayBuffer;
  sourceLanguage: string;
  signal: AbortSignal;
  startedAt: number;
  timeoutMs: number;
  options: AudioTranslationOptions;
};

type ProviderTranscription = { provider: AudioProvider; sourceText: string; segments: unknown[]; model: string };

async function transcribeAudioWithCloudflare(run: AsrRun): Promise<ProviderTranscription> {
  const { providerAudio, sourceLanguage, signal, startedAt, timeoutMs, options } = run;
  const execution = options.execution;
  // Pooled requests resolve the same model without requiring legacy secrets.
  const legacyConfig = execution ? undefined : getCloudflareAudioTranslationConfig();
  const model = legacyConfig?.model || process.env.CLOUDFLARE_WORKERS_AI_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new AppError("ASR_FAILED", "Model Cloudflare Workers AI không hợp lệ.", 500);
  }
  const body = buildCloudflareAudioTranslationBody(
    providerAudio,
    sourceLanguage,
  );

  let response: Response | undefined;
  let payload: CloudflareWorkersAiEnvelope | null;

  if (execution) {
    payload = await execution.dispatcher.execute(
      {
        context: execution,
        operation: "audio_translation_asr",
        model,
        // Without a per-attempt cap one hung ASR call consumes the whole request
        // deadline. ~2x the loaded p95 (~4s) leaves time to retry another account.
        timeoutMs: positiveInteger("CLOUDFLARE_ASR_ATTEMPT_TIMEOUT_MS", 8_000),
      },
      async ({ account, signal: attemptSignal }) => {
        // run.signal also carries a hedge cancellation; the pool reports that as "cancelled".
        const signal = combineAbortSignals([attemptSignal, run.signal]);
        // A hedge admitted after the other provider already answered must not mark the job in-flight again.
        if (signal.aborted) throw networkFault(signal.reason, signal);
        await options.beforeProviderCall?.("asr");
        let response: Response | undefined;
        let payload: CloudflareWorkersAiEnvelope | null;
        try {
          response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/run/${model}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${account.apiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
              signal,
              cache: "no-store",
            },
          );
          const raw = await response.text();
          try { payload = JSON.parse(raw) as CloudflareWorkersAiEnvelope | null; }
          catch { payload = null; }
        } catch (error) {
          throw networkFault(error, signal, response?.status);
        }
        if (!response.ok || payload?.success === false || payload === null) {
          throw providerFaultFromResponse(response, payload);
        }
        return payload;
      },
    );
  } else {
    await options.beforeProviderCall?.("asr");
    try {
      response = await fetchLegacyCloudflare(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(legacyConfig!.accountId)}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${legacyConfig!.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
          cache: "no-store",
        },
        { task: "asr", model, timeoutMs },
      );
      // Reading the response body is covered by the same deadline as fetch.
      const raw = await response.text();
      try {
        payload = JSON.parse(raw) as CloudflareWorkersAiEnvelope | null;
      } catch {
        payload = null;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const timedOut = signal.aborted;
      throw attachFailureDiagnostics(new AppError(
        "ASR_FAILED",
        timedOut
          ? "Cloudflare Workers AI phản hồi quá thời gian chờ. Vui lòng thử lại."
          : "Không kết nối được Cloudflare Workers AI. Vui lòng thử lại.",
        timedOut ? 504 : 502,
        {
          provider: "cloudflare",
          reason: timedOut ? "timeout" : "network_error",
          timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          errorName: error instanceof Error ? error.name : "unknown",
        },
      ), getFailureDiagnostics(networkFault(error, signal, response?.status)));
    }
  }

  const result = payload?.result;
  const sourceText =
    typeof result?.text === "string" ? result.text.trim() : "";

  if (response && (!response.ok || payload?.success === false || payload === null)) {
    throw new AppError(
      "ASR_FAILED",
      response.status === 429
        ? "Cloudflare Workers AI đang quá tải. Vui lòng thử lại sau."
        : "Cloudflare Workers AI không dịch được đoạn ghi âm này.",
      response.status === 429 ? 429 : 502,
      {
        provider: "cloudflare",
        reason: !response.ok || payload?.success === false
          ? "provider_error"
          : payload === null ? "invalid_response" : "empty_translation",
        upstreamStatus: response.status,
        upstreamCodes: Array.isArray(payload?.errors)
          ? payload.errors.map((entry) => entry.code).filter((code) => typeof code === "number")
          : [],
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    );
  }

  return { provider: "cloudflare", sourceText, segments: Array.isArray(result?.segments) ? result.segments : [], model };
}

type CompletedTranscription = ProviderTranscription & {
  sourceLanguage: string;
  startedAt: number;
  signal: AbortSignal;
  options: AudioTranslationOptions;
};

/** Provider-independent transcript checks, checkpoint and hand-off to translation. */
async function completeAudioTranscription(input: CompletedTranscription): Promise<AudioTranslationResult> {
  const { provider, sourceText, segments, sourceLanguage, model, startedAt, signal, options } = input;
  if (!sourceText) {
    throw new AppError("ASR_LOW_CONFIDENCE", "Không nghe rõ lời nói trong audio. Vui lòng ghi âm lại.", 422,
      { provider, reason: "empty_transcript" });
  }
  if (sourceLanguage === "vi") {
    assertVietnameseTranscriptIsUsable(sourceText, segments);
  }
  if (isSuspiciousAudioTranscript(sourceText)) {
    throw new AppError("ASR_LOW_CONFIDENCE", "Không nghe rõ nội dung audio. Vui lòng ghi âm lại.", 422,
      { provider, reason: "suspicious_transcript" });
  }
  const asrMs = Math.round(performance.now() - startedAt);
  const checkpoint: AudioTranslationCheckpoint = { sourceText, sourceLanguage, model, asrMs,
    policyKey: translationCacheKey("checkpoint", sourceLanguage, "text", ""),
    providerAttempts: options.execution?.attempts.used ?? 1 };
  await options.onCheckpoint?.(checkpoint);
  return translateAudioTranscript(checkpoint, options, signal);
}

/**
 * DeepInfra Whisper call. The caller's admission session (if any) is still acquired
 * and bounds concurrency - the job worker still requires the Cloudflare pool - but
 * this call never takes a Cloudflare account permit.
 */
async function transcribeAudioWithDeepInfra(run: AsrRun): Promise<ProviderTranscription> {
  const { audio, providerAudio, sourceLanguage, signal, startedAt, options } = run;
  await options.beforeProviderCall?.("asr");
  try {
    const transcription = await transcribeWithDeepInfra(new Blob([providerAudio], { type: audio.type }), audio.name,
      sourceLanguage, { signal });
    return { provider: "deepinfra", sourceText: transcription.text, segments: transcription.segments, model: transcription.model };
  } catch (error) {
    throw toDeepInfraAppError(error, "asr", performance.now() - startedAt);
  }
}

/**
 * A provider outage, overload, timeout or misconfiguration moves on to the next
 * provider. Unclear speech (4xx) and an expired request never do: another
 * provider would only add cost or outlive the caller's deadline.
 */
function shouldFallBack(error: unknown) {
  if (isPoolFailure(error)) return true;
  return error instanceof AppError && (error.code === "ASR_FAILED" || error.code === "LLM_FAILED") &&
    (error.status === 429 || error.status >= 500);
}

/** AUDIO_ASR_HEDGE_MS / AUDIO_TEXT_HEDGE_MS; 0 (default) disables hedging for that stage. */
function hedgeDelayMs(stage: "asr" | "text") {
  return positiveInteger(stage === "asr" ? "AUDIO_ASR_HEDGE_MS" : "AUDIO_TEXT_HEDGE_MS", 0);
}

function reportProviderSwitch(options: AudioTranslationOptions, event: ProviderFallbackEvent) {
  // Telemetry must never turn a working fallback into a failure.
  try { options.onProviderFallback?.(event); } catch { /* best-effort */ }
}

function failureFields(error: unknown) {
  return error instanceof AppError
    ? { status: error.status, reason: error.details?.reason, upstreamStatus: error.details?.upstreamStatus }
    : { reason: getFailureDiagnostics(error).failureSource };
}

/**
 * Runs a stage on its providers in priority order. The next provider starts when
 * the current one fails with a provider fault (fallback) or, when a hedge delay is
 * set, when it has not answered in time (hedge). The first success wins and every
 * other call still running is cancelled. If all fail, a non-fallback error (such as
 * a 4xx) is reported first, otherwise the error of the last provider.
 */
export function runProviders<T>(
  stage: "asr" | "text",
  providers: readonly AudioProvider[],
  signal: AbortSignal,
  options: AudioTranslationOptions,
  call: (provider: AudioProvider, cancel: AbortSignal) => Promise<T>,
): Promise<T> {
  const hedgeMs = hedgeDelayMs(stage);
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    const errors: unknown[] = [];
    let started = 0;
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(new DOMException("Another provider answered first.", "AbortError"));
      }
      complete();
    };
    const fail = () => {
      const hardError = errors.find(error => error !== undefined && !shouldFallBack(error));
      const lastError = [...errors].reverse().find(error => error !== undefined);
      reject(hardError ?? lastError ?? new AppError(stage === "asr" ? "ASR_FAILED" : "LLM_FAILED", "Chưa cấu hình nhà cung cấp AI.", 500));
    };
    const scheduleHedge = () => {
      clearTimeout(hedgeTimer);
      if (hedgeMs <= 0 || started >= providers.length) return;
      hedgeTimer = setTimeout(() => {
        if (settled || started >= providers.length || signal.aborted) return;
        reportProviderSwitch(options, { stage, from: providers[started - 1], to: providers[started], trigger: "slow" });
        start();
      }, hedgeMs);
    };
    const start = () => {
      const index = started++;
      const controller = new AbortController();
      controllers.push(controller);
      running++;
      scheduleHedge();
      call(providers[index], controller.signal).then(
        value => finish(() => resolve(value)),
        (error: unknown) => {
          running--;
          if (settled) return;
          errors[index] = error;
          const canFallBack = !signal.aborted && shouldFallBack(error);
          if (canFallBack && started < providers.length) {
            reportProviderSwitch(options, { stage, from: providers[index], to: providers[started], trigger: "error", ...failureFields(error) });
            start();
            return;
          }
          // Another provider is still working on this request: let it answer.
          if (running > 0 && !signal.aborted) return;
          finish(fail);
        },
      );
    };

    if (!providers.length) {
      fail();
      return;
    }
    start();
  });
}

async function translateAudioTranscript(checkpoint: AudioTranslationCheckpoint, options: AudioTranslationOptions, inheritedSignal?: AbortSignal): Promise<AudioTranslationResult> {
  const { sourceText, sourceLanguage, model, asrMs } = checkpoint;
  const execution = options.execution;
  const signal = execution?.signal ?? inheritedSignal ?? timeoutSignal(20_000, "request_deadline");
  const startedAt = performance.now();
  const textCache = options.textCache ?? audioTranslationCache;
  // Shared: one entry per sentence for every client, so no client scope is needed.
  const sharedText = sharedTextCacheEnabled();
  const textCacheKey = sharedText ? sharedTextCacheKey(sourceLanguage, sourceText)
    : options.cacheScope && cacheEnabled() ? translationCacheKey(options.cacheScope, sourceLanguage, "text", sourceText) : undefined;
  const cachedText = textCacheKey && sourceLanguage !== "en" ? await textCache.get(textCacheKey) : null;
  let englishText = cachedText?.englishText ?? sourceText;
  const translationStartedAt = performance.now();
  let textModel: string | undefined = cachedText?.textModel;
  const textProviders = resolveAudioProviders("text", "en");
  if (sourceLanguage !== "en" && !cachedText) {
    const text: TextRun = { sourceText, instructions: audioTranslationInstructions(sourceLanguage), signal, startedAt, options };
    const translated = await runProviders("text", textProviders, signal, options, (provider, cancel) => {
      const call = { ...text, signal: combineAbortSignals([signal, cancel]) };
      return provider === "deepinfra" ? translateTextWithDeepInfra(call) : translateTextWithCloudflare(call);
    });
    englishText = translated.englishText;
    textModel = translated.model;
  }
  if (!isEnglishAudioTranslation(englishText)) {
    throw new AppError("LLM_FAILED", "Dịch vụ chưa trả về bản dịch tiếng Anh hợp lệ.", 502,
      { provider: textProviders[0], reason: "invalid_translation_language" });
  }
  const translated: AudioTranslationResult = {
    englishText,
    sourceText,
    textModel,
    timings: { asrMs, translationMs: Math.round(performance.now() - translationStartedAt) },
    // Source-language timestamps/subtitles are not English subtitles.
    wordCount: englishText.split(/\s+/).length,
    model,
  };
  if (textCacheKey && !cachedText && sourceLanguage !== "en") {
    // The shared write runs for all traffic: never let a slow cache delay the response.
    // set() swallows its own failures.
    if (sharedText) void textCache.set(textCacheKey, translated, sharedTextCacheTtlSeconds());
    else await textCache.set(textCacheKey, translated);
  }
  return translated;
}

type TextRun = {
  sourceText: string;
  instructions: string;
  signal: AbortSignal;
  startedAt: number;
  options: AudioTranslationOptions;
};

/** Validated inside each provider so a non-English answer can fall back to the next one. */
function requireEnglishTranslation(text: string, provider: AudioProvider) {
  const englishText = text.trim();
  if (!isEnglishAudioTranslation(englishText)) {
    throw new AppError("LLM_FAILED", "Dịch vụ chưa trả về bản dịch tiếng Anh hợp lệ.", 502,
      { provider, reason: "invalid_translation_language" });
  }
  return englishText;
}

async function translateTextWithDeepInfra(run: TextRun): Promise<{ englishText: string; model: string }> {
  const { sourceText, instructions, signal, startedAt, options } = run;
  await options.beforeProviderCall?.("text");
  try {
    const translated = await translateWithDeepInfra(sourceText, instructions, AUDIO_TRANSLATION_MAX_TOKENS, { signal });
    return { englishText: requireEnglishTranslation(translated.englishText, "deepinfra"), model: translated.model };
  } catch (error) {
    throw toDeepInfraAppError(error, "text", performance.now() - startedAt);
  }
}

async function translateTextWithCloudflare(run: TextRun): Promise<{ englishText: string; model: string }> {
  const { sourceText, instructions, signal, startedAt, options } = run;
  const execution = options.execution;
  try {
    const translated = await translateVietnameseWithCloudflare(sourceText, instructions, AUDIO_TRANSLATION_MAX_TOKENS,
      { signal, execution, beforeProviderCall: options.beforeProviderCall ? () => options.beforeProviderCall!("text") : undefined });
    return { englishText: requireEnglishTranslation(translated.englishText, "cloudflare"), model: translated.model };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (execution && isPoolFailure(error)) {
      throw publicPoolError(error, "text_translation");
    }
    const reason = error instanceof CloudflareTextProviderError ? error.reason : "unknown_error";
    throw attachFailureDiagnostics(new AppError("LLM_FAILED", "Dịch vụ dịch văn bản tạm thời gặp lỗi. Vui lòng thử lại.",
      reason === "timeout" || signal.aborted ? 504 : error instanceof CloudflareTextProviderError && error.status === 429 ? 429 : 502,
      { provider: "cloudflare", stage: "text_translation", reason, elapsedMs: Math.round(performance.now() - startedAt) }),
    getFailureDiagnostics(error));
  }
}

async function transcribeAudio(
  audio: File,
  language: "en" | "vi",
  options: { vadFilter?: boolean } = {},
): Promise<RawAudioTranscriptionResult> {
  const config = getCloudflareAudioTranslationConfig();
  const timeoutMs = positiveInteger(
    "CLOUDFLARE_ASR_TIMEOUT_MS",
    Math.min(config.timeoutMs, 4_000),
  );
  const body = buildCloudflareAudioTranscriptionBody(
    await audio.arrayBuffer(),
    language,
    {
      ...options,
      beamSize: Math.min(
        5,
        positiveInteger("CLOUDFLARE_ASR_BEAM_SIZE", 2),
      ),
    },
  );

  let response: Response;

  try {
    response = await fetchLegacyCloudflare(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/run/${config.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs, "request_deadline"),
        cache: "no-store",
      },
      { task: "asr", model: config.model, timeoutMs },
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "ASR_FAILED",
      "Không kết nối được Cloudflare Workers AI. Vui lòng thử lại.",
      502,
    );
  }

  const payload = (await response
    .json()
    .catch(() => null)) as CloudflareWorkersAiEnvelope | null;
  const result = payload?.result;
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  const transcriptionFailure = classifyCloudflareTranscriptionResponse({
    responseOk: response.ok,
    success: payload?.success,
    transcript: text,
  });

  if (transcriptionFailure === "provider_error") {
    throw new AppError(
      "ASR_FAILED",
      response.status === 429
        ? "Cloudflare Workers AI đang quá tải. Vui lòng thử lại sau."
        : "Cloudflare Workers AI không nhận diện được đoạn ghi âm này.",
      response.status === 429 ? 429 : 502,
    );
  }

  // A successful provider response with no transcript normally means VAD/ASR
  // could not confirm speech. Treat it as unclear input so the fallback
  // provider does not make another guess from the same silent/noisy audio.
  if (transcriptionFailure === "unclear_speech") {
    throw new AppError(
      "ASR_LOW_CONFIDENCE",
      "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
      422,
    );
  }

  return {
    text,
    wordCount:
      typeof result?.word_count === "number" ? result.word_count : undefined,
    segments: Array.isArray(result?.segments) ? result.segments : undefined,
    vtt: typeof result?.vtt === "string" ? result.vtt : undefined,
    model: config.model,
  };
}

export async function transcribeAudioToVietnamese(
  audio: File,
  options: { vadFilter?: boolean } = {},
): Promise<AudioTranscriptionResult> {
  const result = await transcribeAudio(audio, "vi", options);
  const { text, ...metadata } = result;
  return { ...metadata, vietnameseText: text };
}

export type ProviderAudioTranscriptionResult = AudioTranscriptionResult & { provider: AudioProvider };

/**
 * Vietnamese ASR on the providers of AUDIO_ASR_PROVIDER (e.g. "deepinfra,cloudflare"),
 * with the same fallback rules as /api/audio/translate. Used by the conversation pipeline;
 * `targetLanguage` lets AUDIO_ASR_PROVIDER_<LANG> (e.g. _EN) override the shared list.
 */
export async function transcribeAudioToVietnameseWithProviders(
  audio: File,
  options: { vadFilter?: boolean; targetLanguage?: string } = {},
): Promise<ProviderAudioTranscriptionResult> {
  const providers = resolveAudioProviders("asr", options.targetLanguage);
  const neverAborts = new AbortController().signal;
  return runProviders("asr", providers, neverAborts, {}, async (provider, cancel) => {
    if (provider === "cloudflare") {
      return { ...(await transcribeAudioToVietnamese(audio, options)), provider };
    }
    const startedAt = performance.now();
    let transcription;
    try {
      transcription = await transcribeWithDeepInfra(audio, audio.name, "vi", { signal: cancel });
    } catch (error) {
      throw toDeepInfraAppError(error, "asr", performance.now() - startedAt);
    }
    if (!transcription.text) {
      throw new AppError("ASR_LOW_CONFIDENCE", "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.", 422,
        { provider: "deepinfra", reason: "empty_transcript" });
    }
    return { vietnameseText: transcription.text, segments: transcription.segments, model: transcription.model, provider };
  });
}

export async function transcribeAudioToEnglish(
  audio: File,
  options: { vadFilter?: boolean } = {},
): Promise<EnglishAudioTranscriptionResult> {
  const result = await transcribeAudio(audio, "en", options);
  const { text, ...metadata } = result;
  return { ...metadata, englishText: text };
}
