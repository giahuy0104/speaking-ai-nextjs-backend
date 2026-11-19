# Báo cáo test tải: 1000 người dùng tăng đột biến trong 1 phút (tiếng Anh, backend dev)

**Ngày test:** 19/11/2026, 16:43:45 – 16:45:15 UTC (23:43 – 23:45 giờ VN)  
**Người chạy:** Claude (k6 từ máy Windows của bạn)

---

## 1. Tóm tắt

- **Bản dịch vẫn chạy tốt:** 96% lượt nói nhận được bản dịch.
- **Audio thì không:** **chỉ 50%** lượt nói có audio. Nửa còn lại bị Google TTS từ chối (HTTP 429).
- **Điểm gãy là quota Google TTS**, không phải máy chủ. Google nhận khoảng 1.050 lệnh tạo giọng trong 40 giây đầu, đúng mức quota 1.000 request/phút của project. Sau đó Google từ chối mọi lệnh cho đến khi sang phút mới. Lúc này có khoảng **550–600 người** đang dùng.
- **Lỗi thứ hai là DeepInfra (bước dịch):** bắt đầu giới hạn tốc độ sau khoảng 45 giây, khi có khoảng 3.000 câu/phút, làm 113 lượt lỗi 503.
- **Máy chủ còn dư sức:** backend tối đa 157% CPU trên giới hạn 200%, RAM khoảng 200 MB trên 1 GB, không container nào restart.
- **Thời gian từ lúc gửi đến byte audio đầu tiên:** khoảng **1,5–2,5 giây** khi dưới 400 người. Lúc quá tải, trung vị 3,0 giây và p95 22 giây.

### Thông số chính

| Thông số | Giá trị |
|---|---|
| Số lượt nói đã gửi (gửi câu + lấy audio) | **3.070 lượt** (3.070 request dịch, 2.946 request audio; tổng 10.611 HTTP request) |
| Thời gian tải | **khoảng 1 phút 30 giây**: 1 phút tăng lên 1000 người, cộng khoảng 30 giây cho các lượt đang dở chạy xong |
| Thời gian trung bình từ lúc nhận diện xong đến lúc âm thanh đầu tiên phát ra | **7,6 giây** (trung vị 3,6 giây, p95 22,6 giây; khoảng 1,5–2,5 giây khi dưới 400 người) |
| Tỉ lệ thành công (đủ bản dịch và audio) | **48%** (1.472 / 3.070) |
| Tỉ lệ thất bại | **52%** (1.598 / 3.070): 1.474 audio bị Google từ chối 429, 113 dịch lỗi 503, 11 lỗi mạng |

---

## 2. Kịch bản test

| Mục | Giá trị |
|---|---|
| Môi trường | Backend dev `https://api-dev.hoamytech.com`, commit `acca65e` (PR #42 và #43). Production đang tắt |
| Hạ tầng | VPS 8 core / 8 GB. 4 backend × 2 CPU / 1 GB, không ghim core. nginx 1 CPU. 3 Redis. 1 worker |
| Kiểu tải | Tăng đột biến: **0 → 1000 người ảo trong 1 phút**, không giữ tải. Các lượt đang dở được chạy tiếp tối đa 30–40 giây |
| Ngôn ngữ | Chỉ tiếng Anh (Việt → Anh, Google đọc bản tiếng Anh) |
| Câu nói | 10 câu chọn ngẫu nhiên: 5 câu ngắn (1,5–2 giây, 20–24 ký tự), 5 câu dài (5,6–6,3 giây, 69–84 ký tự) |
| Mỗi người ảo | Giống app: nói → chờ 0,55 giây im lặng → `POST /api/conversation` → tải audio → chờ audio phát xong → nói tiếp |
| Cache | Tắt cho tài khoản test `web_k6_` (`LOAD_TEST_BYPASS_AUDIO_CACHE=true`). Lượt nào cũng dịch và tạo giọng mới, không lưu lịch sử |
| Giọng đọc | Câu ngắn: Google Neural2-F (MP3). Câu dài: Chirp3-HD-Aoede (stream), bị từ chối thì chuyển Neural2-F. **Wavenet-A chưa bật** |
| Bước dịch | DeepInfra, DeepSeek-V4-Flash |
| Lệnh | `k6 run -e LANG_MIX=en:1 -e STAGES=1000:1s -e RAMP=1m -e SECOND_AUDIO_GET=0 -e SUMMARY_FILE=tmp/k6-en-spike/summary.json scripts/k6/mobile-turn-loop.js` |

---

## 3. Kết quả tổng

| Chỉ số | Số lượng | Tỉ lệ |
|---|---|---|
| Lượt nói đã chạy | 3.070 | |
| Có bản dịch (`/api/conversation` 200) | 2.946 | **96%** |
| Lỗi dịch 503 (DeepInfra giới hạn) | 113 | 3,7% |
| Lỗi mạng phía k6 | 11 | 0,4% |
| **Có audio (`/api/audio/stream` 200)** | **1.472** | **50%** |
| **Audio bị từ chối 429 (Google)** | **1.474** | **50%** |
| Lượt trọn vẹn (bản dịch + audio) | 1.472 | 48% |
| Preview bị k6 huỷ vì chờ quá lâu | 227–230 | bước phụ |
| Tổng HTTP request | 10.611 | trung bình 69 request/giây |

`PATCH /api/history` trả 404 là bình thường, vì tài khoản k6 không lưu lịch sử.

---

## 4. Thời gian phản hồi

### 4.1 Từ lúc gửi đến byte audio đầu tiên (chỉ tính 1.472 lượt có audio)

| | Thấp nhất | Trung vị | Trung bình | p90 | p95 | p99 | Cao nhất |
|---|---|---|---|---|---|---|---|
| **Gửi → byte audio đầu tiên** | 0,75 s | **3,0 s** | 7,0 s | 19,4 s | **22,0 s** | 26,6 s | 30,6 s |
| Gửi → có bản dịch | 0,01 s | 1,6 s | 3,1 s | 6,8 s | 15,7 s | 18,5 s | 20,0 s |
| Gọi link audio → byte đầu tiên | 0,17 s | 1,4 s | 3,9 s | 12,1 s | 15,8 s | 18,8 s | 22,7 s |

Số gốc của k6 tính từ lúc nói xong. Tôi đã trừ 0,55 giây im lặng mà app chờ trước khi gửi.

### 4.2 Theo thời gian (đo trên server, mỗi 10 giây)

| Giờ (UTC) | Số người (ước tính) | Bản dịch 200 / 503 | Bản dịch p50 / p95 | Audio 200 / 429 | Byte audio đầu tiên p50 / p95 |
|---|---|---|---|---|---|
| 16:43:50 | ~100 | 114 / 0 | 1,3 / 2,9 s | 100 / 0 | 0,3 / 0,5 s |
| 16:44:00 | ~250 | 301 / 0 | 0,9 / 1,9 s | 272 / 0 | 0,4 / 1,6 s |
| 16:44:10 | ~420 | 446 / 0 | 1,0 / 2,1 s | 355 / 0 | 0,6 / 3,7 s |
| **16:44:20** | **~580** | 472 / 0 | 1,0 / 1,9 s | 319 / **260** | **4,7 / 8,0 s** |
| 16:44:30 | ~750 | 483 / 11 | 1,7 / 4,7 s | **0 / 421** | — |
| 16:44:40 | ~920 | 593 / **85** | 2,2 / 7,2 s | **0 / 438** | — |
| 16:44:50 | đang giảm | 537 / 17 | 3,2 / **18,7 s** | 164 / 338 | 1,2 / 3,1 s |
| 16:45:00 | đang giảm | — | — | 262 / 17 | 5,1 / 9,2 s |

---

## 5. Nguyên nhân lỗi

### 5.1 Google TTS: quota 1.000 request/phút (nguyên nhân chính)
- Quota của project (cả 4 backend dùng chung):
  - Tất cả giọng: 1.000 request/phút
  - Neural2: 1.000 request/phút
  - Chirp3 HD: 200 request/phút và 100 stream cùng lúc
- Trong khoảng 40 giây đầu (16:43:45 → 16:44:25), Google nhận khoảng **1.050** lệnh rồi trả 429 cho tới khi sang phút mới (khoảng 16:44:50).
- **Câu dài:** Chirp3 chỉ stream được **388** câu. **1.099** câu bị từ chối và chuyển sang Neural2-F (`english_speech_provider_fallback`), rồi cũng bị từ chối khi quota chung đầy.
- Backend ghi 1.474 lần `tts_stream_request_failed`.

### 5.2 DeepInfra: giới hạn tốc độ ở bước dịch
- Bắt đầu từ 16:44:30, khi có khoảng 3.000 câu/phút: 82 lần `deepinfra_rate_limited_retry` và 113 lượt báo lỗi 503 ("Dịch vụ dịch tạm thời gặp lỗi").
- Log gọi lỗi này là `cloudflare_text_failed` nhưng thực ra là DeepInfra. Tên sự kiện dễ gây hiểu nhầm.

### 5.3 Bộ đếm quota Google trong backend bị tắt khi tải cao
- Log có 33 lần `google_tts_quota_store_unavailable` (fail-open), từ 16:43:52 đến hết test.
- Nguyên nhân: lệnh Redis chỉ được chờ 300 ms (kết nối 500 ms). Khi backend bận thì quá hạn, và backend bỏ qua việc đếm quota trong 5 giây.
- Hậu quả: backend không tự từ chối sớm, vẫn gửi lên Google để Google trả 429. Người dùng phải chờ lâu hơn trước khi nhận lỗi.

---

## 6. Tài nguyên máy chủ

| Container | CPU cao nhất | RAM cao nhất | Giới hạn |
|---|---|---|---|
| backend-3000 | 157% | 201 MB | 2 CPU / 1 GB |
| backend-3001 | 112% | 200 MB | 2 CPU / 1 GB |
| backend-3002 | 141% | 195 MB | 2 CPU / 1 GB |
| backend-3003 | 120% | 190 MB | 2 CPU / 1 GB |
| nginx | 22% | 41 MB | 1 CPU / 256 MB |
| redis / redis-cache / redis-jobs | 11–16% | 4–8 MB | 0,5 CPU mỗi cái |
| audio-worker-a | 2% | 64 MB | 1 CPU / 512 MB |

- Load trung bình của VPS cao nhất là 5,4 trên 8 core.
- Không container nào restart hay bị OOM.
- nginx trong container và trên host đều không có lỗi.
- **Kết luận: CPU, RAM, nginx và mạng chưa phải nút thắt.**

---

## 7. Sức chứa của hạ tầng hiện tại

| Kiểu tải | Sức chứa ước tính | Giới hạn bởi |
|---|---|---|
| Tăng đột biến trong 1 phút | khoảng 550–600 người trước khi audio gãy | Quota Google cho phép dồn khoảng 1.000 lệnh trong phút đầu |
| **Nói liên tục, giữ tải lâu** | **khoảng 150–200 người** | 1.000 request/phút chia cho khoảng 5–6 câu mỗi người mỗi phút |
| Bước dịch (DeepInfra) | khoảng 3.000 câu/phút | Giới hạn tốc độ của tài khoản DeepInfra |

Kết quả này là khi **cache tắt**. Người dùng thật có cache bật nên câu lặp lại không tốn quota, sức chứa sẽ cao hơn tuỳ tỉ lệ câu lặp lại.

---

## 8. Đề xuất

1. **Xin Google tăng quota TTS:** quota "tất cả giọng" và Neural2 lên khoảng 5.000–6.000 request/phút cho 1000 người. Cần bật billing, vì free trial hết hạn khoảng 24/11. Đây là cách tác động mạnh nhất.
2. **Thêm DeepInfra làm giọng dự phòng cho tiếng Anh:** quota tách khỏi Google, nên tăng được sức chứa khi Google đầy. Wavenet-A **không** giúp được vì dùng chung quota 1.000/phút.
3. **Kiểm tra và tăng giới hạn DeepInfra** cho bước dịch, vì bước này bắt đầu lỗi ở khoảng 3.000 câu/phút.
4. **Sửa bộ đếm quota Redis** để không fail-open khi backend bận: tăng thời gian chờ lệnh, hoặc dùng kết nối riêng. Khi đó backend từ chối sớm và rõ ràng thay vì chờ Google trả 429.
5. **Đổi tên sự kiện log** `cloudflare_text_failed` khi provider là DeepInfra.
6. **Lần test sau:**
   - Chạy k6 từ một máy khác để loại trừ giới hạn của máy test.
   - Thêm một lần giữ tải ở mức 200–300 người để đo sức chứa bền vững.
   - Test lại sau khi tăng quota Google.

---

## 9. Dữ liệu gốc

Tất cả nằm trong `tmp/k6-en-spike/`:

| File | Nội dung |
|---|---|
| `summary.json` | Toàn bộ số đo của k6 |
| `k6-run.log` | Output k6, gồm các lỗi request phía máy test |
| `vps-stats.txt` | CPU/RAM các container dev, mỗi khoảng 12 giây |
| `nginx.log` | Access log nginx dev trong thời gian test |
| `backends.log` | Log 4 backend trong thời gian test |
| `vps-analysis.txt` | Đếm sự kiện từ log backend |

Các file log có nội dung câu nói test, không có dữ liệu người dùng thật. Không nên commit thư mục `tmp/`.
