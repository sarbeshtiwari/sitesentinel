import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDb, type Db } from "@wim/db";
import { backfillPerformanceRollups, runPerformanceRollups } from "@wim/queue";
import { startHarness, userWithOrg, type Harness } from "../helpers/harness.js";
import { seedOrg } from "../helpers/monitoring.js";
import { addVerifiedSite, ensureTrial } from "../helpers/http-monitoring.js";

/**
 * Phase 4G scale test (local, single Docker Postgres — NOT a production load test).
 *
 * Volume: 24 organisations × 6 websites × 30 hours of browser results every 5 minutes × 2 viewports (≈ 100 k raw rows,
 * ≈ 50 k ledger rows), plus 90 days of daily rollups for long ranges. The raw rows are FIXTURE data inserted by the schema
 * owner (the engine path is covered by performance.test.ts with real browsers); the rollup job and the API are the real
 * code. Measures: backfill time, incremental run time, dashboard latency under concurrent polling by several tenants,
 * and that every tenant only ever sees its own websites.
 */
let h: Harness;
let c: pg.Client;
let worker: Db;
const ORGS = 24, SITES = 6, HOURS = 30, STEP_MIN = 5;
const tenants: Array<{ orgId: string; client: Awaited<ReturnType<typeof userWithOrg>>["client"]; sites: string[] }> = [];
const seeded: string[] = [];
let parked: string[] = [];
const timings: Record<string, number> = {};

beforeAll(async () => {
  h = await startHarness();
  c = h.owner;
  worker = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 4, omitSecrets: true });
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  // partitions for the seeded past (the maintenance job only pre-creates from yesterday on)
  for (let d = 0; d <= 3; d++) await c.query(`SELECT partitions.create_one(p, 'day', (current_date - $1::int)) FROM unnest(ARRAY['performance_metrics','monitoring_executions']) p`, [d]);
  for (let m = 0; m <= 4; m++) await c.query(`SELECT partitions.create_one(p, 'month', (date_trunc('month', current_date) - make_interval(months => $1))::date) FROM unnest(ARRAY['metrics_daily','metrics_hourly']) p`, [m]);
  const t0 = Date.now();
  for (let o = 0; o < ORGS; o++) {
    // 4 tenants are real signed-in customers (API clients); the rest add volume
    let orgId: string, client: Awaited<ReturnType<typeof userWithOrg>>["client"] | null = null;
    if (o < 4) { const u = await userWithOrg(h.app, `load${o}`); orgId = u.orgId; client = u.client; await ensureTrial(c, orgId); }
    else orgId = (await seedOrg(c, 0, { tag: "load" })).orgId;
    seeded.push(orgId);
    const sites: string[] = [];
    for (let s = 0; s < SITES; s++) sites.push(await addVerifiedSite(c, orgId, `https://load-${o}-${s}-${orgId.slice(0, 6)}.example`));
    if (client) tenants.push({ orgId, client, sites });
    // ledger + raw synthetic results (fixture data), every 5 minutes for 30 hours, 2 viewports; every 20th run INCONCLUSIVE
    // (two statements: the ledger trigger must see the ledger rows, which a single CTE statement would hide)
    await c.query(`
      INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt, recorded_at)
      SELECT gen_random_uuid(), $1, w, 'T2_RENDER', date_trunc('minute', now()) - make_interval(mins => g * ${STEP_MIN}),
             CASE WHEN g % 20 = 0 THEN 'INCONCLUSIVE' ELSE 'PASSED' END, 1, date_trunc('minute', now()) - make_interval(mins => g * ${STEP_MIN}) + interval '30 seconds'
        FROM unnest($2::uuid[]) w, generate_series(1, ${(HOURS * 60) / STEP_MIN}) g`, [orgId, sites]);
    await c.query(`
      INSERT INTO performance_metrics (measured_at, org_id, website_id, execution_id, source, viewport, fcp_ms, lcp_ms, cls, tbt_ms, ttfb_ms, load_ms)
      SELECT r.window_start, $1, r.website_id, r.execution_id, 'SYNTHETIC', v, 800 + (g * 37) % 900, 1500 + (g * 53) % 2500, ((g * 7) % 30) / 100.0, (g * 11) % 500, 100 + (g * 13) % 600, 2000 + (g * 17) % 4000
        FROM (SELECT *, (extract(epoch FROM date_trunc('minute', now()) - window_start) / 60 / ${STEP_MIN})::int AS g FROM execution_results WHERE website_id = ANY($2::uuid[]) AND outcome <> 'INCONCLUSIVE') r,
             unnest(ARRAY['desktop','mobile-small']) v`, [orgId, sites]);
    // 90 days of daily rollups for long-range queries (fixture)
    await c.query(`
      INSERT INTO metrics_daily (bucket, org_id, website_id, subject_type, subject_id, metric, count, ok_count, sum, min, max, p50, p75, p95, histogram)
      SELECT (current_date - d), $1, w, 'WEBSITE', w, 'perf.lcp.desktop', 270, 270, 270 * 2200.0, 1500, 4000, 2100, 2600, 3600, '{"81":100,"84":120,"88":50}'::jsonb
        FROM unnest($2::uuid[]) w, generate_series(3, 92) d`, [orgId, sites]);
  }
  timings.seedMs = Date.now() - t0;
}, 900_000);
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [seeded]);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await worker.$disconnect();
  await h.stop();
  console.log("[4G load] timings", JSON.stringify(timings));
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;

describe("rollups at scale", () => {
  it("backfill of all tenants, then an incremental run, are bounded and exact", async () => {
    const t0 = Date.now();
    const all = await backfillPerformanceRollups(worker, new Date(Date.now() - (HOURS + 2) * 3_600_000), new Date(Date.now() + 3_600_000));
    timings.backfillMs = Date.now() - t0;
    expect(all.hours).toBeGreaterThanOrEqual(ORGS * SITES * HOURS);
    // exact: rolled-up count equals raw non-inconclusive rows for a sample website
    const w = tenants[0]!.sites[0]!;
    const { rows: [raw] } = await c.query(`SELECT count(*)::int AS n FROM performance_metrics p JOIN execution_results r ON r.execution_id = p.execution_id WHERE p.website_id = $1 AND p.viewport = 'desktop' AND p.lcp_ms IS NOT NULL AND r.outcome <> 'INCONCLUSIVE'`, [w]);
    const { rows: [rolled] } = await c.query(`SELECT sum(count)::int AS n FROM metrics_hourly WHERE website_id = $1 AND subject_type = 'WEBSITE' AND metric = 'perf.lcp.desktop'`, [w]);
    expect(rolled.n).toBe(raw.n);
    // incremental run right after: only recently recorded buckets, fast
    await c.query(`INSERT INTO rollup_state (name, watermark, last_run_at) VALUES ('performance', now() - interval '20 minutes', now()) ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark`);
    const t1 = Date.now();
    const inc = await runPerformanceRollups(worker);
    timings.incrementalMs = Date.now() - t1;
    expect(inc.ran).toBe(true);
    // ≈ the last hour or two per website that recorded browser results recently (incl. other test files), not all history
    const { rows: [recent] } = await c.query(`SELECT count(DISTINCT website_id)::int AS n FROM execution_results WHERE tier = 'T2_RENDER' AND recorded_at > now() - interval '40 minutes'`);
    expect(inc.hours).toBeLessThanOrEqual(recent.n * 2);
    expect(inc.hours).toBeLessThan(ORGS * SITES * HOURS / 10);
    expect(timings.incrementalMs).toBeLessThan(30_000);
    // the dashboard rollup query uses the (website_id, metric, bucket) index, not a full scan
    const plan = (await c.query(`EXPLAIN SELECT * FROM metrics_hourly WHERE org_id = $1 AND subject_type = 'WEBSITE' AND metric LIKE 'perf.%.desktop' AND website_id = ANY($2::uuid[]) AND bucket >= now() - interval '1 day'`, [tenants[0]!.orgId, tenants[0]!.sites])).rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index|Bitmap/);
  }, 900_000);
});

describe("dashboard under concurrent polling by several tenants", () => {
  it("p95 latency stays bounded; every tenant only ever sees its own websites", async () => {
    const lat: Record<string, number[]> = {};
    const call = async (t: (typeof tenants)[number], name: string, path: string) => {
      const s = Date.now();
      const r = await t.client.get(path);
      (lat[name] ??= []).push(Date.now() - s);
      expect(r.status, `${name} ${path}`).toBe(200);
      return r.body;
    };
    // 4 tenants × 10 rounds of a full dashboard refresh, all tenants concurrently (≈ 15 s polling compressed)
    await Promise.all(tenants.map(async (t) => {
      for (let round = 0; round < 10; round++) {
        const w = t.sites[round % t.sites.length]!;
        const base = `/api/v1/orgs/${t.orgId}/websites/${w}`;
        const [ov] = await Promise.all([
          call(t, "overview", `/api/v1/orgs/${t.orgId}/monitoring/overview`),
          call(t, "changes", `/api/v1/orgs/${t.orgId}/changes`),
          call(t, "performance", `${base}/performance`),
          call(t, "series24h", `${base}/performance/series?metric=lcp`),
          call(t, "series90d", `${base}/performance/series?metric=lcp&from=${new Date(Date.now() - 89 * 86_400_000).toISOString()}`),
          call(t, "history", `/api/v1/orgs/${t.orgId}/monitoring/history?limit=50`),
        ]);
        const ids = ov.data.websites.map((x: { id: string }) => x.id).sort();
        expect(ids).toEqual([...t.sites].sort()); // no other tenant's website
      }
    }));
    const summary = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p95: p95(v), max: Math.max(...v) }]));
    timings.latency = summary as never;
    console.log("[4G load] latency ms", JSON.stringify(summary));
    for (const [k, v] of Object.entries(summary)) expect(v.p95, k).toBeLessThan(5000);
    // long range: daily rollups with 90 days, explicit gaps for days without rows
    const t = tenants[0]!;
    const s90 = (await t.client.get(`/api/v1/orgs/${t.orgId}/websites/${t.sites[0]}/performance/series?metric=lcp&from=${new Date(Date.now() - 89 * 86_400_000).toISOString()}`)).body.data;
    expect(s90.grain).toBe("day");
    expect(s90.points.length).toBeGreaterThanOrEqual(89);
    expect(s90.points.filter((p: { samples: number }) => p.samples > 0).length).toBeGreaterThan(80);
  }, 900_000);
});
