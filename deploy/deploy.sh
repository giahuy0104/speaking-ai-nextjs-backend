#!/usr/bin/env bash
# Deploy one commit: pull ghcr image tagged with the SHA, rolling-restart both
# backends, verify, and automatically roll back if verification fails.
#
# Usage (normally invoked by remote-entry.sh):
#   GHCR_USER=.. GHCR_TOKEN=.. deploy.sh <40-char-sha> [--simulate-fail]
# Optional env: HOMI_INCOMING=<dir with files shipped by CI>
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sha="${1:-}"
shift || true
is_sha "$sha" || die "first argument must be a full 40-char commit SHA"
for flag in "$@"; do
  case "$flag" in
    --simulate-fail) export DEPLOY_SIMULATE_READY_FAIL=1 ;;
    *) die "unknown option: $flag" ;;
  esac
done

mkdir -p "$STATE_DIR"
cd "$BASE"
exec 9>"$STATE_DIR/lock"
flock -n 9 || die "another deploy/rollback is already running"

previous="$(read_state current_tag)"
[[ -n "$previous" ]] || previous="$(running_tag)"
log "target=$sha previous=${previous:-none}"

# --- Config drift check (report only: CI never writes compose/nginx/redis files on the VPS) ---
incoming="${HOMI_INCOMING:-}"
if [[ -n "$incoming" && -d "$incoming" ]]; then
  drift=0
  for f in "${DRIFT_PATHS[@]}"; do
    diff -rq "$incoming/$f" "$BASE/$f" >/dev/null 2>&1 || drift=1
  done
  ((drift)) && log "NOTICE: compose/infra in the repo differ from the VPS copies (left untouched; apply manually as root if intended)"
fi

# --- Pull image (temporary docker config; token never persisted) ---
[[ -n "${GHCR_USER:-}" && -n "${GHCR_TOKEN:-}" ]] || die "GHCR credentials missing"
docker_cfg="$(mktemp -d "$STATE_DIR/docker-config.XXXXXX")"
cleanup() { rm -rf "$docker_cfg"; }
trap cleanup EXIT
export DOCKER_CONFIG="$docker_cfg"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
unset GHCR_TOKEN
log "pulling $GHCR_IMAGE:$sha"
docker pull --quiet "$GHCR_IMAGE:$sha" >/dev/null
docker tag "$GHCR_IMAGE:$sha" "$LOCAL_IMAGE_REPO:$sha"
docker rmi "$GHCR_IMAGE:$sha" >/dev/null 2>&1 || true
rm -rf "$docker_cfg"
unset DOCKER_CONFIG

# --- Switch + verify ---
rollback_to_previous() {
  if [[ -z "$previous" ]]; then
    log "no previous tag known; cannot roll back automatically. Investigate manually."
    return 1
  fi
  log "ROLLING BACK to $previous"
  DEPLOY_SIMULATE_READY_FAIL=0
  if switch_to "$previous" && verify_stack "$previous"; then
    write_state current_tag "$previous"
    log "rollback to $previous succeeded"
    return 0
  fi
  log "ROLLBACK ALSO FAILED. Manual intervention required."
  return 1
}

if switch_to "$sha" && verify_stack "$sha"; then
  [[ -n "$previous" && "$previous" != "$sha" ]] && write_state previous_tag "$previous"
  write_state current_tag "$sha"
  prune_images
  log "DEPLOY OK: $sha"
else
  log "DEPLOY FAILED for $sha"
  rollback_to_previous || true
  exit 1
fi
