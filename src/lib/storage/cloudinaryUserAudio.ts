import { createHash } from "node:crypto";

export type CloudinaryUserAudioConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  publicIdPrefix: string;
  timeoutMs: number;
};

type CloudinaryUploadResponse = {
  public_id?: string;
  resource_type?: string;
  secure_url?: string;
  error?: { message?: string };
};

const defaultPublicIdPrefix = "speaking-ai/user-audio";
const defaultTimeoutMs = 30_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function normalizePublicIdSegment(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9/_-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function isCloudinaryUserAudioConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim(),
  );
}

export function getCloudinaryUserAudioConfig(): CloudinaryUserAudioConfig {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Chưa cấu hình đủ CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET.",
    );
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
    publicIdPrefix:
      normalizePublicIdSegment(
        process.env.CLOUDINARY_USER_AUDIO_FOLDER ?? defaultPublicIdPrefix,
      ) || defaultPublicIdPrefix,
    timeoutMs: positiveInteger(
      process.env.CLOUDINARY_USER_AUDIO_TIMEOUT_MS,
      defaultTimeoutMs,
    ),
  };
}

export function createCloudinaryUploadSignature(
  parameters: Record<string, string | number | boolean>,
  apiSecret: string,
) {
  const payload = Object.entries(parameters)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");

  return createHash("sha1").update(payload + apiSecret).digest("hex");
}

export async function uploadUserAudioToCloudinary(options: {
  conversationId: string;
  audioFile: File;
  config?: CloudinaryUserAudioConfig;
  fetchImplementation?: typeof fetch;
  timestamp?: number;
}) {
  const config = options.config ?? getCloudinaryUserAudioConfig();
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const safeConversationId = normalizePublicIdSegment(options.conversationId);
  if (!safeConversationId || safeConversationId.includes("/")) {
    throw new Error("Conversation ID không hợp lệ để lưu audio Cloudinary.");
  }

  const publicId = `${config.publicIdPrefix}/${safeConversationId}`;
  const parameters = {
    overwrite: true,
    public_id: publicId,
    timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
  };
  const formData = new FormData();
  formData.append("file", options.audioFile, options.audioFile.name);
  formData.append("api_key", config.apiKey);
  formData.append("overwrite", "true");
  formData.append("public_id", publicId);
  formData.append("timestamp", String(parameters.timestamp));
  formData.append(
    "signature",
    createCloudinaryUploadSignature(parameters, config.apiSecret),
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImplementation(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/video/upload`,
      {
        method: "POST",
        body: formData,
        signal: controller.signal,
      },
    );
    const data = (await response.json().catch(() => null)) as
      | CloudinaryUploadResponse
      | null;

    if (!response.ok || !data?.secure_url) {
      throw new Error(
        data?.error?.message ||
          `Cloudinary upload thất bại với status ${response.status}.`,
      );
    }

    return {
      url: data.secure_url,
      publicId: data.public_id ?? publicId,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
