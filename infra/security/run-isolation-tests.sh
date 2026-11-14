#!/usr/bin/env bash
# Proves egress isolation at the network level (SECURITY.md §25). Builds the isolation topology,
# runs probes INSIDE each container, cross-checks in-page requests against the gateway's own
# decision log, and exits non-zero on any violation. Requires: pnpm build (dist/ present), Docker.
set -euo pipefail
cd "$(dirname "$0")/isolation"
OUT="${ISOLATION_OUT:-/tmp/wim-isolation}"
mkdir -p "$OUT"
compose() { docker compose -f docker-compose.yml "$@"; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

compose up -d --wait --quiet-pull >/dev/null 2>&1 || compose up -d >/dev/null
sleep 3
compose exec -T worker node infra/security/isolation/probe.mjs worker > "$OUT/worker.jsonl"
compose exec -T egress-gateway node infra/security/isolation/probe.mjs gateway > "$OUT/gateway.jsonl"
compose exec -T scheduler node infra/security/isolation/probe.mjs scheduler > "$OUT/scheduler.jsonl"
# Phase 4E: the deep-scan worker's real fetch path.
compose exec -T deepscan node infra/security/isolation/probe.mjs deepscan > "$OUT/deepscan.jsonl"
# Phase 4D: the real runner service (sandbox on, custom seccomp), driven by the worker like worker-browser does.
compose exec -T worker node infra/security/isolation/probe.mjs control-plane > "$OUT/control-plane.jsonl"
compose exec -T -w /repo browser-runner-svc node infra/security/isolation/probe.mjs runner-service > "$OUT/runner-service.jsonl"
# The browser container has no signing secret: mint its capability token in the worker and hand it over.
TOKEN=$(compose exec -T worker node -e 'import("/repo/packages/netguard/dist/index.js").then(m=>process.stdout.write(m.signCapability(process.env.EGRESS_TOKEN_SECRET,{o:"11111111-1111-1111-1111-111111111111",w:null,e:"isolation-browser",k:"browser"},600)))')
compose exec -T -e EGRESS_CAP_TOKEN="$TOKEN" browser-runner node infra/security/isolation/probe.mjs browser-runner > "$OUT/browser.jsonl"
compose logs egress-gateway --no-log-prefix > "$OUT/gateway-decisions.log" 2>&1

node - "$OUT" <<'JS'
const fs = require("fs");
const dir = process.argv[2];
const rows = ["worker", "gateway", "scheduler", "deepscan", "control-plane", "runner-service", "browser"].flatMap((f) => fs.readFileSync(`${dir}/${f}.jsonl`, "utf8").split("\n").filter(Boolean).map(JSON.parse)).filter((r) => !r.summary);
const log = fs.readFileSync(`${dir}/gateway-decisions.log`, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// Opaque in-page responses: confirm with the gateway's decision log that it refused them.
for (const r of rows.filter((r) => r.result === "gateway-refused")) {
  const host = r.name.includes("redis") ? "10.250.10.10" : r.name.includes("metadata") ? "169.254.169.254" : "host.docker.internal";
  const refused = log.some((l) => l.host === host && l.outcome !== "ALLOWED");
  const allowed = log.some((l) => l.host === host && l.outcome === "ALLOWED");
  r.result = refused && !allowed ? "blocked" : "reached";
  r.detail += ` | gateway log: ${refused ? "refused" : "no refusal"}${allowed ? ", ALLOWED!" : ""}`;
}
// Nothing internal may ever appear as ALLOWED in the gateway log.
const internalAllowed = log.filter((l) => l.outcome === "ALLOWED" && l.address && !l.address.startsWith("10.250.77."));
let fail = 0;
for (const r of rows) {
  const ok = r.result === r.expect;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${r.role}] ${r.name} — expected ${r.expect}, got ${r.result} (${r.detail})`);
}
console.log(`${internalAllowed.length === 0 ? "PASS" : "FAIL"}  gateway log: no ALLOWED decision to an address outside the fixture internet (${internalAllowed.length})`);
if (internalAllowed.length) fail++;
// Non-vacuous: the log must actually contain ALLOWED decisions (log level info), incl. the runner's attributed ones.
const allowedCount = log.filter((l) => l.outcome === "ALLOWED").length;
const runnerAttributed = log.filter((l) => l.exec === "isolation-runner-exec" && l.outcome === "ALLOWED" && l.org === "22222222-2222-2222-2222-222222222222" && l.website === "33333333-3333-3333-3333-333333333333" && l.kind === "browser").length;
console.log(`${allowedCount > 0 ? "PASS" : "FAIL"}  gateway log records ALLOWED decisions (${allowedCount}); the check above is not vacuous`);
console.log(`${runnerAttributed > 0 ? "PASS" : "FAIL"}  sandboxed runner traffic attributed to org/website/execution in the gateway log (${runnerAttributed})`);
const deepAttributed = log.filter((l) => l.exec === "isolation-deepscan-exec" && l.kind === "deepscan" && l.org === "44444444-4444-4444-4444-444444444444" && l.website === "55555555-5555-5555-5555-555555555555").length;
const deepInternal = log.filter((l) => l.exec === "isolation-deepscan-exec" && l.outcome === "ALLOWED" && l.address && !l.address.startsWith("10.250.77.")).length;
console.log(`${deepAttributed > 0 && deepInternal === 0 ? "PASS" : "FAIL"}  deep-scan traffic attributed (kind deepscan) in the gateway log (${deepAttributed}); none ALLOWED to an internal address (${deepInternal})`);
if (!deepAttributed || deepInternal) fail++;
if (!allowedCount) fail++;
if (!runnerAttributed) fail++;
const refusals = log.filter((l) => l.outcome && l.outcome !== "ALLOWED").length;
console.log(`\n${rows.length + 4} checks, ${fail} violations; gateway recorded ${refusals} refusals`);
process.exit(fail ? 1 : 0);
JS
