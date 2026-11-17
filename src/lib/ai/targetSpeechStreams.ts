import { pcmStreamToWav, WAV_HEADER_BYTES, withWavSizes } from "@/lib/audio/wav";
import { createSpeechBroadcast, type SpeechBroadcast } from "./speechBroadcast";

/**
 * Streamed zh/ja/ko/fr speech: PCM from DeepInfra's streaming endpoint is sent on
 * uncompressed as WAV (no MP3 encoding) and fanned out, so /api/audio/target plays
 * the clip before it is finished. `start` resolves with the whole WAV, sizes filled
 * in, for the durable cache. The fallback must also return WAV.
 */

export type PcmSpeech = Readonly<{ pcm: ReadableStream<Uint8Array>; sampleRate: number }>;

export type TargetSpeechStreamsOptions = {
  openPcm: (text: string, language: string) => Promise<PcmSpeech>;
  /** The finished-clip path, used only when the stream fails before its first byte. */
  fallback: (text: string, language: string) => Promise<ArrayBuffer>;
  /** Maps a provider error to the one listeners and logs see. */
  toPublicError?: (error: unknown) => unknown;
  log?: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  maxBytes?: number;
};

// Matches the 2-minute PCM cap in streamSpeechWithDeepInfra (24 kHz, 16-bit, mono).
const DEFAULT_MAX_WAV_BYTES = 24_000 * 2 * 120 + WAV_HEADER_BYTES;

export function createTargetSpeechStreams(options: TargetSpeechStreamsOptions) {
  const live = new Map<string, SpeechBroadcast>();
  const keyFor = (text: string, language: string) => `${language}\n${text}`;
  const toPublicError = options.toPublicError ?? (error => error);
  const log = options.log ?? (() => undefined);

  async function produce(text: string, language: string, broadcast: SpeechBroadcast) {
    const startedAt = performance.now();
    try {
      const speech = await options.openPcm(text, language);
      const reader = pcmStreamToWav(speech.pcm, speech.sampleRate).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!broadcast.started()) {
          log("info", "target_speech_stream_first_chunk", { language, latencyMs: Math.round(performance.now() - startedAt) });
        }
        broadcast.push(value);
        if (!broadcast.live()) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
      broadcast.finish();
    } catch (error) {
      const reported = toPublicError(error);
      // Listeners already hold part of this clip; another voice take cannot continue it.
      if (broadcast.started()) {
        log("warn", "target_speech_stream_failed", { language, error: reported });
        broadcast.fail(reported);
        return;
      }
      log("warn", "target_speech_stream_fallback", { language, error: reported });
      try {
        broadcast.push(new Uint8Array(await options.fallback(text, language)));
        broadcast.finish();
      } catch (fallbackError) {
        broadcast.fail(fallbackError);
      }
    }
  }

  return {
    /** Starts one streamed synthesis; the coordinator ensures one per sentence. */
    start(text: string, language: string): Promise<ArrayBuffer> {
      const key = keyFor(text, language);
      const broadcast = createSpeechBroadcast(options.maxBytes ?? DEFAULT_MAX_WAV_BYTES);
      live.set(key, broadcast);
      const forget = () => {
        if (live.get(key) === broadcast) live.delete(key);
      };
      broadcast.completed.then(forget, forget);
      void produce(text, language, broadcast);
      return broadcast.completed.then(withWavSizes);
    },

    /** WAV from its first byte while synthesis is still running; null once it has settled. */
    subscribe(text: string, language: string): ReadableStream<Uint8Array> | null {
      const broadcast = live.get(keyFor(text, language));
      return broadcast?.live() ? broadcast.subscribe() : null;
    },
  };
}
