# Sửa 502 dịch đa ngôn ngữ — Railway production

## Kết quả

Đã triển khai và kiểm tra bằng Chrome hồ sơ **HuaMei - A Huy**, project `backend-cloudflare`, environment `production`.

| Dịch vụ | Commit | Deployment | Trạng thái đã xác nhận |
| --- | --- | --- | --- |
| speaking-ai-nextjs-backend | `41fdabb488b819b955963bd5b935a50058b31bd6` | `1d3fc48c-beed-407a-90b3-3721cd7c13b9` | Active / Deployment successful |
| audio-translation-worker | `68cc948b344ed294ac72e16af06a2b68c8ac3c37` | `8ffd6949-bc5b-4fa6-a017-5f7adf546f3d` | Active / Deployment successful / audio_translation_worker_ready |

Worker được cập nhật cùng mã ứng dụng; hai file triển khai `Dockerfile` và `railway.json` riêng của nhánh worker được giữ nguyên. Không thay cờ jobs, credential, thanh toán hay giới hạn quota.

## Nguyên nhân và cách sửa

Code cũ từ chối mọi bản dịch chứa CR/LF và mọi đầu ra dài hơn 500 ký tự, ngay cả khi đó là bản dịch nhiều câu hợp lệ. Code mới chuẩn hóa whitespace và chỉ bỏ đúng cặp dấu ngoặc kép bao ngoài; không cắt bỏ câu. Giới hạn đầu ra là 2.000 ký tự; ngân sách completion đa ngôn ngữ tăng từ 128 lên 512 token.

Đầu ra rỗng, thiếu hệ chữ yêu cầu, quá dài, bị cắt bởi token budget, bị content filter hoặc trả tool call vẫn bị chặn. Các trường hợp này có `reason` riêng; không giả vờ trả thành công. Không bổ sung retry inference. Luồng tiếng Anh giữ nguyên prompt, ngân sách token và shape kết quả.

Không thể khôi phục payload của lỗi cũ lúc 14:33:23 vì log lúc đó không lưu thông tin đầu ra. Tuy nhiên, production sau sửa đã tái hiện trường hợp có xuống dòng: request `mlfix-20261029-fr-multiple-sentences-76f258` có `hadLineBreaks:true`, `normalizationApplied:true`, `finishReason:stop`, API trả **200**. Với code cũ, cùng đầu ra này sẽ bị từ chối 502.

## Log mới

- `target_translation_completed`: requestId, language, model, sourceLength, rawLength, normalizedLength, hadLineBreaks, normalizationApplied, finishReason, completionTokens, upstreamStatus, latencyMs.
- `target_translation_failed`: thêm reason, stage, code, status, errorType, failureSource, abortCause/upstreamCodes nếu có.
- `target_translation_pipeline_completed`: xác nhận hoàn thành pipeline, audioSource, audioReady và latency.
- `target_translation_audio_unavailable`: phân biệt lỗi giọng đọc bằng stage `tts`, model, reason và upstreamStatus.

Không ghi nội dung lời nói, bản dịch thô hay credential vào các log mới. `finishReason` và token usage được lọc trước khi ghi. Pool attempt giữ UUID `legacy-...`, thêm `parentRequestId` để truy về request API. Parent được lưu trong execution context từng request; không capture trong telemetry sink của dispatcher dùng chung. Regression test kiểm tra cả sink production và sink tùy chỉnh với nhiều parent khác nhau và ID không an toàn.

Ví dụ lọc Railway:

```text
@event:target_translation_failed
```

```text
@requestId:REQUEST_ID OR @parentRequestId:REQUEST_ID
```

```text
@event:target_translation_audio_unavailable AND @upstreamStatus:402
```

Lưu ý trường `status:502` trong warning TTS là trạng thái lỗi nội bộ của bước tạo giọng đọc, không có nghĩa request hội thoại trả HTTP 502: pipeline bắt lỗi đó và vẫn trả HTTP 200 với `audioUrl:null`, `audioSource:device_tts`.

## Kiểm tra

- Toàn bộ integration: **447/447 passed, 0 failed, 0 skipped**, Redis/PostgreSQL dùng container riêng, không nạp credential production.
- ESLint và TypeScript: passed.
- Hai Linux image web/worker: build passed.
- Smoke container: **19/19 passed**, bao gồm auth, CORS, readiness, worker heartbeat và SIGTERM cleanup.
- Trợ lí AI độc lập review theo từng phần; đã rà lại tương tác singleton/parentRequestId và xác nhận bản cuối không còn blocker trong phạm vi sửa 502.
- Production: health/ready 200; **7 request hợp lệ** trên JSON `/api/conversation` trả 200: ba mẫu Pháp (ngắn, nhiều câu, dài trong giới hạn), Trung, Nhật, Hàn và đối chứng tiếng Anh.
- Một negative test vượt giới hạn **45 từ** đầu vào nhận đúng 422 `ASR_LOW_CONFIDENCE`; log `asr_transcript_rejected`, reason `too_long`. Không nới giới hạn này trong bản sửa.
- Hai installation chỉ phục vụ probe đã được revoke thành công (200); token chỉ giữ trong bộ nhớ tiến trình, không lưu trong báo cáo.
- Kết quả production có requestId và timing nằm trong `2026-10-29-multilingual-production-check.json` cạnh tài liệu này. Chỉ dùng câu giả lập do người kiểm tra tạo, không dùng bản ghi âm người thật.

## Các vấn đề còn riêng biệt

1. Cloudflare Grok TTS vẫn trả **402 / 2021** trên `audio-a`; cần kiểm tra credit/billing của Cloudflare. Bản dịch vẫn trả về, Flutter cần hỗ trợ `device_tts`. Bản phát hành này không nạp tiền hay thay model TTS.
2. Probe tiếng Pháp ngắn `Con muốn uống nước.` trả `L'enfant veut boire de l'eau.`: đúng HTTP nhưng chuyển ngôi người nói. Đây là vấn đề chất lượng ngữ nghĩa chưa được xử lý trong bản sửa 502; không coi HTTP 200 là chứng nhận bản dịch luôn đúng nghĩa. Prompt đa ngôn ngữ không thay đổi trong release này.
3. Web HTTP jobs vẫn giữ trạng thái triển khai trước đó; việc xác nhận bucket private và bật jobs HTTP không thuộc bản sửa này.
