# Môi trường DEV: `api-dev.hoamytech.com` (nhánh `dev`)

Chạy trên **cùng VPS** với production nhưng tách hẳn:

| | Production | Dev |
|---|---|---|
| Domain | `api.hoamytech.com` | `api-dev.hoamytech.com` |
| Nhánh / workflow | `can-bang-tai` / `Deploy production` | `dev` / `Deploy dev` |
| GitHub environment | `production` | `development` |
| Thư mục VPS | `/opt/homi/backend` | `/opt/homi/backend-dev` |
| Compose project | `speaking-ai-cloudflare` | `speaking-ai-dev` |
| Backend | `backend-3000`, `backend-3001` | `backend` (1 instance) |
| Nginx nội bộ | `127.0.0.1:8080` | `127.0.0.1:8081` |
| Redis | 3 container, cổng 16379–16381 | 3 container riêng, không mở cổng ra host |
| Image trên VPS | `speaking-ai-backend:<sha>` | `speaking-ai-backend-dev:<sha>` |
| SSH key CI | key production | key dev riêng (forced `HOMI_DEPLOY_ENV=dev`) |

Script deploy dùng chung (`deploy/lib.sh`), chọn cấu hình theo `HOMI_DEPLOY_ENV`
(không đặt = production, hành vi cũ giữ nguyên).

RAM dự kiến thêm: ~1 GB backend + ~0,5 GB Redis/nginx. Kiểm tra `free -h` trước.

## Cài đặt một lần (root trên VPS)

**0. Đưa thay đổi script lên production trước.** Merge PR chứa các file này vào `can-bang-tai`
để `remote-entry.sh`/`lib.sh` mới có trong repo trên VPS.

**1. DNS:** bản ghi `A` `api-dev` → IP VPS (nếu dùng Cloudflare proxy: tạm để *DNS only* khi chạy certbot).

**2. Thư mục dev** (root-owned như production).

`SRC` = bản checkout repo trên VPS (chỗ đã chạy `bootstrap-vps.sh` lần đầu), cập nhật về
`can-bang-tai` mới nhất. **Không** dùng `/opt/homi/backend/deploy`: CI chỉ đặt vào đó
`deploy.sh`/`rollback.sh`/`lib.sh`, không có `docker-compose.dev.yml` hay `bootstrap-vps.sh`.
```bash
SRC=/duong-dan/toi/repo        # ví dụ /root/speaking-ai-nextjs-backend
git -C "$SRC" fetch origin && git -C "$SRC" checkout can-bang-tai && git -C "$SRC" pull --ff-only
install -d -m 700 /opt/homi/backend-dev
cp "$SRC/docker-compose.dev.yml" /opt/homi/backend-dev/
cp -r "$SRC/infra" /opt/homi/backend-dev/
```

**3. File môi trường dev** — KHÔNG copy nguyên `.env.local` production:
```bash
cp /opt/homi/backend/.env.local /opt/homi/backend-dev/.env.local
chmod 600 /opt/homi/backend-dev/.env.local
nano /opt/homi/backend-dev/.env.local
```
Bắt buộc đổi:
- `DATABASE_URL` → database **dev riêng** (tạo DB mới, chạy migration vào đó).
- `CLOUDFLARE_POOL_REDIS_PASSWORD` → mật khẩu mới (chỉ dùng cho Redis dev).
- `PWA_ALLOWED_ORIGINS` → origin của frontend dev (nếu có).

Nên đổi: khoá/tài khoản Cloudflare, Cloudinary, R2 bucket riêng cho dev. Redis dev có bộ đếm quota
riêng, nên nếu dùng chung tài khoản Cloudflare thì dev và prod **không thấy quota của nhau**.

```bash
printf 'CLOUDFLARE_POOL_REDIS_PASSWORD=%s\nBACKEND_IMAGE_TAG=local\n' '<cùng mật khẩu như .env.local dev>' \
  > /opt/homi/backend-dev/.env.compose
chmod 600 /opt/homi/backend-dev/.env.compose
```

**4. Bật Redis dev:**
```bash
cd /opt/homi/backend-dev
docker compose --env-file .env.compose -f docker-compose.dev.yml up -d redis redis-cache redis-jobs
```

**5. Key CI cho dev** (trên máy bạn: `ssh-keygen -t ed25519 -f homi-actions-dev -C github-actions-homi-dev -N ""`):
```bash
sudo bash "$SRC/deploy/bootstrap-vps.sh" --env dev "$(cat homi-actions-dev.pub)"
```
Key production trong `authorized_keys` được giữ nguyên. Lệnh này cũng cài `remote-entry.sh` mới
(dùng chung cho cả hai key); trước bước này mọi lượt `Deploy dev` đều bị VPS từ chối — đúng ý muốn.

Mỗi workflow khai báo môi trường đích (`Deploy dev` gửi `--env=dev`, production không gửi gì);
VPS từ chối nếu không khớp với key. Vì vậy dù `development` thiếu `DEPLOY_SSH_KEY` và GitHub
lấy nhầm key production ở cấp repository, code nhánh `dev` cũng **không** lên production.

**6. Nginx host + HTTPS:**
```bash
cp "$SRC/deploy/nginx-host-api-dev.conf.example" /etc/nginx/sites-available/api-dev.hoamytech.com
ln -s /etc/nginx/sites-available/api-dev.hoamytech.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d api-dev.hoamytech.com
```

**7. GitHub:** Settings → Environments → **New environment** `development`, secrets:
`DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER` (giống prod), `DEPLOY_KNOWN_HOSTS` (giống prod),
`DEPLOY_SSH_KEY` = private key **homi-actions-dev**. Xoá private key khỏi máy sau khi nhập.

**8. Tạo nhánh và deploy lần đầu:**
```bash
git checkout -b dev origin/can-bang-tai && git push -u origin dev
```
Workflow `Deploy dev` tự chạy. Lần đầu nó dựng `backend` rồi tự bật `nginx` dev.
Kiểm tra: `curl -fsS https://api-dev.hoamytech.com/api/ready`.

## Hằng ngày

- Code mới → PR vào `dev` (chạy Verify) → merge → tự deploy lên `api-dev`.
- Test xong → PR `dev` → `can-bang-tai` → production.
- Log: `cd /opt/homi/backend-dev && docker compose --env-file .env.compose -f docker-compose.dev.yml logs --tail=100 backend nginx`
- Tag đang chạy: `cat /opt/homi/backend-dev/.deploy/current_tag`
- Rollback dev: `HOMI_DEPLOY_ENV=dev /opt/homi/backend-dev/deploy/rollback.sh [tag]`
- Khởi động lại tay: luôn kèm tag đang chạy (`.env.compose` chỉ có `local`, image đó không tồn tại):
  `BACKEND_IMAGE_TAG=$(cat .deploy/current_tag) docker compose --env-file .env.compose -f docker-compose.dev.yml up -d`
- Tắt dev để trả RAM: `docker compose --env-file .env.compose -f docker-compose.dev.yml stop`
  (không ảnh hưởng production).

## Hàng đợi job BullMQ (worker)

Bật trên dev từ 2026-11-12: `AUDIO_TRANSLATION_JOBS_ENABLED='true'` trong `.env.local` dev và
service `audio-worker` (profile `jobs`) trong `docker-compose.dev.yml`. Client dùng
`POST /api/audio/jobs` hoặc header `Prefer: respond-async` trên `/api/audio/translate` → 202 + `jobId`,
rồi poll `GET /api/audio/jobs/<jobId>`.

`Deploy dev` build cả image worker (GHCR, tag `<sha>-worker`). `deploy.sh` pull về thành
`speaking-ai-audio-worker-dev:<sha>`, và **chỉ khi `audio-worker` đang chạy** thì recreate nó sau
backend rồi kiểm tra: đúng image, vẫn chạy sau 15 giây, không restart. Lỗi → tự rollback cả backend
lẫn worker. Worker đang tắt thì deploy không bật lên (image vẫn được pull sẵn). `rollback.sh` cũng
chuyển worker nếu có image của tag đích; thiếu image thì giữ worker cũ và ghi NOTICE.

Bật worker bằng tay (lần đầu, hoặc sau khi đã tắt):
```bash
cd /opt/homi/backend-dev
BACKEND_IMAGE_TAG=$(cat .deploy/current_tag) docker compose --env-file .env.compose -f docker-compose.dev.yml --profile jobs up -d --no-deps audio-worker
```
Tag trước khi có CI worker (`efade07…`) được build tay trên VPS.
Worker không có cổng HTTP; kiểm tra bằng heartbeat:
`docker exec speaking-ai-dev-redis-jobs-1 redis-cli --no-auth-warning keys 'speaking-ai-audio-jobs:worker:*'`.
Tắt: đặt lại cờ `false`, `docker compose … stop audio-worker` và recreate `backend`.
