import type { ConversationHistoryEntry } from "@/types/conversation";

export type ConversationRetentionPolicy = {
  userAudioRetentionDays: number | null;
  historyRetentionDays: number | null;
  diagnosticRetentionDays: number | null;
};

export type ConversationRetentionPlan = {
  deleteHistory: boolean;
  deleteUserAudio: boolean;
  deleteDiagnostics: boolean;
};

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

function isOlderThan(
  createdAt: string,
  retentionDays: number | null,
  nowMs: number,
) {
  if (!retentionDays) return false;
  const createdAtMs = Date.parse(createdAt);
  return (
    Number.isFinite(createdAtMs) &&
    createdAtMs < nowMs - retentionDays * millisecondsPerDay
  );
}

export function planConversationRetention(
  entry: ConversationHistoryEntry,
  policy: ConversationRetentionPolicy,
  now = new Date(),
): ConversationRetentionPlan {
  const nowMs = now.getTime();
  const deleteHistory = isOlderThan(
    entry.createdAt,
    policy.historyRetentionDays,
    nowMs,
  );

  return {
    deleteHistory,
    deleteUserAudio:
      Boolean(entry.userAudio) &&
      (deleteHistory ||
        isOlderThan(entry.createdAt, policy.userAudioRetentionDays, nowMs)),
    deleteDiagnostics:
      Boolean(entry.latency || entry.benchmark) &&
      (deleteHistory ||
        isOlderThan(entry.createdAt, policy.diagnosticRetentionDays, nowMs)),
  };
}

export function withoutConversationUserAudio(
  entry: ConversationHistoryEntry,
): ConversationHistoryEntry {
  const retained = { ...entry };
  delete retained.userAudio;
  delete retained.userAudioUrl;
  return retained;
}

export function withoutConversationDiagnostics(
  entry: ConversationHistoryEntry,
  deletedAt: string,
): ConversationHistoryEntry {
  const retained = { ...entry };
  delete retained.benchmark;
  delete retained.latency;
  return {
    ...retained,
    diagnosticsDeletedAt: deletedAt,
  };
}
