import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

const originalLoad = Module._load;
let cacheStubLoaded = false;
Module._load = function(specifier, ...args) {
  if (specifier === "server-only") return {};
  if (specifier === "./textCache") {
    cacheStubLoaded = true;
    return {
      getCachedAiEnglishText: async () => null,
      saveAiEnglishText: async () => { throw new Error("cache unavailable"); },
    };
  }
  return originalLoad.call(this, specifier, ...args);
};

const originalFetch = globalThis.fetch;
const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
let generate;
before(async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  generate = (await import("./llm.ts")).generateEnglishSentence;
  assert.equal(cacheStubLoaded, true, "cache writes must use the failing test stub");
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ["CLOUDFLARE_ACCOUNT_ID", originalAccount],
    ["CLOUDFLARE_WORKERS_AI_API_TOKEN", originalToken],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Module._load = originalLoad;
});

test("provider errors never become a request to repeat; immediate retry can succeed", async () => {
  for (const reason of ["timeout", "rate_limited", "empty_response"]) {
    globalThis.fetch = async () => {
      if (reason === "timeout") throw new DOMException("timed out", "TimeoutError");
      return reason === "rate_limited"
        ? Response.json({}, { status: 429 })
        : Response.json({ choices: [] });
    };
    const source = `Con muốn xem cầu vồng ${reason}.`;
    await assert.rejects(
      generate(source, "home", 6, undefined, undefined, false, true),
      (error) => {
        assert.equal(error.code, "LLM_FAILED");
        assert.equal(error.status, 503);
        assert.equal(error.details.reason, reason);
        return true;
      },
    );
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: "I want to see a rainbow." } }],
    });
    // Cache storage is deliberately unavailable. The valid translation survives.
    const result = await generate(source, "home", 6, undefined, undefined, false, true);
    assert.equal(result.englishText, "I want to see a rainbow.");
    assert.equal(result.mode, "ai");
  }
});

test("unclear input still requests repetition without calling the provider", async () => {
  globalThis.fetch = async () => { throw new Error("unexpected provider call"); };
  const result = await generate("um", "home", 6, undefined, undefined, false, true);
  assert.equal(result.mode, "fallback");
});
