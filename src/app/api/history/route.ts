import {
  clearConversationHistory,
  claimLegacyConversationHistory,
  deleteConversationHistoryEntry,
  readConversationHistory,
  updateConversationHistory,
} from "@/lib/history";
import type {
  ConversationHistoryEntry,
  ConversationHistoryPatch,
} from "@/types/conversation";
import {
  learnFromPositiveFeedback,
  unlearnFromNegativeFeedback,
} from "@/lib/ai/adaptiveLearning";
import { requireAdminAccess } from "@/lib/adminAuth";
import { toErrorResponse } from "@/lib/errors";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

function toInstallationHistoryEntry(entry: ConversationHistoryEntry) {
  const safeEntry = { ...entry };
  delete safeEntry.userAudio;
  delete safeEntry.userAudioUrl;

  return {
    ...safeEntry,
    hasUserAudio: Boolean(entry.userAudio),
  };
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "");
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.floor(requestedLimit)
        : 50;
    const claimedClientId =
      url.searchParams.get("clientId")?.trim() || undefined;
    let clientId = claimedClientId;
    if (claimedClientId) {
      clientId = (await requireInstallationAccess(request, claimedClientId))
        .clientId;
    } else {
      const denied = requireAdminAccess(request);
      if (denied) {
        return denied;
      }
    }
    const claimedLegacyItems = clientId
      ? await claimLegacyConversationHistory(clientId)
      : 0;
    const history = await readConversationHistory(clientId ? 500 : limit);
    const conversations = (
      clientId
        ? history.filter((entry) => entry.clientId === clientId)
        : history
    ).slice(0, limit);
    const responseConversations = clientId
      ? conversations.map(toInstallationHistoryEntry)
      : conversations;

    return withRequestId(
      Response.json({
        conversations: responseConversations,
        learning: {
          scope: clientId ? "device" : "legacy",
          clientId,
          claimedLegacyItems,
        },
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    const claimedClientId =
      url.searchParams.get("clientId")?.trim() || undefined;
    let clientId = claimedClientId;
    if (claimedClientId) {
      clientId = (await requireInstallationAccess(request, claimedClientId))
        .clientId;
    } else {
      const denied = requireAdminAccess(request);
      if (denied) {
        return denied;
      }
    }

    if (conversationId) {
      const deleted = await deleteConversationHistoryEntry(
        conversationId,
        clientId,
      );

      logEvent("info", "child_history_item_deleted", {
        requestId,
        conversationId,
        deleted,
      });
      return withRequestId(Response.json({ deleted, requestId }), requestId);
    }

    await clearConversationHistory(clientId);
    logEvent("info", "child_history_cleared", { requestId, clientId });

    return withRequestId(
      Response.json({ conversations: [], requestId }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function PATCH(request: Request) {
  const requestId = getRequestId(request);
  try {
    const body = (await request.json()) as Partial<ConversationHistoryPatch>;
    const claimedClientId = body.clientId?.trim() || undefined;
    let clientId = claimedClientId;
    if (claimedClientId) {
      clientId = (await requireInstallationAccess(request, claimedClientId))
        .clientId;
    } else {
      const denied = requireAdminAccess(request);
      if (denied) {
        return denied;
      }
    }

    if (!body.conversationId) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Thiếu conversationId." } },
        { status: 400 },
      );
    }

    const historyPatch: ConversationHistoryPatch = {
      conversationId: body.conversationId,
      clientId,
      latency: body.latency,
      qualityApproved: body.qualityApproved,
      reviewStatus:
        typeof body.qualityApproved === "boolean"
          ? body.qualityApproved
            ? "approved"
            : "rejected"
          : body.reviewStatus,
      reviewedAt:
        typeof body.qualityApproved === "boolean"
          ? new Date().toISOString()
          : body.reviewedAt,
      reviewedBy:
        typeof body.qualityApproved === "boolean"
          ? "practice"
          : body.reviewedBy,
      reviewNote: body.reviewNote,
      promotedToRule: body.promotedToRule,
    };
    let conversation = await updateConversationHistory(historyPatch);

    // Conversation history is persisted after the main response. Playback can
    // begin before that background write finishes, especially for cached audio.
    // Retry only telemetry patches so the UI remains completely non-blocking.
    if (!conversation && body.latency) {
      for (const delayMs of [75, 150, 300]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        conversation = await updateConversationHistory(historyPatch);
        if (conversation) {
          break;
        }
      }
    }

    if (!conversation) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Không tìm thấy lượt nói." } },
        { status: 404 },
      );
    }

    let learning = null;

    if (typeof body.qualityApproved === "boolean") {
      try {
        learning = body.qualityApproved
          ? await learnFromPositiveFeedback(conversation)
          : await unlearnFromNegativeFeedback(conversation);
        conversation =
          (await updateConversationHistory({
            conversationId: body.conversationId,
            clientId,
            promotedToRule: learning.promoted,
            learningStatus: learning.status,
            learningReason: body.qualityApproved
              ? "positive_feedback"
              : "negative_feedback",
            learningUseCount: learning.useCount,
          })) ?? conversation;
      } catch (error) {
        console.error("adaptive_learning_feedback_failed", {
          conversationId: body.conversationId,
          qualityApproved: body.qualityApproved,
          error,
        });
      }
    }

    if (body.latency?.audioStartedAfterStopMs !== undefined) {
      logEvent("info", "playback_latency_recorded", {
        requestId,
        conversationId: body.conversationId,
        audioStartedAfterStopMs: body.latency.audioStartedAfterStopMs,
        audioLoadMs: body.latency.audioLoadMs,
        audioFromDeviceCache: body.latency.audioFromDeviceCache,
        responseToPlaybackMs: body.latency.responseToPlaybackMs,
        audioPreloadLoadedData: body.latency.audioPreloadLoadedData,
        audioPreloadCanPlay: body.latency.audioPreloadCanPlay,
        audioPreloadLoadedDataMs: body.latency.audioPreloadLoadedDataMs,
        audioPreloadCanPlayMs: body.latency.audioPreloadCanPlayMs,
      });
    }

    return withRequestId(
      Response.json({ conversation, learning, requestId }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
