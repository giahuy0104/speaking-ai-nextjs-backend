# Audio translation: tải, cache và job nền — cập nhật 28/10/2026

## Kết quả đo và cấu hình được chọn

Đo bằng đúng raw multipart/audio của collection Postman đang có. Baseline và
hai cấu hình concurrency đều chạy 20 client lặp trong 120 giây, không client
retry, tắt cache. Cho các request đang chạy hoàn tất sau cửa sổ gửi; cách này
khác Postman hủy request còn dở khi kết thúc bài test. Backend là `next dev`
trên máy local, provider Cloudflare thật. Kết quả không đánh giá đúng nghĩa.

| Bài đo | Thành công | P50 | P95 | P99 | Quyết định |
| --- | ---: | ---: | ---: | ---: | --- |
| FIFO, text concurrency 4/account | 935/935 | 2.294 ms | 4.865 ms | 6.810 ms | Giữ mặc định |
| Text concurrency 6/account | 953/953 | 2.264 ms | 4.655 ms | 6.649 ms | Chênh lệch nhỏ, chưa đủ để promote |
| Text concurrency 8/account | 894/897 | 2.339 ms | 4.878 ms | 7.056 ms | Không promote; 2 lỗi 422, 1 timeout |
| Cache lạnh, 20 request trùng đồng thời | 20/20 | 3.522 ms | 3.524 ms | 3.543 ms | 1 ASR + 1 text, 19 coalesced |
| Cache nóng, 20 request trùng đồng thời | 20/20 | 816 ms | 825 ms | 842 ms | 20 hit, 0 ASR + 0 text |

P50/P95/P99 trong bảng chỉ lấy request thành công; các báo cáo JSON giữ cả
phân bố toàn bộ request và lỗi. `backendObservations` đối chiếu telemetry,
configVersion và số attempt. Mức 6 chỉ giảm P95 khoảng 4,3% trong một lần đo,
chưa có lần lặp độc lập để khẳng định. Các lỗi ở mức 8 là quan sát của lần đo,
không đủ để kết luận concurrency là nguyên nhân duy nhất của ASR trả rỗng.
Giữ nguyên RPM, burst, account concurrency tổng, model, prompt và beam size 2.

Báo cáo: [baseline](postman/reports/2026-10-27-fifo-sustained-baseline.json),
[concurrency 6](postman/reports/2026-10-27-text-c6-sustained.json),
[concurrency 8](postman/reports/2026-10-27-text-c8-sustained.json),
[cache lạnh](postman/reports/2026-10-27-cache-cold-burst.json),
[cache nóng](postman/reports/2026-10-27-cache-warm-final.json).

Các báo cáo `cache-warm-burst` và `cache-warm-confirm` là lần thử chưa được
chấp nhận: timeout Redis cache 150 ms khiến đường cache không ổn định trong
burst local. Cấu hình cuối dùng timeout kết nối/command 1 giây, fail-open và
cooldown kết nối 5 giây. Báo cáo `cache-warm-final` đã xác nhận mọi request hit.
Không lấy lỗi nhanh hoặc cache hit để suy ra công suất xử lý audio mới.

## Triển khai theo sáu bước

1. Baseline FIFO được lưu trước khi thay đổi đường xử lý.
2. Cache kết quả audio sau xác thực, trước lấy slot AI; cache bản dịch transcript;
   single-flight theo process cho cùng audio/user/contract. Key SHA-256 bao gồm
   byte audio, user, ngôn ngữ, model và policy version. Không đưa audio, transcript
   hoặc token vào key/log. TTL mặc định 300 giây, entry tối đa 64 KiB.
3. Đã thử mức 4/6/8; chọn giữ 4. Không tăng quota provider bằng thay số trong JSON.
4. Có opt-in cắt khoảng lặng đầu/cuối PCM16 WAV bằng ngưỡng bảo thủ và padding
   240/320 ms, giữ nguyên byte của phần speech. Format khác, WAV không chắc chắn
   và audio quá 60 giây đi nguyên trạng. Mặc định **tắt**, chờ kiểm tra chất lượng
   trên audio có reference. Không đổi model hoặc giảm beam để làm đẹp benchmark.
5. Có API job + BullMQ worker, lưu checkpoint ASR để tiếp tục text. Client cũ
   giữ contract đồng bộ; xử lý nền chỉ được yêu cầu rõ qua header hoặc endpoint riêng.
6. Giữ giới hạn FIFO/count/body. Thêm giới hạn distinct cold work/user/process
   (mặc định 4 khi cache bật), giới hạn pending job/user trên Redis (mặc định 10),
   và gate tùy chọn tạm dừng ASR mới khi backlog text đạt ngưỡng. Gate backlog là
   local theo process; quota account/task/model vẫn dùng chung Redis toàn hệ thống.

Single-flight hiện **theo process**; nhiều replica có thể cùng gọi AI khi cùng
cache miss. Redis cache được chia sẻ nhưng chưa có distributed single-flight.
Một subscriber hủy không làm hủy tác vụ còn subscriber khác; tất cả rời đi thì
tác vụ được abort. Client đồng bộ và client cho phép 202 không chia sẻ flight
có thể đổi contract của nhau. RequestId luôn là ID của request hiện tại.

## Hạ tầng local

| Redis | Cổng host | Memory policy | Mục đích |
| --- | --- | --- | --- |
| `speaking-ai-cloudflare-redis` | 16379 | 128 MiB, noeviction, AOF everysec | Quota/lease/cooldown |
| `speaking-ai-audio-cache` | 16380 | 64 MiB, allkeys-lru | Cache có thể mất và tạo lại |
| `speaking-ai-audio-jobs` | 16381 | 128 MiB, noeviction, AOF always | Job, checkpoint, kết quả |

Ba instance tách bộ nhớ; đổi DB index không tạo isolation bộ nhớ. Compose dùng
password local đã có qua env, không ghi password trong source hoặc báo cáo.
Các cổng chỉ bind loopback. Production dùng private network và credentials riêng.

```powershell
npm run redis:up
npm run check:cloudflare-pool -- --validate
# Khi chưa có worker chạy:
npm run audio:worker
# Chạy ở terminal khác:
npm run check:audio-optimization
```

`check:audio-optimization` không gọi inference; kiểm tra PING và heartbeat
worker. Worker cập nhật heartbeat mỗi 5 giây, hết hạn sau 15 giây.
Worker phải có cùng registry/model/namespace Redis quota với API. Không đổi
namespace hoặc xóa Redis keys để né quota. CLI worker dùng flag pool hiện hành;
production không chấp nhận ngoại lệ chia sẻ account legacy của local.

## API và client

- `POST /api/audio/translate`: contract cũ, thành công trả 200.
- Cùng endpoint với `Prefer: respond-async`: khi hết chờ slot/permit có thể lưu
  job và trả 202. Chất lượng không đạt, provider timeout hoặc lỗi mạng không tự
  biến thành job retry inference. Upload vượt bộ nhớ/count trước khi parse vẫn
  có thể trả 429, vì chưa có audio hợp lệ để lưu job.
- `POST /api/audio/jobs`: xác thực và enqueue trực tiếp, trả 202.
- `GET /api/audio/jobs/{jobId}`: kiểm tra installation sở hữu job rồi trả trạng
  thái; `completed` chứa `result`, `failed` chứa lỗi an toàn. 200 ở đây xác nhận
  đọc trạng thái, không đồng nghĩa job thành công. Có createdAt/startedAt/completedAt
  để đo thời gian tiếp nhận, chờ và hoàn tất riêng.

Job bắt buộc bearer installation token, kể cả local đang cho phép client legacy
gọi API đồng bộ. Dùng `Idempotency-Key` 8–128 ký tự; cùng key cùng user trả lại job
đã có, đổi audio/ngôn ngữ/policy dưới key đã có trả 409. Idempotency này áp dụng
job được tiếp nhận; không cam kết inference đồng bộ có exactly-once qua process crash.

202 chỉ được trả sau khi audio/checkpoint đã lưu và enqueue được xác nhận. Nếu
ACK không chắc chắn, trả 503 và giữ khả năng tra lại bằng cùng idempotency key;
không tự gửi lại inference. Hàng job đầy trả 429 + Retry-After. Job khác user hoặc
không tồn tại trả 404. Job hết hạn khi metadata còn tồn tại trả 410; sau cleanup
metadata có thể trả 404.

Client helper ở `src/lib/client/audioTranslationJobs.ts`:

```typescript
const result = await translateAudioWithJobs({
  audio,
  accessToken,
  idempotencyKey: crypto.randomUUID(),
  onJob: job => savePendingJob(job),
});

// Sau khi app mở lại, lấy credential hiện tại và resume, không upload lại audio:
const resultAfterReload = await waitForAudioTranslationJob({
  jobId: savedJob.jobId,
  statusUrl: savedJob.statusUrl,
  accessToken,
});
```

Helper POST đúng một lần, polling theo nextPollMs, có jitter/backoff khi GET
429/503, dừng ở completed/failed hoặc lỗi quyền/hết hạn. Không gửi credential
sang statusUrl khác origin. Việc lưu jobId và tích hợp UI app ngoài repo cần do
client gọi helper thực hiện; không tự đổi màn hình hội thoại hiện có.

## Độ bền, retry và giới hạn

- Audio nằm ở filesystem local (dev) hoặc R2/shared filesystem (production),
  Redis chỉ giữ reference và metadata. Local ghi file rồi fsync/rename trước enqueue.
- Production phải đặt `AUDIO_TRANSLATION_JOB_STORAGE=r2` cùng R2 credentials,
  hoặc chỉ rõ `AUDIO_TRANSLATION_JOB_SHARED_DIRECTORY` là volume dùng chung cho
  API và mọi worker. Đường local mặc định không được dùng trong production.
- Pending tối đa 100 job, 10/user và tổng audio pending 128 MiB. Admission cân
  dung lượng và idempotency bằng Lua nguyên tử. Worker dừng không làm các job
  đã tiếp nhận biến mất khỏi phép đếm capacity khi lease admission hết hạn.
- Job chờ tối đa 15 phút; worker dùng deadline inference hiện hành, cap 30 giây
  và không vượt thời hạn job. Kết quả đọc được trong 1 giờ sau khi kết thúc;
  metadata được giữ tối đa khoảng 1 ngày và có cleanup định kỳ/count cap.
- Tối đa 3 attempt provider cho toàn pipeline, kể cả ASR đã chạy trước handoff.
  Job chỉ retry lỗi admission được xác nhận, backoff có jitter, tối đa 3 lần.
- Worker ghi dấu trước khi gọi provider và checkpoint sau ASR. Nếu process chết
  khi provider đang chạy, recovery kết thúc job với trạng thái lỗi chưa chắc chắn,
  không tự lặp inference có thể đã tính phí. Đây không phải exactly-once inference.
- Audio hoàn tất/thất bại vĩnh viễn được xóa. Worker dọn file local orphan sau
  1 giờ. Với R2 cần lifecycle rule cho prefix `audio-translation-jobs/` để dọn
  object orphan; mã không tự thay đổi cấu hình bucket. Redis AOF local không thay
  thế HA/backup khi triển khai thật.

## Đọc log lỗi và nguồn hủy request

Event `cloudflare_audio_translation_failed` giữ tên cũ và contract API giữ nguyên.
Để xác định nguồn lỗi, đọc các trường chẩn đoán ở cấp ngoài cùng của log:

| Trường | Ý nghĩa |
| --- | --- |
| `failureSource` | `client`, `backend`, `cloudflare`, `network` hoặc `unknown` |
| `abortCause` | `client_disconnect`, `request_deadline`, `attempt_timeout`, `no_subscribers`, `shutdown`, hoặc `unknown` khi có thông tin hủy |
| `requestStage` | Giai đoạn thực tế: upload, authentication, validation, cache_lookup, single_flight_wait, request_admission, asr_admission, asr, text_admission, text_translation hoặc job_enqueue/job_lookup |
| `providerCallStarted`, `providerAttempts` | HTTP request này đã bắt đầu gọi AI chưa và bao nhiêu lần; không phải xác nhận Cloudflare đã nhận request |
| `sharedWorkRequestId` | Request khởi tạo tác vụ khi caller đang chờ chung kết quả; dùng để truy vết lượt gọi AI của tác vụ đó |
| `upstreamStatus`, `upstreamCodes` | Trạng thái HTTP và mã lỗi số của Cloudflare khi quan sát được; không ghi body/message upstream |
| `clientAborted`, `elapsedMs`, `httpStatus` | Tín hiệu kết nối đầu vào đã bị hủy, thời gian xử lý tại server và mã response backend tạo |

Ví dụ caller ngắt kết nối trước khi gọi AI:

```json
{"event":"cloudflare_audio_translation_failed","failureSource":"client","abortCause":"client_disconnect","requestStage":"upload","clientAborted":true,"providerCallStarted":false,"providerAttempts":0,"httpStatus":499}
```

Ví dụ backend hết deadline khi đọc upload:

```json
{"event":"cloudflare_audio_translation_failed","failureSource":"backend","abortCause":"request_deadline","requestStage":"upload","clientAborted":false,"providerCallStarted":false,"httpStatus":504}
```

Ví dụ Cloudflare trả HTTP 503 trong bước dịch:

```json
{"event":"cloudflare_audio_translation_failed","failureSource":"cloudflare","requestStage":"text_translation","upstreamStatus":503,"providerCallStarted":true,"providerAttempts":2,"httpStatus":502}
```

`cloudflare` xác nhận lỗi/phản hồi từ upstream, không tự kết luận Cloudflare có
sự cố: HTTP 401/403 có thể do credential của backend, 429 do quota/rate limit.
`network` là lỗi transport, chưa xác định được phía gây lỗi; `unknown` giữ nguyên
sự không chắc chắn khi gặp AbortError không có nguồn tín hiệu đã được đánh dấu.
`client_disconnect` chỉ xác nhận tín hiệu hủy của kết nối đầu vào: backend không
thể phân biệt thao tác Stop của Postman với reverse proxy đóng kết nối chỉ từ tín hiệu đó.

Khi mọi subscriber rời tác vụ single-flight, event `audio_translation_work_cancelled`
ghi `failureSource=backend, abortCause=no_subscribers`; caller tương ứng vẫn ghi
nguồn hủy của chính nó. Request hoàn tất bình thường không phát sinh event này.
Shutdown hàng chờ được đánh dấu `backend/shutdown`. Event attempt của dispatcher
cũng có `failureSource`, `abortCause`, `upstreamStatus` để đối chiếu bằng requestId.

`details.provider` và `details.stage` thuộc contract lỗi cũ; `stage=asr` có thể là
giá trị mặc định. Dùng `requestStage` và `failureSource` để chẩn đoán, không dùng
nhãn mặc định để quy lỗi upstream. HTTP 499 là response backend tạo; caller đã
đóng kết nối có thể không nhận được response này. Metadata chẩn đoán giữ ở server,
không thêm vào JSON API, không ghi audio, transcript, token hoặc raw abort reason.

Thông báo `error.message` cũng phân biệt nguyên nhân (HTTP status, error code và
`details.reason` giữ nguyên):

| Nguyên nhân | Thông báo API |
| --- | --- |
| Caller đóng kết nối | Yêu cầu đã bị hủy do kết nối từ phía gửi yêu cầu bị ngắt. |
| Hết deadline toàn request | Máy chủ đã dừng yêu cầu dịch audio vì hết thời gian xử lý cho phép. Vui lòng thử lại. |
| Hết thời gian gọi ASR | Đã hết thời gian chờ Cloudflare phản hồi ở bước nhận diện giọng nói. Vui lòng thử lại. |
| Hết thời gian gọi text | Đã hết thời gian chờ Cloudflare phản hồi ở bước dịch văn bản. Vui lòng thử lại. |
| Hàng đợi quá hạn | Yêu cầu đã chờ quá lâu trong hàng đợi xử lý audio. Vui lòng thử lại sau. |
| Giới hạn từ upstream | Cloudflare đang giới hạn số lượng yêu cầu AI. Vui lòng thử lại sau. |
| Upstream trả HTTP 503 khi dịch | Cloudflare trả về lỗi HTTP 503 ở bước dịch văn bản. Vui lòng thử lại sau. |

Khi nguồn hủy/timeout chưa xác định, message chỉ ghi yêu cầu bị hủy/hết thời
gian chờ, không quy lỗi cho Cloudflare. Các message không sử dụng raw provider
message hay raw abort reason. Thông báo này áp dụng cho JSON API do ứng dụng
tạo; trang lỗi 504 do Nginx tạo không đi qua `publicPoolError()`.

### Kiểm chứng logging ngày 28/10/2026

Đã tái hiện lỗi thật khi caller hủy trong lúc upload: Next có thể đã bỏ body
của request, hoặc parser từ chối trước khi listener abort hoàn tất. Backend cũ
ghi nhầm lỗi thiếu/malformed body thành HTTP 400. Upload reader hiện kiểm tra
nguồn hủy trước đọc body và trước khi phân loại lỗi parser, trả đúng lỗi hủy
499 cùng `failureSource=client, abortCause=client_disconnect` khi tín hiệu đó đã hủy.

Trong bài ngắt kết nối có kiểm soát, 20 caller hủy sau 100 ms: backend ghi
15 request `client_disconnect`, 5 request đã hoàn tất trước khi quan sát hủy;
không request bị hủy nào gọi AI. Đây là bài riêng với bài tải thành công.
Xem [báo cáo hủy sau sửa](postman/reports/2026-10-28-cancellation-logging-live-client-abort-fixed.json).

Bài tải cuối trên `localhost:3000`, 20 user trong đủ 60 giây và drain request:
**4.169/4.169 HTTP 200**, P50 269 ms, P95 424 ms, P99 491 ms, max 551 ms.
Toàn bộ là cache hit; kết quả chỉ kiểm tra luồng cache, không phải công suất
xử lý audio mới. Bài trước đó có 1 miss + 19 coalesced + 2.985 hit, 3.005/3.005
HTTP 200; ASR dùng audio-b và text dùng audio-a, mỗi bước một lượt AI thật.
Các lỗi HTTP 429/503 upstream, timeout và abort được kiểm tra bằng provider giả
trong route tests, không cố tạo sự cố ở Cloudflare thật.

[Báo cáo tải cuối](postman/reports/2026-10-28-cancellation-logging-sustained-final.json)
và [đối chiếu log](postman/reports/2026-10-28-cancellation-logging-analysis.json).
Lệnh tái chạy: `npm run benchmark:audio-load -- --clients 20 --seconds 60 --max-requests 10000`.
Giới hạn mặc định 2.000 request vẫn giữ nguyên; `--max-requests` cho phép đặt tối đa
10.000 để bài cache nhanh không kết thúc trước cửa sổ gửi. Report ghi rõ nếu chạm cap.

## Kiểm chứng và rollback

```powershell
npm run test:audio-optimization
npm run test:cloudflare-pool
npm run test:cloudflare
npm run test:cloudflare-text
npm run test:proxy
```

Job integration cần Redis test disposable riêng. Cấp URL job và quota khác
instance; test chỉ dùng account giả, provider giả và namespace riêng:

```powershell
$env:AUDIO_TRANSLATION_JOB_TEST_ISOLATED = "true"
$env:AUDIO_TRANSLATION_JOB_TEST_REDIS_URL = "redis://127.0.0.1:<JOB_TEST_PORT>"
$env:AUDIO_TRANSLATION_JOB_TEST_QUOTA_REDIS_URL = "redis://127.0.0.1:<QUOTA_TEST_PORT>"
npm run test:audio-jobs:redis
```

Đã kiểm tra ownership/idempotency/conflict, job đầy, accepted job vẫn chiếm
capacity khi admission lease hết hạn mà worker chưa chạy, checkpoint tiếp tục
text không lặp ASR, recovery không lặp provider chưa chắc chắn, và API/worker
dùng chung Redis quota thật giữ đúng concurrency của fixture. Test không gọi AI thật.

Nếu Windows khóa build `.next` của dev server, dùng thư mục kiểm tra riêng:

```powershell
$env:AUDIO_TRANSLATION_ISOLATED_BUILD = "true"
npm run build
Remove-Item Env:AUDIO_TRANSLATION_ISOLATED_BUILD
```

Rollback cache/backlog độc lập bằng `AUDIO_TRANSLATION_CACHE_ENABLED=false` và
`CLOUDFLARE_POOL_TEXT_BACKLOG_THRESHOLD=0`. Khi ngừng nhận job mới, cần drain job
đã nhận và giữ GET/worker còn hoạt động trước khi tắt toàn bộ jobs. Không xóa
volume quota/jobs hoặc đổi namespace để rollback. Tắt pool cần giảm tải trước
vì API đồng bộ sẽ quay lại legacy như hành vi sẵn có.
