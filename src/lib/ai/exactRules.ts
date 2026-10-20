import { faithfulTranslationGoldenSet } from "./faithfulTranslationGoldenSet";
import { reviewedCorpusRulesV1 } from "./corpusRules";
import { reviewedPhraseSupplementRulesV1 } from "./phraseSupplementRules";
import { RULE_VERSION } from "./translationPolicy";

export type ExactTranslationRule = {
  id: string;
  vietnamese: string;
  english: string;
  aliases: readonly string[];
  normalizedVietnamese: string;
  ruleVersion: string;
};

export type ExactTranslationRuleMatch = {
  rule: ExactTranslationRule;
  matchType: "exact" | "alias" | "asr_folded";
  matchedVietnamese: string;
};

type ReviewedRuleSource = {
  id: string;
  vietnamese: string;
  english: string;
  aliases?: readonly string[];
};

const reviewedHistoricalCorrections = [
  {
    id: "V1-HIST-001",
    vietnamese: "Con muốn mua cái này.",
    english: "I want to buy this.",
  },
  {
    id: "V1-HIST-002",
    vietnamese: "Con không muốn mua cái này.",
    english: "I don't want to buy this.",
  },
  {
    id: "V1-HIST-003",
    vietnamese: "Bố mua cái này cho con nhé.",
    english: "Dad, please buy this for me.",
  },
  {
    id: "V1-HIST-004",
    vietnamese: "Đường đi xa lắm.",
    english: "It's a long way.",
  },
  {
    id: "V1-HIST-005",
    vietnamese: "Con muốn đi sở thú.",
    english: "I want to go to the zoo.",
    aliases: ["Con muốn đi vườn thú."],
  },
  {
    id: "V1-HIST-006",
    vietnamese: "Con muốn đi thư viện.",
    english: "I want to go to the library.",
  },
  {
    id: "V1-CHILD-001",
    vietnamese: "Hôm nay con rất vui.",
    english: "Today, I'm very happy.",
  },
] as const satisfies readonly ReviewedRuleSource[];

/**
 * Exact matching ignores only presentation differences. Vietnamese diacritics,
 * word order, pronouns and meaning-bearing particles remain part of the key.
 */
export function normalizeVietnameseForExactMatch(text: string) {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps every word and its order, but removes Vietnamese diacritics that ASR
 * may omit. This is intentionally not fuzzy matching: meaning-bearing words
 * such as "không" still have to be present in the whole utterance.
 */
export function normalizeVietnameseForAsrRuleMatch(text: string) {
  return normalizeVietnameseForExactMatch(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d");
}

const reviewedPrimaryRuleSources: ReviewedRuleSource[] = [
  ...faithfulTranslationGoldenSet
    .filter((testCase) => testCase.exactRuleEligible)
    .map((testCase) => ({
      id: testCase.id,
      vietnamese: testCase.vietnamese,
      english: testCase.expectedEnglish,
    })),
  ...reviewedHistoricalCorrections,
  ...reviewedCorpusRulesV1,
];

// The official corpus is the source of truth. A legacy phrase supplement may
// add aliases for the same output, but it must never replace a corpus
// translation when the two sources disagree.
const primaryTranslationByVietnamese = new Map(
  reviewedPrimaryRuleSources.map((rule) => [
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule.english,
  ]),
);

const reviewedSpecialRuleSources: ReviewedRuleSource[] = [
  ...reviewedPrimaryRuleSources,
  ...reviewedPhraseSupplementRulesV1.filter((rule) => {
    const primaryEnglish = primaryTranslationByVietnamese.get(
      normalizeVietnameseForExactMatch(rule.vietnamese),
    );
    return primaryEnglish === undefined || primaryEnglish === rule.english;
  }),
].filter((rule) => !rule.id.startsWith("AIV0-"));

function toTranslationRule(testCase: ReviewedRuleSource): ExactTranslationRule {
  return {
    id: testCase.id,
    vietnamese: testCase.vietnamese,
    english: testCase.english,
    aliases: [...(testCase.aliases ?? [])],
    normalizedVietnamese: normalizeVietnameseForExactMatch(
      testCase.vietnamese,
    ),
    ruleVersion: RULE_VERSION,
  };
}

/**
 * The combined registry remains available to offline manifests, transcript
 * repair and audio warmup. Runtime translation uses the two indexed layers
 * below so a hand-reviewed exception and the official 5,000-sentence bank are
 * observable and independently prioritized.
 */
export const reviewedSpecialExactRulesV1 = reviewedSpecialRuleSources.map(
  toTranslationRule,
);
export const reviewedCorpusTranslationRulesV1 = reviewedCorpusRulesV1.map(
  toTranslationRule,
);
export const reviewedAllTranslationRulesV1 = [
  ...reviewedSpecialExactRulesV1,
  ...reviewedCorpusTranslationRulesV1,
];

type RuleMatchIndexes = {
  exact: Map<string, ExactTranslationRuleMatch>;
  asrFolded: Map<string, ExactTranslationRuleMatch>;
};

function buildRuleMatchIndexes(
  rules: readonly ExactTranslationRule[],
  layerName: string,
): RuleMatchIndexes {
  const exact = new Map<string, ExactTranslationRuleMatch>();

  function registerRuleMatch(
    rule: ExactTranslationRule,
    vietnamese: string,
    matchType: ExactTranslationRuleMatch["matchType"],
  ) {
    const normalizedVietnamese = normalizeVietnameseForExactMatch(vietnamese);

    if (!normalizedVietnamese) {
      throw new Error(`Empty reviewed ${layerName} phrase: ${rule.id}`);
    }

    const existing = exact.get(normalizedVietnamese);
    if (existing && existing.rule.english !== rule.english) {
      throw new Error(
        `Conflicting reviewed ${layerName} rules: ${existing.rule.id} and ${rule.id}`,
      );
    }

    // Canonical sentences always win over an alias that normalizes to the same
    // text. Equal-output alias collisions stay deterministic.
    if (!existing || (existing.matchType === "alias" && matchType === "exact")) {
      exact.set(normalizedVietnamese, {
        rule,
        matchType,
        matchedVietnamese: vietnamese,
      });
    }
  }

  for (const rule of rules) {
    registerRuleMatch(rule, rule.vietnamese, "exact");
  }
  for (const rule of rules) {
    for (const alias of rule.aliases) {
      registerRuleMatch(rule, alias, "alias");
    }
  }

  const asrFolded = new Map<string, ExactTranslationRuleMatch>();
  for (const match of exact.values()) {
    const normalizedVietnamese = normalizeVietnameseForAsrRuleMatch(
      match.matchedVietnamese,
    );
    const existing = asrFolded.get(normalizedVietnamese);
    if (existing && existing.rule.english !== match.rule.english) {
      throw new Error(
        `Conflicting reviewed ${layerName} ASR rules: ${existing.rule.id} and ${match.rule.id}`,
      );
    }
    if (
      !existing ||
      (existing.matchType === "alias" && match.matchType === "exact")
    ) {
      asrFolded.set(normalizedVietnamese, match);
    }
  }

  return { exact, asrFolded };
}

// Both indexes are built once when the server module loads. Per-turn lookup is
// O(1); no request scans or parses the 5,000 JSON rows.
const specialExactIndexes = buildRuleMatchIndexes(
  reviewedSpecialExactRulesV1,
  "special exact",
);
const corpusIndexes = buildRuleMatchIndexes(
  reviewedCorpusTranslationRulesV1,
  "5,000-sentence corpus",
);

export function findReviewedExactRuleMatch(vietnameseText: string) {
  const normalizedVietnamese = normalizeVietnameseForExactMatch(vietnameseText);
  return specialExactIndexes.exact.get(normalizedVietnamese) ?? null;
}

export function findReviewedExactRule(vietnameseText: string) {
  return findReviewedExactRuleMatch(vietnameseText)?.rule ?? null;
}

function findAsrRuleMatch(
  vietnameseText: string,
  indexes: RuleMatchIndexes,
) {
  const normalizedExact = normalizeVietnameseForExactMatch(vietnameseText);
  const exactMatch = indexes.exact.get(normalizedExact);
  if (exactMatch) return exactMatch;

  const normalizedFolded = normalizeVietnameseForAsrRuleMatch(vietnameseText);
  const foldedMatch = indexes.asrFolded.get(normalizedFolded);
  return foldedMatch
    ? { ...foldedMatch, matchType: "asr_folded" as const }
    : null;
}

export function findReviewedExactAsrRuleMatch(vietnameseText: string) {
  return findAsrRuleMatch(vietnameseText, specialExactIndexes);
}

export function findReviewedCorpusRuleMatch(vietnameseText: string) {
  return findAsrRuleMatch(vietnameseText, corpusIndexes);
}

export function findReviewedCorpusRule(vietnameseText: string) {
  return findReviewedCorpusRuleMatch(vietnameseText)?.rule ?? null;
}

/** Combined lookup retained for transcript repair, with special rules first. */
export function findReviewedAsrRuleMatch(vietnameseText: string) {
  return (
    findReviewedExactAsrRuleMatch(vietnameseText) ??
    findReviewedCorpusRuleMatch(vietnameseText)
  );
}

export function getReviewedRuleAudioTexts(limit?: number) {
  const texts = [
    ...new Set(reviewedAllTranslationRulesV1.map((rule) => rule.english)),
  ];
  return limit === undefined ? texts : texts.slice(0, Math.max(0, limit));
}
