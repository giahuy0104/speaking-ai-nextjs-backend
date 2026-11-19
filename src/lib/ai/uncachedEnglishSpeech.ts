import { isWav, withWavSizes } from "@/lib/audio/wav";
import { requestEnglishSpeechAudio } from "./englishSpeech";

/**
 * Finished uncached English speech for players that need a known length (iOS AVPlayer:
 * a `Range: bytes=0-1` probe, then the download). Each signed no-cache URL gets its own
 * synthesis, kept in memory only briefly so the probe and the download share it.
 * Never written to the cache.
 */

const RETAIN_MS = 20_000;
const MAX_JOBS = 1_000;

export type FinishedEnglishSpeech = { audio: ArrayBuffer; contentType: string; source: string };

const jobs = new Map<string, Promise<FinishedEnglishSpeech>>();

async function synthesize(text: string): Promise<FinishedEnglishSpeech> {
  const speech = await requestEnglishSpeechAudio(text);
  const audio = await speech.response.arrayBuffer();
  // A streamed WAV carries "unknown size" placeholders; a finished file needs real ones.
  return isWav(audio)
    ? { audio: withWavSizes(audio), contentType: "audio/wav", source: speech.source }
    : { audio, contentType: speech.response.headers.get("content-type") ?? "audio/mpeg", source: speech.source };
}

/** `key` identifies one turn's URL (its signed `nocache` value); `text` is the sentence. */
export function finishedUncachedEnglishSpeech(key: string, text: string): Promise<FinishedEnglishSpeech> {
  const existing = jobs.get(key);
  if (existing) return existing;
  if (jobs.size >= MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest !== undefined) jobs.delete(oldest);
  }
  const job = synthesize(text);
  jobs.set(key, job);
  const forget = () => {
    if (jobs.get(key) === job) jobs.delete(key);
  };
  // A failure is not kept: the player's retry asks the provider again.
  job.then(() => setTimeout(forget, RETAIN_MS).unref(), forget);
  return job;
}
