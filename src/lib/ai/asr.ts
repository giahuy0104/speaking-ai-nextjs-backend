import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import {
  transcribeAudioInLanguage,
  transcribeAudioToVietnamese,
} from "./cloudflareWorkersAi";
import { resolveCloudflareAsrVadPolicy } from "./cloudflareWorkersAiRequest";
import { sampleVietnameseByContext } from "./prompts";
import { repairVietnameseChildSpeechLayers } from "./childSpeechTranscriptRepair";
import { assertVietnameseTranscriptIsUsable } from "./vietnameseTranscriptValidation";

function repairVietnameseTranscriptFromChildSpeech(
  text: string,
  input: ConversationRequest,
  provider: "cloudflare" | "device",
) {
  const repairStartedAt = performance.now();
  const repair = repairVietnameseChildSpeechLayers(text);

  if (repair.applied) {
    logEvent("info", "asr_transcript_repaired", {
      requestId: input.requestId,
      provider,
      subjectRepairApplied: repair.subjectRepairApplied,
      corpusRepairApplied: repair.corpusRepairApplied,
      corpusRuleId: repair.corpusRuleId,
      correctionId: repair.correctionId,
      strategy: repair.strategy,
      score: repair.score,
      margin: repair.margin,
      transcriptRepairMs: Number(
        (performance.now() - repairStartedAt).toFixed(3),
      ),
      regionalVocabularyApplied: repair.regionalVocabularyApplied,
      regionalVocabularyReplacementCount:
        repair.regionalVocabularyReplacementCount,
      regionalVocabularySourceRows: repair.regionalVocabularySourceRows,
      unresolvedRegionalVariantCount: repair.unresolvedRegionalVariantCount,
    });
  }

  return repair.text;
}

function assertVietnameseTranscript(
  text: string,
  segments: unknown[] = [],
  options: {
    requestId?: string;
    provider?: "cloudflare" | "device";
    utteranceDurationMs?: number;
  } = {},
) {
  assertVietnameseTranscriptIsUsable(text, segments, {
    utteranceDurationMs: options.utteranceDurationMs,
    onRejected: ({ reason }) => {
      logEvent("warn", "asr_transcript_rejected", {
        requestId: options.requestId,
        provider: options.provider,
        reason,
        utteranceDurationMs: options.utteranceDurationMs,
        transcriptLength: text.trim().length,
      });
    },
  });
}

function resolveAudioVadPolicy(input: ConversationRequest) {
  const vadPolicy = resolveCloudflareAsrVadPolicy({
    clientVadApplied: input.benchmark?.clientVadApplied,
    configuredMode: process.env.CLOUDFLARE_ASR_VAD_MODE,
  });
  input.benchmark = {
    ...input.benchmark,
    cloudflareVadFilter: vadPolicy.vadFilter,
    cloudflareVadMode: vadPolicy.mode,
    cloudflareVadReason: vadPolicy.reason,
  };
  logEvent("info", "cloudflare_asr_vad_policy", {
    requestId: input.requestId,
    clientVadApplied: input.benchmark.clientVadApplied === true,
    vadFilter: vadPolicy.vadFilter,
    mode: vadPolicy.mode,
    reason: vadPolicy.reason,
    audioInputLabel: input.benchmark.audioInputLabel,
    bluetoothAudioInput: input.benchmark.bluetoothAudioInput,
  });
  return vadPolicy;
}

async function transcribeAudio(input: ConversationRequest) {
  const audioFile = input.audioFile!;
  const startedAt = performance.now();
  const vadPolicy = resolveAudioVadPolicy(input);
  const result = await transcribeAudioToVietnamese(audioFile, {
    vadFilter: vadPolicy.vadFilter,
  });
  assertVietnameseTranscript(result.vietnameseText, result.segments, {
    requestId: input.requestId,
    provider: "cloudflare",
    utteranceDurationMs: input.benchmark?.utteranceDurationMs,
  });
  logEvent("info", "asr_provider_latency", {
    requestId: input.requestId,
    provider: "cloudflare",
    model: result.model,
    latencyMs: Math.round(performance.now() - startedAt),
    fallbackUsed: false,
  });
  return result.vietnameseText;
}

export async function transcribeVietnamese(input: ConversationRequest) {
  if (input.sourceText?.trim()) {
    const sourceText = input.sourceText.trim();
    const confidence = input.benchmark?.asrConfidence;
    if (
      input.asrMode === "android_streaming" &&
      typeof confidence === "number" &&
      confidence >= 0 &&
      confidence < 0.2
    ) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
        422,
      );
    }
    assertVietnameseTranscript(sourceText, [], {
      requestId: input.requestId,
      provider: "device",
      utteranceDurationMs: input.benchmark?.utteranceDurationMs,
    });
    return input.asrMode && input.asrMode !== "text"
      ? repairVietnameseTranscriptFromChildSpeech(sourceText, input, "device")
      : sourceText;
  }

  if (input.audioFile) {
    const vietnameseText = (await transcribeAudio(input)).trim();

    if (!vietnameseText) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Mình chưa nghe thấy giọng nói. Con đưa micro lại gần và nói rõ hơn nhé.",
        422,
      );
    }

    assertVietnameseTranscript(vietnameseText, [], {
      requestId: input.requestId,
      utteranceDurationMs: input.benchmark?.utteranceDurationMs,
    });

    return repairVietnameseTranscriptFromChildSpeech(
      vietnameseText,
      input,
      "cloudflare",
    );
  }

  await delay(320);

  return sampleVietnameseByContext[input.context][0];
}

/**
 * Captions Whisper is known to produce from silence or noise. The Vietnamese
 * path has its own validator; other sources only reject these exact phrases.
 */
const silenceHallucinations = new Set([
  "thank you for watching",
  "thanks for watching",
  "ご視聴ありがとうございました",
  "ご清聴ありがとうございました",
  "시청해주셔서 감사합니다",
  "구독과 좋아요 부탁드립니다",
  "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
  "字幕由amara.org社区提供",
  "sous-titres réalisés par la communauté d'amara.org",
  "merci d'avoir regardé",
]);

export function isKnownSilenceHallucination(text: string) {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s。．.!！?？,，、]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return silenceHallucinations.has(normalized);
}

/**
 * Transcript for a non-Vietnamese source. The Vietnamese child-speech
 * validation and repair layers only apply to Vietnamese, so they are skipped.
 */
async function transcribeOtherSourceLanguage(
  input: ConversationRequest,
  language: string,
) {
  if (input.sourceText?.trim()) {
    const confidence = input.benchmark?.asrConfidence;
    if (
      input.asrMode === "android_streaming" &&
      typeof confidence === "number" &&
      confidence >= 0 &&
      confidence < 0.2
    ) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
        422,
      );
    }
    return input.sourceText.trim();
  }

  if (!input.audioFile) {
    throw new AppError("BAD_REQUEST", "Thiếu câu nói hoặc đoạn ghi âm.", 400);
  }
  const startedAt = performance.now();
  const vadPolicy = resolveAudioVadPolicy(input);
  const result = await transcribeAudioInLanguage(input.audioFile, language, {
    vadFilter: vadPolicy.vadFilter,
  });
  const text = result.text.trim();
  logEvent("info", "asr_provider_latency", {
    requestId: input.requestId,
    provider: "cloudflare",
    model: result.model,
    sourceLanguage: language,
    latencyMs: Math.round(performance.now() - startedAt),
    fallbackUsed: false,
  });
  if (!text || isKnownSilenceHallucination(text)) {
    throw new AppError(
      "ASR_LOW_CONFIDENCE",
      "Mình chưa nghe thấy giọng nói. Con đưa micro lại gần và nói rõ hơn nhé.",
      422,
    );
  }
  return text;
}

/** Transcript in the request's source language (Vietnamese when missing). */
export async function transcribeSourceLanguage(input: ConversationRequest) {
  const language = input.sourceLanguage ?? "vi";
  return language === "vi"
    ? transcribeVietnamese(input)
    : transcribeOtherSourceLanguage(input, language);
}
