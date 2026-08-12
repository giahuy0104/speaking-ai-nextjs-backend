import { getCloudflareAudioMaxBytes } from "@/lib/ai/cloudflareWorkersAi";
import { archiveConversationUserAudio } from "@/lib/userAudioArchive";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ conversationId: string }>;
};

const identifierPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const conversationIdPattern = /^[A-Za-z0-9_-]{5,100}$/;

function formText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { conversationId } = await context.params;

  try {
    if (!conversationIdPattern.test(conversationId)) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "conversationId không hợp lệ.",
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }

    const formData = await request.formData();
    const audio = formData.get("audio");
    const clientId = formText(formData, "clientId");
    const sessionId = formText(formData, "sessionId");
    const declaredMimeType = formText(formData, "mimeType");
    if (
      !(audio instanceof File) ||
      audio.size <= 0 ||
      !identifierPattern.test(clientId) ||
      !identifierPattern.test(sessionId)
    ) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Audio hoặc định danh lượt nói không hợp lệ.",
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }
    if (audio.size > getCloudflareAudioMaxBytes()) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "AUDIO_TOO_LONG",
              message: "Audio người dùng vượt quá dung lượng cho phép.",
              requestId,
            },
          },
          { status: 413 },
        ),
        requestId,
      );
    }

    const archived = await archiveConversationUserAudio({
      conversationId,
      clientId,
      sessionId,
      audio,
      declaredMimeType,
    });
    logEvent("info", "conversation_user_audio_client_uploaded", {
      requestId,
      conversationId,
      clientId,
      sessionId,
      bytes: archived.userAudio.bytes,
      format: archived.userAudio.format,
      alreadyArchived: archived.alreadyArchived,
    });
    return withRequestId(
      Response.json({
        conversationId,
        userAudioUrl: archived.conversation.userAudioUrl,
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("error", "conversation_user_audio_client_upload_failed", {
      requestId,
      conversationId,
      error,
    });
    return withRequestId(
      Response.json(
        {
          error: {
            code: "USER_AUDIO_UPLOAD_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Không lưu được audio người dùng.",
            requestId,
          },
        },
        { status: 503 },
      ),
      requestId,
    );
  }
}
