import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  detectUserAudioMimeType,
  getConversationUserAudioDownloadUrl,
  getConversationUserAudioUrl,
  isCloudinaryUserAudioConfigured,
} from "./cloudinaryUserAudio";

const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const originalApiKey = process.env.CLOUDINARY_API_KEY;
const originalApiSecret = process.env.CLOUDINARY_API_SECRET;

beforeEach(() => {
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
});

after(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  restore("CLOUDINARY_CLOUD_NAME", originalCloudName);
  restore("CLOUDINARY_API_KEY", originalApiKey);
  restore("CLOUDINARY_API_SECRET", originalApiSecret);
});

test("requires all three Cloudinary credentials for user audio", () => {
  assert.equal(isCloudinaryUserAudioConfigured(), false);
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "key";
  assert.equal(isCloudinaryUserAudioConfigured(), false);
  process.env.CLOUDINARY_API_SECRET = "secret";
  assert.equal(isCloudinaryUserAudioConfigured(), true);
});

test("builds an encoded admin-only conversation audio URL", () => {
  assert.equal(
    getConversationUserAudioUrl("conv id/1"),
    "/api/admin/conversations/conv%20id%2F1/user-audio",
  );
});

test("detects WAV bytes even when a multipart client declares octet-stream", () => {
  const wavHeader = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  ]);
  assert.equal(
    detectUserAudioMimeType(wavHeader, "application/octet-stream"),
    "audio/wav",
  );
});

test("rejects unknown bytes without a declared audio type", () => {
  assert.equal(
    detectUserAudioMimeType(
      Uint8Array.from([1, 2, 3, 4]),
      "application/octet-stream",
    ),
    "",
  );
});

test("creates a short-lived authenticated Cloudinary download URL", () => {
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "key";
  process.env.CLOUDINARY_API_SECRET = "secret";

  const url = getConversationUserAudioDownloadUrl({
    publicId: "speaking-ai/user-audio/conv_123",
    format: "webm",
    version: 1,
    bytes: 123,
    mimeType: "audio/webm",
    resourceType: "video",
    deliveryType: "authenticated",
  });

  assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/demo\/video\/download\?/);
  assert.match(url, /type=authenticated/);
  assert.match(url, /public_id=speaking-ai%2Fuser-audio%2Fconv_123/);
  assert.doesNotMatch(url, /secret/);
});
