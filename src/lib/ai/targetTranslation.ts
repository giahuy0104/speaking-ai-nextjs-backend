import type { PracticeContext, SourceLanguage, TargetLanguage } from "@/types/conversation";
import { AppError } from "@/lib/appError";
import { logEvent } from "@/lib/observability";
import {
  CloudflareTextProviderError,
  getCloudflareTextConfig,
  translateVietnameseWithCloudflare,
  type CloudflareTextCompletionMetadata,
} from "./cloudflareText";
import { attachFailureDiagnostics, getFailureDiagnostics } from "./cloudflare/providerError";
import { buildTargetLanguageInstruction } from "./prompts";

type TranslationLanguage = TargetLanguage;
const maxOutputCharacters = 2_000;
const maxCompletionTokens = 512;

export function normalizeTargetTranslation(text: string) {
  let normalized = text.replace(/\s+/gu, " ").trim();
  for (const [open, close] of [["“", "”"], ["「", "」"], ["«", "»"], ['"', '"']]) {
    if (normalized.startsWith(open) && normalized.endsWith(close)) {
      normalized = normalized.slice(open.length, -close.length).trim();
      break;
    }
  }
  return normalized;
}

export function targetTranslationIssue(text: string, language: TranslationLanguage) {
  if (!text) return "empty_response";
  if (text.length > maxOutputCharacters) return "output_too_long";
  if (language === "zh" && !/[\u3400-\u9fff]/u.test(text)) return "missing_target_script";
  if (language === "ja" && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) return "missing_target_script";
  if (language === "ko" && !/[\uac00-\ud7af]/u.test(text)) return "missing_target_script";
  if (language === "en" || language === "fr" || language === "vi") {
    if (/\p{L}/u.test(text) && !/\p{Script=Latin}/u.test(text)) return "missing_target_script";
    // Source characters left untranslated, e.g. "Anh Huy quá帅 rồi".
    if (/[぀-ヿ㐀-鿿가-힯]/u.test(text)) return "untranslated_source_script";
  }
  return undefined;
}

const latinRetryRule = (name: string) =>
  `Your previous answer was not entirely ${name}. Write every word in ${name}; no Chinese, Japanese or Korean characters.`;
const leakRetryRules: Partial<Record<TranslationLanguage, string>> = {
  vi: latinRetryRule("Vietnamese"), en: latinRetryRule("English"), fr: latinRetryRule("French"),
};

function completionIssue(completion: CloudflareTextCompletionMetadata | undefined) {
  return completion?.finishReason === "length" ? "output_truncated"
    : completion?.finishReason === "content_filter" ? "content_filtered"
    : completion?.finishReason === "tool_calls" ? "unexpected_tool_call" : undefined;
}

export async function translateTargetLanguage(input: {
  sourceText: string;
  language: TranslationLanguage;
  /** Defaults to Vietnamese, the original Vietnamese → target path. */
  sourceLanguage?: SourceLanguage;
  context: PracticeContext;
  childAge?: number;
  requestId?: string;
}) {
  const startedAt = performance.now();
  const sourceLanguage = input.sourceLanguage ?? "vi";
  const fields = {
    requestId: input.requestId,
    language: input.language,
    sourceLanguage,
    provider: "cloudflare",
    stage: "text_translation",
    sourceLength: input.sourceText.length,
    maxCompletionTokens,
    maxOutputCharacters,
  };
  let model: string | undefined;
  let completion: CloudflareTextCompletionMetadata | undefined;
  let output: { rawLength: number; normalizedLength: number; hadLineBreaks: boolean; normalizationApplied: boolean } | undefined;
  try {
    model = getCloudflareTextConfig().model;
    const instruction = buildTargetLanguageInstruction(input.language, input.context, input.childAge, sourceLanguage);
    const translateOnce = async (retry: boolean) => {
      const result = await translateVietnameseWithCloudflare(
        input.sourceText,
        retry ? `${instruction}\n${leakRetryRules[input.language]}` : instruction,
        maxCompletionTokens,
        { parentRequestId: input.requestId, onCompletion: (metadata) => { completion = metadata; } },
      );
      const translatedText = normalizeTargetTranslation(result.englishText);
      output = {
        rawLength: result.englishText.length,
        normalizedLength: translatedText.length,
        hadLineBreaks: /[\r\n\u2028\u2029]/u.test(result.englishText),
        normalizationApplied: translatedText !== result.englishText,
      };
      const reason = completionIssue(completion) ?? targetTranslationIssue(translatedText, input.language);
      return { result, translatedText, reason };
    };
    let { result, translatedText, reason } = await translateOnce(false);
    // Leftover source characters get one retry; a wholly wrong script still fails at once.
    if (reason === "untranslated_source_script") {
      logEvent("warn", "target_translation_script_retry", { ...fields, reason });
      ({ result, translatedText, reason } = await translateOnce(true));
    }
    if (reason) {
      throw attachFailureDiagnostics(new AppError(
        "LLM_FAILED", "Bản dịch AI chưa hoàn chỉnh hoặc không đúng định dạng. Vui lòng thử lại.", 502,
        { provider: "cloudflare", stage: "text_translation", reason, language: input.language },
      ), { failureSource: "cloudflare", upstreamStatus: completion?.upstreamStatus });
    }
    logEvent("info", "target_translation_completed", {
      ...fields, ...completion, ...output, model: result.model,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return { translatedText, model: result.model };
  } catch (error) {
    const projected = error instanceof CloudflareTextProviderError
      ? attachFailureDiagnostics(new AppError(
        "LLM_FAILED", "Chưa dịch được câu này. Bạn thử lại nhé.",
        error.reason === "not_configured" || error.reason === "invalid_model" ? 503
          : error.status === 429 ? 429 : error.reason === "timeout" ? 504 : 502,
        { provider: "cloudflare", stage: "text_translation", reason: completionIssue(completion) ?? error.reason, language: input.language },
      ), getFailureDiagnostics(error)) : error;
    logEvent("warn", "target_translation_failed", {
      ...fields, model, ...completion, ...output,
      reason: projected instanceof AppError ? projected.details?.reason ?? "application_error" : "unexpected_error",
      code: projected instanceof AppError ? projected.code : "LLM_FAILED",
      errorType: projected instanceof AppError ? "AppError" : projected instanceof Error ? "Error" : "non_error",
      status: projected instanceof AppError ? projected.status : 500,
      ...getFailureDiagnostics(projected),
      latencyMs: Math.round(performance.now() - startedAt),
    });
    throw projected;
  }
}
