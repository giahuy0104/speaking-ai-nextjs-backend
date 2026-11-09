# Vận hành pool tài khoản Cloudflare cho audio translation

Module chỉ áp dụng cho `POST /api/audio/translate` khi `CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED=true`. Mặc định flag tắt; caller cũ không truyền execution context vẫn dùng một tài khoản qua `CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_WORKERS_AI_API_TOKEN`. Hội thoại, luyện nghe/nói và TTS giữ cấu hình hiện có.

Ngoại lệ phục vụ thử local với hai account tổng cộng: `CLOUDFLARE_POOL_ALLOW_LEGACY_ACCOUNT_LOCAL_TEST=true` cho phép account legacy có mặt trong registry. Chỉ dùng development/test và Redis loopback; production từ chối. Đây không phải điều phối quota của mọi tính năng legacy. Xem [hướng dẫn Redis local](./redis-local.md#thử-phân-phối-giữa-hai-account-đang-có) trước khi dùng; các yêu cầu tách account bên dưới vẫn áp dụng mặc định và cho production.

Đợt triển khai mã nguồn này không thay credentials hoặc cấu hình deployment, không deploy lên Railway và không xác nhận chất lượng dịch hay năng lực tải production. Đối chiếu phạm vi thiết kế tại [cloudflare-multi-account-architecture.md](./cloudflare-multi-account-architecture.md).

## Chuẩn bị tài khoản và Redis

- Dành riêng tài khoản cho pool. Account ID legacy không được có trong registry, kể cả entry đang disable; thay alias hay tạo token khác cho cùng Account ID không tạo thêm quota. Nếu có hai tài khoản tổng cộng và giữ một tài khoản cho tính năng cũ, pool chỉ còn một tài khoản. Để pool có hai tài khoản riêng cần tổng cộng ba tài khoản.
- Xác nhận quyền truy cập các model đang cấu hình và hạn mức thực tế với Cloudflare. RPM, burst và concurrency bên dưới là chính sách admission của ứng dụng, cần đặt theo hạn mức đã được xác nhận và kết quả staging; các giá trị ví dụ không chứng minh số user hoặc latency.
- Dùng Redis riêng cho kiểm thử; Redis production chỉ lưu metadata quota, identity băm, lease và cooldown. Không lưu token, audio hoặc transcript trong store này. Chọn `rediss://` khi hệ thống Redis yêu cầu TLS.
- Mọi deployment/process dùng cùng các Account ID phải dùng cùng namespace quota. Identity lấy từ Account ID đã chuẩn hóa, không lấy từ alias/token. Không đổi namespace để “reset quota”; hai namespace dùng chung tài khoản có thể cấp tổng permit vượt ngân sách.
- Memory store (`CLOUDFLARE_POOL_STORE=memory`) chỉ dùng dev/test một process; parser từ chối memory khi `NODE_ENV=production`. Không coi nhiều memory store độc lập là một hạn mức chung.

## Cấu hình

Giữ các biến legacy; thêm cấu hình sau vào secret/environment của deployment staging:

```dotenv
CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED=false
CLOUDFLARE_POOL_STORE=redis
CLOUDFLARE_POOL_REDIS_URL=rediss://<USER>:<PASSWORD>@<REDIS_HOST>:<PORT>/0
CLOUDFLARE_POOL_NAMESPACE=speaking-ai-cf-quota-v1
CLOUDFLARE_POOL_CONFIG_VERSION=audio-pool-v1
CLOUDFLARE_POOL_A_TOKEN=<DEDICATED_ACCOUNT_A_TOKEN>
CLOUDFLARE_POOL_B_TOKEN=<DEDICATED_ACCOUNT_B_TOKEN>
CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_STAGE=2
CLOUDFLARE_POOL_MAX_ATTEMPTS_PER_REQUEST=3
CLOUDFLARE_POOL_MAX_WAIT_MS=5000
CLOUDFLARE_POOL_MAX_QUEUED=40
CLOUDFLARE_POOL_MAX_BUFFERED_BYTES=33554432
CLOUDFLARE_POOL_MAX_IN_FLIGHT=20
CLOUDFLARE_POOL_MIN_ATTEMPT_MS=250
```

`CLOUDFLARE_ACCOUNTS_JSON` là JSON một dòng hoặc secret multiline theo deployment. Thay toàn bộ placeholders, đặc biệt Account ID phải là 32 ký tự hex thật và khác tài khoản legacy. JSON chỉ tham chiếu tên biến token; không đặt token trực tiếp vào JSON:

```json
[
  {
    "alias": "audio-a",
    "accountId": "<DEDICATED_ACCOUNT_A_ID>",
    "apiTokenEnv": "CLOUDFLARE_POOL_A_TOKEN",
    "enabled": true,
    "capabilities": {
      "asr": ["@cf/openai/whisper-large-v3-turbo"],
      "text": ["@cf/meta/llama-4-scout-17b-16e-instruct"]
    },
    "limits": {
      "asr": { "rpm": 600, "burst": 10, "maxConcurrent": 10 },
      "text": { "rpm": 240, "burst": 4, "maxConcurrent": 4 },
      "accountMaxConcurrent": 14
    }
  },
  {
    "alias": "audio-b",
    "accountId": "<DEDICATED_ACCOUNT_B_ID>",
    "apiTokenEnv": "CLOUDFLARE_POOL_B_TOKEN",
    "enabled": true,
    "capabilities": {
      "asr": ["@cf/openai/whisper-large-v3-turbo"],
      "text": ["@cf/meta/llama-4-scout-17b-16e-instruct"]
    },
    "limits": {
      "asr": { "rpm": 600, "burst": 10, "maxConcurrent": 10 },
      "text": { "rpm": 240, "burst": 4, "maxConcurrent": 4 },
      "accountMaxConcurrent": 14
    }
  }
]
```

Đổi model qua `CLOUDFLARE_WORKERS_AI_MODEL`/`CLOUDFLARE_TEXT_MODEL` chỉ sau đánh giá riêng; capability registry phải khai báo đúng model được sử dụng. Không dùng thay model/prompt để đo hiệu quả chia tải. Có thể dành account riêng cho một task bằng capability của task còn lại là `[]`, miễn toàn bộ registry có account enabled hỗ trợ cả hai model được cấu hình.

Hạn mức theo model tùy chọn nằm tại `limits.models`, ví dụ:

```json
{
  "models": {
    "@cf/openai/whisper-large-v3-turbo": { "rpm": 120, "burst": 2, "maxConcurrent": 2 }
  }
}
```

Đây là phần bổ sung vào object `limits`. Mỗi attempt phải đồng thời thỏa concurrency tổng account, quota task và quota model nếu khai báo. Hai model ASR không được mỗi model nhận lại toàn bộ quota task. Rate dùng token bucket với burst riêng; không khẳng định tương đương mọi cửa sổ trượt 60 giây của provider.

Parser kiểm tra tối đa 32 account, 32 model/task, RPM không quá 1.000.000, burst và concurrency không quá 10.000. Đây là trần bảo vệ cấu hình, không phải hạn mức Cloudflare. Tối đa hai attempt/stage và ba attempt/request. `MAX_IN_FLIGHT` là số request được xử lý trong mỗi process (mặc định 20, tối đa 1.000); permit Redis áp dụng đồng thời trên các process. Có thể bật chờ ngắn theo mục bên dưới. Năng lực tổng chịu giới hạn tổng permit của các account và tài nguyên từng instance; tăng số instance không nhân RPM của cùng tài khoản.

### Hấp thụ request tăng đột ngột — cập nhật 27/10/2026

Mục tiêu là hấp thụ một đợt request dồn vào, không phải cam kết phục vụ một số user cố định. Giữ nguyên quota/model; request chờ lượt thay vì lập tức nhận 429 khi hai account đang bận.

- `MAX_WAIT_MS=5000`: ngân sách chờ **cộng dồn** cho hàng chờ đầu request, chờ ASR và chờ text, tối đa cấu hình 10.000 ms. Không đặt biến thì giữ hành vi cũ là 0 ms. Thời gian chờ nằm trong deadline tổng, không cộng thêm 5 giây vào timeout 20 giây.
- `MAX_QUEUED=40`: tối đa 40 request chờ đầu vào trên mỗi process; tối đa 40 tác vụ chờ permit bên trong dispatcher đó. Hàng chờ đầu request theo FIFO trong cùng process. Khi bật chờ và có chỗ xếp hàng, các lần xin permit cùng operation/model cũng theo FIFO trong dispatcher đó, đăng ký thứ tự trước lần đọc Redis đầu tiên. Chờ permit không có thứ tự FIFO toàn cục giữa các replica.
- `MAX_IN_FLIGHT=20`: tối đa 20 request xử lý trên mỗi process, gồm cả request đang chờ permit ASR/text. 40 request chờ đầu vào có thể đã parse body nhưng chưa gọi provider.
- `MAX_BUFFERED_BYTES=33554432`: tổng dung lượng raw multipart đã đặt chỗ tối đa 32 MiB trên mỗi process, gồm request đang upload, chờ và xử lý. Giữ chỗ trước `formData()`; request không có Content-Length được tính bằng kích thước request tối đa. Body đọc qua stream bị giới hạn dung lượng và deadline để chặn upload chunked quá lớn hoặc bị treo. Đây là ngân sách byte body, **không phải giới hạn RSS/RAM cứng**: parser, buffer sao chép, Base64 và provider có chi phí RAM bổ sung.
- Chỉ đầu hàng operation/model kiểm tra lại Redis với backoff ngắn và jitter. Cấp permit xong, hủy request hoặc hoàn tất provider sẽ đánh thức hàng chờ local ngay; permit từ process khác vẫn được phát hiện qua polling. Chỉ thao tác xin permit được xếp thứ tự, các lượt inference đã có permit vẫn chạy đồng thời. Không tăng số attempt inference khi chỉ đang chờ, không gọi lại ASR khi text phải chờ. Tất cả phép cấp permit vẫn nguyên tử trong Redis, không đổi namespace hay quota để né giới hạn.
- Client hủy hoặc hết deadline: rời hàng chờ, ngừng đọc/gọi provider. Lượt và byte giữ chỗ được giải phóng trong finally. Đầy hàng/byte trả 429 `queue_full`; hết ngân sách chờ trả 429 `queue_timeout`; hết deadline tổng trả 504. Có `Retry-After` cho lỗi quá tải, kể cả lỗi text đã được bọc thành `LLM_FAILED`.
- Theo dõi `cloudflare_pool_queued`, `cloudflare_pool_request_admitted`, `admissionWaitMs`, `queueDepth`, `queue_full`, `queue_timeout`, `buffer_capacity`. `admissionWaitMs` trong event stage là thời gian chờ của stage đó; event request là chờ hàng đầu vào. `providerElapsedMs` không bao gồm chờ permit.

Đây là hàng chờ HTTP ngắn trong RAM của process, **không phải Redis job queue bền vững**. Redis chỉ giữ quota/lease. Tăng replica làm tăng tổng chỗ chờ và RAM cần dùng nhưng không nhân quota Cloudflare. Process restart hoặc client ngắt kết nối thì request chờ không được khôi phục. Nếu cần lưu hàng nghìn job, chờ dài hoặc tiếp tục sau khi client ngắt, cần thiết kế API job bất đồng bộ và lưu audio ngoài RAM riêng.

Hàng chờ chỉ san bằng đỉnh tải ngắn. Khi tốc độ request đến liên tục vượt khả năng xử lý hoặc hàng đã đầy, 429 vẫn là hành vi bảo vệ cần thiết. Đo burst bằng `benchmark:cloudflare-pool -- --mode burst --clients <N>` (mỗi client đúng một request), sau đó đo sustained riêng. Performance VU lặp liên tục không tương đương một đợt request tăng đột ngột. So sánh success rate và P95 gồm thời gian chờ, không chỉ số lượng 200.

### Sửa chen lượt permit — 27/10/2026

Đối chiếu request `postman-perf-af3b6593-d4e2-46ac-9f66-a3b39f96e093` trong log local: ASR thành công sau 4.130 ms, bước text chờ 5.012 ms rồi trả 429 `queue_timeout`, chưa gọi provider text. Trong khi chờ, các request vào sau đã được cấp permit trước. Bản cũ cho mỗi waiter tự polling nên request mới hoặc waiter tỉnh sớm có thể chen lượt. Bản sửa dùng FIFO local theo operation/model và đánh thức khi có thay đổi permit; không đổi quota, timeout, prompt hoặc model.

Trong cùng lượt Postman có 647 response thành công, một lỗi queue timeout và ba lỗi provider timeout (một ASR gần 20 giây, hai text gần 6 giây): khớp 4/651 lỗi trong ảnh. Ngoài ra log ghi nhận 20 request bị client hủy khi kết thúc tải; không gộp các lượt hủy này vào mẫu 651 response. FIFO xử lý lỗi chen lượt, không bảo đảm loại bỏ timeout provider hoặc 429 khi tải vượt công suất.

Kiểm chứng bản sửa: 76/76 pool/route/compatibility test; 18/18 Cloudflare regression; 4/4 text regression; 10/10 Redis integration trên container disposable riêng; TypeScript và lint hai file thay đổi đạt. Ba test mới tái hiện chen lượt khi waiter đang ngủ, thứ tự trước Redis await, và hủy đầu hàng/thu hồi chỗ chờ; hai test chen lượt đã thất bại trên bản cũ trước khi sửa.

Một burst HTTP local dùng đúng raw body/header Postman, 20 request đồng thời, không client retry: 20/20 HTTP 200, P50 5.009 ms, P95 6.818 ms, cao nhất 8.098 ms. Telemetry ghi cả hai account, đúng 20 ASR + 20 text, có chờ permit, không stage failure. [Báo cáo](./postman/reports/2026-10-27-fifo-smoke.json). Đây là smoke test provider thật, chưa phải sustained test 651 request hay xác nhận chất lượng ngữ nghĩa/production.

Xác minh bản burst ngày 27/10: 73/73 pool/route test; 33/33 regression Cloudflare; 10/10 Redis integration trên container disposable riêng (gồm 24 request đồng thời qua hai runtime dùng chung Redis, provider giả lập, quota không bị vượt). Bốn HTTP request thật gửi đồng thời tới backend local đều trả 200, dùng cả hai account, configVersion `6615f4bdaac2f9e4`. Bốn request thật này chưa cần chờ permit; hành vi xếp hàng được xác nhận trong test burst có kiểm soát, không suy ra công suất production. TypeScript và lint phần thay đổi đạt; build production trong phiên này bị Windows khóa file `.next/build/56416d4ae4ce586f.js` (EPERM), cần chạy lại khi giải phóng file build.

`MIN_ATTEMPT_MS` mặc định 250 là thời gian còn lại tối thiểu trước khi bắt đầu attempt, không phải timeout provider. Deadline tổng audio giữ mặc định 20.000 ms, cap 30.000 ms; text có timeout riêng mặc định 6.000 ms. Retry dùng thời gian còn lại của cùng deadline. Không retry timeout/mạng theo mặc định vì upstream có thể vẫn xử lý và tính phí.

`CONFIG_VERSION` là nhãn an toàn `[a-zA-Z0-9._-]`, tối đa 64 ký tự. Bỏ trống để tạo phiên bản băm từ metadata cấu hình không chứa token. Các process giữ config bất biến theo runtime; thay config/disable account cần rollout đồng bộ.

## Kiểm tra trước khi bật

Chạy unit/compatibility test không cần credentials hoặc gọi inference:

```powershell
npm run test:cloudflare-pool
npm run test:cloudflare
npm run test:cloudflare-text
npm run test:ai-provider
npm run test:cloudflare-only
npm run lint
npm run build
```

Chạy Redis integration trên một server test riêng, với xác nhận isolation rõ ràng:

```powershell
$env:CLOUDFLARE_POOL_TEST_REDIS_URL = "redis://127.0.0.1:<TEST_PORT>/15"
$env:CLOUDFLARE_POOL_TEST_REDIS_CONFIRM_ISOLATED = "true"
npm run test:cloudflare-pool:redis
```

Suite dùng namespace `cf-pool-test-<UUID>` và identity account giả, chỉ xóa key trong namespace của lần chạy, không `FLUSHDB`. Test cần ít nhất hai process tranh cùng quota; kiểm tra Redis TIME/Lua, hết lease, completion lặp/cũ, cooldown, mất Redis và command timeout. Subtest xóa script cache thật để kiểm tra NOSCRIPT chỉ bật thêm `CLOUDFLARE_POOL_TEST_REDIS_ALLOW_SCRIPT_FLUSH=true` trên server disposable chuyên dụng vì `SCRIPT FLUSH` ảnh hưởng script cache của cả server. Không trỏ test vào Redis production hoặc server dùng chung cho nghiệp vụ.

Script kiểm tra cấu hình/Redis mặc định không gọi inference:

```powershell
npm run check:cloudflare-pool
```

Nạp các biến đã chuẩn bị vào process chạy script theo cơ chế environment của máy/deployment. Kiểm tra Redis thành công chỉ xác nhận kết nối và thao tác kiểm tra, không chứng minh quyền model hoặc chất lượng inference. Chỉ dùng `--smoke` khi chủ động cho phép gọi provider và chấp nhận chi phí; xem tùy chọn thực tế bằng `--help`. Không chạy smoke định kỳ bằng inference để kiểm tra sức khỏe account.

Script npm nạp `.env.local` nếu file tồn tại. Khi flag OFF, checker mặc định chỉ báo pool đang tắt; thêm `--validate` để kiểm tra registry/Redis đã chuẩn bị trước khi bật flag. `--smoke` gọi một text inference cho mỗi account enabled hỗ trợ model text đang cấu hình; nó không kiểm chứng quyền ASR. Không dùng smoke thay bộ audio/reference.

Bật flag trên staging sau khi config, Redis và regression đã đạt. Kiểm tra response thành công/error giữ contract, `X-Request-Id`, installation auth, source `en` không gọi text, input invalid không tiêu permit. Không gửi account, token, pool flag hoặc timeout từ multipart/header client.

## Kiểm tra chất lượng và tải

Kiểm tra đúng nghĩa bằng audio có bản chép/reference được duyệt: giọng trẻ, câu ngắn, âm lượng nhỏ/nhiễu, chủ thể, phủ định và nhiều định dạng. Giữ nguyên model, payload, prompt, guards và dataset khi so legacy, pool một account và pool nhiều account. Unit test, HTTP 200 hoặc output có chữ Latin không chứng minh dịch đúng nghĩa. Baseline chất lượng local hiện có tại [audio-translation-optimization.md](./audio-translation-optimization.md) chưa phải xác nhận đạt production.

Script benchmark riêng nhận manifest audio/reference và tách burst với tải liên tục. Chạy `npm run benchmark:cloudflare-pool -- --help` để lấy schema/options hiện hành. Ví dụ sau giả định đã chuẩn bị manifest đúng schema và server local chạy bằng cấu hình staging/test:

```powershell
npm run benchmark:cloudflare-pool -- --manifest <PATH_TO_MANIFEST> --url http://localhost:3000/api/audio/translate --mode burst --clients 20
npm run benchmark:cloudflare-pool -- --manifest <PATH_TO_MANIFEST> --url http://localhost:3000/api/audio/translate --mode burst --clients 100
npm run benchmark:cloudflare-pool -- --manifest <PATH_TO_MANIFEST> --url http://localhost:3000/api/audio/translate --mode sustained --clients 20 --duration-seconds 120
```

Benchmark thực sự gửi HTTP tới endpoint, có thể phát sinh inference và phí nếu server bật provider. Mặc định mục tiêu localhost; `--allow-remote` là opt-in rõ ràng cho URL staging đã xác nhận. Không dùng URL production cho các ví dụ. Bảo vệ credentials installation của harness bằng environment theo hướng dẫn script; không đưa token vào manifest, command output hoặc báo cáo.

Manifest có dạng `{ "samples": [{ "audioPath": "./sample.mp3", "sourceLanguage": "vi", "referenceEnglish": "Hello.", "mimeType": "audio/mpeg" }], "clientId": "<TEST_CLIENT_ID>" }`. Audio path tương đối với manifest; `referenceEnglish`, `mimeType`, `clientId` là tùy chọn. Bearer installation nằm trong `CLOUDFLARE_POOL_BENCHMARK_AUTH_TOKEN`. Báo cáo không ghi audio/transcript/reference/token; `--output <PATH>` ghi metrics và trạng thái từng request. Exact reference match chỉ là đối chiếu văn bản, không thay đánh giá đúng nghĩa. Admitted rate và provider time phải lấy từ telemetry backend, vì HTTP client không quan sát trực tiếp permit.

Burst phải ghi độ lệch thời điểm gửi thực tế và mỗi client gửi đúng một request; tải liên tục đo riêng 20/50/100 VU. Tách success/failure, attempted/admitted rate, 429/422/5xx, latency P50/P95/P99 của request thành công, end-to-end, retry amplification và đánh giá đúng nghĩa. Không lấy request lỗi nhanh để báo cải thiện tốc độ. CPU/RAM của máy phát tải khác CPU/RAM backend Railway; đo cả hai. Chạy các tính năng cũ đồng thời để phát hiện tranh tài nguyên backend dù tài khoản đã tách.

Chỉ dùng mock/staging cho lỗi 429, timeout, Redis chết và process bị kill. Không tạo sự cố chủ động trên production. Mục tiêu 100 user/P95 5 giây/99% trong tài liệu kiến trúc chưa được xác nhận đạt; cần workload và hạn mức cụ thể để nghiệm thu.

## Quan sát và xử lý sự cố

Theo dõi event `cloudflare_pool_admission`, `cloudflare_pool_attempt_completed`, `cloudflare_pool_cooldown`, `cloudflare_pool_unavailable`, `cloudflare_pool_cleanup_failed`. Event chỉ chứa metadata allowlist như alias, stage, model, attempt, safe reason, latency và configVersion; không có Account ID thật, token, audio, transcript hoặc raw provider body. `requestId` dùng trace/log, không làm metric label.

| Hiện tượng | Kiểm tra và hành động |
| --- | --- |
| 429 từ admission | Xem permit, token bucket, concurrency task/model/account và local in-flight. Giảm tải hoặc bổ sung account/quota đã được xác nhận; không bỏ admission. |
| Provider 429/4006 | Xem safe codes và cooldown. Mã chưa rõ không chứng minh hết Neurons/RPM/billing. Retry-After được dùng trong scope account/task thích hợp; tối đa một lần thử account khác theo stage và budget. |
| 401/403 hoặc credential bị vô hiệu | Account vào cooldown dài 24 giờ và probe có kiểm soát sau đó. Disable account qua registry rồi rollout đồng bộ trong khi sửa quyền/token; không đổi namespace để bỏ cooldown và không xoay vô hạn qua pool. |
| Timeout/lỗi mạng | Đối chiếu deadline, provider latency và hạ tầng. Không bật retry mù vì inference upstream có thể tiếp tục. |
| Transcript rỗng/độ tin cậy thấp hoặc sai ngôn ngữ | Xử lý chất lượng/input riêng; không phạt sức khỏe account hay chạy lại mọi tài khoản. |
| Redis mất kết nối/timeout | Pooled workload trả lỗi dịch vụ có kiểm soát (503), không tự rơi về memory hoặc legacy. Khôi phục Redis; permit có thể giữ dư tạm thời do kết quả command chưa chắc chắn. |
| Cleanup thất bại/process chết | Theo dõi TTL lease và Redis. Không xóa lease đang chạy; lease hết hạn tránh kẹt slot vĩnh viễn. Completion phải idempotent và không được xóa lease mới. |

Cooldown được ghi nguyên tử với release lease; sau cooldown chỉ một probe được permit để tránh nhiều instance gọi lại cùng lúc. Provider callback giữ lease đến khi đọc xong body. Rate đã tiêu không được hoàn lại khi trạng thái upstream không chắc chắn. Redis key trong cùng script dùng hash slot theo identity account; admission nguyên tử theo từng account.

Chi phí thực tế đối chiếu dashboard/billing Cloudflare. Số attempt giúp đo amplification, không suy ra một số Neurons cố định mỗi request; thêm account không bảo đảm tốc độ/chi phí thay đổi tuyến tính.

## Thêm, disable và rollback

Để thêm account: tạo token cho account dành riêng, xác nhận capability/quota, thêm env token và registry entry với alias duy nhất, kiểm tra config/Redis, rồi rollout các process dùng cùng registry/version. Chỉ enable sau kiểm chứng model. Disable bằng `enabled=false` rồi rollout đồng bộ; token entry disable có thể bỏ trống. Không dùng alias/token khác để khai báo lại Account ID đã có.

Rollback bằng tắt `CLOUDFLARE_AUDIO_TRANSLATION_POOL_ENABLED` hoặc quay lại artifact trước đó. Trước đó dừng load test, giảm/điều hướng traffic endpoint: flag OFF đưa audio translation trở lại tài khoản legacy và có thể dồn tải vào các tính năng cũ. Giữ credentials legacy xuyên suốt rollout. Khi OFF, request legacy không parse registry hoặc mở Redis; config pool hỏng không chặn các feature cũ hoặc build.

Không xóa Redis keys còn lease, không thay namespace/schema trong khi các version vẫn cùng tiêu quota tài khoản mà chưa có kế hoạch phối hợp. Hạ tầng Redis, account secrets, staging, bộ audio/reference, load test và phê duyệt phát hành vẫn cần được chuẩn bị riêng; mã nguồn không tự thực hiện rollout production.

## Kết quả xác minh mã nguồn ngày 26/10/2026

| Kiểm tra | Kết quả |
| --- | --- |
| `test:cloudflare-pool` | 58/58 pass; core, memory, Redis client giả lập, wrapper compatibility và route với installation auth thật |
| Redis integration trên container Redis 7.4 Alpine riêng | 9/9 pass; hai process tranh quota, rate retention, TTL/completion cũ, cooldown/probe, NOSCRIPT, command timeout và disconnect |
| Cloudflare/Cloudflare text/AI provider/Cloudflare only | 33/33 pass |
| Translation/transcript/TTS cache/storage/installation auth/admin auth/proxy/app version | 200/200 lượt test pass |
| Cloudinary TTS test | 3/3 pass; sửa khai báo kiểu mock và env fixture app-version để TypeScript build được, không đổi assertion hoặc runtime các tính năng này |
| `npm run lint`, TypeScript và `npm run build` | Pass |
| Checker config + Redis PING | Pass bằng registry/account giả và Redis test; không inference |
| Benchmark burst với HTTP server giả lập | Đúng 20 request; 15 success và 5 lỗi 429 được thống kê riêng |

Redis test chỉ dùng namespace/account giả; container đã được xóa sau kiểm tra. Không đổi `.env.local`, credentials thật hoặc deployment. Chưa chạy provider smoke, semantic evaluation, burst/load thật hoặc canary. Các kết quả trên xác nhận hành vi mã nguồn và hạ tầng điều phối trong test, chưa xác nhận mục tiêu 100 user/P95 5 giây/99%.
