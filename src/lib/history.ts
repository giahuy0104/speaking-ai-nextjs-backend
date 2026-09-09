import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ConversationHistoryEntry,
  ConversationHistoryPatch,
  ConversationResponse,
} from "@/types/conversation";
import {
  getDiagnosticRetentionDays,
  getHistoryRetentionDays,
  getUserAudioRetentionDays,
} from "@/lib/dataPolicy";
import {
  planConversationRetention,
  withoutConversationDiagnostics,
  withoutConversationUserAudio,
} from "@/lib/dataRetention";
import { logEvent } from "@/lib/observability";
import { deleteConversationUserAudio } from "@/lib/storage/cloudinaryUserAudio";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  clearRecords,
  deleteRecord,
  getRecord,
  insertRecordIfAbsent,
  listRecordEntries,
  listRecords,
  putRecord,
  updateRecord,
} from "@/lib/db/records";

const historyDir = path.join(process.cwd(), "data");
const historyPath = path.join(historyDir, "conversation-history.jsonl");
const historyNamespace = "conversation_history";
const maxHistoryResponseItems = 50;
const maxBoundedHistoryResponseItems = 500;
const ruleTextSources = new Set([
  "phrase_rule",
  "corpus_rule",
  "keyword_rule",
  "promoted_rule",
  "semantic_cache",
]);
const adaptiveTextSources = new Set(["cloudflare", "openai", "text_cache"]);

let mutationQueue: Promise<void> = Promise.resolve();
let lastMalformedSignature = "";
let lastRetentionCleanupAt = 0;
let retentionCleanupFlight: Promise<ConversationDataRetentionResult> | null =
  null;

export type ConversationDataRetentionResult = {
  audioDeleted: number;
  diagnosticsDeleted: number;
  historyDeleted: number;
  failures: number;
  skipped: boolean;
};

type ParsedHistory = {
  entries: ConversationHistoryEntry[];
  malformedLines: number[];
};

function initialLearningStatus(
  textSource: ConversationResponse["textSource"],
): ConversationHistoryEntry["learningStatus"] {
  if (ruleTextSources.has(textSource)) {
    return "already_rule";
  }
  if (["cloudflare", "openai"].includes(textSource)) {
    return "cached";
  }
  if (textSource === "text_cache") {
    return "observing";
  }
  return "not_eligible";
}

function isFileNotFound(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseHistory(content: string): ParsedHistory {
  const entries: ConversationHistoryEntry[] = [];
  const malformedLines: number[] = [];

  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    try {
      entries.push(JSON.parse(line) as ConversationHistoryEntry);
    } catch {
      malformedLines.push(index + 1);
    }
  });

  const signature = malformedLines.join(",");

  if (signature && signature !== lastMalformedSignature) {
    console.warn("conversation_history_malformed_lines", {
      lines: malformedLines,
    });
  }

  lastMalformedSignature = signature;
  return { entries, malformedLines };
}

async function readHistoryFile() {
  try {
    return parseHistory(await readFile(historyPath, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) {
      return { entries: [], malformedLines: [] } satisfies ParsedHistory;
    }

    throw error;
  }
}

async function writeHistoryFile(entries: ConversationHistoryEntry[]) {
  await mkdir(historyDir, { recursive: true });

  const temporaryPath = path.join(
    historyDir,
    `.conversation-history-${crypto.randomUUID()}.tmp`,
  );
  const content =
    entries.length > 0
      ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, historyPath);
    lastMalformedSignature = "";
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueMutation<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function applyConversationHistoryPatch(
  entry: ConversationHistoryEntry,
  patch: ConversationHistoryPatch,
) {
  return {
    ...entry,
    englishText: patch.englishText ?? entry.englishText,
    originalEnglishText:
      patch.originalEnglishText ?? entry.originalEnglishText,
    audioUrl: patch.audioUrl ?? entry.audioUrl,
    audioSource: patch.audioSource ?? entry.audioSource,
    userAudioUrl: patch.userAudioUrl ?? entry.userAudioUrl,
    userAudio: patch.userAudio ?? entry.userAudio,
    latency: patch.latency && entry.latency
      ? {
          ...entry.latency,
          ...patch.latency,
        }
      : entry.latency,
    qualityApproved: patch.qualityApproved ?? entry.qualityApproved,
    reviewStatus: patch.reviewStatus ?? entry.reviewStatus,
    reviewedAt: patch.reviewedAt ?? entry.reviewedAt,
    reviewedBy: patch.reviewedBy ?? entry.reviewedBy,
    reviewNote: patch.reviewNote ?? entry.reviewNote,
    aiReview: patch.aiReview ?? entry.aiReview,
    promotedToRule: patch.promotedToRule ?? entry.promotedToRule,
    learningStatus: patch.learningStatus ?? entry.learningStatus,
    learningReason: patch.learningReason ?? entry.learningReason,
    learningUseCount: patch.learningUseCount ?? entry.learningUseCount,
  } satisfies ConversationHistoryEntry;
}

export async function appendConversationHistory(
  conversation: ConversationResponse,
  inputMode: ConversationHistoryEntry["inputMode"],
) {
  const entry: ConversationHistoryEntry = {
    ...conversation,
    createdAt: new Date().toISOString(),
    inputMode,
    reviewStatus: "unreviewed",
    learningStatus: initialLearningStatus(conversation.textSource),
    learningUseCount: adaptiveTextSources.has(conversation.textSource)
      ? 1
      : undefined,
  };

  if (isPostgresStorageEnabled()) {
    await insertRecordIfAbsent({
      namespace: historyNamespace,
      key: entry.conversationId,
      clientId: entry.clientId,
      createdAt: entry.createdAt,
      value: entry,
    });
    return;
  }

  await enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    entries.push(entry);
    await writeHistoryFile(entries);
  });
}

function dataRetentionPolicy() {
  return {
    userAudioRetentionDays: getUserAudioRetentionDays(),
    historyRetentionDays: getHistoryRetentionDays(),
    diagnosticRetentionDays: getDiagnosticRetentionDays(),
  };
}

function retentionCleanupIntervalMs() {
  const configured = Number(
    process.env.DATA_RETENTION_CLEANUP_INTERVAL_SECONDS ?? 3_600,
  );
  const seconds =
    Number.isFinite(configured) && configured >= 60
      ? Math.floor(configured)
      : 3_600;
  return seconds * 1_000;
}

function emptyRetentionResult(skipped = false): ConversationDataRetentionResult {
  return {
    audioDeleted: 0,
    diagnosticsDeleted: 0,
    historyDeleted: 0,
    failures: 0,
    skipped,
  };
}

async function cleanupPostgresConversationData(
  now: Date,
): Promise<ConversationDataRetentionResult> {
  const result = emptyRetentionResult();
  const policy = dataRetentionPolicy();
  const records = await listRecordEntries<ConversationHistoryEntry>(
    historyNamespace,
    { limit: 100_000, oldestFirst: true },
  );

  for (const record of records) {
    const plan = planConversationRetention(record.value, policy, now);
    if (!plan.deleteHistory && !plan.deleteUserAudio && !plan.deleteDiagnostics) {
      continue;
    }

    try {
      if (plan.deleteUserAudio && record.value.userAudio) {
        await deleteConversationUserAudio(record.value.userAudio);
        result.audioDeleted += 1;
      }

      if (plan.deleteHistory) {
        const deleted = await deleteRecord(
          historyNamespace,
          record.key,
          record.clientId,
        );
        result.historyDeleted += deleted ? 1 : 0;
        continue;
      }

      const updated = await updateRecord<ConversationHistoryEntry>({
        namespace: historyNamespace,
        key: record.key,
        clientId: record.clientId,
        mutate: (current) => {
          let retained = current;
          if (plan.deleteUserAudio) {
            retained = withoutConversationUserAudio(retained);
          }
          if (plan.deleteDiagnostics) {
            retained = withoutConversationDiagnostics(retained, now.toISOString());
          }
          return retained;
        },
      });
      if (updated && plan.deleteDiagnostics) result.diagnosticsDeleted += 1;
    } catch (error) {
      result.failures += 1;
      logEvent("error", "conversation_data_retention_item_failed", {
        conversationId: record.key,
        error,
      });
    }
  }

  return result;
}

async function cleanupLocalConversationData(
  now: Date,
): Promise<ConversationDataRetentionResult> {
  return enqueueMutation(async () => {
    const result = emptyRetentionResult();
    const policy = dataRetentionPolicy();
    const { entries } = await readHistoryFile();
    const retainedEntries: ConversationHistoryEntry[] = [];
    let changed = false;

    for (const entry of entries) {
      const plan = planConversationRetention(entry, policy, now);
      if (!plan.deleteHistory && !plan.deleteUserAudio && !plan.deleteDiagnostics) {
        retainedEntries.push(entry);
        continue;
      }

      try {
        if (plan.deleteUserAudio && entry.userAudio) {
          await deleteConversationUserAudio(entry.userAudio);
          result.audioDeleted += 1;
        }
        if (plan.deleteHistory) {
          result.historyDeleted += 1;
          changed = true;
          continue;
        }

        let retained = entry;
        if (plan.deleteUserAudio) retained = withoutConversationUserAudio(retained);
        if (plan.deleteDiagnostics) {
          retained = withoutConversationDiagnostics(retained, now.toISOString());
          result.diagnosticsDeleted += 1;
        }
        retainedEntries.push(retained);
        changed = true;
      } catch (error) {
        result.failures += 1;
        retainedEntries.push(entry);
        logEvent("error", "conversation_data_retention_item_failed", {
          conversationId: entry.conversationId,
          error,
        });
      }
    }

    if (changed) await writeHistoryFile(retainedEntries);
    return result;
  });
}

export async function cleanupConversationDataRetention(
  force = false,
  now = new Date(),
): Promise<ConversationDataRetentionResult> {
  const policy = dataRetentionPolicy();
  if (Object.values(policy).every((value) => value === null)) {
    return emptyRetentionResult(true);
  }
  if (
    !force &&
    lastRetentionCleanupAt > 0 &&
    now.getTime() - lastRetentionCleanupAt < retentionCleanupIntervalMs()
  ) {
    return emptyRetentionResult(true);
  }
  if (retentionCleanupFlight) return retentionCleanupFlight;

  retentionCleanupFlight = (
    isPostgresStorageEnabled()
      ? cleanupPostgresConversationData(now)
      : cleanupLocalConversationData(now)
  )
    .then((result) => {
      lastRetentionCleanupAt = now.getTime();
      if (
        result.audioDeleted ||
        result.diagnosticsDeleted ||
        result.historyDeleted ||
        result.failures
      ) {
        logEvent("info", "conversation_data_retention_completed", result);
      }
      return result;
    })
    .finally(() => {
      retentionCleanupFlight = null;
    });

  return retentionCleanupFlight;
}

export async function readConversationHistory(
  limit: number | null = maxHistoryResponseItems,
) {
  const safeLimit = limit === null
    ? null
    : Math.max(
        1,
        Math.min(Math.floor(limit), maxBoundedHistoryResponseItems),
      );

  await cleanupConversationDataRetention();

  if (isPostgresStorageEnabled()) {
    return listRecords<ConversationHistoryEntry>(historyNamespace, {
      limit: safeLimit,
    });
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const newestFirst = [...entries].reverse();
    return safeLimit === null ? newestFirst : newestFirst.slice(0, safeLimit);
  });
}

export async function getConversationHistoryEntry(conversationId: string) {
  if (isPostgresStorageEnabled()) {
    const record = await getRecord<ConversationHistoryEntry>(
      historyNamespace,
      conversationId,
    );
    return record?.value ?? null;
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    return (
      entries.find((entry) => entry.conversationId === conversationId) ?? null
    );
  });
}

export async function claimLegacyConversationHistory(clientId: string) {
  if (isPostgresStorageEnabled()) {
    const entries = await listRecords<ConversationHistoryEntry>(
      historyNamespace,
      { limit: 100_000, oldestFirst: true },
    );
    const hasAnotherOwner = entries.some(
      (entry) => entry.clientId && entry.clientId !== clientId,
    );
    let claimed = 0;

    for (const entry of entries) {
      let nextEntry = entry;

      if (!entry.clientId && !hasAnotherOwner) {
        claimed += 1;
        nextEntry = { ...nextEntry, clientId };
      }

      if (nextEntry.clientId === clientId && !nextEntry.learningStatus) {
        nextEntry = {
          ...nextEntry,
          learningStatus: initialLearningStatus(nextEntry.textSource),
          learningUseCount: adaptiveTextSources.has(nextEntry.textSource)
            ? 1
            : undefined,
        };
      }

      if (nextEntry !== entry) {
        await putRecord({
          namespace: historyNamespace,
          key: nextEntry.conversationId,
          clientId: nextEntry.clientId,
          createdAt: nextEntry.createdAt,
          value: nextEntry,
        });
      }
    }

    return claimed;
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const hasAnotherOwner = entries.some(
      (entry) => entry.clientId && entry.clientId !== clientId,
    );

    let claimed = 0;
    let changed = false;
    const nextEntries = entries.map((entry) => {
      let nextEntry = entry;

      if (!entry.clientId && !hasAnotherOwner) {
        claimed += 1;
        changed = true;
        nextEntry = { ...entry, clientId };
      }

      if (nextEntry.clientId === clientId && !nextEntry.learningStatus) {
        changed = true;
        return {
          ...nextEntry,
          learningStatus: initialLearningStatus(nextEntry.textSource),
          learningUseCount: adaptiveTextSources.has(nextEntry.textSource)
            ? 1
            : undefined,
        };
      }

      return nextEntry;
    });

    if (changed) {
      await writeHistoryFile(nextEntries);
    }

    return claimed;
  });
}

export async function updateConversationHistory(
  patch: ConversationHistoryPatch,
) {
  if (isPostgresStorageEnabled()) {
    return updateRecord<ConversationHistoryEntry>({
      namespace: historyNamespace,
      key: patch.conversationId,
      clientId: patch.clientId,
      mutate: (entry) => applyConversationHistoryPatch(entry, patch),
    });
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    let updatedEntry: ConversationHistoryEntry | null = null;
    const nextEntries = entries.map((entry) => {
      if (
        entry.conversationId !== patch.conversationId ||
        (patch.clientId !== undefined && entry.clientId !== patch.clientId)
      ) {
        return entry;
      }

      updatedEntry = applyConversationHistoryPatch(entry, patch);

      return updatedEntry;
    });

    if (!updatedEntry) {
      return null;
    }

    await writeHistoryFile(nextEntries);
    return updatedEntry;
  });
}

export async function updateConversationHistoryBatch(
  patches: ConversationHistoryPatch[],
) {
  if (patches.length === 0) {
    return 0;
  }

  if (isPostgresStorageEnabled()) {
    let updated = 0;

    for (const patch of patches) {
      const result = await updateConversationHistory(patch);
      updated += result ? 1 : 0;
    }

    return updated;
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const patchesById = new Map(
      patches.map((patch) => [patch.conversationId, patch]),
    );
    let updated = 0;
    const nextEntries = entries.map((entry) => {
      const patch = patchesById.get(entry.conversationId);

      if (
        !patch ||
        (patch.clientId !== undefined && entry.clientId !== patch.clientId)
      ) {
        return entry;
      }

      updated += 1;
      return applyConversationHistoryPatch(entry, patch);
    });

    if (updated > 0) {
      await writeHistoryFile(nextEntries);
    }

    return updated;
  });
}

export async function deleteConversationHistoryEntry(
  conversationId: string,
  clientId?: string,
) {
  if (isPostgresStorageEnabled()) {
    const record = await getRecord<ConversationHistoryEntry>(
      historyNamespace,
      conversationId,
    );
    if (!record || (clientId !== undefined && record.value.clientId !== clientId)) {
      return false;
    }
    if (record.value.userAudio) {
      await deleteConversationUserAudio(record.value.userAudio);
    }
    return deleteRecord(historyNamespace, conversationId, clientId);
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const entry = entries.find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        (clientId === undefined || candidate.clientId === clientId),
    );
    if (!entry) return false;
    if (entry.userAudio) await deleteConversationUserAudio(entry.userAudio);
    const nextEntries = entries.filter(
      (entry) =>
        entry.conversationId !== conversationId ||
        (clientId !== undefined && entry.clientId !== clientId),
    );

    if (nextEntries.length === entries.length) {
      return false;
    }

    await writeHistoryFile(nextEntries);
    return true;
  });
}

export async function clearConversationHistory(clientId?: string) {
  if (isPostgresStorageEnabled()) {
    const entries = await listRecords<ConversationHistoryEntry>(
      historyNamespace,
      { clientId, limit: 100_000, oldestFirst: true },
    );
    for (const entry of entries) {
      if (entry.userAudio) await deleteConversationUserAudio(entry.userAudio);
    }
    await clearRecords(historyNamespace, clientId);
    return;
  }

  await enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const entriesToDelete =
      clientId === undefined
        ? entries
        : entries.filter((entry) => entry.clientId === clientId);
    for (const entry of entriesToDelete) {
      if (entry.userAudio) await deleteConversationUserAudio(entry.userAudio);
    }
    if (clientId === undefined) {
      await writeHistoryFile([]);
      return;
    }

    await writeHistoryFile(
      entries.filter((entry) => entry.clientId !== clientId),
    );
  });
}
