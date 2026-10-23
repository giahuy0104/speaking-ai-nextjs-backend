import { after } from "next/server";
import type { ConversationResponse } from "@/types/conversation";
import {
  appendConversationHistory,
  updateConversationHistory,
} from "@/lib/history";
import { logEvent } from "@/lib/observability";
import {
  getConversationUserAudioUrl,
  isCloudinaryUserAudioConfigured,
  uploadConversationUserAudio,
} from "@/lib/storage/cloudinaryUserAudio";
import { maybeLearnFromRepeatedUse } from "./adaptiveLearning";

type PostResponseOptions = {
  userAudio?: Blob;
};

async function persistUserAudio(result: ConversationResponse, audio: Blob) {
  if (!isCloudinaryUserAudioConfigured()) {
    logEvent("warn", "conversation_user_audio_skipped", {
      requestId: result.requestId,
      conversationId: result.conversationId,
      reason: "cloudinary_not_configured",
    });
    return;
  }

  const startedAt = Date.now();
  const userAudio = await uploadConversationUserAudio(
    result.conversationId,
    audio,
  );
  const updated = await updateConversationHistory({
    conversationId: result.conversationId,
    clientId: result.clientId,
    userAudioUrl: getConversationUserAudioUrl(result.conversationId),
    userAudio,
  });

  if (!updated) {
    throw new Error("Không tìm thấy lịch sử lượt nói sau khi upload audio.");
  }

  logEvent("info", "conversation_user_audio_uploaded", {
    requestId: result.requestId,
    conversationId: result.conversationId,
    bytes: userAudio.bytes,
    format: userAudio.format,
    latencyMs: Date.now() - startedAt,
  });
}

export function scheduleConversationPostResponseTasks(
  result: ConversationResponse,
  inputMode: "audio" | "text",
  options: PostResponseOptions = {},
) {
  after(async () => {
    const startedAt = Date.now();
    try {
      await appendConversationHistory(result, inputMode);
      const tasks: Array<{ name: string; work: Promise<unknown> }> = [];
      if (!result.targetLanguage || result.targetLanguage === "en") {
        tasks.push({ name: "adaptive_learning", work: maybeLearnFromRepeatedUse(result) });
      }
      if (inputMode === "audio" && options.userAudio?.size) {
        tasks.push({ name: "user_audio_upload", work: persistUserAudio(result, options.userAudio) });
      }

      const taskResults = await Promise.allSettled(tasks.map((task) => task.work));
      taskResults.forEach((taskResult, index) => {
        if (taskResult.status === "rejected") {
          logEvent("error", "conversation_post_response_subtask_failed", {
            requestId: result.requestId,
            conversationId: result.conversationId,
            subtask: tasks[index].name,
            error: taskResult.reason,
          });
        }
      });
      logEvent("info", "conversation_post_response_completed", {
        requestId: result.requestId,
        conversationId: result.conversationId,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      logEvent("error", "conversation_post_response_failed", {
        requestId: result.requestId,
        conversationId: result.conversationId,
        latencyMs: Date.now() - startedAt,
        error,
      });
    }
  });
}
