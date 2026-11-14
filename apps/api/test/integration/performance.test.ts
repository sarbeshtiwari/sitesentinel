import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@wim/db";
import { backfillPerformanceRollups, runPerformanceRollups } from "@wim/queue";
import { inviteAndAccept, startHarness, userWithOrg, verifiedUser, type Harness } from "../helpers/harness.js";
import { resetMonitoringSettings, until } from "../helpers/monitoring.js";
import { addVerifiedSite, ensureTrial, incidentsOf } from "../helpers/http-monitoring.js";
import { browserSettings, entitleBrowser, ledger, startBrowserEnv, BROWSER_QUEUE_POLICY, type BrowserEnv } from "../helpers/browser-monitoring.js";

/**
 * Phase 4G — performance thresholds, incidents, rollups, trends, pages, components, responsive and the dashboard APIs,
 * from REAL browser executions (Chromium through the production runner and the egress gateway) against the fixture
 * site, read back through the real API as customers.
 */
let h: Harness;
let env: BrowserEnv;
let parked: string[] = [];
const orgs: string[] = [];
const POLICY = { ...BROWSER_QUEUE_POLICY, timeoutMs: 60_000 };

beforeAll(async () => {
  h = await startHarness();
  env = await startBrowserEnv();
  parked = (await env.owner.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await resetMonitoringSettings(env.owner);
  await browserSettings(env, { "queue.browser-monitoring": POLICY, "monitoring.rollups.enabled": true });
  await env.startBrowserWorker({ jobTimeoutMs: 60_000 });
}, 120_000);
afterAll(async () => {
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await env.owner.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(env.owner);
  await env.close();
  await h.stop();
});

async function customer(tag: string, customThresholds = true) {
  const u = await userWithOrg(h.app, tag);
  orgs.push(u.orgId);
  await ensureTrial(env.owner, u.orgId);
  await entitleBrowser(env, u.orgId);
  if (customThresholds) await env.owner.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.performance.customThresholds', 'true', 'test', gen_random_uuid())`, [u.orgId]);
  return u;
}
async function site(orgId: string, path: string, browserCheck: Record<string, unknown> = {}) {
  const host = `perf-${randomUUID().slice(0, 6)}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  await env.owner.query(`INSERT INTO monitoring_configurations (org_id, website_id, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, now())
    ON CONFLICT (website_id) DO UPDATE SET browser_check = EXCLUDED.browser_check`, [orgId, id, JSON.stringify({ path, extraViewportsPerRun: 0, ...browserCheck })]);
  return { id, host };
}
/** Run the next browser window (each run is moved 15 min into the past so windows are distinct and ordered). */
async function run(w: string, first = false) {
  if (!first) {
    const { rows: [cur] } = await env.owner.query<{ id: string; min: Date }>(`SELECT id, (SELECT min(queued_at) FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER') AS min
      FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' ORDER BY queued_at DESC LIMIT 1`, [w]);
    if (cur) {
      const t = new Date(cur.min.getTime() - 900_000);
      await env.owner.query(`UPDATE monitoring_executions SET queued_at = $2, slot = floor(extract(epoch FROM $2::timestamptz)) WHERE id = $1`, [cur.id, t]);
      for (const tb of ["page_test_results", "responsive_test_results", "component_test_results"]) await env.owner.query(`UPDATE ${tb} SET tested_at = $2 WHERE execution_id = $1`, [cur.id, t]);
      await env.owner.query(`UPDATE performance_metrics SET measured_at = $2 WHERE execution_id = $1`, [cur.id, t]);
      await env.owner.query(`UPDATE execution_results SET window_start = $2 WHERE execution_id = $1`, [cur.id, t]);
      await env.owner.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second', state_window_at = LEAST(state_window_at, $2) WHERE website_id = $1 AND tier = 'T2_RENDER'`, [w, t]);
    }
  }
  const n = first ? 0 : (await ledger(env, w)).length;
  await env.scheduler().runCycle();
  await until(async () => (await ledger(env, w)).length > n, 90_000, 200);
  return (await ledger(env, w)).at(-1)!;
}
const api = (o: string, w: string) => `/api/v1/orgs/${o}/websites/${w}`;
const rollupRows = async (w: string, table = "metrics_hourly") => (await env.owner.query(`SELECT bucket, subject_type, subject_id, metric, count, sum, min, max, p50, p75, p95, histogram FROM ${table} WHERE website_id = $1 AND metric LIKE 'perf.%' ORDER BY bucket, subject_type, metric`, [w])).rows;

describe("thresholds: configuration, entitlement, validation, audit", () => {
  it("defaults are visible; custom bounds need the entitlement; noise protection can always be tightened; changes are audited with before / after", async () => {
    const free = await customer("perfFree", false);
    const fs = await site(free.orgId, "/c/perf");
    const r0 = (await free.client.get(`${api(free.orgId, fs.id)}/performance/thresholds`)).body.data;
    expect(r0).toMatchObject({ customAllowed: false, alertOn: ["lcp", "cls"], effective: { lcp: { good: 2500, poor: 4000 }, ttfb: { good: 800, poor: 1800 } } });
    expect((await free.client.put(`${api(free.orgId, fs.id)}/performance/thresholds`, { thresholds: { ttfb: { good: 100, poor: 200 } } })).status).toBe(403);
    expect((await free.client.put(`${api(free.orgId, fs.id)}/performance/thresholds`, { consecutiveFailures: 4, recoveryPasses: 3 })).status).toBe(200);
    const paid = await customer("perfPaid");
    const ps = await site(paid.orgId, "/c/perf");
    const url = `${api(paid.orgId, ps.id)}/performance/thresholds`;
    expect((await paid.client.put(url, { thresholds: { ttfb: { good: 900, poor: 300 } } })).status).toBe(400);
    expect((await paid.client.put(url, { thresholds: { inp: { good: 1, poor: 2 } } })).status).toBe(400);
    expect((await paid.client.put(url, { alertOn: ["inp"] })).status).toBe(400);
    expect((await paid.client.put(url, { thresholds: { ttfb: { good: 300, poor: 800 } }, alertOn: ["ttfb"] })).status).toBe(200);
    const r1 = (await paid.client.get(url)).body.data;
    expect(r1).toMatchObject({ customAllowed: true, alertOn: ["ttfb"], effective: { ttfb: { good: 300, poor: 800 } } });
    expect(r1.history[0].changes).toMatchObject({ before: {}, after: { thresholds: { ttfb: { good: 300, poor: 800 } }, alertOn: ["ttfb"] } });
    const viewer = await verifiedUser(h.app, "perfViewer");
    await inviteAndAccept(paid.client, paid.orgId, viewer, "VIEWER");
    expect((await viewer.client.put(url, { consecutiveFailures: 2 })).status).toBe(403);
    expect((await viewer.client.get(url)).status).toBe(200);
  }, 120_000);
});

describe("performance incidents from real browser executions", () => {
  it("POOR needs N consecutive checks; one incident; inconclusive runs don't count; recovery needs M good checks; rollups are exact and idempotent", async () => {
    const u = await customer("perfInc");
    const s = await site(u.orgId, "/c/perf", { performance: { thresholds: { ttfb: { good: 400, poor: 900 } }, alertOn: ["ttfb"], consecutiveFailures: 2, recoveryPasses: 2 } });
    const perfIncidents = async () => (await incidentsOf(env.owner, s.id)).filter((i) => i.check_key === "browser.performance");
    const l0 = await run(s.id, true);
    expect(l0.outcome).toBe("PASSED");
    env.site.toggles.set(`${s.host}#perf`, "slow");
    const l1 = await run(s.id);
    expect(l1.outcome).toBe("FAILED");
    expect((await env.owner.query(`SELECT failure_kind FROM page_test_results WHERE execution_id = $1`, [l1.execution_id])).rows[0].failure_kind).toBe("TTFB_POOR");
    expect(await perfIncidents()).toHaveLength(0); // one poor check is noise
    // an INCONCLUSIVE run in between (runner down) neither counts nor resets the streak
    await env.stopBrowserWorkers();
    await env.startBrowserWorker({ runnerUrl: "http://127.0.0.1:9", jobTimeoutMs: 60_000 });
    const li = await run(s.id);
    expect(li.outcome).toBe("INCONCLUSIVE");
    await env.stopBrowserWorkers();
    await env.startBrowserWorker({ jobTimeoutMs: 60_000 });
    expect(await perfIncidents()).toHaveLength(0);
    await run(s.id);
    const open = await perfIncidents();
    expect(open.map((i) => [i.category, i.status, i.source])).toEqual([["PERFORMANCE", "OPEN", "BROWSER"]]);
    await run(s.id); // still poor: same incident, one more occurrence
    expect(await perfIncidents()).toHaveLength(1);
    expect((await perfIncidents())[0]!.occurrence_count).toBeGreaterThanOrEqual(2);
    env.site.toggles.delete(`${s.host}#perf`);
    await run(s.id);
    expect((await perfIncidents())[0]!.status).toBe("OPEN"); // one good check is not recovery
    await run(s.id);
    expect((await perfIncidents())[0]).toMatchObject({ status: "RESOLVED", auto_resolved: true });

    // ---- rollups: exact against raw, inconclusive excluded, idempotent, backfill reproduces
    const r = await runPerformanceRollups(env.db);
    expect(r.ran).toBe(true);
    const raw = (await env.owner.query(`SELECT ttfb_ms FROM performance_metrics WHERE website_id = $1 AND viewport = 'desktop' ORDER BY ttfb_ms`, [s.id])).rows.map((x) => x.ttfb_ms);
    expect(raw.length).toBe(6); // 7 executions, one inconclusive (no metrics)
    const rows = await rollupRows(s.id);
    const web = rows.filter((x) => x.subject_type === "WEBSITE" && x.metric === "perf.ttfb.desktop");
    expect(web.reduce((a, b) => a + b.count, 0)).toBe(6);
    expect(web.reduce((a, b) => a + Number(b.sum), 0)).toBe(raw.reduce((a: number, b: number) => a + b, 0));
    const page = rows.filter((x) => x.subject_type === "PAGE" && x.metric === "perf.ttfb.desktop");
    expect(page.reduce((a, b) => a + b.count, 0)).toBe(6);
    const daily = (await rollupRows(s.id, "metrics_daily")).filter((x) => x.subject_type === "WEBSITE" && x.metric === "perf.ttfb.desktop");
    expect(daily.reduce((a, b) => a + b.count, 0)).toBe(6);
    // idempotent: running again over the same data changes nothing
    await env.owner.query(`UPDATE rollup_state SET watermark = now() - interval '1 day' WHERE name = 'performance'`);
    await runPerformanceRollups(env.db);
    expect(await rollupRows(s.id)).toEqual(rows);
    // backfill after loss reproduces the same rows
    await env.owner.query(`DELETE FROM metrics_hourly WHERE website_id = $1`, [s.id]);
    await backfillPerformanceRollups(env.db, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() + 3_600_000), [s.id]);
    expect(await rollupRows(s.id)).toEqual(rows);
    // concurrent runs: one takes the lock, the other is a no-op; no duplicate rows (primary key)
    const [a, b] = await Promise.all([runPerformanceRollups(env.db), runPerformanceRollups(env.db)]);
    expect([a.ran, b.ran].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await rollupRows(s.id)).toEqual(rows);

    // ---- API: summary, series with explicit gaps, page comparison, overview, history
    const base = api(u.orgId, s.id);
    const sum = (await u.client.get(`${base}/performance`)).body.data;
    const ttfb = sum.metrics.find((m: { metric: string }) => m.metric === "ttfb");
    expect(ttfb).toMatchObject({ samples: 6, alerting: true, thresholds: { good: 400, poor: 900 }, sufficient: true });
    expect(ttfb.max).toBe(raw[raw.length - 1]);
    expect(ttfb.min).toBe(raw[0]);
    expect(sum.measurement).toBe("SYNTHETIC_BROWSER");
    expect(sum.quality).toMatchObject({ recordedChecks: 7, inconclusiveChecks: 1 });
    expect(sum.metrics.find((m: { metric: string }) => m.metric === "inp")).toBeUndefined();
    const series = (await u.client.get(`${base}/performance/series?metric=ttfb`)).body.data;
    expect(series.grain).toBe("hour");
    expect(series.points.length).toBeGreaterThanOrEqual(24);
    expect(series.points.reduce((a: number, p: { samples: number }) => a + p.samples, 0)).toBe(6);
    for (const p of series.points.filter((x: { samples: number }) => x.samples === 0)) expect(p).toMatchObject({ p75: null, status: "INSUFFICIENT_DATA" });
    const old = (await u.client.get(`${base}/performance/series?metric=ttfb&from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z`)).body.data;
    expect(old.points.every((p: { samples: number }) => p.samples === 0)).toBe(true);
    expect((await u.client.get(`${base}/performance/series?metric=ttfb&from=2026-03-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
    expect((await u.client.get(`${base}/performance/series?metric=ttfb&from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`)).status).toBe(400);
    expect((await u.client.get(`${base}/performance/series?metric=inp`)).status).toBe(400);
    const month = (await u.client.get(`${base}/performance/series?metric=ttfb&from=${new Date(Date.now() - 30 * 86_400_000).toISOString()}`)).body.data;
    expect(month.grain).toBe("day");
    expect(month.points.reduce((a: number, p: { samples: number }) => a + p.samples, 0)).toBe(6);
    const pages = (await u.client.get(`${base}/performance/pages`)).body.data;
    expect(pages.pages).toHaveLength(1);
    expect(pages.pages[0]).toMatchObject({ path: "/c/perf", metrics: { ttfb: { samples: 6 } } });
    const pageSeries = (await u.client.get(`${base}/performance/series?metric=ttfb&pageId=${pages.pages[0].pageId}`)).body.data;
    expect(pageSeries.points.reduce((a: number, p: { samples: number }) => a + p.samples, 0)).toBe(6);
    const ov = (await u.client.get(`/api/v1/orgs/${u.orgId}/monitoring/overview`)).body.data;
    expect(ov.websites[0].performance).toMatchObject({ samples: expect.any(Number) });
    expect(["GOOD", "NEEDS_IMPROVEMENT", "POOR", "INSUFFICIENT_DATA"]).toContain(ov.websites[0].performance.status);
    expect(Array.isArray(ov.recentChanges)).toBe(true);
    const hist = (await u.client.get(`/api/v1/orgs/${u.orgId}/monitoring/history?websiteId=${s.id}&limit=100`)).body;
    expect(hist.retention).toMatchObject({ browserDays: 62 });
  }, 600_000);
});

describe("pages, components, responsive dashboards", () => {
  it("pages show monitoring scope honestly; component visibility changes and since-comparison; responsive latest, runs and comparison", async () => {
    const u = await customer("perfPages");
    const s = await site(u.orgId, "/c/shop", { viewports: ["desktop", "mobile-small"], extraViewportsPerRun: 1 });
    const l1 = await run(s.id, true);
    // a page known only from a deep scan (inventory row) — not browser-monitored
    await env.owner.query(`INSERT INTO discovered_pages (org_id, website_id, url, url_hash, path_template, source, depth) VALUES ($1, $2, $3, md5($3), '/c/about', 'SITEMAP', 1)`, [u.orgId, s.id, `http://${s.host}/c/about`]);
    const pages = (await u.client.get(`${api(u.orgId, s.id)}/pages`)).body;
    const shop = pages.data.find((p: { path: string }) => p.path === "/c/shop");
    const about = pages.data.find((p: { path: string }) => p.path === "/c/about");
    expect(shop.monitoring).toMatchObject({ browser: true });
    expect(shop.components.present).toBeGreaterThan(5);
    expect(shop.responsive).toMatchObject({ viewports: 2, failedViewports: 0 });
    expect(about.monitoring).toMatchObject({ browser: false });
    expect(about.browser).toBeNull();
    expect(pages.scope.browserPath).toBe("/c/shop");
    const since = new Date().toISOString();
    env.site.toggles.set(`${s.host}#c`, "hide-search-mobile");
    const l2 = await run(s.id);
    const changes = (await u.client.get(`${api(u.orgId, s.id)}/components/changes?since=${since}`)).body.data;
    expect(changes.visibility.map((c: { type: string }) => c.type)).toContain("SEARCH");
    expect(changes).toMatchObject({ complete: true, removed: [] });
    const search = (await u.client.get(`${api(u.orgId, s.id)}/components?type=SEARCH`)).body.data[0];
    const detail = (await u.client.get(`${api(u.orgId, s.id)}/components/${search.id}`)).body.data;
    expect(detail.visibility).toMatchObject({ desktop: true, "mobile-small": false });
    expect(detail.history[0]).toMatchObject({ type: "VISIBILITY", before: { "mobile-small": true }, after: { "mobile-small": false } });
    const hist = (await u.client.get(`/api/v1/orgs/${u.orgId}/monitoring/history?type=COMPONENT`)).body.data;
    expect(hist.some((e: { title: string }) => /visibility changed/.test(e.title))).toBe(true);
    const resp = (await u.client.get(`${api(u.orgId, s.id)}/responsive`)).body.data;
    expect(resp.latest.map((r: { viewport: string }) => r.viewport).sort()).toEqual(["desktop", "mobile-small"]);
    expect(resp.runs).toHaveLength(2);
    const cmp = (await u.client.get(`${api(u.orgId, s.id)}/responsive/compare?a=${l1.execution_id}&b=${l2.execution_id}`)).body.data;
    expect(cmp.viewports.every((v: { comparable: boolean }) => v.comparable)).toBe(true);
    const mobile = cmp.viewports.find((v: { viewport: string }) => v.viewport === "mobile-small");
    expect(mobile.b.heuristic.join(" ")).toMatch(/search .* visible on wider screens but not here/);
    env.site.toggles.delete(`${s.host}#c`);

    // ---- tenant isolation of every new endpoint
    const other = await userWithOrg(h.app, "perfOther");
    orgs.push(other.orgId);
    for (const p of ["/performance", "/performance/series?metric=lcp", "/performance/pages", "/performance/thresholds", "/pages", "/responsive", `/components/${search.id}`, `/components/changes?since=${since}`, `/responsive/compare?a=${l1.execution_id}&b=${l2.execution_id}`]) {
      expect((await other.client.get(`${api(other.orgId, s.id)}${p}`)).status, p).toBe(404);
      expect((await other.client.get(`${api(u.orgId, s.id)}${p}`)).status, p).toBe(404);
    }
    expect((await other.client.put(`${api(other.orgId, s.id)}/performance/thresholds`, { consecutiveFailures: 2 })).status).toBe(404);
    // the customer role can read rollups of its own organisation only and write none
    const app = createDb({ url: process.env.DATABASE_URL!, max: 1, omitSecrets: true });
    await expect(app.$executeRawUnsafe(`UPDATE metrics_hourly SET count = 0`)).rejects.toThrow(/permission denied/);
    await expect(app.$executeRawUnsafe(`INSERT INTO rollup_state (name, watermark, last_run_at) VALUES ('x', now(), now())`)).rejects.toThrow(/permission denied/);
    await app.$disconnect();
    // a rollup row can't be attributed to another organisation's website
    await expect(env.owner.query(`INSERT INTO metrics_hourly (bucket, org_id, website_id, subject_type, subject_id, metric, count, ok_count, sum) VALUES (date_trunc('hour', now()), $1, $2, 'WEBSITE', $2, 'perf.lcp.desktop', 1, 1, 1)`, [other.orgId, s.id])).rejects.toThrow(/does not match/);
  }, 300_000);
});
