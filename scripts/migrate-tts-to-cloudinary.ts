import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
import { queryDatabase } from "../src/lib/db";
import { saveCloudinaryTts, verifyCloudinaryTts } from "../src/lib/storage/cloudinaryTts";

loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  // Optional separate DB source lets operators import older databases without
  // changing the app's configured DATABASE_URL. Never log connection strings.
  if (process.env.TTS_MIGRATION_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TTS_MIGRATION_DATABASE_URL;
  }
  process.env.PERSISTENCE_BACKEND = "postgres";
  const credentialFile = option("--credentials");
  if (credentialFile) {
    const text = await readFile(credentialFile, "utf8");
    for (const [label, key] of [
      ["Cloud name", "CLOUDINARY_TTS_CLOUD_NAME"],
      ["API Key", "CLOUDINARY_TTS_API_KEY"],
      ["API Secret", "CLOUDINARY_TTS_API_SECRET"],
    ]) {
      const match = text.match(new RegExp(`${label}\\s*[:=]\\s*(\\S+)`, "i"));
      if (!match) throw new Error(`Missing ${label} in credential file.`);
      process.env[key] = match[1];
    }
  }
  const apply = args.includes("--apply");
  const limit = Number(option("--limit") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid --limit.");
  const [summary] = await queryDatabase<{ count: number; bytes: number }>(
    "SELECT COUNT(*)::int AS count, COALESCE(SUM(size_bytes), 0)::float8 AS bytes FROM generated_audio WHERE content_base64 <> ''",
  );
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }));
  if (!apply) return;
  let cursor = "";
  let migrated = 0;
  while (migrated < limit) {
    const rows = await queryDatabase<{ file_name: string; content_base64: string; cloudinary_url: string | null; audio_sha256: string | null }>(
      `SELECT file_name, content_base64, cloudinary_url, audio_sha256 FROM generated_audio
       WHERE file_name > $1 AND content_base64 <> ''
         AND ($3::boolean OR cloudinary_url IS NULL)
       ORDER BY file_name LIMIT $2`,
      [cursor, Math.min(25, limit - migrated), args.includes("--release-db-bytes")],
    );
    if (!rows.length) break;
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
      const row = rows[next++];
      const bytes = Buffer.from(row.content_base64, "base64");
      if (row.cloudinary_url && row.audio_sha256) {
        const verifiedHash = await verifyCloudinaryTts(row.cloudinary_url, bytes);
        if (verifiedHash !== row.audio_sha256) throw new Error("Stored checksum mismatch.");
      } else {
        await saveCloudinaryTts(row.file_name, bytes);
      }
      // Optional final phase only after deploying the Cloudinary-aware reader.
      // Compare original bytes so concurrent updates can never be discarded.
      if (args.includes("--release-db-bytes")) {
        await queryDatabase(
          `UPDATE generated_audio SET content_base64 = '', updated_at = NOW()
           WHERE file_name = $1 AND content_base64 = $2
             AND cloudinary_url IS NOT NULL AND audio_sha256 IS NOT NULL`,
          [row.file_name, row.content_base64],
        );
      }
      migrated++;
      }
    };
    // Bound upload/download traffic and DB connections; do not dispatch the
    // whole corpus at once. All workers settle before reporting a failed batch.
    const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
    if (results.some(result => result.status === "rejected")) {
      throw new Error("Migration batch failed; rerun to resume verified uploads.");
    }
    cursor = rows[rows.length - 1].file_name;
    console.log(JSON.stringify({ migrated, lastFile: cursor }));
  }
  console.log(JSON.stringify({ completed: true, migrated, releasedDbBytes: args.includes("--release-db-bytes") }));
}

main().catch(() => {
  // Provider/DB error objects may contain signed URLs or connection secrets.
  console.error("TTS migration stopped; source audio retained for unverified rows. Check credentials/connectivity and rerun.");
  process.exitCode = 1;
});
