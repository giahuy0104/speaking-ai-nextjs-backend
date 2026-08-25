type AudioCleanupGlobal = typeof globalThis & {
  __aiSpeakingAudioCleanupTimer?: ReturnType<typeof setInterval>;
  __aiSpeakingDataRetentionTimer?: ReturnType<typeof setInterval>;
};

const cleanupGlobal = globalThis as AudioCleanupGlobal;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const [
    { cleanupExpiredAudioSessions },
    { getAudioUploadLimits },
    { cleanupConversationDataRetention },
    { logEvent },
  ] =
    await Promise.all([
      import("@/lib/storage/audioSessions"),
      import("@/lib/storage/config"),
      import("@/lib/history"),
      import("@/lib/observability"),
    ]);

  if (!cleanupGlobal.__aiSpeakingAudioCleanupTimer) {
    const cleanupAudioSessions = () =>
      cleanupExpiredAudioSessions(true)
        .then((deletedCount) => {
          if (deletedCount > 0) {
            logEvent("info", "audio_session_background_cleanup_completed", {
              deletedCount,
            });
          }
        })
        .catch((error) => {
          logEvent("error", "audio_session_background_cleanup_failed", { error });
        });
    await cleanupAudioSessions();
    const intervalMs = getAudioUploadLimits().cleanupIntervalSeconds * 1_000;
    const timer = setInterval(cleanupAudioSessions, intervalMs);
    timer.unref();
    cleanupGlobal.__aiSpeakingAudioCleanupTimer = timer;
  }

  if (!cleanupGlobal.__aiSpeakingDataRetentionTimer) {
    const cleanupConversationData = () =>
      cleanupConversationDataRetention(true).catch((error) => {
        logEvent("error", "conversation_data_retention_background_failed", {
          error,
        });
      });
    await cleanupConversationData();
    const configured = Number(
      process.env.DATA_RETENTION_CLEANUP_INTERVAL_SECONDS ?? 86_400,
    );
    const intervalSeconds =
      Number.isFinite(configured) && configured >= 300
        ? Math.floor(configured)
        : 86_400;
    const timer = setInterval(cleanupConversationData, intervalSeconds * 1_000);
    timer.unref();
    cleanupGlobal.__aiSpeakingDataRetentionTimer = timer;
  }
}
