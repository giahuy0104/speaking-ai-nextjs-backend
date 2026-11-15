import { AppError } from "../appError";
import { combineAbortSignals, timeoutSignal } from "./cloudflare/abortDiagnostics";

/**
 * DeepInfra adapter for the audio translation pipeline: Whisper for ASR and an
 * OpenAI-compatible chat model for the text translation step. Selected per stage
 * with AUDIO_ASR_PROVIDER / AUDIO_TEXT_PROVIDER; Cloudflare stays the default.
 */

export type AudioProvider = "cloudflare" | "deepinfra";
export type AudioProviderStage = "asr" | "text";

const DEFAULT_BASE_URL = "https://api.deepinfra.com/v1/openai";
const DEFAULT_ASR_MODEL = "openai/whisper-large-v3-turbo";
// A dated snapshot: the undated alias can move to a new model and change translations.
const DEFAULT_TEXT_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
// ~2x the loaded Whisper p95, leaving room inside the 20s request deadline.
const DEFAULT_ASR_TIMEOUT_MS = 8_000;
const DEFAULT_TEXT_TIMEOUT_MS = 6_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);
const REASONING_BLOCK = /<think>[\s\S]*?<\/think>/gi;

export class DeepInfraProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`DeepInfra request failed: ${reason}`);
    this.name = "DeepInfraProviderError";
  }
}

type DeepInfraConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  textModel: string;
  asrTimeoutMs: number;
  textTimeoutMs: number;
  reasoningEffort?: string;
}>;

type CallOptions = { signal?: AbortSignal };

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Providers for a stage in priority order, e.g. "deepinfra,cloudflare": the
 * first one is tried first and each later one is a fallback.
 */
export function resolveAudioProviders(stage: AudioProviderStage): readonly AudioProvider[] {
  const name = stage === "asr" ? "AUDIO_ASR_PROVIDER" : "AUDIO_TEXT_PROVIDER";
  const entries = (process.env[name] ?? "").split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean);
  const providers: AudioProvider[] = [];
  for (const entry of entries.length ? entries : ["cloudflare"]) {
    if (entry !== "cloudflare" && entry !== "deepinfra") {
      throw new AppError(stage === "asr" ? "ASR_FAILED" : "LLM_FAILED",
        "Cấu hình nhà cung cấp AI không hợp lệ.", 500, { reason: "invalid_provider", setting: name });
    }
    if (!providers.includes(entry)) providers.push(entry);
  }
  return providers;
}

export function deepInfraAsrModel() {
  return process.env.DEEPINFRA_ASR_MODEL?.trim() || DEFAULT_ASR_MODEL;
}

export function deepInfraTextModel() {
  return process.env.DEEPINFRA_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
}

/** Cache identity for a stage's provider order: Cloudflare-only stays unchanged so existing entries stay valid. */
export function audioModelCacheIdentity(stage: AudioProviderStage, cloudflareModel: string) {
  return resolveAudioProviders(stage).map(provider => provider === "cloudflare" ? cloudflareModel
    : `deepinfra:${stage === "asr" ? deepInfraAsrModel() : deepInfraTextModel()}`).join(">");
}

function resolveBaseUrl() {
  const configured = process.env.DEEPINFRA_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(configured); } catch { throw new DeepInfraProviderError("invalid_base_url"); }
  // The API key travels in a header: never send it over plain HTTP.
  if (url.protocol !== "https:") throw new DeepInfraProviderError("invalid_base_url");
  return configured.replace(/\/+$/, "");
}

export function getDeepInfraConfig(): DeepInfraConfig {
  const apiKey = process.env.DEEPINFRA_API_KEY?.trim();
  if (!apiKey) throw new DeepInfraProviderError("not_configured");
  const asrModel = deepInfraAsrModel();
  const textModel = deepInfraTextModel();
  if (!MODEL_PATTERN.test(asrModel) || !MODEL_PATTERN.test(textModel)) {
    throw new DeepInfraProviderError("invalid_model");
  }
  const reasoningEffort = process.env.DEEPINFRA_TEXT_REASONING_EFFORT?.trim().toLowerCase();
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new DeepInfraProviderError("invalid_reasoning_effort");
  }
  return {
    apiKey,
    baseUrl: resolveBaseUrl(),
    asrModel,
    textModel,
    asrTimeoutMs: positiveInteger("DEEPINFRA_ASR_TIMEOUT_MS", DEFAULT_ASR_TIMEOUT_MS),
    textTimeoutMs: positiveInteger("DEEPINFRA_TEXT_TIMEOUT_MS", DEFAULT_TEXT_TIMEOUT_MS),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

async function postDeepInfra(
  config: DeepInfraConfig,
  path: string,
  init: { body: BodyInit; headers?: Record<string, string> },
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<unknown> {
  const attemptSignal = timeoutSignal(timeoutMs, "attempt_timeout");
  const signal = outerSignal ? combineAbortSignals([outerSignal, attemptSignal]) : attemptSignal;
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, ...init.headers },
      body: init.body,
      signal,
      cache: "no-store",
    });
    // Reading the body is covered by the same deadline as the request.
    raw = await response.text();
  } catch {
    throw new DeepInfraProviderError(signal.aborted ? "timeout" : "network_error");
  }
  // Upstream error bodies are never surfaced: they may echo request content.
  if (!response.ok) {
    throw new DeepInfraProviderError(response.status === 429 ? "rate_limited" : "provider_error", response.status);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DeepInfraProviderError("invalid_response", response.status);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export type DeepInfraTranscription = Readonly<{ text: string; segments: unknown[]; model: string }>;

export async function transcribeWithDeepInfra(
  audio: Blob,
  fileName: string,
  language: string,
  options: CallOptions = {},
): Promise<DeepInfraTranscription> {
  const config = getDeepInfraConfig();
  const form = new FormData();
  form.append("file", audio, fileName || "audio");
  form.append("model", config.asrModel);
  form.append("language", language);
  // verbose_json carries per-segment avg_logprob / no_speech_prob for the transcript validators.
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const payload = asRecord(await postDeepInfra(config, "/audio/transcriptions", { body: form },
    config.asrTimeoutMs, options.signal));
  if (!payload) throw new DeepInfraProviderError("invalid_response");
  return {
    text: typeof payload.text === "string" ? payload.text.trim() : "",
    segments: Array.isArray(payload.segments) ? payload.segments : [],
    model: config.asrModel,
  };
}

function readChatContent(payload: unknown) {
  const choices = asRecord(payload)?.choices;
  const message = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.message) : undefined;
  const content = message?.content;
  return typeof content === "string" ? content.replace(REASONING_BLOCK, "").trim() : "";
}

export async function translateWithDeepInfra(
  text: string,
  instructions: string,
  maxTokens: number,
  options: CallOptions = {},
): Promise<{ englishText: string; model: string }> {
  const config = getDeepInfraConfig();
  const body = {
    model: config.textModel,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: text },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
  };
  const payload = await postDeepInfra(config, "/chat/completions",
    { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    config.textTimeoutMs, options.signal);
  const englishText = readChatContent(payload);
  if (!englishText) throw new DeepInfraProviderError("empty_response");
  return { englishText, model: config.textModel };
}

function statusFor(error: DeepInfraProviderError) {
  switch (error.reason) {
    case "not_configured": return 503;
    case "invalid_model":
    case "invalid_base_url":
    case "invalid_reasoning_effort": return 500;
    case "timeout": return 504;
    case "rate_limited": return 429;
    default: return 502;
  }
}

function asrMessage(status: number) {
  if (status === 429) return "Dịch vụ nhận diện giọng nói đang quá tải. Vui lòng thử lại sau.";
  if (status === 504) return "Dịch vụ nhận diện giọng nói phản hồi quá thời gian chờ. Vui lòng thử lại.";
  if (status === 503) return "Máy chủ chưa được cấu hình DeepInfra.";
  return "Dịch vụ nhận diện giọng nói tạm thời gặp lỗi. Vui lòng thử lại.";
}

/** Public error for a failed DeepInfra stage; other errors pass through unchanged. */
export function toDeepInfraAppError(error: unknown, stage: AudioProviderStage, elapsedMs: number) {
  if (!(error instanceof DeepInfraProviderError)) return error;
  const status = statusFor(error);
  return new AppError(stage === "asr" ? "ASR_FAILED" : "LLM_FAILED",
    stage === "asr" ? asrMessage(status) : "Dịch vụ dịch văn bản tạm thời gặp lỗi. Vui lòng thử lại.",
    status, {
      provider: "deepinfra",
      ...(stage === "text" ? { stage: "text_translation" } : {}),
      reason: error.reason,
      ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
      elapsedMs: Math.round(elapsedMs),
    });
}
