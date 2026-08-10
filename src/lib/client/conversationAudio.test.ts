import assert from "node:assert/strict";
import test from "node:test";
import {
  getCompleteAudioFileName,
  postCompleteAudioConversation,
} from "./conversationAudio";

test("complete audio uses the conversation multipart contract", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({ conversationId: "conv_test" });
  };

  const response = await postCompleteAudioConversation({
    audio: new Blob(["wav-audio"], { type: "audio/wav" }),
    context: "school",
    benchmark: {
      requestedAsrMode: "batch_chunks",
      batchTransport: "single_complete_file",
      uploadedAudioBytes: 9,
    },
    fetchImpl,
  });

  assert.equal(response.status, 200);
  assert.equal(capturedUrl, "/api/conversation");
  assert.equal(capturedInit?.method, "POST");
  assert.ok(capturedInit?.body instanceof FormData);
  const formData = capturedInit.body;
  assert.equal(formData.get("context"), "school");
  assert.equal(formData.get("childAge"), "6");
  assert.deepEqual(JSON.parse(String(formData.get("benchmark"))), {
    requestedAsrMode: "batch_chunks",
    batchTransport: "single_complete_file",
    uploadedAudioBytes: 9,
  });
  const audio = formData.get("audio");
  assert.ok(audio instanceof File);
  assert.equal(audio.name, "speech.wav");
  assert.equal(audio.type, "audio/wav");
});

test("complete audio derives safe filenames for declared audio MIME types", () => {
  assert.equal(getCompleteAudioFileName("audio/aac"), "speech.aac");
  assert.equal(
    getCompleteAudioFileName("audio/x-custom-codec"),
    "speech.custom-codec",
  );
  assert.equal(getCompleteAudioFileName("text/plain"), "speech.webm");
});
