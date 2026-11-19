import assert from "node:assert/strict";
import test from "node:test";
import { isProviderTtsSource, ttsSourceFor } from "./ttsSource";

test("ttsSourceFor names the provider that spoke the audio", () => {
  assert.equal(ttsSourceFor("cloudflare"), "cloudflare_tts");
  assert.equal(ttsSourceFor("deepinfra"), "deepinfra_tts");
  assert.equal(ttsSourceFor("google"), "google_tts");
});

test("isProviderTtsSource accepts provider speech and rejects cache, OpenAI and device speech", () => {
  assert.equal(isProviderTtsSource("cloudflare_tts"), true);
  assert.equal(isProviderTtsSource("deepinfra_tts"), true);
  assert.equal(isProviderTtsSource("google_tts"), true);
  assert.equal(isProviderTtsSource("cache"), false);
  assert.equal(isProviderTtsSource("openai_tts"), false);
  assert.equal(isProviderTtsSource("device_tts"), false);
});
