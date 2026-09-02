import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const runtimeFiles = [
  new URL("./asr.ts", import.meta.url),
  new URL("./llm.ts", import.meta.url),
  new URL("./aiProvider.ts", import.meta.url),
  new URL("./huameiChildSpeech.ts", import.meta.url),
  new URL(
    "../../app/api/realtime/transcription-session/route.ts",
    import.meta.url,
  ),
];

test("AI runtime never calls OpenAI directly", async () => {
  const sources = await Promise.all(
    runtimeFiles.map((file) => readFile(file, "utf8")),
  );
  const runtimeSource = sources.join("\n");

  assert.doesNotMatch(runtimeSource, /getOpenAIClient/);
  assert.doesNotMatch(runtimeSource, /api\.openai\.com/);
  assert.doesNotMatch(runtimeSource, /OPENAI_API_KEY/);
  assert.doesNotMatch(runtimeSource, /fallbackProvider:\s*["']openai["']/);
});

test("Vietnamese batch ASR is routed to HuaMei instead of Cloudflare", async () => {
  const [asrSource, providerSource, huameiSource] = await Promise.all([
    readFile(new URL("./asr.ts", import.meta.url), "utf8"),
    readFile(new URL("./aiProvider.ts", import.meta.url), "utf8"),
    readFile(new URL("./huameiChildSpeech.ts", import.meta.url), "utf8"),
  ]);

  assert.match(asrSource, /transcribeVietnameseWithHuamei/);
  assert.doesNotMatch(asrSource, /cloudflareWorkersAi/);
  assert.match(providerSource, /transcribeVietnameseWithHuamei/);
  assert.doesNotMatch(providerSource, /transcribeVietnameseAudioWithCloudflare/);
  assert.match(huameiSource, /huamei-child-speech-api/);
  assert.match(huameiSource, /"x-api-key"/);
});

test("OpenAI SDK is not a direct dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.openai, undefined);
});
