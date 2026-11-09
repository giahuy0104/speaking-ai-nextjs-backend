# CI/CD: GitHub Actions → VPS (nhánh `can-bang-tai`)

Luồng: PR vào `can-bang-tai` chạy `Verify deployment` (lint, test tích hợp, build production
của image `web` và `worker`). Push/merge vào `can-bang-tai` chạy `Deploy production`:
`guard` → `verify` → `build-push` (image GHCR tag = commit SHA) → `deploy` (SSH vào VPS).

Trên VPS (`/opt/homi/backend`): pull image, gắn tag `speaking-ai-backend:<sha>`, khởi động lại
**lần lượt** `backend-3000` rồi `backend-3001` (`--no-deps`, không đụng Redis/volume/Nginx), kiểm tra
cả hai instance `/api/health` + `/api/ready`, Nginx nội bộ và `https://api.hoamytech.com`.
Nếu không đạt → tự rollback về tag trước và job báo đỏ.

Không bị thay đổi: `.env.local`, `.env.compose`, volume Redis, Nginx host, chứng chỉ HTTPS, DNS,
frontend Netlify. Secrets không nằm trong repo/image/log.

## Secrets cần có (GitHub → Settings → Environments → `production`)

| Secret | Nội dung (không ghi giá trị ở đây) |
|---|---|
| `DEPLOY_HOST` | IP/hostname VPS |
| `DEPLOY_PORT` | Cổng SSH (mặc định 22) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | Private key riêng cho Actions (ed25519) |
| `DEPLOY_KNOWN_HOSTS` | Kết quả `ssh-keyscan -p <port> <host>` đã đối chiếu fingerprint |

Image GHCR dùng `GITHUB_TOKEN` của từng lượt chạy; không cần PAT.

## Cài đặt một lần

1. Trên máy bạn: `ssh-keygen -t ed25519 -f homi-actions -C github-actions-homi -N ""`.
2. Trên VPS, bằng root (bạn tự chạy), đã có repo này: `sudo bash deploy/bootstrap-vps.sh "$(cat homi-actions.pub)"`.
   Script tạo user `deploy`, cài `remote-entry.sh` (root-owned, key chỉ được chạy lệnh `deploy`/`rollback`).
3. Lấy host key: `ssh-keyscan -p <port> <host>`; đối chiếu fingerprint với VPS (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
4. Nhập 5 secrets ở trên; xoá file private key khỏi máy sau khi nhập.
5. Package GHCR phải cho phép repo này đọc (mặc định theo repo).

## Deploy thủ công

GitHub → Actions → **Deploy production** → *Run workflow* (chọn nhánh `can-bang-tai`).
- `sha`: bỏ trống = đầu nhánh; hoặc dán SHA 40 ký tự đã có trên nhánh để deploy lại bản cũ.
- CI **không** ghi `docker-compose.*.yml`/`infra/` lên VPS; nếu bản repo khác VPS, log chỉ báo `NOTICE`. Đổi cấu hình VPS do root làm tay.
- `simulate_ready_fail`: **chỉ để test rollback**.

## Xem log

- Actions: log từng job (không chứa secrets).
- VPS: `homi-backend ps`; `docker compose --env-file .env.local -f docker-compose.redis.yml -f docker-compose.nginx.yml logs --tail=100 nginx backend-3000 backend-3001`.
- Tag đang chạy: `cat /opt/homi/backend/.deploy/current_tag` (trước đó: `previous_tag`).

## Rollback

- Tự động khi deploy lỗi.
- Thủ công qua Actions: chạy lại workflow với `sha` của bản tốt.
- Thủ công trên VPS (user có quyền docker): `/opt/homi/backend/deploy/rollback.sh` (về `previous_tag`) hoặc `... rollback.sh <tag>`.
  Chỉ hoạt động với image còn trên VPS (giữ 3 tag gần nhất).

## Thu hồi quyền

- Thành viên: GitHub → Settings → Collaborators → Remove; hoặc nhánh được bảo vệ nên họ không thể merge nếu thiếu review.
- Key Actions: xoá dòng trong `/home/deploy/.ssh/authorized_keys`, đổi `DEPLOY_SSH_KEY` và chạy lại bước cài đặt.
- Khoá toàn bộ deploy: `sudo usermod -L deploy`.

## Lưu ý vận hành

- `.env.compose` giữ `BACKEND_IMAGE_TAG` cũ. `bootstrap-vps.sh` vá `/usr/local/bin/homi-backend` (có bản sao `.bak-before-cicd`)
  để ưu tiên `.deploy/current_tag`, nên `homi-backend up/restart` không kéo về tag cũ.
- `infra/nginx/nginx.conf` trong repo đã có `map $origin_scheme` giống VPS (giữ `X-Forwarded-Proto` qua hai tầng Nginx).
- Migration cơ sở dữ liệu **không** nằm trong pipeline này; chạy riêng trước khi merge nếu cần.
- User `deploy` thuộc nhóm `docker` (tương đương quyền cao trên host); key bị giới hạn bằng forced command.
