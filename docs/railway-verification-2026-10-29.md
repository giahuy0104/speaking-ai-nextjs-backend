# Kết quả sửa và kiểm tra Railway — 29/10/2026

Các điểm chặn trong mã và cấu hình được nêu ở lần audit đã được xử lý. Repository đã có cấu hình web/worker, môi trường mẫu, kiểm tra production và CI để đưa lên Railway staging. Chưa tạo service hoặc triển khai lên tài khoản Railway.

## Thay đổi chính

| Vấn đề | Kết quả xử lý |
| --- | --- |
| Bắt buộc Compose secret mount | Startup dùng Variables trực tiếp; env file là tùy chọn, lỗi cấu hình được trả về không kèm secret |
| Ghi đè Redis Railway | Chỉ đổi host Redis khi `APP_RUNTIME=compose`; Railway giữ URL, TLS, password và DB index đã cấp |
| Production cho phép chỉ gửi clientId | Luôn bắt buộc installation token và scoped upload; `false` không thể tắt bảo vệ ở production |
| Browser hiện có chưa gửi token | Thêm helper đăng ký/gia hạn, nối recorder, practice, user-audio upload và admin audio check; không replay provider POST |
| Nhiều tab tự vô hiệu hóa phiên | Đăng ký cùng credential idempotent; xử lý race insert bằng đọc và xác minh credential của winner |
| Archive xóa dữ liệu đang dùng | Chỉ lấy preparation đã hết hạn; bảo vệ auth/profile/history/rules/commit markers và hủy pending snapshot không an toàn của bản cũ |
| Async job chia sẻ filesystem | Worker image/config riêng; Railway yêu cầu R2; Compose vẫn hỗ trợ volume local dùng chung |
| Redis quota/cache/jobs không cách ly | Chuẩn hóa host/port, chặn cùng instance kể cả khác DB index; cache đã tắt không làm jobs lỗi |
| Health xanh khi database hỏng | Giữ liveness `/api/health`; thêm `/api/ready` kiểm tra DB/schema, Redis đã bật, R2 nếu dùng, có timeout và không chạy DDL |
| Bucket TTS public chứa giọng riêng tư | Fail startup nếu cấu hình TTS public R2 dùng chung bucket với chunks/jobs private hoặc archive |
| Thiếu quy trình release | Thêm `.env.railway.example`, runbook, lệnh kiểm tra/tích hợp/smoke và GitHub Actions workflow |

Database vẫn dùng Neon HTTP driver hiện có. Startup báo lỗi rõ ràng nếu cấu hình raw Railway PostgreSQL TCP; lần triển khai này không tự đổi database hoặc chuyển dữ liệu.

## Kết quả xác minh

| Kiểm tra | Kết quả |
| --- | --- |
| Bộ test đầy đủ trên Redis/PostgreSQL test thực | **424 đạt, 0 lỗi, 0 bỏ qua** |
| TypeScript `tsc --noEmit --incremental false` | Đạt |
| `npm run lint` | Đạt |
| Web image Node 22 Alpine, clean `npm ci`, Next production build | Đạt |
| Worker image Node 22 Alpine, clean `npm ci` | Đạt |
| `npm run smoke:railway` trên image cuối | **19/19 đạt** |
| Startup `check` với `.env.local`, không có Compose secret mount | Đạt, không kết nối Redis hoặc gọi inference |
| `docker compose ... config --quiet` | Đạt |
| Probe Neon hiện có bằng SELECT/to_regclass thuần đọc | Truy cập được; đủ bốn bảng chính; không chạy migration hoặc ghi dữ liệu |
| Dependency/engine trong package-lock và package.json | Khớp |
| `git diff --check` | Đạt |

Test Redis bao gồm phục hồi sau `NOSCRIPT`, timeout, quota nhiều process, ownership/idempotency của jobs và tiếp tục checkpoint mà không chạy lại ASR. Redis/PostgreSQL của test được tạo riêng, gắn nhãn và dọn sau khi chạy. Test runner loại biến ứng dụng/credential đã export từ shell; đã kiểm tra lại trong cả trường hợp parent shell có storage backend không tương thích.

Test PostgreSQL chạy SQL thực của archive, xác nhận selection hết hạn, batch nhỏ, bảo vệ namespace, bản ghi được gia hạn trong khi upload, hủy snapshot cũ, retry lỗi upload và lease fencing.

Smoke Linux xác nhận web bind đúng PORT runtime, process non-root, auth/CORS, readiness trả 503 với database giả không truy cập được, worker boot với Redis riêng, heartbeat và SIGTERM sạch. Không enqueue job tới provider hoặc dùng credential production cho smoke.

## Rà soát bởi trợ lý AI

Các checkpoint auth, client browser, archive, runtime/Docker/readiness và hạ tầng test đã được trợ lý khác rà soát sau thay đổi. Các vấn đề được phát hiện và sửa trong quá trình này gồm:

- Client web thiếu token khi bật bảo vệ production.
- Race đăng ký cùng installation giữa các tab.
- URL cache Redis đã tắt vẫn gây lỗi jobs.
- Namespace đã trim khi validate nhưng chưa chuẩn hóa cho consumer.
- Cấu hình storage từ shell làm nhiễu bộ test local.
- Nguy cơ dùng một bucket public TTS cho giọng người dùng private.

Không còn vấn đề actionable được ghi nhận trong lượt review cuối. Kiểm tra này không thay thế xác minh trên service Railway thực hoặc QA chất lượng giọng nói.

## Bước triển khai tiếp theo

1. Commit/push đầy đủ thay đổi liên quan, gồm các file mới; workspace đã có nhiều thay đổi của người dùng trước lần sửa này, không tự chọn hoặc commit thay người dùng.
2. Tạo Railway web service dùng `railway.json`; điền Variables theo `.env.railway.example`. Giữ Neon hiện có; thay các URL Redis local bằng URL của service Railway nếu bật pool/cache/jobs.
3. Nếu bật jobs, tạo thêm service dùng `/railway.worker.json`, Redis jobs riêng và bucket R2 private dùng chung với web. Giữ generated TTS ở PostgreSQL/Cloudinary khi R2 phục vụ voice inputs.
4. Dừng deployment/cron archive cũ trước khi bật lịch archive mới. Đảm bảo Flutter/client bên ngoài đã hỗ trợ installation token và scoped upload v2.
5. Trên staging, kiểm tra luồng thật đăng ký → dịch → phát audio → history/admin và restart/redeploy giữ dữ liệu. Nếu bật jobs, thêm enqueue/poll và restart worker. Chưa có kết quả kiểm tra độ chính xác dịch giọng trẻ với provider thật trong lượt sửa này.

Chi tiết thao tác và rollback: [runbook Railway](railway-deployment.md).

## Log kiểm tra local

- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-tests.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-lint.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-types.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-web.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-worker.log`
- `C:/Users/DELL/AppData/Local/Temp/speaking-ai-railway-final-smoke.log`
