import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

const load = Module._load;
Module._load = function (specifier, ...args) {
  if (specifier === "server-only") return {};
  return load.call(this, specifier, ...args);
};
const { transcribeAudioToVietnameseWithProviders } = await import("./cloudflareWorkersAi.ts");
const { setDeepInfraTransportForTests } = await import("./deepInfra.ts");
const { translateTargetLanguage } = await import("./targetTranslation.ts");
const { transcribeVietnamese } = await import("./asr.ts");
const { generateEnglishSentence } = await import("./llm.ts");

const DEEPINFRA_ASR_URL = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const DEEPINFRA_CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions";
const SOURCE_TEXT = "Con khát nước. Mẹ cho con uống nước nhé.";
const translationInput = { sourceText: SOURCE_TEXT, language: "zh", context: "home", childAge: 6 };

function chat(content) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
}

function cloudflareChat(content) {
  return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

function cloudflareAsr(text) {
  return Response.json({ success: true, result: { text, segments: [{ avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1 }] } });
}

test("zh/ja/ko/fr pipeline uses DeepInfra when configured", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    setDeepInfraTransportForTests(undefined);
    Module._load = load;
  });
  let calls = [];
  t.beforeEach(() => {
    setDeepInfraTransportForTests((url, init) => globalThis.fetch(url, init));
    process.env = { ...originalEnv };
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT = "false";
    process.env.CLOUDFLARE_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
    process.env.AUDIO_ASR_PROVIDER = "deepinfra,cloudflare";
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra,cloudflare";
    delete process.env.DEEPINFRA_TEXT_MODEL;
    delete process.env.DEEPINFRA_ASR_MODEL;
    delete process.env.DEEPINFRA_BASE_URL;
    delete process.env.AUDIO_ASR_HEDGE_MS;
    delete process.env.AUDIO_TEXT_HEDGE_MS;
    delete process.env.AUDIO_ASR_PROVIDER_EN;
    delete process.env.AUDIO_TEXT_PROVIDER_EN;
    calls = [];
    console.info = console.warn = () => {};
  });

  await t.test("translates Chinese with DeepSeek on DeepInfra and never calls Cloudflare", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return chat("我想喝水。妈妈，请给我水。");
    };
    const result = await translateTargetLanguage(translationInput);
    assert.equal(result.translatedText, "我想喝水。妈妈，请给我水。");
    assert.equal(result.model, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.deepEqual(calls, [DEEPINFRA_CHAT_URL]);
  });

  await t.test("falls back to Cloudflare when DeepInfra is overloaded", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_CHAT_URL ? new Response("busy", { status: 503 }) : cloudflareChat("我想喝水。");
    };
    const result = await translateTargetLanguage(translationInput);
    assert.equal(result.translatedText, "我想喝水。");
    assert.equal(result.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], DEEPINFRA_CHAT_URL);
  });

  await t.test("falls back to Cloudflare when DeepInfra answers in the wrong script", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_CHAT_URL ? chat("I want water.") : cloudflareChat("我想喝水。");
    };
    const result = await translateTargetLanguage(translationInput);
    assert.equal(result.translatedText, "我想喝水。");
    assert.equal(calls.length, 2);
  });

  await t.test("stays on Cloudflare when AUDIO_TEXT_PROVIDER is unset", async () => {
    delete process.env.AUDIO_TEXT_PROVIDER;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return cloudflareChat("我想喝水。");
    };
    const result = await translateTargetLanguage(translationInput);
    assert.equal(result.model, "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.ok(!calls.includes(DEEPINFRA_CHAT_URL));
  });

  const audio = new File(["audio-bytes"], "speech.wav", { type: "audio/wav" });

  await t.test("transcribes Vietnamese speech with Whisper on DeepInfra", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ text: " Con khát nước. ", segments: [] });
    };
    const result = await transcribeAudioToVietnameseWithProviders(audio);
    assert.equal(result.provider, "deepinfra");
    assert.equal(result.vietnameseText, "Con khát nước.");
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.deepEqual(calls, [DEEPINFRA_ASR_URL]);
  });

  await t.test("an empty DeepInfra transcript is unclear speech, not a Cloudflare retry", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ text: "", segments: [] });
    };
    await assert.rejects(transcribeAudioToVietnameseWithProviders(audio), { code: "ASR_LOW_CONFIDENCE", status: 422 });
    assert.deepEqual(calls, [DEEPINFRA_ASR_URL]);
  });

  await t.test("falls back to Cloudflare ASR when DeepInfra times out or fails", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_ASR_URL ? new Response("down", { status: 500 }) : cloudflareAsr("Con khát nước.");
    };
    const result = await transcribeAudioToVietnameseWithProviders(audio);
    assert.equal(result.provider, "cloudflare");
    assert.equal(result.vietnameseText, "Con khát nước.");
    assert.equal(calls.length, 2);
  });

  await t.test("the English conversation flow also transcribes on DeepInfra when configured", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ text: "Con khát nước rồi mẹ ơi.", segments: [] });
    };
    const text = await transcribeVietnamese({ context: "home", targetLanguage: "en", audioFile: audio });
    assert.equal(text, "Con khát nước rồi mẹ ơi.");
    assert.deepEqual(calls, [DEEPINFRA_ASR_URL]);
  });

  await t.test("the English conversation flow keeps Cloudflare ASR when AUDIO_ASR_PROVIDER is unset", async () => {
    delete process.env.AUDIO_ASR_PROVIDER;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return cloudflareAsr("Con khát nước rồi mẹ ơi.");
    };
    await transcribeVietnamese({ context: "home", targetLanguage: "en", audioFile: audio });
    assert.ok(calls.length > 0);
    assert.ok(calls.every((url) => url.startsWith("https://api.cloudflare.com/")));
  });

  // generateEnglishSentence(text, context, age, clientId, requestId, deferCacheWrite, skipFastLookup, bypassCache):
  // no rule, cache lookup or cache write, so only the providers answer.
  const translateEnglish = () => generateEnglishSentence(SOURCE_TEXT, "home", 6, undefined, undefined, false, true, true);

  await t.test("translates English with DeepInfra and never calls Cloudflare", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return chat("I am thirsty. Mom, please give me water.");
    };
    const result = await translateEnglish();
    assert.equal(result.englishText, "I am thirsty. Mom, please give me water.");
    assert.equal(result.source, "deepinfra");
    assert.equal(result.textProvider, "deepinfra");
    assert.equal(result.textModel, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.equal(result.textFallbackUsed, false);
    assert.deepEqual(calls, [DEEPINFRA_CHAT_URL]);
  });

  await t.test("English falls back to Cloudflare when DeepInfra is overloaded", async () => {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_CHAT_URL
        ? new Response("busy", { status: 503 })
        : cloudflareChat("I am thirsty. Mom, please give me water.");
    };
    const result = await translateEnglish();
    assert.equal(result.textProvider, "cloudflare");
    assert.equal(result.textModel, "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.equal(result.textFallbackUsed, true);
    assert.equal(calls[0], DEEPINFRA_CHAT_URL);
    assert.equal(calls.length, 2);
  });

  await t.test("English with Cloudflare first falls back to DeepInfra when Cloudflare is overloaded", async () => {
    process.env.AUDIO_TEXT_PROVIDER = "cloudflare,deepinfra";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_CHAT_URL
        ? chat("I am thirsty. Mom, please give me water.")
        : new Response("busy", { status: 503 });
    };
    const result = await translateEnglish();
    assert.equal(result.textProvider, "deepinfra");
    assert.equal(result.textFallbackUsed, true);
    assert.equal(calls.at(-1), DEEPINFRA_CHAT_URL);
  });

  await t.test("an English failure on DeepInfra alone names DeepInfra, not Cloudflare", async () => {
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response("busy", { status: 503 });
    };
    await assert.rejects(translateEnglish(), (error) => {
      assert.equal(error.code, "LLM_FAILED");
      assert.equal(error.status, 503);
      assert.equal(error.details.provider, "deepinfra");
      return true;
    });
  });

  await t.test("AUDIO_TEXT_PROVIDER_EN=deepinfra keeps English translation off Cloudflare, even when DeepInfra fails", async () => {
    process.env.AUDIO_TEXT_PROVIDER_EN = "deepinfra";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response("busy", { status: 503 });
    };
    await assert.rejects(translateEnglish(), (error) => error.code === "LLM_FAILED" && error.details.provider === "deepinfra");
    assert.deepEqual(calls, [DEEPINFRA_CHAT_URL]);

    // zh/ja/ko/fr keep the shared list and still fall back to Cloudflare.
    calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_CHAT_URL ? new Response("busy", { status: 503 }) : cloudflareChat("我想喝水。");
    };
    const result = await translateTargetLanguage(translationInput);
    assert.equal(result.translatedText, "我想喝水。");
    assert.equal(calls.length, 2);
  });

  await t.test("AUDIO_ASR_PROVIDER_EN=deepinfra keeps English speech recognition off Cloudflare", async () => {
    process.env.AUDIO_ASR_PROVIDER_EN = "deepinfra";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === DEEPINFRA_ASR_URL ? new Response("down", { status: 500 }) : cloudflareAsr("Con khát nước.");
    };
    await assert.rejects(transcribeVietnamese({ context: "home", targetLanguage: "en", audioFile: audio }));
    assert.deepEqual(calls, [DEEPINFRA_ASR_URL]);

    // Another target language keeps the Cloudflare fallback.
    calls = [];
    const text = await transcribeVietnamese({ context: "home", targetLanguage: "zh", audioFile: audio });
    assert.equal(text, "Con khát nước.");
    assert.equal(calls.length, 2);
  });

  await t.test("English stays on Cloudflare when AUDIO_TEXT_PROVIDER is unset", async () => {
    delete process.env.AUDIO_TEXT_PROVIDER;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return cloudflareChat("I am thirsty. Mom, please give me water.");
    };
    const result = await translateEnglish();
    assert.equal(result.textProvider, "cloudflare");
    assert.ok(!calls.includes(DEEPINFRA_CHAT_URL));
  });
});
