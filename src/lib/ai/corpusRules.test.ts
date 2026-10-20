import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { reviewedCorpusRulesV1 } from "./corpusRules";
import {
  findReviewedCorpusRule,
  findReviewedExactRule,
  normalizeVietnameseForExactMatch,
  reviewedAllTranslationRulesV1,
  reviewedCorpusTranslationRulesV1,
  reviewedSpecialExactRulesV1,
} from "./exactRules";

test("AIV0 V1 imports all 5,000 complete reviewed rules", () => {
  assert.equal(reviewedCorpusRulesV1.length, 5_000);
  assert.equal(reviewedCorpusRulesV1[0]?.id, "AIV0-0001");
  assert.equal(reviewedCorpusRulesV1[499]?.id, "AIV0-0500");
  assert.equal(reviewedCorpusRulesV1[500]?.id, "AIV0-0501");
  assert.equal(reviewedCorpusRulesV1[999]?.id, "AIV0-1000");
  assert.equal(reviewedCorpusRulesV1[1_000]?.id, "AIV0-1001");
  assert.equal(reviewedCorpusRulesV1[2_499]?.id, "AIV0-2500");
  assert.equal(reviewedCorpusRulesV1[4_500]?.id, "AIV0-4501");
  assert.equal(reviewedCorpusRulesV1.at(-1)?.id, "AIV0-5000");
  assert.equal(
    new Set(reviewedCorpusRulesV1.map((rule) => rule.id)).size,
    5_000,
  );
  assert.ok(
    reviewedCorpusRulesV1.every(
      (rule) => rule.vietnamese.trim() && rule.english.trim(),
    ),
  );
});

test("AIV0 V1 has no normalized sentence with conflicting English", () => {
  const translations = new Map<string, string>();

  for (const rule of reviewedCorpusRulesV1) {
    const key = normalizeVietnameseForExactMatch(rule.vietnamese);
    const existing = translations.get(key);
    assert.ok(
      !existing || existing === rule.english,
      `Conflicting translation for ${rule.id}`,
    );
    translations.set(key, rule.english);
  }
});

test("first and last AIV0 sentences are active corpus rules", () => {
  assert.equal(
    findReviewedCorpusRule(reviewedCorpusRulesV1[0].vietnamese)?.english,
    reviewedCorpusRulesV1[0].english,
  );
  assert.equal(
    findReviewedCorpusRule(reviewedCorpusRulesV1.at(-1)!.vietnamese)?.english,
    reviewedCorpusRulesV1.at(-1)!.english,
  );
});

test("second AIV0 batch is active and keeps corpus priority", () => {
  assert.equal(
    findReviewedCorpusRule("Con muốn ăn một quả chuối.")?.english,
    "I want to eat a banana.",
  );
  assert.equal(
    findReviewedCorpusRule("Con muốn rửa tay.")?.id,
    "AIV0-0502",
  );
});

test("special exact rules and the 5,000 corpus rows are separate registries", () => {
  assert.equal(reviewedCorpusTranslationRulesV1.length, 5_000);
  assert.ok(reviewedSpecialExactRulesV1.length > 0);
  assert.ok(
    reviewedSpecialExactRulesV1.every((rule) => !rule.id.startsWith("AIV0-")),
  );
  assert.equal(
    reviewedAllTranslationRulesV1.length,
    reviewedSpecialExactRulesV1.length +
      reviewedCorpusTranslationRulesV1.length,
  );
});

test("all 4,000 new corpus translations are active in the corpus layer", () => {

  for (const rule of reviewedCorpusRulesV1.slice(1_000)) {
    assert.equal(
      findReviewedCorpusRule(rule.vietnamese)?.english,
      rule.english,
      `Inactive or changed translation for ${rule.id}`,
    );
  }
});

test("samples at the start, middle and end of every batch use corpus rules", () => {
  for (let start = 1_000; start < 5_000; start += 500) {
    for (const index of [start, start + 249, start + 499]) {
      const rule = reviewedCorpusRulesV1[index];
      assert.ok(rule, `Missing corpus sample at index ${index}`);
      assert.equal(
        findReviewedCorpusRule(rule.vietnamese)?.english,
        rule.english,
        `Inactive smoke-test rule ${rule.id}`,
      );
    }
  }
});

test("runtime keeps exact and corpus as ordered fast-path layers", async () => {
  const corpusOnly = reviewedCorpusRulesV1.at(-1)!;
  assert.equal(findReviewedExactRule(corpusOnly.vietnamese), null);
  assert.equal(
    findReviewedCorpusRule(corpusOnly.vietnamese)?.english,
    corpusOnly.english,
  );

  const llmSource = await readFile(new URL("./llm.ts", import.meta.url), "utf8");
  const exactLookup = llmSource.indexOf("findReviewedExactAsrRuleMatch(");
  const corpusLookup = llmSource.indexOf("findReviewedCorpusRuleMatch(");

  assert.ok(exactLookup >= 0);
  assert.ok(corpusLookup > exactLookup);
  assert.match(llmSource, /source: "phrase_rule"/);
  assert.match(llmSource, /source: "corpus_rule"/);
});
