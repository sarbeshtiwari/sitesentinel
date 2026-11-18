#!/usr/bin/env bash
# SiteSentinel — build and (re)deploy the stack on the server. Run from the repository checkout:
#   sudo infra/oracle/deploy.sh            # deploy the current branch's latest commit (git pull --ff-only)
#   sudo infra/oracle/deploy.sh <ref>      # deploy a tag / branch / commit (e.g. a rollback: the previous tag)
#   sudo NO_PULL=1 infra/oracle/deploy.sh  # deploy the working tree as it is
#   sudo NO_PULL=1 NO_BUILD=1 infra/oracle/deploy.sh  # config-only change (.env / nginx): no git, no rebuild
# Steps: refuse on placeholders → git fetch/checkout → docker compose build --pull → migrate (one-shot) →
# up -d → wait for every container to be healthy → public health checks through nginx → status.
# Images are tagged with the git commit, so `deploy.sh <previous-ref>` is a rollback (migrations are forward-only:
# check CHANGELOG for destructive ones before rolling back across them).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="${SITESENTINEL_DIR:-/opt/sitesentinel}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PROJECT="${COMPOSE_PROJECT:-sitesentinel}"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO/infra/oracle/docker-compose.prod.yml")
REF="${1:-}"

say() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight
[ -r "$ENV_FILE" ] || die "$ENV_FILE not readable (run setup.sh; deploy with sudo)"
perm="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")"
[ "$perm" = "600" ] || die "$ENV_FILE must be chmod 600 (is $perm)"
grep -qE '^[A-Z0-9_]+=GENERATED_BY_SETUP$' "$ENV_FILE" && die "secrets missing in $ENV_FILE (run infra/oracle/gen-secrets.sh $ENV_FILE)"
grep -qE '^OPS_FALLBACK_ALERT_EMAILS=(TODO.*)?$' "$ENV_FILE" && die "set OPS_FALLBACK_ALERT_EMAILS in $ENV_FILE (worker-notify refuses to start without it)"
todo="$(grep -E '^[A-Z0-9_]+=TODO' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
[ -z "$todo" ] || echo "warning: still TODO in $ENV_FILE: $todo(screenshots/backups/email stay off until filled in)"
[ -s "$APP_DIR/certs/origin.pem" ] && [ -s "$APP_DIR/certs/origin.key" ] || die "Cloudflare origin certificate missing: $APP_DIR/certs/origin.pem + origin.key"
[ -s "$APP_DIR/pg-tls/server.crt" ] || die "PostgreSQL TLS missing (run setup.sh)"
[ -s "$APP_DIR/cloudflare-realip.conf" ] || install -m 644 "$REPO/infra/oracle/nginx/cloudflare-realip.conf" "$APP_DIR/cloudflare-realip.conf"

# ------------------------------------------------------------------ source
cd "$REPO"
if [ "${NO_PULL:-0}" != "1" ]; then
  say "Fetching source"
  # The checkout belongs to the deploy user; run git as that user so file ownership does not change.
  GIT=(git); [ -n "${SUDO_USER:-}" ] && GIT=(sudo -u "$SUDO_USER" git)
  "${GIT[@]}" fetch --tags --prune origin
  if [ -n "$REF" ]; then
    "${GIT[@]}" checkout --detach "$REF" 2>/dev/null || "${GIT[@]}" checkout --detach "origin/$REF"
  else
    "${GIT[@]}" pull --ff-only
  fi
fi
COMMIT="$(git rev-parse --short=12 HEAD)"
git diff --quiet HEAD -- . ':!text.txt' || echo "warning: deploying a working tree with local changes"
export IMAGE_TAG="$COMMIT"
echo "deploying $COMMIT ($(git log -1 --format=%s | cut -c1-80))"

# ------------------------------------------------------------------ build
if [ "${NO_BUILD:-0}" = "1" ]; then
  # Config-only change (.env, nginx): reuse the images of the current tag.
  say "Skipping build (NO_BUILD=1); using images tagged $IMAGE_TAG"
else
  say "Building images (tag $IMAGE_TAG)"
  # One retry: registry/npm downloads occasionally reset; the second run reuses every finished layer.
  "${COMPOSE[@]}" build --pull || { echo "build failed — retrying once in 30 s"; sleep 30; "${COMPOSE[@]}" build --pull; }
fi

# ------------------------------------------------------------------ migrate
say "Starting PostgreSQL + Redis"
"${COMPOSE[@]}" up -d --wait postgres redis
say "Migrating (roles → prisma migrate deploy → packages/db/sql → seed)"
"${COMPOSE[@]}" run --rm migrate

# ------------------------------------------------------------------ up
say "Starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 300 || {
  "${COMPOSE[@]}" ps
  die "some services did not become healthy — see: docker compose -p $PROJECT logs --tail 100 <service>"
}

# ------------------------------------------------------------------ verify through nginx (TLS + Host routing)
say "Health checks through nginx"
https_port="$(grep -E '^HTTPS_PORT=' "$ENV_FILE" | cut -d= -f2)"; https_port="${https_port:-443}"
fail=0
check() { # check <host> <path> <expected-substring|status>
  local host="$1" path="$2" want="$3" out
  out="$(curl -sk --max-time 10 --resolve "$host:$https_port:127.0.0.1" -o /tmp/ss-check.$$ -w '%{http_code}' "https://$host:$https_port$path" || true)"
  if [ "$out" = "$want" ] || grep -q -- "$want" /tmp/ss-check.$$ 2>/dev/null; then echo "  ok   https://$host$path ($out)"
  else echo "  FAIL https://$host$path (HTTP $out)"; fail=1; fi
  rm -f /tmp/ss-check.$$
}
check sentinel-api.ziptat.in /health/ready '"status":"ok"'
check sentinel-client.ziptat.in /login 200
check sentinel-client.ziptat.in /api/v1/public/config 200
check sentinel-admin.ziptat.in /login 200
check sentinel-ingest.ziptat.in /sdk/monitor.v1.js 200
check sentinel-ingest.ziptat.in /health/live '"status":"ok"'

say "Status"
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
docker image prune -f --filter "until=168h" >/dev/null || true
[ "$fail" = 0 ] || die "deployed $COMMIT, but some checks failed (above)"
echo "deployed $COMMIT"
