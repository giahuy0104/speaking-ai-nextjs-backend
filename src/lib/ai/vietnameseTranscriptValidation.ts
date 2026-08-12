import { AppError } from "@/lib/appError";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import {
  getVietnameseTranscriptQualityIssue,
  type TranscriptQualityContext,
} from "./transcriptQuality";

export type VietnameseTranscriptRejection = {
  reason: "unexpected_script" | NonNullable<
    ReturnType<typeof getVietnameseTranscriptQualityIssue>
  >;
};

export type VietnameseTranscriptValidationOptions =
  TranscriptQualityContext & {
    onRejected?: (rejection: VietnameseTranscriptRejection) => void;
  };

export function assertVietnameseTranscriptIsUsable(
  text: string,
  segments: unknown[] = [],
  options: VietnameseTranscriptValidationOptions = {},
) {
  const unexpectedScript = containsUnexpectedEastAsianScript(text);
  const qualityIssue = getVietnameseTranscriptQualityIssue(text, segments, {
    utteranceDurationMs: options.utteranceDurationMs,
  });
  const reason = unexpectedScript ? "unexpected_script" : qualityIssue;
  if (!reason) return;

  options.onRejected?.({ reason });
  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
    422,
  );
}
