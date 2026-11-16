import {
  ADMIN_AUTH_ERRORS,
  ADMIN_SECURITY,
  arrayOf,
  binaryResponse,
  bool,
  enumOf,
  errorResponse,
  headerParam,
  int,
  jsonBody,
  jsonResponse,
  nullable,
  num,
  object,
  pathParam,
  queryParam,
  ref,
  str,
  type OpenApiObject,
} from "../helpers";

const TAG = "Admin";
const conversationIdParam = pathParam("conversationId", "ID lượt hội thoại.");
const sessionCookieHeader = {
  "Set-Cookie": {
    description:
      "`ai-speaking-admin-session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (thêm `Secure` ở production).",
    schema: { type: "string" },
  },
};
const audioTypes = ["audio/mp4", "audio/mpeg", "audio/wav", "application/octet-stream"];

const adminOverviewSchema = object(
  {
    devices: arrayOf({
      allOf: [
        ref("DeviceProfile"),
        object({
          conversationCount: int(),
          unreviewedCount: int(),
          approvedCount: int(),
          rejectedCount: int(),
          lastSeenAt: str(undefined, { format: "date-time" }),
        }),
      ],
    }),
    conversations: arrayOf(ref("ConversationHistoryEntry")),
    stats: object({
      total: int(),
      unreviewed: int(),
      approved: int(),
      rejected: int(),
      needsReview: int(),
      aiSuggested: int(),
      learned: int(),
    }),
    latencyHealth: object({
      sampleCount: int(),
      p95FirstAudioMs: num(),
      thresholdMs: num(),
      status: enumOf(["healthy", "warning", "insufficient_data"]),
      message: str(),
    }),
    dataPolicy: ref("DataPolicy"),
    filters: object({ clientId: str(), status: str(), limit: nullable(int()) }),
    securityMode: enumOf(["account-password", "not-configured"]),
    generatedAt: str(undefined, { format: "date-time" }),
  },
  ["devices", "conversations", "stats", "latencyHealth", "dataPolicy", "filters", "securityMode", "generatedAt"],
);

const healthCheck = object({ ok: bool(), latencyMs: num() }, ["ok", "latencyMs"]);
const successSchema = object({ success: { const: true } }, ["success"]);

export const adminPaths: OpenApiObject = {
  "/api/admin/auth/login": {
    post: {
      tags: [TAG],
      summary: "Đăng nhập admin",
      description:
        "So khớp với ADMIN_USERNAME / ADMIN_PASSWORD. Thành công trả cookie phiên 12 giờ. Sai thông tin bị trễ 350 ms. Body > 4096 byte bị từ chối ngay.",
      operationId: "adminLogin",
      requestBody: jsonBody(
        object(
          {
            username: str("Tối đa 256 ký tự (đã trim).", { maxLength: 256 }),
            password: str("Tối đa 1024 ký tự.", { maxLength: 1024, format: "password" }),
          },
          ["username", "password"],
        ),
      ),
      responses: {
        "200": jsonResponse("Đăng nhập thành công.", successSchema, sessionCookieHeader),
        "401": errorResponse("Sai thông tin, JSON lỗi hoặc body quá lớn (`INVALID_CREDENTIALS`)."),
        "503": errorResponse("Server chưa cấu hình tài khoản admin (`ADMIN_NOT_CONFIGURED`)."),
      },
    },
  },
  "/api/admin/auth/logout": {
    post: {
      tags: [TAG],
      summary: "Đăng xuất admin",
      description: "Xoá cookie phiên (Max-Age=0). Không kiểm tra phiên hiện tại.",
      operationId: "adminLogout",
      responses: {
        "200": jsonResponse("Đã xoá cookie.", successSchema, sessionCookieHeader),
      },
    },
  },
  "/api/admin/overview": {
    get: {
      tags: [TAG],
      summary: "Tổng quan dashboard admin",
      description: "Danh sách thiết bị, lượt hội thoại gần nhất, thống kê review và sức khoẻ độ trễ.",
      operationId: "adminOverview",
      security: ADMIN_SECURITY,
      parameters: [
        queryParam("status", "Lọc theo trạng thái review. Giá trị lạ được coi là `all`.", {
          ...enumOf(["all", "unreviewed", "approved", "rejected", "needs_review", "ai_suggested"]),
          default: "all",
        }),
        queryParam("limit", "Số lượt (1–500) hoặc `all`. Mặc định 50.", { type: "string", default: "50" }),
        queryParam("clientId", "Chỉ lấy một thiết bị."),
      ],
      responses: {
        "200": jsonResponse("Dữ liệu tổng quan.", object({ overview: adminOverviewSchema }, ["overview"])),
        "401": ADMIN_AUTH_ERRORS["401"],
        "503": errorResponse(
          "Chưa cấu hình admin (`ADMIN_NOT_CONFIGURED`) hoặc hết quota truyền dữ liệu DB (`DATABASE_TRANSFER_QUOTA_EXCEEDED`, kèm `Retry-After: 3600`).",
        ),
      },
    },
  },
  "/api/admin/storage-health": {
    get: {
      tags: [TAG],
      summary: "Kiểm tra kho lưu trữ",
      description: "Ping Postgres, Blob, R2 và đếm bản ghi. Trả 200 kể cả khi `ok=false`.",
      operationId: "adminStorageHealth",
      security: ADMIN_SECURITY,
      responses: {
        "200": jsonResponse(
          "Kết quả kiểm tra.",
          object({
            ok: bool(),
            configuration: object(
              {
                persistenceBackend: str(),
                audioStorageBackend: str(),
                audioSessionChunkStorageBackend: str(),
                postgresConfigured: bool(),
                postgresAudioConfigured: bool(),
                blobConfigured: bool(),
                r2CredentialsConfigured: bool(),
                r2Configured: bool(),
                uploadLimits: object({}, [], { additionalProperties: { type: "number" } }),
              },
              [],
              { additionalProperties: true },
            ),
            database: healthCheck,
            blob: healthCheck,
            r2: healthCheck,
            recordCounts: nullable(
              object({
                conversations: int(),
                deviceProfiles: int(),
                promotedRules: int(),
                textCacheEntries: int(),
              }),
            ),
            checkedAt: str(undefined, { format: "date-time" }),
          }),
        ),
        "401": ADMIN_AUTH_ERRORS["401"],
        "503": errorResponse("Kiểm tra bị lỗi (`STORAGE_UNAVAILABLE`) hoặc chưa cấu hình admin."),
      },
    },
  },
  "/api/admin/data-export": {
    get: {
      tags: [TAG],
      summary: "Xuất dữ liệu một thiết bị (JSON)",
      description:
        "Tải file `ai-speaking-<clientId>.json` gồm hồ sơ thiết bị, tối đa 500 lượt hội thoại gần nhất và rule đã học.",
      operationId: "adminDataExport",
      security: ADMIN_SECURITY,
      parameters: [queryParam("clientId", "ID thiết bị cần xuất.", { type: "string", minLength: 1 }, true)],
      responses: {
        "200": jsonResponse(
          "File JSON (Content-Disposition: attachment).",
          object(
            {
              schemaVersion: { const: 1 },
              exportedAt: str(undefined, { format: "date-time" }),
              dataPolicy: ref("DataPolicy"),
              device: nullable(ref("DeviceProfile")),
              conversations: arrayOf(ref("ConversationHistoryEntry")),
              promotedRules: arrayOf({ type: "object", additionalProperties: true }),
            },
            ["schemaVersion", "exportedAt", "dataPolicy", "device", "conversations", "promotedRules"],
          ),
          { "Content-Disposition": { schema: { type: "string" } } },
        ),
        "400": errorResponse("Thiếu `clientId` (`BAD_REQUEST`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/devices/{clientId}": {
    patch: {
      tags: [TAG],
      summary: "Đặt tên thiết bị / tên bé",
      operationId: "adminUpdateDevice",
      security: ADMIN_SECURITY,
      parameters: [pathParam("clientId", "ID thiết bị (1–200 ký tự).")],
      requestBody: jsonBody(
        object(
          {
            deviceName: str("1–100 ký tự.", { minLength: 1, maxLength: 100 }),
            childName: str("Tối đa 100 ký tự.", { maxLength: 100 }),
          },
          ["deviceName"],
        ),
        true,
        { deviceName: "Máy tính bảng phòng khách", childName: "Bé Na" },
      ),
      responses: {
        "200": jsonResponse("Hồ sơ đã cập nhật.", object({ device: ref("DeviceProfile") }, ["device"])),
        "400": errorResponse("clientId hoặc deviceName/childName không hợp lệ (`BAD_REQUEST`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/conversations/{conversationId}/review": {
    patch: {
      tags: [TAG],
      summary: "Duyệt / từ chối một lượt dịch",
      description:
        "`approved` có thể kèm `correctedEnglish` và sẽ học thành rule. `rejected` xoá rule và cache dịch AI. Chỉ tìm trong 500 lượt gần nhất.",
      operationId: "adminReviewConversation",
      security: ADMIN_SECURITY,
      parameters: [conversationIdParam],
      requestBody: jsonBody(
        object(
          {
            verdict: enumOf(["unreviewed", "approved", "rejected"]),
            clientId: str("Lọc theo thiết bị khi có."),
            correctedEnglish: str("Bản dịch đã sửa, tối đa 300 ký tự.", { maxLength: 300 }),
            note: str("Ghi chú, cắt còn 500 ký tự.", { maxLength: 500 }),
          },
          ["verdict"],
        ),
        true,
        { verdict: "approved", correctedEnglish: "I want to drink water." },
      ),
      responses: {
        "200": jsonResponse(
          "Đã lưu đánh giá. Nội dung `learning` tuỳ verdict.",
          object(
            {
              conversation: nullable(ref("ConversationHistoryEntry")),
              learning: object(
                {
                  removedRule: bool("Có khi verdict là unreviewed/rejected."),
                  removedCachedTexts: { description: "Có khi verdict là rejected." },
                  promoted: bool("Có khi verdict là approved."),
                  scopedToClientId: nullable(str()),
                  audio: nullable(
                    object({ audioUrl: str(), source: enumOf(["cache", "openai_tts", "cloudflare_tts"]) }),
                  ),
                  warning: nullable(str()),
                },
                [],
                { additionalProperties: true },
              ),
            },
            ["conversation", "learning"],
          ),
        ),
        "400": errorResponse("verdict sai, correctedEnglish quá dài hoặc bản dịch rỗng (`BAD_REQUEST`)."),
        "404": errorResponse("Không tìm thấy lượt hội thoại (`NOT_FOUND`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/conversations/{conversationId}/ai-review": {
    post: {
      tags: [TAG],
      summary: "Nhờ AI chấm bản dịch",
      description: "Trả kết quả đã lưu nếu có, trừ khi `force=true`.",
      operationId: "adminAiReviewConversation",
      security: ADMIN_SECURITY,
      parameters: [conversationIdParam],
      requestBody: jsonBody(
        object({ clientId: str("Lọc theo thiết bị."), force: bool("`true` để chấm lại.") }),
        false,
      ),
      responses: {
        "200": jsonResponse(
          "Kết quả chấm.",
          object(
            {
              aiReview: ref("ConversationAiReview"),
              cached: bool(),
              conversation: nullable(ref("ConversationHistoryEntry")),
            },
            ["aiReview", "cached", "conversation"],
          ),
        ),
        "404": errorResponse("Không tìm thấy lượt hội thoại (`NOT_FOUND`)."),
        "502": errorResponse("Gọi LLM thất bại (`LLM_FAILED`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/conversations/{conversationId}/user-audio": {
    get: {
      tags: [TAG],
      summary: "Nghe ghi âm của bé (admin)",
      description: "Proxy file ghi âm gốc từ Cloudinary (link ký 60 giây). Hỗ trợ `Range`.",
      operationId: "adminGetUserAudio",
      security: ADMIN_SECURITY,
      parameters: [conversationIdParam, headerParam("Range", "Ví dụ `bytes=0-`.")],
      responses: {
        "200": binaryResponse("Toàn bộ file audio.", audioTypes),
        "206": binaryResponse("Một phần file (Range).", audioTypes, {
          "Content-Range": { schema: { type: "string" } },
        }),
        "404": errorResponse("Lượt hội thoại không có ghi âm (`NOT_FOUND`)."),
        "502": errorResponse("Không tải được audio từ kho (`AUDIO_UNAVAILABLE`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
};
