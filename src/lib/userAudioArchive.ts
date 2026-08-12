import {
  getConversationHistoryEntry,
  updateConversationHistory,
} from "@/lib/history";
import {
  getConversationUserAudioUrl,
  uploadConversationUserAudio,
} from "@/lib/storage/cloudinaryUserAudio";

type ArchiveConversationUserAudioOptions = {
  conversationId: string;
  clientId?: string;
  sessionId?: string;
  audio: Blob;
  declaredMimeType?: string;
};

async function waitForConversation(conversationId: string) {
  for (const delayMs of [0, 75, 150, 300, 600, 1_200]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const conversation = await getConversationHistoryEntry(conversationId);
    if (conversation) return conversation;
  }
  return null;
}

export async function archiveConversationUserAudio(
  options: ArchiveConversationUserAudioOptions,
) {
  const conversation = await waitForConversation(options.conversationId);
  if (!conversation) {
    throw new Error("Không tìm thấy lượt nói để lưu audio người dùng.");
  }
  if (options.clientId && conversation.clientId !== options.clientId) {
    throw new Error("clientId không khớp lượt nói.");
  }
  if (options.sessionId && conversation.sessionId !== options.sessionId) {
    throw new Error("sessionId không khớp lượt nói.");
  }
  if (conversation.userAudio && conversation.userAudioUrl) {
    return {
      conversation,
      userAudio: conversation.userAudio,
      alreadyArchived: true,
    };
  }

  const userAudio = await uploadConversationUserAudio(
    options.conversationId,
    options.audio,
    options.declaredMimeType,
  );
  const updated = await updateConversationHistory({
    conversationId: options.conversationId,
    clientId: conversation.clientId,
    userAudioUrl: getConversationUserAudioUrl(options.conversationId),
    userAudio,
  });
  if (!updated) {
    throw new Error("Không cập nhật được audio vào lịch sử lượt nói.");
  }

  return { conversation: updated, userAudio, alreadyArchived: false };
}
