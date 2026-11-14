#!/usr/bin/env node
// Release readiness, blockers 7 and 8: multi-tenant monitoring + dashboard load harness.
//
// Runs against an ALREADY RUNNING stack (scheduler, egress gateway, worker-http, worker-browser + browser-runner,
// worker-deepscan, worker-notify, API) whose fault environment serves the hosts listed in LOAD_HOSTS_FILE. Seeds
// organisations of different sizes and usage patterns, lets the real scheduler and workers check real (fixture)
// websites, injects a worker crash and a retry storm, and — in phase B — adds concurrent customer dashboard sessions to
// measure whether dashboard load slows scheduling. Prints a JSON report.
//
// It produces LOCAL REAL-INFRASTRUCTURE evidence only. Production-scale evidence requires the same harness on
// production-like infrastructure (DEPLOYMENT.md §25) at the plan limits given below.
//
// Env: MIGRATION_DATABASE_URL, REDIS_URL (from .env), API_URL (http://127.0.0.1:4000), MAILPIT_URL, LOAD_HOSTS_FILE,
//      LOAD_SMALL/LOAD_MEDIUM/LOAD_LARGE (orgs), LOAD_PHASE_SEC, LOAD_DASHBOARD_USERS, CONTROL_URL (fault env control)
import { readFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import pg from "pg";

const env = process.env;
const API = env.API_URL ?? "http://127.0.0.1:4000";
const MAILPIT = env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const CONTROL = env.CONTROL_URL ?? "http://127.0.0.1:15999";
const PHASE_SEC = Number(env.LOAD_PHASE_SEC ?? 300);
const SIZES = { small: { orgs: Number(env.LOAD_SMALL ?? 12), sites: 2, browser: 0 }, medium: { orgs: Number(env.LOAD_MEDIUM ?? 5), sites: 8, browser: 1 }, large: { orgs: Number(env.LOAD_LARGE ?? 2), sites: 40, browser: 2 } };
const DASH_USERS = Number(env.LOAD_DASHBOARD_USERS ?? 8);
const hosts = readFileSync(env.LOAD_HOSTS_FILE, "utf8").split(/[\s,]+/).filter(Boolean);
const db = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
await db.connect();
const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const report = { startedAt: new Date().toISOString(), environment: "local single-host Docker (NOT production-scale)", config: { SIZES, PHASE_SEC, DASH_USERS, hosts: hosts.length }, phases: {} };

// ---------------------------------------------------------------- seed tenants (verified websites on fixture hosts)
let h = 0;
const orgs = [];
for (const [size, cfg] of Object.entries(SIZES)) {
  for (let i = 0; i < cfg.orgs; i++) {
    const orgId = randomUUID(), tag = `load-${size}-${randomBytes(3).toString("hex")}`;
    await q(`INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())`, [orgId, tag]);
    await q(`INSERT INTO trials (org_id, registrable_domain, starts_at, ends_at, status) VALUES ($1, $2, now() - interval '1 day', now() + interval '29 days', 'ACTIVE')`, [orgId, `${tag}.example`]);
    await q(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.browser.entitled', 'true', 'load test', gen_random_uuid()), ($1, 'monitoring.maxWebsites', '100', 'load test', gen_random_uuid()) ON CONFLICT DO NOTHING`, [orgId]);
    const sites = [];
    for (let s = 0; s < cfg.sites; s++) {
      const browser = s < cfg.browser;
      // browser checks go to the first host (the local runner trusts exactly one fixture certificate key)
      const host = browser ? hosts[0] : hosts[1 + (h++ % (hosts.length - 1))];
      const reg = randomUUID(), claim = randomUUID();
      const key = `${host}#${orgId.slice(0, 8)}#${s}`; // unique identity key (the same fixture host serves several websites)
      await q(`INSERT INTO domain_registry (id, identity_key, host_key, registrable_domain, display_host, is_root) VALUES ($1, $2, $2, $3, $4, false)`, [reg, key, host.split(".").slice(-3).join("."), host]);
      await q(`INSERT INTO domain_claims (id, org_id, domain_registry_id, scope, policy, verification_token, status, verified_at, verified_method, updated_at) VALUES ($1, $2, $3, 'HOST', 'SUBDOMAIN_INDEPENDENT', $4, 'VERIFIED', now(), 'DNS_TXT', now())`, [claim, orgId, reg, `wim-verify-${randomBytes(8).toString("hex")}`]);
      const [w] = await q(`INSERT INTO websites (org_id, domain_claim_id, name, canonical_origin, status, verified_at, updated_at) VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now()) RETURNING id`, [orgId, claim, `${tag}-${s}`, `https://${host}`]);
      // HTTP checks probe /toggle so the fixture's per-host "down" switch produces real failures (phase C retry storm)
      await q(`INSERT INTO monitoring_configurations (org_id, website_id, http_check, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, now())`,
        [orgId, w.id, JSON.stringify({ path: "/toggle" }), JSON.stringify({ enabled: browser, path: "/c/perf", viewports: ["desktop"], extraViewportsPerRun: 0 })]);
      sites.push(w.id);
    }
    orgs.push({ orgId, size, sites });
  }
}
report.seeded = { orgs: orgs.length, websites: orgs.reduce((a, o) => a + o.sites.length, 0) };
console.error(`seeded ${report.seeded.orgs} orgs / ${report.seeded.websites} websites`);

// ---------------------------------------------------------------- sampling
async function sample() {
  const [pgc] = await q(`SELECT (SELECT count(*) FROM pg_stat_activity)::int AS conns, (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock')::int AS lock_waits`);
  const [ex] = await q(`SELECT count(*) FILTER (WHERE status IN ('QUEUED','SCHEDULED','RETRYING'))::int AS waiting, count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
                               extract(epoch FROM now() - min(queued_at) FILTER (WHERE status IN ('QUEUED','SCHEDULED')))::int AS oldest_wait FROM monitoring_executions WHERE queued_at > now() - interval '1 hour'`);
  const hb = await q(`SELECT kind, (meta->>'cpuPct')::int AS cpu, rss_mb FROM worker_heartbeats WHERE last_seen_at > now() - interval '30 seconds'`);
  let redis = null;
  try { const info = execSync(`docker compose -f ${new URL("../../../../infra/compose/docker-compose.dev.yml", import.meta.url).pathname} exec -T redis redis-cli -a ${new URL(env.REDIS_URL).password} --no-auth-warning info`, { encoding: "utf8" }); redis = { usedMb: Math.round(Number(/used_memory:(\d+)/.exec(info)[1]) / 1048576), opsPerSec: Number(/instantaneous_ops_per_sec:(\d+)/.exec(info)[1]), clients: Number(/connected_clients:(\d+)/.exec(info)[1]) }; } catch { /* optional */ }
  return { at: Date.now(), ...pgc, ...ex, workers: hb, redis };
}

async function measure(name, durationSec, during) {
  const t0 = new Date();
  const samples = [];
  const stop = Date.now() + durationSec * 1000;
  const bg = during ? during(stop) : Promise.resolve(null);
  while (Date.now() < stop) { samples.push(await sample()); await sleep(15_000); }
  const extra = await bg;
  const orgIds = orgs.map((o) => o.orgId);
  const rows = await q(`
    SELECT e.org_id, e.tier::text AS tier, e.status::text AS status, e.attempt,
           extract(epoch FROM e.started_at - coalesce(e.enqueued_at, e.queued_at)) * 1000 AS wait_ms, e.duration_ms, e.failure_category
      FROM monitoring_executions e WHERE e.org_id = ANY($1::uuid[]) AND e.queued_at >= $2 AND e.queued_at < now()`, [orgIds, t0]);
  const res = await q(`SELECT r.tier::text AS tier, r.outcome, count(*)::int AS n FROM execution_results r WHERE r.org_id = ANY($1::uuid[]) AND r.recorded_at >= $2 GROUP BY 1, 2`, [orgIds, t0]);
  const byTier = {};
  for (const tier of ["T1_HTTP", "T2_RENDER", "T3_DEEP"]) {
    const r = rows.filter((x) => x.tier === tier);
    if (!r.length) continue;
    const waits = r.filter((x) => x.wait_ms !== null).map((x) => Number(x.wait_ms));
    const durs = r.filter((x) => x.duration_ms !== null).map((x) => Number(x.duration_ms));
    byTier[tier] = {
      executions: r.length, perSec: Math.round((r.length / durationSec) * 100) / 100,
      status: Object.fromEntries([...new Set(r.map((x) => x.status))].map((s) => [s, r.filter((x) => x.status === s).length])),
      retried: r.filter((x) => x.attempt > 1).length, waitMs: { p50: pct(waits, 0.5), p95: pct(waits, 0.95), p99: pct(waits, 0.99) },
      durationMs: { p50: pct(durs, 0.5), p95: pct(durs, 0.95), p99: pct(durs, 0.99) },
      errorRatePct: Math.round((r.filter((x) => ["FAILED", "DEAD_LETTERED", "TIMED_OUT"].includes(x.status)).length / r.length) * 1000) / 10,
      outcomes: Object.fromEntries(res.filter((x) => x.tier === tier).map((x) => [x.outcome, x.n])),
    };
  }
  // fairness: executions per website per size class (every tenant gets its schedule, regardless of size)
  const per = {};
  for (const o of orgs) {
    const n = rows.filter((x) => x.org_id === o.orgId && x.tier === "T1_HTTP").length;
    (per[o.size] ??= []).push(n / o.sites.length);
  }
  const fairness = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { minPerSite: Math.min(...v), medianPerSite: pct(v, 0.5) }]));
  const [overdue] = await q(`SELECT count(*)::int AS n FROM monitoring_schedules WHERE org_id = ANY($1::uuid[]) AND status = 'ACTIVE' AND next_run_at < now() - make_interval(secs => interval_sec) - interval '2 minutes'`, [orgIds]);
  // tenant isolation under concurrency: every result and incident belongs to its website's organisation
  const [iso] = await q(`SELECT (SELECT count(*) FROM execution_results r JOIN websites w ON w.id = r.website_id WHERE r.org_id <> w.org_id AND r.recorded_at >= $1)::int AS ledger_mismatch,
                                (SELECT count(*) FROM incidents i JOIN websites w ON w.id = i.website_id WHERE i.org_id <> w.org_id)::int AS incident_mismatch,
                                (SELECT count(*) FROM page_test_results p JOIN websites w ON w.id = p.website_id WHERE p.org_id <> w.org_id AND p.tested_at >= $1)::int AS result_mismatch`, [t0]);
  const s = samples;
  report.phases[name] = {
    durationSec, byTier, fairness, overdueSchedulesAtEnd: overdue.n, tenantIsolation: iso,
    queue: { waitingMax: Math.max(0, ...s.map((x) => x.waiting)), runningMax: Math.max(0, ...s.map((x) => x.running)), oldestWaitSecMax: Math.max(0, ...s.map((x) => x.oldest_wait ?? 0)) },
    postgres: { connectionsMax: Math.max(...s.map((x) => x.conns)), lockWaitsMax: Math.max(...s.map((x) => x.lock_waits)) },
    redis: s.at(-1)?.redis ?? null,
    workerCpuPctMax: Object.fromEntries([...new Set(s.flatMap((x) => x.workers.map((w) => w.kind)))].map((k) => [k, Math.max(...s.flatMap((x) => x.workers.filter((w) => w.kind === k).map((w) => w.cpu ?? 0)))])),
    workerRssMbMax: Object.fromEntries([...new Set(s.flatMap((x) => x.workers.map((w) => w.kind)))].map((k) => [k, Math.max(...s.flatMap((x) => x.workers.filter((w) => w.kind === k).map((w) => w.rss_mb ?? 0)))])),
    ...(extra ? { dashboard: extra } : {}),
  };
  console.error(`phase ${name} done`);
  console.error(`PHASE_REPORT ${JSON.stringify({ [name]: report.phases[name] })}`);
}

// ---------------------------------------------------------------- dashboard sessions (blocker 8)
class Session {
  cookies = new Map();
  async req(method, path, body) {
    const headers = { origin: env.APP_URL ?? "http://localhost:3000", accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET") { if (!this.cookies.get("wim_csrf")) await this.req("GET", "/api/v1/auth/csrf"); headers["x-csrf-token"] = this.cookies.get("wim_csrf"); headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
    const t = Date.now();
    const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t, body: text ? JSON.parse(text) : null };
  }
}
async function customer(i) {
  // Dashboard users are created directly (registration is rate-limited per IP — correctly — and the harness runs from one
  // address). Each gets a real server-side session (token hashed like the API does); every request goes through the
  // real API with session cookie, RLS and permission checks.
  const s = new Session();
  const { createHash, randomBytes: rb } = await import("node:crypto");
  const token = rb(32).toString("base64url");
  const [u] = await q(`INSERT INTO users (email, email_verified_at, password_hash, name, status, updated_at)
                       VALUES ($1, now(), 'load-test-no-login', $2, 'ACTIVE', now()) RETURNING id`, [`load-${i}-${Date.now().toString(36)}@example.test`, `Load ${i}`]);
  await q(`INSERT INTO user_sessions (user_id, token_hash, csrf_secret, mfa_verified, expires_at) VALUES ($1, $2, $3, true, now() + interval '1 day')`,
    [u.id, createHash("sha256").update(token).digest("hex"), rb(32).toString("base64url")]);
  s.cookies.set("wim_sid", token);
  const org = orgs.filter((o) => o.size === "large")[i % SIZES.large.orgs];
  const [ownerRole] = await q(`SELECT id FROM roles WHERE key = 'OWNER' AND org_id IS NULL`);
  await q(`INSERT INTO organization_members (org_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [org.orgId, u.id, ownerRole.id]);
  const me = await s.req("GET", "/api/v1/me");
  if (me.status !== 200) throw new Error(`session not accepted: ${me.status}`);
  return { s, org };
}
async function dashboardLoad(stop) {
  if (!DASH_USERS) return null;
  const users = [];
  for (let i = 0; i < DASH_USERS; i++) users.push(await customer(i));
  const lat = {};
  let errors = 0, calls = 0;
  const day = 86_400_000;
  await Promise.all(users.map(async ({ s, org }) => {
    let round = 0;
    while (Date.now() < stop) {
      const w = org.sites[round % org.sites.length], b = `/api/v1/orgs/${org.orgId}`;
      const paths = {
        changes: `${b}/changes`, overview: `${b}/monitoring/overview`, history: `${b}/monitoring/history?limit=50`,
        perf: `${b}/websites/${w}/performance`, series30d: `${b}/websites/${w}/performance/series?metric=lcp&from=${new Date(Date.now() - 30 * day).toISOString()}`,
        components: `${b}/websites/${w}/components/changes?since=${new Date(Date.now() - 7 * day).toISOString()}`, responsive: `${b}/websites/${w}/responsive`,
        uptime: `${b}/websites/${w}/monitoring/http`,
      };
      await Promise.all(Object.entries(paths).map(async ([k, p]) => { const r = await s.req("GET", p); calls++; if (r.status >= 500 || r.status === 403) errors++; (lat[k] ??= []).push(r.ms); }));
      round++;
      await sleep(2000); // the 15 s polling of many users, compressed: each session refreshes everything every ~2 s
    }
  }));
  return { users: users.length, calls, errors, latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99) }])) };
}

// ---------------------------------------------------------------- phases
await sleep(30_000); // let the scheduler create schedules for the new websites
const PHASES = (env.LOAD_PHASES ?? "A,B,C").split(",");
if (env.LOAD_PREVIOUS) Object.assign(report.phases, JSON.parse(readFileSync(env.LOAD_PREVIOUS, "utf8")).phases);
if (PHASES.includes("A")) await measure("A_steady", PHASE_SEC);
if (PHASES.includes("B")) await measure("B_steady_plus_dashboard", PHASE_SEC, dashboardLoad);
// C: failures — 1/3 of hosts down (retry storm) + a worker-http crash mid-phase
if (PHASES.includes("C")) {
const down = hosts.filter((_, i) => i % 3 === 0);
for (const x of down) await fetch(`${CONTROL}/toggle?host=${x}&state=down`).catch(() => undefined);
setTimeout(() => { try { execSync(`for p in $(pgrep -f "dist/main.js"); do lsof -a -p $p -d cwd -Fn 2>/dev/null | grep -q "apps/worker-http$" && kill -9 $p; done; true`); console.error("killed worker-http"); } catch { /* */ } }, 60_000);
// detached, no inherited pipes: a synchronous exec would block until the restarted worker exits
setTimeout(() => { spawn("bash", ["-c", env.LOAD_RESTART_HTTP ?? "true"], { detached: true, stdio: "ignore" }).unref(); console.error("restarted worker-http"); }, 120_000);
await measure("C_retry_storm_and_worker_crash", PHASE_SEC);
for (const x of down) await fetch(`${CONTROL}/toggle?host=${x}&state=up`).catch(() => undefined);
}
report.finishedAt = new Date().toISOString();
report.cleanup = "orgs are suspended at the end";
await q(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs.map((o) => o.orgId)]);
console.log(JSON.stringify(report, null, 2));
await db.end();
