#!/usr/bin/env bash
# SiteSentinel database restore. DESTRUCTIVE for the target database — read docs/DEPLOY_ORACLE.md §10 first.
#
#   sudo infra/oracle/restore.sh latest                         # newest backup in S3
#   sudo infra/oracle/restore.sh s3://bucket/prefix/wim-….dump.gpg
#   sudo infra/oracle/restore.sh /opt/sitesentinel/backups/wim-….dump.gpg
#   sudo infra/oracle/restore.sh --plain /path/render.dump      # unencrypted pg_dump -Fc (Render migration)
#
# Options (env): TARGET_DB=wim (default) — restore drill: TARGET_DB=wim_restore_test restores into a scratch database
# next to production without touching it, prints row counts, and drops it again unless KEEP_DRILL_DB=1.
#
# Production restore (TARGET_DB=wim): stops every app service, drops and recreates `wim` owned by wim_owner, restores
# as wim_owner (no owner/ACL statements from the dump), re-runs `migrate` (roles, grants, RLS, seed — idempotent), and
# starts the stack again. Asks for confirmation unless YES=1.
set -euo pipefail
umask 077
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="${SITESENTINEL_DIR:-/opt/sitesentinel}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PROJECT="${COMPOSE_PROJECT:-sitesentinel}"
PG="${PROJECT}-postgres-1"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO/infra/oracle/docker-compose.prod.yml")
TARGET_DB="${TARGET_DB:-wim}"
APP_SERVICES=(nginx web admin api ingest scheduler worker-http worker-deepscan worker-notify worker-browser browser-runner egress-gateway)

envget() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }
PLAIN=0
if [ "${1:-}" = "--plain" ]; then PLAIN=1; shift; fi
SRC="${1:?usage: restore.sh [--plain] latest|s3://…|<file>}"
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "bad TARGET_DB" >&2; exit 1; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
aws_env() {
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  AWS_ACCESS_KEY_ID="$(envget BACKUP_AWS_ACCESS_KEY_ID)"; AWS_SECRET_ACCESS_KEY="$(envget BACKUP_AWS_SECRET_ACCESS_KEY)"
  AWS_DEFAULT_REGION="$(envget BACKUP_S3_REGION)"
}
if [ "$SRC" = "latest" ]; then
  aws_env; BUCKET="$(envget BACKUP_S3_BUCKET)"; PREFIX="$(envget BACKUP_S3_PREFIX)"
  key="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/wim-" --query 'Contents[].Key' --output text \
    | tr '\t' '\n' | grep -E '\.dump\.gpg$' | sort | tail -n1)"
  [ -n "$key" ] || { echo "no backups found in s3://$BUCKET/$PREFIX" >&2; exit 1; }
  SRC="s3://$BUCKET/$key"
fi
if [[ "$SRC" == s3://* ]]; then
  aws_env; echo "downloading $SRC"; aws s3 cp --only-show-errors "$SRC" "$work/in"; SRC="$work/in"
fi
[ -s "$SRC" ] || { echo "not found: $SRC" >&2; exit 1; }

dump="$work/wim.dump"
if [ "$PLAIN" = 1 ]; then cp "$SRC" "$dump"
else gpg --batch --quiet --decrypt --passphrase-fd 3 -o "$dump" "$SRC" 3<<<"$(envget BACKUP_PASSPHRASE)"; fi
docker exec -i "$PG" pg_restore --list < "$dump" >/dev/null
echo "archive OK ($(du -h "$dump" | cut -f1))"

psql_su() { docker exec -i "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

if [ "$TARGET_DB" = "wim" ]; then
  if [ "${YES:-0}" != "1" ]; then
    read -r -p "This REPLACES the production database 'wim'. Type 'restore wim' to continue: " answer
    [ "$answer" = "restore wim" ] || { echo "aborted"; exit 1; }
  fi
  echo "stopping application services"
  "${COMPOSE[@]}" stop "${APP_SERVICES[@]}"
fi

echo "recreating database $TARGET_DB"
psql_su <<SQL
\\o /dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();
\\o
DROP DATABASE IF EXISTS $TARGET_DB;
CREATE DATABASE $TARGET_DB OWNER wim_owner;
SQL
docker exec -i "$PG" psql -U postgres -d "$TARGET_DB" -v ON_ERROR_STOP=1 -q \
  -c "ALTER SCHEMA public OWNER TO wim_owner" \
  -c "CREATE EXTENSION IF NOT EXISTS citext" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"

echo "restoring (as wim_owner, no owners/ACLs from the dump)"
# --exit-on-error is not used: dumps from managed Postgres (Render) contain extension/comment statements a
# non-superuser cannot replay; those are reported and skipped, everything else must restore (checked below).
docker exec -i "$PG" pg_restore -U wim_owner -d "$TARGET_DB" --no-owner --no-privileges --jobs 1 < "$dump" \
  2> "$work/restore.err" || true
grep -E '^pg_restore: error' "$work/restore.err" | grep -vE 'extension|COMMENT ON EXTENSION|must be owner of' | head -20 > "$work/errors" || true
if [ -s "$work/errors" ]; then echo "restore errors:" >&2; cat "$work/errors" >&2; exit 1; fi

echo "restored $TARGET_DB:"
docker exec -i "$PG" psql -U postgres -d "$TARGET_DB" -At -F '=' -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'tables', count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'organizations', count(*) FROM organizations;
SELECT 'users', count(*) FROM users;
SELECT 'websites', count(*) FROM websites;
SELECT 'platform_settings', count(*) FROM platform_settings;
SELECT 'subscription_plans', count(*) FROM subscription_plans;
SELECT 'prisma_migrations', count(*) FROM _prisma_migrations;
SQL

if [ "$TARGET_DB" = "wim" ]; then
  echo "re-applying roles, grants, RLS and seed"
  "${COMPOSE[@]}" run --rm migrate
  echo "starting the stack"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 300
  echo "restore complete"
elif [ "${KEEP_DRILL_DB:-0}" != "1" ]; then
  psql_su -c "DROP DATABASE $TARGET_DB"
  echo "drill database $TARGET_DB dropped (set KEEP_DRILL_DB=1 to keep it)"
fi
