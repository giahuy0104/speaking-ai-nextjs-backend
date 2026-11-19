import { audioContentType, getGeneratedAudioRedirect, readGeneratedAudioFile } from "@/lib/storage/audio";
import { loggedAudioRoute } from "@/lib/audio/audioResponseLogger";
import { rangedAudioResponse } from "@/lib/audio/rangedAudio";

export const runtime = "nodejs";

type AudioCacheRouteContext = {
  params: Promise<{ fileName: string }>;
};

async function serveCachedAudio(
  request: Request,
  context: AudioCacheRouteContext,
  includeBody: boolean,
) {
  const { fileName } = await context.params;
  const redirectUrl = await getGeneratedAudioRedirect(fileName);
  if (redirectUrl) {
    return new Response(null, {
      status: 307,
      headers: { Location: redirectUrl, "Cache-Control": "no-store" },
    });
  }
  const audio = await readGeneratedAudioFile(fileName);

  if (!audio) {
    return Response.json(
      {
        error: {
          code: "AUDIO_NOT_FOUND",
          message: "Không tìm thấy tệp âm thanh.",
        },
      },
      { status: 404 },
    );
  }

  return rangedAudioResponse(audio, request.headers.get("range"), {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": audioContentType(fileName),
    "X-Content-Type-Options": "nosniff",
  }, includeBody);
}

// Logs every cached file the app downloads: content type and byte length sent.
export const GET = loggedAudioRoute("cache", (request: Request, context: AudioCacheRouteContext) =>
  serveCachedAudio(request, context, true));

export async function HEAD(
  request: Request,
  context: AudioCacheRouteContext,
) {
  return serveCachedAudio(request, context, false);
}
