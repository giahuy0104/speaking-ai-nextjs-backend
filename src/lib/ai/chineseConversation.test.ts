import assert from "node:assert/strict";
import test from "node:test";
import { buildChineseInstruction, buildTargetLanguageInstruction } from "./prompts";
import { translateVietnameseWithCloudflare } from "./cloudflareText";

test("sends one direct Vietnamese to Chinese request", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  let requestCount = 0;
  globalThis.fetch = async (_url, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[1].content, "Con muốn uống nước.");
    assert.match(body.messages[0].content, /Simplified Chinese/);
    return Response.json({
      choices: [{ message: { content: "我想喝水。" } }],
    });
  };

  try {
    const result = await translateVietnameseWithCloudflare(
      "Con muốn uống nước.",
      buildChineseInstruction("home", 6),
    );
    assert.equal(requestCount, 1);
    assert.equal(result.englishText, "我想喝水。");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalToken === undefined)
      delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    else process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
  }
});

for (const { language, translation, languageName } of [
  { language: "ja", translation: "水が飲みたい。", languageName: "Japanese" },
  { language: "ko", translation: "물을 마시고 싶어요.", languageName: "Korean" },
  { language: "fr", translation: "Je veux boire de l’eau.", languageName: "French" },
] as const) {
  test(`sends one direct Vietnamese to ${languageName} request`, async () => {
    const originalFetch = globalThis.fetch;
    const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
    let requestCount = 0;
    globalThis.fetch = async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[1].content, "Con muốn uống nước.");
      assert.match(body.messages[0].content, new RegExp(languageName));
      return Response.json({ choices: [{ message: { content: translation } }] });
    };

    try {
      const instruction = buildTargetLanguageInstruction(language, "home", 6);
      assert.match(instruction, /Vietnamese utterance directly/);
      const result = await translateVietnameseWithCloudflare(
        "Con muốn uống nước.",
        instruction,
      );
      assert.equal(requestCount, 1);
      assert.equal(result.englishText, translation);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
      if (originalToken === undefined)
        delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
      else process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
    }
  });
}
