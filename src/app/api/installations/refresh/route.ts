import { toErrorResponse } from "@/lib/errors";
import { refreshInstallation } from "@/lib/installationAuth";
import { getRequestId, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    const body = (await request.json().catch(() => null)) as {
      refreshToken?: unknown;
    } | null;
    const refreshToken =
      typeof body?.refreshToken === "string" ? body.refreshToken.trim() : "";
    const session = await refreshInstallation(refreshToken);
    return withRequestId(Response.json(session), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
