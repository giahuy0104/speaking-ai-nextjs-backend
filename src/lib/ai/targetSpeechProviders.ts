import { isDeepInfraBusy, streamSpeechWithDeepInfra, synthesizeWithDeepInfra, toDeepInfraTtsAppError } from "./deepInfra";
import { googleTtsCanStream, isGoogleTtsBusy, streamSpeechWithGoogle, synthesizeWithGoogle, toGoogleTtsAppError } from "./googleTts";
import type { PcmSpeech } from "./targetSpeechStreams";

/** The providers whose speech can stream (AUDIO_TARGET_TTS_STREAM=true). */
export type StreamingSpeechProvider = "deepinfra" | "google";

export type SpeechStreamProvider = Readonly<{
  openPcm: (text: string, language: string) => Promise<PcmSpeech>;
  /** A finished WAV clip in the stream's format, for a stream that fails before its first byte. */
  fallback: (text: string, language: string) => Promise<ArrayBuffer>;
  /** The provider refuses work: the finished-clip path would fail the same way. */
  isBusy: (error: unknown) => boolean;
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
    isBusy: isDeepInfraBusy,
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
    isBusy: isGoogleTtsBusy,
    toPublicError: toGoogleTtsAppError,
    canStream: () => googleTtsCanStream(),
  },
};

export function speechStreamProvider(provider: StreamingSpeechProvider): SpeechStreamProvider {
  return PROVIDERS[provider];
}
