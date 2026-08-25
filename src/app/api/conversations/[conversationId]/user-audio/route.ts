import { getCloudflareAudioMaxBytes } from "@/lib/ai/cloudflareWorkersAi";
import { archiveConversationUserAudio } from "@/lib/userAudioArchive";
import { AppError, toErrorResponse } from "@/lib/errors";
import { getConversationHistoryEntry } from "@/lib/history";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { getConversationUserAudioDownloadUrl } from "@/lib/storage/cloudinaryUserAudio";

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

export async function GET(request: Request, context: RouteContext) {
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

    const claimedClientId =
      new URL(request.url).searchParams.get("clientId")?.trim() ?? "";
    if (!identifierPattern.test(claimedClientId)) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "clientId không hợp lệ.",
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }

    const clientId = (await requireInstallationAccess(request, claimedClientId))
      .clientId;
    const conversation = await getConversationHistoryEntry(conversationId);
    if (
      !conversation ||
      conversation.clientId !== clientId ||
      !conversation.userAudio
    ) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "USER_AUDIO_NOT_FOUND",
              message: "Bản ghi âm không còn tồn tại.",
              requestId,
            },
          },
          { status: 404 },
        ),
        requestId,
      );
    }

    const audioUrl = getConversationUserAudioDownloadUrl(
      conversation.userAudio,
    );
    return withRequestId(
      Response.json({
        conversationId,
        audioUrl,
        expiresInSeconds: 60,
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
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
    const claimedClientId = formText(formData, "clientId");
    const sessionId = formText(formData, "sessionId");
    const declaredMimeType = formText(formData, "mimeType");
    if (
      !(audio instanceof File) ||
      audio.size <= 0 ||
      !identifierPattern.test(claimedClientId) ||
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
    const clientId = (await requireInstallationAccess(request, claimedClientId))
      .clientId;
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
        hasUserAudio: true,
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    if (error instanceof AppError) {
      return withRequestId(toErrorResponse(error, requestId), requestId);
    }
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
