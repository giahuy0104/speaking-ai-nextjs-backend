import { createHash } from "node:crypto";

// Preparation consumers reject these rows after their durable TTL. Other
// namespaces include credentials, history and idempotency records that must
// remain available even when they are old.
export const ARCHIVE_POLICY_VERSION = "expired-preparations-v1";
export const ARCHIVABLE_RECORD_NAMESPACES = ["conversation_preparations_v1"] as const;

export function createArchiveObjectKey(date: Date, batchId: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  const [year, month, day, hour, minute] =
    ["year", "month", "day", "hour", "minute"].map(value);
  const filename = `${day}_${month}_${year}_${hour}h_${minute}_${batchId.replaceAll("-", "")}.json`;
  return `archives/app_records/${year}-${month}-${day}/${filename}`;
}

export type ArchiveJob = {
  batch_id: string;
  bucket: string;
  object_key: string;
  body: string;
  record_count: number;
};

/** Reject pending snapshots made by the former all-namespace archive policy. */
export function isSafeArchiveJob(job: ArchiveJob, now = Date.now()) {
  try {
    const body = JSON.parse(job.body);
    return body.archive_policy === ARCHIVE_POLICY_VERSION &&
      body.batch_id === job.batch_id &&
      Number.isInteger(job.record_count) && job.record_count >= 1 && job.record_count <= 50 &&
      body.record_count === job.record_count &&
      Array.isArray(body.records) && body.records.length === job.record_count &&
      body.records.every((row: Record<string, unknown>) => {
        if (!row || typeof row !== "object" ||
            !ARCHIVABLE_RECORD_NAMESPACES.includes(row.namespace as typeof ARCHIVABLE_RECORD_NAMESPACES[number]) ||
            typeof row.record_key !== "string" || !row.record_key || typeof row.expires_at !== "string") return false;
        const expiresAt = Date.parse(row.expires_at);
        return Number.isFinite(expiresAt) && expiresAt <= now;
      });
  } catch {
    return false;
  }
}

export async function exportVerifiedArchive(
  job: ArchiveJob,
  dependencies: {
    upload: (body: Buffer, sha256: string) => Promise<void>;
    download: () => Promise<Buffer>;
    finalize: () => Promise<number>;
  },
) {
  const body = Buffer.from(job.body, "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");
  await dependencies.upload(body, sha256);
  const stored = await dependencies.download();
  if (!body.equals(stored)) {
    throw new Error("Archive verification failed; app_records were not deleted.");
  }
  const deleted = await dependencies.finalize();
  return { batchId: job.batch_id, key: job.object_key, exported: job.record_count, deleted, sha256 };
}
