#!/usr/bin/env bash
# Shared helpers for the VPS deploy/rollback scripts (run as the `deploy` user).
# Rules: never `set -x`, never print environment or secrets, never touch
# .env.local / .env.compose, Redis volumes, host Nginx or certificates.

log() { printf '%s [deploy:%s] %s\n' "$(date -u +%FT%TZ)" "${DEPLOY_ENV:-?}" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Environment profile. Set only by the root-owned forced command in authorized_keys
# (or by hand on the VPS); unset means production, i.e. the original behaviour.
DEPLOY_ENV="${HOMI_DEPLOY_ENV:-production}"
case "$DEPLOY_ENV" in
  production)
    BASE="${HOMI_BACKEND_DIR:-/opt/homi/backend}"
    LOCAL_IMAGE_REPO="speaking-ai-backend"
    PUBLIC_URL="${PUBLIC_URL:-https://api.hoamytech.com}"
    SERVICES=(backend-3000 backend-3001)
    COMPOSE_FILES=(docker-compose.redis.yml docker-compose.nginx.yml)
    DRIFT_PATHS=(docker-compose.redis.yml docker-compose.nginx.yml infra/nginx/nginx.conf infra/redis)
    ENSURE_UP=()
    # Production CI does not build a worker image yet; its rollout is unchanged.
    WORKER_SERVICES=()
    LOCAL_WORKER_REPO=""
    PROFILE_ARGS=()
    ;;
  dev)
    BASE="${HOMI_BACKEND_DIR:-/opt/homi/backend-dev}"
    # Separate image repo so dev pruning can never delete production rollback images.
    LOCAL_IMAGE_REPO="speaking-ai-backend-dev"
    PUBLIC_URL="${PUBLIC_URL:-https://api-dev.hoamytech.com}"
    SERVICES=(backend)
    COMPOSE_FILES=(docker-compose.dev.yml)
    DRIFT_PATHS=(docker-compose.dev.yml infra/nginx/nginx.dev.conf infra/redis)
    # First CI deploy: nginx depends on a healthy backend, so start it once if absent.
    ENSURE_UP=(nginx)
    # BullMQ worker (Compose profile "jobs"). Updated only while it is already running,
    # so turning jobs off (flag false + `stop audio-worker`) survives later deploys.
    WORKER_SERVICES=(audio-worker)
    LOCAL_WORKER_REPO="speaking-ai-audio-worker-dev"
    PROFILE_ARGS=(--profile jobs)
    ;;
  *) die "unknown HOMI_DEPLOY_ENV: $DEPLOY_ENV" ;;
esac
STATE_DIR="$BASE/.deploy"
GHCR_IMAGE="ghcr.io/giahuy0104/speaking-ai-nextjs-backend"
# CI pushes the worker into the same GHCR repo as "<sha>-worker".
WORKER_TAG_SUFFIX="-worker"
KEEP_TAGS=3
# Seconds a recreated worker must stay up without restarting to count as healthy.
WORKER_SETTLE_SECONDS=15
is_sha() { [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]; }
is_tag() { [[ "${1:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; }

# Mirrors /usr/local/bin/homi-backend on the VPS: only .env.compose supplies substitutions
# (.env.local is the bind-mounted app secret and is never interpolated here).
compose() {
  local args=() f
  for f in "${COMPOSE_FILES[@]}"; do args+=(-f "$BASE/$f"); done
  docker compose --project-directory "$BASE" --env-file "$BASE/.env.compose" "${args[@]}" "${PROFILE_ARGS[@]}" "$@"
}

read_state() { cat "$STATE_DIR/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" >"$STATE_DIR/$1.tmp" && mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"; }

# Image tag currently used by a running backend (e.g. "local" before the first CI deploy).
running_tag() {
  local id image
  id="$(compose ps -q "${1:-${SERVICES[0]}}" 2>/dev/null | head -n1)"
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

# --- Worker helpers ---------------------------------------------------------
# A crash-looping worker is "restarting", not "running"; both mean jobs are enabled.
worker_active() { # service
  [[ -n "$(compose ps -q --status running "$1" 2>/dev/null)$(compose ps -q --status restarting "$1" 2>/dev/null)" ]]
}

# Decided once per deploy/rollback, before any container is recreated.
ACTIVE_WORKERS=()
detect_active_workers() {
  local svc
  ACTIVE_WORKERS=()
  for svc in "${WORKER_SERVICES[@]}"; do
    if worker_active "$svc"; then ACTIVE_WORKERS+=("$svc"); else log "$svc not running; leaving it stopped"; fi
  done
}

worker_image_present() { docker image inspect "$LOCAL_WORKER_REPO:$1" >/dev/null 2>&1; }

# The worker has no HTTP port: healthy = expected image, still running after a
# settle period, and no restarts (startup config errors exit immediately).
verify_worker() { # service tag
  local id image running restarts
  id="$(compose ps -q "$1" | head -n1)"
  [[ -n "$id" ]] || { log "$1 is not running"; return 1; }
  image="$(docker inspect --format '{{.Config.Image}}' "$id")"
  [[ "$image" == "$LOCAL_WORKER_REPO:$2" ]] || { log "$1 runs $image, expected $LOCAL_WORKER_REPO:$2"; return 1; }
  sleep "$WORKER_SETTLE_SECONDS"
  running="$(docker inspect --format '{{.State.Running}}' "$id")"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$id")"
  [[ "$running" == "true" && "$restarts" == "0" ]] || { log "$1 unstable (running=$running restarts=$restarts)"; return 1; }
  log "$1 running $2"
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
  for svc in "${ACTIVE_WORKERS[@]}"; do
    worker_image_present "$tag" || continue
    verify_worker "$svc" "$tag" || return 1
  done
  if [[ "${DEPLOY_SIMULATE_READY_FAIL:-0}" == "1" ]]; then
    log "simulated verification failure (test mode)"
    return 1
  fi
  log "verification passed for $tag"
}

# Rolling switch: one backend at a time so Nginx always has a healthy peer.
# --no-deps keeps the Redis containers and their volumes untouched.
# Active workers follow once the backends are up; stop_grace_period lets running jobs finish.
switch_to() { # tag
  local svc
  export BACKEND_IMAGE_TAG="$1"
  for svc in "${SERVICES[@]}"; do
    log "recreating $svc with $LOCAL_IMAGE_REPO:$1"
    compose up -d --no-build --no-deps --wait --wait-timeout 120 "$svc"
  done
  for svc in "${ENSURE_UP[@]}"; do
    [[ -n "$(compose ps -q --status running "$svc" 2>/dev/null)" ]] && continue
    log "starting missing $svc"
    compose up -d --no-build --no-deps --wait --wait-timeout 60 "$svc"
  done
  for svc in "${ACTIVE_WORKERS[@]}"; do
    if ! worker_image_present "$1"; then
      log "NOTICE: $LOCAL_WORKER_REPO:$1 not present; $svc keeps its current image"
      continue
    fi
    log "recreating $svc with $LOCAL_WORKER_REPO:$1"
    compose up -d --no-build --no-deps --wait --wait-timeout 120 "$svc"
  done
}

prune_repo() { # local_repo
  local keep_a keep_b tag n=0
  keep_a="$(read_state current_tag)"
  keep_b="$(read_state previous_tag)"
  while read -r tag; do
    [[ -n "$tag" && "$tag" != "<none>" ]] || continue
    n=$((n + 1))
    ((n <= KEEP_TAGS)) && continue
    [[ "$tag" == "$keep_a" || "$tag" == "$keep_b" ]] && continue
    docker rmi "$1:$tag" >/dev/null 2>&1 && log "pruned old image $1:$tag"
  done < <(docker image ls "$1" --format '{{.Tag}}')
  return 0
}

prune_images() {
  prune_repo "$LOCAL_IMAGE_REPO"
  [[ -n "$LOCAL_WORKER_REPO" ]] && prune_repo "$LOCAL_WORKER_REPO"
  return 0
}
