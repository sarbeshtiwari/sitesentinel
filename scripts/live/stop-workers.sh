#!/usr/bin/env bash
# Stop the live background services started by scripts/live/run-workers.sh (matched by their repo-relative entry point;
# the local development stack runs `dist/main.js` from each app folder and is not affected).
for s in scheduler worker-browser browser-runner worker-notify worker-deepscan worker-http egress-gateway; do
  pkill -f "node .*apps/$s/dist/main.js" && echo "stopped $s"
done
exit 0
