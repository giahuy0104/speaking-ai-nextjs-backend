import type { BenchmarkMetadata, PracticeContext } from "@/types/conversation";
import { after } from "next/server";
import { finalizeWorkerConversation } from "@/lib/ai/conversationPreparation";
import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import { authorizeAudioSessionRequest } from "@/lib/storage/audioSessionSecurity";

export const runtime = "nodejs";

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);
const sessionPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const snapshotHashPattern = /^[a-f0-9]{64}$/;

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  try {
    const body = (await request.json().catch(() => null)) as {
      clientId?: unknown;
      audioSessionId?: unknown;
      snapshotHash?: unknown;
      sourceText?: unknown;
      context?: unknown;
      childAge?: unknown;
      asrLatencyMs?: unknown;
      benchmark?: BenchmarkMetadata;
    } | null;
    const sourceText =
      typeof body?.sourceText === "string" ? body.sourceText.trim() : "";
    const audioSessionId =
      typeof body?.audioSessionId === "string" ? body.audioSessionId : "";
    const snapshotHash =
      typeof body?.snapshotHash === "string"
        ? body.snapshotHash.toLowerCase()
        : "";
    const context = body?.context;
    const childAge = Number(body?.childAge ?? 6);
    if (
      !sourceText ||
      sourceText.length > 500 ||
      !sessionPattern.test(audioSessionId) ||
      !snapshotHashPattern.test(snapshotHash) ||
      typeof context !== "string" ||
      !contexts.has(context as PracticeContext) ||
      !Number.isInteger(childAge) ||
      childAge < 3 ||
      childAge > 18
    ) {
      throw new AppError(
        "BAD_REQUEST",
        "Dữ liệu finalize hội thoại đã chuẩn bị không hợp lệ.",
      );
    }
    const claimedClientId =
      typeof body?.clientId === "string" && body.clientId.trim()
        ? body.clientId.trim()
        : undefined;
    const uploadClaims = authorizeAudioSessionRequest(
      request,
      audioSessionId,
      claimedClientId,
    );

    const finalized = await finalizeWorkerConversation({
      requestId,
      clientId: uploadClaims?.clientId ?? claimedClientId,
      audioSessionId,
      snapshotHash,
      sourceText,
      context: context as PracticeContext,
      childAge,
      asrLatencyMs: Math.max(0, Math.round(Number(body?.asrLatencyMs ?? 0))),
      benchmark: body?.benchmark,
    });
    if (!finalized) {
      throw new AppError(
        "BAD_REQUEST",
        "Kết quả chuẩn bị đã hết hạn hoặc không khớp snapshot.",
        409,
      );
    }
    if (finalized.persistence) after(() => finalized.persistence!);
    after(async () => {
      try {
        const firstCommit = await finalized.completion;
        logEvent("info", "conversation_prepare_finalize_committed", {
          requestId,
          prepareId: finalized.prepareId,
          audioSessionId,
          firstCommit,
        });
      } catch (error) {
        logEvent("warn", "conversation_prepare_finalize_persist_failed", {
          requestId,
          prepareId: finalized.prepareId,
          audioSessionId,
          error,
        });
      }
    });
    logEvent("info", "conversation_prepare_finalize_completed", {
      requestId,
      prepareId: finalized.prepareId,
      audioSessionId,
      snapshotHash,
      preparationJoined: finalized.preparationJoined,
      textSource: finalized.result.textSource,
      audioSource: finalized.result.audioSource,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return withRequestId(
      Response.json({ ...finalized.result, learning: null }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "conversation_prepare_finalize_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
