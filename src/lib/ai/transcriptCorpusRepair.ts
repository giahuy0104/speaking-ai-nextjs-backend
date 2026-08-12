import {
  normalizeVietnameseForAsrRuleMatch,
  normalizeVietnameseForExactMatch,
  reviewedExactRulesV1,
  type ExactTranslationRule,
} from "./exactRules";
import {
  findObservedChildSpeechAlias,
  findObservedChildSpeechAliasFolded,
  getObservedChildSpeechAliasCandidates,
  type ObservedChildSpeechAlias,
} from "./observedChildSpeechAliases";
import { buildReviewedRegionalAliases } from "./regionalVocabulary";
import { findReviewedBook1AudioAlias } from "./reviewedBook1AudioAliases";
import { findReviewedBook2AudioAlias } from "./reviewedBook2AudioAliases";
import { findReviewedLegacyAudioAlias } from "./reviewedLegacyAudioAliases";
import { findReviewedTestedAudioAlias } from "./reviewedTestedAudioAliases";
import { findReviewedWebRetestAudioAlias } from "./reviewedWebRetestAudioAliases";

export type TranscriptCorpusRepairStrategy =
  | "asr_folded"
  | "observed_child_alias"
  | "observed_child_folded"
  | "observed_child_fuzzy"
  | "reviewed_book1_audio_alias"
  | "reviewed_book2_audio_alias"
  | "reviewed_tested_audio_alias"
  | "reviewed_web_retest_audio_alias"
  | "reviewed_legacy_audio_alias"
  | "observed_asr_alias"
  | "regional_alias"
  | "regional_fuzzy";

export type TranscriptCorpusRepairResult = {
  text: string;
  repaired: boolean;
  ruleId?: string;
  correctionId?: string;
  strategy?: TranscriptCorpusRepairStrategy;
  score?: number;
  margin?: number;
};

const priorityRuleIds = new Set([
  "V1-CHILD-001",
  ...Array.from(
    { length: 99 },
    (_, index) => `AIV0-${String(index + 1).padStart(4, "0")}`,
  ),
]);

/**
 * Fuzzy pronunciation repair intentionally remains limited to 100 reviewed
 * high-frequency sentences. Exact regional aliases are expanded separately
 * to the full 5,000-sentence corpus below.
 */
export const regionalChildSpeechRulesV1 = reviewedExactRulesV1.filter((rule) =>
  priorityRuleIds.has(rule.id),
);

if (regionalChildSpeechRulesV1.length !== 100) {
  throw new Error(
    `Regional child-speech rollout must contain 100 rules, got ${regionalChildSpeechRulesV1.length}`,
  );
}

export const regionalCorpusRulesV1 = reviewedExactRulesV1.filter((rule) =>
  rule.id.startsWith("AIV0-"),
);

if (regionalCorpusRulesV1.length !== 5_000) {
  throw new Error(
    `Regional corpus rollout must contain 5,000 rules, got ${regionalCorpusRulesV1.length}`,
  );
}

const uniqueRegionalCorpusRuleByVietnamese = new Map<
  string,
  ExactTranslationRule
>();
for (const rule of regionalCorpusRulesV1) {
  const normalized = normalizeVietnameseForExactMatch(rule.vietnamese);
  if (!uniqueRegionalCorpusRuleByVietnamese.has(normalized)) {
    uniqueRegionalCorpusRuleByVietnamese.set(normalized, rule);
  }
}

export const regionalCorpusMatchRulesV1 = [
  ...uniqueRegionalCorpusRuleByVietnamese.values(),
];

const regionalExactRepairRuleByVietnamese = new Map(
  uniqueRegionalCorpusRuleByVietnamese,
);
for (const rule of regionalChildSpeechRulesV1) {
  const normalized = normalizeVietnameseForExactMatch(rule.vietnamese);
  if (!regionalExactRepairRuleByVietnamese.has(normalized)) {
    regionalExactRepairRuleByVietnamese.set(normalized, rule);
  }
}
const regionalExactRepairRulesV1 = [
  ...regionalExactRepairRuleByVietnamese.values(),
];

const knownTokenConfusionGroups = [
  // Subject variants frequently emitted by Vietnamese ASR for child speech.
  ["con", "co", "cong", "cung"],
  // "rất" pronounced or transcribed with d/gi/z/g and t/c endings.
  ["rat", "dat", "zat", "gat", "gac"],
  ["vui", "zui", "dui"],
  ["muon", "mun", "mon"],
  ["nuoc", "nuot"],
  ["so", "xo"],
] as const;

const tokenConfusionGroupByToken = new Map<string, number>();
for (const [groupIndex, group] of knownTokenConfusionGroups.entries()) {
  for (const token of group) {
    tokenConfusionGroupByToken.set(token, groupIndex);
  }
}

const optionalChildSpeechTokens = new Set(["con", "oi", "a", "nhe"]);
const negationTokens = new Set(["khong", "chua", "chang"]);
const protectedMeaningTokens = new Set([
  "không",
  "chưa",
  "chẳng",
  "đừng",
  "con",
  "cô",
  "thầy",
  "bố",
  "mẹ",
  "ba",
  "má",
  "anh",
  "chị",
  "em",
  "ông",
  "bà",
  "bé",
  "cháu",
  "bạn",
  "bác",
  "cậu",
  "dì",
  "chú",
  "thím",
  "mợ",
  "dượng",
  "chồng",
  "vợ",
  "mình",
  "tôi",
  "một",
  "hai",
  "ba",
  "bốn",
  "năm",
  "sáu",
  "bảy",
  "tám",
  "chín",
  "mười",
]);

function tokensForSpeechMatch(text: string) {
  const normalized = normalizeVietnameseForAsrRuleMatch(text);
  return normalized ? normalized.split(" ") : [];
}

function hasVietnameseDiacritics(text: string) {
  const exact = normalizeVietnameseForExactMatch(text);
  return exact !== normalizeVietnameseForAsrRuleMatch(text);
}

function phoneticCode(token: string) {
  return token
    .replace(/^ngh/, "ng")
    .replace(/^gi/, "z")
    .replace(/^(?:tr|ch)/, "c")
    .replace(/^[sx]/, "s")
    .replace(/^[rdz]/, "z")
    .replace(/^[ln]/, "n")
    .replace(/(?:ng|n)$/, "n")
    .replace(/[tc]$/, "t");
}

function editDistance(left: string, right: string) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function tokenCost(source: string, canonical: string) {
  if (source === canonical) return 0;

  const sourceGroup = tokenConfusionGroupByToken.get(source);
  if (
    sourceGroup !== undefined &&
    sourceGroup === tokenConfusionGroupByToken.get(canonical)
  ) {
    return 0.18;
  }

  if (phoneticCode(source) === phoneticCode(canonical)) {
    return 0.28;
  }

  const longestLength = Math.max(source.length, canonical.length);
  const similarity =
    longestLength === 0
      ? 1
      : 1 - editDistance(source, canonical) / longestLength;
  if (similarity >= 0.8) return 0.35;
  if (Math.min(source.length, canonical.length) >= 3 && similarity >= 0.67) {
    return 0.48;
  }

  return null;
}

function haveSameNegation(
  sourceTokens: readonly string[],
  canonicalTokens: readonly string[],
) {
  const sourceNegation = sourceTokens.filter((token) =>
    negationTokens.has(token),
  );
  const canonicalNegation = canonicalTokens.filter((token) =>
    negationTokens.has(token),
  );
  return sourceNegation.join(" ") === canonicalNegation.join(" ");
}

function protectedMeaningSignature(text: string) {
  return normalizeVietnameseForExactMatch(text)
    .split(" ")
    .filter(
      (token) => protectedMeaningTokens.has(token) || /^\d+$/.test(token),
    )
    .join(" ");
}

function haveSameProtectedMeaning(sourceText: string, candidateText: string) {
  return (
    protectedMeaningSignature(sourceText) ===
    protectedMeaningSignature(candidateText)
  );
}

function removeOneOptionalToken(tokens: readonly string[]) {
  const variants: string[][] = [];
  for (const [index, token] of tokens.entries()) {
    if (!optionalChildSpeechTokens.has(token)) continue;
    variants.push(tokens.filter((_, tokenIndex) => tokenIndex !== index));
  }
  return variants;
}

function alignTokenCounts(
  sourceTokens: readonly string[],
  canonicalTokens: readonly string[],
) {
  if (sourceTokens.length === canonicalTokens.length) {
    return [{ source: [...sourceTokens], canonical: [...canonicalTokens] }];
  }
  if (sourceTokens.length + 1 === canonicalTokens.length) {
    return removeOneOptionalToken(canonicalTokens)
      .filter((tokens) => tokens.length === sourceTokens.length)
      .map((tokens) => ({ source: [...sourceTokens], canonical: tokens }));
  }
  if (canonicalTokens.length + 1 === sourceTokens.length) {
    return removeOneOptionalToken(sourceTokens)
      .filter((tokens) => tokens.length === canonicalTokens.length)
      .map((tokens) => ({ source: tokens, canonical: [...canonicalTokens] }));
  }
  return [];
}

function scoreCandidateText(
  sourceText: string,
  candidateText: string,
  options: { protectMeaning?: boolean } = {},
) {
  const sourceTokens = tokensForSpeechMatch(sourceText);
  const canonicalTokens = tokensForSpeechMatch(candidateText);
  if (
    sourceTokens.length < 2 ||
    !haveSameNegation(sourceTokens, canonicalTokens) ||
    (options.protectMeaning &&
      !haveSameProtectedMeaning(sourceText, candidateText))
  ) {
    return null;
  }

  let bestScore: number | null = null;
  for (const alignment of alignTokenCounts(sourceTokens, canonicalTokens)) {
    let totalCost = 0;
    let changedTokens = 0;
    let valid = true;
    for (let index = 0; index < alignment.source.length; index += 1) {
      const cost = tokenCost(
        alignment.source[index],
        alignment.canonical[index],
      );
      if (cost === null) {
        valid = false;
        break;
      }
      totalCost += cost;
      if (cost > 0) changedTokens += 1;
    }
    const maxChangedTokens = canonicalTokens.length >= 5 ? 2 : 1;
    if (!valid || changedTokens > maxChangedTokens) continue;

    if (sourceTokens.length !== canonicalTokens.length) {
      totalCost += 0.45;
    }
    const score = 1 - totalCost / Math.max(sourceTokens.length, canonicalTokens.length);
    bestScore = bestScore === null ? score : Math.max(bestScore, score);
  }

  return bestScore;
}

function scoreCandidate(sourceText: string, rule: ExactTranslationRule) {
  return scoreCandidateText(sourceText, rule.vietnamese);
}

const foldedRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();
const exactRuleByVietnamese = new Map<string, ExactTranslationRule>();
for (const rule of regionalExactRepairRulesV1) {
  exactRuleByVietnamese.set(
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule,
  );
  const folded = normalizeVietnameseForAsrRuleMatch(rule.vietnamese);
  const existing = foldedRuleByVietnamese.get(folded);
  foldedRuleByVietnamese.set(
    folded,
    existing && existing.id !== rule.id ? null : rule,
  );
}

/**
 * Provider errors confirmed from real phone/Web test turns. These aliases are
 * deliberately explicit: broad fuzzy matching over all 5,000+ child
 * sentences can silently change a legitimate sentence into another rule.
 */
const reviewedObservedAsrCorrectionsV1 = [
  {
    aliases: [
      "Công mũ xem phim hòa cân",
      "À con muốn xem phim hoặc hình",
    ],
    canonical: "Con muốn xem phim hoạt hình.",
  },
  {
    aliases: ["Con bị vẹn rồi"],
    canonical: "Con mệt rồi.",
  },
  {
    aliases: ["Còn muốn đi sở thủ xìm càng hổ"],
    canonical: "Con muốn đi sở thú xem con hổ.",
  },
  {
    aliases: ["Con học lớp xấu rồi"],
    canonical: "Con học lớp sáu rồi.",
  },
] as const;

const reviewedRuleByCanonicalVietnamese = new Map(
  reviewedExactRulesV1.map((rule) => [
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule,
  ]),
);
const observedAsrCorrectionByFoldedText = new Map(
  reviewedObservedAsrCorrectionsV1.flatMap((correction) =>
    correction.aliases.map(
      (alias) =>
        [normalizeVietnameseForAsrRuleMatch(alias), correction] as const,
    ),
  ),
);

function addUnambiguousRuleAlias(
  aliases: Map<string, ExactTranslationRule | null>,
  alias: string,
  rule: ExactTranslationRule,
) {
  if (!aliases.has(alias)) {
    aliases.set(alias, rule);
    return;
  }
  const existing = aliases.get(alias);
  if (!existing || existing.id !== rule.id) {
    aliases.set(alias, null);
  }
}

const regionalAliasRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();
const foldedRegionalAliasRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();

for (const rule of regionalExactRepairRulesV1) {
  for (const alias of buildReviewedRegionalAliases(rule.vietnamese)) {
    const canonicalCollision = exactRuleByVietnamese.get(alias);
    if (canonicalCollision && canonicalCollision.id !== rule.id) continue;
    addUnambiguousRuleAlias(regionalAliasRuleByVietnamese, alias, rule);

    const foldedAlias = normalizeVietnameseForAsrRuleMatch(alias);
    const foldedCanonicalCollision = foldedRuleByVietnamese.get(foldedAlias);
    if (
      foldedRuleByVietnamese.has(foldedAlias) &&
      (!foldedCanonicalCollision || foldedCanonicalCollision.id !== rule.id)
    ) {
      continue;
    }
    addUnambiguousRuleAlias(
      foldedRegionalAliasRuleByVietnamese,
      foldedAlias,
      rule,
    );
  }
}

export const regionalCorpusRuntimeStats = {
  sourceRuleCount: regionalCorpusRulesV1.length,
  uniqueCanonicalCount: regionalCorpusMatchRulesV1.length,
  exactAliasCount: [...regionalAliasRuleByVietnamese.values()].filter(Boolean)
    .length,
  foldedAliasCount: [
    ...foldedRegionalAliasRuleByVietnamese.values(),
  ].filter(Boolean).length,
  ambiguousExactAliasCount: [
    ...regionalAliasRuleByVietnamese.values(),
  ].filter((rule) => rule === null).length,
  ambiguousFoldedAliasCount: [
    ...foldedRegionalAliasRuleByVietnamese.values(),
  ].filter((rule) => rule === null).length,
} as const;

function buildObservedChildAliasRepair(
  alias: ObservedChildSpeechAlias,
  strategy:
    | "observed_child_alias"
    | "observed_child_folded"
    | "observed_child_fuzzy",
  score: number,
  margin: number,
): TranscriptCorpusRepairResult {
  const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
    normalizeVietnameseForExactMatch(alias.canonical),
  );
  return {
    text: canonicalRule?.vietnamese ?? alias.canonical,
    repaired: true,
    ruleId: canonicalRule?.id,
    correctionId: alias.id,
    strategy,
    score: Number(score.toFixed(3)),
    margin: Number(margin.toFixed(3)),
  };
}

function isSafeFoldedObservedAlias(
  foldedTranscript: string,
  alias: ObservedChildSpeechAlias,
) {
  if (!foldedRuleByVietnamese.has(foldedTranscript)) return true;

  const canonicalCollision = foldedRuleByVietnamese.get(foldedTranscript);
  return (
    canonicalCollision !== null &&
    canonicalCollision !== undefined &&
    normalizeVietnameseForExactMatch(canonicalCollision.vietnamese) ===
      normalizeVietnameseForExactMatch(alias.canonical)
  );
}

function findControlledObservedChildAliasMatch(text: string) {
  const sourceTokenCount = tokensForSpeechMatch(text).length;
  const bestByCanonical = new Map<
    string,
    { alias: ObservedChildSpeechAlias; score: number; sameTokenCount: boolean }
  >();

  for (const alias of getObservedChildSpeechAliasCandidates(text)) {
    if (
      hasVietnameseDiacritics(text) &&
      normalizeVietnameseForAsrRuleMatch(text) ===
        normalizeVietnameseForAsrRuleMatch(alias.source) &&
      normalizeVietnameseForExactMatch(text) !==
        normalizeVietnameseForExactMatch(alias.source)
    ) {
      // A fully accented Vietnamese transcript can fold to another legitimate
      // sentence (for example ba/bà or quả/quà). Do not treat tone changes as
      // fuzzy evidence unless the reviewed exact alias itself matches.
      continue;
    }

    const score = scoreCandidateText(text, alias.source, {
      protectMeaning: true,
    });
    if (score === null) continue;

    const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
    const candidate = {
      alias,
      score,
      sameTokenCount:
        sourceTokenCount === tokensForSpeechMatch(alias.source).length,
    };
    const existing = bestByCanonical.get(canonicalKey);
    if (!existing || candidate.score > existing.score) {
      bestByCanonical.set(canonicalKey, candidate);
    }
  }

  const ranked = [...bestByCanonical.values()].sort(
    (left, right) => right.score - left.score,
  );
  const best = ranked[0];
  if (!best) return null;

  const secondScore = ranked[1]?.score ?? 0;
  const margin = best.score - secondScore;
  // A one-token optional particle costs 0.45 and is allowed only when the
  // token counts differ. Same-length candidates require a stricter score.
  const minimumScore = best.sameTokenCount ? 0.9 : 0.875;
  const minimumMargin = sourceTokenCount <= 4 ? 0.1 : 0.08;
  if (best.score < minimumScore || margin < minimumMargin) return null;

  return { alias: best.alias, score: best.score, margin };
}

export function repairVietnameseTranscriptWithCorpus(
  text: string,
): TranscriptCorpusRepairResult {
  const trimmed = text.trim();
  if (!trimmed) return { text: trimmed, repaired: false };

  const normalizedExact = normalizeVietnameseForExactMatch(trimmed);
  const exactRule = exactRuleByVietnamese.get(normalizedExact);
  if (exactRule) {
    return { text: trimmed, repaired: false, ruleId: exactRule.id };
  }

  const reviewedLegacyAudioAlias = findReviewedLegacyAudioAlias(trimmed);
  if (reviewedLegacyAudioAlias) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(reviewedLegacyAudioAlias.canonical),
    );
    return {
      text: canonicalRule?.vietnamese ?? reviewedLegacyAudioAlias.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      correctionId: reviewedLegacyAudioAlias.id,
      strategy: "reviewed_legacy_audio_alias",
      score: 1,
      margin: 1,
    };
  }

  const reviewedBook1AudioAlias = findReviewedBook1AudioAlias(trimmed);
  if (reviewedBook1AudioAlias) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(reviewedBook1AudioAlias.canonical),
    );
    return {
      text: canonicalRule?.vietnamese ?? reviewedBook1AudioAlias.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      correctionId: reviewedBook1AudioAlias.id,
      strategy: "reviewed_book1_audio_alias",
      score: 1,
      margin: 1,
    };
  }

  const reviewedBook2AudioAlias = findReviewedBook2AudioAlias(trimmed);
  if (reviewedBook2AudioAlias) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(reviewedBook2AudioAlias.canonical),
    );
    return {
      text: canonicalRule?.vietnamese ?? reviewedBook2AudioAlias.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      correctionId: reviewedBook2AudioAlias.id,
      strategy: "reviewed_book2_audio_alias",
      score: 1,
      margin: 1,
    };
  }

  const reviewedTestedAudioAlias = findReviewedTestedAudioAlias(trimmed);
  if (reviewedTestedAudioAlias) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(reviewedTestedAudioAlias.canonical),
    );
    return {
      text: canonicalRule?.vietnamese ?? reviewedTestedAudioAlias.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      correctionId: reviewedTestedAudioAlias.id,
      strategy: "reviewed_tested_audio_alias",
      score: 1,
      margin: 1,
    };
  }

  const reviewedWebRetestAudioAlias = findReviewedWebRetestAudioAlias(trimmed);
  if (reviewedWebRetestAudioAlias) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(reviewedWebRetestAudioAlias.canonical),
    );
    return {
      text: canonicalRule?.vietnamese ?? reviewedWebRetestAudioAlias.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      correctionId: reviewedWebRetestAudioAlias.id,
      strategy: "reviewed_web_retest_audio_alias",
      score: 1,
      margin: 1,
    };
  }

  const observedChildAlias = findObservedChildSpeechAlias(trimmed);
  if (observedChildAlias) {
    return buildObservedChildAliasRepair(
      observedChildAlias,
      "observed_child_alias",
      1,
      1,
    );
  }

  const folded = normalizeVietnameseForAsrRuleMatch(trimmed);
  const foldedObservedChildAlias =
    findObservedChildSpeechAliasFolded(trimmed);
  if (
    !hasVietnameseDiacritics(trimmed) &&
    foldedObservedChildAlias &&
    isSafeFoldedObservedAlias(folded, foldedObservedChildAlias)
  ) {
    return buildObservedChildAliasRepair(
      foldedObservedChildAlias,
      "observed_child_folded",
      1,
      1,
    );
  }

  const observedCorrection = observedAsrCorrectionByFoldedText.get(
    normalizeVietnameseForAsrRuleMatch(trimmed),
  );
  if (observedCorrection) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(observedCorrection.canonical),
    );
    return {
      text: observedCorrection.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      strategy: "observed_asr_alias",
      score: 1,
      margin: 1,
    };
  }

  const regionalAliasRule = regionalAliasRuleByVietnamese.get(normalizedExact);
  if (regionalAliasRule) {
    return {
      text: regionalAliasRule.vietnamese,
      repaired: true,
      ruleId: regionalAliasRule.id,
      strategy: "regional_alias",
      score: 1,
      margin: 1,
    };
  }

  const foldedRule = foldedRuleByVietnamese.get(folded);
  if (foldedRule) {
    return {
      text: foldedRule.vietnamese,
      repaired: true,
      ruleId: foldedRule.id,
      strategy: "asr_folded",
      score: 1,
      margin: 1,
    };
  }

  const foldedRegionalAliasRule =
    foldedRegionalAliasRuleByVietnamese.get(folded);
  if (foldedRegionalAliasRule) {
    return {
      text: foldedRegionalAliasRule.vietnamese,
      repaired: true,
      ruleId: foldedRegionalAliasRule.id,
      strategy: "regional_alias",
      score: 1,
      margin: 1,
    };
  }

  const observedChildFuzzyMatch =
    findControlledObservedChildAliasMatch(trimmed);
  if (observedChildFuzzyMatch) {
    return buildObservedChildAliasRepair(
      observedChildFuzzyMatch.alias,
      "observed_child_fuzzy",
      observedChildFuzzyMatch.score,
      observedChildFuzzyMatch.margin,
    );
  }

  const ranked = regionalChildSpeechRulesV1
    .map((rule) => ({ rule, score: scoreCandidate(trimmed, rule) }))
    .filter(
      (candidate): candidate is { rule: ExactTranslationRule; score: number } =>
        candidate.score !== null,
    )
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) return { text: trimmed, repaired: false };

  const secondScore = ranked[1]?.score ?? 0;
  const margin = best.score - secondScore;
  const tokenCount = tokensForSpeechMatch(trimmed).length;
  const minimumScore = tokenCount <= 3 ? 0.86 : 0.9;
  const minimumMargin = tokenCount <= 3 ? 0.16 : 0.1;
  if (best.score < minimumScore || margin < minimumMargin) {
    return { text: trimmed, repaired: false };
  }

  return {
    text: best.rule.vietnamese,
    repaired: true,
    ruleId: best.rule.id,
    strategy: "regional_fuzzy",
    score: Number(best.score.toFixed(3)),
    margin: Number(margin.toFixed(3)),
  };
}
