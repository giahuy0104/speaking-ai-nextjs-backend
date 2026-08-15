import {
  getCloudflareAudioMaxBytes,
  transcribeAudioToEnglish,
} from "@/lib/ai/cloudflareWorkersAi";
import { matchesLessonEnglish } from "@/lib/ai/lessonAttemptMatcher";
import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 20;

const supportedExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
]);

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function validateAudio(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size === 0) {
    throw new AppError("AUDIO_TOO_SHORT", "Vui lòng gửi bản ghi âm hợp lệ.");
  }
  if (value.size > getCloudflareAudioMaxBytes()) {
    throw new AppError("AUDIO_TOO_LONG", "Bản ghi âm vượt quá dung lượng cho phép.", 413);
  }
  const isAudioMime = value.type.toLowerCase().startsWith("audio/");
  if (!isAudioMime && !supportedExtensions.has(getExtension(value.name))) {
    throw new AppError("BAD_REQUEST", "Định dạng bản ghi âm không được hỗ trợ.", 415);
  }
  return value;
}

function validateExpectedEnglish(value: FormDataEntryValue | null) {
  const expectedEnglish = typeof value === "string" ? value.trim() : "";
  if (!expectedEnglish || expectedEnglish.length > 300) {
    throw new AppError("BAD_REQUEST", "Câu tiếng Anh mục tiêu không hợp lệ.");
  }
  return expectedEnglish;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new AppError("BAD_REQUEST", "Yêu cầu phải dùng multipart/form-data.", 415);
    }

    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes = getCloudflareAudioMaxBytes() + 256 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      throw new AppError("AUDIO_TOO_LONG", "Bản ghi âm vượt quá dung lượng cho phép.", 413);
    }

    const formData = await request.formData();
    const audio = validateAudio(formData.get("audio"));
    const expectedEnglish = validateExpectedEnglish(
      formData.get("expectedEnglish"),
    );
    const transcription = await transcribeAudioToEnglish(audio);
    const matched = matchesLessonEnglish(
      expectedEnglish,
      transcription.englishText,
    );

    logEvent("info", "listening_lesson_attempt_evaluated", {
      requestId,
      matched,
      audioBytes: audio.size,
      expectedWordCount: expectedEnglish.trim().split(/\s+/).length,
      recognizedWordCount: transcription.englishText.trim().split(/\s+/).length,
      model: transcription.model,
    });

    return withRequestId(
      Response.json({
        requestId,
        transcript: transcription.englishText,
        matched,
        model: transcription.model,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "listening_lesson_attempt_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
