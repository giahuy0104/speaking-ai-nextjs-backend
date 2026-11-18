import type {
  PracticeContext,
  TextProvider,
  TextSource,
} from "@/types/conversation";
import { after } from "next/server";
import { normalizeVietnamese } from "@/lib/normalize";
import { logEvent } from "@/lib/observability";
import { AppError } from "@/lib/appError";
import { buildEnglishInstruction } from "./prompts";
import { getPromotedRule } from "./promotedRules";
import { getCachedAiEnglishText, saveAiEnglishText } from "./textCache";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import {
  findReviewedCorpusRuleMatch,
  findReviewedExactAsrRuleMatch,
  normalizeVietnameseForExactMatch,
} from "./exactRules";
import { findMissingTranslationRequirements } from "./translationFidelity";
import { normalizeTranslationOutput } from "./translationOutputQuality";
import {
  CloudflareTextProviderError,
  translateVietnameseWithCloudflare,
} from "./cloudflareText";
import { claimSingleFlight } from "./singleFlight";
import { runProviders } from "./cloudflareWorkersAi";
import { resolveAudioProviders, toDeepInfraAppError, translateWithDeepInfra } from "./deepInfra";
import { turnContent } from "@/lib/turnContentLog";

export type EnglishGenerationResult = {
  englishText: string;
  mode: "rule" | "ai" | "fallback";
  source: TextSource;
  matchedRule?: string;
  textProvider?: TextProvider;
  textModel?: string;
  textFallbackUsed?: boolean;
  textFallbackReason?: string;
};

type ProviderTranslation = {
  englishText: string;
  provider: TextProvider;
  model: string;
};

type TextGenerationGlobalState = typeof globalThis & {
  __aiSpeakingTextGenerationFlights?: Map<
    string,
    Promise<EnglishGenerationResult>
  >;
};

const textGenerationGlobal = globalThis as TextGenerationGlobalState;
const textGenerationFlights =
  textGenerationGlobal.__aiSpeakingTextGenerationFlights ??=
    new Map<string, Promise<EnglishGenerationResult>>();
const textGenerationFlightRetentionMs = 5_000;

function getTextGenerationFlightKey(
  vietnameseText: string,
  context: PracticeContext,
  childAge: number,
) {
  return [
    "cloudflare",
    context,
    `age:${childAge}`,
    normalizeVietnameseForExactMatch(vietnameseText),
  ].join("::");
}

function getFixedEnglishSentence(vietnameseText: string) {
  const exactMatch = findReviewedExactAsrRuleMatch(vietnameseText);

  if (exactMatch) {
    return {
      englishText: exactMatch.rule.english,
      matchedRule: `${exactMatch.matchType}:${exactMatch.rule.ruleVersion}:${exactMatch.rule.id}`,
      source: "phrase_rule" as const,
    };
  }

  const corpusMatch = findReviewedCorpusRuleMatch(vietnameseText);

  if (!corpusMatch) {
    return null;
  }

  return {
    englishText: corpusMatch.rule.english,
    matchedRule: `${corpusMatch.matchType}:${corpusMatch.rule.ruleVersion}:${corpusMatch.rule.id}`,
    source: "corpus_rule" as const,
  };
}

function isUnclearShortInput(normalizedText: string) {
  const unclearInputs = new Set([
    "con",
    "cai nay",
    "cai kia",
    "kia",
    "nay",
    "do",
    "a",
    "a a",
    "um",
    "uh",
  ]);

  return unclearInputs.has(normalizedText) || normalizedText.length < 3;
}

class InvalidTranslationError extends Error {
  constructor(
    readonly provider: TextProvider,
    readonly details?: string,
  ) {
    super(`${provider} returned an invalid translation`);
    this.name = "InvalidTranslationError";
  }
}

function getProviderFailureReason(error: unknown) {
  if (error instanceof CloudflareTextProviderError) {
    return error.reason;
  }
  if (error instanceof AppError) {
    const reason = error.details?.reason;
    return typeof reason === "string" ? reason : error.code;
  }
  if (error instanceof InvalidTranslationError) {
    return error.details
      ? `invalid_translation:${error.details}`
      : "invalid_translation";
  }
  if (error instanceof Error) {
    return error.name || "provider_error";
  }
  return "unknown_error";
}

async function translateWithCloudflare(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
): Promise<ProviderTranslation> {
  const startedAt = performance.now();

  try {
    const result = await translateVietnameseWithCloudflare(
      vietnameseText,
      instructions,
    );
    const englishText = normalizeTranslationOutput(result.englishText);

    if (!englishText) {
      throw new InvalidTranslationError("cloudflare");
    }

    const missingRequirements = findMissingTranslationRequirements(
      vietnameseText,
      englishText,
    );
    if (missingRequirements.length > 0) {
      throw new InvalidTranslationError(
        "cloudflare",
        missingRequirements.join(","),
      );
    }

    return {
      englishText,
      provider: "cloudflare",
      model: result.model,
    };
  } finally {
    logEvent("info", "text_provider_latency", {
      requestId,
      provider: "cloudflare",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  }
}

/** Reasoning models spend tokens before answering; the answer itself is one short sentence. */
const DEEPINFRA_MAX_COMPLETION_TOKENS = 512;

async function translateWithDeepInfraProvider(
  vietnameseText: string,
  instructions: string,
  signal: AbortSignal,
  requestId?: string,
): Promise<ProviderTranslation> {
  const startedAt = performance.now();
  try {
    let result;
    try {
      result = await translateWithDeepInfra(vietnameseText, instructions, DEEPINFRA_MAX_COMPLETION_TOKENS, { signal });
    } catch (error) {
      throw toDeepInfraAppError(error, "text", performance.now() - startedAt);
    }
    const englishText = normalizeTranslationOutput(result.englishText);
    const missingRequirements = englishText
      ? findMissingTranslationRequirements(vietnameseText, englishText)
      : [];
    if (!englishText || missingRequirements.length > 0) {
      // A 502, so the next provider (Cloudflare) still gets a chance.
      const details = missingRequirements.join(",");
      throw new AppError("LLM_FAILED", "Dịch vụ dịch tạm thời gặp lỗi. Vui lòng thử lại.", 502, {
        provider: "deepinfra",
        reason: details ? `invalid_translation:${details}` : "invalid_translation",
      });
    }
    return { englishText, provider: "deepinfra", model: result.model };
  } finally {
    logEvent("info", "text_provider_latency", {
      requestId,
      provider: "deepinfra",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  }
}

/**
 * A Cloudflare failure as the AppError runProviders falls back on (429 or 5xx), so
 * "cloudflare,deepinfra" still reaches DeepInfra. Keeps the original reason.
 */
function toCloudflareFallbackError(error: unknown) {
  if (error instanceof AppError) return error;
  const rateLimited = error instanceof CloudflareTextProviderError &&
    (error.reason === "rate_limited" || error.status === 429);
  return new AppError("LLM_FAILED", "Dịch vụ dịch tạm thời gặp lỗi. Vui lòng thử lại.", rateLimited ? 429 : 502, {
    provider: "cloudflare",
    reason: getProviderFailureReason(error),
  });
}

/** The provider an English translation failure came from (Cloudflare unless it says otherwise). */
function failedTextProvider(error: unknown) {
  const provider = error instanceof AppError ? error.details?.provider : undefined;
  return provider === "deepinfra" ? "deepinfra" : "cloudflare";
}

/** Translates on the providers of AUDIO_TEXT_PROVIDER in priority order (Cloudflare when unset). */
async function generateWithProviders(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
) {
  const providers = resolveAudioProviders("text");
  let firstFailure: unknown;
  const translation = await runProviders("text", providers, new AbortController().signal, {
    onProviderFallback: (event) => logEvent("warn", "english_translation_provider_fallback", { requestId, ...event }),
  }, (provider, cancel) => {
    const attempt = provider === "deepinfra"
      ? translateWithDeepInfraProvider(vietnameseText, instructions, cancel, requestId)
      : translateWithCloudflare(vietnameseText, instructions, requestId).catch((error: unknown) => {
          throw toCloudflareFallbackError(error);
        });
    return attempt.catch((error: unknown) => {
      firstFailure ??= error;
      throw error;
    });
  });
  const fallbackUsed = translation.provider !== providers[0];
  return {
    ...translation,
    fallbackUsed,
    fallbackReason: fallbackUsed && firstFailure !== undefined ? getProviderFailureReason(firstFailure) : undefined,
  };
}

export async function generateEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
  requestId?: string,
  deferCacheWrite = false,
  skipFastLookup = false,
  /** Load tests: no rule or cache lookup, no joining a twin request, no cache write. */
  bypassCache = false,
): Promise<EnglishGenerationResult> {
  const fastSentence = skipFastLookup || bypassCache
    ? null
    : await resolveFastEnglishSentence(
        vietnameseText,
        context,
        childAge,
        clientId,
      );

  if (
    fastSentence &&
    !containsUnexpectedEastAsianScript(fastSentence.englishText)
  ) {
    return fastSentence;
  }

  const fallbackSentence = "Can you say that again, please?";

  if (isUnclearShortInput(normalizeVietnamese(vietnameseText))) {
    return {
      englishText: fallbackSentence,
      mode: "fallback",
      source: "fallback",
    };
  }

  const instructions = buildEnglishInstruction(context, childAge);
  const flightKey = getTextGenerationFlightKey(
    vietnameseText,
    context,
    childAge,
  );
  const generate = async (): Promise<EnglishGenerationResult> => {
      try {
        const result = await generateWithProviders(
          vietnameseText,
          instructions,
          requestId,
        );

        const saveTextCache = () =>
          saveAiEnglishText(
            vietnameseText,
            context,
            childAge,
            result.englishText,
            clientId,
            {
              textProvider: result.provider,
              textModel: result.model,
              textFallbackUsed: result.fallbackUsed,
              textFallbackReason: result.fallbackReason,
            },
          );
        const saveTextCacheSafely = async () => {
          try {
            await saveTextCache();
          } catch (error) {
            logEvent("error", "text_cache_write_failed", { requestId, error });
          }
        };
        try {
          if (bypassCache) {
            // Load tests never write the shared (production) text cache.
          } else if (deferCacheWrite) {
            after(saveTextCacheSafely);
          } else {
            await saveTextCacheSafely();
          }
        } catch (error) {
          logEvent("error", "text_cache_write_failed", { requestId, error });
        }

        return {
          englishText: result.englishText,
          mode: "ai",
          source: result.provider,
          textProvider: result.provider,
          textModel: result.model,
          textFallbackUsed: result.fallbackUsed,
          textFallbackReason: result.fallbackReason,
        };
      } catch (error) {
        const failureReason = getProviderFailureReason(error);
        const provider = failedTextProvider(error);
        // The event name stays the same so existing log queries keep working.
        logEvent("error", "cloudflare_text_failed", {
          requestId,
          provider,
          failureReason,
          ...turnContent({ sourceText: vietnameseText }),
          error,
        });

        // A provider failure says nothing about whether the user spoke clearly.
        // Reject before TTS rather than speaking an unrelated English sentence.
        throw new AppError(
          "LLM_FAILED",
          "Dịch vụ dịch tạm thời gặp lỗi. Vui lòng thử lại.",
          503,
          { provider, reason: failureReason },
        );
      }
  };
  if (bypassCache) return generate();
  const claimedFlight = claimSingleFlight({
    flights: textGenerationFlights,
    key: flightKey,
    retainForMs: textGenerationFlightRetentionMs,
    operation: generate,
  });
  if (claimedFlight.joined) {
    logEvent("info", "text_generation_flight_joined", {
      requestId,
      context,
      childAge,
    });
  }
  return claimedFlight.promise;
}

export async function resolveFastEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
): Promise<EnglishGenerationResult | null> {
  const fixedSentence = getFixedEnglishSentence(vietnameseText);

  if (fixedSentence) {
    return {
      ...fixedSentence,
      mode: "rule",
    };
  }

  const normalizedText = normalizeVietnamese(vietnameseText);

  if (isUnclearShortInput(normalizedText)) {
    return null;
  }

  // Both values live in the same remote persistence layer in production.
  // Looking them up concurrently removes one full database round trip from
  // every cache miss without changing rule priority.
  const [promotedRule, cachedSentence] = await Promise.all([
    getPromotedRule(vietnameseText, context, clientId),
    getCachedAiEnglishText(
      vietnameseText,
      context,
      childAge,
      clientId,
    ),
  ]);

  if (promotedRule) {
    return {
      englishText: promotedRule.englishText,
      mode: "rule",
      source: "promoted_rule",
      matchedRule: `promoted:${promotedRule.ruleVersion}:${promotedRule.normalizedVietnameseText}`,
    };
  }

  if (!cachedSentence) {
    return null;
  }

  return {
    englishText: cachedSentence.englishText,
    mode: "ai",
    source: "text_cache",
    matchedRule: `text_cache:${cachedSentence.normalizedVietnameseText}`,
    textProvider: cachedSentence.textProvider,
    textModel: cachedSentence.textModel,
    textFallbackUsed: cachedSentence.textFallbackUsed,
    textFallbackReason: cachedSentence.textFallbackReason,
  };
}
