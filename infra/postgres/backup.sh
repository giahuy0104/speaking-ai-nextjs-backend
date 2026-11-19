#!/usr/bin/env bash
# Nightly backup of a Postgres container on the VPS (dev: homi-dev-postgres).
# Cron (root): 30 2 * * * /opt/homi/backups/dev-postgres/backup.sh >> /opt/homi/backups/dev-postgres/backup.log 2>&1
#
# Writes a custom-format dump (pg_restore-able), checks it can be read back, and keeps
# KEEP_DAYS days. Dumps stay on this VPS: copy them off the machine (R2) to survive a VPS loss.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-homi-dev-postgres}"
DB="${PG_DB:-homi}"
USER_NAME="${PG_USER:-homi}"
DIR="${BACKUP_DIR:-/opt/homi/backups/dev-postgres}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$DIR"
umask 077
stamp="$(date -u +%Y%m%d-%H%M%S)"
target="$DIR/$DB-$stamp.dump"
partial="$target.partial"

docker exec "$CONTAINER" pg_dump -U "$USER_NAME" -d "$DB" -Fc > "$partial"
# A dump that pg_restore cannot list is not a backup.
docker exec -i "$CONTAINER" pg_restore --list > /dev/null < "$partial"
mv "$partial" "$target"

# Only this directory, only our dump files.
find "$DIR" -maxdepth 1 -type f -name "$DB-*.dump" -mtime +"$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok: $target ($(stat -c %s "$target") bytes)"
