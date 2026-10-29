import assert from "node:assert/strict";
import test from "node:test";
import { translateAudioToEnglish } from "./cloudflareWorkersAi";
import { AppError } from "../appError";
import { isEnglishAudioTranslation, isSuspiciousAudioTranscript } from "./audioTranslationQuality";

test("translation deadline and upstream failures", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; });
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_WORKERS_AI_TIMEOUT_MS = "1";
  delete process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS;
  const audio = new File(["audio"], "speech.mp3", { type: "audio/mpeg" });

  await t.test("batch response survives the legacy short ASR deadline", async () => {
    globalThis.fetch = async (url) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return String(url).includes("chat/completions")
        ? Response.json({ choices: [{ message: { content: "Dad, I am feeling better now." } }] })
        : Response.json({ success: true, result: { text: "Bố ơi, con khỏe rồi." } });
    };
    const result = await translateAudioToEnglish(audio, "vi");
    assert.equal(result.englishText, "Dad, I am feeling better now.");
    assert.equal(result.sourceText, "Bố ơi, con khỏe rồi.");
    assert.equal(result.segments, undefined);
  });

  await t.test("deadline aborts slow response bodies and reports 504", async () => {
    process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS = "10";
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
      },
    }));
    // Keep the event loop alive: AbortSignal.timeout uses an unreferenced timer.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
        e instanceof AppError && e.status === 504 && e.details?.reason === "timeout");
    } finally { clearTimeout(keepAlive); delete process.env.CLOUDFLARE_AUDIO_TRANSLATION_TIMEOUT_MS; }
  });

  await t.test("rate limit is preserved without retrying or exposing upstream text", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ success: false, errors: [{ code: 123, message: "private provider text" }] }, { status: 429 });
    };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 429 && e.details?.upstreamStatus === 429 &&
      !JSON.stringify(e.details).includes("private provider text"));
    assert.equal(calls, 1);
  });

  await t.test("network failure is distinguishable from timeout", async () => {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 502 && e.details?.reason === "network_error");
  });

  await t.test("invalid provider body remains a failure", async () => {
    globalThis.fetch = async () => new Response("not json");
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.status === 502 && e.details?.reason === "invalid_response");
  });

  await t.test("rejects low-confidence speech before paying for translation", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ success: true, result: { text: "Còn nhau lại", segments: [{ avg_logprob: -1.2 }] } });
    };
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) => e instanceof AppError && e.status === 422);
    assert.equal(calls, 1);
  });

  await t.test("cannot label Vietnamese model output as English", async () => {
    globalThis.fetch = async (url) => String(url).includes("chat/completions")
      ? Response.json({ choices: [{ message: { content: "Con khỏe rồi." } }] })
      : Response.json({ success: true, result: { text: "Con khỏe rồi." } });
    await assert.rejects(translateAudioToEnglish(audio, "vi"), (e: unknown) =>
      e instanceof AppError && e.details?.reason === "invalid_translation_language");
  });

  await t.test("English source avoids an unnecessary second provider call", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ success: true, result: { text: "I feel better." } }); };
    assert.equal((await translateAudioToEnglish(audio, "en")).englishText, "I feel better.");
    assert.equal(calls, 1);
  });
});

test("rejects source-language output and common ASR hallucinations", () => {
  assert.equal(isEnglishAudioTranslation("Bố ơi, con khỏe rồi."), false);
  assert.equal(isEnglishAudioTranslation("你好"), false);
  assert.equal(isEnglishAudioTranslation("Dad, I feel better now."), true);
  assert.equal(isSuspiciousAudioTranscript("Hãy subscribe cho kênh lalaschool"), true);
  assert.equal(isSuspiciousAudioTranscript("Con đang mặc áo."), false);
});
