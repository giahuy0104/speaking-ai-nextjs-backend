import { v2 as cloudinary } from "cloudinary";
import type { ConversationUserAudio } from "@/types/conversation";

const defaultFolder = "speaking-ai/user-audio";

type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
};

function configuredFolder() {
  const folder = process.env.CLOUDINARY_USER_AUDIO_FOLDER?.trim();
  return folder ? folder.replace(/^\/+|\/+$/g, "") : defaultFolder;
}

export function isCloudinaryUserAudioConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim(),
  );
}

function getCloudinaryConfig(): CloudinaryConfig {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary chưa được cấu hình đủ CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET.",
    );
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: configuredFolder(),
  };
}

function configureCloudinary() {
  const config = getCloudinaryConfig();
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });
  return config;
}

function safePublicId(conversationId: string) {
  const normalized = conversationId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!normalized) {
    throw new Error("conversationId không hợp lệ để lưu audio người dùng.");
  }
  return normalized;
}

export function getConversationUserAudioUrl(conversationId: string) {
  return `/api/admin/conversations/${encodeURIComponent(conversationId)}/user-audio`;
}

function normalizedAudioMimeType(value: string | undefined) {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType.startsWith("audio/") ? mimeType : "";
}

export function detectUserAudioMimeType(
  bytes: Uint8Array,
  declaredMimeType?: string,
) {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
    return "audio/wav";
  }
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)
  ) {
    return "audio/mpeg";
  }

  return normalizedAudioMimeType(declaredMimeType);
}

export async function uploadConversationUserAudio(
  conversationId: string,
  audio: Blob,
  declaredMimeType?: string,
): Promise<ConversationUserAudio> {
  if (audio.size <= 0) {
    throw new Error("Audio người dùng trống.");
  }

  const config = configureCloudinary();
  const buffer = Buffer.from(await audio.arrayBuffer());
  const mimeType = detectUserAudioMimeType(
    buffer.subarray(0, 16),
    declaredMimeType || audio.type,
  );
  if (!mimeType) {
    throw new Error("Tệp gửi lên không phải định dạng audio được hỗ trợ.");
  }

  const result = await new Promise<Awaited<ReturnType<typeof cloudinary.uploader.upload>>>(
    (resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          type: "authenticated",
          folder: config.folder,
          public_id: safePublicId(conversationId),
          overwrite: true,
          unique_filename: false,
          invalidate: true,
        },
        (error, uploaded) => {
          if (error || !uploaded) {
            reject(error ?? new Error("Cloudinary không trả về kết quả upload."));
            return;
          }
          resolve(uploaded);
        },
      );

      stream.end(buffer);
    },
  );

  if (
    result.resource_type !== "video" ||
    result.type !== "authenticated" ||
    !result.public_id ||
    !result.format
  ) {
    throw new Error("Cloudinary trả về metadata audio không hợp lệ.");
  }

  return {
    publicId: result.public_id,
    format: result.format,
    version: result.version,
    bytes: result.bytes,
    mimeType,
    resourceType: "video",
    deliveryType: "authenticated",
  };
}

export function getConversationUserAudioDownloadUrl(
  asset: ConversationUserAudio,
) {
  configureCloudinary();
  return cloudinary.utils.private_download_url(asset.publicId, asset.format, {
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    expires_at: Math.floor(Date.now() / 1_000) + 60,
    attachment: false,
  });
}

export async function deleteConversationUserAudio(
  asset: ConversationUserAudio,
) {
  configureCloudinary();
  const result = await cloudinary.uploader.destroy(asset.publicId, {
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    invalidate: true,
  });
  const outcome = String(result?.result ?? "");

  if (outcome !== "ok" && outcome !== "not found") {
    throw new Error(`Cloudinary không thể xóa audio người dùng (${outcome || "unknown"}).`);
  }

  return outcome === "ok";
}
