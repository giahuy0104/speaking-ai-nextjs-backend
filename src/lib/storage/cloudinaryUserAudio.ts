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

export async function uploadConversationUserAudio(
  conversationId: string,
  audio: Blob,
): Promise<ConversationUserAudio> {
  if (audio.size <= 0) {
    throw new Error("Audio người dùng trống.");
  }

  const config = configureCloudinary();
  const buffer = Buffer.from(await audio.arrayBuffer());

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
    mimeType: audio.type || `audio/${result.format}`,
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
