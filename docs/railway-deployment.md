# Triển khai backend lên Railway

Backend chạy bằng image Node 22 Alpine, giữ database Neon hiện có. Các file triển khai đã có trong repository; tài khoản Railway vẫn cần được cấp dịch vụ và điền Variables thực tế. Hướng dẫn này không có nghĩa dịch vụ đã được deploy hay provider thật đã được kiểm chứng.

## 1. Web service và cấu hình bắt buộc

Tạo web service từ repository, chọn đúng thư mục chứa `package.json`. Dùng `railway.json` ở root: build `Dockerfile`, start `node infra/docker/start.mjs`, healthcheck `/api/ready`, timeout 120 giây, restart khi lỗi, một replica tại Singapore. Không đổi start command của image standalone thành `npm start`.

Copy các tên biến trong `.env.railway.example` vào Railway Variables và điền giá trị cần dùng. Không commit file đã điền credential.

| Thiết lập | Yêu cầu |
| --- | --- |
| `APP_RUNTIME` | `railway` |
| `DATABASE_URL` | URL database Neon, hostname kết thúc bằng `.neon.tech` |
| `PERSISTENCE_BACKEND` | `postgres` |
| `AUDIO_STORAGE_BACKEND` | Bắt đầu với `postgres`; có thể dùng `cloudinary`, `r2`, `vercel-blob` khi đủ credential |
| `AUDIO_SESSION_CHUNK_STORAGE_BACKEND` | `postgres`, hoặc `r2` khi đã có bucket private |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Credential quản trị mạnh, cung cấp qua Variables |
| `INSTALLATION_AUTH_SECRET` | Secret ngẫu nhiên ít nhất 32 ký tự; giữ ổn định giữa deploy, replica và worker |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_AI_API_TOKEN` | Bắt buộc cho pipeline web ASR/text/TTS; account ID gồm 32 ký tự hex |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Bắt buộc cho bản ghi giọng người dùng private; độc lập với generated TTS |
| `PWA_ALLOWED_ORIGINS` | Để trống nếu cùng origin; nếu khác origin, dùng danh sách origin HTTPS ngăn cách bằng dấu phẩy, không chứa path |
| `PORT`, `HOSTNAME` | Railway cấp `PORT`; startup bind `0.0.0.0`, không cố định host localhost |

Implementation database hiện dùng `neon()` qua HTTP. Không thay trực tiếp `DATABASE_URL` bằng Railway PostgreSQL TCP; muốn chuyển database cần đổi driver hoặc lớp proxy tương thích và kiểm tra migration/query. Không có nhu cầu chuyển database chỉ để chạy backend trên Railway.

Với generated TTS Cloudinary, bổ sung `CLOUDINARY_TTS_CLOUD_NAME`, `CLOUDINARY_TTS_API_KEY`, `CLOUDINARY_TTS_API_SECRET`. Với Blob, dùng `GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN` hoặc `BLOB_READ_WRITE_TOKEN`. Các file audio và records production không dùng local filesystem của container.

## 2. Xác thực và tương thích client

Production luôn bật installation authentication và scoped audio upload, kể cả khi `INSTALLATION_AUTH_REQUIRED=false` hoặc `AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN=false`. Không dùng hai flag này để mở lại quyền truy cập chỉ bằng `clientId`.

Client Flutter hoặc client ngoài repository cần hỗ trợ:

1. Đăng ký `POST /api/installations/register` bằng `clientId`, `platform` và installation secret của thiết bị; gửi installation access token dạng `Authorization: Bearer ...` khi gọi API thiết bị. Refresh/revoke vẫn dùng contract hiện có.
2. Tạo audio session với `protocolVersion: 2`, owner và cấu hình audio. Lưu `uploadToken` nhận được.
3. Gửi upload token khi upload chunk, preview/finalize và discard; chunk kèm `Idempotency-Key: chunk:<audioSessionId>:<sequence>` và `X-Chunk-SHA256` đúng nội dung.

Session upload legacy không được chấp nhận trong production. Nên phát hành client tương thích trước khi chuyển traffic. Browser practice/recorder/admin audio check trong repository đã được nối qua helper xác thực; helper giữ bearer token trong memory, giữ identity thiết bị để đăng ký lại, và không ghi đè upload token. Các API admin tổng thể vẫn dùng cookie quản trị.

`AUDIO_UPLOAD_TOKEN_SECRET` là tùy chọn; nếu bỏ trống, production suy ra một signing key riêng từ `INSTALLATION_AUTH_SECRET`. Nếu khai báo thì phải ít nhất 32 ký tự. Thay secret làm mất hiệu lực token liên quan; không tạo secret ngẫu nhiên mới mỗi lần start.

## 3. Pool, cache và async jobs là các tính năng tùy chọn

Lần đầu có thể giữ cả ba flag `CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED`, `AUDIO_TRANSLATION_CACHE_ENABLED`, `AUDIO_TRANSLATION_JOBS_ENABLED` bằng `false`. Redis không bắt buộc khi các tính năng đó tắt.

Khi bật pool, đặt `CLOUDFLARE_POOL_STORE=redis`, registry `CLOUDFLARE_ACCOUNTS_JSON` hợp lệ và đủ token env được registry tham chiếu. Tham khảo [runbook pool](cloudflare-multi-account-runbook.md). Không bật `CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST` trên Railway. Chỉ bật shared legacy quota khi registry và capability đáp ứng cấu hình tương ứng.

| Khi bật | Phụ thuộc |
| --- | --- |
| Pool | `CLOUDFLARE_POOL_REDIS_URL`, quota Redis có persistence và `noeviction` |
| Cache | Pool và `AUDIO_TRANSLATION_CACHE_REDIS_URL`, Redis cache riêng; có thể dùng eviction |
| Jobs | Pool, `AUDIO_TRANSLATION_JOBS_REDIS_URL`, jobs Redis có persistence/`noeviction`, worker và kho R2 chung |

Cả ba cùng bật cần **ba Redis instance riêng**. Khác database index nhưng cùng hostname/cổng vẫn bị từ chối. Dùng URL do các service cấp qua Variables/private networking; Railway mode giữ nguyên host, password, TLS và database index, không đổi sang hostname của Compose.

Để bật jobs, tạo thêm worker service dùng cùng repository và đặt **Config File Path là `/railway.worker.json`**. File này chọn `Dockerfile.worker`, start `node --import tsx infra/docker/start.mjs worker`; worker không có HTTP healthcheck hay public domain. Không chạy worker bằng image web.

Web và worker dùng cùng pool config, namespace quota, `AUDIO_TRANSLATION_JOB_NAMESPACE`, jobs Redis và bucket private R2. Cả hai đặt `AUDIO_TRANSLATION_JOBS_ENABLED=true`, `AUDIO_TRANSLATION_JOB_STORAGE=r2`; cấp `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_BUCKET`. Không dùng cùng đường dẫn local để giả lập chia sẻ file giữa các service.

Tạo lifecycle phù hợp cho prefix `audio-translation-jobs/` để xóa object mồ côi sau thời gian giữ an toàn, ví dụ một ngày. Với chunks R2, áp dụng tương tự cho `audio-sessions/`. Implementation hiện dùng một biến bucket: startup từ chối kết hợp generated TTS R2 public với jobs/chunks R2 private. Giữ generated TTS ở PostgreSQL/Cloudinary khi bucket phục vụ jobs/chunks; nếu dùng generated TTS R2, đặt chunks ở PostgreSQL và tắt jobs. Bucket archive cũng phải khác bucket public TTS. Không mở public bucket chứa giọng người dùng.

## 4. Kiểm tra trước và sau deploy

Chạy từ checkout sạch với Node tương thích, không lấy credential production để chạy test:

```text
npm ci
npm run lint
npm test
npm run test:integration
npm run build
```

`npm test` chạy bộ test được discover tự động. Test tích hợp cần hạ tầng test riêng; `npm run test:integration` dựng Redis/PostgreSQL dùng một lần bằng Docker và dọn chúng sau khi chạy. Không dùng URL Redis/database production làm biến test. Kết quả toàn bộ test và Linux image phải lấy từ log của lần chạy thực tế, không suy ra từ tài liệu này.

Nếu đã đưa Variables vào process, chạy `npm run check:deployment`. Lệnh này build parser runtime rồi kiểm tra cấu hình; nó không chứng minh provider/network hoạt động. Cũng có thể dùng file staging riêng, đã được gitignore:

```text
npm run build:runtime
node --env-file=.env.staging.local infra/docker/start.mjs check
```

Database mới cần có schema trước khi nhận traffic. Công cụ storage hiện có có thể chạy với credential **staging**:

```text
node --env-file=.env.staging.local --import tsx scripts/check-storage.ts
```

Lệnh storage có thể tạo/cập nhật schema idempotent và truy cập các storage đã bật; cần quyền DDL và backup trước khi áp dụng trên database có dữ liệu. Không coi đây là test thuần đọc. `/api/ready` không tự migration schema.

- `/api/health`: liveness, trả 200 khi HTTP server hoạt động, không chứng minh phụ thuộc sẵn sàng.
- `/api/ready`: trả 200 khi database truy cập được và có bốn bảng cốt lõi, Redis đã bật trả PONG, storage đã chọn đáp ứng kiểm tra. R2 probe kiểm tra bucket chính; không xác nhận bucket archive riêng. Nếu lỗi trả 503 và không công khai credential/địa chỉ nội bộ.
- Readiness giới hạn database bằng abort signal 3 giây, Redis connect/command 1 giây mỗi bước, R2 HeadBucket 2 giây; các bước độc lập chạy song song và kết quả được gom/cache 2 giây để giảm tạo kết nối.
- Cloudinary/Blob trong readiness mới kiểm tra **cấu hình**, không upload/xác minh credential với provider. Readiness không chạy AI inference, không xác nhận chất lượng dịch và không thay thế smoke worker/job.

Sau deploy staging, kiểm tra đăng ký → token → dịch audio → phát audio → history → admin; restart/redeploy phải giữ được records/audio. Nếu bật jobs, kiểm tra thêm enqueue/poll, ownership và worker restart với audio đọc từ R2. Chỉ nhận traffic production sau các bước này.

## 5. Compose, cron và rollback

Compose dùng `APP_RUNTIME=compose`, `APP_ENV_FILE=/run/secrets/app_env` và volume chung như file Compose hiện có. Startup đọc file trong `APP_ENV_FILE` trước; nếu không khai báo, chỉ đọc `/run/secrets/app_env` khi file tồn tại. Biến môi trường đã có trên process được ưu tiên hơn giá trị trong file. File được chỉ định nhưng không tồn tại hoặc lỗi đọc sẽ làm startup thất bại. Railway dùng Variables không cần secret mount hoặc `CLOUDFLARE_POOL_REDIS_PASSWORD`; chỉ Compose mode chuyển URL Redis sang tên service nội bộ. Local jobs trên shared volume chỉ được phép ở Compose mode rõ ràng.

`vercel.json` không tự tạo lịch Railway. Cleanup audio/data retention đã có timer Node và cleanup theo request. Archive riêng có thể lên lịch gọi `GET /api/internal/app-records/archive` với `Authorization: Bearer <CRON_SECRET>` sau khi cấp bucket private `APP_RECORDS_ARCHIVE_R2_BUCKET`, R2 credential và `CRON_SECRET` ít nhất 32 ký tự.

**Dừng toàn bộ deployment/cron cũ trước khi bật archive mới**: bản cũ có thể còn chạy chính sách xóa mọi namespace. Chính sách mới chỉ archive preparation hết hạn thuộc `conversation_preparations_v1`, tối đa 50 dòng mỗi lần; snapshot cũ không an toàn bị hủy khỏi hàng đợi mà không xóa records. Credential, history, profile và rules không thuộc diện archive. Không dùng archive này thay cho backup database.

Giữ nguyên `USER_AUDIO_RETENTION_DAYS`, `HISTORY_RETENTION_DAYS`, `DIAGNOSTIC_RETENTION_DAYS` và interval cleanup theo chính sách dữ liệu của môi trường. Thay đổi pool limits/namespace/registry phải áp dụng đồng nhất cho web và worker; không đổi namespace để bỏ qua quota hiện có.

Trước release, lưu commit/image đã kiểm tra, backup Neon và snapshot Variables. Khi rollback, dừng worker/cron mới trước, khôi phục image và cấu hình tương thích cùng nhau; không rollback archive sang bản có chính sách xóa mọi namespace. Không reset database hoặc xóa bucket để rollback application. Sau rollback kiểm tra lại `/api/ready`, token, history và audio; giữ secret ổn định nếu không có chủ đích thu hồi token.

Tài liệu nền tảng: [Dockerfile Railway](https://docs.railway.com/builds/dockerfiles), [Config as Code](https://docs.railway.com/config-as-code/reference), [Healthchecks](https://docs.railway.com/deployments/healthchecks), [Neon HTTP driver](https://neon.com/docs/serverless/serverless-driver).
