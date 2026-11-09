import assert from "node:assert/strict";
import Module from "node:module";
import { after, afterEach, beforeEach, test } from "node:test";

const load = Module._load;
Module._load = function (specifier, ...args) {
  if (specifier === "server-only") return {};
  return load.call(this, specifier, ...args);
};
const { normalizeTargetTranslation, targetTranslationIssue, translateTargetLanguage } = await import("./targetTranslation.ts");
const { runTargetLanguageConversationPipeline } = await import("./pipeline.ts");
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const originalWarn = console.warn;
let logs;
let calls;
const sourceText = "Con khát nước. Mẹ cho con uống nước nhé.";
const input = { sourceText, language: "fr", context: "home", childAge: 6, requestId: "target-regression-request" };

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

function completion(content, finishReason = "stop") {
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(init.body);
    assert.equal(body.max_completion_tokens, 512);
    return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { completion_tokens: 32 } });
  };
}

test("French translations with line breaks preserve every sentence instead of returning a false 502", async () => {
  completion('« J’ai soif.\r\n\tMaman, donne-moi de l’eau.\u2028Merci ! »');
  const result = await translateTargetLanguage(input);
  assert.equal(result.translatedText, "J’ai soif. Maman, donne-moi de l’eau. Merci !");
  assert.equal(calls.length, 1, "normalization does not create another inference");
  const logged = logs.find(log => log.event === "target_translation_completed");
  assert.equal(logged.requestId, input.requestId);
  assert.equal(logged.hadLineBreaks, true);
  assert.equal(logged.normalizationApplied, true);
  assert.equal(logged.finishReason, "stop");
  assert.equal(logged.upstreamStatus, 200);
  assert.equal(logged.completionTokens, 32);
  for (const privateValue of [sourceText, "J’ai soif", "private-test-token"]) {
    assert.ok(!JSON.stringify(logs).includes(privateValue), "logs contain diagnostics, never source/translation/credentials");
  }
});

test("normalizes matching wrapper quotes without removing quotation inside a sentence", () => {
  for (const text of ['"Bonjour."', "“Bonjour.”", "「Bonjour.」", "«Bonjour.»"]) assert.equal(normalizeTargetTranslation(text), "Bonjour.");
  assert.equal(normalizeTargetTranslation('Il dit « Bonjour ».\nPuis il part.'), 'Il dit « Bonjour ». Puis il part.');
  assert.equal(normalizeTargetTranslation('“Bonjour.'), '“Bonjour.');
});

test("valid translations in every supported target language remain accepted", async () => {
  for (const [language, content] of [["zh", "我想喝水。\n妈妈，请给我水。"], ["ja", "水を飲みたい。\nお母さん、水をください。"], ["ko", "물을 마시고 싶어요.\n엄마, 물 주세요."], ["fr", "J’ai soif.\nMaman, donne-moi de l’eau."]]) {
    completion(content);
    assert.equal((await translateTargetLanguage({ ...input, language })).translatedText, content.replace(/\n/g, " "));
  }
  assert.equal(calls.length, 4);
});

test("translations may expand beyond the old 500-character source-sized limit", async () => {
  const text = "Bonjour. ".repeat(70).trim();
  completion(text);
  assert.equal((await translateTargetLanguage(input)).translatedText, text);
  assert.equal(targetTranslationIssue("a".repeat(2001), "fr"), "output_too_long");
});

for (const [name, content, language, finishReason, reason] of [
  ["missing Chinese script", "I want water.", "zh", "stop", "missing_target_script"],
  ["missing Japanese script", "I want water.", "ja", "stop", "missing_target_script"],
  ["missing Korean script", "I want water.", "ko", "stop", "missing_target_script"],
  ["overlong output", "a".repeat(2001), "fr", "stop", "output_too_long"],
  ["truncated completion", "Je voudrais", "fr", "length", "output_truncated"],
  ["filtered completion", "Bonjour.", "fr", "content_filter", "content_filtered"],
  ["tool invocation", "Bonjour.", "fr", "tool_calls", "unexpected_tool_call"],
  ["empty completion", "", "fr", "stop", "empty_response"],
  ["empty truncated completion", "", "fr", "length", "output_truncated"],
  ["empty filtered completion", "", "fr", "content_filter", "content_filtered"],
]) {
  test(`rejects ${name} with a precise reason and no retry`, async () => {
    completion(content, finishReason);
    await assert.rejects(translateTargetLanguage({ ...input, language }), error => {
      assert.equal(error.code, "LLM_FAILED");
      assert.equal(error.status, 502);
      assert.equal(error.details.reason, reason);
      return true;
    });
    assert.equal(calls.length, 1);
    const logged = logs.find(log => log.event === "target_translation_failed");
    assert.equal(logged.reason, reason);
    assert.equal(logged.language, language);
    assert.equal(logged.upstreamStatus, 200);
    assert.equal(logged.requestId, input.requestId);
    assert.ok(!JSON.stringify(logged).includes(sourceText));
  });
}

test("rate limits and timeouts preserve their real status and source instead of becoming generic 502", async () => {
  globalThis.fetch = async () => Response.json({ errors: [{ code: 3036, message: "private provider details" }] }, { status: 429 });
  await assert.rejects(translateTargetLanguage(input), { status: 429 });
  let logged = logs.at(-1);
  assert.equal(logged.reason, "rate_limited");
  assert.equal(logged.upstreamStatus, 429);
  assert.deepEqual(logged.upstreamCodes, [3036]);
  assert.ok(!JSON.stringify(logs).includes("private provider details"));
  globalThis.fetch = async () => { throw new DOMException("private network details", "TimeoutError"); };
  await assert.rejects(translateTargetLanguage(input), { status: 504 });
  logged = logs.at(-1);
  assert.equal(logged.reason, "timeout");
  assert.equal(logged.failureSource, "unknown");
  assert.ok(!JSON.stringify(logs).includes("private network details"));
});

test("missing server configuration is diagnosable without any inference", async () => {
  delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  await assert.rejects(translateTargetLanguage(input), { status: 503 });
  assert.equal(logs.at(-1).reason, "not_configured");
  assert.equal(calls.length, 0);
});

test("the actual multilingual pipeline keeps text and device TTS fallback when Grok returns 402", async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).endsWith("chat/completions")
      ? Response.json({ choices: [{ message: { content: "J’ai soif.\nMaman, donne-moi de l’eau.", }, finish_reason: "stop" }] })
      : Response.json({ errors: [{ code: 2021 }] }, { status: 402 });
  };
  const result = await runTargetLanguageConversationPipeline({
    ...input, targetLanguage: "fr", asrMode: "text",
  });
  assert.equal(result.vietnameseText, sourceText);
  assert.equal(result.translatedText, "J’ai soif. Maman, donne-moi de l’eau.");
  assert.equal(result.audioUrl, null);
  assert.equal(result.audioSource, "device_tts");
  assert.equal(result.targetLanguage, "fr");
  assert.equal(calls.length, 2, "one text inference and one TTS attempt");
  assert.ok(logs.some(log => log.event === "target_translation_completed"));
  const audioFailure = logs.find(log => log.event === "target_translation_audio_unavailable");
  assert.equal(audioFailure.upstreamStatus, 402);
  assert.equal(audioFailure.reason, "provider_http_error");
  assert.ok(logs.some(log => log.event === "target_translation_pipeline_completed" && log.audioSource === "device_tts"));
});

test("the pipeline never calls TTS for truncated or invalid translations", async () => {
  completion("Je voudrais", "length");
  await assert.rejects(runTargetLanguageConversationPipeline({
    ...input, targetLanguage: "fr", asrMode: "text",
  }), { status: 502 });
  assert.equal(calls.length, 1);
});
