import { updateConversationHistory } from "@/lib/history";
import {
  isCloudinaryUserAudioConfigured,
  uploadUserAudioToCloudinary,
} from "@/lib/storage/cloudinaryUserAudio";

type ArchiveUserSpokenAudioOptions = {
  conversationId: string;
  clientId?: string;
  audioFile: File;
};

async function archiveUserSpokenAudioInternal(
  options: ArchiveUserSpokenAudioOptions,
) {
  if (!isCloudinaryUserAudioConfigured()) {
    throw new Error("Cloudinary chưa được cấu hình để lưu audio người dùng.");
  }

  const mimeType = options.audioFile.type.split(";", 1)[0]?.toLowerCase();
  if (mimeType && !mimeType.startsWith("audio/")) {
    throw new Error("Tệp gửi lên không phải định dạng audio.");
  }

  // Browser Streaming receives the conversation response before Next.js runs
  // the `after()` callback that inserts history. Uploading first uses that
  // wait productively, then the retries below bridge any remaining DB race.
  const uploaded = await uploadUserAudioToCloudinary(options);
  let updatedConversation = null;
  for (const delayMs of [0, 100, 250, 500, 1_000, 2_000]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    updatedConversation = await updateConversationHistory({
      conversationId: options.conversationId,
      clientId: options.clientId,
      userAudioUrl: uploaded.url,
      userAudioStatus: "ready",
      userAudioError: null,
    });
    if (updatedConversation) break;
  }

  if (!updatedConversation) {
    throw new Error("Không tìm thấy lượt nói để lưu URL audio Cloudinary.");
  }

  return { conversation: updatedConversation, ...uploaded };
}

export async function archiveUserSpokenAudio(
  options: ArchiveUserSpokenAudioOptions,
) {
  try {
    return await archiveUserSpokenAudioInternal(options);
  } catch (error) {
    await updateConversationHistory({
      conversationId: options.conversationId,
      clientId: options.clientId,
      userAudioStatus: isCloudinaryUserAudioConfigured()
        ? "failed"
        : "not_configured",
      userAudioError:
        error instanceof Error
          ? error.message.slice(0, 300)
          : "Không lưu được audio người dùng.",
    }).catch(() => undefined);
    throw error;
  }
}
