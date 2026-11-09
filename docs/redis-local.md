# Redis local cho Cloudflare pool

Cấu hình này dành cho backend chạy trực tiếp trên máy Windows hiện tại. Redis chạy bằng Docker Desktop, chỉ công bố cổng `127.0.0.1:16379`, có mật khẩu và Docker volume lưu metadata điều phối. Đây không phải Redis trên Railway hoặc một dịch vụ Redis cloud.

## Khởi động và kiểm tra

Mở Docker Desktop, chờ engine sẵn sàng, rồi chạy tại thư mục project:

```powershell
npm run redis:up
npm run redis:status
npm run check:cloudflare-pool -- --validate
```

`redis:up` chờ healthcheck đạt trước khi kết thúc. `--validate` kiểm tra cấu hình pool và Redis PING, không gọi inference Cloudflare. Khởi động lại backend sau khi sửa `.env.local` để process nhận cấu hình mới.

## Biến môi trường

```dotenv
CLOUDFLARE_POOL_STORE=redis
CLOUDFLARE_POOL_REDIS_PASSWORD=<LOCAL_REDIS_PASSWORD>
CLOUDFLARE_POOL_REDIS_URL=redis://:<URL_ENCODED_PASSWORD>@127.0.0.1:16379/0
```

Hai giá trị mật khẩu phải tương ứng. Password Redis khác API token Cloudflare. Khi cấu hình tự động lần đầu, mật khẩu ngẫu nhiên được ghi vào `.env.local` đã được Git bỏ qua; không ghi mật khẩu vào Compose hoặc tài liệu. Password được sinh dạng hex nên dùng trực tiếp trong URL được.

Registry phải tách Account ID legacy khỏi pool. Nếu chỉ có hai account tổng cộng, giữ một cho legacy và một cho pool; pool lúc này có một account, chưa có dự phòng giữa hai account. Token legacy và các biến token riêng vẫn được giữ.

### Thử phân phối giữa hai account đang có

Theo yêu cầu thử local với hai account tổng cộng, có thể bật ngoại lệ rõ ràng:

```dotenv
CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST=true
```

Khi đó registry có cả `audio-a` và `audio-b`, dùng token env riêng cho từng account. Chạy bằng `npm run dev`, khởi động lại backend sau khi đổi env. Chế độ này chỉ dùng development/test hoặc CLI local và Redis loopback; `NODE_ENV=production` hoặc URL Redis remote bị từ chối. Mặc định ngoại lệ tắt, quy tắc tách legacy vẫn áp dụng.

Các request hội thoại/TTS legacy vẫn dùng account cũ và chưa đi qua admission store. Vì vậy, khi đo pool local, không đồng thời tạo tải legacy lên cùng account. Kết quả không chứng minh quota chung cho toàn bộ tính năng đã được quản lý. Để triển khai production, dùng account pool dành riêng hoặc thực hiện điều phối toàn bộ consumer trước.

Trong Postman, gửi nhiều request hoặc chọn Performance chạy local. Đối chiếu log `cloudflare_pool_admission` theo `requestId`, `stage` và `accountAlias`; cần thấy cả hai alias có attempt hoàn thành thành công. Backend không trả account alias hoặc credentials ra JSON client. Để so phân phối cùng công đoạn, có thể thử audio tiếng Anh với `sourceLanguage=en` để chỉ gọi ASR. Pool không đảm bảo tỷ lệ cứng 50/50 khi tải hoặc cooldown khác nhau.

## Xem log và tạm dừng

```powershell
npm run redis:logs
npm run redis:down
```

`redis:down` dừng container nhưng giữ volume. Khởi động lại bằng `redis:up`. Không thêm `-v`, không xóa volume hoặc dùng `FLUSHDB` để né quota/cooldown. File `infra/redis/redis.conf` bật AOF và chính sách `noeviction` để tránh tự loại bỏ key quota khi đầy bộ nhớ. Đây là cấu hình local; việc mất dữ liệu Redis vẫn cần được xử lý thận trọng khi có traffic thật.

Không trỏ Redis integration test có `SCRIPT FLUSH` hoặc `CLIENT PAUSE` vào Redis đang dùng này; hãy tạo server test disposable riêng theo runbook. Kiểm tra xác nhận dùng namespace và identity giả riêng, không đụng quota của account thật.

## Khi chạy backend ở nơi khác

`127.0.0.1` là máy đang chạy backend. Backend trên Railway không thể truy cập Redis trên máy Windows bằng URL local này. Khi deploy, tạo Redis trong môi trường triển khai và thay `CLOUDFLARE_POOL_REDIS_URL` bằng địa chỉ được cấp, dùng cùng namespace cho mọi process cùng sử dụng một Account ID. Nếu backend chuyển vào container cùng Compose, dùng hostname dịch vụ `redis` và cổng `6379` thay vì URL host hiện tại.
