import {
  getReusableAudioUrl,
  saveReusableAudio,
} from "@/lib/storage/audio";
import {
  getTargetTtsProfile,
  requestTargetSpeech,
  type TargetSpeechLanguage,
} from "./aiProvider";

function descriptor(text: string, language: TargetSpeechLanguage) {
  const profile = getTargetTtsProfile(language);
  return {
    text: text.normalize("NFKC").replace(/\s+/g, " ").trim(),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: profile.extension,
  };
}

export function getTargetAudioStreamUrl(
  text: string,
  language: TargetSpeechLanguage,
) {
  const parameters = new URLSearchParams({ text, lang: language });
  return `/api/audio/target?${parameters}`;
}

export function getTargetAudioCacheUrl(
  text: string,
  language: TargetSpeechLanguage,
) {
  return getReusableAudioUrl(descriptor(text, language));
}

export async function createTargetAudio(
  text: string,
  language: TargetSpeechLanguage,
) {
  return requestTargetSpeech(text, language);
}

export function saveTargetAudio(
  text: string,
  language: TargetSpeechLanguage,
  audio: ArrayBuffer,
) {
  return saveReusableAudio(descriptor(text, language), audio);
}
