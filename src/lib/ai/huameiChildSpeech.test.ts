import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  getHuameiChildSpeechConfig,
  transcribeVietnameseWithHuamei,
} from "./huameiChildSpeech";

const originalFetch = globalThis.fetch;
const environmentKeys = [
  "HUAMEI_CHILD_SPEECH_API_URL",
  "HUAMEI_CHILD_SPEECH_API_KEY",
  "HUAMEI_CHILD_SPEECH_MODEL",
  "HUAMEI_CHILD_SPEECH_MAX_BYTES",
  "HUAMEI_CHILD_SPEECH_TIMEOUT_MS",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

function restoreEnvironment() {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureHuamei() {
  process.env.HUAMEI_CHILD_SPEECH_API_URL =
    "https://speech.example.com/transcribe";
  process.env.HUAMEI_CHILD_SPEECH_API_KEY = "test-key";
}

afterEach(() => {
  restoreEnvironment();
  globalThis.fetch = originalFetch;
});

test("posts the audio as multipart data to HuaMei Child Speech", async () => {
  configureHuamei();
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://speech.example.com/transcribe");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
    assert.ok(init?.body instanceof FormData);

    const uploadedFile = init.body.get("file");
    assert.ok(uploadedFile instanceof File);
    assert.equal(uploadedFile.name, "speech.wav");
    assert.equal(await uploadedFile.text(), "audio-bytes");

    return Response.json({
      text: "Con khát nước.",
      language: "vi",
      duration_seconds: 1.25,
      filename: "speech.wav",
      device: "cpu",
    });
  };

  const result = await transcribeVietnameseWithHuamei(
    new File(["audio-bytes"], "speech.wav", { type: "audio/wav" }),
  );

  assert.deepEqual(result, {
    text: "Con khát nước.",
    provider: "huamei",
    model: "whisper-tiny-children-v2",
    durationSeconds: 1.25,
    device: "cpu",
  });
});

test("requires a server-side HuaMei API key", () => {
  delete process.env.HUAMEI_CHILD_SPEECH_API_KEY;

  assert.throws(
    () => getHuameiChildSpeechConfig(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "ASR_FAILED" &&
      error.status === 503,
  );
});

test("classifies an empty transcript as unclear speech", async () => {
  configureHuamei();
  globalThis.fetch = async () => Response.json({ text: "" });

  await assert.rejects(
    () =>
      transcribeVietnameseWithHuamei(
        new File(["audio-bytes"], "speech.wav", { type: "audio/wav" }),
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "ASR_LOW_CONFIDENCE" &&
      error.status === 422,
  );
});

test("does not leak an upstream authentication response", async () => {
  configureHuamei();
  globalThis.fetch = async () =>
    Response.json({ detail: "API key không hợp lệ." }, { status: 401 });

  await assert.rejects(
    () =>
      transcribeVietnameseWithHuamei(
        new File(["audio-bytes"], "speech.wav", { type: "audio/wav" }),
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "ASR_FAILED" &&
      error.status === 503,
  );
});
