import {
  ADMIN_SECURITY,
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
  str,
  type OpenApiObject,
} from "../helpers";
import { CONTEXTS } from "../schemas";

const TAG = "Listening practice";

export const listeningPaths: OpenApiObject = {
  "/api/listening/evaluate-attempt": {
    post: {
      tags: [TAG],
      summary: "Chấm câu bé nói lại bằng tiếng Anh",
      description: "Nhận dạng giọng bé và so với câu mẫu `expectedEnglish`.",
      operationId: "evaluateListeningAttempt",
      security: INSTALLATION_SECURITY,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: object(
              {
                audio: str("File ghi âm ≤ 10 MiB.", { format: "binary" }),
                expectedEnglish: str("Câu mẫu, 1–300 ký tự.", { minLength: 1, maxLength: 300 }),
                clientId: str(),
              },
              ["audio", "expectedEnglish"],
            ),
          },
        },
      },
      responses: {
        "200": jsonResponse(
          "Kết quả chấm.",
          object({ requestId: str(), transcript: str(), matched: bool(), model: str() }, ["requestId", "transcript", "matched", "model"]),
        ),
        "400": errorResponse("Thiếu audio / expectedEnglish (`BAD_REQUEST`, `AUDIO_TOO_SHORT`)."),
        ...INSTALL_AUTH_ERRORS,
        "413": errorResponse("File quá lớn (`AUDIO_TOO_LONG`)."),
        "415": errorResponse("Không phải multipart / không phải audio (`BAD_REQUEST`)."),
        "502": errorResponse("ASR lỗi (`ASR_FAILED`)."),
      },
    },
  },
  "/api/listening/recognize-choice": {
    post: {
      tags: [TAG],
      summary: "Nhận dạng lựa chọn bé nói (tiếng Việt)",
      operationId: "recognizeListeningChoice",
      security: INSTALLATION_SECURITY,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: object(
              { audio: str("File ghi âm ≤ 2 MiB.", { format: "binary" }), clientId: str() },
              ["audio"],
            ),
          },
        },
      },
      responses: {
        "200": jsonResponse(
          "Transcript tiếng Việt.",
          object(
            { requestId: str(), transcript: str(), provider: { const: "cloudflare" }, model: str() },
            ["requestId", "transcript", "provider", "model"],
          ),
        ),
        "400": errorResponse("Thiếu audio (`AUDIO_TOO_SHORT`)."),
        ...INSTALL_AUTH_ERRORS,
        "413": errorResponse("File quá 2 MiB (`AUDIO_TOO_LONG`)."),
        "415": errorResponse("Không phải multipart (`BAD_REQUEST`)."),
        "502": errorResponse("ASR lỗi (`ASR_FAILED`)."),
      },
    },
  },
  "/api/cache/warmup": {
    post: {
      tags: ["Audio files"],
      summary: "Làm nóng cache audio câu mẫu",
      description:
        "Tạo sẵn TTS cho các câu mẫu. Có `clientId` → dùng installation token (và nhận lịch sử cũ về thiết bị). Không có → cần cookie admin. `background=true` trả 202 ngay.",
      operationId: "warmupAudioCache",
      security: [...INSTALLATION_SECURITY, ...ADMIN_SECURITY],
      requestBody: jsonBody(
        object(
          {
            context: enumOf([...CONTEXTS, "all"]),
            clientId: str(),
            background: bool(),
            limit: { type: "number", minimum: 1 },
          },
          ["context"],
        ),
        true,
        { context: "all", background: true },
      ),
      responses: {
        "200": jsonResponse(
          "Đã làm nóng xong.",
          object(
            {
              result: object({
                context: str(),
                total: int(),
                cached: int(),
                generated: int(),
                failed: int(),
                latencyMs: num(),
                reused: bool(),
                fingerprint: str(),
                cacheHitRate: num(),
                items: arrayOf(
                  object({
                    englishText: str(),
                    audioUrl: nullable(str()),
                    status: enumOf(["cached", "generated", "failed"]),
                    latencyMs: num(),
                    errorMessage: str(),
                  }),
                ),
              }),
            },
            ["result"],
          ),
        ),
        "202": jsonResponse(
          "Đang chạy nền.",
          object(
            {
              accepted: { const: true },
              context: str(),
              claimedLegacyItems: int(),
              migratedLearning: nullable(object({ reviewed: int(), promoted: int(), conflicts: int() })),
              message: str(),
            },
            ["accepted", "context", "claimedLegacyItems", "migratedLearning", "message"],
          ),
        ),
        "400": errorResponse("context / limit không hợp lệ (`BAD_REQUEST`)."),
        ...INSTALL_AUTH_ERRORS,
      },
    },
  },
};
