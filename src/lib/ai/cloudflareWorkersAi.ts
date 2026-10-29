import { AppError } from "@/lib/appError";
import { translateVietnameseWithCloudflare, CloudflareTextProviderError } from "./cloudflareText";
import { isEnglishAudioTranslation, isSuspiciousAudioTranscript } from "./audioTranslationQuality";
import { assertVietnameseTranscriptIsUsable } from "./vietnameseTranscriptValidation";
import type { CloudflareExecutionContext } from "./cloudflare/types";
import { audioTranslationCache, audioTranslationInstructions, cacheEnabled, translationCacheKey } from "./audioTranslationCache";
import { trimPcmWav } from "../audio/trimPcmWav";
import { timeoutSignal } from "./cloudflare/abortDiagnostics";
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
  checkpoint?: AudioTranslationCheckpoint;
  onCheckpoint?: (checkpoint: AudioTranslationCheckpoint) => void | Promise<void>;
  beforeProviderCall?: (stage: "asr" | "text") => Promise<void>;
};

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
  const execution = options.execution;
  // Pooled requests resolve the same model without requiring legacy secrets.
  const legacyConfig = execution ? undefined : getCloudflareAudioTranslationConfig();
  const model = legacyConfig?.model || process.env.CLOUDFLARE_WORKERS_AI_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new AppError("ASR_FAILED", "Model Cloudflare Workers AI không hợp lệ.", 500);
  }
  // Batch translation must tolerate provider queueing under load. Keep the
  // interactive ASR budget independent, and stay below the route's 35s limit.
  const timeoutMs = Math.min(
    30_000,
    positiveInteger("CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS", 20_000),
  );
  const signal = execution?.signal ?? timeoutSignal(timeoutMs, "request_deadline");
  const startedAt = performance.now();
  const originalAudio = options.preparedAudio ?? await audio.arrayBuffer();
  const providerAudio = process.env.AUDIO_TRANSLATION_TRIM_WAV === "true" ? trimPcmWav(originalAudio).bytes : originalAudio;
  const body = buildCloudflareAudioTranslationBody(
    providerAudio,
    sourceLanguage,
  );

  let response: Response | undefined;
  let payload: CloudflareWorkersAiEnvelope | null;

  if (execution) {
    payload = await execution.dispatcher.execute(
      { context: execution, operation: "audio_translation_asr", model },
      async ({ account, signal }) => {
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

  if (!sourceText) {
    throw new AppError("ASR_LOW_CONFIDENCE", "Không nghe rõ lời nói trong audio. Vui lòng ghi âm lại.", 422,
      { provider: "cloudflare", reason: "empty_transcript" });
  }
  if (sourceLanguage === "vi") {
    assertVietnameseTranscriptIsUsable(sourceText, Array.isArray(result?.segments) ? result.segments : []);
  }
  if (isSuspiciousAudioTranscript(sourceText)) {
    throw new AppError("ASR_LOW_CONFIDENCE", "Không nghe rõ nội dung audio. Vui lòng ghi âm lại.", 422,
      { provider: "cloudflare", reason: "suspicious_transcript" });
  }
  const asrMs = Math.round(performance.now() - startedAt);
  const checkpoint: AudioTranslationCheckpoint = { sourceText, sourceLanguage, model, asrMs,
    policyKey: translationCacheKey("checkpoint", sourceLanguage, "text", ""), providerAttempts: execution?.attempts.used ?? 1 };
  await options.onCheckpoint?.(checkpoint);
  return translateAudioTranscript(checkpoint, options, signal);
}

async function translateAudioTranscript(checkpoint: AudioTranslationCheckpoint, options: AudioTranslationOptions, inheritedSignal?: AbortSignal): Promise<AudioTranslationResult> {
  const { sourceText, sourceLanguage, model, asrMs } = checkpoint;
  const execution = options.execution;
  const signal = execution?.signal ?? inheritedSignal ?? timeoutSignal(20_000, "request_deadline");
  const startedAt = performance.now();
  const textCacheKey = options.cacheScope && cacheEnabled()
    ? translationCacheKey(options.cacheScope, sourceLanguage, "text", sourceText) : undefined;
  const cachedText = textCacheKey && sourceLanguage !== "en" ? await audioTranslationCache.get(textCacheKey) : null;
  let englishText = cachedText?.englishText ?? sourceText;
  const translationStartedAt = performance.now();
  let textModel: string | undefined = cachedText?.textModel;
  if (sourceLanguage !== "en" && !cachedText) {
    try {
      const translated = await translateVietnameseWithCloudflare(
        sourceText,
        audioTranslationInstructions(sourceLanguage),
        256,
        { signal, execution, beforeProviderCall: options.beforeProviderCall ? () => options.beforeProviderCall!("text") : undefined },
      );
      englishText = translated.englishText.trim();
      textModel = translated.model;
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
  if (!isEnglishAudioTranslation(englishText)) {
    throw new AppError("LLM_FAILED", "Dịch vụ chưa trả về bản dịch tiếng Anh hợp lệ.", 502,
      { provider: "cloudflare", reason: "invalid_translation_language" });
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
  if (textCacheKey && !cachedText && sourceLanguage !== "en") await audioTranslationCache.set(textCacheKey, translated);
  return translated;
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

export async function transcribeAudioToEnglish(
  audio: File,
  options: { vadFilter?: boolean } = {},
): Promise<EnglishAudioTranscriptionResult> {
  const result = await transcribeAudio(audio, "en", options);
  const { text, ...metadata } = result;
  return { ...metadata, englishText: text };
}
