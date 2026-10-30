# Tài liệu tích hợp REST API cho frontend Flutter

Ngày bàn giao: **29/10/2026**. Đối chiếu mã nguồn ứng dụng `82ec0be428b876d489eac7a6473020be4a525fd9` và checkpoint Railway cùng ngày.

Tài liệu này dành cho luồng **đăng ký installation → gửi file ghi âm → nhận văn bản tiếng Anh**. Bao gồm xác thực, dịch audio, jobs tùy chọn và kiểm tra tình trạng dịch vụ. API hội thoại, TTS, upload audio theo chunk và API quản trị nằm ngoài phạm vi bộ tài liệu này.

## 1. Bắt đầu ở đây

Base URL production:

```text
https://speaking-ai-nextjs-backend-production.up.railway.app
```

| Thành phần | Trạng thái tại checkpoint 29/10/2026 |
| --- | --- |
| Đăng ký installation, cấp/refresh token | Đã kiểm tra trên production |
| `POST /api/audio/translate` | Đang hoạt động; frontend sử dụng endpoint này |
| Pool và cache | Backend xử lý tự động; frontend không kết nối Redis |
| Worker jobs | Đã kiểm tra xử lý nội bộ |
| HTTP jobs: `POST /api/audio/jobs`, `GET /api/audio/jobs/{jobId}` | **Chưa bật trên web production. Chỉ tích hợp sau khi backend thông báo kích hoạt** |

Trạng thái triển khai là snapshot theo ngày, không phải cam kết endpoint jobs đã được bật ở các bản sau. `/api/ready` trả 200 cũng không chứng minh HTTP jobs đang bật.

Các file đi kèm:

- [OpenAPI 3.0.3](./openapi.json): import vào Swagger Editor, Postman hoặc công cụ sinh client.
- [Postman collection](./Speaking-AI-Frontend.postman_collection.json): request mẫu, lưu token từ response, upload multipart và polling thủ công.

Luồng tích hợp hiện tại:

1. Sinh và lưu credential installation riêng trên thiết bị.
2. Gọi register để lấy session.
3. Gửi audio với `Authorization: Bearer <accessToken>`.
4. Hiển thị `englishText` khi HTTP 200.
5. Refresh có điều phối khi token hết hạn; luôn lưu cả cặp token mới.

## 2. Quy ước chung

| Nội dung | Quy ước |
| --- | --- |
| Đường truyền | HTTPS |
| JSON request | `Content-Type: application/json` |
| Upload audio | `multipart/form-data`, field file tên **`audio`** |
| Xác thực request được bảo vệ | `Authorization: Bearer <accessToken>`; dùng đúng tiền tố `Bearer ` |
| Theo dõi lỗi | Response header `X-Request-Id`; lỗi ứng dụng thường có thêm `error.requestId` |
| Request ID do frontend gửi | Tùy chọn `X-Request-Id`, 8–100 ký tự `[A-Za-z0-9._:-]`; không hợp lệ thì backend tự sinh |
| Cookie/admin key | Không cần cho các API được bảo vệ bằng installation token trong tài liệu này |

Token là **chuỗi opaque có định dạng riêng của backend**, không phải JWT chuẩn. Không dùng JWT decoder để tự quyết định hạn token. Dùng `accessTokenExpiresAt` và `refreshTokenExpiresAt` trong response.

Các ví dụ token trong tài liệu đều là placeholder. Frontend không nhận hoặc nhúng `INSTALLATION_AUTH_SECRET`, Cloudflare API token, Redis URL, R2 secret hay mật khẩu admin.

## 3. Xác thực installation

Installation đại diện cho một bản cài/thiết bị của ứng dụng. Đây không phải luồng đăng nhập tài khoản người dùng bằng username/password.

### 3.1. POST `/api/installations/register`

Không yêu cầu Bearer token. Body JSON:

| Field | Bắt buộc | Ràng buộc |
| --- | --- | --- |
| `clientId` | Có | `^(ios\|android\|web)_[A-Za-z0-9._:-]{8,180}$`; tiền tố khớp `platform` |
| `platform` | Có | `android`, `ios` hoặc `web` |
| `installationSecret` | Có | Chuỗi ngẫu nhiên riêng của thiết bị, `[A-Za-z0-9_-]{32,180}`; nên sinh từ 32 byte ngẫu nhiên an toàn và mã hóa base64url không padding |
| `appVersion` | Không | Chuỗi phiên bản; backend trim và giữ tối đa 80 ký tự |

```json
{
  "clientId": "android_550e8400-e29b-41d4-a716-446655440000",
  "platform": "android",
  "installationSecret": "<thay-bang-base64url-ngau-nhien-cua-thiet-bi>",
  "appVersion": "1.0.0"
}
```

Placeholder `installationSecret` phải được thay trước khi gọi. Không dùng chung cặp credential mẫu cho nhiều thiết bị.

Response **201**, kể cả khi đăng ký lại cùng credential:

```json
{
  "clientId": "android_550e8400-e29b-41d4-a716-446655440000",
  "accessToken": "<opaque-access-token>",
  "accessTokenExpiresAt": "2026-10-29T06:00:00.000Z",
  "refreshToken": "<opaque-refresh-token>",
  "refreshTokenExpiresAt": "2027-01-27T05:00:00.000Z"
}
```

Thời điểm trong ví dụ chỉ minh họa; dùng chính expiry backend trả về. Response register có `X-Request-Id` trong header, **không có field `requestId` trong body session**.

Lưu `clientId`, `platform`, `installationSecret` ổn định trong secure storage. Gọi register ở bước khởi tạo/khôi phục phiên, không gọi trước mỗi lần upload. Đăng ký lại cùng ID + secret không xoay session hiện tại; cùng ID nhưng secret khác trả **409 `INSTALLATION_ALREADY_REGISTERED`**.

### 3.2. POST `/api/installations/refresh`

Không dùng access token trong header cho bước này. Body JSON:

```json
{ "refreshToken": "<refresh-token-hien-tai>" }
```

Response **200**, cùng cấu trúc session 5 field ở trên.

**Refresh xoay session và làm mất hiệu lực cả access token lẫn refresh token cũ ngay lập tức.**

- Chỉ cho phép một tác vụ refresh trên mỗi installation tại một thời điểm; các request đang đợi cùng dùng kết quả refresh đó.
- Lưu cả cặp token và expiry mới bằng một bản ghi JSON trong secure storage trước khi tiếp tục request.
- Nếu request A nhận 401 trong lúc request B đã refresh xong, A dùng token mới hiện có; không refresh tiếp chỉ vì 401 của token cũ.
- Sau 401, chỉ thử lại request được bảo vệ tối đa một lần sau khi xác thực lại. Tạo `FormData`/`MultipartFile` mới cho lần gửi lại.
- Nếu mất response refresh sau khi server đã xoay token, có thể khôi phục bằng register với **cùng** `clientId`/`platform`/`installationSecret` đã lưu. Không tạo ID mới để che lỗi phiên.

### 3.3. DELETE `/api/installations/revoke`

Yêu cầu Bearer access token, không có body. Response **200**:

```json
{ "revoked": true, "requestId": "550e8400-e29b-41d4-a716-446655440001" }
```

Thu hồi installation hiện tại; token đã cấp cho phiên đó sẽ không còn được chấp nhận. Xóa session token ở frontend sau khi logout. Endpoint này không phải API xóa lịch sử hội thoại.

## 4. Dịch audio đang sử dụng trên production

### POST `/api/audio/translate`

Yêu cầu Bearer access token. Body **multipart/form-data**:

| Field | Kiểu | Bắt buộc | Ý nghĩa |
| --- | --- | --- | --- |
| `audio` | File binary | Có | File audio hoàn chỉnh, không rỗng |
| `sourceLanguage` | Text | Không | Mặc định `vi` khi thiếu/rỗng; app nên gửi `vi`, `en` hoặc `zh` phù hợp audio |
| `clientId` | Text | Không | Có thể bỏ; nếu gửi phải khớp installation trong token |

`sourceLanguage` được trim và chuyển về chữ thường; cú pháp 2–3 chữ cái ASCII. Ví dụ `vi-VN` không hợp lệ. Ngôn ngữ đích của endpoint là **`en`**; không có tham số chọn ngôn ngữ đích trong contract này.

Giới hạn mặc định file: **10 MiB = 10.485.760 byte**. Giới hạn toàn bộ multipart mặc định là mức đó cộng 256 KiB overhead; cấu hình backend có thể thay đổi giới hạn. Các phần mở rộng được kiểm tra: AAC, FLAC, M4A, MP3, MP4, OGG, WAV, WebM. Gửi đúng MIME/filename và container hợp lệ; không gửi PCM thô với tên giả `.wav`.

Ví dụ cURL cho shell Bash, thay biến bằng token và đường dẫn file của installation thử nghiệm:

```bash
curl --request POST \
  'https://speaking-ai-nextjs-backend-production.up.railway.app/api/audio/translate' \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  --form 'sourceLanguage=vi' \
  --form 'audio=@/path/to/speech.wav;type=audio/wav'
```

Không tự đặt multipart boundary. Khi dùng Dio/Postman/cURL, để thư viện tạo header multipart tương ứng body.

Response **200**:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440002",
  "sourceLanguage": "vi",
  "targetLanguage": "en",
  "englishText": "The weather is nice today.",
  "sourceText": "Hôm nay thời tiết đẹp.",
  "model": "@cf/openai/whisper-large-v3-turbo",
  "textModel": "@cf/meta/llama-4-scout-17b-16e-instruct",
  "wordCount": 6,
  "timings": { "asrMs": 1200, "translationMs": 500 }
}
```

| Field response | Cách sử dụng |
| --- | --- |
| `englishText` | Văn bản tiếng Anh để hiển thị; field chính bắt buộc |
| `sourceLanguage`, `targetLanguage` | Ngôn ngữ nguồn đã chuẩn hóa và đích `en` |
| `model` | Metadata model ASR; không hardcode tên model để điều khiển UI |
| `sourceText` | Transcript nguồn, có thể hiển thị nếu tồn tại |
| `textModel` | Có thể không có, đặc biệt khi nguồn `en` không cần bước dịch văn bản |
| `wordCount`, `timings` | Metadata tùy chọn; frontend phải chấp nhận thiếu |
| `requestId` | Gửi cho backend khi cần truy vết lỗi/kết quả |

Không dựa vào `segments`/`vtt` để dựng phụ đề tiếng Anh: contract kiểu dữ liệu cho phép metadata tùy chọn nhưng pipeline hiện tại không trả timestamps của bản dịch tiếng Anh. Endpoint này trả **JSON text**, không trả audio TTS, URL MP3 hoặc streaming transcript.

Header `Cache-Control: private, no-store`. Header `X-Audio-Cache` có thể là `hit`, `miss`, `coalesced`, `disabled`. Đọc header này để chẩn đoán; không thay đổi luồng nghiệp vụ vì cache miss. Cache có phạm vi installation/ngôn ngữ/nội dung/chính sách model, frontend không truy cập Redis và không gửi cache key.

Timeout phía Flutter có thể đặt connect 15 giây, send 30 giây và receive 45 giây. Đây là giá trị client gợi ý, không phải SLA; mất mạng/timeout không chứng minh server chưa gọi AI. Không tự upload lại liên tục cùng một lượt ghi âm.

## 5. Async jobs — chuẩn bị cho lúc backend kích hoạt

**Chưa bật trên web production tại checkpoint này.** Một request đã xác thực và hợp lệ đến POST jobs hiện trả 404 `AUDIO_JOB_NOT_FOUND`. Request thiếu token/audio vẫn có thể bị từ chối trước khi đến kiểm tra feature flag.

### 5.1. POST `/api/audio/jobs`

Khi được bật, dùng cùng Bearer và multipart như endpoint dịch đồng bộ. Thêm:

```http
Idempotency-Key: audio-turn-550e8400-e29b-41d4-a716-446655440003
```

Backend cho phép bỏ header và sẽ tự sinh key, nhưng frontend **cần tự tạo và lưu key** để khôi phục an toàn sau sự cố kết nối. Key gồm 8–128 ký tự `[A-Za-z0-9._:-]`.

- Một key cho một lượt ghi âm; giữ cùng key, owner, audio và ngôn ngữ khi gửi lại cùng job.
- Cùng owner + key nhưng fingerprint audio/ngôn ngữ/chính sách model khác trả **409 `IDEMPOTENCY_CONFLICT`**.
- Đăng lại job đã tồn tại vẫn trả **202** với `status: queued`, kể cả job đã terminal. Dùng GET để đọc trạng thái thật.
- Dedupe chỉ có hiệu lực khi bản ghi job còn tồn tại. Bản ghi completed/failed có thể bị dọn theo tuổi/số lượng; không coi key là chống lặp vĩnh viễn. Sau 404/410, dừng tự POST lại cùng key: khi record không còn, key cũ có thể tạo job mới và gọi AI lại. Chỉ tạo lượt mới khi người dùng chủ động yêu cầu.
- `Idempotency-Key` không cung cấp durable idempotency cho request đồng bộ thông thường.

Response **202**:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440004",
  "jobId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "statusUrl": "/api/audio/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "nextPollMs": 2000,
  "status": "queued"
}
```

Headers: `Location` bằng `statusUrl`, `Retry-After: 2`, `Preference-Applied: respond-async`, `Cache-Control: private, no-store`.

### 5.2. GET `/api/audio/jobs/{jobId}`

Dùng **cùng installation owner** và Bearer access token còn hiệu lực. `jobId` gồm 64 ký tự hex chữ thường. Ghép `statusUrl` tương đối với base URL; không gửi Bearer token tới một origin khác.

| `status` | Xử lý frontend |
| --- | --- |
| `queued`, `running`, `retrying` | Tiếp tục poll theo `nextPollMs`, thường 2 giây; không tạo vòng lặp liên tục |
| `completed` | Dừng polling, đọc `result.englishText` |
| `failed` | Dừng polling, hiển thị `error.message`; không coi HTTP 200 là job thành công |

Response completed **HTTP 200**:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440005",
  "jobId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "completed",
  "createdAt": "2026-10-29T05:00:00.000Z",
  "startedAt": "2026-10-29T05:00:01.000Z",
  "completedAt": "2026-10-29T05:00:04.000Z",
  "result": {
    "sourceLanguage": "vi",
    "targetLanguage": "en",
    "sourceText": "Hôm nay thời tiết đẹp.",
    "englishText": "The weather is nice today.",
    "model": "@cf/openai/whisper-large-v3-turbo"
  }
}
```

Response failed cũng **HTTP 200**:

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440006",
  "jobId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "failed",
  "createdAt": "2026-10-29T05:00:00.000Z",
  "error": {
    "code": "AUDIO_JOB_FAILED",
    "message": "Không thể hoàn tất bản dịch. Vui lòng gửi lại audio nếu cần."
  }
}
```

Job chưa terminal hết thời hạn public sau 15 phút từ enqueue; job terminal hết thời hạn public sau một giờ từ lúc kết thúc. Sau đó có thể nhận 410; job đã bị dọn hoặc không tồn tại trả 404. Không dùng endpoint này làm kho lịch sử lâu dài. Owner khác cũng nhận 404 để không tiết lộ sự tồn tại của job.

Chưa có endpoint cancel job. Ngừng polling hoặc đóng màn hình không hủy job đã được chấp nhận. Lưu `jobId`/key nếu muốn tiếp tục theo dõi cùng installation khi mở lại màn hình.

### 5.3. `Prefer: respond-async` trên `/api/audio/translate`

Đây là khả năng **chấp nhận handoff khi bận**, không ép mọi request vào queue:

- Jobs chưa bật: header bị bỏ qua, endpoint vẫn xử lý đồng bộ.
- Jobs đã bật: có thể trả 200 từ xử lý đồng bộ/cache, hoặc 202 khi handoff phù hợp/đã có job cùng key.
- Khi dùng tùy chọn này, frontend phải xử lý cả 200 và 202.
- Muốn ép enqueue sau khi feature được bật, dùng POST `/api/audio/jobs`.

## 6. Lỗi và chính sách gửi lại

Envelope lỗi ứng dụng:

```json
{
  "error": {
    "code": "ASR_LOW_CONFIDENCE",
    "message": "Không nghe rõ lời nói trong audio. Vui lòng ghi âm lại.",
    "requestId": "550e8400-e29b-41d4-a716-446655440007",
    "details": { "provider": "cloudflare", "reason": "empty_transcript" }
  }
}
```

`details` tùy chọn và có thể thay đổi; dùng HTTP status + `error.code` để phân nhánh, không match chuỗi message. Gateway/network có thể không trả JSON; xử lý lỗi transport riêng.

| HTTP | Code tiêu biểu | Hành động |
| --- | --- | --- |
| 400 | `BAD_REQUEST`, `AUDIO_TOO_SHORT` | Sửa request; file thiếu/rỗng không phải lỗi 422 |
| 401 | `UNAUTHORIZED` | Điều phối refresh/khôi phục phiên; thử lại tối đa một lần |
| 403 | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED` | Kiểm tra claimed clientId hoặc origin Web được backend cho phép |
| 404 | `DEVICE_NOT_REGISTERED`, `AUDIO_JOB_NOT_FOUND` | Khôi phục installation đúng credential, hoặc kiểm tra feature/job/owner tùy endpoint |
| 409 | `INSTALLATION_ALREADY_REGISTERED`, `IDEMPOTENCY_CONFLICT`, đôi khi `BAD_REQUEST` | Không ghi đè credential của owner khác; không đổi payload dưới cùng key |
| 410 | `AUDIO_JOB_EXPIRED` | Dừng poll, thông báo kết quả đã hết hạn |
| 413 | `AUDIO_TOO_LONG` | Giảm dung lượng file |
| 415 | `BAD_REQUEST` | Sửa Content-Type hoặc định dạng file |
| 422 | `ASR_LOW_CONFIDENCE` | Hướng dẫn ghi âm rõ hơn; không tự lặp lại cùng audio |
| 429 | `RATE_LIMITED`, `ASR_FAILED`, `LLM_FAILED` | Đọc `Retry-After` (giây), giảm tốc độ gửi, cho phép thử lại có kiểm soát |
| 499 | `ASR_FAILED`, `LLM_FAILED` | Yêu cầu bị hủy; phân biệt với lỗi input |
| 500 | Có thể là `BAD_REQUEST`, `ASR_FAILED` | Lỗi máy chủ; không mặc định mọi `BAD_REQUEST` đều là HTTP 400 |
| 502 | `ASR_FAILED`, `LLM_FAILED` | Lỗi kết nối/response dịch vụ AI; báo lỗi kèm requestId |
| 503 | `AUTH_CONFIGURATION_ERROR`, `AUDIO_JOB_UNAVAILABLE`, `ASR_FAILED`, `LLM_FAILED` | Dịch vụ/cấu hình tạm chưa sẵn sàng; báo backend |
| 504 | `ASR_FAILED`, `LLM_FAILED` | Hết thời gian xử lý; không tự upload lại vô hạn |

Không coi `X-Request-Id` là khóa chống lặp. Với job đã nhận 202, ưu tiên tiếp tục GET; không POST lại mỗi vòng polling. Backend có bảo vệ checkpoint nhưng frontend không nên suy diễn rằng mọi timeout đều an toàn để gửi lại.

## 7. Flutter/Dio tham khảo

Cài package phù hợp Flutter SDK của project:

```bash
flutter pub add dio flutter_secure_storage
```

Khởi tạo Flutter binding trước khi dùng secure storage. Đặt quyền Android Internet trong `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Mẫu gọi HTTP; lớp quản lý phiên của app chịu trách nhiệm lưu identity/session và singleflight refresh theo mục 3:

```dart
import 'dart:typed_data';
import 'package:dio/dio.dart';

final dio = Dio(BaseOptions(
  baseUrl: 'https://speaking-ai-nextjs-backend-production.up.railway.app',
  connectTimeout: const Duration(seconds: 15),
  sendTimeout: const Duration(seconds: 30),
  receiveTimeout: const Duration(seconds: 45),
));

Future<Map<String, dynamic>> registerInstallation({
  required String clientId,
  required String installationSecret,
  required String platform,
}) async {
  final response = await dio.post<Map<String, dynamic>>(
    '/api/installations/register',
    data: {
      'clientId': clientId,
      'platform': platform,
      'installationSecret': installationSecret,
    },
  );
  return response.data!;
}

Future<Map<String, dynamic>> refreshSession(String refreshToken) async {
  final response = await dio.post<Map<String, dynamic>>(
    '/api/installations/refresh',
    data: {'refreshToken': refreshToken},
  );
  return response.data!; // Lưu cả hai token mới trước khi tiếp tục.
}

Future<Map<String, dynamic>> translateAudio({
  required Uint8List bytes,
  required String accessToken,
  String sourceLanguage = 'vi',
  String filename = 'speech.wav',
  String mimeType = 'audio/wav',
}) async {
  final form = FormData.fromMap({
    'sourceLanguage': sourceLanguage,
    'audio': MultipartFile.fromBytes(
      bytes,
      filename: filename,
      contentType: DioMediaType.parse(mimeType),
    ),
  });
  final response = await dio.post<Map<String, dynamic>>(
    '/api/audio/translate',
    data: form,
    options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
  );
  return response.data!;
}
```

Mẫu này không tự retry upload hoặc refresh. Bắt `DioException`, đọc `response?.statusCode`, `response?.data` và `response?.headers.value('x-request-id')`. Với M4A, dùng filename `.m4a` và MIME phù hợp container, ví dụ `audio/mp4`.

Sinh identity bằng CSPRNG của Dart và chỉ tạo khi thiết bị chưa lưu credential:

```dart
import 'dart:convert';
import 'dart:math';

String randomBase64Url(int byteCount) {
  final random = Random.secure();
  return base64UrlEncode(
    List<int>.generate(byteCount, (_) => random.nextInt(256)),
  ).replaceAll('=', '');
}

// Chỉ chạy cho installation mới rồi lưu ổn định:
final clientId = 'android_${randomBase64Url(18)}';
final installationSecret = randomBase64Url(32);
```

Session mới nên được lưu thành một JSON bằng `FlutterSecureStorage.write(...)`. Không log Authorization, installationSecret hoặc refreshToken bằng interceptor.

## 8. Flutter Web và CORS

Flutter Android/iOS native không chịu cơ chế CORS của browser. Flutter Web phải dùng origin đã được backend cấu hình trong `PWA_ALLOWED_ORIGINS`; origin bao gồm scheme + host + port. Startup Railway hiện chỉ chấp nhận origin **HTTPS**.

Khi gọi Railway production, thống nhất một origin HTTPS, ví dụ `https://app-dev.example.com`, để backend thêm vào allowlist. Localhost HTTP chỉ dành cho backend chạy chế độ development; không thêm `http://localhost:5173` vào cấu hình Railway hiện tại vì startup validation sẽ từ chối. Nếu origin không được phép, API có thể trả 403 `ORIGIN_NOT_ALLOWED` hoặc browser không cho frontend đọc response.

Preflight OPTIONS hợp lệ trả 204. Các header frontend có thể đọc gồm `X-Request-Id`, `X-Audio-Cache`, `Retry-After`, `Location`, `Preference-Applied`. Không cần cookie hoặc `withCredentials` cho luồng Bearer trong tài liệu này.

## 9. Kiểm tra health/readiness

- `GET /api/health`, không token: HTTP 200 với `status: ok`, `service`, `checkedAt`, `instance`; kiểm tra tiến trình còn sống.
- `GET /api/ready`, không token: HTTP 200 `{ "status": "ready" }` hoặc HTTP 503 `{ "status": "unavailable" }`; không có error envelope ở response readiness 503.

Readiness không chứng minh token provider còn entitlement, chất lượng dịch, worker heartbeat hoặc tính năng HTTP jobs đã được bật. Không gọi health liên tục theo từng audio frame.

## 10. Dùng Postman collection

1. Import `Speaking-AI-Frontend.postman_collection.json` bằng Postman/runtime có hỗ trợ `pm.execution.skipRequest()`. Các guard credential/feature/path dùng API này để bỏ qua request không hợp lệ; runner cũ thiếu API này nằm ngoài phạm vi kiểm tra bộ bàn giao.
2. Dùng **collection variables** cho bộ ví dụ này; tránh environment variables cùng tên che giá trị token được script cập nhật.
3. Điền `platform`, `client_id`, `installation_secret`. Đây là credential của installation test riêng, không phải secret trên Railway.
4. Gửi **01 - Register installation**. Script lưu cả token/expiry vào collection variables khi response 201 hợp lệ.
5. Ở **03 - Translate audio**, chọn file trong Body → form-data → `audio`. Gửi request; mong đợi 200 và `englishText`.
6. **02 - Refresh session** thay cả cặp token trong collection; không gửi nhiều request refresh song song.
7. Folder jobs được ghi rõ **OFF tại checkpoint**. Chỉ dùng sau thông báo backend; khi đó đặt collection variable `jobs_enabled=true` và điền `idempotency_key` ổn định cho lượt ghi âm. Sau enqueue 202, script lưu `job_id` và `status_url`; bấm Poll cách khoảng hai giây, không tự tạo vòng lặp vô hạn.
8. **90 - Revoke own installation** chỉ gửi khi muốn logout installation thử nghiệm; script xóa session token trong collection khi thu hồi thành công.

Các biến nhạy cảm trong file bàn giao để trống. Nếu export/share lại collection sau khi chạy, xóa token và installation_secret khỏi bản export. Không chạy cả collection bằng Runner một cách mù quáng: upload cần chọn file, jobs chưa bật và request revoke thu hồi session.

Dev có Node.js có thể tự sinh một cặp credential test ở máy mình (không gọi server):

```bash
node -e "const c=require('node:crypto');console.log(JSON.stringify({client_id:'android_'+c.randomUUID(),installation_secret:c.randomBytes(32).toString('base64url')}))"
```

## 11. Checklist nghiệm thu frontend

- [ ] Identity ổn định qua lần mở app; mỗi installation có secret riêng.
- [ ] Register 201, upload Bearer 200, hiển thị englishText.
- [ ] Không gửi được audio trước khi đăng ký; bỏ token nhận 401 với request hợp lệ.
- [ ] Refresh được điều phối; lưu cặp token mới; phục hồi được khi response refresh bị mất.
- [ ] File thiếu/rỗng, quá dung lượng, sai Content-Type và audio không rõ được phân biệt đúng.
- [ ] 429/timeout/cancel không gây vòng lặp upload hoặc nhiều lần bấm gửi cùng lượt.
- [ ] Dio tạo FormData mới cho từng lần gửi và ghép đúng MIME/filename.
- [ ] Ghi lại requestId khi báo lỗi; không ghi credential vào log.
- [ ] Flutter Web đã thống nhất origin; Android đã có quyền Internet.
- [ ] Chỉ bật UI jobs khi backend xác nhận hỗ trợ; xử lý đúng 200/202, failed HTTP200, 404/410 và ownership.

## Nguồn đối chiếu

Contract được đọc từ `src/lib/installationAuth.ts`, `src/lib/installationAuthCore.ts`, `src/lib/ai/audioTranslationRoute.ts`, `src/lib/ai/audioTranslationJobs.ts`, các route installation/audio/health/ready và `src/proxy.ts` tại commit nêu ở đầu tài liệu.

- [Dio và multipart](https://pub.dev/packages/dio)
- [MultipartFile.fromBytes / DioMediaType](https://pub.dev/documentation/dio/latest/dio/MultipartFile/MultipartFile.fromBytes.html)
- [Flutter Secure Storage](https://pub.dev/packages/flutter_secure_storage)
- [Quyền Internet và networking trong Flutter](https://docs.flutter.dev/cookbook/networking/send-data)
- [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html)
- [Postman collection variables](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables/)
