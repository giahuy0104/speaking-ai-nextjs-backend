# Test cache Redis trên localhost:8080

Hai backend Docker vẫn chạy production. Request có installation access token
hợp lệ được dùng cache theo installation. Không cần đổi NODE_ENV hoặc sửa điều
kiện cache của ứng dụng. INSTALLATION_AUTH_SECRET được lưu trong .env.local,
dùng chung cho hai backend; cấu hình runtime này cần khởi động lại backend.

## Import vào Postman

1. Import `Audio-Translation-Local-Cache.postman_collection.json`.
2. Import `.env.local-cache.postman_environment.json`, chọn Environment
   **Local 8080 - Authenticated Cache**.
3. Mở request **Translate embedded WAV - authenticated cache**, bấm Send hai
   lần với cùng audio. Body đã có WAV nhúng sẵn, giữ chế độ raw và Content-Type.
4. Xem response header `X-Audio-Cache`: lần đầu thường `miss`, lần sau `hit`.
   Cache có TTL mặc định 300 giây; khi hết TTL, request sẽ xử lý lại.
5. Dùng `X-Request-Id` để đối chiếu log ở cả hai backend: `npm run lb:logs`.

File Environment chứa credential installation dành cho local và được Git bỏ
qua theo quy tắc `.env*`. Nó không chứa signing secret hoặc Cloudflare token.
Collection chỉ chứa tên biến; credential do Environment cung cấp.

## Cấp lại token

Access token mặc định hết hạn sau một giờ. Khi cần:

```powershell
npm run postman:local-auth
```

Import lại Environment vừa tạo. Lệnh đăng ký lại cùng installation để cấp phiên
mới; token ở Environment cũ sẽ không còn dùng được. Đăng ký không nằm trong
vòng lặp Performance Runner, tránh rate limit đăng ký và xoay phiên đồng thời.

Để kiểm tra cache bằng runner nhẹ, gửi ba request tuần tự:

```powershell
npm run postman:local-auth -- --verify-cache
```

Lệnh chỉ gọi localhost:8080; cache miss có thể gọi Cloudflare thật. Kết quả được
lưu trong reports, không ghi token, secret hoặc nội dung audio/bản dịch vào log.

## Đọc kết quả tải

20 VU dùng cùng Environment và audio sẽ chủ yếu đo cache và có thể chờ chung
một tác vụ khi cache lạnh. Để đo công suất AI, cần bài riêng với audio mới hoặc
cache được bỏ qua; không lấy tốc độ cache hit làm tốc độ Cloudflare.
Collection Nginx cũ vẫn không gửi token nên request legacy tiếp tục báo
`disabled`. Dùng đúng collection mới và Environment trên để test cache.
