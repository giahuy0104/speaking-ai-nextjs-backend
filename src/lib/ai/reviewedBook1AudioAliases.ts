import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ReviewedBook1AudioAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: readonly number[];
};

export type ReviewedBook1AudioDecision = ReviewedBook1AudioAlias & {
  reason: string;
};

/**
 * Human-reviewed ASR results from `Book1.xlsx`, sheet `Sheet1`.
 *
 * Runtime aliases are exact whole-sentence matches only. Rows that rewrite a
 * valid speaker role or relationship are retained below for audit but are not
 * loaded into the matcher.
 */
export const reviewedBook1AudioAliasesV1 = Object.freeze<
  ReviewedBook1AudioAlias[]
>([
  {
    id: "BOOK1-AUDIO-001",
    source: "Còn có một quà báo?",
    canonical: "Con có một quả bóng",
    sampleCount: 2,
    sourceRows: [3, 6],
  },
]);

export const existingBook1AudioEvidenceV1 = Object.freeze<
  ReviewedBook1AudioDecision[]
>([
  {
    id: "BOOK1-EXISTING-001",
    source: "Con ơn đi chơi",
    canonical: "Con muốn đi chơi",
    sampleCount: 2,
    sourceRows: [4, 7],
    reason: "Already covered by LEGACY-AUDIO-011.",
  },
]);

export const rejectedBook1AudioAliasesV1 = Object.freeze<
  ReviewedBook1AudioDecision[]
>([
  {
    id: "BOOK1-REJECTED-001",
    source: "Tôi muốn chơi với bạn",
    canonical: "Con muốn chơi với bạn.",
    sampleCount: 3,
    sourceRows: [2, 5, 8],
    reason:
      "Rejected because both sentences are valid and the mapping rewrites the speaker role from tôi to con.",
  },
  {
    id: "BOOK1-REJECTED-002",
    source: "Cô muốn đi chơi.",
    canonical: "Con muốn chơi với bạn.",
    sampleCount: 1,
    sourceRows: [9],
    reason:
      "Rejected because it changes both the speaker role and the intended action.",
  },
  {
    id: "BOOK1-REJECTED-003",
    source: "Con muốn chơi với bác.",
    canonical: "Con muốn chơi với bạn.",
    sampleCount: 1,
    sourceRows: [10],
    reason:
      "Rejected because bác and bạn are distinct relationships in otherwise valid sentences.",
  },
]);

const aliasByExactTranscript = new Map<string, ReviewedBook1AudioAlias>();
for (const alias of reviewedBook1AudioAliasesV1) {
  const sourceKey = normalizeVietnameseForExactMatch(alias.source);
  const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid reviewed Book1 audio alias: ${alias.id}`);
  }
  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting reviewed Book1 audio alias: ${existing.id}/${alias.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...alias }));
}

export const reviewedBook1AudioAliasStats = Object.freeze({
  sourceWorkbook: "Book1.xlsx",
  sourceSheet: "Sheet1",
  sourceRowCount: 9,
  uniqueSourceCount: 5,
  activeAliasCount: aliasByExactTranscript.size,
  activeRowCount: reviewedBook1AudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  existingEvidenceCount: existingBook1AudioEvidenceV1.length,
  existingEvidenceRowCount: existingBook1AudioEvidenceV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  rejectedAliasCount: rejectedBook1AudioAliasesV1.length,
  rejectedRowCount: rejectedBook1AudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
});

export function findReviewedBook1AudioAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") return null;
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
