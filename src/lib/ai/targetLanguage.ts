import { AppError } from "@/lib/appError";
import type {
  ConversationLanguage,
  SourceLanguage,
  TargetLanguage,
} from "@/types/conversation";

export const conversationLanguages: readonly ConversationLanguage[] = [
  "vi", "en", "zh", "ja", "ko", "fr",
];

function isConversationLanguage(value: unknown): value is ConversationLanguage {
  return typeof value === "string" &&
    (conversationLanguages as readonly string[]).includes(value);
}

/** Older apps send no targetLanguage; they expect English. */
export function parseTargetLanguage(value: unknown): TargetLanguage {
  if (value === undefined || value === null || value === "") return "en";
  if (isConversationLanguage(value)) return value;
  throw new AppError("BAD_REQUEST", "Ngôn ngữ dịch không được hỗ trợ.", 400,
    { reason: "unsupported_target_language" });
}

/** Older apps send no sourceLanguage; they always record Vietnamese. */
export function parseSourceLanguage(value: unknown): SourceLanguage {
  if (value === undefined || value === null || value === "") return "vi";
  if (isConversationLanguage(value)) return value;
  throw new AppError("BAD_REQUEST", "Ngôn ngữ nguồn không được hỗ trợ.", 400,
    { reason: "unsupported_source_language" });
}

export type LanguagePair = {
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
};

export function parseLanguagePair(source: unknown, target: unknown): LanguagePair {
  const pair = {
    sourceLanguage: parseSourceLanguage(source),
    targetLanguage: parseTargetLanguage(target),
  };
  if (pair.sourceLanguage === pair.targetLanguage) {
    throw new AppError("BAD_REQUEST", "Ngôn ngữ nguồn và đích phải khác nhau.", 400,
      { reason: "same_source_and_target_language" });
  }
  return pair;
}

/**
 * The original Vietnamese → English path owns the rule engine, caches,
 * prefetch/preview and feedback learning. Records written before
 * multilingual pairs have no language fields and belong to that path.
 */
export function isVietnameseToEnglish(pair: {
  sourceLanguage?: SourceLanguage | null;
  targetLanguage?: TargetLanguage | null;
}) {
  return (pair.sourceLanguage ?? "vi") === "vi" &&
    (pair.targetLanguage ?? "en") === "en";
}

/**
 * Fills the language fields on results/history written by the Vietnamese →
 * English pipeline or before multilingual pairs. Stored records are never
 * rewritten; this only shapes what is returned.
 */
export function withConversationLanguageFields<T extends {
  vietnameseText: string;
  englishText: string;
  sourceLanguage?: SourceLanguage;
  sourceText?: string;
  targetLanguage?: TargetLanguage;
  translatedText?: string;
}>(result: T): T {
  const sourceLanguage = result.sourceLanguage ?? "vi";
  const targetLanguage = result.targetLanguage ?? "en";
  return {
    ...result,
    sourceLanguage,
    sourceText: result.sourceText ?? (sourceLanguage === "vi" ? result.vietnameseText : ""),
    targetLanguage,
    // Admin corrections update englishText only, so English targets read it.
    translatedText: targetLanguage === "en"
      ? result.englishText || result.translatedText || ""
      : result.translatedText ?? "",
  };
}
