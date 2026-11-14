import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { EMAIL_QUEUE } from "@wim/contracts";
import { createDb, type Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createHeartbeat, QUEUES, reconcileUsageDay, runPlatformEvaluation } from "@wim/queue";
import { Client, createAdmin, startHarness, totpCode, type Harness } from "../helpers/harness.js";
import { seedOrg } from "../helpers/monitoring.js";

/**
 * Phase 4H operational load (local, single Docker Postgres/Redis — NOT production evidence).
 *  - 150 workers heartbeating concurrently (write volume and latency)
 *  - 7 days of worker samples / state history (system_health_logs) for the history view
 *  - 120 organisations × 1 500 ledger rows for one day (180 k rows) → reconciliation cost
 *  - 30 evaluations → evaluation latency
 *  - 8 operators polling health / alerts / usage / history concurrently
 */
let h: Harness;
let c: pg.Client;
let db: Db;
let redis: Redis;
const timings: Record<string, unknown> = {};
const prefix = `wimtest-opsload-${randomBytes(3).toString("hex")}`;
let queues: Record<string, Queue>;
const log = createLogger("ops-load", { level: "silent" });
const ORGS = 120, ROWS = 1500, WORKERS = 150;
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const orgIds: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  c = h.owner;
  db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 20, omitSecrets: true });
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queues = Object.fromEntries([QUEUES.http, QUEUES.browser, QUEUES.deepscan, EMAIL_QUEUE].map((n) => [n, new Queue(n, { connection: redis, prefix })]));
  await c.query(`DELETE FROM worker_heartbeats`);
  const t0 = Date.now();
  // organisations + websites (minimal rows) and one day of ledger rows + matching counters (one deliberate mismatch)
  const sites: Array<{ id: string; org_id: string }> = [];
  for (let i = 0; i < ORGS; i++) {
    const o = await seedOrg(c, 1, { tag: "opsload", trial: "NONE" });
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [o.orgId]); // never scheduled
    orgIds.push(o.orgId);
    sites.push({ id: o.websiteIds[0]!, org_id: o.orgId });
  }
  if (sites.length === ORGS) {
    await c.query(`
      INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt, recorded_at)
      SELECT gen_random_uuid(), s.org_id, s.id, 'T1_HTTP', $2::date + make_interval(secs => g * 50), CASE WHEN g % 25 = 0 THEN 'INCONCLUSIVE' ELSE 'PASSED' END, 1, $2::date + make_interval(secs => g * 50 + 5)
        FROM unnest($1::uuid[], $3::uuid[]) AS s(id, org_id), generate_series(1, ${ROWS}) g`, [sites.map((s) => s.id), day, sites.map((s) => s.org_id)]);
    await c.query(`
      INSERT INTO usage_counters (org_id, period_start, key, value, updated_at)
      SELECT o, $2::date, k, CASE k WHEN 'http.checks' THEN ${ROWS} ELSE ${ROWS / 25} END + CASE WHEN o = $3::uuid AND k = 'http.checks' THEN 1 ELSE 0 END, now()
        FROM unnest($1::uuid[]) o, unnest(ARRAY['http.checks', 'http.inconclusive']) k
      ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = EXCLUDED.value`, [orgIds, day, orgIds[0]]);
  }
  timings.ledgerRows = sites.length * ROWS;
  // 7 days of history: a sample per worker kind every 2 minutes, state transitions
  await c.query(`
    INSERT INTO system_health_logs (recorded_at, component, metric, value, labels)
    SELECT now() - make_interval(mins => g * 2), 'worker', 'sample', g % 4, jsonb_build_object('kind', k, 'worker', k || '-' || (g % 10), 'capacity', 4, 'processed', g, 'failed', 0, 'rss', 200)
      FROM generate_series(1, 5040) g, unnest(ARRAY['http-monitoring', 'browser-monitoring', 'deep-scan', 'email']) k`);
  timings.seedMs = Date.now() - t0;
}, 900_000);
afterAll(async () => {
  for (const q of Object.values(queues)) await q.close();
  await c.query(`DELETE FROM worker_heartbeats`);
  await c.query(`DELETE FROM usage_counters WHERE org_id = ANY($1::uuid[])`, [orgIds]);
  redis.disconnect();
  await db.$disconnect();
  await h.stop();
  console.log("[4H ops load]", JSON.stringify(timings));
});

describe("health monitoring is not itself a significant load", () => {
  it("150 workers heartbeating concurrently: bounded write latency; one row each", async () => {
    const hbs = Array.from({ length: WORKERS }, (_, i) => createHeartbeat({
      db, connection: redis, log, workerId: `load-w-${i}`, kind: ["http-monitoring", "browser-monitoring", "deep-scan"][i % 3]!,
      gauges: () => ({ activeJobs: i % 4, capacity: 4, processed: i, failed: 0, timeouts: 0, lastJobAt: new Date() }),
    }));
    const lat: number[] = [];
    for (let round = 0; round < 3; round++) {
      await Promise.all(hbs.map(async (b) => { const t = Date.now(); await b.beat(); lat.push(Date.now() - t); }));
    }
    timings.heartbeat = { writes: lat.length, p95: p95(lat), max: Math.max(...lat), perWorkerPerMinute: 6 /* every 10 s */, samplesPerWorkerPerHour: 30 };
    expect((await c.query(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_id LIKE 'load-w-%'`)).rows[0].n).toBe(WORKERS);
    expect(p95(lat)).toBeLessThan(2000);
  }, 300_000);

  it("evaluation latency with 150 workers and 7 days of history", async () => {
    const lat: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = Date.now();
      const r = await runPlatformEvaluation({ db, connection: redis, queues, evaluatorId: "load", log }, { force: true });
      expect(r.ran).toBe(true);
      lat.push(Date.now() - t);
    }
    timings.evaluation = { n: lat.length, p95: p95(lat), max: Math.max(...lat) };
    expect(p95(lat)).toBeLessThan(5000);
  }, 300_000);

  it("reconciliation of one day with 180 k ledger rows across 120 organisations", async () => {
    const t = Date.now();
    const r = await reconcileUsageDay(db, day);
    timings.reconciliation = { ms: Date.now() - t, ledgerRows: timings.ledgerRows, discrepanciesForLoadOrgs: Number((await c.query(`SELECT count(*) FROM usage_discrepancies WHERE run_id = $1 AND org_id = ANY($2::uuid[]) AND "check" <> 'results~ledger'`, [r.runId, orgIds])).rows[0].count) };
    expect((timings.reconciliation as { discrepanciesForLoadOrgs: number }).discrepanciesForLoadOrgs).toBe(1); // exactly the planted one
    expect(Date.now() - t).toBeLessThan(120_000);
  }, 300_000);

  it("8 operators polling the Super Admin operations pages concurrently", async () => {
    const admins = await Promise.all(Array.from({ length: 8 }, async () => {
      const a = await createAdmin("SUPER_ADMIN");
      const cl = Client.admin(h.app);
      expect((await cl.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret, true) })).status).toBe(200);
      return cl;
    }));
    const lat: Record<string, number[]> = {};
    const call = async (cl: Client, name: string, path: string) => {
      const t = Date.now();
      const r = await cl.get(path);
      (lat[name] ??= []).push(Date.now() - t);
      expect(r.status, `${name}`).toBe(200);
    };
    await Promise.all(admins.map(async (cl) => {
      for (let i = 0; i < 8; i++) {
        await Promise.all([
          call(cl, "health", "/api/admin/v1/ops/health"),
          call(cl, "alerts", "/api/admin/v1/ops/alerts"),
          call(cl, "history24h", "/api/admin/v1/ops/history?hours=24"),
          call(cl, "history7d", "/api/admin/v1/ops/history?hours=168"),
          call(cl, "usage30d", `/api/admin/v1/ops/usage?from=${new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`),
          call(cl, "config", "/api/admin/v1/ops/config"),
        ]);
      }
    }));
    timings.admin = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p95: p95(v), max: Math.max(...v) }]));
    for (const [k, v] of Object.entries(lat)) expect(p95(v), k).toBeLessThan(5000);
  }, 600_000);
});
