import { parsePoolConfig } from "./accountConfig";

export const ASR_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export function poolEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test", CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED: "true", CLOUDFLARE_POOL_STORE: "memory",
    POOL_TEST_A: "test-token-a", POOL_TEST_B: "test-token-b",
    CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify(["a", "b"].map((letter, i) => ({
      alias: `audio-${letter}`, accountId: letter.repeat(32), apiTokenEnv: i === 0 ? "POOL_TEST_A" : "POOL_TEST_B", enabled: true,
      capabilities: { asr: [ASR_MODEL], text: [TEXT_MODEL] },
      limits: { asr: { rpm: 600, burst: 10, maxConcurrent: 10 }, text: { rpm: 240, burst: 4, maxConcurrent: 4 }, accountMaxConcurrent: 14 },
    }))),
  };
}
export function poolConfig() { return parsePoolConfig(poolEnv()); }
