#!/usr/bin/env bash
# Stop the live background services started by scripts/live/run-workers.sh (matched by their repo-relative entry point;
# the local development stack runs `dist/main.js` from each app folder and is not affected).
# Waits until every process has exited (SIGTERM, then SIGKILL after a grace period) so a restart never overlaps the
# old processes — overlapping copies of the scheduler or deep-scan worker process the same jobs twice.
GRACE="${STOP_GRACE_SEC:-20}"
SERVICES="scheduler worker-browser browser-runner worker-notify worker-deepscan worker-http egress-gateway"
for s in $SERVICES; do
  pkill -TERM -f "node .*apps/$s/dist/main.js" && echo "stopping $s"
done
for _ in $(seq "$GRACE"); do
  pgrep -f "node .*apps/(${SERVICES// /|})/dist/main.js" >/dev/null || break
  sleep 1
done
for s in $SERVICES; do
  pkill -KILL -f "node .*apps/$s/dist/main.js" && echo "forced $s (did not exit within ${GRACE}s)"
done
exit 0
