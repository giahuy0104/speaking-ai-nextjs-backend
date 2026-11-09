#!/usr/bin/env bash
# Shared helpers for the VPS deploy/rollback scripts (run as the `deploy` user).
# Rules: never `set -x`, never print environment or secrets, never touch
# .env.local / .env.compose, Redis volumes, host Nginx or certificates.

BASE="${HOMI_BACKEND_DIR:-/opt/homi/backend}"
STATE_DIR="$BASE/.deploy"
LOCAL_IMAGE_REPO="speaking-ai-backend"
GHCR_IMAGE="ghcr.io/giahuy0104/speaking-ai-nextjs-backend"
PUBLIC_URL="${PUBLIC_URL:-https://api.hoamytech.com}"
KEEP_TAGS=3
SERVICES=(backend-3000 backend-3001)

log() { printf '%s [deploy] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
is_sha() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
is_tag() { [[ "${1:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; }

# Mirrors /usr/local/bin/homi-backend on the VPS: only .env.compose supplies substitutions
# (.env.local is the bind-mounted app secret and is never interpolated here).
compose() {
  docker compose --project-directory "$BASE" --env-file "$BASE/.env.compose"     -f "$BASE/docker-compose.redis.yml" -f "$BASE/docker-compose.nginx.yml" "$@"
}

read_state() { cat "$STATE_DIR/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" >"$STATE_DIR/$1.tmp" && mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"; }

# Image tag currently used by a running backend (e.g. "local" before the first CI deploy).
running_tag() {
  local id image
  id="$(compose ps -q "${1:-backend-3000}" 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || return 0
  image="$(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null || true)"
  [[ "$image" == "$LOCAL_IMAGE_REPO":* ]] && printf '%s' "${image#"$LOCAL_IMAGE_REPO":}"
  return 0
}

wait_for() { # attempts delay command...
  local attempts="$1" delay="$2" i
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    "$@" && return 0
    sleep "$delay"
  done
  return 1
}

# Probe from inside the container (same check as the Compose healthcheck).
probe_service() { # service path
  compose exec -T "$1" node -e "fetch('http://127.0.0.1:'+process.env.PORT+'$2',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

http_ok() { curl -fsS --max-time 10 -o /dev/null "$1" 2>/dev/null; }

nginx_url() {
  local hostport
  hostport="$(compose port nginx 80 2>/dev/null | head -n1)"
  [[ -n "$hostport" ]] || return 1
  printf 'http://%s' "${hostport/0.0.0.0/127.0.0.1}"
}

# Success = both instances run the expected tag and pass /api/health + /api/ready,
# and traffic works through the internal Nginx and the public HTTPS endpoint.
verify_stack() { # expected_tag
  local tag="$1" svc id image nginx
  for svc in "${SERVICES[@]}"; do
    id="$(compose ps -q "$svc" | head -n1)"
    [[ -n "$id" ]] || { log "$svc is not running"; return 1; }
    image="$(docker inspect --format '{{.Config.Image}}' "$id")"
    [[ "$image" == "$LOCAL_IMAGE_REPO:$tag" ]] || { log "$svc runs $image, expected $LOCAL_IMAGE_REPO:$tag"; return 1; }
    wait_for 20 3 probe_service "$svc" /api/health || { log "$svc: /api/health failed"; return 1; }
    wait_for 20 3 probe_service "$svc" /api/ready || { log "$svc: /api/ready failed"; return 1; }
    log "$svc healthy and ready"
  done
  nginx="$(nginx_url)" || { log "cannot resolve nginx port"; return 1; }
  wait_for 10 3 http_ok "$nginx/api/ready" || { log "nginx -> /api/ready failed"; return 1; }
  wait_for 10 3 http_ok "$PUBLIC_URL/api/health" || { log "public /api/health failed"; return 1; }
  wait_for 10 3 http_ok "$PUBLIC_URL/api/ready" || { log "public /api/ready failed"; return 1; }
  if [[ "${DEPLOY_SIMULATE_READY_FAIL:-0}" == "1" ]]; then
    log "simulated verification failure (test mode)"
    return 1
  fi
  log "verification passed for $tag"
}

# Rolling switch: one backend at a time so Nginx always has a healthy peer.
# --no-deps keeps the Redis containers and their volumes untouched.
switch_to() { # tag
  local svc
  export BACKEND_IMAGE_TAG="$1"
  for svc in "${SERVICES[@]}"; do
    log "recreating $svc with $LOCAL_IMAGE_REPO:$1"
    compose up -d --no-build --no-deps --wait --wait-timeout 120 "$svc"
  done
}

prune_images() {
  local keep_a keep_b tag n=0
  keep_a="$(read_state current_tag)"
  keep_b="$(read_state previous_tag)"
  while read -r tag; do
    [[ -n "$tag" && "$tag" != "<none>" ]] || continue
    n=$((n + 1))
    ((n <= KEEP_TAGS)) && continue
    [[ "$tag" == "$keep_a" || "$tag" == "$keep_b" ]] && continue
    docker rmi "$LOCAL_IMAGE_REPO:$tag" >/dev/null 2>&1 && log "pruned old image tag $tag"
  done < <(docker image ls "$LOCAL_IMAGE_REPO" --format '{{.Tag}}')
  return 0
}
