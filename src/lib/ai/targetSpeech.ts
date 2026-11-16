import { logEvent } from "@/lib/observability";
import { saveReusableAudio, type ReusableAudioDescriptor } from "@/lib/storage/audio";
import { getTargetTtsProfile, requestTargetSpeech, targetTtsProvider, type TargetSpeechLanguage } from "./aiProvider";
import { createTargetSpeechCoordinator } from "./targetSpeechCoordinator";

/** Cache identity of a translated sentence's speech (provider model + voice per language). */
export function targetSpeechDescriptor(language: TargetSpeechLanguage, text: string): ReusableAudioDescriptor {
  const profile = getTargetTtsProfile(language);
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
 * Only with DeepInfra; the Cloudflare voice currently fails, and a deferred URL that
 * fails leaves the app without its device-speech fallback.
 */
export function isTargetSpeechDeferred() {
  return process.env.AUDIO_TARGET_TTS_DEFERRED?.trim().toLowerCase() === "true" && targetTtsProvider() === "deepinfra";
}

export const targetSpeech = createTargetSpeechCoordinator({
  synthesize: (text, language) => requestTargetSpeech(text, language as TargetSpeechLanguage),
  save: (text, language, audio) => saveReusableAudio(targetSpeechDescriptor(language as TargetSpeechLanguage, text), audio),
  onSaveError: error => logEvent("error", "target_speech_cache_save_failed", { error }),
});
