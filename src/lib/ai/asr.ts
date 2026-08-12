import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { transcribeAudioToVietnamese } from "./cloudflareWorkersAi";
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

async function transcribeAudio(input: ConversationRequest) {
  const audioFile = input.audioFile!;
  const startedAt = performance.now();
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
