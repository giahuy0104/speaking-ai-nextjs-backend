import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../appError";
import { translateAudioToEnglish } from "./cloudflareWorkersAi";
import { translationCacheKey } from "./audioTranslationCache";
import type { CloudflareExecutionContext } from "./cloudflare/types";

type Captured = { url: string; init: RequestInit };

const ASR_URL = "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions";

function asrResponse(text: string, segments: unknown[] = [{ avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1 }]) {
  return Response.json({ text, segments });
}

function chatResponse(content: string) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
}

test("DeepInfra audio translation provider", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  t.beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    delete process.env.DEEPINFRA_TEXT_REASONING_EFFORT;
    delete process.env.DEEPINFRA_TEXT_MODEL;
    delete process.env.DEEPINFRA_ASR_MODEL;
    delete process.env.DEEPINFRA_BASE_URL;
    process.env.AUDIO_ASR_PROVIDER = "deepinfra";
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra";
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
  });
  const audio = new File(["audio-bytes"], "speech.wav", { type: "audio/wav" });

  await t.test("transcribes and translates through DeepInfra without Cloudflare secrets", async () => {
    const calls: Captured[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return String(url) === ASR_URL ? asrResponse("Bố ơi, con khỏe rồi.") : chatResponse("Dad, I am feeling better now.");
    };

    const result = await translateAudioToEnglish(audio, "vi");

    assert.equal(result.englishText, "Dad, I am feeling better now.");
    assert.equal(result.sourceText, "Bố ơi, con khỏe rồi.");
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.equal(result.textModel, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.deepEqual(calls.map(call => call.url), [ASR_URL, CHAT_URL]);

    const asrHeaders = new Headers(calls[0].init.headers);
    assert.equal(asrHeaders.get("authorization"), "Bearer test-deepinfra-key");
    const form = calls[0].init.body as FormData;
    assert.equal(form.get("model"), "openai/whisper-large-v3-turbo");
    assert.equal(form.get("language"), "vi");
    assert.equal(form.get("response_format"), "verbose_json");
    assert.ok(form.get("file") instanceof Blob);

    const chatBody = JSON.parse(String(calls[1].init.body));
    assert.equal(chatBody.model, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.equal(chatBody.temperature, 0);
    assert.equal(chatBody.max_tokens, 256);
    assert.equal(chatBody.messages[1].content, "Bố ơi, con khỏe rồi.");
    assert.equal("reasoning_effort" in chatBody, false);
  });

  await t.test("bypasses the Cloudflare account dispatcher when a pool session exists", async () => {
    let dispatched = 0;
    const execution = {
      signal: new AbortController().signal,
      attempts: { used: 0, max: 2 },
      dispatcher: { execute: async () => { dispatched++; throw new Error("cloudflare dispatcher must not run"); } },
    } as unknown as CloudflareExecutionContext;
    globalThis.fetch = async (url) => String(url) === ASR_URL ? asrResponse("Con chào cô.") : chatResponse("Hello, teacher.");

    const result = await translateAudioToEnglish(audio, "vi", { execution });

    assert.equal(result.englishText, "Hello, teacher.");
    assert.equal(dispatched, 0);
  });

  await t.test("reports a missing API key as a configuration error without calling out", async () => {
    delete process.env.DEEPINFRA_API_KEY;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return asrResponse("x"); };

    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.code === "ASR_FAILED" && e.status === 503);
    assert.equal(calls, 0);
  });

  await t.test("keeps ASR rate limits as 429 and hides upstream text", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ detail: "private provider text" }, { status: 429 }); };

    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.code === "ASR_FAILED" && e.status === 429 &&
      e.details?.provider === "deepinfra" && e.details?.upstreamStatus === 429 &&
      !JSON.stringify(e.details).includes("private provider text"));
    assert.equal(calls, 1);
  });

  await t.test("reports a slow ASR call as a 504 timeout", async () => {
    process.env.DEEPINFRA_ASR_TIMEOUT_MS = "10";
    globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
        e instanceof AppError && e.status === 504 && e.details?.reason === "timeout");
    } finally { clearTimeout(keepAlive); delete process.env.DEEPINFRA_ASR_TIMEOUT_MS; }
  });

  await t.test("rejects low-confidence DeepInfra segments before paying for translation", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return asrResponse("Còn nhau lại", [{ avg_logprob: -1.2 }]);
    };

    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 422);
    assert.deepEqual(urls, [ASR_URL]);
  });

  await t.test("maps text provider failures to LLM_FAILED", async () => {
    globalThis.fetch = async (url) => String(url) === ASR_URL
      ? asrResponse("Con muốn uống nước.")
      : Response.json({ error: "boom" }, { status: 500 });

    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.code === "LLM_FAILED" && e.status === 502 &&
      e.details?.provider === "deepinfra" && e.details?.stage === "text_translation");
  });

  await t.test("drops reasoning blocks and forwards the configured reasoning effort", async () => {
    process.env.DEEPINFRA_TEXT_REASONING_EFFORT = "none";
    let chatBody: Record<string, unknown> = {};
    globalThis.fetch = async (url, init) => {
      if (String(url) === ASR_URL) return asrResponse("Con muốn uống nước.");
      chatBody = JSON.parse(String(init!.body));
      return chatResponse("<think>The child wants water.</think>\nI want to drink water.");
    };

    const result = await translateAudioToEnglish(audio, "vi");

    assert.equal(result.englishText, "I want to drink water.");
    assert.equal(chatBody.reasoning_effort, "none");
  });

  await t.test("can mix DeepInfra ASR with the Cloudflare text model", async () => {
    process.env.AUDIO_TEXT_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-account";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "cf-token";
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return String(url) === ASR_URL
        ? asrResponse("Con chào cô.")
        : Response.json({ choices: [{ message: { content: "Hello, teacher." } }] });
    };

    const result = await translateAudioToEnglish(audio, "vi");

    assert.equal(result.englishText, "Hello, teacher.");
    assert.equal(urls[0], ASR_URL);
    assert.match(urls[1], /api\.cloudflare\.com\/client\/v4\/accounts\/cf-account\/ai\/v1\/chat\/completions/);
  });

  await t.test("separates cache entries by provider and keeps Cloudflare keys stable", () => {
    delete process.env.AUDIO_ASR_PROVIDER;
    delete process.env.AUDIO_TEXT_PROVIDER;
    const cloudflareDefault = translationCacheKey("scope", "vi", "text", "xin chào");
    process.env.AUDIO_ASR_PROVIDER = "cloudflare";
    process.env.AUDIO_TEXT_PROVIDER = "cloudflare";
    assert.equal(translationCacheKey("scope", "vi", "text", "xin chào"), cloudflareDefault);
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra";
    assert.notEqual(translationCacheKey("scope", "vi", "text", "xin chào"), cloudflareDefault);
  });

  await t.test("rejects an unknown provider name", async () => {
    process.env.AUDIO_ASR_PROVIDER = "deepseek";
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 500);
  });
});

const CF_ASR = /api\.cloudflare\.com\/client\/v4\/accounts\/cf-account\/ai\/run\/@cf\/openai\/whisper-large-v3-turbo$/;
const CF_CHAT = /api\.cloudflare\.com\/client\/v4\/accounts\/cf-account\/ai\/v1\/chat\/completions$/;

test("DeepInfra first, Cloudflare fallback", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  t.beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEEPINFRA_TEXT_REASONING_EFFORT;
    delete process.env.DEEPINFRA_TEXT_MODEL;
    delete process.env.DEEPINFRA_ASR_MODEL;
    delete process.env.DEEPINFRA_BASE_URL;
    delete process.env.CLOUDFLARE_WORKERS_AI_MODEL;
    delete process.env.CLOUDFLARE_TEXT_MODEL;
    process.env.AUDIO_ASR_PROVIDER = "deepinfra,cloudflare";
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra,cloudflare";
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-account";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "cf-token";
  });
  const audio = new File(["audio-bytes"], "speech.wav", { type: "audio/wav" });
  const cfAsr = (text: string) => Response.json({ success: true, result: { text } });
  const cfChat = (content: string) => Response.json({ choices: [{ message: { content } }] });

  await t.test("uses only DeepInfra when it succeeds", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return String(url) === ASR_URL ? asrResponse("Con chào cô.") : chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "Hello, teacher.");
    assert.deepEqual(urls, [ASR_URL, CHAT_URL]);
  });

  await t.test("falls back to Cloudflare ASR when DeepInfra is rate limited, keeping DeepInfra for text", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      const target = String(url); urls.push(target);
      if (target === ASR_URL) return Response.json({ detail: "busy" }, { status: 429 });
      if (CF_ASR.test(target)) return cfAsr("Con chào cô.");
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "Hello, teacher.");
    assert.equal(result.model, "@cf/openai/whisper-large-v3-turbo");
    assert.equal(result.textModel, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.equal(urls.length, 3);
    assert.equal(urls[0], ASR_URL); assert.match(urls[1], CF_ASR); assert.equal(urls[2], CHAT_URL);
  });

  await t.test("falls back to Cloudflare text without repeating ASR", async () => {
    const urls: string[] = [];
    const stages: string[] = [];
    globalThis.fetch = async (url) => {
      const target = String(url); urls.push(target);
      if (target === ASR_URL) return asrResponse("Con muốn uống nước.");
      if (target === CHAT_URL) return Response.json({ error: "boom" }, { status: 503 });
      return cfChat("I want to drink water.");
    };
    const result = await translateAudioToEnglish(audio, "vi", { beforeProviderCall: async stage => { stages.push(stage); } });
    assert.equal(result.englishText, "I want to drink water.");
    assert.equal(result.textModel, "@cf/meta/llama-4-scout-17b-16e-instruct");
    assert.equal(urls.filter(u => u === ASR_URL).length, 1);
    assert.match(urls[2], CF_CHAT);
    assert.deepEqual(stages, ["asr", "text", "text"]);
  });

  await t.test("falls back when DeepInfra returns a non-English translation", async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === ASR_URL) return asrResponse("Con muốn uống nước.");
      if (target === CHAT_URL) return chatResponse("Con muốn uống nước.");
      return cfChat("I want to drink water.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "I want to drink water.");
  });

  await t.test("falls back when the DeepInfra key is missing", async () => {
    delete process.env.DEEPINFRA_API_KEY;
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      const target = String(url); urls.push(target);
      return CF_ASR.test(target) ? cfAsr("Con chào cô.") : cfChat("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "Hello, teacher.");
    assert.equal(urls.length, 2);
  });

  await t.test("does not retry unclear speech on Cloudflare", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url) => { urls.push(String(url)); return asrResponse("Còn nhau lại", [{ avg_logprob: -1.2 }]); };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 422);
    assert.deepEqual(urls, [ASR_URL]);
  });

  await t.test("reports the Cloudflare error when both providers fail", async () => {
    globalThis.fetch = async (url) => String(url) === ASR_URL
      ? Response.json({}, { status: 502 })
      : Response.json({ success: false, errors: [{ code: 1 }] }, { status: 429 });
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 429 && e.details?.provider === "cloudflare");
  });

  await t.test("falls back through the Cloudflare account dispatcher in pooled mode", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    const operations: string[] = [];
    const execution = {
      signal: new AbortController().signal,
      attempts: { used: 0, max: 2 },
      dispatcher: {
        execute: async (request: { operation: string }, run: (input: unknown) => Promise<unknown>) => {
          operations.push(request.operation);
          return run({ account: { accountId: "cf-account", apiToken: "pool-token" }, signal: new AbortController().signal });
        },
      },
    } as unknown as CloudflareExecutionContext;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === ASR_URL) return Response.json({}, { status: 500 });
      if (CF_ASR.test(target)) return cfAsr("Con chào cô.");
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi", { execution });
    assert.equal(result.englishText, "Hello, teacher.");
    assert.deepEqual(operations, ["audio_translation_asr"]);
  });

  await t.test("does not fall back once the request deadline has passed", async () => {
    const controller = new AbortController();
    const execution = {
      signal: controller.signal,
      attempts: { used: 0, max: 2 },
      dispatcher: { execute: async () => { throw new Error("must not fall back"); } },
    } as unknown as CloudflareExecutionContext;
    globalThis.fetch = async () => { controller.abort(new Error("deadline")); throw new TypeError("aborted"); };
    await assert.rejects(translateAudioToEnglish(audio, "vi", { execution }), (e: unknown) =>
      e instanceof AppError && e.details?.provider === "deepinfra");
  });

  await t.test("reports each fallback without exposing upstream text, even if the hook throws", async () => {
    const events: unknown[] = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === ASR_URL) return Response.json({ detail: "private provider text" }, { status: 429 });
      if (CF_ASR.test(target)) return cfAsr("Con chào cô.");
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi", {
      onProviderFallback: event => { events.push(event); throw new Error("logger down"); },
    });
    assert.equal(result.englishText, "Hello, teacher.");
    assert.equal(events.length, 1);
    assert.deepEqual({ ...(events[0] as object) }, {
      stage: "asr", from: "deepinfra", to: "cloudflare", status: 429, reason: "rate_limited", upstreamStatus: 429,
    });
  });

  await t.test("keys the cache by the whole provider order", () => {
    const withFallback = translationCacheKey("scope", "vi", "text", "xin chào");
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra";
    process.env.AUDIO_ASR_PROVIDER = "deepinfra";
    assert.notEqual(translationCacheKey("scope", "vi", "text", "xin chào"), withFallback);
  });

  await t.test("rejects an unknown provider inside the list", async () => {
    process.env.AUDIO_ASR_PROVIDER = "deepinfra,deepseek";
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 500);
  });
});
