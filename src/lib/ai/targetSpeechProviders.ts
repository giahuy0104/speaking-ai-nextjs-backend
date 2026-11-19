import { isDeepInfraBusy, streamSpeechWithDeepInfra, synthesizeWithDeepInfra, toDeepInfraTtsAppError } from "./deepInfra";
import {
  googleTtsCanStream,
  googleTtsFallbackChangesVoice,
  isGoogleTtsBusy,
  isGoogleTtsRateLimited,
  streamSpeechWithGoogle,
  synthesizeWithGoogle,
  toGoogleTtsAppError,
} from "./googleTts";
import type { PcmSpeech } from "./targetSpeechStreams";

/** The providers whose speech can stream (AUDIO_TARGET_TTS_STREAM=true). */
export type StreamingSpeechProvider = "deepinfra" | "google";

export type SpeechStreamProvider = Readonly<{
  openPcm: (text: string, language: string) => Promise<PcmSpeech>;
  /** A finished WAV clip in the stream's format, for a stream that fails before its first byte. */
  fallback: (text: string, language: string) => Promise<ArrayBuffer>;
  /** Whether `fallback` can still succeed after this stream error (false: it would hit the same limit). */
  canFallback: (error: unknown, language: string) => boolean;
  /** Whether `fallback` speaks with the stream's voice, so its clip may be cached as the stream's. */
  fallbackKeepsVoice: (language: string) => boolean;
  toPublicError: (error: unknown) => unknown;
  /** Whether this language's voice can stream; otherwise its speech is a finished clip. */
  canStream: (language: string) => boolean;
}>;

const PROVIDERS: Readonly<Record<StreamingSpeechProvider, SpeechStreamProvider>> = {
  deepinfra: {
    openPcm: (text, language) => streamSpeechWithDeepInfra(text, language),
    fallback: async text => {
      try {
        return (await synthesizeWithDeepInfra(text, { format: "wav" })).audio;
      } catch (error) {
        throw toDeepInfraTtsAppError(error);
      }
    },
    canFallback: error => !isDeepInfraBusy(error),
    fallbackKeepsVoice: () => true,
    toPublicError: toDeepInfraTtsAppError,
    canStream: () => true,
  },
  google: {
    openPcm: (text, language) => streamSpeechWithGoogle(text, language),
    fallback: async (text, language) => {
      try {
        return await synthesizeWithGoogle(text, language, { format: "wav" });
      } catch (error) {
        throw toGoogleTtsAppError(error);
      }
    },
    // Google's 429 for Chirp 3 HD leaves a fallback voice (Neural2/WaveNet, its own quota)
    // usable. A full local queue does not: the stand-in would wait in the same queue.
    canFallback: (error, language) =>
      !isGoogleTtsBusy(error) || (isGoogleTtsRateLimited(error) && googleTtsFallbackChangesVoice(language)),
    fallbackKeepsVoice: language => !googleTtsFallbackChangesVoice(language),
    toPublicError: toGoogleTtsAppError,
    canStream: () => googleTtsCanStream(),
  },
};

export function speechStreamProvider(provider: StreamingSpeechProvider): SpeechStreamProvider {
  return PROVIDERS[provider];
}
