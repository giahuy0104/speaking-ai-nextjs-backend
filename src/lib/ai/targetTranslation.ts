import type { PracticeContext, TargetLanguage } from "@/types/conversation";
import { AppError } from "@/lib/appError";
import { logEvent } from "@/lib/observability";
import {
  CloudflareTextProviderError,
  getCloudflareTextConfig,
  translateVietnameseWithCloudflare,
  type CloudflareTextCompletionMetadata,
} from "./cloudflareText";
import { attachFailureDiagnostics, getFailureDiagnostics } from "./cloudflare/providerError";
import { runProviders } from "./cloudflareWorkersAi";
import {
  deepInfraTextModel, resolveAudioProviders, toDeepInfraAppError, translateWithDeepInfra, type AudioProvider,
} from "./deepInfra";
import { buildTargetLanguageInstruction } from "./prompts";
import { turnContent } from "@/lib/turnContentLog";

type TranslationLanguage = Exclude<TargetLanguage, "en">;
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
  return undefined;
}

function completionIssue(completion: CloudflareTextCompletionMetadata | undefined) {
  return completion?.finishReason === "length" ? "output_truncated"
    : completion?.finishReason === "content_filter" ? "content_filtered"
    : completion?.finishReason === "tool_calls" ? "unexpected_tool_call" : undefined;
}

type TargetTranslationInput = {
  sourceText: string;
  language: TranslationLanguage;
  context: PracticeContext;
  childAge?: number;
  requestId?: string;
};

type OutputShape = { rawLength: number; normalizedLength: number; hadLineBreaks: boolean; normalizationApplied: boolean };

/** Per-provider attempt details, kept for the completion/failure log line. */
type AttemptState = {
  provider: AudioProvider;
  model?: string;
  completion?: CloudflareTextCompletionMetadata;
  output?: OutputShape;
};

function describeOutput(raw: string, translatedText: string): OutputShape {
  return {
    rawLength: raw.length,
    normalizedLength: translatedText.length,
    hadLineBreaks: /[\r\n\u2028\u2029]/u.test(raw),
    normalizationApplied: translatedText !== raw,
  };
}

function invalidTranslation(provider: AudioProvider, reason: string, language: TranslationLanguage, upstreamStatus?: number) {
  const error = new AppError(
    "LLM_FAILED", "Bản dịch AI chưa hoàn chỉnh hoặc không đúng định dạng. Vui lòng thử lại.", 502,
    { provider, stage: "text_translation", reason, language },
  );
  // Abort diagnostics only know Cloudflare as an upstream source.
  return provider === "cloudflare" ? attachFailureDiagnostics(error, { failureSource: "cloudflare", upstreamStatus }) : error;
}

async function translateOnCloudflare(input: TargetTranslationInput, instruction: string, state: AttemptState) {
  try {
    state.model = getCloudflareTextConfig().model;
    const result = await translateVietnameseWithCloudflare(input.sourceText, instruction, maxCompletionTokens,
      { parentRequestId: input.requestId, onCompletion: (metadata) => { state.completion = metadata; } });
    const translatedText = normalizeTargetTranslation(result.englishText);
    state.model = result.model;
    state.output = describeOutput(result.englishText, translatedText);
    const reason = completionIssue(state.completion) ?? targetTranslationIssue(translatedText, input.language);
    if (reason) throw invalidTranslation("cloudflare", reason, input.language, state.completion?.upstreamStatus);
    return { translatedText, model: result.model };
  } catch (error) {
    if (!(error instanceof CloudflareTextProviderError)) throw error;
    throw attachFailureDiagnostics(new AppError(
      "LLM_FAILED", "Chưa dịch được câu này. Bạn thử lại nhé.",
      error.reason === "not_configured" || error.reason === "invalid_model" ? 503
        : error.status === 429 ? 429 : error.reason === "timeout" ? 504 : 502,
      { provider: "cloudflare", stage: "text_translation", reason: completionIssue(state.completion) ?? error.reason, language: input.language },
    ), getFailureDiagnostics(error));
  }
}

async function translateOnDeepInfra(input: TargetTranslationInput, instruction: string, state: AttemptState, signal: AbortSignal) {
  const startedAt = performance.now();
  state.model = deepInfraTextModel();
  let raw: string;
  try {
    raw = (await translateWithDeepInfra(input.sourceText, instruction, maxCompletionTokens, { signal })).englishText;
  } catch (error) {
    throw toDeepInfraAppError(error, "text", performance.now() - startedAt);
  }
  const translatedText = normalizeTargetTranslation(raw);
  state.output = describeOutput(raw, translatedText);
  // A wrong-script answer is a 502, so the next provider (Cloudflare) still gets a chance.
  const reason = targetTranslationIssue(translatedText, input.language);
  if (reason) throw invalidTranslation("deepinfra", reason, input.language);
  return { translatedText, model: state.model };
}

/** Translates on the providers of AUDIO_TEXT_PROVIDER in priority order (Cloudflare when unset). */
export async function translateTargetLanguage(input: TargetTranslationInput) {
  const startedAt = performance.now();
  const instruction = buildTargetLanguageInstruction(input.language, input.context, input.childAge);
  const attempts: AttemptState[] = [];
  const fields = {
    requestId: input.requestId,
    language: input.language,
    stage: "text_translation",
    sourceLength: input.sourceText.length,
    maxCompletionTokens,
    maxOutputCharacters,
    ...turnContent({ sourceText: input.sourceText }),
  };
  try {
    const result = await runProviders("text", resolveAudioProviders("text"), new AbortController().signal, {
      onProviderFallback: (event) => logEvent("warn", "target_translation_provider_fallback", { ...fields, ...event }),
    }, (provider, cancel) => {
      const state: AttemptState = { provider };
      attempts.push(state);
      return provider === "deepinfra"
        ? translateOnDeepInfra(input, instruction, state, cancel)
        : translateOnCloudflare(input, instruction, state);
    });
    const winner = attempts.find((attempt) => attempt.model === result.model) ?? attempts[attempts.length - 1];
    logEvent("info", "target_translation_completed", {
      ...fields, provider: winner?.provider, ...winner?.completion, ...winner?.output, model: result.model,
      providerAttempts: attempts.length,
      latencyMs: Math.round(performance.now() - startedAt),
      ...turnContent({ translatedText: result.translatedText }),
    });
    return result;
  } catch (projected) {
    const last = attempts[attempts.length - 1];
    logEvent("warn", "target_translation_failed", {
      ...fields, provider: last?.provider, model: last?.model, ...last?.completion, ...last?.output,
      providerAttempts: attempts.length,
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
