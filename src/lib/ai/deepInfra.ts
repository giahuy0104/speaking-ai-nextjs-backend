// The body classes must come from the same undici as `fetch`: it recognises FormData
// with an instanceof check, and Node's global FormData would be sent as "[object FormData]".
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from "undici";
import { AppError } from "../appError";
import { combineAbortSignals, timeoutSignal } from "./cloudflare/abortDiagnostics";
import { ConcurrencyLimitTimeoutError, createConcurrencyLimiter, type ConcurrencyLimiter, type ReleaseSlot } from "./concurrencyLimiter";

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
const DEFAULT_KEEPALIVE_MS = 50_000;
const CONNECT_TIMEOUT_MS = 5_000;
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
  // The API key travels in a header: never send it over plain HTTP, except to this
  // machine (local proxies and tests of the real transport).
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new DeepInfraProviderError("invalid_base_url");
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

type DeepInfraRequestInit = RequestInit & { dispatcher: Agent };
type DeepInfraTransport = (url: string, init: DeepInfraRequestInit) => Promise<Response>;

// DeepInfra is ~250 ms away and a new TLS connection costs ~0.6 s. Its server keeps
// idle connections for at least 60 s, but Node's default fetch drops them after 4 s,
// so almost every request between two user turns reconnected. Keep them for 50 s.
// undici's own fetch is paired with its own Agent, independent of Node's bundled copy.
let sharedAgent: Agent | undefined;
let transportOverride: DeepInfraTransport | undefined;

function keepAliveAgent() {
  if (!sharedAgent) {
    const keepAliveMs = positiveInteger("DEEPINFRA_KEEPALIVE_MS", DEFAULT_KEEPALIVE_MS);
    sharedAgent = new Agent({
      keepAliveTimeout: keepAliveMs,
      keepAliveMaxTimeout: keepAliveMs,
      connect: { timeout: CONNECT_TIMEOUT_MS },
    });
  }
  return sharedAgent;
}

const keepAliveTransport: DeepInfraTransport = (url, init) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

/** Tests route DeepInfra calls through a mocked fetch; `undefined` restores the keep-alive transport. */
export function setDeepInfraTransportForTests(transport: DeepInfraTransport | undefined) {
  transportOverride = transport;
}

async function sendDeepInfra(
  config: DeepInfraConfig,
  path: string,
  init: { body: BodyInit; headers?: Record<string, string> },
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<{ response: Response; body: ArrayBuffer }> {
  const attemptSignal = timeoutSignal(timeoutMs, "attempt_timeout");
  const signal = outerSignal ? combineAbortSignals([outerSignal, attemptSignal]) : attemptSignal;
  let response: Response;
  let body: ArrayBuffer;
  try {
    response = await (transportOverride ?? keepAliveTransport)(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, ...init.headers },
      body: init.body,
      signal,
      dispatcher: keepAliveAgent(),
    });
    // Reading the body is covered by the same deadline as the request.
    body = await response.arrayBuffer();
  } catch {
    throw new DeepInfraProviderError(signal.aborted ? "timeout" : "network_error");
  }
  // Upstream error bodies are never surfaced: they may echo request content.
  if (!response.ok) {
    throw new DeepInfraProviderError(response.status === 429 ? "rate_limited" : "provider_error", response.status);
  }
  return { response, body };
}

async function postDeepInfra(
  config: DeepInfraConfig,
  path: string,
  init: { body: BodyInit; headers?: Record<string, string> },
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<unknown> {
  const { response, body } = await sendDeepInfra(config, path, init, timeoutMs, outerSignal);
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
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
  const form = new UndiciFormData();
  form.append("file", audio, fileName || "audio");
  form.append("model", config.asrModel);
  form.append("language", language);
  // verbose_json carries per-segment avg_logprob / no_speech_prob for the transcript validators.
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  // undici's FormData is a valid body for undici's fetch; the DOM typings only know the global class.
  const payload = asRecord(await postDeepInfra(config, "/audio/transcriptions", { body: form as unknown as BodyInit },
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

const DEFAULT_TTS_MODEL = "Qwen/Qwen3-TTS";
// Qwen3-TTS preset voice; it reads all target languages (zh/ja/ko/fr).
const DEFAULT_TTS_VOICE = "Sohee";
// Qwen3-TTS took 1.6-3.9 s for one or two short sentences in manual tests.
const DEFAULT_TTS_TIMEOUT_MS = 10_000;
const VOICE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SPEECH_BYTES = 10 * 1024 * 1024;
// DeepInfra refuses (HTTP 429) calls beyond the account's concurrency limit for a
// model, and the voice is then lost. Each backend process keeps its own Qwen3-TTS
// calls under this cap and lets the rest wait briefly for a free slot. The account
// limit is shared by every backend (dev and production): N backends x this cap.
const DEFAULT_TTS_MAX_CONCURRENCY = 40;
// Short: the app waits 20 s for the whole turn, and a busy account rarely frees
// many slots within a few seconds.
const DEFAULT_TTS_QUEUE_WAIT_MS = 3_000;
// One limiter per process even if Next loads this module in several bundles.
const TTS_LIMITER_KEY = Symbol.for("homi.deepinfra.ttsLimiter");
const limiterHolder = globalThis as typeof globalThis & { [TTS_LIMITER_KEY]?: ConcurrencyLimiter };

function deepInfraTtsLimiter() {
  limiterHolder[TTS_LIMITER_KEY] ??= createConcurrencyLimiter({
    maxConcurrent: positiveInteger("DEEPINFRA_TTS_MAX_CONCURRENCY", DEFAULT_TTS_MAX_CONCURRENCY),
    maxWaitMs: positiveInteger("DEEPINFRA_TTS_QUEUE_WAIT_MS", DEFAULT_TTS_QUEUE_WAIT_MS),
  });
  return limiterHolder[TTS_LIMITER_KEY];
}

/** Tests change the limits through the environment; this rebuilds the limiter. */
export function resetDeepInfraTtsLimiterForTests() {
  delete limiterHolder[TTS_LIMITER_KEY];
}

/** DeepInfra is refusing work (account limit or full local queue): trying again now hits the same wall. */
export function isDeepInfraBusy(error: unknown) {
  return error instanceof DeepInfraProviderError && (error.reason === "rate_limited" || error.reason === "queue_timeout");
}

/** Waits for a Qwen3-TTS slot; `queue_timeout` (HTTP 429) when none frees in time. */
async function acquireTtsSlot(signal?: AbortSignal): Promise<ReleaseSlot> {
  try {
    return await deepInfraTtsLimiter().acquire(signal);
  } catch (error) {
    throw new DeepInfraProviderError(error instanceof ConcurrencyLimitTimeoutError ? "queue_timeout" : "network_error");
  }
}

export function deepInfraTtsModel() {
  return process.env.DEEPINFRA_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;
}

export function deepInfraTtsVoice() {
  return process.env.DEEPINFRA_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE;
}

export type DeepInfraSpeechFormat = "mp3" | "wav";
const SPEECH_CONTENT_TYPES: Record<DeepInfraSpeechFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav" };

/**
 * Text-to-speech through DeepInfra's OpenAI-compatible endpoint; returns the
 * finished clip. MP3 by default; WAV (24 kHz, 16-bit, mono) matches streamed speech.
 */
export async function synthesizeWithDeepInfra(
  text: string,
  options: CallOptions & { format?: DeepInfraSpeechFormat } = {},
): Promise<{ audio: ArrayBuffer; model: string; voice: string }> {
  const config = getDeepInfraConfig();
  const model = deepInfraTtsModel();
  const voice = deepInfraTtsVoice();
  const format = options.format ?? "mp3";
  if (!MODEL_PATTERN.test(model)) throw new DeepInfraProviderError("invalid_model");
  if (!VOICE_PATTERN.test(voice)) throw new DeepInfraProviderError("invalid_voice");
  // The provider timeout starts once a slot is held, so waiting never eats into it.
  const release = await acquireTtsSlot(options.signal);
  try {
    const { response, body } = await sendDeepInfra(config, "/audio/speech", {
      body: JSON.stringify({ model, input: text, voice, response_format: format }),
      headers: { "Content-Type": "application/json" },
    }, positiveInteger("DEEPINFRA_TTS_TIMEOUT_MS", DEFAULT_TTS_TIMEOUT_MS), options.signal);
    if (!response.headers.get("content-type")?.includes(SPEECH_CONTENT_TYPES[format]) ||
        body.byteLength === 0 || body.byteLength > MAX_SPEECH_BYTES) {
      throw new DeepInfraProviderError("invalid_response", response.status);
    }
    return { audio: body, model, voice };
  } finally {
    release();
  }
}

/** Raw PCM from the streaming endpoint: signed 16-bit little-endian, mono. */
export const DEEPINFRA_PCM_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;
// Two minutes of speech; a translated sentence is a few seconds.
const MAX_PCM_BYTES = DEEPINFRA_PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 120;
// The whole stream (headers + body) must finish within this. Separate from the
// MP3 timeout because a slow listener's backpressure also counts against it.
const DEFAULT_TTS_STREAM_TIMEOUT_MS = 20_000;
const STREAM_LANGUAGES = new Set(["zh", "ja", "ko", "fr", "en"]);

export type DeepInfraSpeechStream = Readonly<{
  /** Chunks always hold whole 16-bit samples (even byte lengths). */
  pcm: ReadableStream<Uint8Array>;
  sampleRate: number;
  model: string;
  voice: string;
}>;

/**
 * Speech as it is generated, via the ElevenLabs-style endpoint
 * POST /v1/text-to-speech/{voice}/stream. For Qwen3-TTS only `pcm` streams:
 * mp3, opus and wav answer 200 with an empty body (checked 2026-11-16), so the
 * caller encodes. One deadline covers the whole stream, not just the headers.
 */
export async function streamSpeechWithDeepInfra(
  text: string,
  language: string,
  options: CallOptions = {},
): Promise<DeepInfraSpeechStream> {
  const config = getDeepInfraConfig();
  const model = deepInfraTtsModel();
  const voice = deepInfraTtsVoice();
  if (!MODEL_PATTERN.test(model)) throw new DeepInfraProviderError("invalid_model");
  if (!VOICE_PATTERN.test(voice)) throw new DeepInfraProviderError("invalid_voice");
  // The OpenAI-compatible routes live under /v1/openai; this one sits beside them.
  const root = config.baseUrl.replace(/\/openai$/, "");
  // Held until the stream ends, fails or is cancelled: the call is open until then.
  const release = await acquireTtsSlot(options.signal);
  const deadline = timeoutSignal(
    positiveInteger("DEEPINFRA_TTS_STREAM_TIMEOUT_MS", DEFAULT_TTS_STREAM_TIMEOUT_MS), "attempt_timeout");
  const signal = options.signal ? combineAbortSignals([options.signal, deadline]) : deadline;
  // The deadline or a caller abort ends the call even when nobody is reading the
  // stream (no pull pending), so the slot cannot stay held by a stalled listener.
  signal.addEventListener("abort", release, { once: true });
  // A caller abort (client gone) is a network-level stop, not our deadline.
  const failure = () => new DeepInfraProviderError(deadline.aborted ? "timeout" : "network_error");
  let response: Response;
  try {
    response = await (transportOverride ?? keepAliveTransport)(
      `${root}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text, model_id: model, output_format: "pcm",
          ...(STREAM_LANGUAGES.has(language) ? { language_code: language } : {}),
        }),
        signal,
        dispatcher: keepAliveAgent(),
      });
  } catch {
    release();
    throw failure();
  }
  if (!response.ok || !response.body) {
    release();
    // Upstream error bodies are never surfaced: they may echo the text.
    await response.body?.cancel().catch(() => undefined);
    throw new DeepInfraProviderError(response.status === 429 ? "rate_limited" : "provider_error", response.status);
  }
  if (!response.headers.get("content-type")?.includes("audio/pcm")) {
    release();
    await response.body.cancel().catch(() => undefined);
    throw new DeepInfraProviderError("invalid_response", response.status);
  }
  const reader = response.body.getReader();
  let received = 0;
  // Upstream chunks may split a sample; carry the odd byte into the next chunk.
  let carry: Uint8Array | undefined;
  const pcm = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            release();
            if (received < PCM_BYTES_PER_SAMPLE) controller.error(new DeepInfraProviderError("empty_response", response.status));
            else controller.close();
            return;
          }
          received += value.byteLength;
          if (received > MAX_PCM_BYTES) {
            release();
            controller.error(new DeepInfraProviderError("invalid_response", response.status));
            await reader.cancel().catch(() => undefined);
            return;
          }
          const bytes = carry ? concatBytes(carry, value) : value;
          const whole = bytes.byteLength - (bytes.byteLength % PCM_BYTES_PER_SAMPLE);
          carry = whole < bytes.byteLength ? bytes.slice(whole) : undefined;
          if (whole > 0) {
            controller.enqueue(whole === bytes.byteLength ? bytes : bytes.subarray(0, whole));
            return;
          }
        }
      } catch {
        release();
        controller.error(failure());
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return { pcm, sampleRate: DEEPINFRA_PCM_SAMPLE_RATE, model, voice };
}

function concatBytes(head: Uint8Array, tail: Uint8Array) {
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head, 0);
  joined.set(tail, head.byteLength);
  return joined;
}

function statusFor(error: DeepInfraProviderError) {
  switch (error.reason) {
    case "not_configured": return 503;
    case "invalid_model":
    case "invalid_voice":
    case "invalid_base_url":
    case "invalid_reasoning_effort": return 500;
    case "timeout": return 504;
    case "rate_limited":
    case "queue_timeout": return 429;
    default: return 502;
  }
}

function asrMessage(status: number) {
  if (status === 429) return "Dịch vụ nhận diện giọng nói đang quá tải. Vui lòng thử lại sau.";
  if (status === 504) return "Dịch vụ nhận diện giọng nói phản hồi quá thời gian chờ. Vui lòng thử lại.";
  if (status === 503) return "Máy chủ chưa được cấu hình DeepInfra.";
  return "Dịch vụ nhận diện giọng nói tạm thời gặp lỗi. Vui lòng thử lại.";
}

/** Public error for a failed DeepInfra speech request; other errors pass through unchanged. */
export function toDeepInfraTtsAppError(error: unknown) {
  if (!(error instanceof DeepInfraProviderError)) return error;
  return new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", statusFor(error), {
    provider: "deepinfra",
    stage: "tts",
    reason: error.reason,
    ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
  });
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
