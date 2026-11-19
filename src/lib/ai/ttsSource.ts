import type { AudioSource, ProviderTtsSource } from "@/types/conversation";

export type TtsProviderName = "cloudflare" | "deepinfra" | "google";

const SOURCE_BY_PROVIDER: Readonly<Record<TtsProviderName, ProviderTtsSource>> = {
  cloudflare: "cloudflare_tts",
  deepinfra: "deepinfra_tts",
  google: "google_tts",
};

const PROVIDER_TTS_SOURCES: ReadonlySet<string> = new Set(Object.values(SOURCE_BY_PROVIDER));

/** The audioSource label for speech synthesized by this provider. */
export function ttsSourceFor(provider: TtsProviderName): ProviderTtsSource {
  return SOURCE_BY_PROVIDER[provider];
}

/** True for speech a server-side provider synthesized (not cache, OpenAI or device speech). */
export function isProviderTtsSource(source: AudioSource): source is ProviderTtsSource {
  return PROVIDER_TTS_SOURCES.has(source);
}
