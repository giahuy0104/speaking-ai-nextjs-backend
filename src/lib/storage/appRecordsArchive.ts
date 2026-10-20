import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { isPostgresStorageEnabled, queryDatabase } from "@/lib/db";
import { getR2Client, isR2PreconditionFailed } from "@/lib/storage/r2";
import { exportVerifiedArchive, type ArchiveJob } from "./appRecordsArchiveCore";

// The durable singleton retains the exact snapshot/key across failed runs.
// A lease serializes workers; the owner token fences a worker whose lease expired.
export async function archiveAppRecords() {
  if (!isPostgresStorageEnabled()) throw new Error("PostgreSQL is required.");
  const bucket = process.env.APP_RECORDS_ARCHIVE_R2_BUCKET?.trim();
  if (!bucket) throw new Error("APP_RECORDS_ARCHIVE_R2_BUCKET is required.");
  const owner = randomUUID();
  const batchId = randomUUID();
  const key = `archives/app_records/${new Date().toISOString().slice(0, 10)}/${batchId}.json`;
  let jobs = await queryDatabase<ArchiveJob>(
    `UPDATE app_records_archive_job
       SET owner = $1, lease_until = NOW() + INTERVAL '10 minutes'
     WHERE id = 1 AND lease_until <= NOW()
     RETURNING batch_id, bucket, object_key, body`, [owner],
  );
  if (!jobs.length) {
    jobs = await queryDatabase<ArchiveJob>(
      `WITH oldest AS MATERIALIZED (
         SELECT to_jsonb(r) AS row, r.xmin::text AS version
         FROM app_records r
         ORDER BY created_at, namespace, record_key LIMIT 50
       ), batch AS (
         SELECT jsonb_agg(row ORDER BY row->>'created_at', row->>'namespace', row->>'record_key') AS records,
                jsonb_agg(jsonb_build_object('row', row, 'version', version)) AS snapshot
         FROM oldest HAVING COUNT(*) = 50
       )
       INSERT INTO app_records_archive_job
         (id, batch_id, bucket, object_key, body, snapshot, owner, lease_until)
       SELECT 1, $1, $2, $3,
         jsonb_build_object('export_version', 1, 'batch_id', $1::text,
           'exported_at', NOW(), 'source_table', 'app_records',
           'record_count', 50, 'records', records)::text,
         snapshot, $4, NOW() + INTERVAL '10 minutes'
       FROM batch ON CONFLICT (id) DO NOTHING
       RETURNING batch_id, bucket, object_key, body`,
      [batchId, bucket, key, owner],
    );
  }
  const job = jobs[0];
  if (!job) return { status: "skipped" as const, reason: "busy_or_fewer_than_50" };

  try {
    const client = getR2Client();
    const result = await exportVerifiedArchive(job, {
      upload: async (body, sha256) => {
        try {
          await client.send(new PutObjectCommand({
            Bucket: job.bucket, Key: job.object_key, Body: body,
            ContentType: "application/json", Metadata: { sha256 }, IfNoneMatch: "*",
          }), { abortSignal: AbortSignal.timeout(20_000) });
        } catch (error) {
          // A retry never overwrites an existing archive. Read back and compare it.
          if (!isR2PreconditionFailed(error)) throw error;
        }
      },
      download: async () => {
        const response = await client.send(new GetObjectCommand({
          Bucket: job.bucket, Key: job.object_key,
        }), { abortSignal: AbortSignal.timeout(20_000) });
        if (!response.Body) throw new Error("Archive has no body.");
        return Buffer.from(await response.Body.transformToByteArray());
      },
      finalize: async () => {
        const results = await queryDatabase<{ deleted: number }>(
          `WITH owned AS MATERIALIZED (
             SELECT * FROM app_records_archive_job
             WHERE id = 1 AND owner = $1 AND lease_until > NOW() FOR UPDATE
           ), deleted AS (
             DELETE FROM app_records r USING owned j, jsonb_array_elements(j.snapshot) s
             WHERE r.namespace = s->'row'->>'namespace'
               AND r.record_key = s->'row'->>'record_key'
               AND r.xmin::text = s->>'version'
               AND to_jsonb(r) = s->'row'
             RETURNING r.record_key
           ), finished AS (
             DELETE FROM app_records_archive_job j USING owned
             WHERE j.id = owned.id RETURNING j.id
           )
           SELECT (SELECT COUNT(*)::integer FROM deleted) AS deleted FROM finished`,
          [owner],
        );
        if (!results.length) throw new Error("Archive lease lost; deletion not authorized.");
        return results[0].deleted;
      },
    });
    return { status: "archived" as const, ...result };
  } catch (error) {
    // Preserve the snapshot for retry, but allow the next scheduled run to claim it.
    await queryDatabase(
      `UPDATE app_records_archive_job SET lease_until = NOW()
       WHERE id = 1 AND owner = $1`, [owner],
    ).catch(() => undefined);
    throw error;
  }
}
