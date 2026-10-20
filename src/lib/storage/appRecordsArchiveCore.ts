import { createHash } from "node:crypto";

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
};

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
  return { batchId: job.batch_id, key: job.object_key, exported: 50, deleted, sha256 };
}
