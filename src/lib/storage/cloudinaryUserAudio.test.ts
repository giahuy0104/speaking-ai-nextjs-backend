import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudinaryUploadSignature,
  uploadUserAudioToCloudinary,
  type CloudinaryUserAudioConfig,
} from "./cloudinaryUserAudio";

const config: CloudinaryUserAudioConfig = {
  cloudName: "demo-cloud",
  apiKey: "demo-key",
  apiSecret: "demo-secret",
  publicIdPrefix: "speaking-ai/user-audio",
  timeoutMs: 1_000,
};

test("creates a stable Cloudinary SHA-1 signature with sorted parameters", () => {
  assert.equal(
    createCloudinaryUploadSignature(
      {
        timestamp: 1_700_000_000,
        public_id: "speaking-ai/user-audio/conv_test",
        overwrite: true,
      },
      "demo-secret",
    ),
    "99d0793bcc08bfd6b5e94e6ffb2c9888ede3767a",
  );
});

test("uploads audio through Cloudinary's video resource endpoint", async () => {
  let requestedUrl = "";
  let submittedForm: FormData | null = null;
  const audioFile = new File([new Uint8Array([1, 2, 3])], "speech.webm", {
    type: "audio/webm",
  });

  const result = await uploadUserAudioToCloudinary({
    conversationId: "conv_test",
    audioFile,
    config,
    timestamp: 1_700_000_000,
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      submittedForm = init?.body as FormData;
      return Response.json({
        public_id: "speaking-ai/user-audio/conv_test",
        resource_type: "video",
        secure_url:
          "https://res.cloudinary.com/demo-cloud/video/upload/v1/speech.webm",
      });
    },
  });

  assert.equal(
    requestedUrl,
    "https://api.cloudinary.com/v1_1/demo-cloud/video/upload",
  );
  assert.equal(submittedForm?.get("api_key"), "demo-key");
  assert.equal(
    submittedForm?.get("public_id"),
    "speaking-ai/user-audio/conv_test",
  );
  assert.equal(result.publicId, "speaking-ai/user-audio/conv_test");
  assert.match(result.url, /^https:\/\/res\.cloudinary\.com\//);
});
