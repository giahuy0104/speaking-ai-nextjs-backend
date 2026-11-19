import { after } from "next/server";
import type { PracticeContext } from "@/types/conversation";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  warmAllRuleAudioCaches,
  warmRuleAudioCache,
} from "@/lib/ai/audioWarmup";
import { claimLegacyConversationHistory } from "@/lib/history";
import { migrateApprovedHistoryLearning } from "@/lib/ai/adaptiveLearning";
import { requireAdminAccess } from "@/lib/adminAuth";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { audioCacheDisabled } from "@/lib/ai/loadTestPersistence";

export const runtime = "nodejs";
export const maxDuration = 300;

const validContexts = new Set(["home", "school", "outside"]);

function isPracticeContext(value: unknown): value is PracticeContext {
  return typeof value === "string" && validContexts.has(value);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      clientId?: unknown;
      context?: unknown;
      background?: unknown;
      limit?: unknown;
    };
    const context = body.context;
    const claimedClientId =
      typeof body.clientId === "string" && body.clientId.trim()
        ? body.clientId.trim()
        : undefined;
    let clientId = claimedClientId;
    if (claimedClientId) {
      clientId = (await requireInstallationAccess(request, claimedClientId))
        .clientId;
    } else {
      const denied = requireAdminAccess(request);
      if (denied) return denied;
    }
    const limit =
      body.limit === undefined
        ? undefined
        : typeof body.limit === "number" && Number.isFinite(body.limit)
          ? body.limit
          : NaN;

    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      throw new AppError(
        "BAD_REQUEST",
        "Giới hạn làm nóng audio không hợp lệ.",
      );
    }

    const warmup = () =>
      context === "all"
        ? warmAllRuleAudioCaches(clientId, { limit })
        : warmRuleAudioCache(context as PracticeContext, clientId, { limit });

    if (context !== "all" && !isPracticeContext(context)) {
      throw new AppError("BAD_REQUEST", "Vui lòng chọn ngữ cảnh hợp lệ.");
    }

    const claimedLegacyItems = clientId
      ? await claimLegacyConversationHistory(clientId)
      : 0;
    const migratedLearning = clientId
      ? await migrateApprovedHistoryLearning(clientId)
      : null;

    // Dev with no audio cache: pre-filling it would only write clips nobody reads.
    if (audioCacheDisabled()) {
      return Response.json(
        {
          accepted: true,
          context,
          claimedLegacyItems,
          migratedLearning,
          skipped: "audio_cache_disabled",
          message: "Audio cache is disabled; warm-up skipped.",
        },
        { status: 202 },
      );
    }

    if (body.background === true) {
      after(async () => {
        try {
          const result = await warmup();
          console.info("audio_cache_warmup_completed", {
            context: result.context,
            clientId,
            total: result.total,
            cached: result.cached,
            generated: result.generated,
            failed: result.failed,
            reused: result.reused,
            cacheHitRate: result.cacheHitRate,
            cacheHitTarget: 0.85,
            fingerprint: result.fingerprint,
            latencyMs: result.latencyMs,
          });
        } catch (error) {
          console.error("audio_cache_warmup_failed", {
            context,
            message:
              error instanceof Error ? error.message : "Unknown warmup error",
          });
        }
      });

      return Response.json(
        {
          accepted: true,
          context,
          claimedLegacyItems,
          migratedLearning,
          message: "Audio cache warm-up started in background.",
        },
        { status: 202 },
      );
    }

    const result = await warmup();

    return Response.json({ result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
