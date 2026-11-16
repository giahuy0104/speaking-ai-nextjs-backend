import {
  arrayOf,
  enumOf,
  errorResponse,
  int,
  jsonResponse,
  num,
  object,
  queryParam,
  str,
  type OpenApiObject,
} from "../helpers";
import { CONTEXTS } from "../schemas";

const TAG = "System";

export const systemPaths: OpenApiObject = {
  "/api/health": {
    get: {
      tags: [TAG],
      summary: "Health",
      description: "Liveness: process còn sống. Không kiểm tra DB/Redis.",
      operationId: "health",
      responses: {
        "200": jsonResponse(
          "Process đang chạy.",
          object(
            {
              status: { const: "ok" },
              service: { const: "speaking-ai-nextjs-backend" },
              checkedAt: str(undefined, { format: "date-time" }),
              instance: str("Hostname container trả lời."),
            },
            ["status", "service", "checkedAt", "instance"],
          ),
        ),
      },
    },
  },
  "/api/ready": {
    get: {
      tags: [TAG],
      summary: "Ready",
      description: "Readiness: kiểm tra database, Redis và storage (cache 2 giây).",
      operationId: "ready",
      responses: {
        "200": jsonResponse("Sẵn sàng nhận traffic.", object({ status: { const: "ready" } }, ["status"])),
        "503": jsonResponse("Một phụ thuộc chưa sẵn sàng.", object({ status: { const: "unavailable" } }, ["status"])),
      },
    },
  },
  "/api/app-version": {
    get: {
      tags: [TAG],
      summary: "Chính sách cập nhật app Android",
      description: "App so sánh build hiện tại với `minimumSupportedBuild` để bắt buộc cập nhật.",
      operationId: "appVersion",
      parameters: [
        queryParam("platform", "Chỉ hỗ trợ `android`.", { ...enumOf(["android"]), default: "android" }),
        queryParam("channel", "Chỉ hỗ trợ `direct`.", { ...enumOf(["direct"]), default: "direct" }),
      ],
      responses: {
        "200": jsonResponse(
          "Phiên bản mới nhất.",
          object(
            {
              platform: { const: "android" },
              channel: { const: "direct" },
              latestVersion: str(undefined, { example: "1.4.0" }),
              latestBuild: { type: "integer", minimum: 1 },
              minimumSupportedBuild: { type: "integer", minimum: 1 },
              downloadUrl: str(undefined, { format: "uri" }),
              messages: object({ vi: str(), zh: str() }, ["vi", "zh"]),
              checkedAt: str(undefined, { format: "date-time" }),
            },
            ["platform", "channel", "latestVersion", "latestBuild", "minimumSupportedBuild", "downloadUrl", "messages", "checkedAt"],
          ),
        ),
        "400": errorResponse("platform/channel không hỗ trợ (`UNSUPPORTED_UPDATE_CHANNEL`)."),
        "503": errorResponse("Thiếu biến môi trường ANDROID_* (`UPDATE_POLICY_NOT_CONFIGURED`)."),
      },
    },
  },
  "/api/offline-intents": {
    get: {
      tags: [TAG],
      summary: "Bộ câu nhận dạng offline",
      description: "Manifest câu mẫu + audio để thiết bị nhận dạng nhanh không cần mạng. Cache public 5 phút.",
      operationId: "offlineIntents",
      parameters: [queryParam("limit", "Số câu, 30–500. Mặc định 40.", { type: "integer", minimum: 30, maximum: 500, default: 40 })],
      responses: {
        "200": jsonResponse(
          "Manifest.",
          object(
            {
              version: str("16 ký tự hex, đổi khi nội dung đổi."),
              sampleRate: { const: 24000 },
              policy: object({
                confidenceThreshold: num(),
                marginThreshold: num(),
                stableUpdates: int(),
                earlyFallbackMs: int(),
              }),
              items: arrayOf(
                object(
                  {
                    id: str(),
                    contexts: arrayOf(enumOf(CONTEXTS)),
                    samples: arrayOf(str()),
                    englishText: str(),
                    audioUrl: str(),
                  },
                  ["id", "contexts", "samples", "englishText", "audioUrl"],
                ),
              ),
            },
            ["version", "sampleRate", "policy", "items"],
          ),
        ),
      },
    },
  },
  "/api/sessions": {
    get: {
      tags: [TAG],
      summary: "Phiên luyện tập (placeholder)",
      description: "MVP: luôn trả mảng rỗng.",
      operationId: "listSessions",
      deprecated: true,
      responses: {
        "200": jsonResponse(
          "Luôn rỗng.",
          object({ sessions: arrayOf({}), note: str() }, ["sessions", "note"]),
        ),
      },
    },
  },
};
