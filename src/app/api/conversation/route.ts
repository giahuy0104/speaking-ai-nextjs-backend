import type { ConversationRequest, PracticeContext, TargetLanguage } from "@/types/conversation";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  runChineseConversationPipeline,
  runConversationPipeline,
} from "@/lib/ai/pipeline";
import { getCloudflareAudioMaxBytes } from "@/lib/ai/cloudflareWorkersAi";
import { scheduleConversationPostResponseTasks } from "@/lib/ai/postResponseTasks";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

const validContexts = new Set(["home", "school", "outside"]);

function isPracticeContext(value: unknown): value is PracticeContext {
  return typeof value === "string" && validContexts.has(value);
}

function parseTargetLanguage(value: unknown): TargetLanguage {
  if (value === undefined || value === null || value === "en") return "en";
  if (value === "zh") return "zh";
  throw new AppError("BAD_REQUEST", "Ngôn ngữ dịch không được hỗ trợ.");
}

function validateRequest(body: unknown): ConversationRequest {
  if (!body || typeof body !== "object") {
    throw new AppError("BAD_REQUEST", "Nội dung yêu cầu không hợp lệ.");
  }

  const input = body as Partial<ConversationRequest>;

  if (!isPracticeContext(input.context)) {
    throw new AppError("BAD_REQUEST", "Vui lòng chọn ngữ cảnh hợp lệ.");
  }

  return {
    clientId:
      typeof input.clientId === "string" && input.clientId.trim()
        ? input.clientId.trim()
        : undefined,
    context: input.context,
    childAge: input.childAge ?? 6,
    targetLanguage: parseTargetLanguage(input.targetLanguage),
    sessionId: input.sessionId,
    sourceText: input.sourceText,
    asrMode:
      input.asrMode === "browser_streaming" ||
      input.asrMode === "android_streaming" ||
      input.asrMode === "openai_realtime" ||
      input.asrMode === "ble_offline_intent"
        ? input.asrMode
        : "text",
    benchmark: input.benchmark,
  };
}

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function getFormBenchmark(formData: FormData) {
  const value = getFormValue(formData, "benchmark");

  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ConversationRequest["benchmark"])
      : undefined;
  } catch {
    return undefined;
  }
}

function validateFormData(formData: FormData): ConversationRequest {
  const context = getFormValue(formData, "context");
  const audioFile = formData.get("audio");
  const childAge = Number(getFormValue(formData, "childAge") ?? 6);
  const sourceText = getFormValue(formData, "sourceText");

  if (!isPracticeContext(context)) {
    throw new AppError("BAD_REQUEST", "Vui lòng chọn ngữ cảnh hợp lệ.");
  }

  if (audioFile && !(audioFile instanceof File)) {
    throw new AppError("BAD_REQUEST", "Tệp âm thanh tải lên không hợp lệ.");
  }

  if (
    audioFile instanceof File &&
    audioFile.size > getCloudflareAudioMaxBytes()
  ) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Tệp audio vượt quá dung lượng cho phép.",
      413,
    );
  }

  if (!audioFile && !sourceText) {
    throw new AppError("AUDIO_TOO_SHORT", "Vui lòng ghi âm hoặc nhập câu mẫu.");
  }

  return {
    clientId: getFormValue(formData, "clientId"),
    context,
    childAge,
    targetLanguage: parseTargetLanguage(getFormValue(formData, "targetLanguage")),
    sessionId: getFormValue(formData, "sessionId"),
    sourceText,
    audioFile: audioFile instanceof File ? audioFile : undefined,
    asrMode: audioFile instanceof File ? "batch_chunks" : "text",
    benchmark: getFormBenchmark(formData),
  };
}

async function parseFormData(request: Request) {
  try {
    return await request.formData();
  } catch {
    throw new AppError(
      "BAD_REQUEST",
      "Dữ liệu multipart/form-data không hợp lệ.",
      400,
    );
  }
}

async function parseJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Nội dung JSON không hợp lệ.", 400);
  }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");
    const parsedInput = isMultipart
      ? validateFormData(await parseFormData(request))
      : validateRequest(await parseJson(request));
    const access = await requireInstallationAccess(
      request,
      parsedInput.clientId,
    );
    const input = { ...parsedInput, clientId: access.clientId };
    const result =
      input.targetLanguage === "zh"
        ? await runChineseConversationPipeline({ ...input, requestId })
        : await runConversationPipeline(
            { ...input, requestId },
            {
              deferTextCacheWrite: true,
              // Worker Prepare is the primary iOS Web fast path. If a valid Worker
              // transcript reaches this compatibility route instead, prime TTS while
              // the JSON response is in flight so Safari does not start the provider
              // request only after receiving the conversation result. APK Batch
              // Chunks keeps its established behavior because it never uses
              // browser_streaming here.
              eagerAudioOnCacheMiss: input.asrMode === "browser_streaming",
            },
          );
    if (input.targetLanguage === "en") {
      scheduleConversationPostResponseTasks(
        result,
        isMultipart ||
          input.asrMode === "browser_streaming" ||
          input.asrMode === "openai_realtime" ||
          input.asrMode === "ble_offline_intent"
          ? "audio"
          : "text",
        { userAudio: input.audioFile },
      );
    }

    return withRequestId(
      Response.json({ ...result, learning: null }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "conversation_request_failed", { requestId, error });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
