const contractions: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bi['’]m\b/g, "i am"],
  [/\byou['’]re\b/g, "you are"],
  [/\bhe['’]s\b/g, "he is"],
  [/\bshe['’]s\b/g, "she is"],
  [/\bit['’]s\b/g, "it is"],
  [/\bwe['’]re\b/g, "we are"],
  [/\bthey['’]re\b/g, "they are"],
  [/\bcan['’]t\b/g, "cannot"],
  [/\bdon['’]t\b/g, "do not"],
  [/\bdoesn['’]t\b/g, "does not"],
  [/\bisn['’]t\b/g, "is not"],
  [/\baren['’]t\b/g, "are not"],
];

// English ASR commonly spells the Vietnamese name "An" as the homophones
// "Ann" or "Anne". They represent the same spoken lesson word and must not
// make a child fail an otherwise exact sentence.
const spokenWordAliases: Readonly<Record<string, string>> = {
  ann: "an",
  anne: "an",
  // Observed with the production Whisper model for a child saying "I'm An".
  // This is safe only in the English lesson matcher; the lesson corpus does
  // not use the prayer word "amen" as a target sentence.
  amen: "i am an",
};

export function normalizeLessonEnglish(value: string) {
  let normalized = value.normalize("NFKC").trim().toLowerCase();
  for (const [pattern, replacement] of contractions) {
    normalized = normalized.replace(pattern, replacement);
  }
  const words = normalized
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => spokenWordAliases[word] ?? word);
  return words.join(" ");
}

/**
 * Content-only lesson check. Intonation, pitch and pronunciation scores are
 * deliberately excluded: if English ASR hears the target words, the child
 * passes the sentence.
 */
export function matchesLessonEnglish(
  expectedEnglish: string,
  transcript: string,
) {
  const expected = normalizeLessonEnglish(expectedEnglish);
  const recognized = normalizeLessonEnglish(transcript);
  return expected.length > 0 && recognized === expected;
}
