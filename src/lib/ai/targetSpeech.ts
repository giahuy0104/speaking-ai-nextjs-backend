import { logEvent } from "@/lib/observability";
import { saveReusableAudio, type ReusableAudioDescriptor } from "@/lib/storage/audio";
import { getTargetTtsProfile, requestTargetSpeech, targetTtsProvider, type TargetSpeechLanguage } from "./aiProvider";
import { createTargetSpeechCoordinator } from "./targetSpeechCoordinator";
import { streamSpeechWithDeepInfra, synthesizeWithDeepInfra, toDeepInfraTtsAppError } from "./deepInfra";
import { createTargetSpeechStreams } from "./targetSpeechStreams";

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
    extension: isTargetSpeechStreaming() ? "wav" : profile.extension,
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
  toPublicError: toDeepInfraTtsAppError,
  log: (level, event, fields) => logEvent(level, event, fields),
});

/** WAV from its first byte while synthesis is still running; null once it has settled. */
export function subscribeTargetSpeech(text: string, language: TargetSpeechLanguage) {
  return targetSpeechStreams.subscribe(text, language);
}

export const targetSpeech = createTargetSpeechCoordinator({
  synthesize: (text, language) => isTargetSpeechStreaming()
    ? targetSpeechStreams.start(text, language)
    : requestTargetSpeech(text, language as TargetSpeechLanguage),
  save: (text, language, audio) => saveReusableAudio(targetSpeechDescriptor(language as TargetSpeechLanguage, text), audio),
  onSaveError: error => logEvent("error", "target_speech_cache_save_failed", { error }),
});
