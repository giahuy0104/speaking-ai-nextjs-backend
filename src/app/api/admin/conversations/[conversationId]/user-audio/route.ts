import { requireAdminAccess } from "@/lib/adminAuth";
import { readConversationHistory } from "@/lib/history";
import { getConversationUserAudioDownloadUrl } from "@/lib/storage/cloudinaryUserAudio";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ conversationId: string }>;
};

const forwardedHeaders = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
] as const;

export async function GET(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const unauthorized = requireAdminAccess(request);
  if (unauthorized) {
    return withRequestId(unauthorized, requestId);
  }

  const { conversationId } = await context.params;
  const conversation = (await readConversationHistory(500)).find(
    (entry) => entry.conversationId === conversationId,
  );

  if (!conversation?.userAudio) {
    return withRequestId(
      Response.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Lượt nói này chưa có audio người dùng.",
            requestId,
          },
        },
        { status: 404 },
      ),
      requestId,
    );
  }

  try {
    const downloadUrl = getConversationUserAudioDownloadUrl(
      conversation.userAudio,
    );
    const range = request.headers.get("range");
    const upstream = await fetch(downloadUrl, {
      cache: "no-store",
      headers: range ? { Range: range } : undefined,
    });

    if (!upstream.ok || !upstream.body) {
      throw new Error(`Cloudinary trả về HTTP ${upstream.status}.`);
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Type":
        upstream.headers.get("content-type") || conversation.userAudio.mimeType,
    });
    forwardedHeaders.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    });

    return withRequestId(
      new Response(upstream.body, {
        status: upstream.status,
        headers,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("error", "admin_user_audio_stream_failed", {
      requestId,
      conversationId,
      error,
    });
    return withRequestId(
      Response.json(
        {
          error: {
            code: "AUDIO_UNAVAILABLE",
            message: "Không tải được audio người dùng từ Cloudinary.",
            requestId,
          },
        },
        { status: 502 },
      ),
      requestId,
    );
  }
}
