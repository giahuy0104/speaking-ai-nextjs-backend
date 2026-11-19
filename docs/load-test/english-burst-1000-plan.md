# Bài test: 1000 người dùng gửi cùng một audio cùng lúc (tiếng Anh)

Ngày lập: 19/11/2026 · Môi trường: dev (`https://api-dev.hoamytech.com`, 4 backend, DB dùng chung production)

## 1. Mục tiêu

Đo, khi 1000 người gửi audio **cùng một lúc**, thời gian của từng bước:

1. **STT** — nhận diện giọng nói tiếng Việt (Whisper trên DeepInfra).
2. **Dịch** — tiếng Việt → tiếng Anh.
3. **TTS** — tạo và phát giọng đọc tiếng Anh (stream).
4. **Gửi → chunk audio đầu tiên / phát được** — thời gian người dùng thực sự phải chờ.

Đồng thời tìm mức tải mà hệ thống bắt đầu chậm hoặc lỗi, và bước nào là điểm nghẽn.

## 2. API được test

App Android nhận diện giọng nói trên điện thoại, server không có bước STT. Để đo STT trên server, bài test dùng luồng gửi file audio (như bản web):

| Bước | Request |
|---|---|
| STT + dịch | `POST /api/audio/translate` (multipart, file WAV 16 kHz mono) → `englishText`, `timings.asrMs`, `timings.translationMs`, `audioUrl` |
| TTS | `GET audioUrl` (`/api/audio/stream?...`, audio tiếng Anh phát dần) |

## 3. Kịch bản

- **Audio:** một file cho tất cả người dùng — `06_Sang_nay_toi_thuc_day` (5,6 s, câu dài). Lượt phụ: `01_Hom_nay_troi_nang_dep` (1,65 s, câu ngắn). Chuyển sang WAV 16 kHz mono.
- **Kiểu tải:** k6 `per-vu-iterations` — N người dùng ảo, **mỗi người 1 request**, cùng xuất phát trong ~1 giây.
- **Các mức:** 10 (chạy thử) → 100 → 250 → 500 → 1000, nghỉ 2–3 phút giữa các mức.
- **Mỗi người dùng ảo:** gửi audio → đọc kết quả STT/dịch → gọi `audioUrl` → nhận hết audio.

## 4. Chỉ số

Mốc 0 (`t0`) = lúc bắt đầu gửi request audio.

**Chỉ số chính**

| Metric | Ý nghĩa |
|---|---|
| `send_to_first_audio_chunk_ms` | Gửi → nhận **chunk audio TTS đầu tiên** |
| `send_to_playable_ms` | Gửi → đủ dữ liệu để **bắt đầu phát** (MP3 ~8 KB đầu) |
| `send_to_audio_end_ms` | Gửi → nhận hết audio |

**Chia nhỏ theo bước**

| Metric | Đo | Nguồn |
|---|---|---|
| `upload_ms` | Gửi file lên | k6 |
| `stt_ms` | Nhận diện giọng nói | server (`timings.asrMs`) |
| `translate_ms` | Dịch | server (`timings.translationMs`) |
| `server_other_ms` | Xếp hàng / xử lý khác trên server | request − STT − dịch − upload |
| `tts_first_chunk_ms` | Gọi `audioUrl` → chunk audio đầu | k6 |
| `tts_buffer_ms` | Chunk đầu → đủ để phát | k6 / máy đo mẫu |
| `tts_download_ms` | Tải hết audio | k6 |

Kiểm tra chéo: `send_to_first_audio_chunk_ms ≈ upload + stt + translate + server_other + tts_first_chunk`.

**Lỗi:** tỷ lệ theo mã (`429`, `502`, `503`, `504`, timeout) và theo bước (STT / dịch / TTS). Log dev (`LOG_TURN_CONTENT=true`) ghi kèm câu bị lỗi.

## 5. Cách đo — 3 lớp

| Lớp | Số lượng | Đo được |
|---|---|---|
| **k6** | 100–1000 người | Tạo tải; mọi metric ở mục 4. "Đủ để phát" là ước tính (k6 không đọc từng chunk). |
| **Máy đo mẫu (Node.js)** `scripts/k6/audio-chunk-probe.mjs` | 10–20 người, chạy cùng lúc với k6 | Thời điểm thật của chunk đầu, lúc đủ để phát, khoảng cách giữa các chunk (stream có khựng không). Dùng để kiểm chứng k6. |
| **Điện thoại thật** (tuỳ chọn) | 1 máy | Lúc loa thật sự phát (`playback_latency_client`, `playback_trace` trên logcat) — thêm thời gian khởi động player (~100–300 ms). |

## 6. Điều kiện trước khi chạy

1. **Tắt cache cho tài khoản k6.** 1000 request cùng một câu: nếu còn cache thì chỉ lượt đầu dịch/tạo giọng thật. Phần tắt cache (`LOAD_TEST_BYPASS_AUDIO_CACHE`) đã viết cho `/api/conversation` nhưng **chưa deploy**, và cần **mở rộng cho `/api/audio/translate`** (cache bản dịch, cache audio tiếng Anh, gộp request trùng).
2. **Deploy** các thay đổi backend đang chờ (bộ giới hạn TTS, cách B, tắt cache k6, log nội dung, Google Translate dự phòng).
3. **Kiểm tra giới hạn của route:** kích thước file, số request/phút mỗi IP — tránh bị chính backend chặn trước khi đo.
4. **Viết script:** `scripts/k6/audio-burst-translate.js` (dùng lại một phần `audio-burst-1000.js`) và `scripts/k6/audio-chunk-probe.mjs`.
5. **Giờ chạy:** lúc ít người dùng thật (DeepInfra có thể dùng chung tài khoản với production).

## 7. Dự đoán

| Bước | Ở 1000 người cùng lúc |
|---|---|
| STT (Whisper, DeepInfra) | ~1000 yêu cầu đồng thời, vượt giới hạn ~200/model → khả năng cao `429` hoặc xếp hàng; timeout STT trên dev 8 s |
| Dịch (DeepSeek) | 1000 yêu cầu; khi bị giới hạn sẽ chuyển Cloudflare / Google NMT (nếu đã cấu hình) |
| TTS tiếng Anh | 1000 stream cùng lúc từ nhà cung cấp giọng tiếng Anh của dev |

Chi phí mỗi mức 1000: ~93 phút audio cho Whisper, ~80.000 ký tự dịch, ~60.000 ký tự tạo giọng.

## 8. Báo cáo

Cho mỗi mức (100 / 250 / 500 / 1000), tách câu ngắn và câu dài:

- `send_to_first_audio_chunk_ms`, `send_to_playable_ms`: p50 / p90 / p95 / p99 / max.
- Tỷ lệ lượt có tiếng trong ≤ 2 s, ≤ 3 s, ≤ 5 s, ≤ 10 s.
- Biểu đồ chia thời gian theo bước (upload / STT / dịch / chờ / TTS) — bước nào dài ra khi tải tăng.
- Bảng lỗi theo bước và mã lỗi, kèm ví dụ log.
- Kết luận: mức tải tối đa còn đạt ngưỡng, điểm nghẽn đầu tiên, đề xuất xử lý.

File kết quả: `docs/postman/reports/k6-audio-burst-translate-en-<N>.json` và bản tổng hợp (PDF nếu cần).

## 9. Thứ tự thực hiện

1. Mở rộng tắt cache cho `/api/audio/translate` + test.
2. Viết script k6 và máy đo mẫu.
3. Deploy lên dev.
4. Chạy thử 10 người, đối chiếu với log backend.
5. Chạy 100 → 250 → 500 → 1000, nghỉ giữa các mức.
6. Tổng hợp báo cáo.
