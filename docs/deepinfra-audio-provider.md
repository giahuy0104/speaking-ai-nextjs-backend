# DeepInfra cho ASR và dịch của `/api/audio/translate`

Áp dụng cho `POST /api/audio/translate` và audio worker (BullMQ). Không đổi pipeline Flutter chính, dịch text V1 hay TTS: các luồng đó vẫn dùng Cloudflare.

## Cấu hình khuyến nghị: DeepInfra trước, Cloudflare dự phòng

Trong `.env.local` (local) hoặc file env của `api-dev` và worker trên VPS:

```
AUDIO_ASR_PROVIDER=deepinfra,cloudflare
AUDIO_TEXT_PROVIDER=deepinfra,cloudflare
DEEPINFRA_API_KEY=<key>           # không commit, không dán vào chat
DEEPINFRA_ASR_TIMEOUT_MS=5000     # chừa thời gian cho Cloudflare trong hạn 20s
```

- Mỗi biến là danh sách theo thứ tự ưu tiên. `deepinfra` hoặc `cloudflare` một mình = không có dự phòng. Bỏ trống = `cloudflare` (hành vi cũ, khoá cache không đổi).
- Hai bước chọn độc lập. Cloudflare vẫn cần cấu hình như cũ (tài khoản legacy hoặc pool) để làm dự phòng.
- Production/Compose: container dừng ngay khi khởi động nếu danh sách có `deepinfra` mà thiếu `DEEPINFRA_API_KEY` (`infra/docker/runtime-config.mjs`).
- Restart backend và worker sau khi đổi env.

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `DEEPINFRA_ASR_MODEL` | `openai/whisper-large-v3-turbo` | Cùng model với Cloudflare |
| `DEEPINFRA_TEXT_MODEL` | `deepseek-ai/DeepSeek-V4-Flash-0731` | Bản có ngày, không tự đổi model |
| `DEEPINFRA_ASR_TIMEOUT_MS` | `8000` | Mỗi lượt gọi ASR; nên 5000 khi có dự phòng |
| `DEEPINFRA_TEXT_TIMEOUT_MS` | `6000` | Mỗi lượt gọi dịch |
| `DEEPINFRA_TEXT_REASONING_EFFORT` | (trống) | `none`…`high`; chỉ gửi khi đặt |
| `DEEPINFRA_BASE_URL` | `https://api.deepinfra.com/v1/openai` | Chỉ chấp nhận https |

## Khi nào chuyển sang Cloudflare

| Tình huống | Chuyển? |
|---|---|
| DeepInfra 429, 5xx, quá thời gian, lỗi mạng, phản hồi hỏng | Có |
| Thiếu `DEEPINFRA_API_KEY` hoặc model sai | Có |
| Bước dịch trả rỗng hoặc không phải tiếng Anh | Có (chỉ bước dịch) |
| Audio không nghe rõ / transcript đáng ngờ (422) | Không: gửi lại chỉ tốn thêm tiền |
| Request đã hết hạn hoặc client đã ngắt | Không |

- Mỗi bước fallback riêng: bước dịch lỗi thì chỉ dịch lại trên Cloudflare, không chạy lại ASR.
- Nếu cả hai đều lỗi, trả lỗi của nhà cung cấp cuối (Cloudflare).
- Mỗi lần chuyển ghi log `audio_translation_provider_fallback` (`stage`, `from`, `to`, `status`, `reason`, `upstreamStatus`; route kèm `requestId`, worker kèm `jobId`). Theo dõi log này để biết DeepInfra lỗi bao nhiêu.
- Kết quả trả về `model` / `textModel` của nhà cung cấp thực sự đã xử lý.
- Job bị đưa lại hàng đợi (Cloudflare hết chỗ) sẽ thử DeepInfra lại từ đầu ở lần sau, tối đa 3 lần cho một job. Bước ASR đã xong (checkpoint) không chạy lại.

## Hành vi khác

- ASR gửi multipart tới `/audio/transcriptions` với `language` cố định và `response_format=verbose_json`. Segment (`avg_logprob`, `no_speech_prob`, `compression_ratio`) đi qua cùng bộ kiểm tra transcript tiếng Việt như Cloudflare.
- Dịch gọi `/chat/completions` với cùng prompt và `max_tokens=256`. Khối `<think>…</think>` (nếu có) bị bỏ trước khi kiểm tra bản dịch.
- Khi bật pool, session admission vẫn giới hạn số request đồng thời của backend; lượt gọi DeepInfra không dùng permit Cloudflare, lượt dự phòng Cloudflare thì dùng như bình thường. Audio worker vẫn cần `CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED=true`.
- Không trả nội dung lỗi từ DeepInfra ra ngoài.

## Cần kiểm tra trước khi dùng thật

1. DeepInfra không có `vad_filter`, `beam_size`, `no_speech_threshold` như Cloudflare. Test riêng audio im lặng/nhiễu để xem Whisper có sinh chữ giả không (kết quả này không kích hoạt fallback).
2. Xác nhận DeepInfra trả `segments` trong `verbose_json`; nếu không, bộ kiểm tra chỉ còn dựa vào nội dung text.
3. Nếu model dịch mặc định có suy luận, token suy luận có thể dùng hết `max_tokens` và mọi bước dịch đều rơi xuống Cloudflare. Xem log fallback ở lần chạy đầu; nếu thấy `empty_response`, đặt `DEEPINFRA_TEXT_REASONING_EFFORT=none`.
4. Đo độ trễ và tỉ lệ fallback bằng k6 (DeepInfra mặc định 200 request đồng thời mỗi model).

Test: `npm run test:deepinfra`, `npm run test:deployment`.
