# Test dịch audio qua Nginx 8080

Import `Audio-Translation-Nginx-8080.postman_collection.json` vào Postman.
Đây là bản viết lại từ file người dùng gửi: giữ nguyên audio WAV nhúng sẵn,
đổi điểm vào sang Nginx và bổ sung kiểm tra response cùng thông tin chẩn đoán.

## Gửi một request

1. Chạy stack bằng `npm run lb:up` nếu chưa chạy.
2. Import collection mới tên **Audio Translation - Nginx 8080 - Embedded Audio**.
3. Chọn **No environment**. Collection đã có `baseUrl=http://localhost:8080`;
   một biến `baseUrl` trong Environment đang chọn có thể ghi đè giá trị này.
4. Trong **Settings > General > Request Timeout**, đặt `70000` ms. Collection
   không tự thay đổi setting của ứng dụng Postman.
5. Chọn request **POST audio translate via Nginx 8080 - embedded WAV** và Send.

Không cần chọn file audio hay tạo Environment. Giữ Body ở chế độ **raw**,
giữ nguyên header `Content-Type` và multipart boundary. Audio gốc 93.560 byte,
multipart raw 128.465 byte, được giữ nguyên từng byte từ collection gốc.
URL request là `{{baseUrl}}/api/audio/translate`.

Hai backend `3000` và `3001` nằm trong Docker. `localhost:3000/3001` trên máy
host có thể là ứng dụng khác; client dùng cổng `8080` để đi qua Nginx.

## Assertions và chẩn đoán

Khi thành công, collection kiểm tra 9 điều kiện:

- HTTP 200.
- JSON hợp lệ và đúng Content-Type.
- Header `X-Request-Id` được giữ nguyên.
- `requestId` trong JSON khớp request đã gửi.
- Ngôn ngữ nguồn `vi`, ngôn ngữ đích `en`.
- `englishText` là chuỗi không rỗng.
- `wordCount` là số nguyên dương.
- `X-Audio-Cache` là `disabled`, `hit`, `miss` hoặc `coalesced`.
- Response có `Cache-Control: no-store`.

HTTP 429/499/502/503/504 đều làm test thất bại. Script không tự retry, không
bỏ qua lỗi để làm đẹp tỷ lệ thành công. Khi lỗi, mở Postman Console để xem
`status`, `requestId`, `responseTimeMs`, `code`, `stage`, `reason`, `retryAfter`.
Nếu Nginx trả HTML do lỗi proxy, test JSON sẽ thất bại và vẫn giữ HTTP status
trong chẩn đoán.

Tiền tố request ID mới là `postman-nginx-`. Đối chiếu ID đó trong:

```powershell
npm run lb:logs -- --follow
```

Hoặc xem riêng hai backend:

```powershell
npm run lb:logs:3000
npm run lb:logs:3001
```

Access log Nginx ghi `upstream` chứa `:3000` hoặc `:3001`. Response dịch không
trả tên backend/account; không suy luận backend từ token hoặc virtual user.

## Chạy Performance Runner

### Runner nhẹ cho bài 20 VU trên máy hiện tại

```powershell
npm run benchmark:nginx
```

Lệnh đọc nguyên body/header của collection này, gửi qua Nginx `8080`, chạy
20 luồng, cửa sổ gửi 30 giây, tối đa 120 request. Đây là runner HTTP nhẹ dùng
payload của collection; nó kiểm tra HTTP 200 và bản dịch tiếng Anh không rỗng,
không thực thi script `pm.*` như Newman/Postman. Collection trong Postman vẫn
giữ đầy đủ 9 assertions cho bài kiểm tra chức năng.

Runner kiểm tra RAM trước khi gửi từng request. Mặc định, khi RAM host dùng
từ 90% hoặc còn dưới 1 GiB trống, nó ngừng gửi mới và chờ các request đã gửi
hoàn tất. Khi hết cửa sổ gửi, đạt số request tối đa hoặc nhấn Ctrl+C một lần,
runner cũng chờ các request đang chạy. Deadline mỗi HTTP request là 40 giây,
lớn hơn deadline xử lý audio tối đa 30 giây của backend. Nó không tự retry
request lỗi hoặc inference có kết quả chưa xác định.

Nếu dừng do thiếu RAM hoặc người dùng ngắt, báo cáo ghi lý do và lệnh trả exit
code khác 0, ngay cả khi các request đã gửi đều thành công. Các lỗi HTTP khác
vẫn được tính đúng. Mỗi lần chạy gọi provider thật và có thể phát sinh chi phí.

```powershell
# Một đợt dồn đúng 20 request, mỗi luồng gửi một lần.
npm run benchmark:nginx -- --mode burst --max-requests 20

# Tải liên tục 60 giây, tối đa 240 request.
npm run benchmark:nginx -- --seconds 60 --max-requests 240
```

Báo cáo JSON được lưu trong `docs/postman/reports/`; prefix request ID là
`opt-nginx-`. Các tùy chọn đứng sau `--` ghi đè mặc định tương ứng.

### Performance Runner trong giao diện Postman

Chọn Fixed load và 2 virtual users trong giao diện Postman. Đây là cấu hình
chạy do người dùng chọn; import JSON không tự cấu hình một phiên performance.
Collection chỉ có một request dịch audio để không trộn các request health
check vào số liệu tải. Hai VU không gắn cố định vào hai backend hay hai
Cloudflare account, và không bảo đảm chia tải chính xác 50/50.

Nginx không tăng quota Cloudflare. Cấu hình Docker hiện giữ `audio-a` cho luồng
legacy và dùng `audio-b` cho pool production. Backend tự điều phối provider;
collection không gọi Cloudflare trực tiếp và không chứa API token Cloudflare.
HTTP 200 không chứng minh chất lượng ngữ nghĩa bản dịch hoặc cache/Redis hoạt
động đúng. Với cấu hình No Auth/legacy hiện tại, cache có thể báo `disabled`.

Collection giữ `clientId=web_postman_performance` và No Auth như bản gốc,
phù hợp `INSTALLATION_AUTH_REQUIRED=false` hiện tại. Nếu server bật xác thực
installation, cần cung cấp Bearer token và sửa `clientId` khớp token trước khi
chạy. Không thay đổi chính sách xác thực server để vượt qua test.

## Nguyên nhân lỗi 499 đã xác minh

Trong phiên Postman 12.34.1 chạy 20 VU ngày 28/10/2026, lúc 14:17:07 giờ Việt
Nam (07:17:07 UTC), Postman ghi:

```text
Critical system resource limit: MEMORY at 98.18% with threshold 95
State change: running -> error
run status:stopping
```

Nginx ghi 150 request trong phiên đó: 131 HTTP 200 và 19 HTTP 499. Cả 19 kết
nối bị hủy trong cùng giây Postman dừng, dù tuổi request khác nhau từ 204 đến
5.725 ms. Cùng request ID, backend ghi `failureSource=client` và
`abortCause=client_disconnect` cho cả 19 trường hợp. Đây là hệ quả load
generator dừng vì RAM host, không phải timeout 60 giây của Nginx.

Xem [báo cáo đối chiếu log](reports/2026-10-28-nginx-499-root-cause.json).
Giữ ngưỡng bảo vệ RAM của Postman. Với GUI local, cần giảm VU hoặc giải phóng
RAM trước khi chạy; giữ bài 20 luồng trên máy hiện tại bằng lệnh runner nhẹ ở
trên. Tăng timeout Nginx hoặc bật `proxy_ignore_client_abort` không khôi phục
kết nối client đã đóng. Việc đổi cách sinh tải không thể ngăn một client khác
chủ động ngắt kết nối hoặc bị hệ điều hành kết thúc.

## Kết quả kiểm tra ngày 28/10/2026

Đã kiểm tra JSON theo schema Postman Collection v2.1 chính thức, xác nhận
multipart/audio giữ nguyên và chạy bằng Newman 6.2.3 qua Nginx tại cổng 8080.
Lần chạy xác nhận cuối: 1 request, HTTP 200, khoảng 3 giây, 9/9 assertions đạt.
Đây là một lần kiểm tra chức năng, chưa phải bài Performance 2 VU dài hạn.

Sau khi bổ sung runner nhẹ, đã chạy thực tế **20 luồng / 120 request** qua
Nginx với chính body/header của collection. Kết quả đối chiếu access log:

| Kết quả | Số request |
| --- | ---: |
| HTTP 200 | 117 |
| HTTP 429 (`queue_timeout`, giai đoạn dịch text) | 2 |
| HTTP 504 (`timeout`, giai đoạn ASR) | 1 |
| HTTP 499 | 0 |

Cả backend `3000` và `3001` nhận tải. Phiên chạy kéo dài khoảng 30,95 giây,
RAM host cao nhất quan sát khi nhận request là 80,69%; RSS runner ở cuối phiên
là 76 MiB. Runner đợi request cuối hoàn tất và trả exit code 1 vì vẫn có ba
request 429/504. Kết quả này xác nhận đã tránh được đợt hủy kết nối do Postman
cạn RAM; chưa đạt 100% thành công ở mức tải này. Hai lỗi hàng chờ và một timeout
vẫn được ghi nhận nguyên trạng để đánh giá giới hạn xử lý/provider.

Xem [báo cáo 20 luồng và xác nhận từ Nginx](reports/2026-10-28-nginx-20vu-memory-safe.json).
Các kiểm tra hồi quy cho dừng do RAM, dừng gửi khi hết giờ, giới hạn request,
ngắt có chờ và burst 20 luồng đều đạt (5/5); TypeScript và ESLint của runner đạt.

Tham khảo [biến trong Postman](https://learning.postman.com/docs/use/send-requests/variables/define-variables/),
[Request Timeout](https://learning.postman.com/docs/getting-started/installation/settings/general-settings)
và [Newman](https://github.com/postmanlabs/newman).
