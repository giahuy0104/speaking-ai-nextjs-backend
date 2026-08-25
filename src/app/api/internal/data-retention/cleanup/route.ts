import { cleanupConversationDataRetention } from "@/lib/history";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return (
    process.env.NODE_ENV !== "production" ||
    Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`)
  );
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  if (!isAuthorized(request)) {
    return withRequestId(
      Response.json(
        { error: { code: "UNAUTHORIZED", message: "Không có quyền truy cập." } },
        { status: 401 },
      ),
      requestId,
    );
  }

  const result = await cleanupConversationDataRetention(true);
  logEvent("info", "conversation_data_retention_cron_completed", {
    requestId,
    ...result,
  });
  return withRequestId(Response.json(result), requestId);
}
