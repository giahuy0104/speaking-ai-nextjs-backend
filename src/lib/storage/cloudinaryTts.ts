import { createHash } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { queryDatabase } from "@/lib/db";

// Separate credentials keep TTS storage independent of private user recordings.
export function getCloudinaryTtsConfig() {
  const cloud_name = process.env.CLOUDINARY_TTS_CLOUD_NAME?.trim();
  const api_key = process.env.CLOUDINARY_TTS_API_KEY?.trim();
  const api_secret = process.env.CLOUDINARY_TTS_API_SECRET?.trim();
  if (!cloud_name || !api_key || !api_secret || !process.env.DATABASE_URL?.trim()) {
    throw new Error("Cloudinary TTS requires CLOUDINARY_TTS_CLOUD_NAME/API_KEY/API_SECRET and DATABASE_URL.");
  }
  return { cloud_name, api_key, api_secret, secure: true };
}

export function ttsPublicId(fileName: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,254}\.mp3$/i.test(fileName)) {
    throw new Error("Invalid TTS audio filename.");
  }
  return `speaking-ai/tts/${fileName.slice(0, -4)}`;
}

export async function getCloudinaryTtsUrl(fileName: string) {
  ttsPublicId(fileName);
  const rows = await queryDatabase<{ cloudinary_url: string | null }>(
    "SELECT cloudinary_url FROM generated_audio WHERE file_name = $1 LIMIT 1",
    [fileName],
  );
  return rows[0]?.cloudinary_url || null;
}

export async function verifyCloudinaryTts(url: string, bytes: Uint8Array) {
  const config = getCloudinaryTtsConfig();
  if (!url.startsWith(`https://res.cloudinary.com/${config.cloud_name}/`)) {
    throw new Error("Unexpected Cloudinary TTS URL.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store" });
  if (!response.ok) throw new Error("Cloudinary TTS verification download failed.");
  const uploaded = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (createHash("sha256").update(uploaded).digest("hex") !== sha256) {
    throw new Error("Cloudinary TTS verification checksum mismatch; original audio retained.");
  }
  return sha256;
}

export async function saveCloudinaryTts(fileName: string, bytes: Uint8Array) {
  const config = getCloudinaryTtsConfig();
  const publicId = ttsPublicId(fileName);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Never mutate global SDK credentials: user-audio uploads can run concurrently.
  const asset = await new Promise<import("cloudinary").UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      ...config, resource_type: "video", type: "upload", public_id: publicId,
      overwrite: false, unique_filename: false, timeout: 60_000,
    }, (error, result) => {
      if (error || !result) reject(new Error("Cloudinary TTS upload failed."));
      else resolve(result);
    });
    stream.on("error", () => reject(new Error("Cloudinary TTS upload stream failed.")));
    stream.end(Buffer.from(bytes));
  });
  if (asset.public_id !== publicId || asset.format !== "mp3" ||
      !asset.secure_url?.startsWith(`https://res.cloudinary.com/${config.cloud_name}/`)) {
    throw new Error("Cloudinary TTS returned an unexpected asset.");
  }
  // Verify the actual downloadable bytes before recording a durable cache hit.
  await verifyCloudinaryTts(asset.secure_url, bytes);
  await queryDatabase(
    `INSERT INTO generated_audio
      (file_name, content_base64, content_type, size_bytes, cloudinary_url, cloudinary_public_id, audio_sha256)
     VALUES ($1, '', 'audio/mpeg', $2, $3, $4, $5)
     ON CONFLICT (file_name) DO UPDATE SET
       cloudinary_url = EXCLUDED.cloudinary_url,
       cloudinary_public_id = EXCLUDED.cloudinary_public_id,
       audio_sha256 = EXCLUDED.audio_sha256,
       updated_at = NOW()`,
    [fileName, bytes.byteLength, asset.secure_url, publicId, sha256],
  );
  return asset.secure_url;
}
