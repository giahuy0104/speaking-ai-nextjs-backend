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
 * Sentences whose stream was replaced by a clip in another voice (e.g. WaveNet while
 * Chirp 3 HD is rate limited). That clip is served but never cached: the cache key
 * names the stream's voice, and the next request should get Chirp 3 HD again.
 */
const spokenByFallbackVoice = new Set<string>();

const targetSpeechStreams = createTargetSpeechStreams({
  openPcm: (text, language) => activeStreamProvider().openPcm(text, language),
  // Same format as the stream, so listeners and the cache never mix WAV and MP3.
  fallback: (text, language) => activeStreamProvider().fallback(text, language),
  shouldFallback: (error, language) => activeStreamProvider().canFallback(error, language),
  onFallback: (text, language) => {
    if (!activeStreamProvider().fallbackKeepsVoice(language)) spokenByFallbackVoice.add(sentenceKey(text, language));
  },
  toPublicError: error => activeStreamProvider().toPublicError(error),
  log: (level, event, fields) => logEvent(level, event, fields),
});

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
  // A failure is kept too: the app's second download of a failed turn gets the same
  // error at once instead of paying for (and queueing) another synthesis.
  const forget = () => {
    const timer = setTimeout(() => {
      if (uncachedJobs.get(jobId) === job) uncachedJobs.delete(jobId);
    }, UNCACHED_JOB_RETAIN_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  job.then(forget, forget);
  return job;
}

/** The live WAV of a load-test turn once its first byte exists (see subscribeTargetSpeech). */
export function subscribeUncachedTargetSpeech(jobId: string) {
  return targetSpeechStreams.subscribeKeyWhenAudible(uncachedKey(jobId));
}

export const targetSpeech = createTargetSpeechCoordinator({
  synthesize: (text, language) => {
    if (targetSpeechMode(language, text) !== "stream") {
      return requestTargetSpeech(text, language as TargetSpeechLanguage, { onClipFallback: clipFallbackLogger(language) });
    }
    const key = sentenceKey(text, language);
    spokenByFallbackVoice.delete(key);
    const job = targetSpeechStreams.start(text, language);
    // A failed job is never saved, so its mark would otherwise stay.
    job.catch(() => spokenByFallbackVoice.delete(key));
    return job;
  },
  save: async (text, language, audio) => {
    if (spokenByFallbackVoice.delete(sentenceKey(text, language))) return;
    await saveReusableAudio(targetSpeechDescriptor(language as TargetSpeechLanguage, text), audio);
  },
  onSaveError: error => logEvent("error", "target_speech_cache_save_failed", { error }),
});
