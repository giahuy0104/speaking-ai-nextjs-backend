import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../appError";
import { translateAudioToEnglish } from "./cloudflareWorkersAi";
import { translationCacheKey } from "./audioTranslationCache";
import type { CloudflareExecutionContext } from "./cloudflare/types";
import {
  DeepInfraProviderError,
  getDeepInfraConfig,
  resetDeepInfraStageLimitersForTests,
  setDeepInfraTransportForTests,
  transcribeWithDeepInfra,
} from "./deepInfra";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; setDeepInfraTransportForTests(undefined); });
  t.beforeEach(() => {
    // Route DeepInfra through the mocked global fetch instead of the keep-alive agent.
    setDeepInfraTransportForTests((url, init) => globalThis.fetch(url, init));
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

  await t.test("keeps ASR rate limits as 429 after one retry and hides upstream text", async () => {
    process.env.DEEPINFRA_429_RETRY_DELAY_MS = "1";
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ detail: "private provider text" }, { status: 429 }); };

    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.code === "ASR_FAILED" && e.status === 429 &&
      e.details?.provider === "deepinfra" && e.details?.upstreamStatus === 429 &&
      !JSON.stringify(e.details).includes("private provider text"));
    assert.equal(calls, 2, "one retry after the 429, then the refusal is reported");
  });

  await t.test("a 429 retried once succeeds without failing the turn", async () => {
    process.env.DEEPINFRA_429_RETRY_DELAY_MS = "1";
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url) === ASR_URL && urls.filter(seen => seen === ASR_URL).length === 1) {
        return Response.json({ detail: "busy" }, { status: 429 });
      }
      return String(url) === ASR_URL ? asrResponse("Con chào cô.") : chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "Hello, teacher.");
    assert.deepEqual(urls, [ASR_URL, ASR_URL, CHAT_URL]);
  });

  await t.test("DEEPINFRA_429_RETRIES=0 reports the first 429; other errors are never retried", async () => {
    process.env.DEEPINFRA_429_RETRIES = "0";
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 429 }); };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 429);
    assert.equal(calls, 1);
    delete process.env.DEEPINFRA_429_RETRIES;
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({}, { status: 503 }); };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 502);
    assert.equal(calls, 1);
  });

  await t.test("calls over the per-backend cap wait for a slot, then give up with queue_timeout", async () => {
    process.env.DEEPINFRA_ASR_MAX_CONCURRENCY = "1";
    process.env.DEEPINFRA_ASR_QUEUE_WAIT_MS = "30";
    resetDeepInfraStageLimitersForTests();
    let calls = 0;
    let answer!: () => void;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { answer = resolve; });
      return asrResponse("Con chào cô.");
    };
    try {
      const first = transcribeWithDeepInfra(audio, "speech.wav", "vi");
      // The second call waits behind the first, then is refused without reaching DeepInfra.
      await assert.rejects(transcribeWithDeepInfra(audio, "speech.wav", "vi"),
        (e: unknown) => e instanceof DeepInfraProviderError && e.reason === "queue_timeout");
      assert.equal(calls, 1);
      // A waiting call gets the slot as soon as it frees.
      const third = transcribeWithDeepInfra(audio, "speech.wav", "vi");
      answer();
      assert.equal((await first).text, "Con chào cô.");
      assert.equal((await third).text, "Con chào cô.");
      assert.equal(calls, 2);
    } finally {
      resetDeepInfraStageLimitersForTests();
    }
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
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; setDeepInfraTransportForTests(undefined); });
  t.beforeEach(() => {
    // Route DeepInfra through the mocked global fetch instead of the keep-alive agent.
    setDeepInfraTransportForTests((url, init) => globalThis.fetch(url, init));
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

  await t.test("falls back to Cloudflare ASR when DeepInfra stays rate limited, keeping DeepInfra for text", async () => {
    process.env.DEEPINFRA_429_RETRIES = "0";
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
      stage: "asr", from: "deepinfra", to: "cloudflare", trigger: "error", status: 429, reason: "rate_limited", upstreamStatus: 429,
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

/** A provider response that arrives after `ms` unless the request is aborted first. */
function delayed(ms: number, signal: AbortSignal | null | undefined, response: () => Response, aborted?: () => void) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(response()), ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); aborted?.(); reject(signal.reason); }, { once: true });
  });
}

test("real keep-alive transport sends a multipart upload", async (t) => {
  const originalEnv = { ...process.env };
  const received: { contentType?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received.push({ contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString("latin1") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "Con chào cô.", segments: [] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    process.env = originalEnv;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  setDeepInfraTransportForTests(undefined);
  process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
  process.env.DEEPINFRA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/openai`;

  const result = await transcribeWithDeepInfra(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }), "cau-3.m4a", "vi");

  assert.equal(result.text, "Con chào cô.");
  assert.equal(received.length, 1);
  assert.match(received[0].contentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(received[0].body, /name="model"\r\n\r\nopenai\/whisper-large-v3-turbo/);
  assert.match(received[0].body, /name="file"; filename="cau-3.m4a"/);
});

test("only loopback hosts may use plain HTTP", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
    process.env.DEEPINFRA_BASE_URL = "http://api.deepinfra.com/v1/openai";
    assert.throws(() => getDeepInfraConfig(), /invalid_base_url/);
    process.env.DEEPINFRA_BASE_URL = "http://localhost:9999/v1/openai";
    assert.equal(getDeepInfraConfig().baseUrl, "http://localhost:9999/v1/openai");
  } finally { process.env = originalEnv; }
});

test("keep-alive transport and hedged requests", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; setDeepInfraTransportForTests(undefined); });
  t.beforeEach(() => {
    setDeepInfraTransportForTests((url, init) => globalThis.fetch(url, init));
    process.env = { ...originalEnv };
    for (const key of ["DEEPINFRA_TEXT_REASONING_EFFORT", "DEEPINFRA_TEXT_MODEL", "DEEPINFRA_ASR_MODEL", "DEEPINFRA_BASE_URL",
      "CLOUDFLARE_WORKERS_AI_MODEL", "CLOUDFLARE_TEXT_MODEL", "AUDIO_ASR_HEDGE_MS", "AUDIO_TEXT_HEDGE_MS"]) delete process.env[key];
    process.env.AUDIO_ASR_PROVIDER = "deepinfra,cloudflare";
    process.env.AUDIO_TEXT_PROVIDER = "deepinfra,cloudflare";
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "cf-account";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "cf-token";
  });
  const audio = new File(["audio-bytes"], "speech.wav", { type: "audio/wav" });
  const cfAsr = (text: string) => Response.json({ success: true, result: { text } });
  const cfChat = (content: string) => Response.json({ choices: [{ message: { content } }] });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));

  await t.test("sends DeepInfra calls through a keep-alive dispatcher", async () => {
    let dispatcher: unknown;
    setDeepInfraTransportForTests((url, init) => { dispatcher = (init as { dispatcher?: unknown }).dispatcher; return globalThis.fetch(url, init); });
    globalThis.fetch = async (url) => String(url) === ASR_URL ? asrResponse("Con chào cô.") : chatResponse("Hello, teacher.");
    await translateAudioToEnglish(audio, "vi");
    assert.ok(dispatcher, "DeepInfra requests must carry the keep-alive agent");
  });

  await t.test("never hedges when no hedge delay is configured", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url); urls.push(target);
      if (target === ASR_URL) return delayed(80, init?.signal, () => asrResponse("Con chào cô."));
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.deepEqual(urls, [ASR_URL, CHAT_URL]);
  });

  await t.test("starts Cloudflare ASR when DeepInfra is slow and cancels the slower call", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "30";
    let deepInfraCancelled = false;
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === ASR_URL) return delayed(500, init?.signal, () => asrResponse("Con chào cô."), () => { deepInfraCancelled = true; });
      if (CF_ASR.test(target)) return cfAsr("Con chào cô.");
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi", { onProviderFallback: event => { events.push({ ...event }); } });
    assert.equal(result.model, "@cf/openai/whisper-large-v3-turbo");
    assert.equal(result.textModel, "deepseek-ai/DeepSeek-V4-Flash-0731");
    assert.equal(deepInfraCancelled, true);
    assert.deepEqual(events, [{ stage: "asr", from: "deepinfra", to: "cloudflare", trigger: "slow" }]);
  });

  await t.test("keeps the DeepInfra answer when it arrives before the hedge delay", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "200";
    const urls: string[] = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url); urls.push(target);
      if (target === ASR_URL) return delayed(10, init?.signal, () => asrResponse("Con chào cô."));
      return chatResponse("Hello, teacher.");
    };
    await translateAudioToEnglish(audio, "vi");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(urls, [ASR_URL, CHAT_URL]);
  });

  await t.test("hedges the text step independently of ASR", async () => {
    process.env.AUDIO_TEXT_HEDGE_MS = "30";
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === ASR_URL) return asrResponse("Con muốn uống nước.");
      if (target === CHAT_URL) return delayed(500, init?.signal, () => chatResponse("I want water."));
      return cfChat("I want to drink water.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.equal(result.englishText, "I want to drink water.");
    assert.equal(result.textModel, "@cf/meta/llama-4-scout-17b-16e-instruct");
  });

  await t.test("waits for the slow primary when the hedge fails", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "20";
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === ASR_URL) return delayed(120, init?.signal, () => asrResponse("Con chào cô."));
      if (CF_ASR.test(target)) return Response.json({ success: false, errors: [{ code: 1 }] }, { status: 429 });
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.equal(result.englishText, "Hello, teacher.");
  });

  await t.test("reports the Cloudflare error when both hedged calls fail", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "20";
    globalThis.fetch = async (url, init) => String(url) === ASR_URL
      ? delayed(80, init?.signal, () => Response.json({}, { status: 502 }))
      : Response.json({ success: false, errors: [{ code: 1 }] }, { status: 429 });
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 429 && e.details?.provider === "cloudflare");
  });

  await t.test("a hedge admitted after the winner never marks the job in-flight again", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "10";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    const stages: string[] = [];
    let cloudflareFetches = 0;
    let releaseAdmission: () => void = () => {};
    const admitted = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const execution = {
      signal: new AbortController().signal,
      attempts: { used: 0, max: 2 },
      dispatcher: {
        // Simulates a pool admission queue that only frees a slot after DeepInfra has answered.
        execute: async (_request: unknown, run: (input: unknown) => Promise<unknown>) => {
          await admitted;
          return run({ account: { accountId: "cf-account", apiToken: "pool-token" }, signal: new AbortController().signal });
        },
      },
    } as unknown as CloudflareExecutionContext;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === ASR_URL) return delayed(40, init?.signal, () => asrResponse("Con chào cô."));
      if (CF_ASR.test(target)) { cloudflareFetches++; return cfAsr("Con chào cô."); }
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi", { execution, beforeProviderCall: async stage => { stages.push(stage); } });
    releaseAdmission();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.deepEqual(stages, ["asr", "text"]);
    assert.equal(cloudflareFetches, 0);
  });

  await t.test("cancels the losing Cloudflare call inside the account pool", async () => {
    process.env.AUDIO_ASR_HEDGE_MS = "20";
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    let cloudflareCancelled = false;
    const execution = {
      signal: new AbortController().signal,
      attempts: { used: 0, max: 2 },
      dispatcher: {
        execute: async (_request: unknown, run: (input: unknown) => Promise<unknown>) =>
          run({ account: { accountId: "cf-account", apiToken: "pool-token" }, signal: new AbortController().signal }),
      },
    } as unknown as CloudflareExecutionContext;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target === ASR_URL) return delayed(60, init?.signal, () => asrResponse("Con chào cô."));
      if (CF_ASR.test(target)) return delayed(1000, init?.signal, () => cfAsr("Con chào cô."), () => { cloudflareCancelled = true; });
      return chatResponse("Hello, teacher.");
    };
    const result = await translateAudioToEnglish(audio, "vi", { execution });
    assert.equal(result.model, "openai/whisper-large-v3-turbo");
    assert.equal(cloudflareCancelled, true);
  });
});
