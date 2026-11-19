import { AppError } from "@/lib/appError";
import { pcmStreamToWav } from "@/lib/audio/wav";
import {
  getConfiguredTtsProfile,
  requestEnglishSpeech,
  type EnglishSpeechResult,
  type TtsProfile,
} from "./aiProvider";
import {
  GOOGLE_TTS_MODEL,
  googleTtsCanStream,
  googleTtsVoice,
  streamSpeechWithGoogle,
  synthesizeWithGoogle,
  toGoogleTtsAppError,
  type GoogleVoiceKind,
} from "./googleTts";
import { ttsSourceFor } from "./ttsSource";

/**
 * The voice of an English sentence (GET /api/audio/stream).
 * AUDIO_ENGLISH_TTS_PROVIDER=cloudflare (default): Cloudflare Workers AI aura-1, as before.
 * AUDIO_ENGLISH_TTS_PROVIDER=google:
 * - a short sentence (about 1-3 s, under AUDIO_ENGLISH_STREAM_MIN_CHARS) is a finished
 *   MP3 clip in GOOGLE_TTS_CLIP_VOICE_EN (e.g. Neural2-F);
 * - a longer one streams GOOGLE_TTS_VOICE (Chirp 3 HD) as WAV while it is generated.
 * A stream Google refuses becomes a clip; a clip Google refuses is spoken by Cloudflare.
 */

export type EnglishTtsProvider = "cloudflare" | "google";
export type EnglishSpeechMode = "clip" | "stream";

const ENGLISH_TTS_PROVIDERS: ReadonlySet<string> = new Set(["cloudflare", "google"]);
const GOOGLE_LANGUAGE = "en";
// Measured 2026-11-18: en-US Neural2 reads ~16 characters a second; 50 characters is ~3 s.
const DEFAULT_STREAM_MIN_CHARS = 50;

export function englishTtsProvider(): EnglishTtsProvider {
  const configured = process.env.AUDIO_ENGLISH_TTS_PROVIDER?.trim().toLowerCase() || "cloudflare";
  if (!ENGLISH_TTS_PROVIDERS.has(configured)) {
    throw new AppError("TTS_FAILED", "Cấu hình nhà cung cấp AI không hợp lệ.", 500,
      { reason: "invalid_provider", setting: "AUDIO_ENGLISH_TTS_PROVIDER" });
  }
  return configured as EnglishTtsProvider;
}

function streamMinChars() {
  const value = Number(process.env.AUDIO_ENGLISH_STREAM_MIN_CHARS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_STREAM_MIN_CHARS;
}

/** Characters as the audio cache sees the sentence (NFKC, collapsed whitespace). */
function spokenLength(text: string) {
  return Array.from(text.normalize("NFKC").replace(/\s+/g, " ").trim()).length;
}

/** Google only: whether this sentence streams. A voice that cannot stream always makes clips. */
export function englishSpeechMode(text: string): EnglishSpeechMode {
  if (!googleTtsCanStream()) return "clip";
  return spokenLength(text) >= streamMinChars() ? "stream" : "clip";
}

function googleProfile(kind: GoogleVoiceKind): TtsProfile {
  return {
    provider: "google",
    model: GOOGLE_TTS_MODEL,
    // The language stays in the voice, as for zh/ja/ko/fr, so caches never mix languages.
    voice: `${googleTtsVoice(GOOGLE_LANGUAGE, kind)}-${GOOGLE_LANGUAGE}`,
    speed: 1,
    extension: kind === "stream" ? "wav" : "mp3",
  };
}

/** Cache identity of a sentence's speech. Without a sentence: the clip profile. */
export function getEnglishTtsProfile(text?: string): TtsProfile {
  if (englishTtsProvider() === "cloudflare") return getConfiguredTtsProfile();
  return googleProfile(text !== undefined && englishSpeechMode(text) === "stream" ? "stream" : "clip");
}

/**
 * What this sentence may have been spoken (and cached) as when its first choice failed:
 * a refused stream became a clip, a failed clip became Cloudflare. Empty with Cloudflare.
 */
export function englishSpeechFallbackProfiles(text: string): TtsProfile[] {
  if (englishTtsProvider() === "cloudflare") return [];
  const fallbacks = englishSpeechMode(text) === "stream" ? [googleProfile("clip")] : [];
  if (!cloudflareFallbackEnabled()) return fallbacks;
  try {
    return [...fallbacks, getConfiguredTtsProfile()];
  } catch {
    // Cloudflare is not configured, so nothing was ever spoken by it.
    return fallbacks;
  }
}

function speechResponse(body: BodyInit, contentType: string, profile: TtsProfile): EnglishSpeechResult {
  return {
    response: new Response(body, { headers: { "Content-Type": contentType } }),
    source: ttsSourceFor(profile.provider),
    profile,
  };
}

async function googleStream(text: string): Promise<EnglishSpeechResult> {
  // Resolves at the first audio: a refusal (429, timeout) arrives here, before any byte.
  const speech = await streamSpeechWithGoogle(text, GOOGLE_LANGUAGE);
  return speechResponse(pcmStreamToWav(speech.pcm, speech.sampleRate), "audio/wav", googleProfile("stream"));
}

async function googleClip(text: string): Promise<EnglishSpeechResult> {
  const audio = await synthesizeWithGoogle(text, GOOGLE_LANGUAGE);
  return speechResponse(audio, "audio/mpeg", googleProfile("clip"));
}

/**
 * Loaded only when a fallback happens: observability is server-only, and tts.ts (which
 * imports this module) is also used by plain Node tests. Logging must never fail speech.
 */
function logFallback(from: string, to: string, error: unknown) {
  void import("@/lib/observability")
    .then(({ logEvent }) => logEvent("warn", "english_speech_provider_fallback", {
      from, to, error: toGoogleTtsAppError(error),
    }))
    .catch(() => undefined);
}

/** The provider response for one English sentence; its profile says what was actually spoken. */
export async function requestEnglishSpeechAudio(text: string): Promise<EnglishSpeechResult> {
  if (englishTtsProvider() === "cloudflare") return requestEnglishSpeech(text, getConfiguredTtsProfile());
  if (englishSpeechMode(text) === "stream") {
    try {
      return await googleStream(text);
    } catch (error) {
      logFallback("google_stream", "google_clip", error);
    }
  }
  try {
    return await googleClip(text);
  } catch (error) {
    // No Cloudflare for English: the request fails and the app speaks with the device voice.
    if (!cloudflareFallbackEnabled()) throw toGoogleTtsAppError(error);
    logFallback("google_clip", "cloudflare", error);
  }
  return requestEnglishSpeech(text, getConfiguredTtsProfile());
}

/** AUDIO_ENGLISH_CLOUDFLARE_FALLBACK=false: Google failures are never spoken by Cloudflare. */
function cloudflareFallbackEnabled() {
  return process.env.AUDIO_ENGLISH_CLOUDFLARE_FALLBACK?.trim().toLowerCase() !== "false";
}
