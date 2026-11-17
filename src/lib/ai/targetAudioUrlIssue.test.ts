import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTargetAudioUrlEndpointEnabled,
  issueTargetAudioUrl,
  MAX_DEFERRED_TEXT_LENGTH,
  verifyTargetAudioUrl,
} from "./targetAudioUrl";

const env = { INSTALLATION_AUTH_SECRET: "s".repeat(40), AUDIO_STREAM_NODE: "3001" };
const now = 1_800_000_000_000;

test("the URL-issuing endpoint is off unless AUDIO_TARGET_URL_ENDPOINT=true", () => {
  assert.equal(isTargetAudioUrlEndpointEnabled({}), false);
  assert.equal(isTargetAudioUrlEndpointEnabled({ AUDIO_TARGET_URL_ENDPOINT: "1" }), false);
  assert.equal(isTargetAudioUrlEndpointEnabled({ AUDIO_TARGET_URL_ENDPOINT: " TRUE " }), true);
});

test("issues a signed URL the target route accepts", () => {
  const issued = issueTargetAudioUrl({ lang: "ja", text: "  今日はとても嬉しいです。 " }, { env, now });
  assert.ok("audioUrl" in issued);
  assert.equal(issued.expiresAt, now + 15 * 60_000);
  const params = new URL(issued.audioUrl, "https://api.test").searchParams;
  assert.equal(params.get("node"), "3001");
  assert.deepEqual(verifyTargetAudioUrl(params, { env, now }), { language: "ja", text: "今日はとても嬉しいです。" });
});

test("rejects a bad language, empty or too long text, and a body that is not an object", () => {
  for (const body of [
    { lang: "en", text: "hello" },
    { lang: "ja", text: "   " },
    { lang: "ja", text: 42 },
    { lang: "fr", text: "a".repeat(MAX_DEFERRED_TEXT_LENGTH + 1) },
    null,
    "ja",
  ]) {
    assert.deepEqual(issueTargetAudioUrl(body, { env, now }), { error: "invalid_input" }, JSON.stringify(body));
  }
});

test("reports a missing signing secret apart from bad input", () => {
  assert.deepEqual(
    issueTargetAudioUrl({ lang: "ko", text: "안녕" }, { env: { INSTALLATION_AUTH_SECRET: "short" }, now }),
    { error: "signing_unavailable" },
  );
});
