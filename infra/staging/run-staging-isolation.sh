#!/usr/bin/env bash
# Staging network-isolation proof (release readiness, blocker 2). Runs the same probes as the local isolation suite, but
# inside the DEPLOYED pods' network namespaces (ephemeral debug containers), against the real CNI, firewall and cloud
# network. Refuses to run without an explicit kube context and namespace. Writes JSONL evidence and a summary.
#
#   KUBE_CONTEXT=staging NAMESPACE=sitesentinel PROBE_IMAGE=registry/wim-isolation-probe:tag \
#   EGRESS_CAP_TOKEN=<token minted by an operator for org/website "isolation" with ttl ≤ 600 s> \
#   OUT=./staging-isolation-$(date +%F) infra/staging/run-staging-isolation.sh
#
# Pass criterion: 0 violations AND the gateway's own decision log shows the runner's probe traffic attributed and
# every internal/metadata destination refused. Archive $OUT with the run date, cluster, image digests and operator.
set -euo pipefail
: "${KUBE_CONTEXT:?set KUBE_CONTEXT (refusing to guess a cluster)}" "${NAMESPACE:?set NAMESPACE}" "${PROBE_IMAGE:?set PROBE_IMAGE}"
OUT="${OUT:-./staging-isolation}"
mkdir -p "$OUT"
k() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
pod() { k get pod -l "app.kubernetes.io/component=$1" -o jsonpath='{.items[0].metadata.name}'; }

probe() { # component role target-container
  local p; p=$(pod "$1")
  echo "probing $1 ($p) as role $2" >&2
  k debug "$p" --image="$PROBE_IMAGE" --target="$3" --profile=restricted --quiet --attach --container="isoprobe-$RANDOM" \
    --env="EGRESS_CAP_TOKEN=${EGRESS_CAP_TOKEN:-}" -- "$2" > "$OUT/$1.jsonl"
}
probe worker-http worker worker
probe scheduler scheduler scheduler
probe worker-deepscan deepscan worker
probe egress-gateway gateway gateway
probe browser-runner browser-runner runner
probe browser-runner runner-service runner
k logs -l app.kubernetes.io/component=egress-gateway --since=15m > "$OUT/gateway-decisions.log"
k get networkpolicy -o yaml > "$OUT/networkpolicies.applied.yaml"
k get pods -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{"\t"}{.spec.containers[0].image}{"\t"}{.status.containerStatuses[0].imageID}{"\n"}{end}' > "$OUT/images.tsv"

node - "$OUT" <<'JS'
const fs = require("fs"); const dir = process.argv[2];
const rows = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })).filter((r) => r && !r.summary);
const bad = rows.filter((r) => r.expect !== r.result);
for (const r of bad) console.log(`VIOLATION ${r.role}: ${r.name} expected ${r.expect}, got ${r.result} (${r.detail ?? ""})`);
console.log(`${rows.length} checks, ${bad.length} violations`);
fs.writeFileSync(`${dir}/summary.txt`, `${new Date().toISOString()} ${rows.length} checks, ${bad.length} violations\n`);
process.exit(bad.length || !rows.length ? 1 : 0);
JS
