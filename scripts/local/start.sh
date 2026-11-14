#!/usr/bin/env bash
# Start the full SiteSentinel stack locally (macOS / Linux). Logs: .local/logs/<service>.log
# Requires: Docker running, `pnpm install`, `pnpm keys:init`, `pnpm build` and migrations done once (see README).
# Stop with: scripts/local/stop.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
LOGS="$ROOT/.local/logs"; PIDS="$ROOT/.local/pids"; mkdir -p "$LOGS" "$PIDS"
set -a; . ./.env; set +a
# services run from their own folders: make relative paths in .env absolute
case "${KEK_RING_FILE:-}" in /*) ;; "") KEK_RING_FILE="$ROOT/.keys/kek.json" ;; *) KEK_RING_FILE="$ROOT/$KEK_RING_FILE" ;; esac
export KEK_RING_FILE
# local-only secret shared by the gateway and the workers that sign capability tokens (never used outside this machine)
export EGRESS_TOKEN_SECRET="${EGRESS_TOKEN_SECRET:-local-egress-secret-$(whoami)-0123456789abcdef}"
export EGRESS_PORT=8090 EGRESS_GATEWAY_URL=http://127.0.0.1:8090
export BROWSER_RUNNER_URL=http://127.0.0.1:3300

echo "→ infrastructure (Postgres, Redis, S3, Mailpit)"
pnpm -s infra:up >/dev/null

run() { # name dir env...
  local name=$1 dir=$2; shift 2
  if [ -f "$PIDS/$name" ] && kill -0 "$(cat "$PIDS/$name")" 2>/dev/null; then echo "  $name already running"; return; fi
  ( cd "$dir" && env "$@" nohup node --enable-source-maps dist/main.js < /dev/null > "$LOGS/$name.log" 2>&1 & echo $! > "$PIDS/$name" )
  echo "  started $name (log: .local/logs/$name.log)"
}
echo "→ services"
run egress-gateway apps/egress-gateway
run browser-runner apps/browser-runner RUNNER_PORT=3300 RUNNER_BIND_HOST=127.0.0.1 RUNNER_ADVERTISE_HOST=127.0.0.1 RUNNER_GATEWAY_URL=$EGRESS_GATEWAY_URL RUNNER_MAX_SESSIONS=2
run api apps/api
run ingest apps/ingest
run worker-notify apps/worker-notify
run worker-http apps/worker-http
run worker-browser apps/worker-browser
run worker-deepscan apps/worker-deepscan
run scheduler apps/scheduler

echo "→ web apps (Next.js dev servers)"
for app in web admin; do
  if [ -f "$PIDS/$app" ] && kill -0 "$(cat "$PIDS/$app")" 2>/dev/null; then echo "  $app already running"; continue; fi
  ( cd "apps/$app" && nohup pnpm dev < /dev/null > "$LOGS/$app.log" 2>&1 & echo $! > "$PIDS/$app" ); echo "  started $app"
done

echo
echo "Customer app   http://localhost:3000"
echo "Super Admin    http://localhost:3001"
echo "API health     http://localhost:4000/health/ready"
echo "Mailpit (mail) http://localhost:58025"
echo "Wait ~20 s for the web apps to compile on first open."
