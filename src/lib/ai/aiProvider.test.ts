import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  generateAiText,
  getConfiguredTtsProfile,
  getTargetTtsProfile,
  getTextAiProfile,
  requestEnglishSpeech,
  requestTargetSpeech,
  transcribeVietnameseAudio,
} from "./aiProvider";
import { setDeepInfraTransportForTests } from "./deepInfra";
import { resetGoogleTtsForTests, setGoogleTtsClientForTests } from "./googleTts";
import { parseTargetLanguage } from "./targetLanguage";
import { buildTargetLanguageInstruction } from "./prompts";

const originalFetch = globalThis.fetch;
const environmentKeys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_WORKERS_AI_API_TOKEN",
  "CLOUDFLARE_ASR_MODEL",
  "CLOUDFLARE_TEXT_MODEL",
  "CLOUDFLARE_TTS_MODEL",
  "CLOUDFLARE_TTS_SPEAKER",
  "AUDIO_TARGET_TTS_PROVIDER",
  "DEEPINFRA_API_KEY",
  "DEEPINFRA_TTS_MODEL",
  "DEEPINFRA_TTS_VOICE",
  "GOOGLE_TTS_VOICE",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

function restoreEnvironment() {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configureCloudflare() {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
}

afterEach(() => {
  restoreEnvironment();
  globalThis.fetch = originalFetch;
  setDeepInfraTransportForTests(undefined);
  setGoogleTtsClientForTests(undefined);
  resetGoogleTtsForTests();
});

test("selects Cloudflare-only profiles", () => {
  configureCloudflare();

  assert.deepEqual(getTextAiProfile(), {
    provider: "cloudflare",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
  });
  assert.deepEqual(getConfiguredTtsProfile(), {
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    voice: "luna",
    speed: 1,
    extension: "mp3",
  });
});

test("generates text through the Cloudflare chat-completions endpoint", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
    );
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    assert.equal(body.model, "@cf/qwen/qwen3-30b-a3b-fp8");
    assert.match(body.messages[0].content, /^\/no_think/);

    return Response.json({
      choices: [{ message: { content: "I am thirsty." } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
  };

  const result = await generateAiText({
    instructions: "Translate naturally.",
    input: "Con khát nước.",
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    text: "I am thirsty.",
    provider: "cloudflare",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    inputTokens: 10,
    outputTokens: 4,
  });
});

test("transcribes Vietnamese audio through Cloudflare Whisper", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/openai/whisper-large-v3-turbo",
    );
    const body = JSON.parse(String(init?.body)) as {
      task: string;
      language: string;
      audio: string;
    };
    assert.equal(body.task, "transcribe");
    assert.equal(body.language, "vi");
    assert.equal(body.audio, Buffer.from("audio-bytes").toString("base64"));

    return Response.json({ result: { text: "Con khát nước." } });
  };

  const result = await transcribeVietnameseAudio(
    new File(["audio-bytes"], "speech.wav", { type: "audio/wav" }),
  );

  assert.deepEqual(result, {
    text: "Con khát nước.",
    provider: "cloudflare",
    model: "@cf/openai/whisper-large-v3-turbo",
  });
});

test("requests MP3 speech from Cloudflare", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/deepgram/aura-1",
    );
    const body = JSON.parse(String(init?.body)) as {
      text: string;
      speaker: string;
      encoding: string;
    };
    assert.deepEqual(body, {
      text: "I am thirsty.",
      speaker: "luna",
      encoding: "mp3",
    });

    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  const speech = await requestEnglishSpeech(
    "I am thirsty.",
    getConfiguredTtsProfile(),
  );

  assert.equal(speech.source, "cloudflare_tts");
  assert.deepEqual(
    new Uint8Array(await speech.response.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
});

test("accepts old English requests and validates target languages", () => {
  assert.equal(parseTargetLanguage(undefined), "en");
  for (const language of ["en", "zh", "ja", "ko", "fr"] as const) {
    assert.equal(parseTargetLanguage(language), language);
  }
  assert.throws(() => parseTargetLanguage("de"), (error: unknown) =>
    error instanceof AppError && error.code === "BAD_REQUEST" && error.status === 400,
  );
  assert.match(buildTargetLanguageInstruction("ja", "home", 6), /Japanese/);
  assert.match(buildTargetLanguageInstruction("ja", "home", 6), /without romaji/);
});

test("downloads Cloudflare multilingual MP3 for each new output language", async () => {
  configureCloudflare();
  for (const language of ["zh", "ja", "ko", "fr"] as const) {
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests++;
      if (requests === 1) {
        assert.equal(
          String(input),
          "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "xai/grok-tts",
          input: { text: "Translated sentence.", language, voice_id: "ara" },
        });
        return Response.json({
          state: "Completed",
          result: { audio: "https://audio.r2.dev/result.mp3" },
        });
      }
      assert.equal(String(input), "https://audio.r2.dev/result.mp3");
      assert.equal(init?.method, "GET");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    };
    assert.equal(getTargetTtsProfile(language).voice, `ara-${language}`);
    assert.deepEqual(
      new Uint8Array(await requestTargetSpeech("Translated sentence.", language)),
      new Uint8Array([1, 2, 3]),
    );
    assert.equal(requests, 2);
  }
});

test("rejects a non-Cloudflare audio URL before downloading it", async () => {
  configureCloudflare();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ result: { audio: "https://example.com/audio.mp3" } });
  };
  await assert.rejects(
    () => requestTargetSpeech("Bonjour.", "fr"),
    (error: unknown) => error instanceof AppError && error.code === "TTS_FAILED",
  );
  assert.equal(requests, 1);
});

test("does not call another provider when Cloudflare TTS fails", async () => {
  configureCloudflare();
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return Response.json(
      { errors: [{ message: "temporary" }] },
      { status: 502 },
    );
  };

  await assert.rejects(
    () =>
      requestEnglishSpeech(
        "I am thirsty.",
        getConfiguredTtsProfile(),
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "TTS_FAILED",
  );

  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /cloudflare\.com/);
});

test("returns a clear configuration error when no AI provider exists", async () => {
  for (const key of environmentKeys) {
    delete process.env[key];
  }

  await assert.rejects(
    () =>
      generateAiText({
        instructions: "Translate naturally.",
        input: "Con khát nước.",
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "LLM_FAILED" &&
      error.status === 503,
  );
});

function configureDeepInfraSpeech(transport: Parameters<typeof setDeepInfraTransportForTests>[0]) {
  configureCloudflare();
  process.env.AUDIO_TARGET_TTS_PROVIDER = "deepinfra";
  process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
  setDeepInfraTransportForTests(transport);
  // Any Cloudflare call would mean the provider switch leaked.
  globalThis.fetch = async (input) => assert.fail(`unexpected Cloudflare call to ${String(input)}`);
}

test("target-language speech uses Qwen3-TTS with the Sohee voice on DeepInfra", async () => {
  let calls = 0;
  configureDeepInfraSpeech(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepinfra.com/v1/openai/audio/speech");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-deepinfra-key");
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: "Qwen/Qwen3-TTS", input: "今天我很开心。", voice: "Sohee", response_format: "mp3",
    });
    return new Response(new Uint8Array([7, 8, 9]), { headers: { "Content-Type": "audio/mpeg" } });
  });
  assert.deepEqual(getTargetTtsProfile("zh"), {
    provider: "deepinfra", model: "Qwen/Qwen3-TTS", voice: "Sohee-zh", speed: 1, extension: "mp3",
  });
  assert.equal(getTargetTtsProfile("ja").voice, "Sohee-ja");
  assert.deepEqual(new Uint8Array(await requestTargetSpeech("今天我很开心。", "zh")), new Uint8Array([7, 8, 9]));
  assert.equal(calls, 1);
});

test("DeepInfra speech failures become TTS_FAILED without falling back to Cloudflare", async () => {
  for (const [response, status, reason] of [
    [new Response("upstream says no", { status: 500 }), 502, "provider_error"],
    [new Response("slow down", { status: 429 }), 429, "rate_limited"],
    [Response.json({ error: "not audio" }), 502, "invalid_response"],
    [new Response(new Uint8Array(), { headers: { "Content-Type": "audio/mpeg" } }), 502, "invalid_response"],
  ] as const) {
    configureDeepInfraSpeech(async () => response);
    await assert.rejects(() => requestTargetSpeech("Bonjour.", "fr"), (error: unknown) =>
      error instanceof AppError && error.code === "TTS_FAILED" && error.status === status &&
      error.details?.provider === "deepinfra" && error.details?.reason === reason &&
      !String(error.message).includes("upstream says no"));
  }
});

test("rejects an invalid speech provider or voice setting before calling anyone", async () => {
  configureDeepInfraSpeech(async () => assert.fail("DeepInfra must not be called"));
  process.env.DEEPINFRA_TTS_VOICE = "Sohee voice";
  await assert.rejects(() => requestTargetSpeech("안녕.", "ko"), (error: unknown) =>
    error instanceof AppError && error.status === 500 && error.details?.reason === "invalid_voice");
  process.env.AUDIO_TARGET_TTS_PROVIDER = "openai";
  assert.throws(() => getTargetTtsProfile("ko"), (error: unknown) =>
    error instanceof AppError && error.status === 500 && error.details?.reason === "invalid_provider");
});

test("target-language speech uses Google Cloud TTS (Chirp 3 HD MP3) when the provider is google", async () => {
  configureCloudflare();
  process.env.AUDIO_TARGET_TTS_PROVIDER = "google";
  globalThis.fetch = async (input) => assert.fail(`unexpected Cloudflare call to ${String(input)}`);
  const requests: unknown[] = [];
  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    async synthesizeSpeech(request) { requests.push(request); return [{ audioContent: new Uint8Array([4, 5, 6]) }]; },
  });
  assert.deepEqual(getTargetTtsProfile("ko"), {
    provider: "google", model: "google-cloud-tts", voice: "Chirp3-HD-Aoede-ko", speed: 1, extension: "mp3",
  });
  assert.deepEqual(new Uint8Array(await requestTargetSpeech("안녕하세요.", "ko")), new Uint8Array([4, 5, 6]));
  assert.deepEqual(requests, [{
    input: { text: "안녕하세요." },
    voice: { languageCode: "ko-KR", name: "ko-KR-Chirp3-HD-Aoede" },
    audioConfig: { audioEncoding: "MP3" },
  }]);
});

test("Google speech failures become TTS_FAILED with the google provider", async () => {
  configureCloudflare();
  process.env.AUDIO_TARGET_TTS_PROVIDER = "google";
  setGoogleTtsClientForTests({
    streamingSynthesize: () => assert.fail("stream not expected"),
    async synthesizeSpeech() { throw Object.assign(new Error("quota echoed text"), { code: 8 }); },
  });
  await assert.rejects(() => requestTargetSpeech("Bonjour.", "fr"), (error: unknown) =>
    error instanceof AppError && error.code === "TTS_FAILED" && error.status === 429 &&
    error.details?.provider === "google" && error.details?.reason === "rate_limited" &&
    !String(error.message).includes("echoed"));
});

test("target-language speech stays on Cloudflare when no provider is configured", () => {
  delete process.env.AUDIO_TARGET_TTS_PROVIDER;
  assert.deepEqual(getTargetTtsProfile("zh"), {
    provider: "cloudflare", model: "xai/grok-tts", voice: "ara-zh", speed: 1, extension: "mp3",
  });
});
