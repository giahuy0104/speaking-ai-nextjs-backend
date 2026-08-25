import { transcribeVietnameseAudio } from "@/lib/ai/aiProvider";
import { AppError, toErrorResponse } from "@/lib/errors";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 15;

const maxChoiceAudioBytes = 2 * 1024 * 1024;

function validateAudio(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || value.size === 0) {
    throw new AppError(
      "AUDIO_TOO_SHORT",
      "Không tìm thấy câu trả lời bằng giọng nói.",
    );
  }
  if (value.size > maxChoiceAudioBytes) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Câu trả lời quá dài. Con hãy nói ngắn gọn nhé.",
      413,
    );
  }
  return value;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new AppError(
        "BAD_REQUEST",
        "Yêu cầu phải dùng multipart/form-data.",
        415,
      );
    }

    const formData = await request.formData();
    const claimedClientId =
      typeof formData.get("clientId") === "string"
        ? String(formData.get("clientId")).trim()
        : "";
    await requireInstallationAccess(request, claimedClientId);
    const audio = validateAudio(formData.get("audio"));
    const result = await transcribeVietnameseAudio(audio);

    logEvent("info", "listening_choice_recognized", {
      requestId,
      audioBytes: audio.size,
      provider: result.provider,
      model: result.model,
    });

    return withRequestId(
      Response.json({
        requestId,
        transcript: result.text,
        provider: result.provider,
        model: result.model,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "listening_choice_recognition_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
