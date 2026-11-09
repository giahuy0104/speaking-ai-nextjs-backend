import { requireInstallationAccess } from "@/lib/installationAuth";
import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, withRequestId } from "@/lib/observability";
import { readTranslationJob } from "@/lib/ai/audioTranslationJobs";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const requestId = getRequestId(request);
  try {
    const access = await requireInstallationAccess(request);
    if (access.legacy) throw new AppError("UNAUTHORIZED", "Job audio cần installation access token.", 401);
    const { jobId } = await context.params;
    const result = await readTranslationJob(jobId, access.clientId);
    return withRequestId(Response.json({ requestId, ...result }, { headers: { "Cache-Control": "private, no-store" } }), requestId);
  } catch (error) { return withRequestId(toErrorResponse(error, requestId), requestId); }
}
