import {
  ADMIN_AUTH_ERRORS,
  ADMIN_SECURITY,
  AUDIO_SESSION_AUTH_ERRORS,
  AUDIO_SESSION_SECURITY,
  INSTALLATION_SECURITY,
  INSTALL_AUTH_ERRORS,
  arrayOf,
  bool,
  enumOf,
  errorResponse,
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
import { CONTEXTS, TARGET_LANGUAGES, TEXT_SOURCES } from "../schemas";

const TAG = "Conversation";
const HISTORY_TAG = "History";

const conversationResult = {
  allOf: [ref("ConversationResponse"), object({ learning: { type: "null" } })],
};

const PIPELINE_ERRORS: OpenApiObject = {
  "413": errorResponse("File audio quá lớn (`AUDIO_TOO_LONG`, mặc định 10 MiB)."),
  "422": errorResponse("Không nghe rõ câu nói (`ASR_LOW_CONFIDENCE`)."),
  "429": errorResponse("Hết quota provider AI (`RATE_LIMITED`)."),
  "502": errorResponse("Lỗi ASR / dịch / TTS phía provider (`ASR_FAILED`, `LLM_FAILED`, `TTS_FAILED`)."),
};

const preparationFields: OpenApiObject = {
  clientId: str(),
  audioSessionId: str(undefined, { pattern: "^[A-Za-z0-9._:-]{8,160}$" }),
  snapshotHash: str("SHA-256 (hex thường) của snapshot audio.", { pattern: "^[a-f0-9]{64}$" }),
  sourceText: str("Transcript streaming, 1–500 ký tự.", { minLength: 1, maxLength: 500 }),
  context: enumOf(CONTEXTS),
  childAge: { type: "integer", minimum: 3, maximum: 18, default: 6 },
  asrLatencyMs: num(),
  benchmark: ref("BenchmarkMetadata"),
};
const preparationRequired = ["audioSessionId", "snapshotHash", "sourceText", "context"];

export const conversationPaths: OpenApiObject = {
  "/api/conversation": {
    post: {
      tags: [TAG],
      summary: "Dịch một câu nói (text hoặc audio)",
      description:
        "Luồng chính: tiếng Việt của bé → bản dịch + audio TTS. Gửi JSON với `sourceText`, hoặc `multipart/form-data` với file `audio`. `targetLanguage` khác `en` sẽ điền `translatedText`.",
      operationId: "createConversation",
      security: INSTALLATION_SECURITY,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: object(
              {
                context: enumOf(CONTEXTS),
                sourceText: str("Câu tiếng Việt."),
                clientId: str(),
                childAge: { type: "number", default: 6 },
                targetLanguage: { ...enumOf(TARGET_LANGUAGES), default: "en" },
                sessionId: str(),
                asrMode: enumOf(["browser_streaming", "android_streaming", "openai_realtime", "ble_offline_intent"]),
                benchmark: ref("BenchmarkMetadata"),
              },
              ["context"],
            ),
            example: { context: "home", sourceText: "con muốn uống nước", targetLanguage: "en" },
          },
          "multipart/form-data": {
            schema: object(
              {
                context: enumOf(CONTEXTS),
                audio: str("File ghi âm (≤ 10 MiB). Cần `audio` hoặc `sourceText`.", { format: "binary" }),
                sourceText: str(),
                clientId: str(),
                childAge: str("Số dạng chuỗi, mặc định 6."),
                targetLanguage: enumOf(TARGET_LANGUAGES),
                sessionId: str(),
                benchmark: str("JSON object dạng chuỗi."),
              },
              ["context"],
            ),
          },
        },
      },
      responses: {
        "200": jsonResponse("Kết quả dịch.", conversationResult),
        "400": errorResponse("Thiếu context / dữ liệu sai (`BAD_REQUEST`, `AUDIO_TOO_SHORT`)."),
        ...INSTALL_AUTH_ERRORS,
        ...PIPELINE_ERRORS,
      },
    },
  },
  "/api/conversation/preview": {
    post: {
      tags: [TAG],
      summary: "Xem trước bản dịch từ rule/cache",
      description: "Chỉ tra rule và cache, không gọi AI. `matched=false` nghĩa là cần gọi luồng đầy đủ.",
      operationId: "previewConversation",
      security: INSTALLATION_SECURITY,
      requestBody: jsonBody(
        object(
          {
            sourceText: str(undefined, { minLength: 1, maxLength: 500 }),
            context: enumOf(CONTEXTS),
            childAge: { type: "number", default: 6 },
            clientId: str(),
          },
          ["sourceText", "context"],
        ),
        true,
        { sourceText: "con chào cô", context: "school" },
      ),
      responses: {
        "200": jsonResponse("Có hoặc không khớp.", {
          oneOf: [
            object({ matched: { const: false } }, ["matched"]),
            object(
              {
                matched: { const: true },
                sourceText: str(),
                englishText: str(),
                textSource: enumOf(TEXT_SOURCES),
                matchedRule: str(),
                audioUrl: nullable(str()),
                audioSource: nullable(enumOf(["cache"])),
              },
              ["matched", "sourceText", "englishText", "textSource", "audioUrl", "audioSource"],
            ),
          ],
        }),
        "400": errorResponse("sourceText/context không hợp lệ (`BAD_REQUEST`)."),
        ...INSTALL_AUTH_ERRORS,
      },
    },
  },
  "/api/conversation/prepare": {
    post: {
      tags: [TAG],
      summary: "Chuẩn bị bản dịch trong lúc bé còn nói",
      description:
        "Dịch sớm từ transcript streaming theo một snapshot audio. Kết quả giữ ~10 phút, xác nhận bằng `/commit`. Gọi trùng snapshot sẽ `joined=true`.",
      operationId: "prepareConversation",
      security: AUDIO_SESSION_SECURITY,
      requestBody: jsonBody(object(preparationFields, preparationRequired)),
      responses: {
        "200": jsonResponse(
          "Đã chuẩn bị.",
          object(
            {
              prepareId: str(undefined, { pattern: "^prep_[a-f0-9]{32}$" }),
              snapshotHash: str(),
              joined: bool(),
              expiresAt: str(undefined, { format: "date-time" }),
              result: conversationResult,
            },
            ["prepareId", "snapshotHash", "joined", "expiresAt", "result"],
          ),
        ),
        "400": errorResponse("Dữ liệu không hợp lệ (`BAD_REQUEST`)."),
        ...AUDIO_SESSION_AUTH_ERRORS,
        ...PIPELINE_ERRORS,
      },
    },
  },
  "/api/conversation/prepare/commit": {
    post: {
      tags: [TAG],
      summary: "Xác nhận bản dịch đã chuẩn bị",
      operationId: "commitPreparedConversation",
      security: AUDIO_SESSION_SECURITY,
      requestBody: jsonBody(
        object(
          {
            prepareId: str(undefined, { pattern: "^prep_[a-f0-9]{32}$" }),
            audioSessionId: preparationFields.audioSessionId as OpenApiObject,
            snapshotHash: preparationFields.snapshotHash as OpenApiObject,
            benchmark: ref("BenchmarkMetadata"),
          },
          ["prepareId", "audioSessionId", "snapshotHash"],
        ),
      ),
      responses: {
        "200": jsonResponse("Lượt hội thoại đã lưu.", conversationResult),
        "400": errorResponse("Dữ liệu không hợp lệ (`BAD_REQUEST`)."),
        "409": errorResponse("Bản chuẩn bị hết hạn, không tồn tại hoặc lệch session/snapshot (`BAD_REQUEST`)."),
        ...AUDIO_SESSION_AUTH_ERRORS,
      },
    },
  },
  "/api/conversation/prepare/finalize": {
    post: {
      tags: [TAG],
      summary: "Chuẩn bị + xác nhận trong một lần gọi",
      description: "Dùng lại kết quả đang chuẩn bị (nếu có) rồi commit ngay.",
      operationId: "finalizePreparedConversation",
      security: AUDIO_SESSION_SECURITY,
      requestBody: jsonBody(object(preparationFields, preparationRequired)),
      responses: {
        "200": jsonResponse("Lượt hội thoại đã lưu.", conversationResult),
        "400": errorResponse("Dữ liệu không hợp lệ (`BAD_REQUEST`)."),
        "409": errorResponse("Bản chuẩn bị hết hạn hoặc lệch snapshot (`BAD_REQUEST`)."),
        ...AUDIO_SESSION_AUTH_ERRORS,
        ...PIPELINE_ERRORS,
      },
    },
  },
  "/api/conversations/{conversationId}/user-audio": {
    parameters: [pathParam("conversationId", "`[A-Za-z0-9_-]{5,100}`.")],
    get: {
      tags: [HISTORY_TAG],
      summary: "Lấy link nghe lại ghi âm của bé",
      description: "Trả URL Cloudinary riêng tư, hết hạn sau 60 giây.",
      operationId: "getUserAudioUrl",
      security: INSTALLATION_SECURITY,
      parameters: [queryParam("clientId", "ID thiết bị sở hữu lượt nói.", { type: "string", pattern: "^[A-Za-z0-9._:-]{8,160}$" }, true)],
      responses: {
        "200": jsonResponse(
          "Link tạm thời.",
          object(
            { conversationId: str(), audioUrl: str(undefined, { format: "uri" }), expiresInSeconds: { const: 60 }, requestId: str() },
            ["conversationId", "audioUrl", "expiresInSeconds", "requestId"],
          ),
        ),
        "400": errorResponse("conversationId/clientId sai định dạng (`BAD_REQUEST`)."),
        "404": errorResponse("Không có ghi âm cho lượt này (`USER_AUDIO_NOT_FOUND`)."),
        ...INSTALL_AUTH_ERRORS,
      },
    },
    post: {
      tags: [HISTORY_TAG],
      summary: "Tải ghi âm gốc của bé lên",
      description: "Lưu file ghi âm cho lượt nói đã có. Idempotent: gửi lại vẫn trả 200.",
      operationId: "uploadUserAudio",
      security: INSTALLATION_SECURITY,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: object(
              {
                audio: str("File ghi âm, 1 byte – 10 MiB.", { format: "binary" }),
                clientId: str(undefined, { pattern: "^[A-Za-z0-9._:-]{8,160}$" }),
                sessionId: str(undefined, { pattern: "^[A-Za-z0-9._:-]{8,160}$" }),
                mimeType: str("Ví dụ `audio/mp4`."),
              },
              ["audio", "clientId", "sessionId"],
            ),
          },
        },
      },
      responses: {
        "200": jsonResponse(
          "Đã lưu.",
          object({ conversationId: str(), hasUserAudio: { const: true }, requestId: str() }, ["conversationId", "hasUserAudio", "requestId"]),
        ),
        "400": errorResponse("Thiếu audio/clientId/sessionId (`BAD_REQUEST`)."),
        "413": errorResponse("File quá lớn (`AUDIO_TOO_LONG`)."),
        ...INSTALL_AUTH_ERRORS,
        "503": errorResponse("Không lưu được: lượt nói không tồn tại, lệch client/session, hoặc lỗi kho (`USER_AUDIO_UPLOAD_FAILED`)."),
      },
    },
  },
  "/api/history": {
    get: {
      tags: [HISTORY_TAG],
      summary: "Lịch sử hội thoại",
      description:
        "Có `clientId` → dùng installation token, chỉ trả lịch sử thiết bị đó (ẩn link ghi âm, có `hasUserAudio`). Không có `clientId` → cần cookie admin, trả toàn bộ.",
      operationId: "listHistory",
      security: [...INSTALLATION_SECURITY, ...ADMIN_SECURITY],
      parameters: [
        queryParam("clientId", "ID thiết bị."),
        queryParam("limit", "Số lượt, mặc định 50.", { type: "integer", minimum: 1, default: 50 }),
      ],
      responses: {
        "200": jsonResponse(
          "Danh sách lượt nói, mới nhất trước.",
          object(
            {
              conversations: arrayOf(ref("ConversationHistoryEntry")),
              learning: object(
                { scope: enumOf(["device", "legacy"]), clientId: str(), claimedLegacyItems: int() },
                ["scope", "claimedLegacyItems"],
              ),
            },
            ["conversations", "learning"],
          ),
        ),
        ...INSTALL_AUTH_ERRORS,
      },
    },
    delete: {
      tags: [HISTORY_TAG],
      summary: "Xoá một lượt hoặc toàn bộ lịch sử",
      description: "Có `conversationId` → xoá một lượt. Không có → xoá hết lịch sử của thiết bị (hoặc toàn hệ thống nếu là admin).",
      operationId: "deleteHistory",
      security: [...INSTALLATION_SECURITY, ...ADMIN_SECURITY],
      parameters: [queryParam("conversationId", "Lượt cần xoá."), queryParam("clientId", "ID thiết bị.")],
      responses: {
        "200": jsonResponse("Đã xoá.", {
          oneOf: [
            object({ deleted: bool(), requestId: str() }, ["deleted", "requestId"]),
            object({ conversations: { type: "array", maxItems: 0 }, requestId: str() }, ["conversations", "requestId"]),
          ],
        }),
        ...INSTALL_AUTH_ERRORS,
      },
    },
    patch: {
      tags: [HISTORY_TAG],
      summary: "Cập nhật độ trễ / đánh giá của một lượt",
      description:
        "App gửi số đo phía thiết bị (`latency`) hoặc phụ huynh bấm đúng/sai (`qualityApproved`). `qualityApproved` kích hoạt học rule tự động với bản dịch tiếng Anh.",
      operationId: "patchHistory",
      security: [...INSTALLATION_SECURITY, ...ADMIN_SECURITY],
      requestBody: jsonBody(
        object(
          {
            conversationId: str(),
            clientId: str(),
            latency: { type: "object", additionalProperties: { type: ["number", "boolean"] } },
            qualityApproved: bool(),
            reviewStatus: enumOf(["unreviewed", "approved", "rejected", "needs_review"]),
            reviewedAt: str(),
            reviewedBy: enumOf(["admin", "practice"]),
            reviewNote: str(),
            promotedToRule: bool(),
          },
          ["conversationId"],
        ),
        true,
        { conversationId: "conv_123", clientId: "android_6f1c2a9e-4b7d", latency: { audioStartedAfterStopMs: 1450 } },
      ),
      responses: {
        "200": jsonResponse(
          "Lượt đã cập nhật.",
          object(
            {
              conversation: ref("ConversationHistoryEntry"),
              learning: nullable(ref("AdaptiveLearningOutcome")),
              requestId: str(),
            },
            ["conversation", "learning", "requestId"],
          ),
        ),
        "400": errorResponse("Thiếu conversationId (`BAD_REQUEST`)."),
        "404": errorResponse("Không tìm thấy lượt nói (code `BAD_REQUEST`)."),
        ...INSTALL_AUTH_ERRORS,
      },
    },
  },
  "/api/reports": {
    get: {
      tags: ["Admin"],
      summary: "Báo cáo độ trễ",
      operationId: "latencyReport",
      security: ADMIN_SECURITY,
      responses: {
        "200": jsonResponse("Báo cáo.", object({ report: ref("LatencyReport") }, ["report"])),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/rules/promote": {
    post: {
      tags: ["Admin"],
      summary: "Biến một bản dịch AI thành rule",
      description: "Chỉ áp dụng cho lượt có textSource là cloudflare / openai / text_cache. Tìm trong 1000 lượt gần nhất.",
      operationId: "promoteRule",
      security: ADMIN_SECURITY,
      requestBody: jsonBody(object({ conversationId: str(), clientId: str() }, ["conversationId"])),
      responses: {
        "200": jsonResponse(
          "Rule mới và audio của nó.",
          object({ rule: ref("PromotedRule"), audio: ref("AudioSynthesisResult") }, ["rule", "audio"]),
        ),
        "400": errorResponse("Thiếu conversationId hoặc lượt không phải bản dịch AI (`BAD_REQUEST`)."),
        "404": errorResponse("Không tìm thấy lượt (code `BAD_REQUEST`)."),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
};

