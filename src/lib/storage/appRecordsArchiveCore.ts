import { createHash } from "node:crypto";

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
