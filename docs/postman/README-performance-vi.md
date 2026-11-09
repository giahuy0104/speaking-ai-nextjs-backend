# Chạy Performance với hai account Cloudflare

Import `Audio-Translation-Performance.postman_collection.json` vào Postman Desktop.
Tên collection: **Audio Translation - Performance - Embedded Audio - 2 VUs**.

## Thiết lập lần chạy

1. Giữ backend chạy tại `http://localhost:3000` và Redis Docker đang chạy.
2. Chọn collection mới, bấm **Run → Performance → Local/App**.
3. Chọn **Fixed** (mức tải cố định), đặt **Virtual users = 2**.
4. Chọn thời gian ngắn nhất giao diện cho phép để thử trước, chẳng hạn 30 giây hoặc 1 phút.
5. Để **Environment = None**, **Iteration data = None**, rồi bấm **Run**.

Số virtual users và thời gian chạy được chọn trong giao diện Runner; file collection v2.1 không tự đặt hai thông số này.
Mỗi người dùng ảo gửi request tiếp theo sau khi request trước kết thúc, lặp lại trong suốt thời gian chạy.
Hai người dùng ảo không có nghĩa toàn bài thử chỉ gửi hai request.

Để đo request tăng đột ngột, dùng chế độ burst của script benchmark backend: mỗi client gửi đúng một request đồng thời. Một bài Performance VU lặp nhiều phút là tải liên tục, không mô phỏng riêng một đợt dồn request. Backend mới hỗ trợ chờ ngắn bằng `CLOUDFLARE_POOL_MAX_WAIT_MS`, số chỗ chờ và byte body đều có giới hạn; xem runbook để cấu hình. Hàng chờ đầy hoặc chờ quá lâu vẫn trả 429 và phải được ghi nhận trong kết quả.

## Vì sao bản này không cần chọn file

Collection có sẵn nội dung WAV mẫu, được chuyển thành chuỗi Base64 trong một body **raw multipart**.
Base64 là cách biểu diễn byte của file bằng chữ và số. Bộ đọc form hiện tại của backend giải mã chuỗi này trở lại thành file audio.
Đã kiểm tra nội dung giải mã trùng từng byte với WAV gốc, dung lượng **93.560 byte**.
Vì body đã chứa audio nên Performance Runner không cần truy cập đường dẫn file trên máy.

Giữ nguyên **Body = raw** và header **Content-Type** kèm `boundary` đã có sẵn.
Không chuyển body sang JSON, binary hoặc form-data trong trình soạn request.
Không cần Working directory, upload file lên Postman team hoặc CSV/JSON Iteration data.

Đây là cách gửi dành cho bài thử với backend Node.js hiện tại. Nếu thay bộ đọc multipart hoặc runtime backend trong tương lai, cần kiểm tra lại việc giải mã `Content-Transfer-Encoding: base64`.
Body mã hóa lớn hơn file WAV nhị phân khoảng 33–37% (bản này 128.465 byte gồm cả header multipart).
Kết quả bao gồm chi phí upload và giải mã đó; dùng cùng collection khi so sánh các lần chạy.
Collection chứa audio mẫu và không chứa token/Account ID Cloudflare. Chia sẻ collection cũng là chia sẻ audio mẫu.

## Xác nhận hai account được sử dụng

Collection gọi API backend; backend tự chọn `audio-a` hoặc `audio-b` theo cấu hình pool và khả năng nhận tải.
Không có token Cloudflare trong Postman và không gắn cứng người dùng ảo số 1 vào account A hay người dùng số 2 vào account B.
ASR (nhận diện tiếng nói) và dịch văn bản có thể dùng account khác nhau trong cùng một request.
Hai virtual users không bảo đảm tỷ lệ chia tải chính xác 50/50.

Trong `.next/dev/logs/next-development.log`, tìm:

```text
postman-perf-
cloudflare_pool_attempt_completed
```

Đối chiếu các trường:

| Trường | Ý nghĩa |
| --- | --- |
| `requestId` | Ghép các giai đoạn của cùng một request. Mỗi lần gửi có ID mới. |
| `accountAlias` | `audio-a` hoặc `audio-b`. |
| `stage` | `audio_translation_asr` hoặc `audio_translation_text`. |
| `status` | `success` cho lần gọi nhà cung cấp thành công. |

Phản hồi API giữ nguyên hợp đồng hiện tại, không trả accountAlias cho client.
Header `X-Request-Id` có tiền tố `postman-perf-` để tách bài thử khỏi traffic khác.

## Đọc lỗi

- **400 / AUDIO_TOO_SHORT:** kiểm tra đã chọn đúng collection Embedded Audio và giữ nguyên body/header.
- **429:** pool hoặc nhà cung cấp đã chạm giới hạn nhận tải; đây là kết quả cần ghi nhận, không bỏ qua trong báo cáo.
- Bản collection cập nhật hiển thị thêm `stage`, `reason` và `Retry-After` trong lỗi assertion/console. `reason=queue_timeout` là hết thời gian chờ permit; `reason=rate_limited` là phản hồi giới hạn từ provider. Import lại collection sau khi cập nhật file để xem chẩn đoán mới. Test vẫn yêu cầu HTTP 200.
- **503:** kiểm tra Redis và log backend, bao gồm `reason` nếu có.
- **Timeout:** đối chiếu log với requestId để biết request chậm hoặc hết thời gian ở giai đoạn nào.

Collection yêu cầu HTTP 200 và bản dịch tiếng Anh không rỗng. Điều này kiểm tra cấu trúc kết quả, không đánh giá độ đúng về ngữ nghĩa của bản dịch.

## Kiểm tra đã thực hiện

Đã gửi đồng thời hai HTTP request dùng chính raw body và header của collection tới backend local.
Cả hai trả HTTP 200 và bản dịch tiếng Anh không rỗng; log ghi nhận cả `audio-a` và `audio-b`.
Đây là kiểm tra HTTP trực tiếp, chưa phải một phiên chạy qua giao diện Postman Performance Runner.

Sau bản sửa FIFO permit ngày 27/10, một burst 20 HTTP request đồng thời với cùng body/header đạt 20/20 HTTP 200; P95 6.818 ms. Cả hai account đều được sử dụng, có chờ permit và không lặp ASR/text. Xem [báo cáo](./reports/2026-10-27-fifo-smoke.json). Kết quả này chưa xác nhận tải liên tục dài hạn hoặc chất lượng ngữ nghĩa bản dịch; lỗi timeout provider vẫn cần theo dõi riêng.

Tham khảo: [cấu hình Performance Runner](https://learning.postman.com/docs/tests-and-scripts/performance-testing/performance-test-configuration/) và [body raw trong Postman](https://learning.postman.com/docs/use/send-requests/create-requests/parameters).
