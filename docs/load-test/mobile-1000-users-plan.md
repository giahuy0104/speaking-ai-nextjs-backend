# Plan test tải 1000 người dùng theo luồng app mobile (Android)

Ngày lập: 17/11/2026 · Môi trường: dev (`https://api-dev.hoamytech.com`, 4 backend × 1,5 CPU, DB dùng chung production)
Audio đầu vào: `C:\Users\DELL\Downloads\10_cau_tieng_viet` (10 file MP3, 44,1 kHz mono)

## 1. Mục tiêu

1. Đo thời gian từ lúc người dùng nói xong đến lúc nhận được giọng đọc stream (byte đầu, đủ để phát) ở mỗi lượt — chi tiết mục 8.1.
2. Tìm số người dùng đồng thời tối đa mà hệ thống dev phục vụ được với lỗi < 1%.
3. Xác định điểm nghẽn đầu tiên: CPU backend, DeepSeek (dịch), Qwen3-TTS (giọng Trung/Nhật/Hàn/Pháp), Cloudflare (giọng Anh) hay băng thông.
4. Kiểm tra luồng phát stream mới (`/api/audio/target`) dưới tải: byte đầu, đóng stream, lỗi giữa chừng.

## 2. Luồng một lượt nói trên app Android (bản release hiện tại)

Nguồn: `speaking-ai-flutter` nhánh dev. Android luôn dùng nhận dạng giọng nói trên máy (`asrMode: android_streaming`); server không nhận audio để nhận dạng.

| # | Khi nào | Request | Ghi chú |
|---|---|---|---|
| A | Trong lúc trẻ nói, chỉ khi đích là **en** | `POST /api/conversation/preview` (JSON `{clientId, context, childAge, sourceText}`) | 300 ms sau mỗi kết quả tạm ≥ 5 ký tự và ≥ 2 từ; có thể gọi vài lần mỗi lượt; không chờ kết quả |
| B | Sau 0,4–0,7 s im lặng (hoặc trẻ bấm dừng, tối đa 12 s) | `POST /api/conversation` (JSON) | `{clientId, context, targetLanguage, childAge, sourceText, asrMode:"android_streaming", benchmark:{utteranceDurationMs, …}}`; timeout 20 s; thử lại tối đa 3 lần khi bị 429 |
| C | Ngay sau B, song song với D, không chờ | `POST /api/conversations/{conversationId}/user-audio` (multipart) | WAV 16 kHz mono 16-bit ≈ 32 KB/giây nói; chỉ Android 13+ |
| D | Ngay sau B | GET `audioUrl` | **en**: cache URL hoặc `/api/audio/stream?...`; **zh/ja/ko/fr**: `/api/audio/target?...` (WAV stream) |
| D2 | Khi bắt đầu phát | GET `audioUrl` **lần 2** (lưu cache trên máy) | Áp dụng cả `/api/audio/target` → mỗi lượt Trung/Nhật/Hàn/Pháp tải audio 2 lần |
| E | Khi bắt đầu phát, không chờ | `PATCH /api/history` (JSON latency) | |

Mỗi lần mở app (không phải mỗi lượt): `POST /api/installations/register` (chỉ lần đầu), `POST /api/devices/register`, `GET /api/offline-intents?limit=500`, sau ~10 s `POST /api/cache/warmup` + `GET /api/history?limit=100` + tối đa 12 GET audio.

Nhịp độ: lượt tiếp theo chỉ bắt đầu khi audio đã phát xong. Một vòng ≈ 0,5–1 s mic sẵn sàng + thời gian nói + 0,4–0,7 s im lặng + độ trễ B + thời gian phát audio → khoảng **5–12 s/lượt/người**, không có thời gian nghỉ cố định (chế độ nói liên tục tự sang lượt mới).

## 3. Dữ liệu test từ 10 file audio

| File | Độ dài | Nhóm |
|---|---|---|
| 01_Hom_nay_troi_nang_dep | 1,65 s | ngắn |
| 02_Toi_thich_uong_ca_phe | 1,51 s | ngắn |
| 03_Chung_ta_di_dao_nhe | 1,99 s | ngắn |
| 04_Em_dang_hoc_tieng_Anh | 2,08 s | ngắn |
| 05_Buoi_sang_that_yen_binh | 1,91 s | ngắn |
| 06_Sang_nay_toi_thuc_day | 5,64 s | dài |
| 07_Cuoi_tuan_nay_gia_dinh | 6,16 s | dài |
| 08_Moi_ngay_toi_danh_thoi_gian | 5,71 s | dài |
| 09_Sau_gio_lam_chung_toi | 6,33 s | dài |
| 10_Du_cong_viec_ban_ron | 5,86 s | dài |

Vì app nhận dạng trên máy, server chỉ nhận **văn bản**. Chuẩn bị một lần (script `scripts/k6/build-mobile-mix.mjs`, chạy trên máy test):

1. Nhận dạng mỗi file **một lần** bằng Whisper (cùng model backend dùng) → `sourceText`. Kiểm tra bằng mắt, sửa nếu sai (giả lập kết quả nhận dạng trên máy).
2. Chuyển mỗi file sang WAV 16 kHz mono 16-bit (đúng định dạng app gửi ở bước C) để có kích thước upload thật.
3. Ghi `scripts/k6/data/mobile-mix-10cau.json`: `{name, sourceText, utteranceDurationMs, wavBase64}`.
4. Xóa các bản WAV tạm sau khi tạo xong file JSON.

Lưu ý: câu dài nhất phải ≤ 45 từ tiếng Việt (giới hạn backend), và bản dịch ≤ 300 ký tự để nhận URL stream.

## 4. Việc cần làm trước khi chạy

| # | Việc | Lý do |
|---|---|---|
| 1 | **Backend**: với tài khoản test (`web_k6_`), bỏ qua cache audio nhưng **vẫn trả URL `/api/audio/target` và stream**; chỉ không ghi clip vào cache | Hiện `LOAD_TEST_BYPASS_AUDIO_CACHE` trả `audioUrl: null` → không test được luồng stream |
| 2 | **Backend**: `POST /user-audio` và `PATCH /api/history` của tài khoản `web_k6_` trả thành công nhưng không ghi Cloudinary/DB | Hiện route user-audio upload thật lên Cloudinary dùng chung production |
| 3 | **k6**: script mới `scripts/k6/mobile-turn-loop.js` mô phỏng đúng bảng ở mục 2 | Script hiện tại gửi file audio cho server nhận dạng — khác app |
| 4 | Tăng số token test (installation) lên ~50–100, đăng ký trong `setup()` có chờ khi bị 429 | Như các lần test trước |
| 5 | Chạy thử 10 người × 2 phút, so log backend với log điện thoại | Đảm bảo script giống app |
| 6 | Thống nhất ngân sách DeepInfra/Cloudflare và giờ chạy (ít người dùng thật) | Dev và production có thể dùng chung tài khoản DeepInfra: test có thể làm chậm người dùng thật |

## 5. Kịch bản k6 cho mỗi người dùng ảo (VU)

```
setup: đăng ký N installation (web_k6_*) → chia cho các VU
mỗi VU (vòng lặp):
  chọn câu ngẫu nhiên trong 10 câu; ngôn ngữ đích theo tỷ lệ cấu hình
  sleep(0.5–1 s)                              # mic sẵn sàng
  nếu en: gửi 1–2 POST /api/conversation/preview trong lúc "nói"
  sleep(utteranceDurationMs)                  # trẻ nói
  tVoiceEnd = now                             # trẻ nói xong (mốc 0)
  sleep(ENDPOINT_SILENCE_MS, mặc định 550)    # app chờ im lặng để chốt câu
  tRequest = now
  POST /api/conversation  → tResponse; status, conversationId, audioUrl
  song song (http.batch):
     POST /user-audio (WAV của câu)           # bật bằng UPLOAD_USER_AUDIO=true
     GET audioUrl (stream) → tFirstByte, tPlayable, tLastByte, tClosed, số byte
  khi có byte đầu: PATCH /api/history; GET audioUrl lần 2 (giống app)
  ghi các mốc ở mục 8.1
  sleep(thời lượng audio còn lại)             # đang phát
```

Tham số: `STAGES`, `RAMP_S`, `LANG_MIX` (mặc định `en:40,zh:15,ja:15,ko:15,fr:15`), `MIX_FILE`, `TOKENS`, `UPLOAD_USER_AUDIO`, `SECOND_AUDIO_GET` (mặc định true như app), `SUMMARY_FILE`.

## 6. Các giai đoạn tải

| Giai đoạn | Người dùng | Tăng trong | Giữ | Điều kiện đi tiếp |
|---|---|---|---|---|
| 0 – chạy thử | 10 | 30 s | 2 phút | script khớp app, lỗi = 0 |
| 1 | 100 | 1 phút | 5 phút | lỗi < 1%, `voice_end_to_playable_ms` p95 trong ngưỡng mục 8.1 |
| 2 | 250 | 2 phút | 5 phút | như trên |
| 3 | 500 | 3 phút | 5 phút | như trên |
| 4 | 750 | 3 phút | 5 phút | như trên |
| 5 | 1000 | 3 phút | 10 phút | ghi nhận kết quả |

Dừng ngay khi: lỗi > 10% trong 1 phút, DeepInfra trả 429 liên tục > 2 phút, CPU một backend 100% > 3 phút, hoặc có dấu hiệu ảnh hưởng production (log `api.hoamytech.com` tăng lỗi).

Có thể chạy thêm một lượt "tăng ngay từ 0 lên 1000" như các lần trước để so sánh, sau khi có kết quả tăng dần.

## 7. Ước tính tải ở 1000 người

| Đại lượng | Ước tính | So với giới hạn đã biết |
|---|---|---|
| `POST /api/conversation` | 1000 ÷ (8–12 s/lượt) ≈ **85–125 lượt/giây** | DeepSeek trả 429 từ ~70–85 req/s trong các lần test trước → **khả năng nghẽn dịch** |
| Tạo giọng Trung/Nhật/Hàn/Pháp | 60% × 85–125 ≈ 50–75 clip/giây × 2–4 s/clip ≈ **100–300 yêu cầu đồng thời** | DeepInfra giới hạn 200 đồng thời mỗi model; Qwen3-TTS chậm dần khi tải cao |
| Băng thông ra từ VPS | WAV 48 KB/giây audio, clip 2–6 s ≈ 100–290 KB × **2 lần tải** + MP3 tiếng Anh → ≈ **15–35 MB/s (120–280 Mbit/s)** | Cần kiểm tra giới hạn cổng mạng VPS và máy chạy k6 |
| Upload user-audio (nếu bật) | 1,5–6,3 s × 32 KB ≈ 50–200 KB/lượt ≈ 8–25 MB/s vào | Tắt mặc định trên dev |
| Ký tự TTS trong 10 phút giữ ở 1000 người | ≈ 50k–75k lượt × ~40 ký tự ≈ **2–3 triệu ký tự** | Cần tính chi phí theo giá DeepInfra/Cloudflare trước khi chạy |

Kết luận dự kiến: 1000 người dùng đồng thời theo nhịp app thật gần như chắc chắn vượt giới hạn dịch (DeepSeek) và giọng (Qwen3-TTS) hiện tại; mục tiêu thực tế của lần test là tìm ngưỡng và điểm nghẽn đầu tiên.

## 8. Số liệu cần thu

### 8.1 Từ lúc người dùng nói xong đến lúc nhận được giọng đọc (số liệu chính)

Mốc 0 = `tVoiceEnd`, lúc trẻ nói xong. Mỗi lượt ghi các khoảng sau (k6 `Trend`, đơn vị ms), tách theo ngôn ngữ đích, câu ngắn/dài và giai đoạn tải:

| Metric k6 | Công thức | Ý nghĩa |
|---|---|---|
| `voice_end_to_request_ms` | `tRequest − tVoiceEnd` | App chờ im lặng để chốt câu (giả lập 0,4–0,7 s; trên máy thật lấy từ log) |
| `conversation_ms` | `tResponse − tRequest` | Backend dịch xong và trả bản dịch (bản dịch hiện lên màn hình) |
| `voice_end_to_text_ms` | `tResponse − tVoiceEnd` | Nói xong → thấy bản dịch |
| `audio_ttfb_ms` | `tFirstByte − tResponse` | Gọi URL audio → nhận byte stream đầu tiên |
| **`voice_end_to_first_audio_byte_ms`** | `tFirstByte − tVoiceEnd` | **Nói xong → nhận byte giọng đọc đầu tiên** |
| **`voice_end_to_playable_ms`** | `tPlayable − tVoiceEnd` | **Nói xong → đủ dữ liệu để bắt đầu phát** (header 44 byte + 100 ms audio = 4 844 byte WAV; MP3 tiếng Anh: 8 KB đầu) |
| `audio_download_ms` | `tLastByte − tFirstByte` | Thời gian nhận hết clip (so với độ dài clip: phải nhỏ hơn để phát không bị khựng) |
| `audio_close_after_last_byte_ms` | `tClosed − tLastByte` | Stream đóng sau byte cuối (phải ≈ 0; lỗi 8,5 s trước đây nằm ở đây) |
| `voice_end_to_audio_end_ms` | `tVoiceEnd` → hết tiếng (`tPlayable` + độ dài clip) | Nói xong → nghe xong bản dịch |

Báo cáo mỗi metric theo p50 / p90 / p95 / p99 / max, và tỷ lệ lượt có `voice_end_to_playable_ms` ≤ 2 s, ≤ 3 s, ≤ 5 s.

Ngưỡng đề xuất (dùng làm điều kiện đi tiếp ở mục 6): `voice_end_to_playable_ms` p95 ≤ 3 000 ms ở tiếng Anh và ≤ 4 000 ms ở Trung/Nhật/Hàn/Pháp.

Giới hạn của k6: k6 đo lúc **nhận** byte, không đo lúc loa phát ra tiếng. Trên điện thoại còn thêm thời gian ExoPlayer chuẩn bị (thường 100–300 ms). Để đối chiếu:
- Mỗi giai đoạn, cho 1 điện thoại thật nói song song với k6 và đọc log `playback_latency_client` (`audioStartedAfterStopMs` = trẻ ngừng nói → loa bắt đầu phát) và `playback_trace` trên logcat.
- Backend cũng nhận các số này trong `PATCH /api/history` (`latency.audioStartedAfterStopMs`, `timeToFirstAudioMs`); thống kê từ log backend cho các lượt của điện thoại thật.
- Chênh lệch giữa điện thoại và `voice_end_to_playable_ms` của k6 là phần trên máy (nhận dạng chốt câu + khởi động player).

### 8.2 Các số liệu khác

**Từ k6 (mỗi giai đoạn, tách theo ngôn ngữ):**
- Latency `POST /api/conversation`; tỷ lệ status 200 / 422 / 429 / 502 / 503 / 504 / timeout.
- Audio: số byte, tỷ lệ stream bị đứt hoặc lỗi (các mốc thời gian ở mục 8.1).
- Số lượt hoàn thành mỗi giây.

**Từ VPS:** `docker stats` (CPU, RAM từng backend), log backend: `deepinfra_*` lỗi/429/timeout, `target_speech_stream_first_chunk`, `target_speech_stream_failed`, `target_speech_served`, số kết nối nginx.

**Báo cáo:** JSON trong `docs/postman/reports/` + bản tóm tắt (và PDF nếu cần) như các lần trước.

## 9. Rủi ro và lưu ý

- DB và Cloudinary dùng chung production: chỉ dùng tài khoản `web_k6_`, bật các cờ bỏ ghi (mục 4), không gọi API ghi dữ liệu khác.
- Chi phí DeepInfra có thể lớn (mục 7); có thể giảm bằng cách giảm thời gian giữ hoặc tỷ lệ tiếng Trung/Nhật/Hàn/Pháp.
- Không thay đổi production; mọi cờ chỉ bật trên dev và tắt lại sau test.
- Máy chạy k6 phải đủ băng thông và CPU cho 1000 VU đọc stream; nếu không, chia cho 2 máy.
- Không in hay lưu chữ ký `sig` của URL audio trong báo cáo.

## 10. Phát hiện phụ từ việc đọc code app

- App tải `/api/audio/target` **2 lần** mỗi lượt (lần 2 để lưu cache trên máy, `audio_playback_service.dart:1378-1380`). Với WAV, lần 2 tốn gấp đôi băng thông. Nên sửa app: không lưu cache cho URL stream, hoặc lưu từ bộ nhớ của `StreamedWavSource` sau khi tải xong.
- `PATCH /api/history` mỗi lượt ghi DB → với k6 cần bỏ ghi (mục 4).
