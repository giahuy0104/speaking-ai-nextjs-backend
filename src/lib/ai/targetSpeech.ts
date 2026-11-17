import { logEvent } from "@/lib/observability";
import { saveReusableAudio, type ReusableAudioDescriptor } from "@/lib/storage/audio";
import { getTargetTtsProfile, requestTargetSpeech, targetTtsProvider, type TargetSpeechLanguage } from "./aiProvider";
import { createTargetSpeechCoordinator } from "./targetSpeechCoordinator";
import { isDeepInfraBusy, streamSpeechWithDeepInfra, synthesizeWithDeepInfra, toDeepInfraTtsAppError } from "./deepInfra";
import { createTargetSpeechStreams } from "./targetSpeechStreams";
import { targetSpeechModeFor, type TargetSpeechMode } from "./targetSpeechMode";

/**
 * Cache identity of a translated sentence's speech (provider model + voice per language).
 * Streamed speech is uncompressed WAV, so it is cached apart from the MP3 clips.
 */
export function targetSpeechDescriptor(language: TargetSpeechLanguage, text: string): ReusableAudioDescriptor {
  const profile = getTargetTtsProfile(language);
  return {
    text: text.normalize("NFKC").replace(/\s+/g, " ").trim(),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: targetSpeechMode(language, text) === "stream" ? "wav" : profile.extension,
  };
}

/**
 * AUDIO_TARGET_TTS_DEFERRED=true returns the translation before its speech exists:
 * the response carries a signed /api/audio/target URL and synthesis starts at once.
 * Only with DeepInfra; the Cloudflare voice currently fails, and a deferred URL that
 * fails leaves the app without its device-speech fallback.
 */
export function isTargetSpeechDeferred() {
  return process.env.AUDIO_TARGET_TTS_DEFERRED?.trim().toLowerCase() === "true" && targetTtsProvider() === "deepinfra";
}

/**
 * AUDIO_TARGET_TTS_STREAM=true (with deferred speech): synthesis goes through
 * DeepInfra's streaming endpoint and its PCM is sent on as WAV without encoding,
 * so the app's /api/audio/target request starts playing before the clip is finished.
 */
export function isTargetSpeechStreaming() {
  return isTargetSpeechDeferred() && process.env.AUDIO_TARGET_TTS_STREAM?.trim().toLowerCase() === "true";
}

/**
 * With streaming on, only long sentences stream (WAV); short ones are a finished
 * MP3 clip (see targetSpeechMode.ts). Without streaming every sentence is a clip.
 */
export function targetSpeechMode(language: string, text: string): TargetSpeechMode {
  return targetSpeechModeFor(language, text, { streaming: isTargetSpeechStreaming() });
}

async function finishedWavSpeech(text: string) {
  try {
    return (await synthesizeWithDeepInfra(text, { format: "wav" })).audio;
  } catch (error) {
    throw toDeepInfraTtsAppError(error);
  }
}

const targetSpeechStreams = createTargetSpeechStreams({
  openPcm: streamSpeechWithDeepInfra,
  // Same format as the stream, so listeners and the cache never mix WAV and MP3.
  fallback: text => finishedWavSpeech(text),
  // A busy account would refuse the finished clip too, after another wait in the queue.
  shouldFallback: error => !isDeepInfraBusy(error),
  toPublicError: toDeepInfraTtsAppError,
  log: (level, event, fields) => logEvent(level, event, fields),
});

/** WAV from its first byte while synthesis is still running; null once it has settled. */
export function subscribeTargetSpeech(text: string, language: TargetSpeechLanguage) {
  return targetSpeechStreams.subscribe(text, language);
}

// Load tests (k6 installations with LOAD_TEST_BYPASS_AUDIO_CACHE): each turn gets its
// own synthesis, keyed by a job id in its signed URL. It never reads or writes the
// cache and never joins or shares another turn's synthesis. Kept briefly so the
// app's second download of the same URL gets the same clip.
// The app's second download follows the first within seconds of playback.
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
    : requestTargetSpeech(text, language);
  uncachedJobs.set(jobId, job);
  const forget = () => {
    const timer = setTimeout(() => {
      if (uncachedJobs.get(jobId) === job) uncachedJobs.delete(jobId);
    }, UNCACHED_JOB_RETAIN_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  job.then(forget, () => uncachedJobs.delete(jobId));
  return job;
}

/** The live WAV of a load-test turn, from its first byte; null once it has settled. */
export function subscribeUncachedTargetSpeech(jobId: string) {
  return targetSpeechStreams.subscribeKey(uncachedKey(jobId));
}

export const targetSpeech = createTargetSpeechCoordinator({
  synthesize: (text, language) => targetSpeechMode(language, text) === "stream"
    ? targetSpeechStreams.start(text, language)
    : requestTargetSpeech(text, language as TargetSpeechLanguage),
  save: (text, language, audio) => saveReusableAudio(targetSpeechDescriptor(language as TargetSpeechLanguage, text), audio),
  onSaveError: error => logEvent("error", "target_speech_cache_save_failed", { error }),
});
