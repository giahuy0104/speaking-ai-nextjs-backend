import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import { getAudioStorageBackend } from "./config";
import { saveCloudinaryTts, ttsPublicId } from "./cloudinaryTts";

test("Cloudinary TTS preserves cache filename identity and rejects unsafe paths", () => {
  assert.equal(ttsPublicId("hello-abc123.mp3"), "speaking-ai/tts/hello-abc123");
  for (const name of ["../hello.mp3", "hello.wav", "folder/hello.mp3"]) {
    assert.throws(() => ttsPublicId(name));
  }
});

test("Cloudinary backend does not fall back to local storage", () => {
  const original = process.env.AUDIO_STORAGE_BACKEND;
  try {
    process.env.AUDIO_STORAGE_BACKEND = "cloudinary";
    assert.equal(getAudioStorageBackend(), "cloudinary");
  } finally {
    if (original === undefined) delete process.env.AUDIO_STORAGE_BACKEND;
    else process.env.AUDIO_STORAGE_BACKEND = original;
  }
});

test("checksum mismatch rejects migration before any database write", async () => {
  const names = ["CLOUDINARY_TTS_CLOUD_NAME", "CLOUDINARY_TTS_API_KEY", "CLOUDINARY_TTS_API_SECRET", "DATABASE_URL"];
  const previous = names.map(key => process.env[key]);
  const originalUpload = cloudinary.uploader.upload_stream;
  const originalFetch = globalThis.fetch;
  try {
    names.forEach(key => { process.env[key] = "test"; });
    cloudinary.uploader.upload_stream = ((options: Record<string, unknown>, callback: (error: null, result: unknown) => void) => {
      assert.equal(options.overwrite, false);
      const stream = new PassThrough();
      stream.resume();
      stream.on("finish", () => callback(null, {
        public_id: "speaking-ai/tts/hello-abc123", format: "mp3",
        secure_url: "https://res.cloudinary.com/test/video/upload/v1/hello.mp3",
      }));
      return stream;
    }) as unknown as typeof originalUpload;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/res\.cloudinary\.com\//);
      return new Response("different audio");
    };
    await assert.rejects(saveCloudinaryTts("hello-abc123.mp3", Buffer.from("original audio")), /checksum mismatch/);
  } finally {
    cloudinary.uploader.upload_stream = originalUpload;
    globalThis.fetch = originalFetch;
    names.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
