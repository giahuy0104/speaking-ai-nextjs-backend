import { AppError } from "@/lib/appError";

const DEFAULT_ENDPOINT =
  "https://huamei-child-speech-api-415112188289.us-central1.run.app/transcribe";
const DEFAULT_MODEL = "whisper-tiny-children-v2";
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type HuameiChildSpeechResponse = {
  text?: unknown;
  language?: unknown;
  duration_seconds?: unknown;
  filename?: unknown;
  device?: unknown;
  detail?: unknown;
};

export type HuameiChildSpeechTranscription = {
  text: string;
  provider: "huamei";
  model: string;
  durationSeconds?: number;
  device?: string;
};

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getEndpoint() {
  const configured = process.env.HUAMEI_CHILD_SPEECH_API_URL?.trim();

  try {
    const endpoint = new URL(configured || DEFAULT_ENDPOINT);
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error();
    return endpoint.toString();
  } catch {
    throw new AppError(
      "ASR_FAILED",
      "HUAMEI_CHILD_SPEECH_API_URL không hợp lệ.",
      500,
    );
  }
}

export function getHuameiChildSpeechMaxBytes() {
  return positiveInteger(
    "HUAMEI_CHILD_SPEECH_MAX_BYTES",
    DEFAULT_MAX_BYTES,
  );
}

export function getHuameiChildSpeechConfig() {
  const apiKey = process.env.HUAMEI_CHILD_SPEECH_API_KEY?.trim();

  if (!apiKey) {
    throw new AppError(
      "ASR_FAILED",
      "Backend chưa được cấu hình HUAMEI_CHILD_SPEECH_API_KEY.",
      503,
    );
  }

  return {
    endpoint: getEndpoint(),
    apiKey,
    model:
      process.env.HUAMEI_CHILD_SPEECH_MODEL?.trim() || DEFAULT_MODEL,
    maxBytes: getHuameiChildSpeechMaxBytes(),
    timeoutMs: positiveInteger(
      "HUAMEI_CHILD_SPEECH_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

function providerError(status: number) {
  if (status === 401 || status === 403) {
    return new AppError(
      "ASR_FAILED",
      "Khóa API HuaMei Child Speech không hợp lệ.",
      503,
    );
  }
  if (status === 413) {
    return new AppError(
      "AUDIO_TOO_LONG",
      "Tệp audio vượt quá dung lượng cho phép.",
      413,
    );
  }
  if (status === 429) {
    return new AppError(
      "ASR_FAILED",
      "HuaMei Child Speech API đang quá tải. Vui lòng thử lại sau.",
      429,
    );
  }
  if (status === 408 || status === 504) {
    return new AppError(
      "ASR_FAILED",
      "HuaMei Child Speech API xử lý audio quá thời gian.",
      504,
    );
  }
  return new AppError(
    "ASR_FAILED",
    "HuaMei Child Speech API không nhận diện được đoạn ghi âm này.",
    502,
  );
}

export async function transcribeVietnameseWithHuamei(
  audio: File,
): Promise<HuameiChildSpeechTranscription> {
  const config = getHuameiChildSpeechConfig();

  if (audio.size > config.maxBytes) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Tệp audio vượt quá dung lượng cho phép.",
      413,
    );
  }

  const formData = new FormData();
  formData.append("file", audio, audio.name || "audio.bin");

  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "x-api-key": config.apiKey },
      body: formData,
      signal: AbortSignal.timeout(config.timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new AppError(
      "ASR_FAILED",
      name === "TimeoutError" || name === "AbortError"
        ? "HuaMei Child Speech API phản hồi quá chậm. Vui lòng thử lại."
        : "Không kết nối được HuaMei Child Speech API. Vui lòng thử lại.",
      502,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | HuameiChildSpeechResponse
    | null;

  if (!response.ok) throw providerError(response.status);

  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new AppError(
      "ASR_LOW_CONFIDENCE",
      "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
      422,
    );
  }

  return {
    text,
    provider: "huamei",
    model: config.model,
    durationSeconds:
      typeof payload?.duration_seconds === "number"
        ? payload.duration_seconds
        : undefined,
    device: typeof payload?.device === "string" ? payload.device : undefined,
  };
}
