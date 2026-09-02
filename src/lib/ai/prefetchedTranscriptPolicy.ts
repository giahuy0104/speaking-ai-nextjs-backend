import { repairVietnameseChildSpeechLayers } from "./childSpeechTranscriptRepair";
import { assertVietnameseTranscriptIsUsable } from "./vietnameseTranscriptValidation";

export type PrefetchedTranscript = {
  sourceText: string;
  latencyMs: number;
};

export type ResolvedPrefetchedTranscript = PrefetchedTranscript & {
  changed: boolean;
  canReuseDownstreamPrefetch: boolean;
  repair: ReturnType<typeof repairVietnameseChildSpeechLayers>;
  transcriptRepairMs: number;
};

export type PrefetchedTranscriptValidationContext = {
  requestId?: string;
  provider?: "huamei" | "device";
  utteranceDurationMs?: number;
  onRejected?: (reason: string) => void;
};

/**
 * Every early ASR result must pass through the same child-speech repair used by
 * the authoritative ASR path. If the transcript changes, any translation or
 * audio created from the old text is stale and must not be reused.
 */
export function resolvePrefetchedTranscriptForPipeline(
  prefetchedTranscript: PrefetchedTranscript,
  validationContext: PrefetchedTranscriptValidationContext = {},
): ResolvedPrefetchedTranscript {
  const originalSourceText = prefetchedTranscript.sourceText.trim();
  assertVietnameseTranscriptIsUsable(originalSourceText, [], {
    utteranceDurationMs: validationContext.utteranceDurationMs,
    onRejected: ({ reason }) => validationContext.onRejected?.(reason),
  });
  const repairStartedAt = performance.now();
  const repair = repairVietnameseChildSpeechLayers(originalSourceText);
  const transcriptRepairMs = Number(
    (performance.now() - repairStartedAt).toFixed(3),
  );
  const sourceText = repair.text;
  const changed = sourceText !== originalSourceText;

  return {
    sourceText,
    latencyMs: prefetchedTranscript.latencyMs,
    changed,
    canReuseDownstreamPrefetch: !changed,
    repair,
    transcriptRepairMs,
  };
}
