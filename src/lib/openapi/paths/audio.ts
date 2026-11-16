import {
  INSTALLATION_SECURITY,
  INSTALL_AUTH_ERRORS,
  RETRY_AFTER,
  arrayOf,
  binaryResponse,
  enumOf,
  errorResponse,
  headerParam,
  int,
  jsonResponse,
  num,
  object,
  pathParam,
  queryParam,
  str,
  type OpenApiObject,
} from "../helpers";

const TAG = "Audio translation";
const TTS_TAG = "Audio files";

const AUDIO_EXTENSIONS = "aac, flac, m4a, mp3, mp4, ogg, wav, webm";

const translationResult: OpenApiObject = {
  englishText: str("Bản dịch tiếng Anh."),
  sourceText: str("Transcript tiếng Việt."),
  model: str("Model ASR."),
  textModel: str("Model dịch."),
  wordCount: int(),
  segments: arrayOf({}),
  vtt: str(),
  timings: object({ asrMs: num(), translationMs: num() }),
};

const translateBody: OpenApiObject = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: object(
        {
          audio: str(`File ghi âm, ≤ 10 MiB. MIME \`audio/*\` hoặc đuôi ${AUDIO_EXTENSIONS}.`, { format: "binary" }),
          sourceLanguage: str("Mã ngôn ngữ nguồn 2–3 chữ thường.", { default: "vi", pattern: "^[a-z]{2,3}$" }),
          clientId: str("ID thiết bị (phải khớp token)."),
        },
        ["audio"],
      ),
    },
  },
};

const jobAccepted = object(
  {
    requestId: str(),
    jobId: str(undefined, { pattern: "^[a-f0-9]{64}$" }),
    statusUrl: str(undefined, { example: "/api/audio/jobs/<jobId>" }),
    nextPollMs: { const: 2000 },
    status: { const: "queued" },
  },
  ["requestId", "jobId", "statusUrl", "nextPollMs", "status"],
);

const jobAcceptedResponse = jsonResponse("Đã nhận job, poll `statusUrl`.", jobAccepted, {
  Location: { description: "URL trạng thái job.", schema: { type: "string" } },
  ...RETRY_AFTER,
  "Preference-Applied": { schema: { type: "string", example: "respond-async" } },
});

const idempotencyKey = headerParam(
  "Idempotency-Key",
  "Chế độ job: khoá chống gửi trùng, `[a-zA-Z0-9._:-]{8,128}`. Bỏ trống thì server tự tạo.",
  false,
  { type: "string", pattern: "^[a-zA-Z0-9._:-]{8,128}$" },
);

const TRANSLATE_ERRORS: OpenApiObject = {
  "400": errorResponse("Thiếu audio, sourceLanguage sai, multipart lỗi (`BAD_REQUEST`, `AUDIO_TOO_SHORT`)."),
  ...INSTALL_AUTH_ERRORS,
  "409": errorResponse("Idempotency-Key đã dùng cho audio khác (`IDEMPOTENCY_CONFLICT`)."),
  "413": errorResponse("File quá lớn (`AUDIO_TOO_LONG`)."),
  "415": errorResponse("Không phải multipart hoặc không phải file audio (`BAD_REQUEST`)."),
  "429": errorResponse("Hàng đợi đầy / provider giới hạn (`RATE_LIMITED`).", RETRY_AFTER),
  "502": errorResponse("Provider ASR/dịch lỗi (`ASR_FAILED`, `LLM_FAILED`). `details` có `provider`, `stage`, `reason`."),
  "503": errorResponse(
    "Pool hết chỗ / quá thời gian chờ / job store không sẵn sàng (`ASR_FAILED`, `LLM_FAILED`, `AUDIO_JOB_UNAVAILABLE`, `AUTH_CONFIGURATION_ERROR`).",
    RETRY_AFTER,
  ),
  "504": errorResponse("Provider quá thời gian (`ASR_FAILED`, `LLM_FAILED`)."),
};

export const audioPaths: OpenApiObject = {
  "/api/audio/translate": {
    post: {
      tags: [TAG],
      summary: "Dịch file audio sang tiếng Anh",
      description:
        "Gửi một file ghi âm, nhận transcript + bản dịch. Khi bật eager TTS, response có `audioUrl` để phát ngay. Thêm header `Prefer: respond-async` (khi server bật jobs) để nhận 202 và poll.",
      operationId: "translateAudio",
      security: INSTALLATION_SECURITY,
      parameters: [
        headerParam("Prefer", "`respond-async` để chạy dạng job.", false, { type: "string", enum: ["respond-async"] }),
        idempotencyKey,
      ],
      requestBody: translateBody,
      responses: {
        "200": jsonResponse(
          "Bản dịch.",
          object(
            {
              requestId: str(),
              sourceLanguage: str(),
              targetLanguage: { const: "en" },
              ...translationResult,
              audioUrl: str("URL cache hoặc `/api/audio/stream?text=…`."),
              audioCacheReady: { type: "boolean" },
            },
            ["requestId", "sourceLanguage", "targetLanguage", "englishText", "model"],
          ),
          { "X-Audio-Cache": { schema: { type: "string", enum: ["disabled", "hit", "miss", "coalesced"] } } },
        ),
        "202": jobAcceptedResponse,
        ...TRANSLATE_ERRORS,
      },
    },
  },
  "/api/audio/jobs": {
    post: {
      tags: [TAG],
      summary: "Tạo job dịch audio (bất đồng bộ)",
      description:
        "Giống `/api/audio/translate` nhưng luôn trả 202. Cần AUDIO_TRANSLATION_JOBS_ENABLED=true, nếu không trả 404. Tối đa 10 job đang chờ mỗi thiết bị.",
      operationId: "createAudioJob",
      security: INSTALLATION_SECURITY,
      parameters: [idempotencyKey],
      requestBody: translateBody,
      responses: {
        "202": jobAcceptedResponse,
        "404": errorResponse("Server chưa bật jobs (`AUDIO_JOB_NOT_FOUND`)."),
        ...TRANSLATE_ERRORS,
      },
    },
  },
  "/api/audio/jobs/{jobId}": {
    get: {
      tags: [TAG],
      summary: "Trạng thái job dịch audio",
      description: "Poll mỗi `nextPollMs`. Job chưa xong hết hạn sau 15 phút; job đã xong giữ 1 giờ.",
      operationId: "getAudioJob",
      security: INSTALLATION_SECURITY,
      parameters: [pathParam("jobId", "64 ký tự hex.")],
      responses: {
        "200": jsonResponse(
          "Trạng thái hiện tại.",
          object(
            {
              requestId: str(),
              jobId: str(),
              status: enumOf(["queued", "running", "retrying", "completed", "failed"]),
              nextPollMs: { type: "integer", description: "Không có khi job đã kết thúc." },
              createdAt: str(undefined, { format: "date-time" }),
              startedAt: str(undefined, { format: "date-time" }),
              completedAt: str(undefined, { format: "date-time" }),
              result: object(
                { sourceLanguage: str(), targetLanguage: { const: "en" }, ...translationResult },
                ["englishText"],
                { description: "Chỉ có khi `completed`." },
              ),
              error: object(
                { code: { const: "AUDIO_JOB_FAILED" }, message: str() },
                ["code", "message"],
                { description: "Chỉ có khi `failed`." },
              ),
            },
            ["requestId", "jobId", "status", "createdAt"],
          ),
        ),
        "401": INSTALL_AUTH_ERRORS["401"],
        "404": errorResponse("Không có job hoặc không thuộc thiết bị này (`AUDIO_JOB_NOT_FOUND`)."),
        "410": errorResponse("Job đã hết hạn (`AUDIO_JOB_EXPIRED`)."),
        "503": errorResponse("Job store không sẵn sàng (`AUDIO_JOB_UNAVAILABLE`)."),
      },
    },
  },
  "/api/audio/stream": {
    get: {
      tags: [TTS_TAG],
      summary: "Phát TTS dạng stream",
      description:
        "Có cache → 307 tới file. Chưa có → stream audio trực tiếp từ TTS và lưu cache song song. Dùng URL do server trả về (đã kèm `missToken`/`node`).",
      operationId: "streamTts",
      parameters: [
        queryParam("text", "Câu cần đọc, 1–500 ký tự.", { type: "string", minLength: 1, maxLength: 500 }, true),
        queryParam("missToken", "Token một lần do server cấp, bỏ qua tra cache."),
        queryParam("node", "Gợi ý định tuyến backend, do server tạo."),
      ],
      responses: {
        "200": binaryResponse("Audio đang stream.", ["audio/mpeg"], {
          "X-Audio-Source": { schema: { type: "string", example: "cloudflare_tts" } },
          "X-Audio-Stream-Reused": { schema: { type: "string", enum: ["0", "1"] } },
        }),
        "307": {
          description: "Đã có cache, chuyển tới file audio.",
          headers: {
            Location: { schema: { type: "string" } },
            "X-Audio-Source": { schema: { type: "string", example: "cache" } },
          },
        },
        "400": errorResponse("text rỗng hoặc dài quá (`BAD_REQUEST`)."),
        "502": errorResponse("TTS lỗi (`TTS_FAILED`)."),
      },
    },
  },
  "/api/audio/target": {
    get: {
      tags: [TTS_TAG],
      summary: "Audio bản dịch Trung/Nhật/Hàn/Pháp (tạo sau)",
      description:
        "Chỉ dùng khi `AUDIO_TARGET_TTS_DEFERRED=true`: bản dịch trả về trước, `audioUrl` trỏ tới route này. " +
        "Chỉ chấp nhận URL do server ký (HMAC trên ngôn ngữ, hạn dùng và câu; hết hạn sau 15 phút). " +
        "Nhập vào lần tạo đang chạy trên cùng backend, hoặc 307 tới cache, hoặc tạo mới rồi trả MP3 hoàn chỉnh. " +
        "Khi `AUDIO_TARGET_TTS_STREAM=true`, lúc giọng đọc còn đang tạo thì body là MP3 phát dần " +
        "(chunked, không có `Content-Length`, `X-Audio-Source: stream`); mọi request vào sau đều nhận clip từ byte đầu.",
      operationId: "getTargetSpeech",
      parameters: [
        queryParam("lang", "Ngôn ngữ đích.", { type: "string", enum: ["zh", "ja", "ko", "fr"] }, true),
        queryParam("text", "Câu đã dịch, 1–300 ký tự.", { type: "string", minLength: 1, maxLength: 300 }, true),
        queryParam("exp", "Hạn dùng (ms Unix), do server tạo.", { type: "string" }, true),
        queryParam("sig", "Chữ ký base64url, do server tạo.", { type: "string" }, true),
        queryParam("node", "Gợi ý định tuyến backend, do server tạo."),
      ],
      responses: {
        "200": binaryResponse("MP3 của câu: hoàn chỉnh, hoặc phát dần khi `X-Audio-Source: stream`.", ["audio/mpeg"], {
          "X-Audio-Source": { schema: { type: "string", enum: ["joined", "synthesized", "stream"] } },
        }),
        "307": {
          description: "Đã có cache, chuyển tới file audio.",
          headers: {
            Location: { schema: { type: "string" } },
            "X-Audio-Source": { schema: { type: "string", example: "cache" } },
          },
        },
        "403": errorResponse("URL sai chữ ký, hết hạn hoặc thiếu tham số (`FORBIDDEN`)."),
        "502": errorResponse("TTS lỗi (`TTS_FAILED`)."),
      },
    },
  },
  "/api/audio/cache/{fileName}": {
    parameters: [pathParam("fileName", "Tên file, ví dụ `<hash>.mp3`. Cũng truy cập được qua `/generated-audio/{fileName}`.")],
    get: {
      tags: [TTS_TAG],
      summary: "Tải file audio đã cache",
      description: "Hỗ trợ `Range` (một khoảng). Kho Cloudinary trả 307 tới CDN.",
      operationId: "getCachedAudio",
      parameters: [headerParam("Range", "`bytes=start-end`, `bytes=start-` hoặc `bytes=-suffix`.")],
      responses: {
        "200": binaryResponse("Toàn bộ file. Cache 1 năm, immutable.", ["audio/mpeg", "application/octet-stream"]),
        "206": binaryResponse("Một phần file.", ["audio/mpeg", "application/octet-stream"], {
          "Content-Range": { schema: { type: "string" } },
        }),
        "307": { description: "Chuyển tới Cloudinary.", headers: { Location: { schema: { type: "string" } } } },
        "404": errorResponse("Không có file (`AUDIO_NOT_FOUND`)."),
        "416": { description: "Range không hợp lệ.", headers: { "Content-Range": { schema: { type: "string" } } } },
      },
    },
    head: {
      tags: [TTS_TAG],
      summary: "Kiểm tra file audio đã cache",
      operationId: "headCachedAudio",
      responses: {
        "200": { description: "File tồn tại (không có body)." },
        "307": { description: "Chuyển tới Cloudinary." },
        "404": { description: "Không có file." },
      },
    },
  },
};
