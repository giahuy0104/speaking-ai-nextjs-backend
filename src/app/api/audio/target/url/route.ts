import { AppError, toErrorResponse } from "@/lib/errors";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { isTargetAudioUrlEndpointEnabled, issueTargetAudioUrl } from "@/lib/ai/targetAudioUrl";

export const runtime = "nodejs";

/**
 * Test hook (AUDIO_TARGET_URL_ENDPOINT=true, dev only): signs a GET /api/audio/target
 * URL for any sentence, so its streaming can be measured without a conversation turn.
 * Requires an installation token; synthesis starts only when the URL is fetched.
 */
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  if (!isTargetAudioUrlEndpointEnabled()) {
    return withRequestId(Response.json(
      { error: { code: "NOT_FOUND", message: "Không tìm thấy.", requestId } }, { status: 404 }), requestId);
  }
  try {
    const access = await requireInstallationAccess(request);
    const body: unknown = await request.json().catch(() => null);
    const issued = issueTargetAudioUrl(body);
    if ("error" in issued) {
      throw issued.error === "invalid_input"
        ? new AppError("BAD_REQUEST", "Cần `lang` (zh, ja, ko, fr) và `text` dài 1–300 ký tự.")
        : new AppError("AUTH_CONFIGURATION_ERROR", "Server chưa cấu hình khóa ký URL.", 503);
    }
    logEvent("info", "target_audio_url_issued", { requestId, clientId: access.clientId });
    return withRequestId(
      Response.json({ requestId, ...issued }, { headers: { "Cache-Control": "no-store" } }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
