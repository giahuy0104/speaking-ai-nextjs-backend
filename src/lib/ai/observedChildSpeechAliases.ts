import observedChildSpeechAliasData from "./observedChildSpeechAliasesV1.json";
import observedChildSpeechAliasDataV2 from "./observedChildSpeechAliasesV2.json";
import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ObservedChildSpeechAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: number[];
  sourceWorkbook?: string;
  ageGroups?: string[];
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
    duplicateOrExistingSourceCount?: number;
  };
  entries: ObservedChildSpeechAlias[];
};

const datasets = [
  observedChildSpeechAliasData,
  observedChildSpeechAliasDataV2,
] as ObservedChildSpeechAliasDataset[];
const aliasByExactTranscript = new Map<string, ObservedChildSpeechAlias>();

for (const dataset of datasets) {
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
}

export const observedChildSpeechAliasRuntimeStats = Object.freeze({
  version: datasets.map((dataset) => dataset.version).join("+"),
  generatedFromRows: datasets.reduce(
    (total, dataset) => total + dataset.generatedFromRows,
    0,
  ),
  aliasCount: aliasByExactTranscript.size,
  ambiguousSourceCount: datasets.reduce(
    (total, dataset) => total + dataset.excluded.ambiguousSourceCount,
    0,
  ),
  noOpSourceCount: datasets.reduce(
    (total, dataset) => total + dataset.excluded.noOpSourceCount,
    0,
  ),
  negationMismatchSourceCount: datasets.reduce(
    (total, dataset) => total + dataset.excluded.negationMismatchSourceCount,
    0,
  ),
  protectedRoleMismatchSourceCount: datasets.reduce(
    (total, dataset) =>
      total + dataset.excluded.protectedRoleMismatchSourceCount,
    0,
  ),
  personalNameSourceCount: datasets.reduce(
    (total, dataset) => total + dataset.excluded.personalNameSourceCount,
    0,
  ),
  duplicateOrExistingSourceCount: datasets.reduce(
    (total, dataset) =>
      total + (dataset.excluded.duplicateOrExistingSourceCount ?? 0),
    0,
  ),
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
