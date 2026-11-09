import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../appError";
import {
  translateAudioToEnglish,
  transcribeAudioToEnglish,
  transcribeAudioToVietnamese,
} from "./cloudflareWorkersAi";
import { translateVietnameseWithCloudflare } from "./cloudflareText";
import { isPoolFailure } from "./cloudflare/providerError";
import type {
  CloudflareAccount,
  CloudflareDispatcher,
  CloudflareExecutionContext,
  CloudflareOperation,
} from "./cloudflare/types";

const asrModel = "@cf/openai/whisper-large-v3-turbo";
const textModel = "@cf/meta/llama-4-scout-17b-16e-instruct";
const audio = new File(["audio"], "speech.mp3", { type: "audio/mpeg" });

function account(alias: string): CloudflareAccount {
  const limit = { rpm: 60, burst: 2, maxConcurrent: 2 };
  return {
    alias, accountId: `dedicated-${alias}`, identity: alias, apiToken: `token-${alias}`,
    enabled: true, capabilities: { asr: [asrModel], text: [textModel] },
    limits: { asr: limit, text: limit, accountMaxConcurrent: 2 },
  };
}

function execution(
  requestId: string,
  calls: Array<{ requestId: string; operation: CloudflareOperation }>,
): CloudflareExecutionContext {
  const dispatcher: CloudflareDispatcher = {
    async execute({ context, operation }, callback) {
      calls.push({ requestId: context.requestId, operation });
      return callback({ account: account(`${requestId}-${operation}`), signal: context.signal });
    },
  };
  return {
    requestId, workload: "audio-translate", deadlineAt: Date.now() + 20_000,
    signal: new AbortController().signal, attempts: { used: 0, max: 3 }, dispatcher,
  };
}

test("optional execution preserves legacy credentials and isolates pooled requests", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  delete process.env.CLOUDFLARE_WORKERS_AI_MODEL;
  delete process.env.CLOUDFLARE_TEXT_MODEL;
  process.env.CLOUDFLARE_ACCOUNT_ID = "legacy-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "legacy-token";
  process.env.CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED = "true";
  process.env.CLOUDFLARE_ACCOUNTS_JSON = "broken pool configuration";

  await t.test("old callers ignore all pool settings, including invalid pool config", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (url, init) => {
      requests.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer legacy-token");
      return String(url).includes("chat/completions")
        ? Response.json({ choices: [{ message: { content: "I feel better." } }] })
        : Response.json({ success: true, result: { text: "I feel better." } });
    };
    assert.equal((await translateAudioToEnglish(audio, "en")).englishText, "I feel better.");
    assert.equal((await transcribeAudioToEnglish(audio)).englishText, "I feel better.");
    assert.equal((await transcribeAudioToVietnamese(audio)).vietnameseText, "I feel better.");
    assert.equal((await translateVietnameseWithCloudflare("Con khỏe rồi.", "Translate.")).englishText, "I feel better.");
    assert.equal(requests.length, 4);
    assert.ok(requests.every((url) => url.includes("/accounts/legacy-account/")));
  });

  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;

  await t.test("pool ASR and text use their permitted accounts without legacy tokens", async () => {
    const calls: Array<{ requestId: string; operation: CloudflareOperation }> = [];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (url, init) => {
      const path = String(url);
      const operation = path.includes("chat/completions") ? "audio_translation_text" : "audio_translation_asr";
      assert.ok(path.includes(`/accounts/dedicated-first-${operation}/`));
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer token-first-${operation}`);
      requests.push({ url: path, body: JSON.parse(String(init?.body)) });
      return operation === "audio_translation_text"
        ? Response.json({ choices: [{ message: { content: "Dad, I feel better now." } }] })
        : Response.json({ success: true, result: { text: "Bố ơi, con khỏe rồi." } });
    };
    const result = await translateAudioToEnglish(audio, "vi", { execution: execution("first", calls) });
    assert.equal(result.englishText, "Dad, I feel better now.");
    assert.equal(result.sourceText, "Bố ơi, con khỏe rồi.");
    assert.equal(result.model, asrModel);
    assert.equal(result.textModel, textModel);
    assert.deepEqual(calls.map((entry) => entry.operation), ["audio_translation_asr", "audio_translation_text"]);
    assert.equal(requests[0].body.task, "transcribe");
    assert.equal(requests[0].body.language, "vi");
    assert.equal(requests[1].body.max_completion_tokens, 256);
    assert.equal(requests[1].body.temperature, 0);
    assert.ok(!JSON.stringify(result).includes("dedicated"));
  });

  await t.test("concurrent requests never share credentials or execution context", async () => {
    const calls: Array<{ requestId: string; operation: CloudflareOperation }> = [];
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 2));
      return Response.json({ success: true, result: { text: "I feel better." } });
    };
    const results = await Promise.all([
      translateAudioToEnglish(audio, "en", { execution: execution("request-a", calls) }),
      translateAudioToEnglish(audio, "en", { execution: execution("request-b", calls) }),
    ]);
    assert.equal(results.length, 2);
    assert.equal(calls.length, 2, "English input skips text inference");
    assert.deepEqual(new Set(calls.map((entry) => entry.requestId)), new Set(["request-a", "request-b"]));
    assert.ok(urls.some((url) => url.includes("dedicated-request-a-")));
    assert.ok(urls.some((url) => url.includes("dedicated-request-b-")));
  });

  await t.test("provider envelopes become safe internal faults before dispatcher retry", async () => {
    const calls: Array<{ requestId: string; operation: CloudflareOperation }> = [];
    for (const status of [200, 429]) {
      globalThis.fetch = async () => Response.json({ success: false, errors: [{ code: 4006, message: "secret-token private-account" }] }, { status });
      await assert.rejects(translateAudioToEnglish(audio, "en", { execution: execution("failure", calls) }), (error: unknown) => {
        assert.ok(isPoolFailure(error));
        assert.ok(!JSON.stringify(error).includes("secret-token"));
        assert.ok(!String(error).includes("private-account"));
        return true;
      });
    }
  });

  await t.test("text faults preserve the text stage and never restart ASR", async () => {
    const calls: Array<{ requestId: string; operation: CloudflareOperation }> = [];
    globalThis.fetch = async (url) => String(url).includes("chat/completions")
      ? Response.json({ errors: [{ code: 4006 }] }, { status: 429 })
      : Response.json({ success: true, result: { text: "Con khỏe rồi." } });
    await assert.rejects(translateAudioToEnglish(audio, "vi", { execution: execution("text-failure", calls) }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "LLM_FAILED");
      assert.equal(error.status, 429);
      return true;
    });
    assert.deepEqual(calls.map((entry) => entry.operation), ["audio_translation_asr", "audio_translation_text"]);
  });

  await t.test("quality rejection happens after ASR admission and before text admission", async () => {
    const calls: Array<{ requestId: string; operation: CloudflareOperation }> = [];
    globalThis.fetch = async () => Response.json({ success: true, result: { text: "Còn nhau lại", segments: [{ avg_logprob: -1.2 }] } });
    await assert.rejects(translateAudioToEnglish(audio, "vi", { execution: execution("quality", calls) }), (error: unknown) => error instanceof AppError && error.status === 422);
    assert.equal(calls.length, 1);
  });

  await t.test("the admission callback includes reading the complete provider body", async () => {
    let callbackActive = false;
    let bodyReadInsidePermit = false;
    const context = execution("body", []);
    const dispatcher: CloudflareDispatcher = {
      async execute(_input, callback) {
        callbackActive = true;
        const result = await callback({ account: account("body"), signal: context.signal });
        callbackActive = false;
        return result;
      },
    };
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          bodyReadInsidePermit = callbackActive;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ success: true, result: { text: "I feel better." } })));
          controller.close();
        }, 2);
      },
    }));
    await translateAudioToEnglish(audio, "en", { execution: { ...context, dispatcher } });
    assert.equal(bodyReadInsidePermit, true);
    assert.equal(callbackActive, false);
  });
});
