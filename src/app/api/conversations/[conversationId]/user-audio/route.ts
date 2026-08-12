import { getCloudflareAudioMaxBytes } from "@/lib/ai/cloudflareWorkersAi";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { archiveUserSpokenAudio } from "@/lib/userAudioArchive";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ conversationId: string }>;
};

const conversationIdPattern = /^[a-zA-Z0-9_-]{5,100}$/;

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
              message: "Conversation ID không hợp lệ.",
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio");
    const clientIdValue = formData.get("clientId");
    const clientId =
      typeof clientIdValue === "string" && clientIdValue.trim()
        ? clientIdValue.trim()
        : undefined;

    if (!(audioFile instanceof File) || audioFile.size <= 0) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Tệp audio người dùng không hợp lệ.",
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }
    if (audioFile.size > getCloudflareAudioMaxBytes()) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "AUDIO_TOO_LONG",
              message: "Tệp audio vượt quá dung lượng cho phép.",
              requestId,
            },
          },
          { status: 413 },
        ),
        requestId,
      );
    }

    const archived = await archiveUserSpokenAudio({
      conversationId,
      clientId,
      audioFile,
    });
    logEvent("info", "user_audio_cloudinary_archived", {
      requestId,
      conversationId,
      clientId,
      audioBytes: audioFile.size,
      publicId: archived.publicId,
    });

    return withRequestId(
      Response.json({
        conversationId,
        userAudioUrl: archived.url,
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("error", "user_audio_cloudinary_archive_failed", {
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
