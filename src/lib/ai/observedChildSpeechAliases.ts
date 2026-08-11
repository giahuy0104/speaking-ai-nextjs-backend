import observedChildSpeechAliasData from "./observedChildSpeechAliasesV1.json";
import observedChildSpeechAliasDataV2 from "./observedChildSpeechAliasesV2.json";
import {
  normalizeVietnameseForAsrRuleMatch,
  normalizeVietnameseForExactMatch,
} from "./exactRules";

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

function addUnambiguousFoldedAlias(
  aliases: Map<string, ObservedChildSpeechAlias | null>,
  alias: ObservedChildSpeechAlias,
) {
  const foldedSource = normalizeVietnameseForAsrRuleMatch(alias.source);
  if (!foldedSource) return;

  if (!aliases.has(foldedSource)) {
    aliases.set(foldedSource, alias);
    return;
  }

  const existing = aliases.get(foldedSource);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) ===
      normalizeVietnameseForExactMatch(alias.canonical)
  ) {
    return;
  }

  // Accent folding can make two different Vietnamese sentences identical.
  // Keep that key disabled instead of guessing between different meanings.
  aliases.set(foldedSource, null);
}

const aliasByFoldedTranscript = new Map<
  string,
  ObservedChildSpeechAlias | null
>();
const aliasesByFoldedTokenCountAndToken = new Map<
  number,
  Map<string, ObservedChildSpeechAlias[]>
>();
const uniqueFoldedTokenCountByAliasId = new Map<string, number>();

for (const alias of aliasByExactTranscript.values()) {
  addUnambiguousFoldedAlias(aliasByFoldedTranscript, alias);

  const foldedTokens = normalizeVietnameseForAsrRuleMatch(alias.source)
    .split(" ")
    .filter(Boolean);
  const uniqueTokens = new Set(foldedTokens);
  uniqueFoldedTokenCountByAliasId.set(alias.id, uniqueTokens.size);

  const tokenIndex =
    aliasesByFoldedTokenCountAndToken.get(foldedTokens.length) ?? new Map();
  for (const token of uniqueTokens) {
    const tokenAliases = tokenIndex.get(token) ?? [];
    tokenAliases.push(alias);
    tokenIndex.set(token, tokenAliases);
  }
  aliasesByFoldedTokenCountAndToken.set(foldedTokens.length, tokenIndex);
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
  foldedAliasCount: [...aliasByFoldedTranscript.values()].filter(Boolean)
    .length,
  ambiguousFoldedAliasCount: [...aliasByFoldedTranscript.values()].filter(
    (alias) => alias === null,
  ).length,
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

/**
 * Accent-insensitive whole-sentence lookup. Ambiguous folded keys are removed
 * at startup, so this remains an O(1) lookup without guessing between meanings.
 */
export function findObservedChildSpeechAliasFolded(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") {
    return null;
  }
  return (
    aliasByFoldedTranscript.get(
      normalizeVietnameseForAsrRuleMatch(transcript),
    ) ?? null
  );
}

/**
 * Returns only aliases whose token count can be aligned with the transcript.
 * This keeps controlled fuzzy matching away from the complete alias corpus.
 */
export function getObservedChildSpeechAliasCandidates(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") {
    return [];
  }

  const tokens = normalizeVietnameseForAsrRuleMatch(transcript)
    .split(" ")
    .filter(Boolean);
  const tokenCount = tokens.length;
  if (tokenCount < 2) return [];

  const uniqueInputTokens = new Set(tokens);
  const overlapByAlias = new Map<ObservedChildSpeechAlias, number>();
  for (const candidateTokenCount of [
    tokenCount - 1,
    tokenCount,
    tokenCount + 1,
  ]) {
    const tokenIndex =
      aliasesByFoldedTokenCountAndToken.get(candidateTokenCount);
    if (!tokenIndex) continue;

    for (const token of uniqueInputTokens) {
      for (const alias of tokenIndex.get(token) ?? []) {
        overlapByAlias.set(alias, (overlapByAlias.get(alias) ?? 0) + 1);
      }
    }
  }

  return [...overlapByAlias.entries()]
    .filter(([alias, overlap]) => {
      const aliasUniqueTokenCount =
        uniqueFoldedTokenCountByAliasId.get(alias.id) ?? 0;
      const comparableUniqueTokenCount = Math.min(
        uniqueInputTokens.size,
        aliasUniqueTokenCount,
      );
      const allowedMissingTokens = tokenCount >= 5 ? 2 : 1;
      return (
        overlap >=
        Math.max(1, comparableUniqueTokenCount - allowedMissingTokens)
      );
    })
    .map(([alias]) => alias);
}
