#!/usr/bin/env bash
# Start (or restart) the LIVE background services on this machine against the hosted database and Redis:
# egress gateway, worker-http, scheduler, worker-deepscan and worker-notify. Stop them with scripts/live/stop-workers.sh.
#
# Secrets are read from a private env file (default ~/.sitesentinel/live.env, chmod 600) — never from the repo.
# Template: scripts/live/live.env.example. Logs: .local/live-logs/<service>.log
# This is a stop-gap for testing; production should run these on an always-on host (see docs/DEPLOYMENT.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${SITESENTINEL_LIVE_ENV:-$HOME/.sitesentinel/live.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy scripts/live/live.env.example and fill it in)"; exit 1; }
if [ "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")" != "600" ]; then echo "refusing: $ENV_FILE must be chmod 600"; exit 1; fi
set -a; . "$ENV_FILE"; set +a
for v in WORKER_DATABASE_URL SCANNER_DATABASE_URL REDIS_URL EGRESS_TOKEN_SECRET KEK_RING_JSON APP_URL OPS_FALLBACK_ALERT_EMAILS SDK_URL; do
  [ -n "${!v:-}" ] || { echo "missing $v in $ENV_FILE"; exit 1; }
done
export NODE_ENV=production EGRESS_PORT="${EGRESS_PORT:-8091}"
export EGRESS_GATEWAY_URL="http://127.0.0.1:${EGRESS_PORT}"
LOGS="$ROOT/.local/live-logs"; mkdir -p "$LOGS"

"$ROOT/scripts/live/stop-workers.sh" >/dev/null 2>&1 || true
cd "$ROOT"
start() { # name entry — refuses to start a second copy of a service
  if pgrep -f "node .*apps/$1/dist/main.js" >/dev/null; then echo "  ✗ $1 is still running (pid $(pgrep -f "node .*apps/$1/dist/main.js" | tr '\n' ' ')) — not starting a second copy"; return; fi
  nohup node --enable-source-maps "apps/$1/dist/main.js" < /dev/null >> "$LOGS/$1.log" 2>&1 &
  echo "  started $1 (pid $!, log .local/live-logs/$1.log)"
}
echo "→ live services (NODE_ENV=production)"
start egress-gateway
sleep 1
SERVICES="egress-gateway"
if [ -n "${BROWSER_DATABASE_URL:-}" ]; then
  # Sandboxed Chromium (browser-runner, loopback only). Started — and BROWSER_RUNNER_URL exported — BEFORE the deep-scan
  # worker, which uses it for browser-assisted discovery (otherwise that worker never renders a page).
  export RUNNER_PORT="${RUNNER_PORT:-3301}" RUNNER_BIND_HOST=127.0.0.1 RUNNER_ADVERTISE_HOST=127.0.0.1 RUNNER_GATEWAY_URL="$EGRESS_GATEWAY_URL"
  export BROWSER_RUNNER_URL="http://127.0.0.1:${RUNNER_PORT}"
  start browser-runner
  sleep 2
  SERVICES="$SERVICES browser-runner"
fi
start worker-http
start worker-deepscan
start worker-notify
start scheduler
SERVICES="$SERVICES worker-http worker-deepscan worker-notify scheduler"
if [ -n "${BROWSER_DATABASE_URL:-}" ]; then start worker-browser; SERVICES="$SERVICES worker-browser"; fi
sleep 5
for s in $SERVICES; do
  n=$(pgrep -f "node .*apps/$s/dist/main.js" | wc -l | tr -d ' ')
  if [ "$n" = 1 ]; then echo "  ✓ $s running"
  elif [ "$n" = 0 ]; then echo "  ✗ $s stopped — last log lines:"; tail -5 "$LOGS/$s.log"
  else echo "  ✗ $s has $n copies running — run scripts/live/stop-workers.sh, then start again"; fi
done
echo "Keep this Mac awake (e.g. caffeinate -s) — monitoring stops when it sleeps."
