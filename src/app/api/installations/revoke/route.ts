import { toErrorResponse } from "@/lib/errors";
import { revokeInstallation } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const requestId = getRequestId(request);
  try {
    const access = await revokeInstallation(request);
    logEvent("info", "installation_revoked", {
      requestId,
      clientId: access.clientId,
    });
    return withRequestId(
      Response.json({ revoked: true, requestId }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
