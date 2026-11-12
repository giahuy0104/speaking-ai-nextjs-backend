#!/usr/bin/env bash
# ONE-TIME setup on the VPS, run as root by the project owner (not by CI):
#   sudo bash bootstrap-vps.sh "<public key line of the dedicated Actions key>"            # production
#   sudo bash bootstrap-vps.sh --env dev "<public key line of the DEV-only Actions key>"  # dev stack
# Creates a restricted `deploy` user. Does NOT change SSH daemon settings, Nginx,
# Certbot, DNS, .env files, Redis data, or existing containers.
# Each environment has its own key; re-running for one env never removes the other's key.
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
env_name=production
if [[ "${1:-}" == "--env" ]]; then env_name="${2:-}"; shift 2 || true; fi
pubkey="${1:-}"
[[ "$pubkey" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "pass the PUBLIC key line (ssh-ed25519 AAAA... comment)" >&2; exit 1; }

case "$env_name" in
  production) BASE=/opt/homi/backend ;;
  dev) BASE=/opt/homi/backend-dev ;;
  *) echo "--env must be production or dev" >&2; exit 1 ;;
esac
BIN=/opt/homi/deploy-bin
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d "$BASE" ]] || { echo "$BASE not found" >&2; exit 1; }
[[ -f "$BASE/.env.compose" ]] || { echo "$BASE/.env.compose not found" >&2; exit 1; }

id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy   # NOTE: docker group is root-equivalent; mitigated by the forced command below.

# Root-owned entrypoint: the deploy user cannot modify what its own key may execute.
install -d -o root -g root -m 755 "$BIN"
install -o root -g root -m 755 "$SRC/remote-entry.sh" "$BIN/remote-entry.sh"

# $BASE is root:root 0700. Give deploy traverse-only access to it (ACL), plus its own writable
# .deploy/ and deploy/ dirs. Compose/Nginx/Redis config stays root-owned: CI cannot modify it.
command -v setfacl >/dev/null || apt-get install -y acl >/dev/null
setfacl -m u:deploy:x "$BASE"
install -d -o deploy -g deploy -m 700 "$BASE/.deploy" "$BASE/deploy"

# deploy reads ONLY .env.compose (compose substitutions, same as the homi-backend wrapper).
# .env.local (application secrets) is not granted to deploy; the Docker daemon mounts it.
setfacl -m u:deploy:r "$BASE/.env.compose"

# Keep `homi-backend` consistent with CI: if CI deployed a tag, use it instead of the
# (stale) BACKEND_IMAGE_TAG in .env.compose. Idempotent; backup kept next to the wrapper.
WRAP=/usr/local/bin/homi-backend
if [[ "$env_name" == production && -f "$WRAP" ]] && ! grep -q 'deploy/current_tag\|\.deploy/current_tag' "$WRAP"; then
  cp -a "$WRAP" "$WRAP.bak-before-cicd"
  sed -i '/^cd \/opt\/homi\/backend$/a [ -r .deploy/current_tag ] \&\& export BACKEND_IMAGE_TAG="$(cat .deploy/current_tag)" || true' "$WRAP"
  echo "Patched $WRAP (backup: $WRAP.bak-before-cicd)"
fi

# Forced command + restrictions (no pty, no forwarding, only remote-entry.sh).
# Production keeps the original line format (no env prefix = production).
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
AK=/home/deploy/.ssh/authorized_keys
touch "$AK"
if [[ "$env_name" == production ]]; then
  forced="$BIN/remote-entry.sh"
  others="$(grep 'HOMI_DEPLOY_ENV=' "$AK" || true)"            # keep keys of other envs
else
  forced="HOMI_DEPLOY_ENV=$env_name $BIN/remote-entry.sh"
  others="$(grep -v "HOMI_DEPLOY_ENV=$env_name " "$AK" || true)" # keep prod + other envs
fi
{
  [[ -n "$others" ]] && printf '%s\n' "$others"
  printf 'restrict,command="%s" %s\n' "$forced" "$pubkey"
} >"$AK.tmp"
mv "$AK.tmp" "$AK"
chown deploy:deploy "$AK"
chmod 600 "$AK"

echo "OK ($env_name). Next: put host key + private key into GitHub Secrets (see docs/ci-cd-deployment.md)."
echo "Test (as root): sudo -u deploy HOMI_DEPLOY_ENV=$env_name docker ps"
