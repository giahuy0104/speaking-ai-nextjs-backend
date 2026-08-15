import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesLessonEnglish,
  normalizeLessonEnglish,
} from "./lessonAttemptMatcher";

test("accepts the target words without scoring intonation", () => {
  assert.equal(matchesLessonEnglish("I'm An", "I'm An."), true);
  assert.equal(matchesLessonEnglish("I'm An", "I am An"), true);
  assert.equal(matchesLessonEnglish("HELLO!", "hello"), true);
});

test("accepts ASR homophone spellings of the Vietnamese name An", () => {
  assert.equal(matchesLessonEnglish("I'm An", "I'm Ann"), true);
  assert.equal(matchesLessonEnglish("I'm An", "I'm Anne"), true);
  assert.equal(
    matchesLessonEnglish("Hello, I’m An.", "Hello, I'm Anne."),
    true,
  );
  assert.equal(matchesLessonEnglish("I'm An", "Amen."), true);
  assert.equal(matchesLessonEnglish("Hello, I’m An.", "Hello, amen."), true);
});

test("rejects speech whose content is not the lesson sentence", () => {
  assert.equal(matchesLessonEnglish("I'm An", "Con muốn ăn cơm"), false);
  assert.equal(matchesLessonEnglish("I'm An", "I want to eat rice"), false);
  assert.equal(matchesLessonEnglish("This is my bag", "This is my book"), false);
});

test("normalizes curly English contractions", () => {
  assert.equal(normalizeLessonEnglish("I’m An"), "i am an");
});
