import assert from "node:assert/strict";
import test from "node:test";
import {
  createTranslationCache, sharedTextCacheEnabled, sharedTextCacheKey, sharedTextCacheTtlSeconds, translationCacheKey,
} from "./audioTranslationCache";
import { translateAudioToEnglish } from "./cloudflareWorkersAi";

const ONE_DAY_S = 24 * 60 * 60;
/** Shared entries are written without blocking the response. */
const settled = () => new Promise(resolve => setImmediate(resolve));

function memoryCache() {
  const values = new Map<string, string>();
  const ttls: number[] = [];
  const cache = createTranslationCache({
    get: async key => values.get(key) ?? null,
    set: async (key, value, ttlSeconds) => { values.set(key, value); ttls.push(ttlSeconds); },
  });
  return { cache, values, ttls };
}

/** Stubs Cloudflare: transcripts are served in order (the last one repeats); counts calls to the text model. */
function stubProvider(t: test.TestContext, transcripts: string | string[], english: string) {
  const queue = Array.isArray(transcripts) ? [...transcripts] : [transcripts];
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  delete process.env.AUDIO_TRANSLATION_CACHE_ENABLED;
  delete process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED;
  delete process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_TTL_SECONDS;
  const calls = { asr: 0, text: 0 };
  globalThis.fetch = async url => {
    if (String(url).includes("chat/completions")) {
      calls.text++;
      return Response.json({ choices: [{ message: { content: english } }] });
    }
    calls.asr++;
    return Response.json({ success: true, result: { text: queue.length > 1 ? queue.shift() : queue[0] } });
  };
  return calls;
}

const recording = (name: string) => new File([name], `${name}.mp3`, { type: "audio/mpeg" });

test("the shared sentence cache is off unless its own flag is true", t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  delete process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED;
  assert.equal(sharedTextCacheEnabled(), false);
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED = "false";
  assert.equal(sharedTextCacheEnabled(), false);
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED = "true";
  assert.equal(sharedTextCacheEnabled(), true);
});

test("the same sentence gets one shared key whatever its spacing, quotes or closing full stop", () => {
  const key = sharedTextCacheKey("vi", "Con ăn cơm.");
  assert.equal(sharedTextCacheKey("vi", "  Con   ăn cơm "), key);
  assert.equal(sharedTextCacheKey("vi", "Con ăn cơm..."), key);
  assert.equal(sharedTextCacheKey("vi", "\"Con ăn cơm\","), key);
});

test("letter case stays significant because Vietnamese names are also common words", () => {
  // "Mai đi học." is about a girl called Mai; "mai đi học." means going to school tomorrow.
  assert.notEqual(sharedTextCacheKey("vi", "Mai đi học."), sharedTextCacheKey("vi", "mai đi học."));
});

test("the shared key changes when the translation prompt changes", t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  const key = sharedTextCacheKey("vi", "Con ăn cơm.");
  assert.notEqual(sharedTextCacheKey("vi", "Con ăn cơm.", "Translate differently."), key);
  assert.notEqual(sharedTextCacheKey("vi", "Con ăn cơm.", undefined, 64), key);
});

test("a different sentence, a question, another language or a per-client key never share the entry", () => {
  const key = sharedTextCacheKey("vi", "Con ăn cơm.");
  assert.notEqual(sharedTextCacheKey("vi", "Con uống nước."), key);
  // A question and a statement translate differently, so "?" and "!" stay significant.
  assert.notEqual(sharedTextCacheKey("vi", "Con ăn cơm?"), key);
  assert.notEqual(sharedTextCacheKey("vi", "Con ăn cơm!"), key);
  assert.notEqual(sharedTextCacheKey("zh", "Con ăn cơm."), key);
  assert.notEqual(translationCacheKey("client-a", "vi", "text", "Con ăn cơm."), key);
});

test("shared entries live for one day by default and the setting is clamped", t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  delete process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_TTL_SECONDS;
  assert.equal(sharedTextCacheTtlSeconds(), ONE_DAY_S);
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_TTL_SECONDS = "5";
  assert.equal(sharedTextCacheTtlSeconds(), 60);
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_TTL_SECONDS = String(400 * 24 * 60 * 60);
  assert.equal(sharedTextCacheTtlSeconds(), 30 * 24 * 60 * 60);
});

test("a cache write keeps the short default lifetime unless a longer one is asked for", async () => {
  const { cache, ttls } = memoryCache();
  const value = { englishText: "I eat rice.", sourceText: "Con ăn cơm.", model: "asr" };
  await cache.set("short", value);
  await cache.set("long", value, ONE_DAY_S);
  assert.equal(ttls[0] <= 3600, true);
  assert.equal(ttls[1], ONE_DAY_S);
});

test("two different users saying the same sentence call the text model once", async t => {
  const calls = stubProvider(t, ["Con ăn cơm.", "Con ăn cơm", "  Con ăn cơm... "], "I eat rice.");
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED = "true";
  const { cache, ttls } = memoryCache();

  const first = await translateAudioToEnglish(recording("child-a"), "vi", { cacheScope: "client-a", textCache: cache });
  await settled();
  const second = await translateAudioToEnglish(recording("child-b"), "vi", { cacheScope: "client-b", textCache: cache });
  // A legacy client has no cache scope at all and still benefits.
  const third = await translateAudioToEnglish(recording("child-c"), "vi", { textCache: cache });
  await settled();

  assert.equal(first.englishText, "I eat rice.");
  assert.equal(second.englishText, "I eat rice.");
  assert.equal(third.englishText, "I eat rice.");
  // A hit returns the caller's own transcript, never the first speaker's.
  assert.equal(first.sourceText, "Con ăn cơm.");
  assert.equal(second.sourceText, "Con ăn cơm");
  assert.equal(calls.asr, 3);
  assert.equal(calls.text, 1);
  assert.deepEqual(ttls, [ONE_DAY_S]);
});

test("with only the per-client cache flag on, translations are still not shared between clients", async t => {
  const calls = stubProvider(t, "Con ăn cơm.", "I eat rice.");
  process.env.AUDIO_TRANSLATION_CACHE_ENABLED = "true";
  process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED = "true";
  const { cache } = memoryCache();

  await translateAudioToEnglish(recording("child-a"), "vi", { cacheScope: "client-a", textCache: cache });
  await translateAudioToEnglish(recording("child-a-again"), "vi", { cacheScope: "client-a", textCache: cache });
  await translateAudioToEnglish(recording("child-b"), "vi", { cacheScope: "client-b", textCache: cache });

  assert.equal(calls.text, 2);
});

test("a cache that is down never fails or blocks a translation", async t => {
  const calls = stubProvider(t, "Con ăn cơm.", "I eat rice.");
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED = "true";
  const broken = createTranslationCache({
    get: async () => { throw new Error("offline"); },
    set: () => new Promise<void>(() => { /* never settles */ }),
  });

  const result = await translateAudioToEnglish(recording("child-a"), "vi", { textCache: broken });

  assert.equal(result.englishText, "I eat rice.");
  assert.equal(calls.text, 1);
});

test("with the flag off every request still calls the text model", async t => {
  const calls = stubProvider(t, "Con ăn cơm.", "I eat rice.");
  const { cache, values } = memoryCache();

  await translateAudioToEnglish(recording("child-a"), "vi", { cacheScope: "client-a", textCache: cache });
  await translateAudioToEnglish(recording("child-b"), "vi", { cacheScope: "client-b", textCache: cache });

  assert.equal(calls.text, 2);
  assert.equal(values.size, 0);
});

test("a translation that is not English is rejected and never stored for other users", async t => {
  const calls = stubProvider(t, "Con ăn cơm.", "Con ăn cơm.");
  process.env.AUDIO_TRANSLATION_SHARED_TEXT_CACHE_ENABLED = "true";
  const { cache, values } = memoryCache();

  await assert.rejects(translateAudioToEnglish(recording("child-a"), "vi", { textCache: cache }),
    { code: "LLM_FAILED" });
  await assert.rejects(translateAudioToEnglish(recording("child-b"), "vi", { textCache: cache }),
    { code: "LLM_FAILED" });

  assert.equal(values.size, 0);
  assert.equal(calls.text, 2);
});
