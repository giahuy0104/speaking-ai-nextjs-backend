import { repairVietnameseChildSpeechLayers } from "./childSpeechTranscriptRepair";

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

/**
 * Every early ASR result must pass through the same child-speech repair used by
 * the authoritative ASR path. If the transcript changes, any translation or
 * audio created from the old text is stale and must not be reused.
 */
export function resolvePrefetchedTranscriptForPipeline(
  prefetchedTranscript: PrefetchedTranscript,
): ResolvedPrefetchedTranscript {
  const originalSourceText = prefetchedTranscript.sourceText.trim();
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
