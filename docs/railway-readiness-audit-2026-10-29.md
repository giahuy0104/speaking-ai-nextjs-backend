# Kiểm tra khả năng triển khai Railway — 29/10/2026

> Đây là audit trước khi sửa. Các điểm chặn đã được xử lý trong lượt tiếp theo; xem [kết quả sửa và xác minh](railway-verification-2026-10-29.md) và [runbook triển khai](railway-deployment.md) để biết trạng thái hiện tại.

Mức sẵn sàng: **48/100 — Blocked**. Chưa sẵn sàng triển khai production nguyên trạng. Phần ứng dụng Next.js build và chạy được; đường khởi động Docker hiện tại phụ thuộc Docker Compose, cấu hình bảo vệ production chưa được khóa, và tác vụ archive có thể xóa dữ liệu đang sử dụng.

Phạm vi: trạng thái workspace hiện tại, gồm cả thay đổi chưa commit. Đây là điểm đánh giá kỹ thuật dựa trên bằng chứng bên dưới. Chưa triển khai lên Railway và chưa xác minh cấu hình trên tài khoản Railway.

## Kết quả đã chạy

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run lint` | Đạt, exit 0 |
| `npm run build` với standalone và thư mục build riêng | Đạt, bao gồm TypeScript và tạo các route |
| Build standalone với toàn bộ giá trị trong `.env.local` bị ghi đè thành rỗng ở process build | Đạt, exit 0; không sửa `.env.local` |
| Toàn bộ 62 file `*.test.ts` / `*.test.mjs` trong `src` và `scripts` | 372 test: 370 đạt, 0 lỗi, 2 bỏ qua |
| HTTP smoke trên standalone server, cấu hình production dùng credential giả | 8/8 đạt |
| `node infra/docker/start.mjs check` không có Compose secret mount | Lỗi `ENOENT` tại `/run/secrets/app_env`, tái hiện điểm chặn khởi động |
| Build/chạy Docker Linux thực tế | Chưa thực hiện: Docker daemon không hoạt động |

8 kiểm tra HTTP gồm health 200, admin redirect 307, admin API 401, history yêu cầu token 401, cron yêu cầu secret 401, Origin ngoài danh sách 403, CORS preflight hợp lệ 204 và request audio sai Content-Type 415. Các kiểm tra này không xác nhận kết nối provider thật hoặc độ chính xác dịch giọng nói.

Hai test bị bỏ qua là Redis admission integration và durable audio jobs integration. Chúng cần Redis riêng cho test qua `CLOUDFLARE_POOL_TEST_REDIS_URL` và `AUDIO_TRANSLATION_JOB_TEST_REDIS_URL`.

Máy kiểm tra dùng Node 24.11.1; Dockerfile dùng Node 22 Alpine. Lockfile khớp dependency khai báo trong `package.json`. Chưa xác minh `npm ci` và native dependency trên image Linux sạch.

## Các điểm cần xử lý trước production

### 1. P1 — Docker khởi động phụ thuộc Compose secret và tên Redis cố định

Nguồn: `Dockerfile:37`, `infra/docker/start.mjs:4`, `infra/docker/start.mjs:51`.

- CMD mặc định của image web chạy `infra/docker/start.mjs`.
- Script gọi `loadEnvFile("/run/secrets/app_env")` vô điều kiện. Với cách deploy repository lên Railway thông thường và cung cấp biến qua Variables, file này không có; process dừng trước khi mở cổng HTTP.
- Sau bước đọc secret, script bắt buộc có `CLOUDFLARE_POOL_REDIS_PASSWORD`, rồi ghi đè cả ba URL Redis bằng các host `redis`, `redis-cache`, `redis-jobs` tại cổng 6379. URL được cấp từ Railway Variables vì vậy không được giữ lại.
- Việc kiểm tra Redis vẫn áp dụng ngay cả khi tắt các tính năng pool/cache/jobs.

Hướng xử lý: hỗ trợ biến môi trường runtime do Railway cấp; chỉ đọc secret file khi được cấu hình và file tồn tại; giữ nguyên các Redis URL đã cung cấp và chỉ tạo URL Compose trong cấu hình Compose rõ ràng. Bind `0.0.0.0` và sử dụng `PORT` runtime.

Có thể dùng start command riêng `node server.js` cho image web để bỏ qua wrapper, nhưng khi đó cần tự kiểm tra toàn bộ cấu hình production mà wrapper đang kiểm tra. `npm start` cũng không phải start command phù hợp cho image standalone tối giản này.

Railway tự nhận Dockerfile và mặc định chạy CMD/ENTRYPOINT của image: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [Start Command](https://docs.railway.com/deployments/start-command).

### 2. P1 — Archive xóa mọi namespace, kể cả credential đang hoạt động

Nguồn: `src/lib/storage/appRecordsArchive.ts:24`, `src/lib/storage/appRecordsArchive.ts:75`, `src/lib/installationAuth.ts:19`, `src/lib/db/records.ts:76`, `vercel.json:4`.

Archive chọn 50 dòng cũ nhất của toàn bộ `app_records`, không lọc namespace và không có điều kiện hết hạn. Sau khi xác minh bản sao R2, nó xóa các dòng không bị thay đổi khỏi PostgreSQL.

`installation_auth` nằm trong cùng bảng. Xóa bản ghi installation đang hoạt động khiến việc xác minh access/refresh token không tìm thấy credential và từ chối thiết bị. Promoted rules, device profiles hoặc history còn cần dùng cũng có thể bị lấy đi. `getRecord` đọc trực tiếp PostgreSQL, không có cơ chế đọc bù từ archive R2.

Điểm này chỉ phát sinh khi archive được cấu hình đủ và được gọi; không đồng nghĩa dữ liệu đã bị xóa trong lần kiểm tra. File `vercel.json` hiện đặt lịch gọi mỗi 5 phút.

Hướng xử lý: giới hạn namespace có thể archive và mốc retention, loại trừ credential/config đang sử dụng; hoặc chỉ sao lưu mà không xóa. Kiểm chứng chức năng đọc lịch sử/credential sau archive trên database test trước khi bật lịch chạy.

### 3. P1 — Cần bắt buộc installation authentication trong môi trường public

Nguồn: `src/lib/installationAuth.ts:52`, `src/lib/installationAuth.ts:343`, `.env.example`.

`INSTALLATION_AUTH_REQUIRED` mặc định false. Không có bearer token, server vẫn chấp nhận `clientId` hợp lệ ở chế độ legacy. Các route như history sử dụng chính nhánh này để xác định quyền truy cập thiết bị.

`.env.example` đặt false; `.env.local` hiện không khai báo flag này. Có secret không tự động bật chế độ bắt buộc xác thực. Nếu mang cấu hình này lên môi trường public, biết `clientId` có thể đủ để đọc hoặc sửa dữ liệu thuộc thiết bị đó qua các route hỗ trợ legacy.

Trước production: đặt `INSTALLATION_AUTH_REQUIRED=true`, secret đủ mạnh và ổn định giữa các replica; xác minh ứng dụng client đã hỗ trợ đăng ký/refresh/access token. Với upload session, chuẩn bị `AUDIO_UPLOAD_TOKEN_SECRET` và chuyển sang scoped token sau khi client tương thích.

### 4. P1 nếu bật jobs — Cần worker và kho audio dùng chung giữa các service

Nguồn: `src/lib/ai/audioTranslationJobStorage.ts:10`, `src/lib/ai/audioTranslationJobStorage.ts:26`, `src/lib/ai/audioTranslationJobs.ts:21`, `Dockerfile:25`, `Dockerfile:32`.

- Backend lưu audio job ở local theo mặc định; production yêu cầu khai báo shared directory nếu dùng local.
- Compose gắn cùng volume vào web/worker. Hai Railway service không tự chia sẻ filesystem chỉ vì dùng cùng đường dẫn.
- Khuyến nghị `AUDIO_TRANSLATION_JOB_STORAGE=r2` với bucket private và lifecycle cho object mồ côi khi chạy web/worker riêng biệt.
- Image cuối cùng của Dockerfile là `web`. Source và trình chạy TS cho worker được copy vào stage `worker`; cần cấu hình build/image worker riêng. Chỉ đổi lệnh chạy của image web sang `npm run audio:worker` là chưa đủ.
- Cache Redis phải khác host:port với quota Redis. Jobs Redis phải khác host:port với cả quota và cache. Khác Redis database index trên cùng host:port vẫn bị code từ chối.
- Khi bật đủ pool/cache/jobs cần ba Redis instance riêng; quota và jobs nên có persistence, `noeviction`; cache có thể dùng eviction. Cấu hình trong `infra/redis/` hiện phục vụ Compose, cần áp dụng tương ứng cho dịch vụ Railway.

Jobs đang tắt trong cấu hình local được kiểm tra; có thể giữ tắt trong lần deploy staging đầu tiên. Pool đang bật nên vẫn cần quota Redis; cache đang bật nên cần cache Redis riêng hoặc tắt cache rõ ràng.

Railway có các giới hạn riêng cho volume và replica: [Volumes](https://docs.railway.com/volumes/reference). Thiết lập worker/queue tham khảo [Next.js với background jobs](https://docs.railway.com/guides/fullstack-nextjs).

### 5. P1 nếu thay database — Driver hiện tại cần Neon

Nguồn: `src/lib/db/index.ts:1`, `src/lib/db/index.ts:28`.

Ứng dụng dùng `neon()` của `@neondatabase/serverless`, gửi query qua HTTP, không dùng PostgreSQL TCP driver thông thường. `DATABASE_URL` local hiện trỏ tới Neon, phù hợp với implementation này.

Có thể chạy backend trên Railway và giữ Neon. Không nên thay thẳng URL bằng Railway PostgreSQL rồi kỳ vọng driver hiện tại hoạt động. Nếu muốn chuyển database vào Railway, cần PostgreSQL driver phù hợp hoặc lớp proxy Neon tương thích, sau đó kiểm tra schema, query và migration.

Schema đang được tạo/cập nhật idempotent ở query đầu tiên. Cần kiểm tra DDL trên database staging và chuẩn bị backup trước khi nâng production.

Tham khảo [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver).

## Cấu hình vận hành còn thiếu hoặc cần xác nhận

- `railway.json` hiện chỉ cấu hình region Singapore và 1 replica; chưa khai báo healthcheck, start command hay lịch cron. Các mục này có thể được đặt ở dashboard, nhưng chưa có bằng chứng xác nhận.
- Nên khai báo healthcheck path `/api/health`. Endpoint hiện chỉ kiểm tra liveness và luôn trả 200; nó vẫn thành công khi database không truy cập được. Cần kiểm tra riêng PostgreSQL/Redis/storage trước khi chấp nhận release; storage-health là route admin đã được bảo vệ.
- `vercel.json` không tự trở thành lịch Railway. Cleanup audio và data-retention đã có timer trong `src/instrumentation.ts` khi Node server chạy, ngoài cleanup theo request; không cần kết luận rằng thiếu cron sẽ khiến cleanup dừng hoàn toàn. Archive chưa có timer tương tự và cần giải quyết mục 2 trước khi lên lịch.
- `.env.local` đang dùng các Redis URL local/Compose. Cần thay bằng URL thực của service Railway. R2 và `CRON_SECRET` hiện chưa được cấu hình trong local; chỉ thêm chúng khi bật các tính năng tương ứng.
- Nếu PostgreSQL metadata đã được chọn, phải chọn rõ audio/session backend phù hợp. Ví dụ `.env.example` đặt chunk backend R2 nhưng credential R2 trống; không thể chép nguyên file này thành cấu hình production.
- Khai báo `PWA_ALLOWED_ORIGINS` đúng domain frontend khi frontend khác origin. Test proxy và preflight đã đạt với origin test.
- Chưa có `.github/workflows` trong workspace. Cần gate build/lint/test trước release và ghi lại commit/image để rollback.
- Có nhiều thay đổi chưa commit và 117 file untracked tại thời điểm kiểm tra, gồm Dockerfile và module mà route mới import. Deploy từ GitHub chỉ dùng nội dung đã commit/push; phải chọn đủ file liên quan cho release.
- `docs/audio-translation-optimization.md` còn ghi nhận semantic acceptance FAILED trên bộ audio thử trước đó. Không có kết quả QA provider thật mới trong lần kiểm tra này để thay thế kết luận đó; unit test xanh không chứng minh độ chính xác dịch giọng trẻ hoặc tải production.

Railway healthcheck tham khảo [Healthchecks](https://docs.railway.com/deployments/healthchecks), cấu hình file tham khảo [Config as Code](https://docs.railway.com/config-as-code/reference).

## Cấu hình đề xuất cho lần deploy staging đầu tiên

Giữ kiến trúc đơn giản: một web service Railway, database Neon hiện có, PostgreSQL hoặc Cloudinary cho generated audio; quota Redis nếu giữ pool. Thêm Redis cache riêng khi bật cache. Chỉ thêm worker, jobs Redis và R2 khi thực sự bật async jobs.

| Biến/thiết lập | Giá trị hoặc yêu cầu |
| --- | --- |
| Start web sau khi sửa wrapper | `node server.js` hoặc wrapper đã hỗ trợ Railway |
| Host và port | `HOSTNAME=0.0.0.0`, đọc `PORT` do Railway cấp |
| `PERSISTENCE_BACKEND` | `postgres` |
| `DATABASE_URL` | URL Neon hiện tại, lưu trong Variables |
| `AUDIO_STORAGE_BACKEND` | `postgres` để bắt đầu, hoặc provider đã cấu hình đủ |
| `AUDIO_SESSION_CHUNK_STORAGE_BACKEND` | `postgres` nếu chưa cấu hình R2 |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Credential mạnh, cung cấp qua Variables |
| `INSTALLATION_AUTH_REQUIRED` | `true`, client phải tương thích |
| `INSTALLATION_AUTH_SECRET` | Secret ngẫu nhiên tối thiểu 32 ký tự, giữ ổn định |
| Cloudflare legacy/account registry/token env | Copy đúng cấu hình cần dùng, không đưa secret vào image/source |
| `CLOUDFLARE_POOL_STORE` | `redis` khi bật pool production |
| `CLOUDFLARE_POOL_REDIS_URL` | URL quota Redis thực, không bị wrapper ghi đè |
| `AUDIO_TRANSLATION_CACHE_ENABLED` | `false`, hoặc `true` cùng Redis cache riêng |
| `AUDIO_TRANSLATION_JOBS_ENABLED` | `false` ở lần đầu nếu chưa chuẩn bị đủ worker/storage |
| `PWA_ALLOWED_ORIGINS` | Danh sách origin frontend thực tế |
| Healthcheck | `/api/health`, kèm kiểm tra phụ thuộc riêng trong quy trình release |
| Archive schedule | Chưa bật trước khi xử lý việc xóa dữ liệu đang hoạt động |

Sau khi xử lý các điểm bắt buộc: build/chạy image Node 22 Linux sạch, chạy hai Redis integration test trên Redis test riêng, deploy staging, kiểm tra đăng ký thiết bị → nhận token → dịch audio → phát audio → lưu/đọc history → admin → restart/redeploy vẫn còn dữ liệu. Nếu bật jobs, kiểm tra thêm enqueue/poll, worker restart, quyền sở hữu và đọc audio từ R2. Chỉ chuyển traffic production sau khi các luồng này đạt.

## Dấu vết kiểm tra

Log local:

- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-lint-20261029.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-build-20261029.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-build-no-credentials-20261029.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-tests-20261029.log`

Build audit dùng `.next-audio-check` để không ghi đè `.next` của môi trường phát triển. Các mục include do Next tự thêm vào `tsconfig.json` trong lúc build đã được khôi phục về trạng thái trước kiểm tra. Không sửa logic ứng dụng trong lần audit này.
