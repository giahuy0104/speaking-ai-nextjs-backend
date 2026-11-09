import { deploymentReadiness } from "@/lib/deployment/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { ready } = await deploymentReadiness();
  // Do not publish internal endpoints, credentials or provider diagnostics.
  return Response.json({ status: ready ? "ready" : "unavailable" }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
