import type { CloudflareExecutionContext } from "./cloudflare/types";
import { attachFailureDiagnostics, getFailureDiagnostics, networkFault, providerFaultFromResponse } from "./cloudflare/providerError";
import { combineAbortSignals, timeoutSignal } from "./cloudflare/abortDiagnostics";
import { AppError } from "../appError";
import { fetchLegacyCloudflare } from "./cloudflare/legacyAdmission";

// GLM-4.7 Flash spends its completion budget on mandatory reasoning before it
// emits the translation. Llama 4 Scout returns the requested text directly,
// which keeps the primary path both faster and less likely to fall back.
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
// Full sentences can take more than 2.5 seconds even on a healthy provider.
// This is an upper bound; successful responses still return immediately.
const DEFAULT_TEXT_TIMEOUT_MS = 6_000;

type CloudflareChatEnvelope = {
  success?: boolean;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
    };
  }>;
  usage?: { completion_tokens?: unknown };
  errors?: Array<{ code?: number; message?: string }>;
};

export type CloudflareTextCompletionMetadata = Readonly<{
  model: string;
  upstreamStatus: number;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "other" | "unknown";
  completionTokens?: number;
}>;

type TextTranslationOptions = {
  signal?: AbortSignal;
  execution?: CloudflareExecutionContext;
  beforeProviderCall?: () => Promise<void>;
  onCompletion?: (metadata: CloudflareTextCompletionMetadata) => void;
  parentRequestId?: string;
};

export class CloudflareTextProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`Cloudflare text translation failed: ${reason}`);
    this.name = "CloudflareTextProviderError";
  }
}

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

export function isCloudflareTextConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim(),
  );
}

export function getCloudflareTextConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();
  const model =
    process.env.CLOUDFLARE_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;

  if (!accountId || !apiToken) {
    throw new CloudflareTextProviderError("not_configured");
  }

  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new CloudflareTextProviderError("invalid_model");
  }

  return {
    accountId,
    apiToken,
    model,
    timeoutMs: positiveInteger(
      "CLOUDFLARE_TEXT_TIMEOUT_MS",
      DEFAULT_TEXT_TIMEOUT_MS,
    ),
  };
}

export function buildCloudflareTextTranslationBody(
  model: string,
  instructions: string,
  vietnameseText: string,
  maxCompletionTokens = 48,
) {
  return {
    model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: vietnameseText },
    ],
    temperature: 0,
    // One short child-facing sentence is the entire product output. A tighter
    // budget prevents the model from appending alternatives or explanations,
    // and reduces both text latency and the downstream TTS duration.
    max_completion_tokens: maxCompletionTokens,
    stream: false,
  } as const;
}

function extractTextContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();
}

function readCompletion(
  payload: CloudflareChatEnvelope | null,
  model: string,
  upstreamStatus: number,
  onCompletion?: TextTranslationOptions["onCompletion"],
) {
  const reason = payload?.choices?.[0]?.finish_reason;
  const finishReason = reason === undefined || reason === null ? "unknown"
    : reason === "stop" || reason === "length" || reason === "content_filter" || reason === "tool_calls"
      ? reason : "other";
  const tokens = payload?.usage?.completion_tokens;
  const metadata: CloudflareTextCompletionMetadata = Object.freeze({
    model, upstreamStatus, finishReason,
    ...(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
      ? { completionTokens: tokens } : {}),
  });
  // Diagnostic hooks must never turn a successful provider call into a failure.
  try { onCompletion?.(metadata); } catch { /* best-effort telemetry */ }
  const englishText = extractTextContent(payload?.choices?.[0]?.message?.content);
  if (!englishText) {
    throw attachFailureDiagnostics(new CloudflareTextProviderError("empty_response"),
      { failureSource: "cloudflare", upstreamStatus });
  }
  return { englishText, model };
}

export async function translateVietnameseWithCloudflare(
  vietnameseText: string,
  instructions: string,
  maxCompletionTokens = 48,
  options: TextTranslationOptions = {},
) {
  if (options.execution) {
    const model = process.env.CLOUDFLARE_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
    if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
      throw new CloudflareTextProviderError("invalid_model");
    }
    const completion = await options.execution.dispatcher.execute(
      {
        context: options.execution,
        operation: "audio_translation_text",
        model,
        timeoutMs: positiveInteger("CLOUDFLARE_TEXT_TIMEOUT_MS", DEFAULT_TEXT_TIMEOUT_MS),
      },
      async ({ account, signal: attemptSignal }) => {
        await options.beforeProviderCall?.();
        const signal = options.signal
          ? combineAbortSignals([attemptSignal, options.signal])
          : attemptSignal;
        let response: Response | undefined;
        let payload: CloudflareChatEnvelope | null;
        try {
          response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.accountId)}/ai/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${account.apiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(buildCloudflareTextTranslationBody(
                model, instructions, vietnameseText, maxCompletionTokens,
              )),
              signal,
              cache: "no-store",
            },
          );
          const raw = await response.text();
          try { payload = JSON.parse(raw) as CloudflareChatEnvelope | null; }
          catch { payload = null; }
        } catch (error) {
          throw networkFault(error, signal, response?.status);
        }
        if (!response.ok || payload === null || payload.success === false) {
          throw providerFaultFromResponse(response, payload);
        }
        return { payload, upstreamStatus: response.status };
      },
    );
    // Content validation belongs to the wrapper, outside provider retry.
    return readCompletion(completion.payload, model, completion.upstreamStatus, options.onCompletion);
  }

  const config = getCloudflareTextConfig();
  await options.beforeProviderCall?.();
  const signal = options.signal
    ? combineAbortSignals([options.signal, timeoutSignal(config.timeoutMs, "attempt_timeout")])
    : timeoutSignal(config.timeoutMs, "attempt_timeout");
  let response: Response | undefined;
  let payload: CloudflareChatEnvelope | null;

  try {
    response = await fetchLegacyCloudflare(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildCloudflareTextTranslationBody(
            config.model,
            instructions,
            vietnameseText,
            maxCompletionTokens,
          ),
        ),
        signal,
        cache: "no-store",
      },
      { task: "text", model: config.model, timeoutMs: config.timeoutMs, parentRequestId: options.parentRequestId },
    );
    const raw = await response.text();
    try { payload = JSON.parse(raw) as CloudflareChatEnvelope | null; }
    catch { payload = null; }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const name = error instanceof Error ? error.name : "";
    throw attachFailureDiagnostics(new CloudflareTextProviderError(
      signal.aborted || name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "network_error",
    ), getFailureDiagnostics(networkFault(error, signal, response?.status)));
  }

  if (!response.ok) {
    throw attachFailureDiagnostics(new CloudflareTextProviderError(
      response.status === 429 ? "rate_limited" : `http_${response.status}`,
      response.status,
    ), getFailureDiagnostics(providerFaultFromResponse(response, payload)));
  }

  if (!payload || payload.success === false) {
    throw attachFailureDiagnostics(new CloudflareTextProviderError("invalid_response"),
      getFailureDiagnostics(providerFaultFromResponse(response, payload)));
  }

  return readCompletion(payload, config.model, response.status, options.onCompletion);
}
