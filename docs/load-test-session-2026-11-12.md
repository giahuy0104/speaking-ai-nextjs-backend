# Phiên test tải audio trên api-dev — 12/11/2026

Bản ghi cuộc trò chuyện giữa người dùng và Claude Code về việc test tải luồng dịch audio
trên `https://api-dev.hoamytech.com`. Mỗi mục là một yêu cầu của người dùng, kèm việc đã làm và kết quả.
File này không chứa token hay bí mật.

## Tóm tắt nhanh

| Mốc | Kết quả |
|---|---|
| Mục tiêu ban đầu | Test 1000 request trong 1 giây |
| Công cụ | k6 v2.3.0 (Postman Performance không giữ được đúng số request/giây) |
| Điểm nghẽn 1 | Nginx dev: 1 worker × 512 kết nối, chặn 22–46% request bằng lỗi 500/503. Đã sửa |
| Điểm nghẽn 2 | Bộ đệm upload của backend: 60 request mỗi instance. Đã nâng lên 600 |
| Điểm nghẽn 3 (còn lại) | Tốc độ cấp lượt gọi Cloudflare của pool: 300 lượt dịch/phút mỗi tài khoản, chờ tối đa 8 giây |
| Chế độ jobs | Nhận đủ 1000 job trong 1 giây, xử lý xong 1000/1000 trong khoảng 4 phút |
| Tài khoản Cloudflare | Thêm tài khoản thứ ba `audio-c` trên dev |

## Bảng kết quả các đợt test

| Giờ (VN) | Kịch bản | Thành công | 429 | 500/503 | Ghi chú |
|---|---|---|---|---|---|
| 15:56 | Sync, 2 request/giây trong 30 giây, 10 audio | 33/61 | 2 | 0 | 4/10 file audio luôn bị `422 ASR_LOW_CONFIDENCE` |
| 16:00 | Sync, 1000 trong 1 giây, 6 audio | 35/999 | 742 | 220 | `audio-b` bị Cloudflare từ chối |
| 16:13 | Sync, 1000 trong 1 giây, 6 audio | 90/998 | 445 | 459 | `audio-b` bị Cloudflare trả 429 mã 4006 |
| 16:43 | Sync, 1000 trong 1 giây, 1 audio | 170/1000 | 449 | 381 | Hai tài khoản đều hoạt động |
| 16:56 | Sync, 1000 trong 1 giây, sau khi sửa nginx | 220/1000 | 780 | 0 | Cả 1000 request tới backend |
| 17:11 | Jobs, 1000 trong 1 giây | 1000/1000 trên server | 0 | 0 | k6 báo 768 do poll quá thời gian |
| 17:21 | Sync, 500 trong 1 giây, 2 tài khoản | 158/500 | 342 | 0 | |
| 17:35 | Sync, 500 trong 1 giây, 3 tài khoản | 295/500 | 205 | 0 | |

## Diễn biến theo từng yêu cầu

### 1. "Tôi muốn test 1000 request trong 1 giây bằng collection Postman Performance có được không"

- Postman Performance tính theo số người dùng ảo (VU), không theo request/giây: `RPS ≈ số VU / thời gian phản hồi`.
- Backend có các giới hạn riêng: `AUDIO_TRANSLATION_JOB_MAX_PER_CLIENT` (mặc định 10), `AUDIO_TRANSLATION_JOB_MAX_PENDING` (tối đa 1000 trong code), giới hạn tốc độ ở route chunk và session.
- Cảnh báo: api-dev dùng chung database với production.
- Đề xuất dùng k6 với `constant-arrival-rate` để giữ đúng 1000 request/giây.

### 2. "Viết script k6 cho luồng audio"

Tạo `scripts/k6/audio-load.js`:

- `MODE=sync` gọi `POST /api/audio/translate`; `MODE=jobs` gọi `POST /api/audio/jobs` rồi poll `GET /api/audio/jobs/:jobId`.
- `PROFILE=ramp` hoặc `constant`, tải theo tốc độ đến (`RATE` luồng mới mỗi giây).
- `setup()` đăng ký sẵn `TOKENS` installation (API đăng ký giới hạn 12 lượt/phút/IP), các VU dùng chung.
- Chỉ số: `audio_flow_duration`, `audio_flow_success`, `audio_rate_limited`, `audio_cache_hit`, `audio_flow_failures`.
- Từ chối chạy với `api.hoamytech.com` nếu thiếu `ALLOW_PROD=1`.

### 3. "Cho tôi lệnh chạy request qua CLI"

```bash
winget install k6 --source winget
```

```bash
k6 run -e BASE_URL=https://api-dev.hoamytech.com -e MODE=sync -e PROFILE=constant -e RATE=2 -e DURATION=30s scripts/k6/audio-load.js
```

```bash
k6 run -e BASE_URL=https://api-dev.hoamytech.com -e MODE=jobs -e RATE=20 -e DURATION=2m -e TOKENS=30 -e MAX_VUS=1000 scripts/k6/audio-load.js
```

### 4. Lỗi "k6 is not recognized" trong PowerShell

k6 đã được cài tại `C:\Program Files\k6\k6.exe`; cửa sổ PowerShell mở trước khi cài nên chưa nhận PATH mới. Cách xử lý: mở lại terminal, hoặc gọi thẳng:

```powershell
& "C:\Program Files\k6\k6.exe" version
```

### 5. "Chạy dùm tôi luôn đi" — chạy thử 2 request/giây

- p95 3,3 giây, 3% bị 429, không trúng cache.
- 46% lỗi không phải do tải: 4/10 file audio trong bộ test luôn bị `422 ASR_LOW_CONFIDENCE`
  (`2-con-nho-ngoai.wav`, `003-con-dang-mac-ao.wav`, `3-con-o-sieu-thi.wav`, `3-thoi.wav`).
- Một số bản dịch sai nghĩa (ví dụ "dừng" thành "People").

### 6. "Test 1000 trong 1 giây" (lần 1 và lần 2)

- Lần 1: 35/999 thành công; 742 lỗi 429; 220 lỗi 500/503 không có body JSON.
- Lần 2: 90/998 thành công; 445 lỗi 429; 459 lỗi 500/503.
- Health của dev và prod trở lại 200 sau mỗi lần chạy.

### 7. Kiểm tra log trên VPS — nguồn gốc lỗi 500/503

Đường đi của request: `k6 → nginx host (:443) → nginx container dev (:8081) → backend-3000 / backend-3001`.

| Lỗi k6 thấy | Nguyên nhân trong log |
|---|---|
| 500 | Nginx container dev: `512 worker_connections are not enough while connecting to upstream` (request chưa tới backend) |
| 503 | Nginx host: `upstream prematurely closed connection`, rồi `error_page 502 504 =503` đổi thành 503 |
| 429 | Backend từ chối |

Mỗi request qua proxy chiếm 2 kết nối, nên 1 worker × 512 chỉ giữ được khoảng 250 request cùng lúc.

### 8. Nguyên nhân từng loại lỗi của backend

| Lý do | Nguyên nhân |
|---|---|
| `queue_full` (bước upload, `buffer_capacity`) | Số request đang đệm vượt `CLOUDFLARE_POOL_MAX_IN_FLIGHT + MAX_QUEUED` = 20 + 40 = 60 mỗi instance |
| `queue_timeout` | Chờ quá `CLOUDFLARE_POOL_MAX_WAIT_MS` (8 giây) mà chưa có lượt gọi Cloudflare |
| `store_unavailable` | Lệnh Redis của pool quá 1 giây; client bị huỷ, không tự kết nối lại. Redis không từ chối kết nối nào, nhiều khả năng do thiếu CPU (suy luận) |

### 9. "Cho tôi ngưỡng để giải quyết được 1000 request trong 1 giây"

Số đo: ASR khoảng 1,4 giây, dịch văn bản khoảng 0,9 giây khi không phải chờ.
Hạn mức mỗi tài khoản: ASR 720 lượt/phút (20 cùng lúc), văn bản 300 lượt/phút (8 cùng lúc).

Ngưỡng hạ tầng (cần cho cả hai hướng):

| Thành phần | Trước | Ngưỡng |
|---|---|---|
| Nginx dev `worker_connections` | 512 | 4096 |
| Nginx dev `worker_processes` | 1 | auto |
| Nginx dev CPU / RAM | 0,25 / 64 MB | 1 / 256 MB |
| `MAX_IN_FLIGHT` + `MAX_QUEUED` mỗi instance | 60 | ≥ 600 |
| `CLOUDFLARE_POOL_MAX_BUFFERED_BYTES` | 32 MB | 128 MB |

- **Hướng A (jobs):** nhận 1000 request trong 1 giây, xử lý qua hàng đợi. Làm được với code hiện tại.
- **Hướng B (sync, trả lời trong khoảng 15 giây):** cần ≥ 150 lượt ASR và ≥ 90 lượt dịch cùng lúc, khoảng 6000 lượt/phút mỗi loại;
  còn vướng giới hạn cứng 60 luồng mỗi instance trong `src/lib/ai/audioTranslationService.ts`.

### 10. "Triển khai theo hướng A"

Sửa trong repo (commit `77ed0d1`):

- `infra/nginx/nginx.dev.conf`: `worker_processes auto`, `worker_connections 4096`, `worker_rlimit_nofile 16384`, `keepalive 64`.
- `docker-compose.dev.yml`:
  - Nginx dev 1 CPU / 256 MB; backend 1,5 CPU; Redis 0,5 CPU; worker 1 CPU.
  - `CLOUDFLARE_POOL_MAX_IN_FLIGHT=100`, `CLOUDFLARE_POOL_MAX_QUEUED=500`, `CLOUDFLARE_POOL_MAX_BUFFERED_BYTES=134217728`.
  - `AUDIO_TRANSLATION_JOB_MAX_PENDING=1000`, `AUDIO_TRANSLATION_JOB_MAX_PER_CLIENT=100`, `AUDIO_TRANSLATION_JOB_WORKER_CONCURRENCY=16`.

Biến trong `environment` của compose ghi đè `.env.local`, vì `loadEnvFile` không ghi đè biến đã có.
`MAX_PER_CLIENT=100` chỉ để tiện test tải trên dev, không nên mang sang production.

### 11. Script test riêng cho một file WAV

Tạo `scripts/k6/audio-burst-1000.js`: gửi đúng `REQUESTS` request (mặc định 1000) của một file WAV tới
`POST /api/audio/translate`, rải đều trong `WINDOW_MS` (mặc định 1000 ms).

```bash
k6 run scripts/k6/audio-burst-1000.js
```

```bash
k6 run -e REQUESTS=500 scripts/k6/audio-burst-1000.js
```

Ghi chú: file "con không hiểu" được nhận diện thành "Con muốn cho với bạn" và dịch thành "I want to give it to you".
Khi cache tắt (`cacheStatus: disabled`), backend không gộp request trùng: mỗi request là một lượt dịch riêng.

### 12. "Đã đẩy code và deploy hết rồi" — nhưng giới hạn mới chưa có hiệu lực

Workflow "Deploy dev" chỉ cập nhật image backend. Theo `deploy/deploy.sh`, CI không bao giờ ghi đè file compose và nginx trên VPS;
phải chép tay bằng quyền root vào `/opt/homi/backend-dev`.

### 13. Áp dụng cấu hình trên VPS

1. So sánh file trên VPS với repo: khớp bản trước khi sửa.
2. Sao lưu thành `*.bak-20261112-burst`, chép bản mới, kiểm tra `docker compose config` và `nginx -t`.
3. Tạo lại 7 container của dev; tất cả healthy. Production không bị đụng tới.

Lưu ý: `.env.compose` ghi `BACKEND_IMAGE_TAG=local` nhưng image thật mang tag theo commit.
Khi chạy `docker compose up -d` bằng tay phải truyền `BACKEND_IMAGE_TAG=<mã commit>`.

### 14. Chạy lại 1000 request sync sau khi sửa nginx

220 thành công, 780 lỗi 429, không còn 500/503. Nginx dev và nginx host không ghi lỗi nào.

### 15. "Debug lỗi 429 từ backend"

- Pool cấp lượt gọi theo kiểu xô token (`src/lib/ai/cloudflare/redisScripts.ts`): có sẵn `burst` lượt, nạp thêm `rpm ÷ 60` lượt mỗi giây.
- Hai tài khoản: ASR 24 lượt/giây, dịch văn bản **10 lượt/giây** (điểm nghẽn).
- `CLOUDFLARE_POOL_TEXT_BACKLOG_THRESHOLD=8` tạm dừng cấp lượt ASR khi có 8 request chờ dịch.
- Cả 780 lỗi là `queue_timeout`, thất bại sau 8,05–11,9 giây. Cloudflare không từ chối lượt nào.

### 16. "Cloudflare có gói dùng bao nhiêu tính bấy nhiêu không"

Có (theo trí nhớ của Claude, cần đối chiếu trang giá của Cloudflare): gói Workers Paid khoảng 5 USD/tháng,
phần vượt 10.000 neuron/ngày tính theo lượng dùng. Trả tiền không tự nâng giới hạn số lượt gọi mỗi phút.

### 17. Test 1000 request trong 1 giây bằng chế độ jobs

| Hạng mục | Kết quả |
|---|---|
| Job được nhận (202) | 1000/1000 |
| Job xử lý xong | 1000/1000, 0 thất bại, tất cả có bản dịch |
| Thời gian | khoảng 4 phút (4,2 job/giây) |
| k6 báo thành công | 768 |

- 198 lượt poll quá 15 giây: 1000 client poll mỗi 2 giây làm hai backend chạy ở 123% CPU.
- 31 lượt poll trả `completed` nhưng thiếu bản dịch: khả năng là lỗi tranh chấp trong hàm đọc job ở
  `src/lib/ai/audioTranslationJobs.ts` (đọc dữ liệu job trước, hỏi trạng thái sau). Chưa tái hiện riêng.
- Giới hạn tốc độ lần này là worker: 16 job cùng lúc, mỗi job gần 4 giây.

### 18. Test 500 request trong 1 giây (sync, 2 tài khoản)

158/500 thành công; 342 lỗi 429 (`queue_timeout`); 47 lượt ASR bị lãng phí vì hết thời gian chờ ở bước dịch.

### 19. Thêm tài khoản Cloudflare thứ ba vào dev

- Token được kiểm tra với Cloudflare và Workers AI trước khi thêm.
- Thêm `audio-c` vào `CLOUDFLARE_ACCOUNTS_JSON` và biến `CLOUDFLARE_POOL_C_TOKEN` trong `.env.local` trên VPS
  (sao lưu tại `.env.local.bak-20261112-audio-c`). `audio-b` được giữ nguyên.
- Kiểm tra: 60/60 request thành công, mỗi tài khoản xử lý 20 lượt ASR.

### 20. Test lại 500 request với 3 tài khoản

295/500 thành công (59%), 205 lỗi 429. Ba tài khoản chia tải đều (ASR 113/114/112, dịch 98/97/98).

## Việc còn mở

- Chế độ sync vẫn bị giới hạn bởi tốc độ cấp lượt dịch văn bản (khoảng 15 lượt/giây với 3 tài khoản).
- Endpoint trạng thái job có thể trả `completed` mà thiếu kết quả (chưa sửa).
- Poll trạng thái tốn CPU khi có 1000 client.
- `scripts/k6/audio-load.js` có thay đổi `gracefulStop` chưa commit; `scripts/k6/audio-burst-1000.js` chưa commit.
- File thừa `scripts/k6/audio-load - Copy.js` nằm trong commit `77ed0d1`.
- Nginx host (`worker_connections 768`) chưa nâng; file dùng chung với production.
- Chất lượng nhận diện giọng nói với một số file audio trẻ em cần xem xét riêng.

## File liên quan

- Script: `scripts/k6/audio-load.js`, `scripts/k6/audio-burst-1000.js`
- Cấu hình: `docker-compose.dev.yml`, `infra/nginx/nginx.dev.conf`
- Báo cáo k6: `docs/postman/reports/k6-*.json`
