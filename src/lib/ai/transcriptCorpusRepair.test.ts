import assert from "node:assert/strict";
import test from "node:test";
import {
  findReviewedAsrRuleMatch,
  normalizeVietnameseForExactMatch,
} from "./exactRules";
import {
  buildReviewedRegionalAliases,
  excludedRegionalVocabularyV1,
  reviewedRegionalVocabularyV1,
} from "./regionalVocabulary";
import {
  observedChildSpeechAliases,
  observedChildSpeechAliasRuntimeStats,
} from "./observedChildSpeechAliases";
import {
  existingBook1AudioEvidenceV1,
  rejectedBook1AudioAliasesV1,
  reviewedBook1AudioAliasesV1,
  reviewedBook1AudioAliasStats,
} from "./reviewedBook1AudioAliases";
import {
  existingBook2AudioEvidenceV1,
  rejectedBook2AudioAliasesV1,
  reviewedBook2AudioAliasesV1,
  reviewedBook2AudioAliasStats,
} from "./reviewedBook2AudioAliases";
import {
  rejectedReviewedLegacyAudioAliasesV1,
  reviewedLegacyAudioAliasesV1,
  reviewedLegacyAudioAliasStats,
  supersededReviewedLegacyAudioAliasesV1,
} from "./reviewedLegacyAudioAliases";
import {
  regionalChildSpeechRulesV1,
  regionalCorpusMatchRulesV1,
  regionalCorpusRulesV1,
  regionalCorpusRuntimeStats,
  repairVietnameseTranscriptWithCorpus,
} from "./transcriptCorpusRepair";

test("regional rollout contains exactly 100 reviewed child sentences", () => {
  assert.equal(regionalChildSpeechRulesV1.length, 100);
  assert.equal(new Set(regionalChildSpeechRulesV1.map((rule) => rule.id)).size, 100);
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "V1-CHILD-001"));
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "AIV0-0099"));
});

test("regional workbook rollout keeps only reviewed, context-safe entries", () => {
  assert.equal(reviewedRegionalVocabularyV1.length, 141);
  assert.equal(excludedRegionalVocabularyV1.length, 6);
  assert.equal(
    new Set(reviewedRegionalVocabularyV1.map((entry) => entry.sourceRow)).size,
    141,
  );
});

test("regional exact-alias rollout covers the complete official corpus", () => {
  assert.equal(regionalCorpusRulesV1.length, 5_000);
  assert.equal(regionalCorpusMatchRulesV1.length, 4_913);
  assert.equal(regionalCorpusRuntimeStats.sourceRuleCount, 5_000);
  assert.equal(regionalCorpusRuntimeStats.uniqueCanonicalCount, 4_913);
  assert.ok(regionalCorpusRuntimeStats.exactAliasCount > 10_000);
  assert.ok(regionalCorpusRuntimeStats.foldedAliasCount > 10_000);
});

test("loads only unambiguous reviewed child-speech sentence aliases", () => {
  assert.equal(observedChildSpeechAliasRuntimeStats.generatedFromRows, 1_573);
  assert.equal(observedChildSpeechAliasRuntimeStats.aliasCount, 1_190);
  assert.equal(observedChildSpeechAliasRuntimeStats.ambiguousSourceCount, 16);
  assert.equal(observedChildSpeechAliasRuntimeStats.noOpSourceCount, 5);
  assert.equal(observedChildSpeechAliasRuntimeStats.negationMismatchSourceCount, 11);
  assert.equal(
    observedChildSpeechAliasRuntimeStats.protectedRoleMismatchSourceCount,
    78,
  );
  assert.equal(observedChildSpeechAliasRuntimeStats.personalNameSourceCount, 14);
  assert.equal(
    observedChildSpeechAliasRuntimeStats.duplicateOrExistingSourceCount,
    131,
  );
  assert.equal(
    observedChildSpeechAliases.filter((alias) =>
      alias.id.startsWith("CHILD-ASR-V2-"),
    ).length,
    390,
  );
  assert.equal(
    new Set(observedChildSpeechAliases.map((alias) => alias.id)).size,
    observedChildSpeechAliases.length,
  );
  assert.ok(observedChildSpeechAliasRuntimeStats.foldedAliasCount > 1_000);
  assert.ok(
    observedChildSpeechAliasRuntimeStats.ambiguousFoldedAliasCount > 0,
  );
});

test("repairs every reviewed legacy-audio transcript with exact-only aliases", () => {
  assert.equal(reviewedLegacyAudioAliasStats.sourceRowCount, 37);
  assert.equal(reviewedLegacyAudioAliasStats.generatedFromRows, 35);
  assert.equal(reviewedLegacyAudioAliasStats.aliasCount, 30);
  assert.equal(reviewedLegacyAudioAliasesV1.length, 30);
  assert.equal(reviewedLegacyAudioAliasStats.rejectedAliasCount, 0);
  assert.equal(reviewedLegacyAudioAliasStats.rejectedRowCount, 0);
  assert.equal(rejectedReviewedLegacyAudioAliasesV1.length, 0);
  assert.equal(reviewedLegacyAudioAliasStats.supersededAliasCount, 1);
  assert.equal(reviewedLegacyAudioAliasStats.supersededRowCount, 2);
  assert.equal(supersededReviewedLegacyAudioAliasesV1.length, 1);

  for (const alias of reviewedLegacyAudioAliasesV1) {
    const repaired = repairVietnameseTranscriptWithCorpus(alias.source);
    assert.equal(
      normalizeVietnameseForExactMatch(repaired.text),
      normalizeVietnameseForExactMatch(alias.canonical),
      alias.id,
    );
    assert.equal(repaired.strategy, "reviewed_legacy_audio_alias", alias.id);
    assert.equal(repaired.correctionId, alias.id, alias.id);
  }
});

test("records the legacy decision superseded by the Book1 review", () => {
  assert.equal(supersededReviewedLegacyAudioAliasesV1[0]?.id, "LEGACY-AUDIO-010");
  assert.equal(
    supersededReviewedLegacyAudioAliasesV1[0]?.supersededBy,
    "BOOK1-AUDIO-001",
  );
});

test("Book1 promotes only the reviewed content-safe exact alias", () => {
  assert.equal(reviewedBook1AudioAliasStats.sourceRowCount, 9);
  assert.equal(reviewedBook1AudioAliasStats.uniqueSourceCount, 5);
  assert.equal(reviewedBook1AudioAliasStats.activeAliasCount, 1);
  assert.equal(reviewedBook1AudioAliasStats.activeRowCount, 2);
  assert.equal(reviewedBook1AudioAliasStats.existingEvidenceCount, 1);
  assert.equal(reviewedBook1AudioAliasStats.existingEvidenceRowCount, 2);
  assert.equal(reviewedBook1AudioAliasStats.rejectedAliasCount, 3);
  assert.equal(reviewedBook1AudioAliasStats.rejectedRowCount, 5);
  assert.equal(reviewedBook1AudioAliasesV1.length, 1);
  assert.equal(existingBook1AudioEvidenceV1.length, 1);
  assert.equal(rejectedBook1AudioAliasesV1.length, 3);

  const repaired = repairVietnameseTranscriptWithCorpus(
    "Còn có một quà báo?",
  );
  assert.equal(
    normalizeVietnameseForExactMatch(repaired.text),
    normalizeVietnameseForExactMatch("Con có một quả bóng"),
  );
  assert.equal(repaired.strategy, "reviewed_book1_audio_alias");
  assert.equal(repaired.correctionId, "BOOK1-AUDIO-001");
});

test("Book1 retains duplicate evidence without replacing the existing alias", () => {
  const repaired = repairVietnameseTranscriptWithCorpus("Con ơn đi chơi");
  assert.equal(repaired.text, "Con muốn đi chơi.");
  assert.equal(repaired.strategy, "reviewed_legacy_audio_alias");
  assert.equal(repaired.correctionId, "LEGACY-AUDIO-011");
});

test("Book1 does not rewrite valid speaker roles or relationships", () => {
  for (const alias of rejectedBook1AudioAliasesV1) {
    const repaired = repairVietnameseTranscriptWithCorpus(alias.source);
    assert.equal(repaired.text, alias.source, alias.id);
    assert.equal(repaired.repaired, false, alias.id);
    assert.notEqual(repaired.strategy, "reviewed_book1_audio_alias", alias.id);
    assert.equal(repaired.correctionId, undefined, alias.id);
  }
});

test("Book2 loads every reviewed exact alias and preserves its audit totals", () => {
  assert.equal(reviewedBook2AudioAliasStats.sourceRowCount, 64);
  assert.equal(reviewedBook2AudioAliasStats.uniqueSourceCount, 56);
  assert.equal(reviewedBook2AudioAliasStats.activeAliasCount, 38);
  assert.equal(reviewedBook2AudioAliasStats.activeRowCount, 43);
  assert.equal(reviewedBook2AudioAliasStats.existingEvidenceCount, 2);
  assert.equal(reviewedBook2AudioAliasStats.existingEvidenceRowCount, 5);
  assert.equal(reviewedBook2AudioAliasStats.rejectedAliasCount, 16);
  assert.equal(reviewedBook2AudioAliasStats.rejectedRowCount, 16);
  assert.equal(reviewedBook2AudioAliasesV1.length, 38);
  assert.equal(existingBook2AudioEvidenceV1.length, 2);
  assert.equal(rejectedBook2AudioAliasesV1.length, 16);

  for (const alias of reviewedBook2AudioAliasesV1) {
    const repaired = repairVietnameseTranscriptWithCorpus(alias.source);
    assert.equal(
      normalizeVietnameseForExactMatch(repaired.text),
      normalizeVietnameseForExactMatch(alias.canonical),
      alias.id,
    );
    assert.equal(repaired.strategy, "reviewed_book2_audio_alias", alias.id);
    assert.equal(repaired.correctionId, alias.id, alias.id);
  }
});

test("Book2 keeps existing active and rejected decisions unchanged", () => {
  const existingActive = repairVietnameseTranscriptWithCorpus(
    existingBook2AudioEvidenceV1[0]!.source,
  );
  assert.equal(existingActive.correctionId, "LEGACY-AUDIO-011");
  assert.equal(existingActive.strategy, "reviewed_legacy_audio_alias");

  const existingRejected = repairVietnameseTranscriptWithCorpus(
    existingBook2AudioEvidenceV1[1]!.source,
  );
  assert.equal(existingRejected.repaired, false);
  assert.equal(existingRejected.correctionId, undefined);
});

test("Book2 never loads rejected meaning, negation or role changes", () => {
  for (const alias of rejectedBook2AudioAliasesV1) {
    const repaired = repairVietnameseTranscriptWithCorpus(alias.source);
    assert.equal(repaired.text, alias.source, alias.id);
    assert.equal(repaired.repaired, false, alias.id);
    assert.notEqual(repaired.strategy, "reviewed_book2_audio_alias", alias.id);
    assert.equal(repaired.correctionId, undefined, alias.id);
  }
});

test("Book2 exact aliases do not expand to longer or accent-folded sentences", () => {
  for (const source of [
    "Con thái con mẹ hôm nay",
    "Con muon trao voi bon",
    "Câu mũi ngớp lạnh",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(repaired.strategy, "reviewed_book2_audio_alias", source);
  }
});

test("legacy-audio aliases never expand through fuzzy or accent-folded matching", () => {
  for (const source of [
    "Con thịt ăn cơm hôm nay",
    "Tao muốn uống nước lạnh",
    "Con không thể không đi",
    "Anh ta là bé Mây thật",
    "Con ten la Be May",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(
      repaired.strategy,
      "reviewed_legacy_audio_alias",
      source,
    );
  }
});

test("legacy-audio aliases allow only an equivalent final politeness particle", () => {
  for (const source of [
    "Cô chú nó chậm lại nha",
    "Cô chú nó chậm lại nhá.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, "Cô chú nói chậm lại nhé", source);
    assert.equal(repaired.correctionId, "LEGACY-AUDIO-030", source);
    assert.equal(repaired.strategy, "reviewed_legacy_audio_alias", source);
  }

  for (const source of [
    "Cô chú không chậm lại nha",
    "Cô chú nó nói chậm lại nha",
    "Cảm ơn tôi với bạn nha",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(repaired.strategy, "reviewed_legacy_audio_alias", source);
  }
});

test("keeps negation and protected speaker roles unchanged in every V2 alias", () => {
  const negationTokens = new Set(["không", "chưa", "chẳng"]);
  const protectedRoleTokens = new Set([
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
  ]);
  const selectedTokens = (text: string, allowed: Set<string>) =>
    normalizeVietnameseForExactMatch(text)
      .split(" ")
      .filter((token) => allowed.has(token))
      .sort();

  for (const alias of observedChildSpeechAliases.filter((entry) =>
    entry.id.startsWith("CHILD-ASR-V2-"),
  )) {
    assert.deepEqual(
      selectedTokens(alias.source, negationTokens),
      selectedTokens(alias.canonical, negationTokens),
      alias.id,
    );
    assert.deepEqual(
      selectedTokens(alias.source, protectedRoleTokens),
      selectedTokens(alias.canonical, protectedRoleTokens),
      alias.id,
    );
  }
});

test("prefers reviewed child observations over broad accent-folded rules", () => {
  const cases = new Map([
    ["Con muốn ăn áo.", "Con muốn ăn táo."],
    ["Con muốn ăn côm.", "Con muốn ăn tôm."],
    ["Con thấy con èo.", "Con thấy con mèo."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_child_alias", source);
    assert.match(repaired.correctionId ?? "", /^CHILD-ASR-V1-[A-F0-9]{12}$/);
  }
});

test("does not auto-correct ambiguous or meaning-reversing workbook rows", () => {
  for (const source of [
    "Đây là cái báy.",
    "Con lấy cái báy.",
    "Không muốn nghe lại",
    "Anh không hiểu",
    "Con tên là bé My",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(repaired.strategy, "observed_child_alias", source);
    assert.equal(repaired.correctionId, undefined, source);
  }
});

test("does not fuzzy-match unrelated whole-sentence extensions", () => {
  const repaired = repairVietnameseTranscriptWithCorpus(
    "Con muốn ăn áo hôm nay.",
  );
  assert.notEqual(repaired.strategy, "observed_child_alias");
  assert.equal(repaired.correctionId, undefined);
});

test("repairs an unambiguous observed child alias when ASR drops accents", () => {
  const repaired = repairVietnameseTranscriptWithCorpus("Con hat nuoc.");
  assert.equal(repaired.text, "Con khát nước.");
  assert.equal(repaired.strategy, "observed_child_folded");
  assert.match(repaired.correctionId ?? "", /^CHILD-ASR-V2-[A-F0-9]{12}$/);
});

test("fuzzy-matches reviewed child aliases with one optional particle", () => {
  const cases = new Map([
    ["Con hát nước ạ.", "Con khát nước."],
    ["Con muốn dửa tay ạ.", "Con muốn rửa tay."],
    ["Món này non quá ạ.", "Món này ngon quá."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_child_fuzzy", source);
    assert.ok((repaired.score ?? 0) >= 0.875, source);
    assert.ok((repaired.margin ?? 0) >= 0.1, source);
  }
});

test("controlled child fuzzy matching preserves meaning-bearing words", () => {
  for (const source of [
    "Con không hát nước.",
    "Bố hát nước ạ.",
    "Con hát một bài.",
    "Con có một quả báo?",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, source);
    assert.equal(repaired.repaired, false);
    assert.notEqual(repaired.strategy, "observed_child_fuzzy");
    assert.notEqual(repaired.strategy, "observed_child_folded");
  }
});

test("repairs only the safe new exact aliases from the second child dataset", () => {
  const cases = new Map([
    ["Con hát nước.", "Con khát nước."],
    ["Con muốn dửa tay.", "Con muốn rửa tay."],
    ["Món này non quá.", "Món này ngon quá."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_child_alias", source);
    assert.match(repaired.correctionId ?? "", /^CHILD-ASR-V2-[A-F0-9]{12}$/);
  }
});

test("does not load duplicate, negation, role or conflicting rows from the second dataset", () => {
  for (const source of [
    "Công công hiểu.",
    "Con chào pố.",
    "Con muốn chơi với bác.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(repaired.strategy, "observed_child_alias", source);
    assert.equal(repaired.correctionId, undefined, source);
  }
});

test("repairs the three confirmed noisy recordings of the water request", () => {
  for (const source of [
    "Góng múng ung sốt.",
    "Còn muốn ôm sợ?",
    "Còn mong ung sơ?",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, "Con muốn uống nước.", source);
    assert.equal(repaired.strategy, "observed_child_alias", source);
    assert.match(repaired.correctionId ?? "", /^CHILD-ASR-V1-[A-F0-9]{12}$/);
  }
});

test("all 100 rollout sentences recover from missing Vietnamese diacritics", () => {
  for (const rule of regionalChildSpeechRulesV1) {
    const withoutDiacritics = rule.vietnamese
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/đ/giu, (letter) => (letter === "Đ" ? "D" : "d"));
    const repaired = repairVietnameseTranscriptWithCorpus(withoutDiacritics);
    assert.equal(repaired.text, rule.vietnamese, rule.id);
    assert.equal(repaired.ruleId, rule.id, rule.id);
  }
});

test("repairs observed happy-sentence variants to one canonical rule", () => {
  for (const source of [
    "Hom nay con rat vui",
    "Hôm nay con zất vui.",
    "Hôm nay con dất vui.",
    "Hôm nay con gất vui.",
    "Hôm nay con gấc vui.",
    "Hôm nay còn rất vui.",
    "Họm này cũng rất vui.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, "Hôm nay con rất vui.", source);
    assert.equal(repaired.ruleId, "V1-CHILD-001", source);
    assert.equal(
      findReviewedAsrRuleMatch(repaired.text)?.rule.english,
      "Today, I'm very happy.",
      source,
    );
  }
});

test("repairs common regional and child-pronunciation substitutions", () => {
  const cases = new Map([
    ["Con mún uống nước.", "Con muốn uống nước."],
    ["Con nàm đổ nước rồi.", "Con làm đổ nước rồi."],
    ["Con xợ quá.", "Con sợ quá."],
    ["Con muốn chơi cầu chượt.", "Con muốn chơi cầu trượt."],
  ]);

  for (const [source, expected] of cases) {
    assert.equal(repairVietnameseTranscriptWithCorpus(source).text, expected);
  }
});

test("repairs observed Cloudflare child-speech errors without broad fuzzy matching", () => {
  const cases = new Map([
    ["Công mũ xem phim hòa cân", "Con muốn xem phim hoạt hình."],
    ["à con muốn xem phim hoặc hình", "Con muốn xem phim hoạt hình."],
    ["Con bị vẹn rồi", "Con mệt rồi."],
    ["Còn muốn đi sở thủ xìm càng hổ", "Con muốn đi sở thú xem con hổ."],
    ["Con học lớp xấu rồi", "Con học lớp sáu rồi."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_asr_alias", source);
  }
});

test("repairs reviewed North, Central, and South whole-sentence aliases", () => {
  const cases = new Map([
    ["Bữa ni con rất bui.", "Hôm nay con rất vui."],
    ["Con mần đổ nác rầu.", "Con làm đổ nước rồi."],
    ["Má giùm con mặc áo nha.", "Mẹ giúp con mặc áo nhé."],
    ["Con muốn đi cầu.", "Con muốn đi vệ sinh."],
    ["Con cần một cây viết chì.", "Con cần một cây bút chì."],
    ["Con đếm được năm trái banh.", "Con đếm được năm quả bóng."],
    [
      "Con kiếm hổng ra đôi vớ của con.",
      "Con không tìm thấy đôi tất của con.",
    ],
    ["Con nỏ ưng món ni.", "Con không thích món này."],
    ["Con tự cột dây giày được.", "Con tự buộc dây giày được."],
    ["Con chùi bàn được hông?", "Con lau bàn được không?"],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "regional_alias", source);
  }
});

test("repairs regional aliases from every 500-row corpus batch", () => {
  const cases = new Map([
    ["Con bị đau ở ni.", "Con bị đau ở đây."],
    ["Con muốn ăn một trái chuối.", "Con muốn ăn một quả chuối."],
    [
      "Lát nựa, con sẽ ăn một trái chuối.",
      "Lát nữa, con sẽ ăn một quả chuối.",
    ],
    [
      "Sau nớ, con sẽ ăn một trái chuối.",
      "Sau đó, con sẽ ăn một quả chuối.",
    ],
    ["Bữa ni, con muốn chọn áo đặng mặc.", "Hôm nay, con muốn chọn áo để mặc."],
    ["Sau nớ, con sẽ chùi khô tay.", "Sau đó, con sẽ lau khô tay."],
    ["Con muốn kêu má khi cần.", "Con muốn gọi mẹ khi cần."],
    ["Con thường kêu mạ khi cần.", "Con thường gọi mẹ khi cần."],
    ["Con muốn uống nác khi khát.", "Con muốn uống nước khi khát."],
    [
      "Ở nhà, con thường uống nác khi khát.",
      "Ở nhà, con thường uống nước khi khát.",
    ],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "regional_alias", source);
  }
});

test("every unambiguous generated regional alias returns its corpus sentence", () => {
  const canonicalByVietnamese = new Map(
    regionalCorpusMatchRulesV1.map((rule) => [
      normalizeVietnameseForExactMatch(rule.vietnamese),
      rule,
    ]),
  );
  let checkedAliases = 0;

  for (const rule of regionalCorpusMatchRulesV1) {
    for (const alias of buildReviewedRegionalAliases(rule.vietnamese)) {
      const canonicalCollision = canonicalByVietnamese.get(
        normalizeVietnameseForExactMatch(alias),
      );
      if (canonicalCollision && canonicalCollision.id !== rule.id) continue;

      const repaired = repairVietnameseTranscriptWithCorpus(alias);
      assert.equal(repaired.text, rule.vietnamese, `${rule.id}: ${alias}`);
      checkedAliases += 1;
    }
  }

  assert.equal(
    regionalCorpusRuntimeStats.exactAliasCount - checkedAliases,
    buildReviewedRegionalAliases("Hôm nay con rất vui.").length,
  );
});

test("does not create context-invalid workbook aliases", () => {
  const cases = [
    ["Theo mình, nhóm nên dùng hình ảnh này.", "hình hình"],
    ["Con sẽ sắp xếp để không ảnh hưởng việc học.", "hình hưởng"],
    ["Con quên mang hộp bút.", "hộp cây viết"],
    ["Con muốn cất đồ chơi.", "đồ nhởi"],
    ["Mình đang học về cách giảm ô nhiễm.", "dù nhiễm"],
    ["Con nghe thấy tiếng chuông.", "nghe chộ"],
    ["Mình rẽ trái ở ngã tư nhé.", "rẽ trấy"],
    ["Con học về lời nói lịch sự.", "học dìa"],
    ["Con muốn tham gia câu lạc bộ.", "đậu phộng"],
    ["Cô cho em xem lại ví dụ được không ạ?", "bóp dụ"],
    ["Con muốn chơi xích đu.", "sên đu"],
    ["Trong lớp, em muốn đọc to câu trả lời.", "đọc bự"],
  ] as const;

  for (const [canonical, invalidFragment] of cases) {
    assert.ok(
      buildReviewedRegionalAliases(canonical).every(
        (alias) => !alias.includes(invalidFragment),
      ),
      `${canonical} -> ${invalidFragment}`,
    );
  }
});

test("does not force unrelated, negated, or legitimate sentences into corpus", () => {
  for (const source of [
    "Con thích quả gấc.",
    "Hôm nay con rất buồn.",
    "Con không muốn ăn cơm.",
    "Bố muốn uống cà phê.",
    "Bữa ni mẹ rất buồn.",
    "Con khoái quả gấc.",
    "Cô o ơi.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, source);
    assert.equal(repaired.repaired, false);
  }
});
