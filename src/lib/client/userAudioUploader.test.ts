import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadConversationUserAudioAfterResponse } from "./userAudioUploader";

function uploadInput() {
  return {
    conversationId: "conv_browser_123",
    clientId: "web_client_123",
    sessionId: "session_browser_123",
    audio: new Blob(["recorded-audio"], { type: "audio/webm" }),
    fileName: "speech.webm",
    mimeType: "audio/webm;codecs=opus",
  };
}

test("uploads browser audio with every conversation identifier", async () => {
  let capturedFormData: FormData | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(
      String(input),
      "/api/conversations/conv_browser_123/user-audio",
    );
    capturedFormData = init?.body as FormData;
    return Response.json({
      conversationId: "conv_browser_123",
      userAudioUrl: "/api/admin/conversations/conv_browser_123/user-audio",
    });
  };

  const result = await uploadConversationUserAudioAfterResponse(uploadInput(), {
    fetchImpl,
  });

  assert.equal(result.conversationId, "conv_browser_123");
  assert.equal(capturedFormData?.get("clientId"), "web_client_123");
  assert.equal(capturedFormData?.get("sessionId"), "session_browser_123");
  assert.equal(capturedFormData?.get("mimeType"), "audio/webm;codecs=opus");
  const audio = capturedFormData?.get("audio");
  assert.ok(audio instanceof File);
  assert.equal(audio.name, "speech.webm");
  assert.equal(audio.size, 14);
});

test("retries when history is not ready after the conversation response", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return Response.json(
        { error: { message: "Không tìm thấy lượt nói để lưu audio người dùng." } },
        { status: 503 },
      );
    }
    return Response.json({
      conversationId: "conv_browser_123",
      userAudioUrl: "/api/admin/conversations/conv_browser_123/user-audio",
    });
  };

  await uploadConversationUserAudioAfterResponse(uploadInput(), {
    fetchImpl,
    retryDelaysMs: [0, 25],
    delayImpl: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [25]);
});

test("does not retry an invalid audio request", async () => {
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    return Response.json(
      { error: { message: "Audio hoặc định danh lượt nói không hợp lệ." } },
      { status: 400 },
    );
  };

  await assert.rejects(
    uploadConversationUserAudioAfterResponse(uploadInput(), {
      fetchImpl,
      retryDelaysMs: [0, 25],
      delayImpl: async () => undefined,
    }),
    /không hợp lệ/,
  );
  assert.equal(attempts, 1);
});
