import observedChildSpeechAliasData from "./observedChildSpeechAliasesV1.json";
import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ObservedChildSpeechAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: number[];
};

type ObservedChildSpeechAliasDataset = {
  version: string;
  sourceWorkbook: string;
  sourceSheet: string;
  generatedFromRows: number;
  excluded: {
    ambiguousSourceCount: number;
    noOpSourceCount: number;
    negationMismatchSourceCount: number;
    protectedRoleMismatchSourceCount: number;
    personalNameSourceCount: number;
  };
  entries: ObservedChildSpeechAlias[];
};

const dataset =
  observedChildSpeechAliasData as ObservedChildSpeechAliasDataset;
const aliasByExactTranscript = new Map<string, ObservedChildSpeechAlias>();

for (const entry of dataset.entries) {
  const sourceKey = normalizeVietnameseForExactMatch(entry.source);
  const canonicalKey = normalizeVietnameseForExactMatch(entry.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid observed child-speech alias: ${entry.id}`);
  }
  if (sourceKey.split(" ").length < 3) {
    throw new Error(`Observed child-speech alias is too short: ${entry.id}`);
  }

  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting observed child-speech alias: ${existing.id}/${entry.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...entry }));
}

export const observedChildSpeechAliasRuntimeStats = Object.freeze({
  version: dataset.version,
  generatedFromRows: dataset.generatedFromRows,
  aliasCount: aliasByExactTranscript.size,
  ...dataset.excluded,
});

export const observedChildSpeechAliases = Object.freeze([
  ...aliasByExactTranscript.values(),
]);

/**
 * Exact full-sentence lookup only. This deliberately avoids fuzzy expansion,
 * database access and external calls in the latency-sensitive ASR path.
 */
export function findObservedChildSpeechAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") {
    return null;
  }
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
