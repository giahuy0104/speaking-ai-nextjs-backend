# Chạy Nginx load balancer

Stack Docker mặc định chạy `Nginx → 2 backend Next.js`, dùng chung PostgreSQL
và ba Redis hiện có cho quota, cache và jobs. Chỉ Nginx mở cổng HTTP ra host.
Hai service có tên riêng `backend-3000` và `backend-3001`, lần lượt lắng nghe
cổng nội bộ Docker `3000` và `3001`, để dễ đối chiếu log.
Hai backend dùng cùng một image/build để các static asset và cấu hình Next.js
khớp nhau. PostgreSQL hiện dùng driver Neon HTTP; `DATABASE_URL` phải trỏ đến
dịch vụ tương thích với driver này.

## Chuẩn bị

- Docker Engine đang chạy Linux containers và Docker Compose >= 2.20.
- `.env.local` có `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` và
  `CLOUDFLARE_POOL_REDIS_PASSWORD` giống cấu hình Redis hiện có.
- Nếu bật pool, dùng các Cloudflare account riêng như runbook hiện tại.
  Khi `.env.local` đang có `CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST=true`,
  entrypoint giữ account legacy cho luồng cũ, loại account đó khỏi registry pool
  của container và tắt ngoại lệ development. File `.env.local` không thay đổi.
  Log `docker_pool_legacy_account_reserved` báo số account đã loại; nếu không còn
  account riêng nào đang bật, container từ chối khởi động. Ví dụ cấu hình local
  có `audio-a` chung legacy và `audio-b` riêng thì pool production chỉ dùng
  `audio-b`; muốn tăng quota phải thêm account riêng và quota hợp lệ.
- `AUDIO_STORAGE_BACKEND` để trống (mặc định PostgreSQL), hoặc chọn `postgres`,
  `cloudinary`, `r2`, `vercel-blob` và cung cấp đủ credentials tương ứng.
  Container từ chối `local`, vì file cục bộ giữa các replica không đồng bộ.

Compose đặt `PERSISTENCE_BACKEND=postgres` và `CLOUDFLARE_POOL_STORE=redis`.
Entrypoint đọc `.env.local` từ Docker secret bằng parser của Node, rồi tạo
Redis URL theo hostname nội bộ `redis`, `redis-cache`, `redis-jobs`. Password
được encode vào URL tự động; không cần sửa URL localhost trong `.env.local`.
Secret không được đóng gói vào image. Không đưa `.env.local` vào Git.

## Khởi động và kiểm tra

```powershell
npm run lb:up
npm run lb:status
npm run lb:check
```

Mở `http://127.0.0.1:8080`. Các endpoint API giữ nguyên path, ví dụ
`http://127.0.0.1:8080/api/audio/translate`. Với Android emulator, dùng
`http://10.0.2.2:8080` làm backend base URL.

`lb:check` gửi 20 request đến `/api/health`, kiểm tra có ít nhất hai instance
khác nhau trả lời, request ID được giữ nguyên, CORS cùng origin hoạt động và
health response không bị cache. Không gửi audio hay gọi inference Cloudflare.

`GET /healthz` kiểm tra riêng Nginx. `GET /api/health` đi qua Nginx đến một
backend và trả `{ "status": "ok", "instance": "..." }`. Đây là liveness,
không phải kiểm tra PostgreSQL, Redis hoặc Cloudflare. Dùng endpoint admin
storage-health hiện có khi cần kiểm tra storage đầy đủ.

## Cổng và log từng backend

Thêm vào `.env.local` khi cần thay đổi:

```dotenv
NGINX_BIND_ADDRESS=127.0.0.1
NGINX_HTTP_PORT=8080
BACKEND_IMAGE_TAG=local
```

Chạy lại `npm run lb:up` sau khi đổi cấu hình. Nginx dùng `least_conn` để chia
tải giữa `backend-3000:3000` và `backend-3001:3001`. Docker DNS cập nhật địa chỉ
backend sau khoảng 5 giây khi tạo lại container. Backend có lỗi kết nối được
tạm loại khỏi phân phối bằng passive health checks.

Xem log realtime từng backend trong hai terminal riêng:

```powershell
npm run lb:logs:3000
npm run lb:logs:3001
```

Dùng Ctrl+C để thoát xem log; backend vẫn tiếp tục chạy. `npm run lb:logs`
hiển thị 100 dòng gần nhất của cả Nginx và hai backend. Access log Nginx ghi
`upstream` gồm IP và port `3000` hoặc `3001`, kèm `requestId` để đối chiếu.

Hai port backend không publish ra host: `localhost:3000` và `localhost:3001`
có thể đang được ứng dụng khác sử dụng. Client gọi `localhost:8080` để đi qua
load balancer. Nếu muốn thêm backend, thêm service có port và tên riêng trong
Compose rồi thêm server tương ứng trong upstream Nginx; cấu hình cũ
`BACKEND_REPLICAS` không còn được sử dụng.

Mỗi backend được giới hạn 1 CPU, 1 GiB RAM; Nginx 0,5 CPU, 128 MiB. Chỉnh
`docker-compose.nginx.yml` theo tài nguyên host và kết quả đo tải. Thêm replica
không tăng quota Cloudflare; tất cả tiếp tục dùng chung quota Redis và namespace.
Cache gom request trùng trong RAM và một số bộ đếm cục bộ vẫn riêng từng process;
đo lại tải thực tế sau khi tăng replica.

Mặc định chỉ bind loopback để chạy local. Khi triển khai trên server, cấu hình
HTTPS/certificate tại Nginx hoặc reverse proxy tin cậy phía trước, rồi mới
publish ra mạng phù hợp, ví dụ `NGINX_BIND_ADDRESS=0.0.0.0`. Nếu TLS kết thúc
ngay tại Nginx, `$scheme` tự chuyển thành `https`. Nếu có proxy TLS phía trước,
cần cấu hình trust/header theo proxy đó; không nhận tùy ý
`X-Forwarded-Proto` do client gửi. Cập nhật `PWA_ALLOWED_ORIGINS` nếu PWA dùng
origin khác. Nếu domain public đã có load balancer ngoài, không mở cổng backend.

## Timeout, request ID và lỗi cancelled

- Deadline dịch audio của ứng dụng vẫn mặc định 20 giây, tối đa 30 giây.
- Nginx dùng `proxy_read_timeout=60s` và `proxy_send_timeout=60s`. Đây là giới
  hạn chờ giữa các thao tác I/O, không phải deadline tổng của một request.
- Đặt timeout Postman/app lớn hơn thời gian xử lý backend và thời gian upload;
  với audio ngắn có thể bắt đầu ở 70 giây rồi đo lại.
- Upload tối đa qua Nginx là 32 MiB; API vẫn kiểm tra giới hạn audio của riêng nó.
- Nginx giữ request ID hợp lệ hoặc tạo ID mới; access log JSON ghi `requestId`,
  `upstream`, `upstreamStatus`, `requestTime`, `upstreamTime`.
- API response và stream không bị proxy cache/buffer. Các response lỗi và
  header `Retry-After`, `Location`, `Preference-Applied` được giữ nguyên.
- Không bật retry `non_idempotent`; POST đã gửi tới backend sẽ không được
  chuyển sang backend khác để thực hiện lại inference.
- Client mất kết nối vẫn có thể dẫn tới `cancelled`. Nginx không bảo đảm lỗi
  này biến mất. Với công việc cần chạy tiếp khi client ngắt kết nối, dùng jobs.

```powershell
npm run lb:logs
docker compose --env-file .env.local -f docker-compose.redis.yml -f docker-compose.nginx.yml exec nginx nginx -t
```

## Worker tùy chọn cho jobs

Đặt `AUDIO_TRANSLATION_JOBS_ENABLED=true` và bật pool trong `.env.local`, rồi:

```powershell
docker compose --env-file .env.local -f docker-compose.redis.yml -f docker-compose.nginx.yml --profile jobs up -d --build --wait nginx audio-worker
```

Worker đọc cùng secret và Redis. Các backend và worker cùng mount named volume
`audio-job-files` tại `/app/data/audio-translation-jobs`; nếu chọn local job
audio, tất cả đều đọc được cùng file. Volume này dùng được cho nhiều container
trên cùng Docker host. Khi tách sang nhiều server, chọn
`AUDIO_TRANSLATION_JOB_STORAGE=r2` với cấu hình R2 hợp lệ hoặc storage chia sẻ
thật sự. Không dùng volume local độc lập trên mỗi server.

## Kiểm tra failover và dừng

Để kiểm tra failover local, lấy ID của một backend, dừng tạm container đó,
gửi request `/api/health` qua Nginx và xác nhận backend còn lại phục vụ; sau đó
khởi động lại container và chạy `npm run lb:check`. Lần kết nối lỗi đầu tiên
với một POST đang gửi vẫn có thể thất bại vì không tự lặp inference.

```powershell
npm run lb:stop
```

Lệnh này chỉ dừng Nginx, backend và worker, giữ các Redis hiện có chạy tiếp và
giữ dữ liệu. `npm run lb:up` sẽ bật lại Nginx/backend. Với worker, dùng lệnh
profile jobs ở trên.

Không dùng `docker compose down -v` để dừng thông thường: nó xóa volume dữ liệu.
Các lệnh Redis cũ vẫn dùng cùng project `speaking-ai-cloudflare`; tránh
`redis:down` khi stack Nginx còn phục vụ. Vercel cron không tự chạy khi self-host;
cấu hình scheduler của server cho các endpoint cron hiện có nếu dùng tính năng đó.

Khi nâng phiên bản, dùng `BACKEND_IMAGE_TAG` riêng cho mỗi release. Build image
mới trước, sau đó cập nhật các container. Docker Compose cơ bản có thể gây một
khoảng gián đoạn khi thay tất cả replica; dùng blue/green hoặc orchestrator nếu
cần rollout không gián đoạn. Giữ image tag trước đó để rollback.
