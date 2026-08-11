export function normalizeVietnameseStandardSentence(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("vi-VN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVietnameseStandardSentences(value: string) {
  const sentences: string[] = [];
  const normalizedSentences = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const sentence = line.trim();
    const normalized = normalizeVietnameseStandardSentence(sentence);
    if (!normalized || normalizedSentences.has(normalized)) continue;

    normalizedSentences.add(normalized);
    sentences.push(sentence);
  }

  return sentences;
}

export function findVietnameseStandardSentenceMatch(
  recognizedText: string,
  standardSentences: readonly string[],
) {
  const normalizedRecognizedText =
    normalizeVietnameseStandardSentence(recognizedText);
  if (!normalizedRecognizedText) return null;

  return (
    standardSentences.find(
      (sentence) =>
        normalizeVietnameseStandardSentence(sentence) ===
        normalizedRecognizedText,
    ) ?? null
  );
}
