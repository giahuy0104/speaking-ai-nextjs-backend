import assert from "node:assert/strict";
import test from "node:test";
import { parsePoolConfig } from "./accountConfig";
import { operationTask, quotaRules } from "./quotaPolicy";

const model = "@cf/openai/whisper-large-v3-turbo";
const secondAsrModel = "@cf/openai/another-asr";
const text = "@cf/meta/llama-4-scout-17b-16e-instruct";
function account() {
  return parsePoolConfig({
    CLOUDFLARE_POOL_STORE: "memory",
    TOKEN: "test-token",
    CLOUDFLARE_ACCOUNTS_JSON: JSON.stringify([{
      alias: "audio-a", accountId: "11111111111111111111111111111111", apiTokenEnv: "TOKEN", enabled: true,
      capabilities: { asr: [model, secondAsrModel], text: [text] },
      limits: {
        asr: { rpm: 600, burst: 10, maxConcurrent: 10 },
        text: { rpm: 240, burst: 4, maxConcurrent: 4 },
        accountMaxConcurrent: 14,
        models: { [model]: { rpm: 60, burst: 2, maxConcurrent: 2 } },
      },
    }]),
  }).accounts[0];
}

test("task and model quota are subordinate to account concurrency", () => {
  const rules = quotaRules(account(), "audio_translation_asr", model);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { key: "account", maxConcurrent: 14 });
  assert.deepEqual(rules[1], { key: "task:asr", rpm: 600, burst: 10, maxConcurrent: 10 });
  assert.equal(rules[2].rpm, 60);
  assert.match(rules[2].key, /^model:[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(rules));
  assert.ok(rules.every(Object.isFrozen));
});

test("two models share the same task quota instead of duplicating it", () => {
  const first = quotaRules(account(), "audio_translation_asr", model);
  const second = quotaRules(account(), "audio_translation_asr", secondAsrModel);
  assert.deepEqual(first[1], second[1]);
  assert.equal(second.length, 2);
  const textRules = quotaRules(account(), "audio_translation_text", text);
  assert.deepEqual(first[0], textRules[0]);
  assert.equal(textRules[1].key, "task:text");
  assert.equal(textRules[1].rpm, 240);
  assert.equal(operationTask("audio_translation_text"), "text");
});

test("quota keys are independent of alias and credential rotation", () => {
  const original = account();
  const renamed = { ...original, alias: "renamed", apiToken: "rotated" };
  assert.deepEqual(quotaRules(original, "audio_translation_asr", model), quotaRules(renamed, "audio_translation_asr", model));
});

test("legacy workloads reuse ASR/text keys and TTS shares the account with a separate task limit", () => {
  const base = account();
  assert.deepEqual(quotaRules(base, "legacy_asr", model), quotaRules(base, "audio_translation_asr", model));
  assert.deepEqual(quotaRules(base, "legacy_text", text), quotaRules(base, "audio_translation_text", text));
  const tts = { rpm: 60, burst: 2, maxConcurrent: 2 };
  const rules = quotaRules({ ...base, limits: { ...base.limits, tts } }, "legacy_tts", "@cf/deepgram/aura-1");
  assert.deepEqual(rules[0], quotaRules(base, "legacy_asr", model)[0]);
  assert.deepEqual(rules[1], { key: "task:tts", ...tts });
  assert.equal(operationTask("legacy_tts"), "tts");
  assert.throws(() => quotaRules(base, "legacy_tts", "@cf/deepgram/aura-1"), { reason: "configuration" });
});
