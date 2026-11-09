#!/usr/bin/env bash
# Manual rollback to the previous (or a named) image tag already present on the VPS.
#   rollback.sh            -> tag stored in .deploy/previous_tag
#   rollback.sh <tag|sha>  -> that tag (must exist as speaking-ai-backend:<tag>)
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mkdir -p "$STATE_DIR"
cd "$BASE"
exec 9>"$STATE_DIR/lock"
flock -n 9 || die "another deploy/rollback is already running"

current="$(read_state current_tag)"
target="${1:-$(read_state previous_tag)}"
[[ -n "$target" ]] || die "no previous tag recorded; pass one explicitly"
is_tag "$target" || die "invalid tag: $target"
docker image inspect "$LOCAL_IMAGE_REPO:$target" >/dev/null 2>&1 \
  || die "image $LOCAL_IMAGE_REPO:$target not found locally (run a deploy for that SHA instead)"

log "manual rollback: ${current:-unknown} -> $target"
if switch_to "$target" && verify_stack "$target"; then
  [[ -n "$current" && "$current" != "$target" ]] && write_state previous_tag "$current"
  write_state current_tag "$target"
  log "ROLLBACK OK: $target"
else
  die "rollback to $target failed verification; check: docker compose ps / logs"
fi
