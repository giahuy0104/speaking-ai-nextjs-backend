import {
  AUDIO_SESSION_AUTH_ERRORS,
  AUDIO_SESSION_SECURITY,
  INSTALLATION_SECURITY,
  INSTALL_AUTH_ERRORS,
  RETRY_AFTER,
  bool,
  enumOf,
  errorResponse,
  headerParam,
  int,
  jsonBody,
  jsonResponse,
  num,
  object,
  pathParam,
  ref,
  str,
  type OpenApiObject,
} from "../helpers";
import { CONTEXTS, TARGET_LANGUAGES, TEXT_SOURCES } from "../schemas";

const TAG = "Audio sessions (chunk upload)";
const sessionIdParam = pathParam("audioSessionId", "ID từ `POST /api/audio-sessions`.");

const pcm16Wav = object(
  {
    sampleRate: { type: "integer", minimum: 8000, maximum: 96000 },
    channelCount: { type: "integer", minimum: 1, maximum: 2, description: "Session v2 bắt buộc 1." },
    bitsPerSample: { const: 16 },
    pcmByteLength: { type: "integer", minimum: 1, description: "Chia hết cho channelCount × 2." },
    chunkCount: { type: "integer", minimum: 1 },
  },
  ["sampleRate", "channelCount", "bitsPerSample", "pcmByteLength"],
  { description: "Mô tả PCM 16-bit đã upload để server ghép thành WAV." },
);

const UPLOAD_ERRORS: OpenApiObject = {
  ...AUDIO_SESSION_AUTH_ERRORS,
  "404": errorResponse("Không có session (`AUDIO_SESSION_INVALID`)."),
  "413": errorResponse("Vượt giới hạn chunk/session (`AUDIO_UPLOAD_LIMIT`). Mặc định 1 MiB/chunk, 16 MiB/session, 1000 chunk."),
  "429": errorResponse("Quá 180 request/phút cho session (`RATE_LIMITED`).", RETRY_AFTER),
};

export const audioSessionPaths: OpenApiObject = {
  "/api/audio-sessions": {
    post: {
      tags: [TAG],
      summary: "Mở phiên upload audio theo chunk",
      description:
        "Gửi `protocolVersion: 2` để nhận `uploadToken` (Bearer cho các API chunk/finalize/preview/prepare). Không có body = giao thức cũ v1 (production từ chối với 426). Giới hạn 30 lần/phút/IP.",
      operationId: "createAudioSession",
      security: INSTALLATION_SECURITY,
      requestBody: jsonBody(
        object({
          protocolVersion: { const: 2 },
          clientId: str(undefined, { pattern: "^(ios|android|web)_[A-Za-z0-9._:-]{8,180}$" }),
          audio: object({
            encoding: { ...enumOf(["pcm_s16le", "encoded_audio"]), default: "pcm_s16le" },
            requestedSampleRate: { type: "integer", minimum: 8000, maximum: 96000, default: 24000 },
            channelCount: { const: 1 },
            bitsPerSample: { const: 16 },
            sourceChunkDurationMs: { type: "integer", minimum: 50, maximum: 2000, default: 200 },
            maxDurationMs: { type: "integer", minimum: 450, maximum: 60000, default: 12000 },
          }),
        }),
        false,
        { protocolVersion: 2, clientId: "android_6f1c2a9e-4b7d-4f0a", audio: { encoding: "pcm_s16le", requestedSampleRate: 24000 } },
      ),
      responses: {
        "200": jsonResponse(
          "Session đã mở.",
          object(
            {
              audioSessionId: str("Tiền tố `audio_v2-`, `audio_v2-r2-`, `audio_` hoặc `audio_r2-`."),
              uploadToken: str("Chỉ có với v2."),
              expiresAt: str(undefined, { format: "date-time" }),
              capabilities: object({
                pcm16WavFinalize: bool(),
                chunkChecksumSha256: bool(),
                missingChunkRecovery: bool(),
                batchPrefetch: bool(),
                scopedUploadToken: bool(),
                uploadProtocolVersion: { type: "integer", enum: [1, 2] },
                chunkStorageBackend: enumOf(["local", "postgres", "r2"]),
                sessionTtlSeconds: int(),
              }),
            },
            ["audioSessionId", "capabilities"],
          ),
        ),
        "400": errorResponse("Cấu hình audio không hợp lệ (`BAD_REQUEST`)."),
        ...INSTALL_AUTH_ERRORS,
        "426": errorResponse("Server yêu cầu giao thức v2 (`AUDIO_SESSION_UNAUTHORIZED`)."),
        "429": errorResponse("Quá nhiều session mới (`RATE_LIMITED`).", RETRY_AFTER),
      },
    },
  },
  "/api/audio-sessions/{audioSessionId}/chunks": {
    parameters: [sessionIdParam],
    post: {
      tags: [TAG],
      summary: "Upload một chunk audio",
      description: "Gửi lại cùng chunk là an toàn (`duplicate=true`). Session v2 bắt buộc `Idempotency-Key` và `X-Chunk-SHA256`.",
      operationId: "uploadAudioChunk",
      security: AUDIO_SESSION_SECURITY,
      parameters: [
        headerParam("Idempotency-Key", "Đúng dạng `chunk:{audioSessionId}:{sequence}`."),
        headerParam("X-Chunk-SHA256", "SHA-256 hex của chunk.", false, { type: "string", pattern: "^[a-f0-9]{64}$" }),
      ],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: object(
              {
                audio: str("Bytes của chunk.", { format: "binary" }),
                sequence: { type: "integer", minimum: 0, description: "Số thứ tự chunk, bắt đầu từ 0." },
              },
              ["audio", "sequence"],
            ),
          },
        },
      },
      responses: {
        "200": jsonResponse(
          "Đã lưu chunk.",
          object(
            { uploaded: { const: true }, sequence: int(), duplicate: bool(), sha256: str(), totalBytes: int(), chunkCount: int() },
            ["uploaded", "sequence", "duplicate", "sha256", "totalBytes", "chunkCount"],
          ),
        ),
        "400": errorResponse(
          "Chunk rỗng, sequence sai, thiếu/sai Idempotency-Key hoặc checksum (`AUDIO_SESSION_INVALID`, `AUDIO_CHUNK_IDEMPOTENCY_INVALID`, `AUDIO_CHUNK_CHECKSUM_INVALID`, `AUDIO_CHUNK_CHECKSUM_MISMATCH`).",
        ),
        "409": errorResponse("Chunk khác nội dung đã có, hoặc session đang/đã finalize (`AUDIO_CHUNK_CONFLICT`, `AUDIO_SESSION_INVALID`)."),
        ...UPLOAD_ERRORS,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Huỷ session (bé bấm huỷ)",
      operationId: "discardAudioSession",
      security: AUDIO_SESSION_SECURITY,
      parameters: [headerParam("X-Discard-Reason", "Lý do để log, `[a-z0-9_]{1,40}`.")],
      responses: {
        "200": jsonResponse("Đã huỷ.", object({ discarded: { const: true } }, ["discarded"])),
        ...UPLOAD_ERRORS,
      },
    },
  },
  "/api/audio-sessions/{audioSessionId}/finalize": {
    post: {
      tags: [TAG],
      summary: "Kết thúc session và dịch",
      description:
        "Ghép các chunk, nhận dạng, dịch và tạo TTS. Gửi lại cùng body sau khi xong trả lại kết quả cũ. Truyền `prefetchId` từ `/preview` để dùng lại bản dịch đã chuẩn bị.",
      operationId: "finalizeAudioSession",
      security: AUDIO_SESSION_SECURITY,
      parameters: [sessionIdParam],
      requestBody: jsonBody(
        object(
          {
            clientId: str(),
            context: enumOf(CONTEXTS),
            childAge: { type: "number", default: 6 },
            targetLanguage: { ...enumOf(TARGET_LANGUAGES), default: "en" },
            sessionId: str(),
            asrMode: enumOf(["batch_chunks", "browser_streaming"]),
            sourceText: str("Chỉ dùng với `browser_streaming`."),
            mimeType: {
              ...enumOf(["audio/aac", "audio/mp4", "audio/m4a", "audio/wav", "audio/wave", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/webm"]),
              default: "audio/webm",
            },
            pcm16Wav,
            prefetchId: str(),
            benchmark: ref("BenchmarkMetadata"),
          },
          ["context"],
        ),
        true,
        {
          context: "home",
          targetLanguage: "en",
          mimeType: "audio/wav",
          pcm16Wav: { sampleRate: 24000, channelCount: 1, bitsPerSample: 16, pcmByteLength: 288000, chunkCount: 30 },
        },
      ),
      responses: {
        "200": jsonResponse("Kết quả dịch.", {
          allOf: [ref("ConversationResponse"), object({ learning: { type: "null" } })],
        }),
        "400": errorResponse("Body/metadata PCM không hợp lệ (`BAD_REQUEST`, `AUDIO_SESSION_INVALID`)."),
        "409": errorResponse(
          "Thiếu chunk (`AUDIO_CHUNKS_MISSING`, `details.missingSequences`), body khác lần trước (`AUDIO_SESSION_INVALID`) hoặc đang finalize (`RATE_LIMITED`).",
        ),
        "415": errorResponse("mimeType không hỗ trợ (`AUDIO_SESSION_INVALID`)."),
        ...UPLOAD_ERRORS,
        "502": errorResponse("Lỗi ASR / dịch / TTS (`ASR_FAILED`, `LLM_FAILED`, `TTS_FAILED`)."),
      },
    },
  },
  "/api/audio-sessions/{audioSessionId}/preview": {
    post: {
      tags: [TAG],
      summary: "Dịch thử từ các chunk đã có",
      description: "Gọi trong lúc bé đang nói để dịch sớm. Khi `eligible=true`, gửi `prefetchId` vào finalize.",
      operationId: "previewAudioSession",
      security: AUDIO_SESSION_SECURITY,
      parameters: [sessionIdParam],
      requestBody: jsonBody(
        object(
          {
            context: enumOf(CONTEXTS),
            pcm16Wav,
            clientId: str(),
            childAge: { type: "number", default: 6 },
            terminal: bool("`true` khi đây là snapshot cuối."),
            previousPrefetchId: str(),
            benchmark: ref("BenchmarkMetadata"),
          },
          ["context", "pcm16Wav"],
        ),
      ),
      responses: {
        "200": jsonResponse("Kết quả dịch thử.", {
          oneOf: [
            object(
              {
                eligible: { const: false },
                reason: enumOf(["audio_too_short", "prefetch_throttled", "speculative_translation_fallback", "unsafe_text_source"]),
                asrLatencyMs: num(),
                translationLatencyMs: num(),
              },
              ["eligible", "reason"],
            ),
            object(
              {
                eligible: { const: true },
                prefetchId: str(),
                stabilityCount: int(),
                sourceText: str(),
                englishText: str(),
                textSource: enumOf(TEXT_SOURCES),
                audioUrl: str(),
                audioSource: enumOf(["cache", "cloudflare_tts", "deepinfra_tts", "google_tts"]),
                snapshotChunkCount: int(),
                terminalSnapshot: bool(),
                asrLatencyMs: num(),
                translationLatencyMs: num(),
                previewLatencyMs: num(),
              },
              ["eligible", "prefetchId", "sourceText", "englishText", "textSource", "audioUrl", "audioSource"],
            ),
          ],
        }),
        "400": errorResponse("Thiếu context / pcm16Wav (`BAD_REQUEST`)."),
        ...AUDIO_SESSION_AUTH_ERRORS,
      },
    },
  },
  "/api/realtime/transcription-session": {
    post: {
      tags: [TAG],
      summary: "Phiên ASR realtime (đã tắt)",
      operationId: "createRealtimeTranscriptionSession",
      deprecated: true,
      responses: {
        "410": errorResponse("Chế độ này đã tắt (`ASR_MODE_DISABLED`)."),
      },
    },
  },
};
