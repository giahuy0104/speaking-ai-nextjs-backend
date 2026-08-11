import assert from "node:assert/strict";
import test from "node:test";
import {
  findVietnameseStandardSentenceMatch,
  normalizeVietnameseStandardSentence,
  parseVietnameseStandardSentences,
} from "./standardSentenceMatching";

test("normalizes casing, punctuation, whitespace and Unicode composition", () => {
  assert.equal(
    normalizeVietnameseStandardSentence("  CON tên là Bé Mây!!! "),
    "con tên là bé mây",
  );
});

test("parses one standard sentence per line and removes normalized duplicates", () => {
  assert.deepEqual(
    parseVietnameseStandardSentences(
      "Con tên là Bé Mây.\n\ncon tên là bé mây\nCon yêu mẹ",
    ),
    ["Con tên là Bé Mây.", "Con yêu mẹ"],
  );
});

test("matches a recognized sentence while preserving Vietnamese diacritics", () => {
  const standards = ["Con tên là Bé Mây.", "Con yêu mẹ"];

  assert.equal(
    findVietnameseStandardSentenceMatch("con tên là bé mây", standards),
    "Con tên là Bé Mây.",
  );
  assert.equal(
    findVietnameseStandardSentenceMatch("Con ten la Be May", standards),
    null,
  );
});
