import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import Module from "node:module";
import test from "node:test";

const load = Module._load;
Module._load = function (specifier, ...args) {
  if (specifier === "server-only") return {};
  return load.call(this, specifier, ...args);
};
const { setDeepInfraTransportForTests } = await import("./deepInfra.ts");
const { resetGoogleTranslateForTests, setGoogleTranslateTransportForTests, GOOGLE_TRANSLATE_MODEL } = await import("./googleTranslate.ts");
const { translateTargetLanguage } = await import("./targetTranslation.ts");
const { generateEnglishSentence } = await import("./llm.ts");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = JSON.stringify({
  client_email: "translate@homi-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "homi-test",
});

function setup(t, providers) {
  const originalEnv = { ...process.env };
  const originalLog = { info: console.info, warn: console.warn, error: console.error };
  const logs = [];
  console.info = console.warn = console.error = line => logs.push(String(line));
  Object.assign(process.env, {
    DEEPINFRA_API_KEY: "test-key", GOOGLE_TTS_CREDENTIALS_JSON: credentials,
    AUDIO_TEXT_PROVIDER: providers, AUDIO_TEXT_PROVIDER_EN: providers,
  });
  resetGoogleTranslateForTests();
  let deepInfraCalls = 0;
  setDeepInfraTransportForTests(async () => {
    deepInfraCalls++;
    return new Response("{}", { status: 429 });
  });
  const googleTargets = [];
  setGoogleTranslateTransportForTests(async (url, init) => {
    if (String(url).includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
    const { targetLanguageCode } = JSON.parse(String(init.body));
    googleTargets.push(targetLanguageCode);
    return Response.json({ translations: [{ translatedText: targetLanguageCode === "en" ? "Today the weather is sunny." : "今天天气晴朗" }] });
  });
  t.after(() => {
    process.env = originalEnv;
    Object.assign(console, originalLog);
    setDeepInfraTransportForTests(undefined);
    setGoogleTranslateTransportForTests(undefined);
    resetGoogleTranslateForTests();
  });
  return { logs, googleTargets, deepInfraCalls: () => deepInfraCalls };
}

test("a zh translation falls back to Google NMT when DeepInfra is rate limited", async (t) => {
  const run = setup(t, "deepinfra,google");
  const result = await translateTargetLanguage({ sourceText: "Hôm nay trời nắng đẹp", language: "zh", context: "home", childAge: 6 });
  assert.deepEqual(result, { translatedText: "今天天气晴朗", model: GOOGLE_TRANSLATE_MODEL });
  assert.ok(run.deepInfraCalls() >= 1);
  assert.deepEqual(run.googleTargets, ["zh-CN"]);
  assert.ok(run.logs.some(line => line.includes('"event":"target_translation_provider_fallback"') && line.includes('"to":"google"')));
});

test("an English sentence falls back to Google NMT and reports it as the source", async (t) => {
  const run = setup(t, "deepinfra,google");
  const result = await generateEnglishSentence("Hôm nay con đi chơi công viên với bạn " + Date.now(), "home", 6,
    undefined, undefined, false, true, true);
  assert.equal(result.englishText, "Today the weather is sunny.");
  assert.equal(result.source, "google");
  assert.equal(result.textProvider, "google");
  assert.equal(result.textFallbackUsed, true);
  assert.deepEqual(run.googleTargets, ["en"]);
});

test("Google is not called while the first provider answers", async (t) => {
  const run = setup(t, "deepinfra,google");
  setDeepInfraTransportForTests(async () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "今天天气很好" } }] }));
  const result = await translateTargetLanguage({ sourceText: "Hôm nay trời đẹp", language: "zh", context: "home", childAge: 6 });
  assert.equal(result.translatedText, "今天天气很好");
  assert.deepEqual(run.googleTargets, []);
});
