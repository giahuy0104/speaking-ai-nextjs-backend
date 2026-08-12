import { after } from "next/server";
import type { ConversationResponse } from "@/types/conversation";
import { isCloudinaryUserAudioConfigured } from "@/lib/storage/cloudinaryUserAudio";
import { appendConversationHistory } from "@/lib/history";
import { logEvent } from "@/lib/observability";
import { archiveUserSpokenAudio } from "@/lib/userAudioArchive";
import { maybeLearnFromRepeatedUse } from "./adaptiveLearning";

export function scheduleConversationPostResponseTasks(
  result: ConversationResponse,
  inputMode: "audio" | "text",
  userAudioFile?: File,
) {
  after(async () => {
    const startedAt = Date.now();
    try {
      await appendConversationHistory(result, inputMode);
      const backgroundTasks: Promise<unknown>[] = [
        maybeLearnFromRepeatedUse(result).catch((error) => {
          logEvent("error", "conversation_learning_failed", {
            requestId: result.requestId,
            conversationId: result.conversationId,
            error,
          });
        }),
      ];
      if (userAudioFile?.size) {
        if (isCloudinaryUserAudioConfigured()) {
          backgroundTasks.push(
            archiveUserSpokenAudio({
              conversationId: result.conversationId,
              clientId: result.clientId,
              audioFile: userAudioFile,
            })
              .then((uploaded) => {
                logEvent("info", "user_audio_cloudinary_archived", {
                  requestId: result.requestId,
                  conversationId: result.conversationId,
                  audioBytes: userAudioFile.size,
                  publicId: uploaded.publicId,
                });
              })
              .catch((error) => {
                logEvent("error", "user_audio_cloudinary_archive_failed", {
                  requestId: result.requestId,
                  conversationId: result.conversationId,
                  error,
                });
              }),
          );
        } else {
          logEvent("warn", "user_audio_cloudinary_not_configured", {
            requestId: result.requestId,
            conversationId: result.conversationId,
          });
        }
      }
      await Promise.all(backgroundTasks);
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
