import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AppError } from "../appError";
import { getAudioUploadSecurityConfig } from "./config";
import { authorizeAudioSessionRequest, issueAudioSessionToken, parseAudioSessionCreateConfig } from "./audioSessionSecurity";

const keys = ["NODE_ENV", "INSTALLATION_AUTH_SECRET", "AUDIO_UPLOAD_TOKEN_SECRET", "AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN"] as const;
let original: Record<string, string | undefined>;
beforeEach(() => {
  original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "production",
    INSTALLATION_AUTH_SECRET: "installation-signing-secret-with-at-least-32-characters",
    AUDIO_UPLOAD_TOKEN_SECRET: "",
    AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN: "false",
  });
});
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else Object.assign(process.env, { [key]: original[key] });
  }
});

test("production scoped tokens use a stable domain-separated installation key by default", () => {
  const security = getAudioUploadSecurityConfig();
  assert.equal(security.requireScopedToken, true);
  assert.equal(security.scopedTokensEnabled, true);
  assert.notEqual(security.tokenSecret, process.env.INSTALLATION_AUTH_SECRET);
  assert.equal(security.tokenSecret, getAudioUploadSecurityConfig().tokenSecret);
  const config = parseAudioSessionCreateConfig({ protocolVersion: 2, clientId: "web_production-device" });
  assert.ok(config);
  const token = issueAudioSessionToken("audio_v2-production-test", config).token;
  const request = new Request("https://example.test/audio", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authorizeAudioSessionRequest(request, "audio_v2-production-test")?.clientId, config.clientId);
  assert.throws(() => authorizeAudioSessionRequest(request, "audio_v2-another-test"),
    (error: unknown) => error instanceof AppError && error.status === 403);
});

test("production rejects legacy audio session IDs even when the feature flag is false", () => {
  assert.throws(() => authorizeAudioSessionRequest(new Request("https://example.test/audio"), "audio_legacy-test"),
    (error: unknown) => error instanceof AppError && error.code === "AUDIO_SESSION_UNAUTHORIZED" && error.status === 401);
});

test("an invalid explicit upload key cannot silently fall back to the installation key", () => {
  process.env.AUDIO_UPLOAD_TOKEN_SECRET = "short";
  assert.equal(getAudioUploadSecurityConfig().invalidTokenSecret, true);
  assert.equal(getAudioUploadSecurityConfig().scopedTokensEnabled, false);
  assert.throws(() => authorizeAudioSessionRequest(new Request("https://example.test/audio"), "audio_v2-test"),
    (error: unknown) => error instanceof AppError && error.status === 503);
});

test("missing installation and upload keys fail closed in production", () => {
  process.env.INSTALLATION_AUTH_SECRET = "";
  assert.equal(getAudioUploadSecurityConfig().scopedTokensEnabled, false);
  assert.throws(() => authorizeAudioSessionRequest(new Request("https://example.test/audio"), "audio_v2-test"),
    (error: unknown) => error instanceof AppError && error.status === 503);
});

test("development retains legacy audio sessions when scoped tokens are optional", () => {
  Object.assign(process.env, { NODE_ENV: "development" });
  assert.equal(getAudioUploadSecurityConfig().requireScopedToken, false);
  assert.equal(getAudioUploadSecurityConfig().scopedTokensEnabled, false);
  assert.equal(authorizeAudioSessionRequest(new Request("https://example.test/audio"), "audio_legacy-test"), null);
});
