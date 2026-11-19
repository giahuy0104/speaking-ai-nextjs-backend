import { AppError } from "@/lib/appError";
import { logEvent } from "@/lib/observability";
import { saveReusableAudio, type ReusableAudioDescriptor } from "@/lib/storage/audio";
import { getTargetTtsProfile, requestTargetSpeech, targetTtsProvider, type TargetSpeechLanguage } from "./aiProvider";
import { createTargetSpeechCoordinator } from "./targetSpeechCoordinator";
import { createTargetSpeechStreams } from "./targetSpeechStreams";
import { speechStreamProvider, type StreamingSpeechProvider } from "./targetSpeechProviders";
import { targetSpeechModeFor, type TargetSpeechMode } from "./targetSpeechMode";

/**
 * Cache identity of a translated sentence's speech (provider model + voice per language).
 * Streamed speech is uncompressed WAV, so it is cached apart from the MP3 clips.
 */
export function targetSpeechDescriptor(language: TargetSpeechLanguage, text: string): ReusableAudioDescriptor {
  const mode = targetSpeechMode(language, text);
  // Google: a clip may use another voice than a stream, and the cache must say which.
  const profile = getTargetTtsProfile(language, mode === "stream" ? "stream" : "clip", text);
  return {
    text: text.normalize("NFKC").replace(/\s+/g, " ").trim(),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: mode === "stream" ? "wav" : profile.extension,
  };
}

/** Cache identity of a short clip Google spoke (without text, the profile skips the DeepInfra share). */
export function googleClipDescriptor(language: TargetSpeechLanguage, text: string): ReusableAudioDescriptor {
  const profile = getTargetTtsProfile(language, "clip");
  return {
    text: text.normalize("NFKC").replace(/\s+/g, " ").trim(),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: profile.extension,
  };
}

/**
 * AUDIO_TARGET_TTS_DEFERRED=true returns the translation before its speech exists:
 * the response carries a signed /api/audio/target URL and synthesis starts at once.
 * Only with DeepInfra or Google; the Cloudflare voice currently fails, and a deferred
 * URL that fails leaves the app without its device-speech fallback.
 */
export function isTargetSpeechDeferred() {
  return process.env.AUDIO_TARGET_TTS_DEFERRED?.trim().toLowerCase() === "true" && streamingProvider() !== undefined;
}

/** The configured provider when its speech can be deferred and streamed. */
function streamingProvider(): StreamingSpeechProvider | undefined {
  const provider = targetTtsProvider();
  return provider === "deepinfra" || provider === "google" ? provider : undefined;
}

/**
 * AUDIO_TARGET_TTS_STREAM=true (with deferred speech): synthesis goes through the
 * provider's streaming API (DeepInfra's stream endpoint, Google's StreamingSynthesize)
 * and its PCM is sent on as WAV without encoding, so the app's /api/audio/target
 * request starts playing before the clip is finished.
 */
export function isTargetSpeechStreaming() {
  return isTargetSpeechDeferred() && process.env.AUDIO_TARGET_TTS_STREAM?.trim().toLowerCase() === "true";
}

/**
 * With streaming on, only long sentences stream (WAV); short ones are a finished
 * MP3 clip (see targetSpeechMode.ts). Without streaming every sentence is a clip.
 */
export function targetSpeechMode(language: string, text: string): TargetSpeechMode {
  // A voice that cannot stream (Google Neural2...) always serves a finished clip.
  const streaming = isTargetSpeechStreaming() && activeStreamProvider().canStream(language);
  return targetSpeechModeFor(language, text, { streaming });
}

/** Streams only run while a streaming provider is configured (see isTargetSpeechDeferred). */
const activeStreamProvider = () => speechStreamProvider(streamingProvider() ?? "deepinfra");

const sentenceKey = (text: string, language: string) => `${language}\n${text}`;

/**
 * Sentences spoken by another voice than their cache key names: a stream replaced by
 * a fallback clip (e.g. WaveNet while Chirp 3 HD is rate limited), or a DeepInfra clip
 * that Google spoke because DeepInfra was busy. That audio is served but never cached,
 * so the next request gets the intended voice again.
 */
const spokenByFallbackVoice = new Set<string>();

/** How many sentences are marked as spoken by a fallback voice (each must be cleared). */
export function fallbackVoiceMarkCountForTests() {
  return spokenByFallbackVoice.size;
}

const targetSpeechStreams = createTargetSpeechStreams({
  openPcm: (text, language) => activeStreamProvider().openPcm(text, language),
  // Same format as the stream, so listeners and the cache never mix WAV and MP3.
  fallback: (text, language) => activeStreamProvider().fallback(text, language),
  shouldFallback: (error, language) => activeStreamProvider().canFallback(error, language),
  // Only the coordinator's job reaches save(), which clears the mark. A load-test turn
  // (its own key) is never saved, so marking it would leak one entry per turn.
  onFallback: (text, language, { shared }) => {
    if (shared && !activeStreamProvider().fallbackKeepsVoice(language)) spokenByFallbackVoice.add(sentenceKey(text, language));
  },
  toPublicError: error => activeStreamProvider().toPublicError(error),
  log: (level, event, fields) => logEvent(level, event, fields),
});

/** Whether this language can stream with the configured provider (segmented speech). */
export function canStreamSpeech(language: string) {
  return isTargetSpeechStreaming() && activeStreamProvider().canStream(language);
}

/**
 * One streamed synthesis under its own key (a segment of segmentedSpeech.ts): never
 * cached and never joined by another sentence. Resolves with the whole WAV.
 */
export function startKeyedSpeechStream(key: string, text: string, language: string): Promise<ArrayBuffer> {
  return targetSpeechStreams.start(text, language, key);
}

/** The live WAV of a keyed stream; null once it has settled. */
export function subscribeKeyedSpeechStream(key: string) {
  return targetSpeechStreams.subscribeKey(key);
}

/**
 * WAV from its first byte while synthesis is still running; null once it has settled.
 * Resolves only when the first byte exists and rejects when the speech fails before
 * it, so the route can still answer with an HTTP error instead of a broken 200.
 */
export function subscribeTargetSpeech(text: string, language: TargetSpeechLanguage) {
  return targetSpeechStreams.subscribeWhenAudible(text, language);
}

// Load tests (k6 installations with LOAD_TEST_BYPASS_AUDIO_CACHE): each turn gets its
// own synthesis, keyed by a job id in its signed URL. It never reads or writes the
// cache and never joins or shares another turn's synthesis. Kept briefly so the
// app's second download of the same URL gets the same clip.
// The app's second download follows the first within seconds of playback.
/** A clip routed to DeepInfra that Google spoke instead (DeepInfra busy or failing). */
const clipFallbackLogger = (language: string) => (error: unknown) =>
  logEvent("warn", "target_speech_clip_provider_fallback", { language, from: "deepinfra", to: "google", error });

/**
 * A provider refusing work: Google rate limited, DeepInfra over its account limit, or
 * a full local queue. Both providers answer these with HTTP 429 (and only these), so
 * asking again right away would be refused again.
 */
function isProviderRefusal(error: unknown) {
  return error instanceof AppError && error.status === 429;
}

const UNCACHED_JOB_RETAIN_MS = 20_000;
const MAX_UNCACHED_JOBS = 1_000;
const uncachedJobs = new Map<string, Promise<ArrayBuffer>>();

const uncachedKey = (jobId: string) => `uncached\n${jobId}`;

/** Starts (or joins) the uncached synthesis of one load-test turn. */
export function startUncachedTargetSpeech(jobId: string, text: string, language: TargetSpeechLanguage): Promise<ArrayBuffer> {
  const existing = uncachedJobs.get(jobId);
  if (existing) return existing;
  if (uncachedJobs.size >= MAX_UNCACHED_JOBS) {
    const oldest = uncachedJobs.keys().next().value;
    if (oldest !== undefined) uncachedJobs.delete(oldest);
  }
  const job = targetSpeechMode(language, text) === "stream"
    ? targetSpeechStreams.start(text, language, uncachedKey(jobId))
    : requestTargetSpeech(text, language, { onClipFallback: clipFallbackLogger(language) });
  uncachedJobs.set(jobId, job);
  const forgetNow = () => {
    if (uncachedJobs.get(jobId) === job) uncachedJobs.delete(jobId);
  };
  const forgetLater = () => {
    const timer = setTimeout(forgetNow, UNCACHED_JOB_RETAIN_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  // A refusal is kept too: the app's second download of a refused turn gets the same
  // error at once instead of asking the busy provider again. Other failures retry.
  job.then(forgetLater, error => (isProviderRefusal(error) ? forgetLater() : forgetNow()));
  return job;
}

/** The live WAV of a load-test turn once its first byte exists (see subscribeTargetSpeech). */
export function subscribeUncachedTargetSpeech(jobId: string) {
  return targetSpeechStreams.subscribeKeyWhenAudible(uncachedKey(jobId));
}

export const targetSpeech = createTargetSpeechCoordinator({
  synthesize: (text, language) => {
    const key = sentenceKey(text, language);
    spokenByFallbackVoice.delete(key);
    const job = targetSpeechMode(language, text) === "stream"
      ? targetSpeechStreams.start(text, language)
      : requestTargetSpeech(text, language as TargetSpeechLanguage, {
        onClipFallback: error => {
          clipFallbackLogger(language)(error);
          // The cache key names DeepInfra's voice; Google spoke this clip.
          spokenByFallbackVoice.add(key);
        },
      });
    // A failed job is never saved, so its mark would otherwise stay.
    job.catch(() => spokenByFallbackVoice.delete(key));
    return job;
  },
  save: async (text, language, audio) => {
    if (spokenByFallbackVoice.delete(sentenceKey(text, language))) return;
    await saveReusableAudio(targetSpeechDescriptor(language as TargetSpeechLanguage, text), audio);
  },
  onSaveError: error => logEvent("error", "target_speech_cache_save_failed", { error }),
  // Keep only refusals; a timeout or network error is retried by the next request.
  shouldRetainFailure: isProviderRefusal,
});
