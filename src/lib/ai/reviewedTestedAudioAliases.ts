import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ReviewedTestedAudioAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRefs: readonly string[];
};

export type ReviewedTestedAudioDecision = ReviewedTestedAudioAlias & {
  reason: string;
  existingId?: string;
};

/**
 * Human-reviewed ASR results from `Đã test audio.xlsx`.
 *
 * Runtime aliases are exact whole-sentence matches only. Plausible alternate
 * meanings, negation changes, protected speaker roles and conflicting labels
 * remain rejected decisions and are never loaded into the matcher.
 */
export const reviewedTestedAudioAliasesV1 = Object.freeze<
  ReviewedTestedAudioAlias[]
>([
  { id: "TESTED-AUDIO-001", source: "Mũ trời chia bát.", canonical: "Con muốn chơi với bạn", sampleCount: 1, sourceRefs: ["Trang tính2!A2:B2"] },
  { id: "TESTED-AUDIO-002", source: "Hôm nay trông rất trời.", canonical: "Hôm nay trông rất vui", sampleCount: 1, sourceRefs: ["Trang tính2!A3:B3"] },
  { id: "TESTED-AUDIO-003", source: "Quang gái trong mầm", canonical: "Con thấy con mèo", sampleCount: 1, sourceRefs: ["Trang tính2!A4:B4"] },
  { id: "TESTED-AUDIO-004", source: "Con thái rất bui.", canonical: "Con thấy rất vui", sampleCount: 1, sourceRefs: ["Trang tính2!A6:B6"] },
  { id: "TESTED-AUDIO-005", source: "Rồi muốn ăn thở", canonical: "Con muốn ăn phở", sampleCount: 1, sourceRefs: ["Trang tính2!A8:B8"] },
  { id: "TESTED-AUDIO-006", source: "Trông trái trông bông", canonical: "Con thấy con ong", sampleCount: 1, sourceRefs: ["Trang tính2!A10:B10"] },
  { id: "TESTED-AUDIO-007", source: "Cùng gái đáy bộ", canonical: "Con lấy cái ô", sampleCount: 1, sourceRefs: ["Trang tính2!A11:B11"] },
  { id: "TESTED-AUDIO-008", source: "Trùng cái trùng móc", canonical: "Con thấy con ốc", sampleCount: 1, sourceRefs: ["Trang tính2!A12:B12"] },
  { id: "TESTED-AUDIO-009", source: "Con muốn bè", canonical: "Con muốn vẽ", sampleCount: 1, sourceRefs: ["Trang tính2!A13:B13"] },
  { id: "TESTED-AUDIO-010", source: "Cái con lĩa", canonical: "Con thấy con khỉ", sampleCount: 1, sourceRefs: ["Trang tính2!A14:B14"] },
  { id: "TESTED-AUDIO-011", source: "Con cháy con eo", canonical: "Con thấy con mèo", sampleCount: 1, sourceRefs: ["Trang tính2!A15:B15"] },
  { id: "TESTED-AUDIO-012", source: "Con lấy cà báo", canonical: "Con lấy cái áo", sampleCount: 1, sourceRefs: ["Trang tính2!A16:B16"] },
  { id: "TESTED-AUDIO-013", source: "Con sáng chưa?", canonical: "Con ăn sáng chưa", sampleCount: 1, sourceRefs: ["Trang tính2!A18:B18"] },
]);

export const existingTestedAudioEvidenceV1 = Object.freeze<
  ReviewedTestedAudioDecision[]
>([
  { id: "TESTED-EXISTING-001", source: "Con gọi này bê", canonical: "Con gọi là ba", sampleCount: 1, sourceRefs: ["Trang tính1!A5:B5"], existingId: "BOOK2-AUDIO-007", reason: "Already covered by the reviewed Book2 exact alias." },
  { id: "TESTED-EXISTING-002", source: "Ơn rồi này Bắc", canonical: "Con gọi là bắp", sampleCount: 1, sourceRefs: ["Trang tính1!A6:B6"], existingId: "BOOK2-AUDIO-008", reason: "Already covered by the reviewed Book2 exact alias." },
  { id: "TESTED-EXISTING-003", source: "Con ơn đi chơi", canonical: "Con muốn đi chơi", sampleCount: 4, sourceRefs: ["Trang tính1!A7:B7", "Trang tính1!A9:B9", "Trang tính2!E14:F14", "Trang tính2!E25:F25"], existingId: "LEGACY-AUDIO-011", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-004", source: "Con tên bé mây", canonical: "Con tên bé mây", sampleCount: 1, sourceRefs: ["Trang tính1!A13:B13"], existingId: "EXACT-CANONICAL", reason: "The observed transcript is already the canonical sentence." },
  { id: "TESTED-EXISTING-005", source: "Con muốn ăn mánh", canonical: "Con muốn ăn bánh", sampleCount: 1, sourceRefs: ["Trang tính2!A5:B5"], existingId: "CHILD-ASR-V1-5110ACD6136C", reason: "Already covered by an active reviewed child-speech alias." },
  { id: "TESTED-EXISTING-006", source: "Cô chủ nói chậm lạ nhỉ? Ừ, ừ, ừ.", canonical: "Cô chú nói chậm lại nhé", sampleCount: 1, sourceRefs: ["Trang tính2!E4:F4"], existingId: "LEGACY-AUDIO-001", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-007", source: "Con thịt ăn cơm", canonical: "Con thích ăn cơm.", sampleCount: 1, sourceRefs: ["Trang tính2!E5:F5"], existingId: "LEGACY-AUDIO-002", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-008", source: "Con gọi là Ngo", canonical: "Con gọi là ngô", sampleCount: 1, sourceRefs: ["Trang tính2!E6:F6"], existingId: "LEGACY-AUDIO-003", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-009", source: "Con tên là Pé Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRefs: ["Trang tính2!E7:F7"], existingId: "LEGACY-AUDIO-004", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-010", source: "Cô nói chẳng lạc nhé.", canonical: "Cô nói chậm lại nhé", sampleCount: 2, sourceRefs: ["Trang tính2!E8:F8", "Trang tính2!E26:F26"], existingId: "LEGACY-AUDIO-005", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-011", source: "Cảm ơn chơi với bạn.", canonical: "Con muốn chơi với bạn.", sampleCount: 2, sourceRefs: ["Trang tính2!E9:F9", "Trang tính2!E27:F27"], existingId: "LEGACY-AUDIO-006", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-012", source: "Cảm ơn nghe lại", canonical: "Con muốn nghe lại.", sampleCount: 1, sourceRefs: ["Trang tính2!E10:F10"], existingId: "LEGACY-AUDIO-007", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-013", source: "Con gọi là bó.", canonical: "Con gọi là bố", sampleCount: 2, sourceRefs: ["Trang tính2!E11:F11", "Trang tính2!E22:F22"], existingId: "LEGACY-AUDIO-008", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-014", source: "Con ngọt là ngon", canonical: "Con gọi là ngô", sampleCount: 2, sourceRefs: ["Trang tính2!E12:F12", "Trang tính2!E23:F23"], existingId: "LEGACY-AUDIO-009", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-015", source: "Còn có một quà báo?", canonical: "Con có một quả bóng.", sampleCount: 2, sourceRefs: ["Trang tính2!E13:F13", "Trang tính2!E24:F24"], existingId: "BOOK1-AUDIO-001", reason: "Already covered by the reviewed Book1 exact alias." },
  { id: "TESTED-EXISTING-016", source: "Căng thông hiểu", canonical: "Con không hiểu.", sampleCount: 1, sourceRefs: ["Trang tính2!E15:F15"], existingId: "LEGACY-AUDIO-012", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-017", source: "Cô nó trở lại nha", canonical: "Cô nói chậm lại nhé", sampleCount: 1, sourceRefs: ["Trang tính2!E16:F16"], existingId: "LEGACY-AUDIO-013", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-018", source: "Con muốn chơi giáp ảnh.", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRefs: ["Trang tính2!E17:F17"], existingId: "LEGACY-AUDIO-014", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-019", source: "Ở rà bố", canonical: "Con gọi là bố", sampleCount: 1, sourceRefs: ["Trang tính2!E18:F18"], existingId: "LEGACY-AUDIO-015", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-020", source: "Cơn cõi cà mô", canonical: "Con gọi là ngô", sampleCount: 1, sourceRefs: ["Trang tính2!E19:F19"], existingId: "LEGACY-AUDIO-016", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-021", source: "Con chân là mẹ mai", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRefs: ["Trang tính2!E20:F20"], existingId: "LEGACY-AUDIO-017", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-022", source: "Con hiếp mô đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRefs: ["Trang tính2!E21:F21"], existingId: "LEGACY-AUDIO-018", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-023", source: "Tao muốn uống nước", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRefs: ["Trang tính2!E28:F28"], existingId: "LEGACY-AUDIO-019", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-024", source: "Con không thể không?", canonical: "Con không hiểu.", sampleCount: 1, sourceRefs: ["Trang tính2!E29:F29"], existingId: "LEGACY-AUDIO-020", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-025", source: "Chú nói cho mày nhé.", canonical: "Chú nói chậm lại nhé", sampleCount: 1, sourceRefs: ["Trang tính2!E30:F30"], existingId: "LEGACY-AUDIO-021", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-026", source: "Ôi mày con rất vui", canonical: "Hôm nay con rất vui.", sampleCount: 1, sourceRefs: ["Trang tính2!E31:F31"], existingId: "LEGACY-AUDIO-022", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-027", source: "Thầy càng mèo", canonical: "Con thấy con mèo.", sampleCount: 1, sourceRefs: ["Trang tính2!E32:F32"], existingId: "LEGACY-AUDIO-023", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-028", source: "Mẹ ơi con còn giúp", canonical: "Mẹ ơi, con cần giúp.", sampleCount: 1, sourceRefs: ["Trang tính2!E33:F33"], existingId: "LEGACY-AUDIO-024", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-029", source: "Con thích ngủ đỏ", canonical: "Con thích màu đỏ.", sampleCount: 1, sourceRefs: ["Trang tính2!E34:F34"], existingId: "LEGACY-AUDIO-025", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-030", source: "Con muốn cho với bạn", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRefs: ["Trang tính2!E35:F35"], existingId: "LEGACY-AUDIO-026", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-031", source: "Chú nó chậm lại nhé", canonical: "Chú nói chậm lại nhé", sampleCount: 1, sourceRefs: ["Trang tính2!E36:F36"], existingId: "LEGACY-AUDIO-027", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-032", source: "Anh ta là bé Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRefs: ["Trang tính2!E37:F37"], existingId: "LEGACY-AUDIO-028", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-033", source: "Con tên là Bẻ Mây", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRefs: ["Trang tính2!E38:F38"], existingId: "LEGACY-AUDIO-029", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-034", source: "Cô chú nó chậm lại nhé.", canonical: "Cô chú nói chậm lại nhé", sampleCount: 1, sourceRefs: ["Trang tính2!E39:F39"], existingId: "LEGACY-AUDIO-030", reason: "Already covered by an active reviewed legacy alias." },
  { id: "TESTED-EXISTING-035", source: "Con tên là Bẻ May", canonical: "Con tên là Bé Mây.", sampleCount: 1, sourceRefs: ["Trang tính2!E40:F40"], existingId: "LEGACY-AUDIO-031", reason: "Already covered by an active reviewed legacy alias." },
]);

export const rejectedTestedAudioAliasesV1 = Object.freeze<
  ReviewedTestedAudioDecision[]
>([
  { id: "TESTED-REJECTED-001", source: "Con muốn chào mấy bà anh.", canonical: "Con muốn chơi với bạn", sampleCount: 1, sourceRefs: ["Trang tính1!A2:B2"], existingId: "BOOK2-REJECTED-001", reason: "Changes the action and several relationship words." },
  { id: "TESTED-REJECTED-002", source: "Tôi muốn chơi với bạn.", canonical: "Con muốn chơi với bạn", sampleCount: 3, sourceRefs: ["Trang tính1!A3:B3", "Trang tính1!A4:B4", "Trang tính1!A18:B18"], existingId: "BOOK1-REJECTED-001", reason: "Rewrites a valid speaker role." },
  { id: "TESTED-REJECTED-003", source: "Cảm ơn ông nữ", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRefs: ["Trang tính1!A8:B8"], existingId: "BOOK2-REJECTED-002", reason: "Replaces a plausible thank-you utterance and relationship word with a different intent." },
  { id: "TESTED-REJECTED-004", source: "Cảm ơn ông lưu", canonical: "Con muốn uống nước.", sampleCount: 1, sourceRefs: ["Trang tính1!A10:B10"], existingId: "BOOK2-REJECTED-008", reason: "Replaces a plausible thank-you utterance and relationship word with a different intent." },
  { id: "TESTED-REJECTED-005", source: "con gọi là bác", canonical: "Con gọi là bắp", sampleCount: 1, sourceRefs: ["Trang tính1!A11:B11"], existingId: "BOOK2-REJECTED-009", reason: "Changes a protected relationship word and conflicts with the earlier workbook label for the same source." },
  { id: "TESTED-REJECTED-006", source: "Chú nói chẳng là ai?", canonical: "Chú nói chậm lại", sampleCount: 1, sourceRefs: ["Trang tính1!A12:B12"], existingId: "BOOK2-REJECTED-011", reason: "Removes negation and replaces a plausible question with a request." },
  { id: "TESTED-REJECTED-007", source: "Cô muốn chơi với bạn", canonical: "Con muốn chơi với bạn.", sampleCount: 1, sourceRefs: ["Trang tính1!A14:B14"], existingId: "BOOK2-REJECTED-012", reason: "Rewrites a valid protected speaker role." },
  { id: "TESTED-REJECTED-008", source: "khi con 4 tuổi", canonical: "Con 4 tuổi", sampleCount: 1, sourceRefs: ["Trang tính1!A15:B15"], existingId: "BOOK2-REJECTED-013", reason: "Changes a valid time clause into a present-age statement." },
  { id: "TESTED-REJECTED-009", source: "Không muốn đi chơi với bạn", canonical: "Con muốn đi chơi với bạn", sampleCount: 1, sourceRefs: ["Trang tính1!A16:B16"], existingId: "BOOK2-REJECTED-014", reason: "Removes explicit negation and reverses meaning." },
  { id: "TESTED-REJECTED-010", source: "Cảm ơn giúp", canonical: "Mẹ ơi con cần giúp", sampleCount: 1, sourceRefs: ["Trang tính1!A17:B17"], existingId: "BOOK2-REJECTED-015", reason: "Replaces the whole utterance with a different intent and relationship word." },
  { id: "TESTED-REJECTED-011", source: "Công công hiểu.", canonical: "Con không hiểu", sampleCount: 1, sourceRefs: ["Trang tính1!A19:B19"], existingId: "BOOK2-REJECTED-016", reason: "Adds negation and can reverse meaning." },
  { id: "TESTED-REJECTED-012", source: "Tôi muốn ăn kì", canonical: "Con muốn ăn thịt", sampleCount: 1, sourceRefs: ["Trang tính2!A7:B7"], reason: "Rewrites a valid speaker role and an ambiguous food word." },
  { id: "TESTED-REJECTED-013", source: "Không muốn ăn đâu", canonical: "Con muốn ăn rau", sampleCount: 1, sourceRefs: ["Trang tính2!A9:B9"], reason: "Removes explicit negation and changes the food object." },
  { id: "TESTED-REJECTED-014", source: "con muốn ăn mỡ", canonical: "Con muốn ăn ổi", sampleCount: 1, sourceRefs: ["Trang tính2!A17:B17"], reason: "Both food words are valid and have different meanings." },
]);

const aliasByExactTranscript = new Map<string, ReviewedTestedAudioAlias>();
for (const alias of reviewedTestedAudioAliasesV1) {
  const sourceKey = normalizeVietnameseForExactMatch(alias.source);
  const canonicalKey = normalizeVietnameseForExactMatch(alias.canonical);
  if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) {
    throw new Error(`Invalid reviewed tested-audio alias: ${alias.id}`);
  }
  const existing = aliasByExactTranscript.get(sourceKey);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !== canonicalKey
  ) {
    throw new Error(
      `Conflicting reviewed tested-audio alias: ${existing.id}/${alias.id}`,
    );
  }
  aliasByExactTranscript.set(sourceKey, Object.freeze({ ...alias }));
}

export const reviewedTestedAudioAliasStats = Object.freeze({
  sourceWorkbook: "Đã test audio.xlsx",
  sourceSheets: ["Trang tính1", "Trang tính2"] as const,
  sourceRowCount: 72,
  uniqueSourceCount: 62,
  activeAliasCount: aliasByExactTranscript.size,
  activeRowCount: reviewedTestedAudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  existingEvidenceCount: existingTestedAudioEvidenceV1.length,
  existingEvidenceRowCount: existingTestedAudioEvidenceV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
  rejectedAliasCount: rejectedTestedAudioAliasesV1.length,
  rejectedRowCount: rejectedTestedAudioAliasesV1.reduce(
    (total, alias) => total + alias.sampleCount,
    0,
  ),
});

export function findReviewedTestedAudioAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") return null;
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
