import assert from "node:assert/strict";
import Module from "node:module";
import { after, afterEach, beforeEach, test } from "node:test";

const load = Module._load;
Module._load = function (specifier, ...args) {
  if (specifier === "server-only") return {};
  return load.call(this, specifier, ...args);
};
const {
  isVietnameseToEnglish,
  parseLanguagePair,
  withConversationLanguageFields,
} = await import("./targetLanguage.ts");
const { buildTargetLanguageInstruction } = await import("./prompts.ts");
const { targetTranslationIssue } = await import("./targetTranslation.ts");
const { runTargetLanguageConversationPipeline } = await import("./pipeline.ts");
const { isKnownSilenceHallucination } = await import("./asr.ts");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalWarn = console.warn;
let logs;
let calls;

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "private-test-token";
  process.env.CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT = "false";
  process.env.CLOUDFLARE_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
  process.env.CLOUDFLARE_TEXT_TIMEOUT_MS = "6000";
  process.env.AUDIO_STORAGE_BACKEND = "local";
  process.env.PERSISTENCE_BACKEND = "local";
  process.env.DATABASE_URL = "";
  logs = [];
  calls = [];
  console.info = console.warn = value => { logs.push(JSON.parse(value)); };
});
afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  console.warn = originalWarn;
});
after(() => { Module._load = load; });

/** Text inference returns `translation`; TTS fails so the pipeline uses device TTS. */
function providerReturning(translation) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return String(url).endsWith("chat/completions")
      ? Response.json({ choices: [{ message: { content: translation }, finish_reason: "stop" }] })
      : Response.json({ errors: [{ code: 2021 }] }, { status: 402 });
  };
}

function badRequestReason(reason) {
  return error => error.status === 400 && error.details?.reason === reason;
}

test("requests from older apps keep Vietnamese → English", () => {
  assert.deepEqual(parseLanguagePair(undefined, undefined), { sourceLanguage: "vi", targetLanguage: "en" });
  assert.deepEqual(parseLanguagePair(undefined, "zh"), { sourceLanguage: "vi", targetLanguage: "zh" });
  assert.deepEqual(parseLanguagePair("ja", "ko"), { sourceLanguage: "ja", targetLanguage: "ko" });
  assert.deepEqual(parseLanguagePair("fr", "vi"), { sourceLanguage: "fr", targetLanguage: "vi" });
});

test("same-language pairs and unknown codes are rejected with stable reasons", () => {
  assert.throws(() => parseLanguagePair("en", "en"), badRequestReason("same_source_and_target_language"));
  assert.throws(() => parseLanguagePair(undefined, "vi"), badRequestReason("same_source_and_target_language"));
  assert.throws(() => parseLanguagePair("de", "en"), badRequestReason("unsupported_source_language"));
  assert.throws(() => parseLanguagePair("vi", "zh-TW"), badRequestReason("unsupported_target_language"));
});

test("only Vietnamese → English (including legacy records) is eligible for rule learning", () => {
  assert.equal(isVietnameseToEnglish({}), true);
  assert.equal(isVietnameseToEnglish({ targetLanguage: "en" }), true);
  assert.equal(isVietnameseToEnglish({ sourceLanguage: "vi", targetLanguage: "en" }), true);
  assert.equal(isVietnameseToEnglish({ sourceLanguage: "ja", targetLanguage: "en" }), false);
  assert.equal(isVietnameseToEnglish({ targetLanguage: "fr" }), false);
});

test("legacy records are read as Vietnamese → English without inventing other languages", () => {
  const legacy = withConversationLanguageFields({ vietnameseText: "Con đói", englishText: "I'm hungry." });
  assert.equal(legacy.sourceLanguage, "vi");
  assert.equal(legacy.sourceText, "Con đói");
  assert.equal(legacy.targetLanguage, "en");
  assert.equal(legacy.translatedText, "I'm hungry.");

  const legacyFrench = withConversationLanguageFields({
    vietnameseText: "Con đói", englishText: "", targetLanguage: "fr", translatedText: "J'ai faim.",
  });
  assert.equal(legacyFrench.sourceText, "Con đói");
  assert.equal(legacyFrench.translatedText, "J'ai faim.");
});

test("the Vietnamese → target prompt is unchanged; other sources are named correctly", () => {
  const vietnamese = buildTargetLanguageInstruction("ja", "home", 6);
  assert.match(vietnamese, /child's Vietnamese utterance directly into natural Japanese/);
  assert.match(vietnamese, /or translate through English/);

  const japaneseToKorean = buildTargetLanguageInstruction("ko", "home", 6, "ja");
  assert.match(japaneseToKorean, /child's Japanese utterance directly into natural Korean/);

  const frenchToVietnamese = buildTargetLanguageInstruction("vi", "school", 7, "fr");
  assert.match(frenchToVietnamese, /child's French utterance directly into natural Vietnamese/);

  const japaneseToEnglish = buildTargetLanguageInstruction("en", "home", 6, "ja");
  assert.doesNotMatch(japaneseToEnglish, /translate through English/);
});

test("Latin-script targets reject output in another script", () => {
  assert.equal(targetTranslationIssue("お水が欲しい", "en"), "missing_target_script");
  assert.equal(targetTranslationIssue("Con muốn uống nước.", "vi"), undefined);
  assert.equal(targetTranslationIssue("I want water.", "en"), undefined);
});

test("Japanese → English skips Vietnamese transcript checks and fills pair fields", async () => {
  providerReturning("I want to drink water.");
  const result = await runTargetLanguageConversationPipeline({
    sourceText: "お水が飲みたい", sourceLanguage: "ja", targetLanguage: "en",
    context: "home", childAge: 6, asrMode: "android_streaming", requestId: "ja-en",
  });
  assert.equal(result.sourceLanguage, "ja");
  assert.equal(result.sourceText, "お水が飲みたい");
  assert.equal(result.targetLanguage, "en");
  assert.equal(result.translatedText, "I want to drink water.");
  assert.equal(result.vietnameseText, "", "Japanese is never stored as Vietnamese");
  assert.equal(result.englishText, "I want to drink water.");
  assert.equal(result.audioSource, "device_tts");
  const prompt = calls[0].body.messages.map(message => message.content).join("\n");
  assert.match(prompt, /child's Japanese utterance/);
  assert.equal(calls[1].body.input.language, "en", "TTS is requested in the target language");
});

test("English → Vietnamese voices Vietnamese and keeps legacy fields empty", async () => {
  providerReturning("Con muốn uống nước.");
  const result = await runTargetLanguageConversationPipeline({
    sourceText: "I want water", sourceLanguage: "en", targetLanguage: "vi",
    context: "home", childAge: 6, asrMode: "text", requestId: "en-vi",
  });
  assert.equal(result.sourceText, "I want water");
  assert.equal(result.translatedText, "Con muốn uống nước.");
  assert.equal(result.vietnameseText, "");
  assert.equal(result.englishText, "");
  assert.equal(calls[1].body.input.language, "vi");
  assert.equal(result.audioUrl, null);
  assert.equal(result.audioSource, "device_tts");
});

test("Vietnamese → English never runs on the direct pipeline", async () => {
  providerReturning("unused");
  await assert.rejects(runTargetLanguageConversationPipeline({
    sourceText: "Con đói", sourceLanguage: "vi", targetLanguage: "en", context: "home", asrMode: "text",
  }), { status: 400 });
  await assert.rejects(runTargetLanguageConversationPipeline({
    sourceText: "Con đói", targetLanguage: "en", context: "home", asrMode: "text",
  }), { status: 400 });
  assert.equal(calls.length, 0);
});

test("English targets read the (admin-corrected) englishText", () => {
  const corrected = withConversationLanguageFields({
    vietnameseText: "Con đói", englishText: "I am hungry.", translatedText: "I hungry.",
  });
  assert.equal(corrected.translatedText, "I am hungry.");
});

test("Latin-script check accepts letterless output and still rejects CJK", () => {
  assert.equal(targetTranslationIssue("5", "en"), undefined);
  assert.equal(targetTranslationIssue("3 + 2", "fr"), undefined);
  assert.equal(targetTranslationIssue("水", "vi"), "missing_target_script");
});

test("known Whisper silence captions are rejected, real short phrases are not", () => {
  assert.equal(isKnownSilenceHallucination("ご視聴ありがとうございました。"), true);
  assert.equal(isKnownSilenceHallucination("Thanks for watching!"), true);
  assert.equal(isKnownSilenceHallucination("Thank you"), false);
  assert.equal(isKnownSilenceHallucination("お水が飲みたい"), false);
});
