import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ReviewedBook2AudioAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: readonly number[];
};

export type ReviewedBook2AudioDecision = ReviewedBook2AudioAlias & {
  reason: string;
  existingId?: string;
};

/**
 * Human-reviewed ASR results from `Book2.xlsx`, sheet `Sheet1`.
 *
 * Runtime aliases are exact whole-sentence matches only. Valid alternative
 * meanings, negation changes and protected speaker/relationship changes are
 * retained as rejected decisions and never loaded into the matcher.
 */
export const reviewedBook2AudioAliasesV1 = Object.freeze<
  ReviewedBook2AudioAlias[]
>([
  { id: "BOOK2-AUDIO-001", source: "Con gọi là ngọt", canonical: "Con gọi là Ngô.", sampleCount: 1, sourceRows: [2] },
  { id: "BOOK2-AUDIO-002", source: "Con thái con mẹ", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRows: [3] },
  { id: "BOOK2-AUDIO-003", source: "Còn bụi ăn nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [4] },
  { id: "BOOK2-AUDIO-004", source: "Cầm muốn uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [5] },
  { id: "BOOK2-AUDIO-005", source: "Canh hít mở đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRows: [6] },
  { id: "BOOK2-AUDIO-006", source: "Con tên là bé May", canonical: "Con tên là Bé Mây.", sampleCount: 3, sourceRows: [10, 22, 31] },
  { id: "BOOK2-AUDIO-007", source: "Con gọi này bê", canonical: "Con gọi là ba", sampleCount: 1, sourceRows: [11] },
  { id: "BOOK2-AUDIO-008", source: "Ơn rồi này Bắc", canonical: "Con gọi là bắp", sampleCount: 1, sourceRows: [12] },
  { id: "BOOK2-AUDIO-009", source: "Mẹ ơi con con giúp", canonical: "Mẹ ơi, con cần giúp.", sampleCount: 1, sourceRows: [13] },
  { id: "BOOK2-AUDIO-010", source: "Con thức ăn cơm", canonical: "Con thích ăn cơm.", sampleCount: 1, sourceRows: [14] },
  { id: "BOOK2-AUDIO-011", source: "Con gỗ là bê", canonical: "Con gọi là ba", sampleCount: 2, sourceRows: [15, 35] },
  { id: "BOOK2-AUDIO-012", source: "Mà muốn uống nước", canonical: "Con muốn uống nước.", sampleCount: 2, sourceRows: [17, 37] },
  { id: "BOOK2-AUDIO-013", source: "Con gọi bằng bè", canonical: "Con gọi bằng ba", sampleCount: 1, sourceRows: [18] },
  { id: "BOOK2-AUDIO-014", source: "Còn 5 tổ quý", canonical: "Con năm tuổi", sampleCount: 1, sourceRows: [20] },
  { id: "BOOK2-AUDIO-015", source: "Công thầy, công mèo", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRows: [21] },
  { id: "BOOK2-AUDIO-016", source: "Con tên là bé này", canonical: "Con tên là bé mây", sampleCount: 1, sourceRows: [23] },
  { id: "BOOK2-AUDIO-017", source: "có một quả tống", canonical: "Con có một quả bóng.", sampleCount: 1, sourceRows: [26] },
  { id: "BOOK2-AUDIO-018", source: "Câu muốn uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [27] },
  { id: "BOOK2-AUDIO-019", source: "Câu nước uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [29] },
  { id: "BOOK2-AUDIO-020", source: "Con gọi là bao", canonical: "Con gọi là ba", sampleCount: 1, sourceRows: [33] },
  { id: "BOOK2-AUDIO-021", source: "Cùng là bí mây", canonical: "Con là bé mây", sampleCount: 1, sourceRows: [34] },
  { id: "BOOK2-AUDIO-022", source: "Con muốn nghe lửa.", canonical: "Con muốn nghe lại", sampleCount: 1, sourceRows: [39] },
  { id: "BOOK2-AUDIO-023", source: "Con gọi là bar", canonical: "Con gọi là ba", sampleCount: 1, sourceRows: [40] },
  { id: "BOOK2-AUDIO-024", source: "Con có một quà bán.", canonical: "Con có một quả bóng.", sampleCount: 1, sourceRows: [42] },
  { id: "BOOK2-AUDIO-025", source: "Con muốn trao với bọn", canonical: "Con muốn chơi với bạn.", sampleCount: 2, sourceRows: [44, 46] },
  { id: "BOOK2-AUDIO-026", source: "Còn mua uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [45] },
  { id: "BOOK2-AUDIO-027", source: "Cô chối nó chậm nữa nhé", canonical: "Cô chú nói chậm lại nhé.", sampleCount: 1, sourceRows: [47] },
  { id: "BOOK2-AUDIO-028", source: "Còn tên bé mày", canonical: "Con tên bé mây", sampleCount: 1, sourceRows: [49] },
  { id: "BOOK2-AUDIO-029", source: "Còn mũi nghe lại", canonical: "Con muốn nghe lại", sampleCount: 1, sourceRows: [50] },
  { id: "BOOK2-AUDIO-030", source: "Còn nhớ yên lúc", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [55] },
  { id: "BOOK2-AUDIO-031", source: "Con rất màu đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRows: [56] },
  { id: "BOOK2-AUDIO-032", source: "Còn thăng là bé mai", canonical: "Con tên là bé mây", sampleCount: 1, sourceRows: [58] },
  { id: "BOOK2-AUDIO-033", source: "Câu ngũ là bo.", canonical: "Con gọi là ba", sampleCount: 1, sourceRows: [59] },
  { id: "BOOK2-AUDIO-034", source: "Công thái con mèo", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRows: [60] },
  { id: "BOOK2-AUDIO-035", source: "Còn có màu quả bán.", canonical: "Con có một quả bóng.", sampleCount: 1, sourceRows: [61] },
  { id: "BOOK2-AUDIO-036", source: "Câu mũi ngớp.", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [62] },
  { id: "BOOK2-AUDIO-037", source: "Con thích mà đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRows: [64] },
  { id: "BOOK2-AUDIO-038", source: "Con muốn chờ với bọn", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRows: [65] },
]);

export const existingBook2AudioEvidenceV1 = Object.freeze<
  ReviewedBook2AudioDecision[]
>([
  {
    id: "BOOK2-EXISTING-001",
    source: "Con ơn đi chơi",
    canonical: "Con muốn đi chơi",
    sampleCount: 2,
    sourceRows: [16, 36],
    existingId: "LEGACY-AUDIO-011",
    reason: "Already covered by an active reviewed legacy alias.",
  },
  {
    id: "BOOK2-EXISTING-002",
    source: "Tôi muốn chơi với bạn.",
    canonical: "Con muốn chơi với bạn.",
    sampleCount: 3,
    sourceRows: [8, 9, 57],
    existingId: "BOOK1-REJECTED-001",
    reason: "Already rejected because it rewrites a valid speaker role.",
  },
]);

export const rejectedBook2AudioAliasesV1 = Object.freeze<
  ReviewedBook2AudioDecision[]
>([
  { id: "BOOK2-REJECTED-001", source: "Con muốn chào mấy bà anh.", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRows: [7], reason: "Changes the action and several relationship words." },
  { id: "BOOK2-REJECTED-002", source: "Cảm ơn ông nữ", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [19], reason: "Replaces a plausible thank-you utterance and protected relationship word with a different intent." },
  { id: "BOOK2-REJECTED-003", source: "Không muốn nghe lại", canonical: "Con muốn nghe lại.", sampleCount: 1, sourceRows: [24], reason: "Removes explicit negation and reverses meaning." },
  { id: "BOOK2-REJECTED-004", source: "Con thích con mèo", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRows: [25], reason: "Both sentences are valid but express different actions." },
  { id: "BOOK2-REJECTED-005", source: "Cô chú nói chào mẹ nhé.", canonical: "Cô chú nói chậm lại nhé.", sampleCount: 1, sourceRows: [28], reason: "Both sentences are plausible and have different actions and objects." },
  { id: "BOOK2-REJECTED-006", source: "Thôi chú nói chậm lại nha", canonical: "Cô chú nói chậm lại nhé.", sampleCount: 1, sourceRows: [30], reason: "Changes a valid protected speaker role." },
  { id: "BOOK2-REJECTED-007", source: "Anh tên là Bé May.", canonical: "Con tên là bé mây", sampleCount: 1, sourceRows: [32], reason: "Rewrites a valid speaker role and a possible personal name." },
  { id: "BOOK2-REJECTED-008", source: "Cảm ơn ông lưu", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRows: [38], reason: "Replaces a plausible thank-you utterance and protected relationship word with a different intent." },
  { id: "BOOK2-REJECTED-009", source: "con gọi là bác", canonical: "Con muốn nghe lại.", sampleCount: 1, sourceRows: [41], reason: "Both the action and protected relationship word change." },
  { id: "BOOK2-REJECTED-010", source: "Con muốn đi cha ơi", canonical: "Con muốn đi chơi", sampleCount: 1, sourceRows: [43], reason: "Could be a valid direct address to a parent and changes the intended action." },
  { id: "BOOK2-REJECTED-011", source: "Chú nói chẳng là ai?", canonical: "Chú nói chậm lại.", sampleCount: 1, sourceRows: [48], reason: "Removes negation and replaces a plausible question with a request." },
  { id: "BOOK2-REJECTED-012", source: "Cô muốn chơi với bạn", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRows: [51], reason: "Rewrites a valid protected speaker role." },
  { id: "BOOK2-REJECTED-013", source: "khi con 4 tuổi", canonical: "Con bốn tuổi", sampleCount: 1, sourceRows: [52], reason: "Changes a valid time clause into a present-age statement." },
  { id: "BOOK2-REJECTED-014", source: "Không muốn đi chơi với bạn", canonical: "Con muốn đi chơi với bạn", sampleCount: 1, sourceRows: [53], reason: "Removes explicit negation and reverses meaning." },
  { id: "BOOK2-REJECTED-015", source: "Cảm ơn giúp", canonical: "Mẹ ơi con cần giúp", sampleCount: 1, sourceRows: [54], reason: "Replaces the whole utterance with a different intent and protected relationship word." },
  { id: "BOOK2-REJECTED-016", source: "Công công hiểu.", canonical: "Con không hiểu.", sampleCount: 1, sourceRows: [63], reason: "Adds negation; retained behind the existing meaning-reversal safety guard." },
]);

const aliasByExactTranscript = new Map<string, ReviewedBook2AudioAlias>();
for (const alias of reviewedBook2AudioAliasesV1) {
  const sourceKey = normalizeVietnameseForExactMatch(alias.source);
  const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid reviewed Book2 audio alias: ${alias.id}`);
  }
  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting reviewed Book2 audio alias: ${existing.id}/${alias.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...alias }));
}

export const reviewedBook2AudioAliasStats = Object.freeze({
  sourceWorkbook: "Book2.xlsx",
  sourceSheet: "Sheet1",
  sourceRowCount: 64,
  uniqueSourceCount: 56,
  activeAliasCount: aliasByExactTranscript.size,
  activeRowCount: reviewedBook2AudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  existingEvidenceCount: existingBook2AudioEvidenceV1.length,
  existingEvidenceRowCount: existingBook2AudioEvidenceV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  rejectedAliasCount: rejectedBook2AudioAliasesV1.length,
  rejectedRowCount: rejectedBook2AudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
});

export function findReviewedBook2AudioAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") return null;
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
