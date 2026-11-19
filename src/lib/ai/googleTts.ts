import type { Duplex } from "node:stream";
import { AppError } from "../appError";
import { ConcurrencyLimitTimeoutError, createConcurrencyLimiter, type ConcurrencyLimiter, type ReleaseSlot } from "./concurrencyLimiter";

/**
 * Google Cloud Text-to-Speech (gRPC, google.cloud.texttospeech.v1) for the voice of a
 * zh/ja/ko/fr translation. Selected with AUDIO_TARGET_TTS_PROVIDER=google.
 * - StreamingSynthesize: PCM while it is generated, for streamed speech.
 * - SynthesizeSpeech: a finished MP3 clip, or a WAV clip when a stream must be replaced.
 * Credentials: GOOGLE_TTS_CREDENTIALS_JSON (service-account JSON, raw or base64),
 * otherwise Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, gcloud).
 */

export type GoogleTtsReason =
  | "not_configured" | "invalid_voice" | "unsupported_language" | "timeout" | "network_error"
  | "rate_limited" | "queue_timeout" | "provider_error" | "invalid_response" | "empty_response";

export class GoogleTtsProviderError extends Error {
  constructor(readonly reason: GoogleTtsReason, readonly grpcCode?: number) {
    super(`Google TTS failed: ${reason}`);
    this.name = "GoogleTtsProviderError";
  }
}

type SynthesizeRequest = Readonly<{
  input: { text: string };
  voice: { languageCode: string; name: string };
  audioConfig: { audioEncoding: "MP3" } | { audioEncoding: "LINEAR16"; sampleRateHertz: number };
}>;

type AudioContent = Uint8Array | string | null | undefined;

/** The two calls this adapter makes; tests supply a fake. */
export type GoogleTtsClient = {
  streamingSynthesize(): Duplex;
  synthesizeSpeech(request: SynthesizeRequest, options?: { timeout?: number }): Promise<readonly [{ audioContent?: AudioContent }, ...unknown[]]>;
};

/** Chirp 3 HD streams 24 kHz, 16-bit, mono PCM; the WAV fallback uses the same rate. */
export const GOOGLE_TTS_SAMPLE_RATE = 24_000;
export const GOOGLE_TTS_MODEL = "google-cloud-tts";
const DEFAULT_VOICE = "Chirp3-HD-Aoede";
const VOICE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// en: English speech with AUDIO_ENGLISH_TTS_PROVIDER=google (see englishSpeech.ts).
const LOCALES: Readonly<Record<string, string>> = { en: "en-US", zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR" };
const PCM_BYTES_PER_SAMPLE = 2;
// Two minutes of speech; a translated sentence is a few seconds.
const MAX_PCM_BYTES = GOOGLE_TTS_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 120;
const MAX_CLIP_BYTES = 10 * 1024 * 1024;
// Measured 2026-11-18 from Vietnam: first audio ~0.24 s, a 6 s sentence complete in ~1.1 s.
const DEFAULT_TIMEOUT_MS = 10_000;
// The whole stream (first byte to last); a slow listener's backpressure counts too.
const DEFAULT_STREAM_TIMEOUT_MS = 20_000;
// Google allows 100 concurrent streaming sessions per project, shared by every backend.
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_QUEUE_WAIT_MS = 3_000;

// gRPC status codes (google.rpc.Code).
const GRPC_CANCELLED = 1;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAVAILABLE = 14;
const GRPC_UNAUTHENTICATED = 16;

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * "stream": streamed speech and its WAV stand-in. "clip": a finished MP3 clip (a short
 * sentence, or every sentence while streaming is off).
 */
export type GoogleVoiceKind = "stream" | "clip";

/**
 * A voice without its locale. Streams use GOOGLE_TTS_VOICE (default Chirp3-HD-Aoede);
 * clips may use GOOGLE_TTS_CLIP_VOICE_<LANG> (e.g. GOOGLE_TTS_CLIP_VOICE_JA=Neural2-B),
 * otherwise the stream voice.
 */
export function googleTtsVoice(language: string, kind: GoogleVoiceKind = "stream"): string {
  const streamVoice = process.env.GOOGLE_TTS_VOICE?.trim() || DEFAULT_VOICE;
  if (kind === "stream") return streamVoice;
  return process.env[`GOOGLE_TTS_CLIP_VOICE_${language.toUpperCase()}`]?.trim() || streamVoice;
}

/**
 * The voice of the WAV clip that stands in for a stream Google refused before its
 * first byte: GOOGLE_TTS_FALLBACK_VOICE_<LANG> (e.g. ZH=Wavenet-A, JA=Neural2-B),
 * otherwise the stream voice itself. Chirp 3 HD has its own per-minute quota, so a
 * Neural2/WaveNet stand-in can still speak while Chirp 3 HD is rate limited.
 */
export function googleTtsFallbackVoice(language: string): string {
  return process.env[`GOOGLE_TTS_FALLBACK_VOICE_${language.toUpperCase()}`]?.trim() || googleTtsVoice(language, "stream");
}

/** Whether a stream's stand-in clip is spoken by another voice than the stream. */
export function googleTtsFallbackChangesVoice(language: string): boolean {
  return googleTtsFallbackVoice(language) !== googleTtsVoice(language, "stream");
}

function localizedVoiceName(language: string, voice: string): string {
  const locale = LOCALES[language];
  if (!locale) throw new GoogleTtsProviderError("unsupported_language");
  if (!VOICE_PATTERN.test(voice)) throw new GoogleTtsProviderError("invalid_voice");
  return `${locale}-${voice}`;
}

/** Full Google voice name, e.g. zh -> cmn-CN-Chirp3-HD-Aoede. */
export function googleTtsVoiceName(language: string, kind: GoogleVoiceKind = "stream"): string {
  return localizedVoiceName(language, googleTtsVoice(language, kind));
}

/** Google streams only Chirp 3 HD voices ("only Chirp 3: HD voices are supported for streaming synthesis"). */
export function googleTtsCanStream(): boolean {
  const voice = googleTtsVoice("", "stream");
  return VOICE_PATTERN.test(voice) && voice.startsWith("Chirp3-HD-");
}

function voiceFor(language: string, use: GoogleVoiceKind | "fallback") {
  const name = use === "fallback"
    ? localizedVoiceName(language, googleTtsFallbackVoice(language))
    : googleTtsVoiceName(language, use);
  return { languageCode: LOCALES[language], name };
}

// One client (one gRPC channel, kept warm) and one limiter per process, even if
// Next loads this module in several bundles.
const STATE_KEY = Symbol.for("homi.googleTts.state");
type State = { client?: Promise<GoogleTtsClient>; limiter?: ConcurrencyLimiter };
const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
const state = (): State => (holder[STATE_KEY] ??= {});
let clientOverride: GoogleTtsClient | undefined;

export function setGoogleTtsClientForTests(client: GoogleTtsClient | undefined) {
  clientOverride = client;
}

/** Tests change limits through the environment; this rebuilds the limiter and client. */
export function resetGoogleTtsForTests() {
  delete holder[STATE_KEY];
}

function credentialsFromEnv() {
  const raw = process.env.GOOGLE_TTS_CREDENTIALS_JSON?.trim();
  if (!raw) return {};
  try {
    const json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof json.client_email !== "string" || typeof json.private_key !== "string") throw new Error("incomplete");
    return {
      credentials: { client_email: json.client_email, private_key: json.private_key },
      ...(typeof json.project_id === "string" ? { projectId: json.project_id } : {}),
    };
  } catch {
    throw new GoogleTtsProviderError("not_configured");
  }
}

async function createClient(): Promise<GoogleTtsClient> {
  const options = credentialsFromEnv();
  // Loaded on first use: the gRPC stack is large and most processes never need it.
  const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
  const client = new TextToSpeechClient(options);
  return {
    streamingSynthesize: () => client.streamingSynthesize() as unknown as Duplex,
    synthesizeSpeech: (request, callOptions) =>
      client.synthesizeSpeech(request, callOptions) as unknown as ReturnType<GoogleTtsClient["synthesizeSpeech"]>,
  };
}

async function googleClient(): Promise<GoogleTtsClient> {
  if (clientOverride) return clientOverride;
  const current = state();
  current.client ??= createClient().catch(error => {
    current.client = undefined;
    throw error instanceof GoogleTtsProviderError ? error : new GoogleTtsProviderError("not_configured");
  });
  return current.client;
}

function limiter() {
  const current = state();
  current.limiter ??= createConcurrencyLimiter({
    maxConcurrent: positiveInteger("GOOGLE_TTS_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY),
    maxWaitMs: positiveInteger("GOOGLE_TTS_QUEUE_WAIT_MS", DEFAULT_QUEUE_WAIT_MS),
  });
  return current.limiter;
}

async function acquireSlot(signal?: AbortSignal): Promise<ReleaseSlot> {
  try {
    return await limiter().acquire(signal);
  } catch (error) {
    throw new GoogleTtsProviderError(error instanceof ConcurrencyLimitTimeoutError ? "queue_timeout" : "network_error");
  }
}

/** Maps a gRPC failure; its message is never kept (it may echo the text). */
function fromGrpc(error: unknown): GoogleTtsProviderError {
  if (error instanceof GoogleTtsProviderError) return error;
  const code = typeof (error as { code?: unknown })?.code === "number" ? (error as { code: number }).code : undefined;
  switch (code) {
    case GRPC_RESOURCE_EXHAUSTED: return new GoogleTtsProviderError("rate_limited", code);
    case GRPC_DEADLINE_EXCEEDED: return new GoogleTtsProviderError("timeout", code);
    case GRPC_UNAUTHENTICATED:
    case GRPC_PERMISSION_DENIED: return new GoogleTtsProviderError("not_configured", code);
    case GRPC_CANCELLED:
    case GRPC_UNAVAILABLE: return new GoogleTtsProviderError("network_error", code);
    default: return new GoogleTtsProviderError("provider_error", code);
  }
}

function toBytes(content: AudioContent): Uint8Array {
  if (typeof content === "string") return Buffer.from(content, "base64");
  return content ?? new Uint8Array();
}

function concatBytes(head: Uint8Array, tail: Uint8Array) {
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head, 0);
  joined.set(tail, head.byteLength);
  return joined;
}

export type GoogleSpeechStream = Readonly<{
  /** Chunks always hold whole 16-bit samples (even byte lengths). */
  pcm: ReadableStream<Uint8Array>;
  sampleRate: number;
  model: string;
  voice: string;
}>;

/**
 * StreamingSynthesize: sends the config, then the text, then half-closes; resolves at
 * the first audio. One deadline covers the whole stream, and the concurrency slot is
 * held until the stream ends, fails or is cancelled.
 */
export async function streamSpeechWithGoogle(
  text: string,
  language: string,
  options: { signal?: AbortSignal } = {},
): Promise<GoogleSpeechStream> {
  const voice = voiceFor(language, "stream");
  // Google would refuse the call; the clip path serves these voices.
  if (!googleTtsCanStream()) throw new GoogleTtsProviderError("invalid_voice");
  const release = await acquireSlot(options.signal);
  let call: Duplex;
  try {
    call = (await googleClient()).streamingSynthesize();
  } catch (error) {
    release();
    throw fromGrpc(error);
  }

  return new Promise<GoogleSpeechStream>((resolve, reject) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let opened = false;
    let finished = false;
    let received = 0;
    let carry: Uint8Array | undefined;

    const pcm = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      pull() { call.resume(); },
      cancel() { settle(); call.destroy(); },
    });

    const deadline = setTimeout(() => fail(new GoogleTtsProviderError("timeout")),
      positiveInteger("GOOGLE_TTS_STREAM_TIMEOUT_MS", DEFAULT_STREAM_TIMEOUT_MS));
    const onAbort = () => fail(new GoogleTtsProviderError("network_error"));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function settle() {
      if (finished) return false;
      finished = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      release();
      return true;
    }

    function fail(error: GoogleTtsProviderError) {
      if (!settle()) return;
      call.destroy();
      if (opened) controller.error(error); else reject(error);
    }

    call.on("data", (response: { audioContent?: AudioContent }) => {
      if (finished) return;
      const chunk = toBytes(response.audioContent);
      received += chunk.byteLength;
      if (received > MAX_PCM_BYTES) return fail(new GoogleTtsProviderError("invalid_response"));
      const bytes = carry ? concatBytes(carry, chunk) : chunk;
      const whole = bytes.byteLength - (bytes.byteLength % PCM_BYTES_PER_SAMPLE);
      carry = whole < bytes.byteLength ? bytes.slice(whole) : undefined;
      if (whole === 0) return;
      controller.enqueue(whole === bytes.byteLength ? bytes : bytes.subarray(0, whole));
      if (!opened) {
        opened = true;
        resolve({ pcm, sampleRate: GOOGLE_TTS_SAMPLE_RATE, model: GOOGLE_TTS_MODEL, voice: voice.name });
      }
      if ((controller.desiredSize ?? 1) <= 0) call.pause();
    });
    // Stays attached after settling: a late error from a destroyed call must not crash.
    call.on("error", error => fail(fromGrpc(error)));
    call.on("end", () => {
      if (!opened) return fail(new GoogleTtsProviderError("empty_response"));
      if (settle()) controller.close();
    });
    // Closed without 'end' or 'error' (destroyed underneath us): fail now, not at the deadline.
    call.on("close", () => fail(new GoogleTtsProviderError("network_error")));
    // The signal may have aborted while the client was starting, before the listener existed.
    if (options.signal?.aborted) return onAbort();

    call.write({
      streamingConfig: {
        voice,
        streamingAudioConfig: { audioEncoding: "PCM", sampleRateHertz: GOOGLE_TTS_SAMPLE_RATE },
      },
    });
    call.write({ input: { text } });
    call.end();
  });
}

export type GoogleSpeechFormat = "mp3" | "wav";

/** SynthesizeSpeech: a finished MP3 clip, or a WAV clip (header included) at the stream's rate. */
export async function synthesizeWithGoogle(
  text: string,
  language: string,
  options: { format?: GoogleSpeechFormat; signal?: AbortSignal } = {},
): Promise<ArrayBuffer> {
  // A WAV clip stands in for a stream: the stream's voice unless a fallback voice is set.
  const voice = voiceFor(language, options.format === "wav" ? "fallback" : "clip");
  const release = await acquireSlot(options.signal);
  try {
    const client = await googleClient();
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice,
      audioConfig: options.format === "wav"
        ? { audioEncoding: "LINEAR16", sampleRateHertz: GOOGLE_TTS_SAMPLE_RATE }
        : { audioEncoding: "MP3" },
    }, { timeout: positiveInteger("GOOGLE_TTS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS) });
    const audio = toBytes(response.audioContent);
    if (audio.byteLength === 0 || audio.byteLength > MAX_CLIP_BYTES) throw new GoogleTtsProviderError("invalid_response");
    return audio.slice().buffer;
  } catch (error) {
    throw fromGrpc(error);
  } finally {
    release();
  }
}

/** Google is refusing work (project quota or full local queue): trying again now hits the same wall. */
export function isGoogleTtsBusy(error: unknown) {
  return error instanceof GoogleTtsProviderError && (error.reason === "rate_limited" || error.reason === "queue_timeout");
}

/** Google itself refused (RESOURCE_EXHAUSTED), not the local queue: another voice's quota may still allow it. */
export function isGoogleTtsRateLimited(error: unknown) {
  return error instanceof GoogleTtsProviderError && error.reason === "rate_limited";
}

function statusFor(error: GoogleTtsProviderError) {
  switch (error.reason) {
    case "not_configured": return 503;
    case "invalid_voice":
    case "unsupported_language": return 500;
    case "timeout": return 504;
    case "rate_limited":
    case "queue_timeout": return 429;
    default: return 502;
  }
}

/** Public error for a failed Google speech request; other errors pass through unchanged. */
export function toGoogleTtsAppError(error: unknown) {
  if (!(error instanceof GoogleTtsProviderError)) return error;
  return new AppError("TTS_FAILED", "Chưa tạo được giọng đọc bản dịch.", statusFor(error), {
    provider: "google",
    stage: "tts",
    reason: error.reason,
    ...(error.grpcCode !== undefined ? { grpcCode: error.grpcCode } : {}),
  });
}
