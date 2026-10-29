# Hai tài khoản và quota Redis dùng chung

`audio/translate` có thể chọn cả `audio-a` và `audio-b`. Các API ASR, text và TTS
cũ giữ tài khoản `CLOUDFLARE_ACCOUNT_ID`, nhưng lấy permit từ cùng Redis và
namespace. Một lần gọi inference lấy một permit; không bọc lại lời gọi đã có
`execution`. Các workload dùng chung key account và key task ASR/text, TTS có
key task riêng. FIFO theo task/model trong từng process, không phải FIFO toàn cụm.

## Cấu hình

- `CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED=true`, store Redis trên production.
- `CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST=false`.
- `CLOUDFLARE_POOL_SHARE_LEGACY_ACCOUNT=true`: mọi inference legacy được admission,
  lỗi Redis/cấu hình sẽ dừng yêu cầu, không gọi thẳng Cloudflare để bỏ qua quota.
- `CLOUDFLARE_POOL_ROUTE_LEGACY_ACCOUNT=false` trong giai đoạn đầu; đổi thành
  `true` sau khi mọi backend và worker đã có mã admission mới.
- Account legacy phải enabled trong registry, dùng token qua biến riêng. Thêm
  đủ model vào capabilities ASR/text/TTS. Nếu không cấu hình text model, các API
  hiện có dùng hai mặc định khác nhau: Llama Scout và Qwen3; cần khai báo cả hai.
- `capabilities.tts` gồm model TTS tiếng Anh đang cấu hình (mặc định
  `@cf/deepgram/aura-1`) và `xai/grok-tts` cho các ngôn ngữ đích khác.
- Có `limits.tts` riêng. Mức khởi đầu local `rpm=60, burst=2, maxConcurrent=2`
  là ngân sách của ứng dụng, chưa phải xác nhận quota hoặc quyền model Cloudflare.
  `accountMaxConcurrent` vẫn áp dụng cho tổng ASR + text + TTS.
- Mọi replica dùng cùng Redis/namespace và cùng định nghĩa giới hạn. Giữ key
  quota hiện tại khi nâng cấp để không tạo lại ngân sách rate/concurrency.

## Triển khai hai giai đoạn

1. Lưu image và `.env.local` hiện tại ở nơi riêng, không đưa secrets vào Git.
2. Build mã mới. Bật SHARE, tắt LOCAL_TEST, giữ ROUTE=false; khởi động lại lần
   lượt tất cả backend và worker đang hoạt động. Các API cũ dùng Redis, còn
   audio/translate vẫn dành account legacy cho các API cũ.
3. Xác nhận mỗi instance có sự kiện `docker_pool_shared_legacy_quota_enabled`
   với `legacyRouting=false`. Chạy kiểm tra API và legacy.
4. Đổi ROUTE=true, khởi động lại lần lượt các instance. Xác nhận cả hai account
   nhận ASR và text, cả hai backend có cùng configVersion.
5. Đo 20 user/60 giây với cache miss. Tách admission 429, upstream HTTP lỗi,
   deadline và client cancellation; ghi nhận P95 cùng phân bố theo account.

Legacy không tự retry hoặc chuyển account. Lỗi text không chạy lại ASR. TTS
streaming trả header sớm, giữ permit tới EOF/lỗi/hủy/deadline và giữ giới hạn
thời gian cũ. Download MP3 từ storage không tiêu thụ permit inference.
Một HTTP 403 của model chỉ gọi ở legacy không disable toàn account; 401 vẫn
áp dụng chính sách credentials chung. HTTP lỗi vẫn giữ contract legacy.

Các sự kiện admission có workload `audio-translate`, `legacy-asr`, `legacy-text`,
`legacy-tts`, model và accountAlias; không chứa token, account ID hoặc nội dung.
Legacy transport tạo requestId riêng cho mỗi inference. Nó chưa nối requestId
này với ID HTTP của mọi API cũ.

## Kiểm tra và rollback

Chạy `npm run test:cloudflare-legacy`, `npm run test:cloudflare-pool`, các test
AI provider/TTS, TypeScript và lint. Test Redis dùng server tạm riêng, bao gồm
hai kết nối backend tranh cùng account giữa legacy TTS và pooled ASR.
Kiểm tra stream kết thúc, hủy giữa chừng, deadline, lỗi mạng/Redis và không lấy
permit hai lần. Chạy smoke có gọi Cloudflare trên từng account trước load test.

Rollback có kiểm soát: đặt ROUTE=false trên mọi instance trước để ngừng nhận
audio/translate vào account legacy, chờ in-flight kết thúc; sau đó phục hồi
image và cấu hình cũ đã lưu, khởi động lại lần lượt. Không xóa Redis quota.
Không chỉ tắt SHARE khi registry còn chứa account legacy: cấu hình cũ sẽ bị
chặn hoặc legacy có thể chạy ngoài quota.
