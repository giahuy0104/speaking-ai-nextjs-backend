#!/usr/bin/env bash
# SSH forced command for the GitHub Actions key (authorized_keys: restrict,command="...").
# Installed root-owned at /opt/homi/deploy-bin/remote-entry.sh by bootstrap-vps.sh so the
# deploy user (and CI) cannot rewrite it. Accepts ONLY:
#   deploy <40-char-sha> [--simulate-fail]   (stdin: "<user> <token>\n" + tar.gz)
#   rollback [tag]
#
# The environment comes ONLY from the forced command written by root, e.g.
#   command="HOMI_DEPLOY_ENV=dev /opt/homi/deploy-bin/remote-entry.sh"
# Unset = production. The client cannot choose it (SSH_ORIGINAL_COMMAND is not parsed for it).
set -Eeuo pipefail

fail() { echo "remote-entry: $*" >&2; exit 2; }

export HOMI_DEPLOY_ENV="${HOMI_DEPLOY_ENV:-production}"
case "$HOMI_DEPLOY_ENV" in
  production) BASE=/opt/homi/backend ;;
  dev) BASE=/opt/homi/backend-dev ;;
  *) fail "unknown environment" ;;
esac
export HOMI_BACKEND_DIR="$BASE"
STATE_DIR="$BASE/.deploy"
read -r -a args <<<"${SSH_ORIGINAL_COMMAND:-}"
cmd="${args[0]:-}"

install_shipped_scripts() { # dir
  install -d -m 700 "$BASE/deploy"
  install -m 700 "$1/deploy/deploy.sh" "$1/deploy/rollback.sh" "$1/deploy/lib.sh" "$BASE/deploy/"
}

case "$cmd" in
  deploy)
    sha="${args[1]:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid sha"
    extra=("${args[@]:2}")
    for f in "${extra[@]}"; do
      [[ "$f" == "--simulate-fail" ]] || fail "unsupported option"
    done

    IFS=' ' read -r GHCR_USER GHCR_TOKEN
    [[ "$GHCR_USER" =~ ^[A-Za-z0-9-]{1,39}$ && -n "$GHCR_TOKEN" ]] || fail "bad credentials line"
    export GHCR_USER GHCR_TOKEN

    mkdir -p "$STATE_DIR"
    staging="$(mktemp -d "$STATE_DIR/incoming.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    cat >"$staging/bundle.tgz"

    # Whitelist what the bundle may contain; reject absolute/.. paths and links.
    while IFS= read -r entry; do
      case "$entry" in
        /* | *..*) fail "unsafe path in bundle" ;;
      esac
      [[ "$entry" =~ ^(docker-compose\.(redis|nginx|dev)\.yml|infra(/.*)?|deploy/?|deploy/(deploy|rollback|lib)\.sh)$ ]] \
        || fail "unexpected file in bundle: $entry"
    done < <(tar -tzf "$staging/bundle.tgz")
    if tar -tvzf "$staging/bundle.tgz" | grep -Eq '^[lh]'; then fail "links are not allowed in bundle"; fi

    mkdir "$staging/files"
    tar -xzf "$staging/bundle.tgz" -C "$staging/files" --no-same-owner --no-same-permissions
    install_shipped_scripts "$staging/files"
    export HOMI_INCOMING="$staging/files"
    "$BASE/deploy/deploy.sh" "$sha" "${extra[@]}"
    ;;
  rollback)
    tag="${args[1]:-}"
    [[ -z "$tag" || "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail "invalid tag"
    exec "$BASE/deploy/rollback.sh" ${tag:+"$tag"}
    ;;
  *)
    fail "command not allowed"
    ;;
esac
