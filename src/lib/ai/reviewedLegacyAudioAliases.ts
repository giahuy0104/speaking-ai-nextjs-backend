import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ReviewedLegacyAudioAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: readonly number[];
};

export type RejectedReviewedLegacyAudioAlias = ReviewedLegacyAudioAlias & {
  reason: string;
};

/**
 * Human-reviewed ASR results from `Test audio cũ.xlsx`, sheet `Trang tính1`.
 *
 * These mappings are deliberately content-exact. Several rows change pronouns,
 * negation or a personal name, so they must never participate in accent-folded
 * or fuzzy matching. Punctuation and case are normalized by the exact lookup.
 * The only controlled variation is an equivalent final politeness particle
 * (`nha`/`nhá`/`nhé`); every content word must still match the reviewed ASR.
 */
export const reviewedLegacyAudioAliasesV1 = Object.freeze<
  ReviewedLegacyAudioAlias[]
>([
  { id: "LEGACY-AUDIO-001", source: "Cô chủ nói chậm lạ nhỉ? Ừ, ừ, ừ.", canonical: "Cô chú nói chậm lại nhé", sampleCount: 1, sourceRows: [2] },
  { id: "LEGACY-AUDIO-002", source: "Con thịt ăn cơm", canonical: "Con thích ăn cơm.", sampleCount: 1, sourceRows: [3] },
  { id: "LEGACY-AUDIO-003", source: "Con gọi là Ngo", canonical: "Con gọi là ngô", sampleCount: 1, sourceRows: [4] },
  { id: "LEGACY-AUDIO-004", source: "Con tên là Pé Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRows: [5] },
  { id: "LEGACY-AUDIO-005", source: "Cô nói chẳng lạc nhé.", canonical: "Cô nói chậm lại nhé", sampleCount: 2, sourceRows: [6, 24] },
  { id: "LEGACY-AUDIO-006", source: "Cảm ơn chơi với bạn.", canonical: "Con muốn chơi với bạn.", sampleCount: 2, sourceRows: [7, 25] },
  { id: "LEGACY-AUDIO-007", source: "Cảm ơn nghe lại", canonical: "Con muốn nghe lại.", sampleCount: 1, sourceRows: [8] },
  { id: "LEGACY-AUDIO-008", source: "Con gọi là bó.", canonical: "Con gọi là bố", sampleCount: 2, sourceRows: [9, 20] },
  { id: "LEGACY-AUDIO-009", source: "Con ngọt là ngon", canonical: "Con gọi là ngô", sampleCount: 2, sourceRows: [10, 21] },
  { id: "LEGACY-AUDIO-011", source: "Con ơn đi chơi", canonical: "Con muốn đi chơi.", sampleCount: 2, sourceRows: [12, 23] },
  { id: "LEGACY-AUDIO-012", source: "Căng thông hiểu", canonical: "Con không hiểu.", sampleCount: 1, sourceRows: [13] },
  { id: "LEGACY-AUDIO-013", source: "Cô nó trở lại nha", canonical: "Cô nói chậm lại nhé", sampleCount: 1, sourceRows: [14] },
  { id: "LEGACY-AUDIO-014", source: "Con muốn chơi giáp ảnh.", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRows: [15] },
  { id: "LEGACY-AUDIO-015", source: "Ở rà bố", canonical: "Con gọi là bố", sampleCount: 1, sourceRows: [16] },
  { id: "LEGACY-AUDIO-016", source: "Cơn cõi cà mô", canonical: "Con gọi là ngô", sampleCount: 1, sourceRows: [17] },
  { id: "LEGACY-AUDIO-017", source: "Con chân là mẹ mai", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRows: [18] },
  { id: "LEGACY-AUDIO-018", source: "Con hiếp mô đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRows: [19] },
  { id: "LEGACY-AUDIO-019", source: "Tao muốn uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [26] },
  { id: "LEGACY-AUDIO-020", source: "Con không thể không?", canonical: "Con không hiểu.", sampleCount: 1, sourceRows: [27] },
  { id: "LEGACY-AUDIO-021", source: "Chú nói cho mày nhé.", canonical: "Chú nói chậm lại nhé", sampleCount: 1, sourceRows: [28] },
  { id: "LEGACY-AUDIO-022", source: "Ôi mày con rất vui", canonical: "Hôm nay con rất vui.", sampleCount: 1, sourceRows: [29] },
  { id: "LEGACY-AUDIO-023", source: "Thầy càng mèo", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRows: [30] },
  { id: "LEGACY-AUDIO-024", source: "Mẹ ơi con còn giúp", canonical: "Mẹ ơi, con cần giúp.", sampleCount: 1, sourceRows: [31] },
  { id: "LEGACY-AUDIO-025", source: "Con thích ngủ đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRows: [32] },
  { id: "LEGACY-AUDIO-026", source: "Con muốn cho với bạn", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRows: [33] },
  { id: "LEGACY-AUDIO-027", source: "Chú nó chậm lại nhé", canonical: "Chú nói chậm lại nhé", sampleCount: 1, sourceRows: [34] },
  { id: "LEGACY-AUDIO-028", source: "Anh ta là bé Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRows: [35] },
  { id: "LEGACY-AUDIO-029", source: "Con tên là Bẻ Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRows: [36] },
  { id: "LEGACY-AUDIO-030", source: "Cô chú nó chậm lại nhé.", canonical: "Cô chú nói chậm lại nhé", sampleCount: 1, sourceRows: [37] },
  { id: "LEGACY-AUDIO-031", source: "Con tên là Bẻ May", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRows: [38] },
]);

export const rejectedReviewedLegacyAudioAliasesV1 = Object.freeze<
  RejectedReviewedLegacyAudioAlias[]
>([
  {
    id: "LEGACY-AUDIO-010",
    source: "Còn có một quà báo?",
    canonical: "Con có một quả bóng.",
    sampleCount: 2,
    sourceRows: [11, 22],
    reason:
      "Quarantined because it changes several meaning-bearing words and conflicts with the existing child-speech safety regression.",
  },
]);

const aliasByExactTranscript = new Map<string, ReviewedLegacyAudioAlias>();
const aliasByFinalPolitenessTranscript = new Map<
  string,
  ReviewedLegacyAudioAlias
>();
const ambiguousFinalPolitenessTranscripts = new Set<string>();
const finalPolitenessParticles = new Set(["nha", "nhá", "nhé"]);

function normalizeFinalPolitenessTranscript(text: string) {
  const tokens = normalizeVietnameseForExactMatch(text).split(" ");
  if (!finalPolitenessParticles.has(tokens.at(-1) ?? "")) return null;
  tokens[tokens.length - 1] = "<politeness>";
  return tokens.join(" ");
}

for (const alias of reviewedLegacyAudioAliasesV1) {
  const sourceKey = normalizeVietnameseForExactMatch(alias.source);
  const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid reviewed legacy-audio alias: ${alias.id}`);
  }
  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting reviewed legacy-audio alias: ${existing.id}/${alias.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...alias }));

  const finalPolitenessKey = normalizeFinalPolitenessTranscript(alias.source);
  if (!finalPolitenessKey) continue;
  const existingFinalPolitenessAlias = aliasByFinalPolitenessTranscript.get(
    finalPolitenessKey,
  );
  if (
    existingFinalPolitenessAlias &&
    normalizeVietnameseForExactMatch(existingFinalPolitenessAlias.canonical) !==
      canonicalKey
  ) {
    aliasByFinalPolitenessTranscript.delete(finalPolitenessKey);
    ambiguousFinalPolitenessTranscripts.add(finalPolitenessKey);
    continue;
  }
  if (!ambiguousFinalPolitenessTranscripts.has(finalPolitenessKey)) {
    aliasByFinalPolitenessTranscript.set(finalPolitenessKey, alias);
  }
}

export const reviewedLegacyAudioAliasStats = Object.freeze({
  sourceWorkbook: "Test audio cũ.xlsx",
  sourceSheet: "Trang tính1",
  sourceRowCount: [
    ...reviewedLegacyAudioAliasesV1,
    ...rejectedReviewedLegacyAudioAliasesV1,
  ].reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  generatedFromRows: reviewedLegacyAudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  aliasCount: aliasByExactTranscript.size,
  finalPolitenessAliasCount: aliasByFinalPolitenessTranscript.size,
  ambiguousFinalPolitenessAliasCount:
    ambiguousFinalPolitenessTranscripts.size,
  rejectedAliasCount: rejectedReviewedLegacyAudioAliasesV1.length,
  rejectedRowCount: rejectedReviewedLegacyAudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
});

export function findReviewedLegacyAudioAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") return null;
  const exactAlias = aliasByExactTranscript.get(
    normalizeVietnameseForExactMatch(transcript),
  );
  if (exactAlias) return exactAlias;

  const finalPolitenessKey = normalizeFinalPolitenessTranscript(transcript);
  if (
    !finalPolitenessKey ||
    ambiguousFinalPolitenessTranscripts.has(finalPolitenessKey)
  ) {
    return null;
  }
  return aliasByFinalPolitenessTranscript.get(finalPolitenessKey) ?? null;
}
