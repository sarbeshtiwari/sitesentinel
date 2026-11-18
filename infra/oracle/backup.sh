#!/usr/bin/env bash
# SiteSentinel daily database backup (sitesentinel-backup.timer, 03:00 IST). Run by hand: sudo infra/oracle/backup.sh
#   pg_dump (custom format, compressed) as the schema owner inside the postgres container
#   → gpg symmetric AES-256 (passphrase BACKUP_PASSPHRASE from the env file, never on the command line)
#   → s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/wim-<UTC timestamp>.dump.gpg   (newest $BACKUP_KEEP kept, default 14)
# The newest 3 encrypted dumps are also kept locally in $SITESENTINEL_DIR/backups (fast restore; same disk, so not
# a substitute for S3). Exit code ≠ 0 on any failure → `systemctl status sitesentinel-backup` / journal shows it.
set -euo pipefail
umask 077
APP_DIR="${SITESENTINEL_DIR:-/opt/sitesentinel}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PROJECT="${COMPOSE_PROJECT:-sitesentinel}"
PG="${PROJECT}-postgres-1"
OUT="$APP_DIR/backups"
LOCAL_KEEP=3

envget() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }
PASSPHRASE="$(envget BACKUP_PASSPHRASE)"
BUCKET="$(envget BACKUP_S3_BUCKET)"
PREFIX="$(envget BACKUP_S3_PREFIX)"; PREFIX="${PREFIX:-sitesentinel/db}"
KEEP="$(envget BACKUP_KEEP)"; KEEP="${KEEP:-14}"
[ -n "$PASSPHRASE" ] && [ "$PASSPHRASE" != "GENERATED_BY_SETUP" ] || { echo "BACKUP_PASSPHRASE missing" >&2; exit 1; }

mkdir -p "$OUT"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="$OUT/wim-$ts.dump.gpg"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

echo "dumping database (custom format) → $(basename "$file")"
# pipefail: a failed pg_dump fails the whole pipeline, so a truncated dump is never kept.
docker exec "$PG" pg_dump -U wim_owner -d wim -Fc -Z 6 --no-owner --no-privileges \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --compress-algo none \
        --passphrase-fd 3 -o "$tmp" 3<<<"$PASSPHRASE"
mv "$tmp" "$file"
size="$(du -h "$file" | cut -f1)"
echo "encrypted dump: $size"

# quick integrity check: decrypt and list the archive table of contents
gpg --batch --quiet --decrypt --passphrase-fd 3 "$file" 3<<<"$PASSPHRASE" \
  | docker exec -i "$PG" pg_restore --list >/dev/null
echo "verified: archive decrypts and lists"

# local retention
ls -1t "$OUT"/wim-*.dump.gpg 2>/dev/null | tail -n +$((LOCAL_KEEP + 1)) | xargs -r rm -f

# S3 upload + retention
if [ -z "$BUCKET" ] || [[ "$BUCKET" == TODO* ]]; then
  echo "warning: BACKUP_S3_BUCKET not set — backup kept locally only ($OUT)" >&2
  exit 2
fi
export AWS_ACCESS_KEY_ID; AWS_ACCESS_KEY_ID="$(envget BACKUP_AWS_ACCESS_KEY_ID)"
export AWS_SECRET_ACCESS_KEY; AWS_SECRET_ACCESS_KEY="$(envget BACKUP_AWS_SECRET_ACCESS_KEY)"
export AWS_DEFAULT_REGION; AWS_DEFAULT_REGION="$(envget BACKUP_S3_REGION)"
aws s3 cp --only-show-errors "$file" "s3://$BUCKET/$PREFIX/$(basename "$file")"
echo "uploaded s3://$BUCKET/$PREFIX/$(basename "$file")"

# keep the newest $KEEP objects (names sort chronologically)
mapfile -t objs < <(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/wim-" \
  --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -E '\.dump\.gpg$' | sort)
excess=$(( ${#objs[@]} - KEEP ))
for ((i = 0; i < excess; i++)); do
  aws s3 rm --only-show-errors "s3://$BUCKET/${objs[$i]}"
  echo "pruned ${objs[$i]}"
done
echo "backup complete ($(( ${#objs[@]} > KEEP ? KEEP : ${#objs[@]} )) in S3)"
