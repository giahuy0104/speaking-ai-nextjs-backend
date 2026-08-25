import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationHistoryEntry } from "@/types/conversation";
import {
  planConversationRetention,
  withoutConversationDiagnostics,
  withoutConversationUserAudio,
} from "./dataRetention";

function entry(createdAt: string): ConversationHistoryEntry {
  return {
    conversationId: "conv_1",
    sessionId: "session_1",
    clientId: "client_1",
    context: "home",
    vietnameseText: "xin chào",
    englishText: "hello",
    audioUrl: null,
    promptVersion: "1",
    processingMode: "rule",
    textSource: "phrase_rule",
    audioSource: "cache",
    asrMode: "android_streaming",
    createdAt,
    inputMode: "audio",
    latency: { asrMs: 10, llmMs: 20, ttsMs: 30, timeToFirstAudioMs: 40 },
    benchmark: { utteranceDurationMs: 500 },
    userAudioUrl: "/api/admin/conversations/conv_1/user-audio",
    userAudio: {
      publicId: "speaking-ai/user-audio/conv_1",
      format: "wav",
      version: 1,
      bytes: 100,
      mimeType: "audio/wav",
      resourceType: "video",
      deliveryType: "authenticated",
    },
  };
}

const policy = {
  userAudioRetentionDays: 30,
  historyRetentionDays: 180,
  diagnosticRetentionDays: 30,
};
const now = new Date("2026-08-25T00:00:00.000Z");

test("keeps a recent conversation intact", () => {
  assert.deepEqual(
    planConversationRetention(entry("2026-08-01T00:00:00.000Z"), policy, now),
    {
      deleteHistory: false,
      deleteUserAudio: false,
      deleteDiagnostics: false,
    },
  );
});

test("deletes audio and diagnostics after 30 days while retaining history", () => {
  const original = entry("2026-07-01T00:00:00.000Z");
  assert.deepEqual(planConversationRetention(original, policy, now), {
    deleteHistory: false,
    deleteUserAudio: true,
    deleteDiagnostics: true,
  });

  const redacted = withoutConversationDiagnostics(
    withoutConversationUserAudio(original),
    now.toISOString(),
  );
  assert.equal(redacted.userAudio, undefined);
  assert.equal(redacted.userAudioUrl, undefined);
  assert.equal(redacted.latency, undefined);
  assert.equal(redacted.benchmark, undefined);
  assert.equal(redacted.vietnameseText, "xin chào");
  assert.equal(redacted.diagnosticsDeletedAt, now.toISOString());
});

test("deletes the entire conversation after 180 days", () => {
  assert.deepEqual(
    planConversationRetention(entry("2026-01-01T00:00:00.000Z"), policy, now),
    {
      deleteHistory: true,
      deleteUserAudio: true,
      deleteDiagnostics: true,
    },
  );
});
