export const CHILD_DATA_POLICY_VERSION = "2026-08-25";

function configuredRetentionDays(
  variableName: string,
  fallbackVariableName = "CHILD_DATA_RETENTION_DAYS",
) {
  const configured = process.env[variableName]?.trim();
  const fallback = process.env[fallbackVariableName]?.trim();
  const value = Number(configured || fallback || "");
  return Number.isFinite(value) && value >= 1
    ? Math.min(3650, Math.floor(value))
    : null;
}

export function getUserAudioRetentionDays() {
  return configuredRetentionDays("USER_AUDIO_RETENTION_DAYS");
}

export function getHistoryRetentionDays() {
  return configuredRetentionDays("HISTORY_RETENTION_DAYS");
}

export function getDiagnosticRetentionDays() {
  return configuredRetentionDays("DIAGNOSTIC_RETENTION_DAYS");
}

/** @deprecated Use the data-specific getters above. */
export function getChildDataRetentionDays() {
  return getHistoryRetentionDays();
}

export function getChildDataPolicy() {
  const userAudioRetentionDays = getUserAudioRetentionDays();
  const historyRetentionDays = getHistoryRetentionDays();
  const diagnosticRetentionDays = getDiagnosticRetentionDays();
  const configuredRetentionValues = [
    userAudioRetentionDays,
    historyRetentionDays,
    diagnosticRetentionDays,
  ];

  return {
    version: CHILD_DATA_POLICY_VERSION,
    userAudioRetentionDays,
    historyRetentionDays,
    diagnosticRetentionDays,
    automaticDeletionEnabled: configuredRetentionValues.every(
      (value) => value !== null,
    ),
    exportFormat: "json" as const,
    parentCanExport: true,
    parentCanDeleteIndividualTurns: true,
    parentCanDeleteAllDeviceHistory: true,
    notes:
      userAudioRetentionDays && historyRetentionDays && diagnosticRetentionDays
        ? `Audio người dùng được giữ tối đa ${userAudioRetentionDays} ngày, lịch sử ${historyRetentionDays} ngày và chẩn đoán ${diagnosticRetentionDays} ngày.`
        : "Chưa cấu hình đủ thời hạn tự động xóa audio, lịch sử và chẩn đoán; phụ huynh vẫn có thể xuất hoặc xóa dữ liệu thủ công.",
  };
}
