// OpenAPI 3.1 document served at /openapi.json and rendered by /docs (Swagger UI)
// and /redoc. Paths are hand-written from the route handlers under src/app/api;
// openapi.test.ts fails when a route file has no matching path here.

import { API_DOCS_TITLE } from "./docsHtml";
import type { OpenApiObject } from "./helpers";
import { adminPaths } from "./paths/admin";
import { audioPaths } from "./paths/audio";
import { audioSessionPaths } from "./paths/audioSessions";
import { conversationPaths } from "./paths/conversation";
import { installationPaths } from "./paths/installations";
import { internalPaths } from "./paths/internal";
import { listeningPaths } from "./paths/listening";
import { systemPaths } from "./paths/system";
import { componentSchemas } from "./schemas";

const DESCRIPTION = `Backend cho app luyện nói của HuaMei: bé nói tiếng Việt → nhận dạng → dịch (en/zh/ja/ko/fr) → đọc lại bằng TTS.

**Xác thực**
- **InstallationBearer**: app gọi \`POST /api/installations/register\` để lấy \`accessToken\` (15 phút) và \`refreshToken\` (90 ngày, dùng một lần). Gửi \`Authorization: Bearer <accessToken>\`.
- **AudioSessionToken**: \`uploadToken\` trả về từ \`POST /api/audio-sessions\` (giao thức v2), dùng cho chunk / finalize / preview / prepare.
- **AdminSession**: cookie \`ai-speaking-admin-session\` sau khi \`POST /api/admin/auth/login\`.
- **CronSecret**: \`Authorization: Bearer <CRON_SECRET>\` cho các job \`/api/internal/*\`.

**Quy ước chung**
- Mọi lỗi dùng \`ErrorEnvelope\`: \`{ "error": { "code", "message", "requestId?", "details?" } }\`. \`message\` là tiếng Việt, hiển thị được cho người dùng.
- Gửi \`X-Request-Id\` (8–100 ký tự \`[a-zA-Z0-9._:-]\`) để truy vết; server luôn trả lại header này.
- Trình duyệt khác origin phải nằm trong \`PWA_ALLOWED_ORIGINS\`, nếu không nhận 403 \`ORIGIN_NOT_ALLOWED\`.
- Ở môi trường dev (không bật \`INSTALLATION_AUTH_REQUIRED\`) có thể bỏ token và chỉ gửi \`clientId\` hợp lệ.`;

const TAGS = [
  { name: "System", description: "Health check, phiên bản app, dữ liệu offline." },
  { name: "Installations", description: "Đăng ký cài đặt, cấp / làm mới / thu hồi token, thông tin thiết bị." },
  { name: "Audio translation", description: "Gửi một file ghi âm và nhận bản dịch (đồng bộ hoặc dạng job)." },
  { name: "Audio sessions (chunk upload)", description: "Upload ghi âm theo từng chunk trong lúc bé nói, rồi finalize." },
  { name: "Conversation", description: "Luồng hội thoại: text/audio → bản dịch + TTS, chuẩn bị sớm từ transcript streaming." },
  { name: "Audio files", description: "Phát và tải file TTS đã tạo." },
  { name: "Listening practice", description: "Bài luyện nghe: chấm câu bé nói lại." },
  { name: "History", description: "Lịch sử lượt nói của thiết bị, ghi âm gốc của bé." },
  { name: "Admin", description: "Dashboard quản trị (cần cookie admin)." },
  { name: "Internal (cron)", description: "Job định kỳ, gọi bằng CRON_SECRET." },
];

export const openApiDocument: OpenApiObject = {
  openapi: "3.1.0",
  info: {
    title: API_DOCS_TITLE,
    version: "2026-11-16",
    description: DESCRIPTION,
  },
  servers: [
    { url: "/", description: "Server đang mở trang này" },
    { url: "https://api.hoamytech.com", description: "Production" },
    { url: "https://api-dev.hoamytech.com", description: "Dev" },
  ],
  tags: TAGS,
  paths: {
    ...systemPaths,
    ...installationPaths,
    ...audioPaths,
    ...audioSessionPaths,
    ...conversationPaths,
    ...listeningPaths,
    ...adminPaths,
    ...internalPaths,
  },
  components: {
    securitySchemes: {
      InstallationBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "homi_install_v1 opaque token",
        description: "`accessToken` từ register/refresh.",
      },
      AudioSessionToken: {
        type: "http",
        scheme: "bearer",
        description: "`uploadToken` từ `POST /api/audio-sessions` (v2).",
      },
      AdminSession: {
        type: "apiKey",
        in: "cookie",
        name: "ai-speaking-admin-session",
        description: "Đăng nhập qua `POST /api/admin/auth/login`; trình duyệt tự gửi cookie.",
      },
      CronSecret: {
        type: "http",
        scheme: "bearer",
        description: "Giá trị biến môi trường CRON_SECRET.",
      },
    },
    headers: {
      XRequestId: {
        description: "ID truy vết của request (lấy từ request hoặc server tạo).",
        schema: { type: "string" },
      },
      RetryAfter: {
        description: "Số giây nên chờ trước khi thử lại.",
        schema: { type: "integer" },
      },
    },
    schemas: componentSchemas,
  },
};
