#!/usr/bin/env bash
# Stop everything started by scripts/local/start.sh. Pass --infra to also stop the Docker services (data is kept).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
for f in .local/pids/*; do
  [ -f "$f" ] || continue
  pid=$(cat "$f"); pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null && echo "stopped $(basename "$f")"
  rm -f "$f"
done
[ "${1:-}" = "--infra" ] && pnpm -s infra:down
