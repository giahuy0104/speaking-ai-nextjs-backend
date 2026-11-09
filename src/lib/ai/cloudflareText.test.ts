import assert from "node:assert/strict";
import test from "node:test";
import { getFailureDiagnostics } from "./cloudflare/providerError";
import type { CloudflareExecutionContext } from "./cloudflare/types";
import {
  buildCloudflareTextTranslationBody,
  CloudflareTextProviderError,
  getCloudflareTextConfig,
  translateVietnameseWithCloudflare,
  type CloudflareTextCompletionMetadata,
} from "./cloudflareText";

test("translation timeout allows full sentences and honors explicit configuration", () => {
  const original = { ...process.env };
  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
    delete process.env.CLOUDFLARE_TEXT_TIMEOUT_MS;
    assert.equal(getCloudflareTextConfig().timeoutMs, 6000);
    process.env.CLOUDFLARE_TEXT_TIMEOUT_MS = "8000";
    assert.equal(getCloudflareTextConfig().timeoutMs, 8000);
  } finally {
    for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_AI_API_TOKEN", "CLOUDFLARE_TEXT_TIMEOUT_MS"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test("builds a deterministic faithful-translation request for Cloudflare", () => {
  const body = buildCloudflareTextTranslationBody(
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "Translate faithfully. English only.",
    "Mẹ ơi, con muốn mua cái này.",
  );

  assert.equal(
    body.model,
    "@cf/meta/llama-4-scout-17b-16e-instruct",
  );
  assert.equal(body.temperature, 0);
  assert.equal(body.max_completion_tokens, 48);
  assert.deepEqual(body.messages, [
    { role: "system", content: "Translate faithfully. English only." },
    { role: "user", content: "Mẹ ơi, con muốn mua cái này." },
  ]);
});

test("parses a successful Cloudflare chat completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        { message: { content: "Mom, I want to buy this." } },
      ],
    });

  try {
    const result = await translateVietnameseWithCloudflare(
      "Mẹ ơi, con muốn mua cái này.",
      "Translate faithfully.",
    );
    assert.equal(result.englishText, "Mom, I want to buy this.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalToken === undefined) {
      delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
    }
  }
});

test("classifies Cloudflare rate limits so the router can fall back", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  globalThis.fetch = async () =>
    Response.json({ errors: [{ code: 3036 }] }, { status: 429 });

  try {
    await assert.rejects(
      () =>
        translateVietnameseWithCloudflare(
          "Con muốn uống nước.",
          "Translate faithfully.",
        ),
      (error: unknown) =>
        error instanceof CloudflareTextProviderError &&
        error.reason === "rate_limited" &&
        error.status === 429,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalToken === undefined) {
      delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
    }
  }
});

test("completion telemetry is sanitized in legacy and execution paths without changing the result", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT = "false";
  const model = getCloudflareTextConfig().model;
  const execution: CloudflareExecutionContext = {
    requestId: "completion-test-request", workload: "audio-translate", deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal, attempts: { used: 0, max: 1 },
    dispatcher: { async execute({ context }, callback) {
      const limit = { rpm: 60, burst: 2, maxConcurrent: 1 };
      return callback({ signal: context.signal, account: {
        alias: "test", accountId: "test-account", identity: "test", apiToken: "test-token", enabled: true,
        capabilities: { text: [model], asr: [] }, limits: { text: limit, asr: limit, accountMaxConcurrent: 1 },
      } });
    } },
  };
  for (const context of [undefined, execution]) {
    let metadata: CloudflareTextCompletionMetadata | undefined;
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "Bonjour." }, finish_reason: "stop" }], usage: { completion_tokens: 4 },
    });
    const result = await translateVietnameseWithCloudflare("Xin chào.", "French only.", 512, {
      execution: context, onCompletion: value => { metadata = value; },
    });
    assert.deepEqual(result, { englishText: "Bonjour.", model });
    assert.deepEqual(metadata, { model, upstreamStatus: 200, finishReason: "stop", completionTokens: 4 });
    assert.ok(Object.isFrozen(metadata));
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "Bonjour." }, finish_reason: "private provider string" }],
      usage: { completion_tokens: "secret" },
    });
    await translateVietnameseWithCloudflare("Xin chào.", "French only.", 512, {
      execution: context, onCompletion: value => { metadata = value; },
    });
    assert.deepEqual(metadata, { model, upstreamStatus: 200, finishReason: "other" });
    assert.deepEqual(await translateVietnameseWithCloudflare("Xin chào.", "French only.", 512, {
      execution: context, onCompletion: () => { throw Error("telemetry failure"); },
    }), { englishText: "Bonjour.", model });
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 512 },
    });
    await assert.rejects(translateVietnameseWithCloudflare("Xin chào.", "French only.", 512, {
      execution: context, onCompletion: value => { metadata = value; },
    }), { reason: "empty_response" });
    assert.equal(metadata!.finishReason, "length", "empty completions still report why generation stopped");
  }
});

test("legacy text errors keep bounded upstream codes and reject invalid envelopes", async t => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT = "false";
  globalThis.fetch = async () => Response.json({ errors: [{ code: 3036, message: "private provider details" }] }, { status: 429 });
  await assert.rejects(translateVietnameseWithCloudflare("Con khát.", "Translate."), error => {
    assert.deepEqual(getFailureDiagnostics(error), { failureSource: "cloudflare", upstreamStatus: 429, upstreamCodes: [3036] });
    return true;
  });
  for (const response of [new Response("not JSON"), Response.json({ success: false, choices: [{ message: { content: "must not be accepted" } }] })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(translateVietnameseWithCloudflare("Con khát.", "Translate."), { reason: "invalid_response" });
  }
});
