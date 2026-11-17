/**
 * How the voice of a deferred zh/ja/ko/fr translation is delivered (cách B):
 * - "clip": a finished MP3. A short sentence is synthesized in ~1.5-2 s, about as
 *   soon as a stream would start, and a finished file is small, carries its real
 *   length (the player ends on its own) and is cached as MP3.
 * - "stream": WAV streamed while it is generated, only for long sentences, where
 *   starting early saves several seconds.
 * The translation is returned first either way. The choice depends only on the
 * sentence and the environment, so the conversation pipeline and the
 * /api/audio/target route always agree without carrying it in the signed URL.
 */

export type TargetSpeechMode = "clip" | "stream";

type EnvSource = Readonly<Record<string, string | undefined>>;

// Qwen3-TTS reads about 5-6 CJK characters per second: 20 characters is ~3.5 s.
const DEFAULT_MIN_CHARS_CJK = 20;
// French is ~14-15 characters per second: 50 characters is ~3.5 s.
const DEFAULT_MIN_CHARS_FR = 50;

function threshold(env: EnvSource, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Characters as the cache sees the sentence (NFKC, collapsed whitespace), counted by code point. */
function spokenLength(text: string) {
  return Array.from(text.normalize("NFKC").replace(/\s+/g, " ").trim()).length;
}

export function targetSpeechModeFor(
  language: string,
  text: string,
  options: { streaming: boolean; env?: EnvSource },
): TargetSpeechMode {
  if (!options.streaming) return "clip";
  const env = options.env ?? process.env;
  const minChars = language === "fr"
    ? threshold(env, "AUDIO_TARGET_STREAM_MIN_CHARS_FR", DEFAULT_MIN_CHARS_FR)
    : threshold(env, "AUDIO_TARGET_STREAM_MIN_CHARS", DEFAULT_MIN_CHARS_CJK);
  return spokenLength(text) >= minChars ? "stream" : "clip";
}
