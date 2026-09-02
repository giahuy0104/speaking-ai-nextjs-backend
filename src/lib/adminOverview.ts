import "server-only";

import { getAdminSecurityMode } from "@/lib/adminAuth";
import {
  createDefaultDeviceProfile,
  readDeviceProfiles,
} from "@/lib/deviceProfiles";
import {
  cleanupConversationDataRetention,
  readConversationHistory,
} from "@/lib/history";
import type {
  AdminOverview,
  AdminReviewFilter,
  DeviceSummary,
} from "@/types/admin";
import type {
  ConversationHistoryEntry,
  ConversationReviewStatus,
} from "@/types/conversation";
import { buildLatencyReport } from "@/lib/reports";
import { getChildDataPolicy } from "@/lib/dataPolicy";
import { isPostgresStorageEnabled } from "@/lib/db";
import { readPostgresAdminOverviewSnapshot } from "@/lib/adminOverviewPostgres";

export function getConversationReviewStatus(
  conversation: ConversationHistoryEntry,
): ConversationReviewStatus {
  if (conversation.reviewStatus) {
    return conversation.reviewStatus;
  }

  if (conversation.qualityApproved === true) {
    return "approved";
  }

  if (conversation.qualityApproved === false) {
    return "rejected";
  }

  return "unreviewed";
}

function entryClientId(entry: ConversationHistoryEntry) {
  return entry.clientId?.trim() || "legacy";
}

function matchesStatus(
  entry: ConversationHistoryEntry,
  status: AdminReviewFilter,
) {
  if (status === "all") {
    return true;
  }

  if (status === "ai_suggested") {
    return Boolean(entry.aiReview);
  }

  return getConversationReviewStatus(entry) === status;
}

function buildLatencyHealth(
  sampleCount: number,
  p95FirstAudioMs: number,
): AdminOverview["latencyHealth"] {
  const configuredThreshold = Number(process.env.LATENCY_P95_ALERT_MS ?? 2500);
  const thresholdMs = Number.isFinite(configuredThreshold) &&
    configuredThreshold >= 500
    ? Math.round(configuredThreshold)
    : 2500;
  const warning = sampleCount >= 10 && p95FirstAudioMs > thresholdMs;

  return {
    sampleCount,
    p95FirstAudioMs,
    thresholdMs,
    status: warning
      ? "warning"
      : sampleCount >= 10
        ? "healthy"
        : "insufficient_data",
    message: warning
      ? `P95 từ lúc dừng nói đến khi audio bắt đầu phát là ${p95FirstAudioMs} ms, vượt ngưỡng ${thresholdMs} ms.`
      : sampleCount >= 10
        ? "P95 đang nằm trong ngưỡng theo dõi."
        : "Cần ít nhất 10 lượt có telemetry phát audio để đánh giá P95.",
  };
}

async function getPostgresAdminOverview(options: {
  clientId?: string;
  status: AdminReviewFilter;
  limit: number | null;
}): Promise<AdminOverview> {
  await cleanupConversationDataRetention();
  const dataPolicy = getChildDataPolicy();
  const snapshot = await readPostgresAdminOverviewSnapshot(options);

  const profiles = Object.fromEntries(
    snapshot.profiles.map((profile) => [profile.clientId, profile]),
  );
  const countsByClientId = new Map(
    snapshot.deviceCounts.map((counts) => [counts.clientId, counts]),
  );
  const allClientIds = new Set([
    ...Object.keys(profiles),
    ...snapshot.deviceCounts.map((counts) => counts.clientId),
  ]);
  const devices: DeviceSummary[] = [...allClientIds].map((clientId) => {
    const profile = profiles[clientId] ?? createDefaultDeviceProfile(clientId);
    const counts = countsByClientId.get(clientId);

    return {
      ...profile,
      conversationCount: counts?.conversationCount ?? 0,
      unreviewedCount: counts?.unreviewedCount ?? 0,
      approvedCount: counts?.approvedCount ?? 0,
      rejectedCount: counts?.rejectedCount ?? 0,
      lastSeenAt: counts?.lastSeenAt,
    };
  });
  devices.sort((left, right) =>
    (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""),
  );

  return {
    devices,
    conversations: snapshot.conversations,
    stats: snapshot.stats,
    latencyHealth: buildLatencyHealth(
      snapshot.latencySampleCount,
      snapshot.p95FirstAudioMs,
    ),
    dataPolicy,
    filters: options,
    securityMode: getAdminSecurityMode(),
    generatedAt: new Date().toISOString(),
  };
}

export async function getAdminOverview(options: {
  clientId?: string;
  status?: AdminReviewFilter;
  limit?: number | null;
} = {}): Promise<AdminOverview> {
  const status = options.status ?? "all";
  const limit = options.limit === null
    ? null
    : Math.max(1, Math.min(Math.floor(options.limit ?? 200), 500));
  if (isPostgresStorageEnabled()) {
    return getPostgresAdminOverview({
      clientId: options.clientId,
      status,
      limit,
    });
  }

  const [history, profiles] = await Promise.all([
    readConversationHistory(limit === null ? null : 500),
    readDeviceProfiles(),
  ]);
  const allClientIds = new Set([
    ...Object.keys(profiles),
    ...history.map(entryClientId),
  ]);

  const devices: DeviceSummary[] = [...allClientIds].map((clientId) => {
    const conversations = history.filter(
      (entry) => entryClientId(entry) === clientId,
    );
    const profile = profiles[clientId] ?? createDefaultDeviceProfile(clientId);

    return {
      ...profile,
      conversationCount: conversations.length,
      unreviewedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "unreviewed",
      ).length,
      approvedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "approved",
      ).length,
      rejectedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "rejected",
      ).length,
      lastSeenAt: conversations[0]?.createdAt,
    };
  });

  devices.sort((left, right) =>
    (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""),
  );

  const scopedHistory = options.clientId
    ? history.filter((entry) => entryClientId(entry) === options.clientId)
    : history;
  const matchingConversations = scopedHistory.filter((entry) =>
    matchesStatus(entry, status),
  );
  const conversations = limit === null
    ? matchingConversations
    : matchingConversations.slice(0, limit);
  const latencyReport = buildLatencyReport(scopedHistory);
  const latencyHealth = buildLatencyHealth(
    latencyReport.measuredTurns,
    latencyReport.p95FirstAudioMs,
  );

  return {
    devices,
    conversations,
    stats: {
      total: scopedHistory.length,
      unreviewed: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "unreviewed",
      ).length,
      approved: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "approved",
      ).length,
      rejected: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "rejected",
      ).length,
      needsReview: scopedHistory.filter(
        (entry) =>
          getConversationReviewStatus(entry) === "needs_review" ||
          entry.aiReview?.verdict === "needs_review",
      ).length,
      aiSuggested: scopedHistory.filter((entry) => entry.aiReview).length,
      learned: scopedHistory.filter((entry) => entry.promotedToRule).length,
    },
    latencyHealth,
    dataPolicy: getChildDataPolicy(),
    filters: {
      clientId: options.clientId,
      status,
      limit,
    },
    securityMode: getAdminSecurityMode(),
    generatedAt: new Date().toISOString(),
  };
}
