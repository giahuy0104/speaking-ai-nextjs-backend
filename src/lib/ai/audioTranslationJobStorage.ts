import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2CredentialsConfig } from "../storage/config";
import { deleteR2Objects, getR2Client, isR2PreconditionFailed, readR2Object } from "../storage/r2";

export type JobAudio = { key: string; sha256: string; name: string; mime: string; bytes: number; backend: "local" | "r2" };
const validKey = /^[a-f0-9]{64}-[a-f0-9]{64}\.bin$/;
function root() {
  const configured = process.env.AUDIO_TRANSLATION_JOB_SHARED_DIRECTORY;
  if (process.env.NODE_ENV === "production" && !configured) throw new Error("job_audio_requires_shared_storage");
  // Generated audio belongs on runtime storage, never in a deployment bundle.
  return configured ? path.resolve(/* turbopackIgnore: true */ configured)
    : path.join(/* turbopackIgnore: true */ process.cwd(), "data", "audio-translation-jobs");
}
function localPath(key: string) {
  if (!validKey.test(key)) throw new Error("invalid_job_audio_key");
  return path.join(root(), key);
}
export async function storeJobAudio(jobId: string, audio: File): Promise<JobAudio> {
  if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error("invalid_job_id");
  const bytes = Buffer.from(await audio.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `${jobId}-${sha256}.bin`;
  const backend = process.env.AUDIO_TRANSLATION_JOB_STORAGE === "r2" ? "r2" : "local";
  if (backend === "r2") {
    const config = getR2CredentialsConfig();
    try {
      await getR2Client().send(new PutObjectCommand({ Bucket: config.bucket, Key: `audio-translation-jobs/${key}`,
        Body: bytes, ContentType: "application/octet-stream", CacheControl: "private, no-store", IfNoneMatch: "*" }),
      { abortSignal: AbortSignal.timeout(5000) });
    } catch (error) { if (!isR2PreconditionFailed(error)) throw new Error("job_audio_unavailable"); }
  } else {
    const target = localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return { key, sha256, name: "speech" + (path.extname(audio.name).match(/^\.[a-z0-9]{1,5}$/i)?.[0] || ".bin"),
    mime: audio.type.slice(0, 100), bytes: bytes.length, backend };
}
export async function loadJobAudio(audio: JobAudio) {
  if (!validKey.test(audio.key)) throw new Error("invalid_job_audio_key");
  const bytes = audio.backend === "r2" ? await readR2Object(`audio-translation-jobs/${audio.key}`) : await readFile(localPath(audio.key));
  if (bytes.length !== audio.bytes || createHash("sha256").update(bytes).digest("hex") !== audio.sha256) throw new Error("job_audio_integrity");
  return new File([new Uint8Array(bytes)], audio.name, { type: audio.mime });
}
export async function removeJobAudio(audio: JobAudio) {
  if (!validKey.test(audio.key)) throw new Error("invalid_job_audio_key");
  if (audio.backend === "r2") await deleteR2Objects([`audio-translation-jobs/${audio.key}`]);
  else await unlink(localPath(audio.key)).catch(error => { if (error.code !== "ENOENT") throw error; });
}
export async function cleanExpiredLocalJobAudio(maxAgeMs = 3_600_000) {
  if (process.env.AUDIO_TRANSLATION_JOB_STORAGE === "r2") return; // Use a bucket lifecycle rule for orphaned objects.
  const directory = root();
  const entries = await readdir(directory).catch(() => []);
  for (const name of entries) {
    if (!validKey.test(name) && !/^[a-f0-9]{64}-[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > maxAgeMs) await unlink(file).catch(() => {});
  }
}
