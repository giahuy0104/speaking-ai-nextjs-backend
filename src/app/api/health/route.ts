import { hostname } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness only: polling must not run AI inference or mutate shared storage.
export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "speaking-ai-nextjs-backend",
      checkedAt: new Date().toISOString(),
      instance: hostname(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
