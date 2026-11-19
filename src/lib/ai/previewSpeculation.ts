import type { ConversationRequest, ConversationResponse } from "@/types/conversation";
import { logEvent } from "@/lib/observability";
import { lazyCacheRedisCommand } from "./audioTranslationCache";
import { transcribeVietnamese } from "./asr";
import { skipsPostResponsePersistence } from "./loadTestPersistence";
import { runConversationPipeline, runTargetLanguageConversationPipeline } from "./pipeline";
import {
  createPreviewSpeculation,
  previewSpeculationConfig,
  type PreviewSpeculation,
  type SpeculationStore,
} from "./previewSpeculationCore";

/** The cache Redis (AUDIO_TRANSLATION_CACHE_REDIS_URL), shared by every backend. */
function redisSpeculationStore(): SpeculationStore {
  const command = lazyCacheRedisCommand(
    () => process.env.AUDIO_TRANSLATION_CACHE_REDIS_URL,
    "preview_speculation_cache_unavailable",
    // The final request waits on these calls: a slow cache must cost little, then
    // the 5 s cooldown skips it entirely (every call is a miss).
    { connectTimeoutMs: 300, commandTimeoutMs: 300 },
  );
  return {
    async get(key) {
      const reply = await command(["GET", key]);
      return typeof reply === "string" ? reply : null;
    },
    async set(key, value, ttlMs) {
      await command(["SET", key, value, "PX", String(ttlMs)]);
    },
    async setIfAbsent(key, value, ttlMs) {
      return (await command(["SET", key, value, "PX", String(ttlMs), "NX"])) === "OK";
    },
    async replaceIf(key, expected, value, ttlMs) {
      const reply = await command(["EVAL", REPLACE_IF_SCRIPT, "1", key, expected, value, String(ttlMs)]);
      return reply === 1 || reply === "1";
    },
  };
}

/** Compare-and-set in one step: a slow run never overwrites a turn already answered. */
const REPLACE_IF_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 end return 0";

/** The same work as the final request, minus history and learning (post-response tasks). */
function runSpeculativePipeline(input: ConversationRequest): Promise<ConversationResponse> {
  return input.targetLanguage === "en"
    // Start English speech now: the app opens audioUrl only after the final request.
    // The text cache is written after the run, as for the final request, so the
    // result is ready sooner.
    ? runConversationPipeline(input, { eagerAudioOnCacheMiss: true, deferTextCacheWrite: true })
    : runTargetLanguageConversationPipeline(input);
}

type SpeculationGlobal = typeof globalThis & {
  // Route bundles are separate module instances: share one per process.
  __previewSpeculation?: PreviewSpeculation;
};

export function getPreviewSpeculation(): PreviewSpeculation {
  const state = globalThis as SpeculationGlobal;
  state.__previewSpeculation ??= createPreviewSpeculation({
    store: redisSpeculationStore(),
    runPipeline: runSpeculativePipeline,
    transcribe: transcribeVietnamese,
    config: () => previewSpeculationConfig(),
    isLoadTestClient: skipsPostResponsePersistence,
    log: logEvent,
    flights: new Map(),
  });
  return state.__previewSpeculation;
}

export { previewSpeculationConfig };
