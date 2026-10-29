import type {
  ConversationRequest,
  ConversationResponse,
} from "@/types/conversation";
import { measureStep, nowMs } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { getAudioStorageBackend } from "@/lib/storage/config";
import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import { AppError } from "@/lib/errors";
import { transcribeVietnamese } from "./asr";
import { resolvePrefetchedTranscriptForPipeline } from "./prefetchedTranscriptPolicy";
import {
  generateEnglishSentence,
  type EnglishGenerationResult,
} from "./llm";
import { PROMPT_VERSION } from "./prompts";
import { translateTargetLanguage } from "./targetTranslation";
import { getFailureDiagnostics } from "./cloudflare/providerError";
import { getTargetTtsProfile, requestTargetSpeech } from "./aiProvider";
import {
  prepareEnglishAudio,
  synthesizeEnglishAudio,
  type AudioSynthesisResult,
} from "./tts";

export type ConversationPipelineOptions = {
  deferTextCacheWrite?: boolean;
  prefetchedTranscript?: {
    sourceText: string;
    latencyMs: number;
  };
  prefetchedTranslation?: EnglishGenerationResult;
  prefetchedAudio?: AudioSynthesisResult;
  /**
   * Return a signed streaming URL on every cache miss. Terminal Web previews
   * use this so Safari can start the provider stream while finalize reuses the
   * exact prepared pipeline instead of waiting for durable cache storage.
   */
  streamAudioOnCacheMiss?: boolean;
  /** Web Worker prepare only: start provider TTS before Safari opens audioUrl. */
  eagerAudioOnCacheMiss?: boolean;
};

export type PreparedConversationPipeline = {
  asr: {
    value: string;
    latencyMs: number;
  };
  llm: {
    value: EnglishGenerationResult;
    latencyMs: number;
  };
  tts: {
    value: AudioSynthesisResult;
    latencyMs: number;
  };
  preparationMs: number;
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export async function runTargetLanguageConversationPipeline(
  input: ConversationRequest,
): Promise<ConversationResponse> {
  const language = input.targetLanguage;
  if (language === "en") {
    throw new AppError("BAD_REQUEST", "Ngôn ngữ dịch không hợp lệ.", 400);
  }
  const startedAt = nowMs();
  const asr = await measureStep(() => transcribeVietnamese(input));
  const translation = await measureStep(() => translateTargetLanguage({
    sourceText: asr.value, language, context: input.context,
    childAge: input.childAge, requestId: input.requestId,
  }));
  const translatedText = translation.value.translatedText;

  const profile = getTargetTtsProfile(language);
  const descriptor = {
    text: translatedText.normalize("NFKC").replace(/\s+/g, " ").trim(),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: profile.extension,
  };
  const tts = await measureStep(async () => {
    try {
      const cachedUrl = await getReusableAudioUrl(descriptor);
      if (cachedUrl) return { audioUrl: cachedUrl, source: "cache" as const };
      const audio = await requestTargetSpeech(translatedText, language, { parentRequestId: input.requestId });
      const audioUrl = await saveReusableAudio(descriptor, audio);
      return { audioUrl, source: "cloudflare_tts" as const };
    } catch (error) {
      logEvent("warn", "target_translation_audio_unavailable", {
        requestId: input.requestId,
        language,
        stage: "tts",
        model: profile.model,
        reason: error instanceof AppError ? error.details?.reason ?? "audio_unavailable" : "audio_unavailable",
        status: error instanceof AppError ? error.status : 500,
        ...getFailureDiagnostics(error),
        error,
      });
      return { audioUrl: null, source: "device_tts" as const };
    }
  });

  const result: ConversationResponse = {
    requestId: input.requestId,
    clientId: input.clientId,
    conversationId: createId("conv"),
    sessionId: input.sessionId ?? createId("sess"),
    context: input.context,
    vietnameseText: asr.value,
    englishText: "",
    targetLanguage: language,
    translatedText,
    audioUrl: tts.value.audioUrl,
    promptVersion: PROMPT_VERSION,
    processingMode: "ai",
    textSource: "cloudflare",
    textProvider: "cloudflare",
    textModel: translation.value.model,
    audioSource: tts.value.source,
    asrMode: input.asrMode ?? (input.audioFile ? "batch_chunks" : "text"),
    benchmark: input.benchmark,
    latency: {
      asrMs: asr.latencyMs,
      llmMs: translation.latencyMs,
      ttsMs: tts.latencyMs,
      timeToFirstAudioMs: Math.round(nowMs() - startedAt),
    },
  };
  logEvent("info", "target_translation_pipeline_completed", {
    requestId: input.requestId, language, model: result.textModel,
    audioSource: result.audioSource, audioReady: result.audioUrl !== null,
    latency: result.latency,
  });
  return result;
}

export async function prepareConversationPipeline(
  input: ConversationRequest,
  options: ConversationPipelineOptions = {},
): Promise<PreparedConversationPipeline> {
  const startedAt = nowMs();
  const resolvedPrefetchedTranscript = options.prefetchedTranscript
    ? resolvePrefetchedTranscriptForPipeline(options.prefetchedTranscript, {
        requestId: input.requestId,
        provider: input.asrMode === "batch_chunks" ? "cloudflare" : "device",
        utteranceDurationMs: input.benchmark?.utteranceDurationMs,
        onRejected: (reason) => {
          logEvent("warn", "asr_transcript_rejected", {
            requestId: input.requestId,
            provider:
              input.asrMode === "batch_chunks" ? "cloudflare" : "device",
            reason,
            utteranceDurationMs: input.benchmark?.utteranceDurationMs,
            transcriptLength:
              options.prefetchedTranscript?.sourceText.trim().length ?? 0,
            prefetchedTranscript: true,
          });
        },
      })
    : null;
  const canReuseDownstreamPrefetch =
    resolvedPrefetchedTranscript?.canReuseDownstreamPrefetch !== false;
  const prefetchedTranslation = canReuseDownstreamPrefetch
    ? options.prefetchedTranslation
    : undefined;
  const prefetchedAudio = canReuseDownstreamPrefetch
    ? options.prefetchedAudio
    : undefined;

  if (resolvedPrefetchedTranscript?.repair.applied) {
    const repair = resolvedPrefetchedTranscript.repair;
    logEvent("info", "asr_transcript_repaired", {
      requestId: input.requestId,
      provider: input.asrMode === "batch_chunks" ? "cloudflare" : "device",
      subjectRepairApplied: repair.subjectRepairApplied,
      corpusRepairApplied: repair.corpusRepairApplied,
      corpusRuleId: repair.corpusRuleId,
      correctionId: repair.correctionId,
      strategy: repair.strategy,
      score: repair.score,
      margin: repair.margin,
      transcriptRepairMs: resolvedPrefetchedTranscript.transcriptRepairMs,
      regionalVocabularyApplied: repair.regionalVocabularyApplied,
      regionalVocabularyReplacementCount:
        repair.regionalVocabularyReplacementCount,
      regionalVocabularySourceRows: repair.regionalVocabularySourceRows,
      unresolvedRegionalVariantCount: repair.unresolvedRegionalVariantCount,
      prefetchedTranscript: true,
    });
  }

  if (
    resolvedPrefetchedTranscript?.changed &&
    (options.prefetchedTranslation || options.prefetchedAudio)
  ) {
    logEvent("info", "conversation_prefetch_invalidated_after_transcript_repair", {
      requestId: input.requestId,
      asrMode: input.asrMode,
      translationInvalidated: Boolean(options.prefetchedTranslation),
      audioInvalidated: Boolean(options.prefetchedAudio),
    });
  }

  const asr = resolvedPrefetchedTranscript
    ? {
        value: resolvedPrefetchedTranscript.sourceText,
        latencyMs: resolvedPrefetchedTranscript.latencyMs,
      }
    : await measureStep(() => transcribeVietnamese(input));
  const llm = prefetchedTranslation
    ? { value: prefetchedTranslation, latencyMs: 0 }
    : await measureStep(() =>
        generateEnglishSentence(
          asr.value,
          input.context,
          input.childAge,
          input.clientId,
          input.requestId,
          options.deferTextCacheWrite,
        ),
      );
  // A brand-new AI sentence cannot be a cache hit. Return its streaming URL
  // immediately; /api/audio/stream clones the provider response and persists
  // it in `after()` independently from Safari playback. Reviewed rules and
  // known text-cache entries still resolve to durable audio before returning.
  const usesFastStreamingTts =
    !prefetchedAudio &&
    (options.streamAudioOnCacheMiss || llm.value.source === "cloudflare" ||
      getAudioStorageBackend() === "cloudinary");
  const tts = prefetchedAudio
    ? { value: prefetchedAudio, latencyMs: 0 }
    : await measureStep<AudioSynthesisResult>(() =>
        usesFastStreamingTts
          ? prepareEnglishAudio(llm.value.englishText, {
              eagerStream: options.eagerAudioOnCacheMiss === true,
              knownCacheMiss:
                options.eagerAudioOnCacheMiss === true &&
                llm.value.source === "cloudflare",
            })
          : synthesizeEnglishAudio(llm.value.englishText),
      );

  return {
    asr,
    llm,
    tts,
    preparationMs: Math.round(nowMs() - startedAt),
  };
}

export function completePreparedConversationPipeline(
  input: ConversationRequest,
  prepared: PreparedConversationPipeline,
): ConversationResponse {
  const conversationId = createId("conv");
  const { asr, llm, tts } = prepared;

  const result = {
    requestId: input.requestId,
    clientId: input.clientId,
    conversationId,
    sessionId: input.sessionId ?? createId("sess"),
    context: input.context,
    vietnameseText: asr.value,
    englishText: llm.value.englishText,
    audioUrl: tts.value.audioUrl,
    promptVersion: PROMPT_VERSION,
    processingMode: llm.value.mode,
    matchedRule: llm.value.matchedRule,
    textSource: llm.value.source,
    textProvider: llm.value.textProvider,
    textModel: llm.value.textModel,
    textFallbackUsed: llm.value.textFallbackUsed,
    textFallbackReason: llm.value.textFallbackReason,
    audioSource: tts.value.source,
    asrMode: input.asrMode ?? (input.audioFile ? "batch_chunks" : "text"),
    benchmark: tts.value.eagerStreamStarted
      ? {
          ...input.benchmark,
          workerEagerAudioStreamStarted: true,
          workerAudioCacheLookupSkipped:
            tts.value.cacheLookupSkipped === true,
        }
      : input.benchmark,
    latency: {
      asrMs: asr.latencyMs,
      llmMs: llm.latencyMs,
      ttsMs: tts.latencyMs,
      timeToFirstAudioMs: prepared.preparationMs,
    },
  } satisfies ConversationResponse;

  logEvent("info", "conversation_pipeline_completed", {
    requestId: input.requestId,
    conversationId,
    context: input.context,
    asrMode: result.asrMode,
    processingMode: result.processingMode,
    textSource: result.textSource,
    textProvider: result.textProvider,
    textModel: result.textModel,
    textFallbackUsed: result.textFallbackUsed,
    textFallbackReason: result.textFallbackReason,
    matchedRule: result.matchedRule,
    audioSource: result.audioSource,
    audioCacheHit: result.audioSource === "cache",
    audioCacheReady: tts.value.cacheReady,
    eagerAudioStreamStarted: tts.value.eagerStreamStarted === true,
    audioCacheLookupSkipped: tts.value.cacheLookupSkipped === true,
    audioDeliveryMode: tts.value.cacheReady ? "cache" : "stream_and_cache",
    audioCacheHitTarget: 0.85,
    latency: result.latency,
  });

  return result;
}

export async function runConversationPipeline(
  input: ConversationRequest,
  options: ConversationPipelineOptions = {},
): Promise<ConversationResponse> {
  const prepared = await prepareConversationPipeline(input, options);
  return completePreparedConversationPipeline(input, prepared);
}
