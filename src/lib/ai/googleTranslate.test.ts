import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { AppError } from "../appError";
import {
  GOOGLE_TRANSLATE_MODEL,
  GoogleTranslateProviderError,
  resetGoogleTranslateForTests,
  setGoogleTranslateTransportForTests,
  toGoogleTranslateAppError,
  translateWithGoogle,
} from "./googleTranslate";
import { resolveAudioProviders } from "./deepInfra";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = JSON.stringify({
  client_email: "translate@homi-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "homi-test",
});

const KEYS = ["GOOGLE_TRANSLATE_CREDENTIALS_JSON", "GOOGLE_TTS_CREDENTIALS_JSON", "GOOGLE_TRANSLATE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS", "AUDIO_TEXT_PROVIDER", "AUDIO_ASR_PROVIDER"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.GOOGLE_TTS_CREDENTIALS_JSON = credentials;
  resetGoogleTranslateForTests();
});

afterEach(() => {
  setGoogleTranslateTransportForTests(undefined);
  resetGoogleTranslateForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

type Call = { url: string; body: string; authorization?: string };

function fakeGoogle(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  setGoogleTranslateTransportForTests(async (url, init) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(url), body: String(init?.body ?? ""), authorization: headers.get("authorization") ?? undefined };
    calls.push(call);
    if (call.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "token-1", expires_in: 3600, token_type: "Bearer" });
    }
    return reply(call);
  });
  return calls;
}

const translated = (text: string) => Response.json({ translations: [{ translatedText: text }] });

test("translates Vietnamese with the v3 NMT model of the service account's project", async () => {
  const calls = fakeGoogle(() => translated("今天天气晴朗"));
  const result = await translateWithGoogle("Hôm nay trời nắng đẹp", "zh");
  assert.deepEqual(result, { translatedText: "今天天气晴朗", model: GOOGLE_TRANSLATE_MODEL });

  const [token, call] = calls;
  assert.match(token.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  assert.equal(call.url, "https://translation.googleapis.com/v3/projects/homi-test/locations/global:translateText");
  assert.equal(call.authorization, "Bearer token-1");
  assert.deepEqual(JSON.parse(call.body), {
    contents: ["Hôm nay trời nắng đẹp"],
    mimeType: "text/plain",
    sourceLanguageCode: "vi",
    targetLanguageCode: "zh-CN",
    model: "projects/homi-test/locations/global/models/general/nmt",
  });
});

test("reuses the access token across calls and maps every target language", async () => {
  const calls = fakeGoogle(call => translated(`ok:${JSON.parse(call.body).targetLanguageCode}`));
  for (const [language, code] of [["en", "en"], ["ja", "ja"], ["ko", "ko"], ["fr", "fr"]] as const) {
    assert.equal((await translateWithGoogle("Xin chào", language)).translatedText, `ok:${code}`);
  }
  assert.equal(calls.filter(call => call.url.includes("oauth2")).length, 1, "one token for all calls");
});

test("a dedicated translation key and project win over the TTS service account", async () => {
  process.env.GOOGLE_TRANSLATE_CREDENTIALS_JSON = Buffer.from(credentials).toString("base64");
  process.env.GOOGLE_TRANSLATE_PROJECT_ID = "homi-translate";
  const calls = fakeGoogle(() => translated("Hello"));
  await translateWithGoogle("Xin chào", "en");
  assert.match(calls[1].url, /projects\/homi-translate\//);
});

test("quota, auth and empty answers become provider errors that can fall back", async () => {
  fakeGoogle(() => new Response("{}", { status: 429 }));
  await assert.rejects(translateWithGoogle("Xin chào", "en"), (error: unknown) => {
    assert.ok(error instanceof GoogleTranslateProviderError && error.reason === "rate_limited");
    const appError = toGoogleTranslateAppError(error);
    assert.ok(appError instanceof AppError);
    assert.equal(appError.code, "LLM_FAILED");
    assert.equal(appError.status, 429);
    assert.deepEqual(appError.details, { provider: "google", stage: "text_translation", reason: "rate_limited", upstreamStatus: 429 });
    return true;
  });

  resetGoogleTranslateForTests();
  fakeGoogle(() => new Response("{}", { status: 403 }));
  await assert.rejects(translateWithGoogle("Xin chào", "en"), (error: unknown) =>
    error instanceof GoogleTranslateProviderError && error.reason === "not_configured" && (toGoogleTranslateAppError(error) as AppError).status === 503);

  resetGoogleTranslateForTests();
  fakeGoogle(() => translated("   "));
  await assert.rejects(translateWithGoogle("Xin chào", "en"), (error: unknown) =>
    error instanceof GoogleTranslateProviderError && error.reason === "empty_response" && (toGoogleTranslateAppError(error) as AppError).status === 502);
});

test("without credentials it is not configured, before any request", async () => {
  delete process.env.GOOGLE_TTS_CREDENTIALS_JSON;
  const calls = fakeGoogle(() => translated("x"));
  await assert.rejects(translateWithGoogle("Xin chào", "en"), (error: unknown) =>
    error instanceof GoogleTranslateProviderError && error.reason === "not_configured");
  assert.equal(calls.length, 0);
});

test("google is a valid provider for the translation step only", () => {
  process.env.AUDIO_TEXT_PROVIDER = "deepinfra, Google";
  assert.deepEqual(resolveAudioProviders("text"), ["deepinfra", "google"]);
  process.env.AUDIO_ASR_PROVIDER = "google";
  assert.throws(() => resolveAudioProviders("asr"), (error: unknown) =>
    error instanceof AppError && error.details?.reason === "invalid_provider");
});
