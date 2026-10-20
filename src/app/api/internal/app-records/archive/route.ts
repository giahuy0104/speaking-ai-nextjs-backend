import { timingSafeEqual } from "node:crypto";
import { archiveAppRecords } from "@/lib/storage/appRecordsArchive";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await archiveAppRecords();
    console.info(JSON.stringify({ event: "app_records_archive", ...result }));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Do not expose record contents, connection strings or credentials in logs.
    console.error("app_records_archive_failed");
    return Response.json({ error: "Archive failed; retry on next run." }, { status: 500 });
  }
}
