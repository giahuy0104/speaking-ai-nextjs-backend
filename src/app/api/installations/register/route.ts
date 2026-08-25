import { AppError, toErrorResponse } from "@/lib/errors";
import {
  consumeInstallationRegistrationRateLimit,
  registerInstallation,
} from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const retryAfter = consumeInstallationRegistrationRateLimit(request);
  if (retryAfter !== null) {
    return withRequestId(
      Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Đã đăng ký quá nhiều installation. Vui lòng thử lại sau.",
            requestId,
          },
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      ),
      requestId,
    );
  }
  try {
    const body = await request.json().catch(() => null);
    const session = await registerInstallation(body);
    logEvent("info", "installation_registered", {
      requestId,
      clientId: session.clientId,
    });
    return withRequestId(Response.json(session, { status: 201 }), requestId);
  } catch (error) {
    logEvent(
      error instanceof AppError && error.status < 500 ? "warn" : "error",
      "installation_registration_failed",
      { requestId, error },
    );
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
