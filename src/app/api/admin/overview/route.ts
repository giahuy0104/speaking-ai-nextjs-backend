import { getAdminOverview } from "@/lib/adminOverview";
import { requireAdminAccess } from "@/lib/adminAuth";
import type { AdminReviewFilter } from "@/types/admin";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";
import { isDatabaseTransferQuotaError } from "@/lib/db/errors";

export const runtime = "nodejs";

const validStatuses = new Set<AdminReviewFilter>([
  "all",
  "unreviewed",
  "approved",
  "rejected",
  "needs_review",
  "ai_suggested",
]);

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const denied = requireAdminAccess(request);
  if (denied) {
    return withRequestId(denied, requestId);
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status") ?? "all";
  const status = validStatuses.has(rawStatus as AdminReviewFilter)
    ? (rawStatus as AdminReviewFilter)
    : "all";
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const clientId = url.searchParams.get("clientId")?.trim() || undefined;

  let overview;
  try {
    overview = await getAdminOverview({ clientId, status, limit });
  } catch (error) {
    if (!isDatabaseTransferQuotaError(error)) {
      throw error;
    }

    logEvent("error", "database_transfer_quota_exceeded", {
      requestId,
      route: "/api/admin/overview",
    });
    return withRequestId(
      Response.json(
        {
          error: {
            code: "DATABASE_TRANSFER_QUOTA_EXCEEDED",
            message:
              "Neon đã hết hạn mức truyền dữ liệu. Hãy nâng gói hoặc chờ Neon cấp lại quota rồi làm mới trang.",
          },
        },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "3600",
          },
        },
      ),
      requestId,
    );
  }
  if (overview.latencyHealth.status === "warning") {
    logEvent("warn", "latency_p95_alert", {
      requestId,
      ...overview.latencyHealth,
    });
  }

  return withRequestId(Response.json({ overview }), requestId);
}
