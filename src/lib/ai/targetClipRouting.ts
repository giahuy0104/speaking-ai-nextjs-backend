import { createHash } from "node:crypto";

/**
 * With Google as the target-speech provider, a share of the short sentences (finished
 * MP3 clips) is spoken by DeepInfra (Qwen3-TTS) instead, to spread load across both
 * providers' quotas: AUDIO_TARGET_CLIP_DEEPINFRA_SHARE=0.33 sends about a third.
 * The choice is a hash of the sentence, not a coin toss, so a sentence always goes the
 * same way and the audio cache is looked up and saved under the same voice.
 */

type EnvSource = Readonly<Record<string, string | undefined>>;

export function deepInfraClipShare(env: EnvSource = process.env): number {
  const share = Number(env.AUDIO_TARGET_CLIP_DEEPINFRA_SHARE?.trim());
  return Number.isFinite(share) && share > 0 ? Math.min(share, 1) : 0;
}

export function clipGoesToDeepInfra(language: string, text: string, env: EnvSource = process.env): boolean {
  const share = deepInfraClipShare(env);
  if (share === 0) return false;
  if (share === 1) return true;
  // The same normalization as the audio cache key (see targetSpeechDescriptor).
  const sentence = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const bucket = createHash("sha256").update(`${language}\n${sentence}`).digest().readUInt32BE(0) / 2 ** 32;
  return bucket < share;
}
