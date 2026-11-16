import {
  CRON_SECURITY,
  bool,
  enumOf,
  errorResponse,
  int,
  jsonResponse,
  object,
  str,
  type OpenApiObject,
} from "../helpers";

const TAG = "Internal (cron)";
const plainError = object({ error: str() }, ["error"]);

export const internalPaths: OpenApiObject = {
  "/api/internal/app-records/archive": {
    get: {
      tags: [TAG],
      summary: "Lưu trữ bản ghi hết hạn",
      description:
        "Cron job. Luôn yêu cầu `Authorization: Bearer <CRON_SECRET>` (mọi môi trường). Lỗi trả `error` dạng chuỗi.",
      operationId: "internalArchiveAppRecords",
      security: CRON_SECURITY,
      responses: {
        "200": jsonResponse("Đã chạy.", {
          oneOf: [
            object(
              {
                status: { const: "skipped" },
                reason: enumOf(["busy_or_no_expired_records", "unsafe_pending_archive_cancelled", "archive_lease_lost"]),
              },
              ["status", "reason"],
            ),
            object(
              {
                status: { const: "archived" },
                batchId: str(),
                key: str(),
                exported: int(),
                deleted: int(),
                sha256: str(),
              },
              ["status", "batchId", "key", "exported", "deleted", "sha256"],
            ),
          ],
        }),
        "401": jsonResponse("Sai hoặc thiếu CRON_SECRET.", plainError),
        "500": jsonResponse("Lưu trữ thất bại, chạy lại lần sau.", plainError),
      },
    },
  },
  "/api/internal/audio-sessions/cleanup": {
    get: {
      tags: [TAG],
      summary: "Dọn audio session hết hạn",
      description: "Cron job. Chỉ kiểm tra CRON_SECRET khi NODE_ENV=production.",
      operationId: "internalCleanupAudioSessions",
      security: CRON_SECURITY,
      responses: {
        "200": jsonResponse("Số session đã xoá.", object({ deletedCount: int() }, ["deletedCount"])),
        "401": errorResponse("Sai CRON_SECRET (`UNAUTHORIZED`)."),
      },
    },
  },
  "/api/internal/data-retention/cleanup": {
    get: {
      tags: [TAG],
      summary: "Xoá dữ liệu quá hạn lưu giữ",
      description: "Cron job. Xoá audio, diagnostics, lịch sử theo chính sách dữ liệu. CRON_SECRET chỉ bắt buộc ở production.",
      operationId: "internalDataRetentionCleanup",
      security: CRON_SECURITY,
      responses: {
        "200": jsonResponse(
          "Kết quả dọn dẹp.",
          object(
            {
              audioDeleted: int(),
              diagnosticsDeleted: int(),
              historyDeleted: int(),
              failures: int(),
              skipped: bool(),
            },
            ["audioDeleted", "diagnosticsDeleted", "historyDeleted", "failures", "skipped"],
          ),
        ),
        "401": errorResponse("Sai CRON_SECRET (`UNAUTHORIZED`)."),
      },
    },
  },
};
