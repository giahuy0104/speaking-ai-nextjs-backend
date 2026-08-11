import { requireAdminAccess } from "@/lib/adminAuth";
import { diagnoseChildSpeechTranscript } from "@/lib/ai/childSpeechTranscriptDiagnostic";
import {
  getCloudflareAudioMaxBytes,
  transcribeAudioToVietnamese,
} from "@/lib/ai/cloudflareWorkersAi";
import { containsUnexpectedEastAsianScript } from "@/lib/ai/languageValidation";
import { getVietnameseTranscriptQualityIssue } from "@/lib/ai/transcriptQuality";
import {
  consumeChildSpeechTestRateLimit,
  hasValidChildSpeechTestToken,
} from "@/lib/childSpeechTestSecurity";
import { AppError, toErrorResponse } from "@/lib/errors";
import { normalizeVietnameseForExactMatch } from "@/lib/ai/exactRules";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import type { ChildSpeechTestResponse } from "@/types/childSpeechTest";
import type { PracticeContext } from "@/types/conversation";

export const runtime = "nodejs";

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);

type ParsedTestInput = {
  expectedText: string;
  rawAsr?: string;
  audio?: File;
  context: PracticeContext;
  childAge: number;
  lessonId?: string;
  inputLabel?: string;
  utteranceDurationMs?: number;
};

function optionalText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximumLength ? text : undefined;
}

function requiredText(value: unknown, field: string, maximumLength: number) {
  const text = optionalText(value, maximumLength);
  if (!text) {
    throw new AppError("BAD_REQUEST", `${field} không hợp lệ.`, 400);
  }
  return text;
}

function parseContext(value: unknown): PracticeContext {
  return typeof value === "string" && contexts.has(value as PracticeContext)
    ? (value as PracticeContext)
    : "home";
}

function parseChildAge(value: unknown) {
  const age = Number(value ?? 6);
  return Number.isFinite(age) && age >= 2 && age <= 18 ? Math.round(age) : 6;
}

function parseDuration(value: unknown) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0
    ? Math.min(Math.round(duration), 120_000)
    : undefined;
}

async function parseInput(request: Request): Promise<ParsedTestInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) {
      throw new AppError("BAD_REQUEST", "Dữ liệu audio không hợp lệ.", 400);
    }
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      throw new AppError("AUDIO_TOO_SHORT", "Chưa có dữ liệu ghi âm.", 400);
    }
    if (audio.size > getCloudflareAudioMaxBytes()) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        "Tệp audio vượt quá dung lượng cho phép.",
        413,
      );
    }
    return {
      expectedText: requiredText(
        form.get("expectedText"),
        "Câu dự kiến",
        300,
      ),
      audio,
      context: parseContext(form.get("context")),
      childAge: parseChildAge(form.get("childAge")),
      lessonId: optionalText(form.get("lessonId"), 100),
      inputLabel: optionalText(form.get("inputLabel"), 150),
      utteranceDurationMs: parseDuration(form.get("utteranceDurationMs")),
    };
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    throw new AppError("BAD_REQUEST", "Nội dung JSON không hợp lệ.", 400);
  }
  return {
    expectedText: requiredText(body.expectedText, "Câu dự kiến", 300),
    rawAsr: requiredText(body.rawAsr, "Raw ASR", 500),
    context: parseContext(body.context),
    childAge: parseChildAge(body.childAge),
    lessonId: optionalText(body.lessonId, 100),
    inputLabel: optionalText(body.inputLabel, 150),
    utteranceDurationMs: parseDuration(body.utteranceDurationMs),
  };
}

function authorize(request: Request) {
  if (hasValidChildSpeechTestToken(request)) return null;
  return requireAdminAccess(request);
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const denied = authorize(request);
  if (denied) return withRequestId(denied, requestId);

  const retryAfter = consumeChildSpeechTestRateLimit(request);
  if (retryAfter > 0) {
    const response = Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Đang test quá nhanh. Vui lòng thử lại sau.",
          requestId,
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(retryAfter));
    return withRequestId(response, requestId);
  }

  const startedAt = performance.now();
  try {
    const input = await parseInput(request);
    let rawAsr = input.rawAsr ?? "";
    let model: string | undefined;
    let wordCount: number | undefined;
    let segments: unknown[] = [];
    let asrLatencyMs = 0;

    if (input.audio) {
      const asrStartedAt = performance.now();
      const transcription = await transcribeAudioToVietnamese(input.audio, {
        vadFilter: true,
      });
      asrLatencyMs = Math.round(performance.now() - asrStartedAt);
      rawAsr = transcription.vietnameseText;
      model = transcription.model;
      wordCount = transcription.wordCount;
      segments = transcription.segments ?? [];
    }

    const diagnostic = diagnoseChildSpeechTranscript(rawAsr);
    const unexpectedScript = containsUnexpectedEastAsianScript(rawAsr);
    const qualityIssue = unexpectedScript
      ? "unexpected_script"
      : getVietnameseTranscriptQualityIssue(rawAsr, segments, {
          utteranceDurationMs: input.utteranceDurationMs,
        }) ?? undefined;
    const matchedExpected =
      normalizeVietnameseForExactMatch(diagnostic.text) ===
      normalizeVietnameseForExactMatch(input.expectedText);
    const response: ChildSpeechTestResponse = {
      requestId,
      mode: input.audio ? "cloudflare_audio" : "text_replay",
      expectedText: input.expectedText,
      rawAsr,
      correctedText: diagnostic.text,
      matchedExpected,
      qualityIssue,
      lessonId: input.lessonId,
      context: input.context,
      childAge: input.childAge,
      inputLabel: input.inputLabel,
      audioBytes: input.audio?.size,
      asr: { model, wordCount, latencyMs: asrLatencyMs },
      repair: {
        subjectRepairApplied: diagnostic.subjectRepairApplied,
        corpusRepairApplied: diagnostic.corpusRepairApplied,
        regionalVocabularyApplied: diagnostic.regionalVocabularyApplied,
        strategy: diagnostic.strategy,
        score: diagnostic.score,
        margin: diagnostic.margin,
        ruleId: diagnostic.corpusRuleId,
        correctionId: diagnostic.correctionId,
        latencyMs: diagnostic.repairMs,
      },
      totalMs: Math.round(performance.now() - startedAt),
      testedAt: new Date().toISOString(),
    };

    logEvent("info", "child_speech_test_completed", {
      requestId,
      mode: response.mode,
      matchedExpected,
      rawLength: rawAsr.length,
      correctedLength: diagnostic.text.length,
      strategy: diagnostic.strategy,
      qualityIssue,
      asrLatencyMs,
      repairLatencyMs: diagnostic.repairMs,
      totalMs: response.totalMs,
    });
    return withRequestId(Response.json(response), requestId);
  } catch (error) {
    logEvent("warn", "child_speech_test_failed", { requestId, error });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
