import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@wim/db";
import { Client, createAdmin, startHarness, totpCode, userWithOrg, type Harness } from "../helpers/harness.js";
import { resetMonitoringSettings, until } from "../helpers/monitoring.js";
import { addVerifiedSite, ensureTrial } from "../helpers/http-monitoring.js";
import { deepSettings, entitleDeep, nextDeepWindow, scanNow, scansOf, startDeepEnv, type DeepEnv } from "../helpers/deep-scan.js";

/** Phase 4E customer API (tenant-scoped), manual scans, pause/cancel, findings and history, usage, admin aggregates. */
let h: Harness;
let env: DeepEnv;
let parked: string[] = [];
const orgs: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  env = await startDeepEnv();
  parked = (await env.owner.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await env.owner.query(`UPDATE deep_scans SET status = 'CANCELLED' WHERE status = 'RUNNING'`);
  await resetMonitoringSettings(env.owner);
  await deepSettings(env);
  await env.startDeepWorker();
  // the API process enqueues manual scans under its own prefix (one prefix in production; two in this harness)
  await env.startDeepWorker({ prefix: process.env.QUEUE_PREFIX });
}, 120_000);
afterAll(async () => {
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await env.owner.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(env.owner);
  await env.close();
  await h.stop();
});

async function customer(tag: string, entitled = true) {
  const u = await userWithOrg(h.app, tag);
  orgs.push(u.orgId);
  await ensureTrial(env.owner, u.orgId);
  if (entitled) await entitleDeep(env, u.orgId);
  return u;
}
async function site(orgId: string, variant = "mini") {
  const host = `ds-${variant}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  return { id, host, origin: `http://${host}` };
}

describe("customer deep-scan API", () => {
  it("manual start, history, coverage, pages, findings with history, comparison and usage — all from persisted results", async () => {
    const u = await customer("dsApi");
    const s = await site(u.orgId);
    const base = `/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan`;
    const sum0 = await u.client.get(base);
    expect(sum0.status).toBe(200);
    expect(sum0.body.data).toMatchObject({ entitled: true, enabled: false, latestScan: null, measurement: "AUTOMATED_CHECKS" });
    expect(sum0.body.data.effectiveLimits).toMatchObject({ maxPages: 100, browserPages: 0, externalLinks: false });
    // the first cycle creates the schedule and runs the first (scheduled) scan; a manual start meanwhile is refused
    env.site.toggles.set(`${s.host}#slow`, "down"); // keep the first scan running while we try to start another
    await env.scheduler().runCycle();
    await until(async () => (await scansOf(env, s.id)).some((x) => x.status === "RUNNING"), 30_000, 200);
    const dup = await u.client.post(`${base}/start`, {});
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/already queued or running/);
    expect((await u.client.get(base)).body.data.enabled).toBe(true);
    env.site.toggles.delete(`${s.host}#slow`);
    await until(async () => (await scansOf(env, s.id)).every((x) => x.status !== "RUNNING"), 120_000, 300);
    await nextDeepWindow(env, s.id);
    await env.owner.query(`UPDATE monitoring_schedules SET next_run_at = now() + interval '1 day' WHERE website_id = $1 AND tier = 'T3_DEEP'`, [s.id]);
    const start = await u.client.post(`${base}/start`, {});
    expect(start.status, JSON.stringify(start.body)).toBe(202);
    const exec = start.body.data.executionId;
    expect((await u.client.post(`${base}/start`, {})).status).toBe(409); // already queued/running
    await until(async () => (await scansOf(env, s.id)).find((x) => x.execution_id === exec && x.status !== "RUNNING"), 120_000, 300);
    const scans = await u.client.get(`${base}/scans`);
    expect(scans.body.data[0]).toMatchObject({ executionId: exec, trigger: "MANUAL", status: "COMPLETED", complete: true });
    expect(scans.body.data[0].coverage.pagesChecked).toBeGreaterThanOrEqual(8);
    const detail = await u.client.get(`${base}/scans/${exec}`);
    expect(detail.body.data.discovery.robotsFound).toEqual({ [s.host]: false });
    const pages = await u.client.get(`${base}/scans/${exec}/pages?state=FAILED`);
    expect(pages.body.data.map((p: { url: string }) => p.url)).toEqual([`${s.origin}/missing`]);
    expect(pages.body.data[0]).toMatchObject({ status: 404, linkedFrom: `${s.origin}/broken-link` });
    const findings = await u.client.get(`${base}/findings?group=broken_pages`);
    expect(findings.body.data).toHaveLength(1);
    expect(findings.body.data[0]).toMatchObject({ category: "BROKEN_PAGE", severity: "HIGH", status: "OPEN", automated: true, detectionMethod: "HTTP" });
    expect(findings.body.data[0].impact).toMatch(/error page/);
    // fix the page; a scheduled scan resolves it; history and comparison show it
    env.site.toggles.set(s.host, "fixed");
    await scanNow(env, [s.id]);
    const f = await u.client.get(`${base}/findings/${findings.body.data[0].id}`);
    expect(f.body.data.status).toBe("RESOLVED");
    expect(f.body.data.history.map((x: { type: string }) => x.type)).toEqual(["OPENED", "RECURRED", "RESOLVED"]);
    const latest = (await u.client.get(`${base}/scans`)).body.data[0];
    const cmp = await u.client.get(`${base}/scans/${latest.executionId}`);
    expect(cmp.body.data.comparison).toMatchObject({ baselineExecutionId: exec, recoveredPages: { count: 1 } });
    // Phase 4F: compare any two scans; finding filters
    const cmp2 = await u.client.get(`${base}/scans/${latest.executionId}/compare?base=${exec}`);
    expect(cmp2.status).toBe(200);
    expect(cmp2.body.data).toMatchObject({ reliable: true, recoveredPages: { count: 1 }, newBrokenPages: { count: 0 }, removedPages: { count: 0 } });
    expect(cmp2.body.data.statusChanged.items[0]).toMatch(/\/missing \(404 → 200\)$/);
    expect((await u.client.get(`${base}/scans/${latest.executionId}/compare?base=${latest.executionId}`)).status).toBe(404);
    expect((await u.client.get(`${base}/scans/${latest.executionId}/compare?base=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    const byUrl = await u.client.get(`${base}/findings?status=ALL&url=MISSING`);
    expect(byUrl.body.data.map((x: { subject: string }) => x.subject)).toContain(`${s.origin}/missing`);
    expect((await u.client.get(`${base}/findings?status=ALL&category=BROKEN_PAGE`)).body.data.every((x: { category: string }) => x.category === "BROKEN_PAGE")).toBe(true);
    expect((await u.client.get(`${base}/findings?status=ALL&lastDetectedFrom=${new Date(Date.now() + 3_600_000).toISOString()}`)).body.data).toHaveLength(0);
    expect((await u.client.get(`${base}/findings?category=not-a-category`)).status).toBe(400);
    const usage = await u.client.get(`/api/v1/orgs/${u.orgId}/deep-scan/usage`);
    expect(usage.body.data).toMatchObject({ entitled: true, quota: { pagesPerDay: 100_000 } });
    expect(usage.body.data.usage.scans.today).toBe(3);
    expect(usage.body.data.quota.pagesUsedToday).toBe(usage.body.data.usage.pages.today);
  }, 300_000);

  it("configuration is validated; additional hosts must be separately verified websites of the same organisation", async () => {
    const u = await customer("dsCfg");
    const s = await site(u.orgId);
    const other = await customer("dsCfgOther");
    const foreign = await site(other.orgId);
    const mine = await site(u.orgId);
    const url = `/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/config`;
    for (const bad of [{ startPaths: ["https://evil/"] }, { sitemaps: ["http://other/s.xml"] }, { crawlAll: true }, { maxPages: 0 }, { incidentGroups: ["everything"] }]) {
      expect((await u.client.put(url, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await u.client.put(url, { additionalHosts: [foreign.host] })).status).toBe(400); // another org's verified host
    expect((await u.client.put(url, { additionalHosts: ["unverified.example"] })).status).toBe(400);
    const ok = await u.client.put(url, { additionalHosts: [mine.host], maxPages: 50, excludePatterns: ["/tmp/*"], severityOverrides: { MISSING_H1: "MEDIUM" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ additionalHosts: [mine.host], maxPages: 50, queryParamMode: "KEEP_MEANINGFUL", respectRobots: true });
    const sum = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan`);
    expect(sum.body.data.effectiveLimits.maxPages).toBe(50);
    const big = await u.client.put(url, { maxPages: 100_000 });
    expect(big.status).toBe(200);
    expect((await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan`)).body.data.effectiveLimits.maxPages).toBe(100); // never above the plan
  }, 120_000);

  it("pause stops scheduling and cancels a running scan (partial data kept); resume re-enables; cancel works for queued scans", async () => {
    const u = await customer("dsPause");
    const s = await site(u.orgId);
    env.site.toggles.set(`${s.host}#slow`, "down");
    await env.scheduler().runCycle();
    await until(async () => (await scansOf(env, s.id)).find((x) => x.status === "RUNNING" && x.pages_completed >= 1), 60_000, 200);
    const p = await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/pause`, { paused: true });
    expect(p.status).toBe(200);
    await until(async () => (await scansOf(env, s.id)).every((x) => x.status !== "RUNNING"), 30_000, 200);
    expect((await scansOf(env, s.id))[0]!.status).toBe("CANCELLED");
    await env.scheduler().runCycle();
    const sched = await env.owner.query(`SELECT status::text, paused_reason FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T3_DEEP'`, [s.id]);
    expect(sched.rows[0]).toEqual({ status: "PAUSED", paused_reason: "DISABLED_BY_CUSTOMER" });
    expect((await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/start`, {})).status).toBe(409); // not eligible while paused
    env.site.toggles.delete(`${s.host}#slow`);
    expect((await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/pause`, { paused: false })).status).toBe(200);
    await env.scheduler().runCycle();
    expect((await env.owner.query(`SELECT status::text FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T3_DEEP'`, [s.id])).rows[0].status).toBe("ACTIVE");
    // cancel a queued manual scan (worker stopped so it stays queued)
    await env.stopDeepWorkers();
    try {
      await nextDeepWindow(env, s.id);
      await env.owner.query(`UPDATE monitoring_schedules SET next_run_at = now() + interval '1 day' WHERE website_id = $1 AND tier = 'T3_DEEP'`, [s.id]);
      const st = await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/start`, {});
      expect(st.status).toBe(202);
      const c = await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/scans/${st.body.data.executionId}/cancel`, {});
      expect(c.body.data.status).toBe("CANCELLED");
      expect((await u.client.post(`/api/v1/orgs/${u.orgId}/websites/${s.id}/deep-scan/scans/${st.body.data.executionId}/cancel`, {})).status).toBe(409);
    } finally {
      await env.startDeepWorker();
      await env.startDeepWorker({ prefix: process.env.QUEUE_PREFIX });
    }
  }, 180_000);

  it("tenant isolation: another organisation sees nothing and can change nothing; customers can't write scan data", async () => {
    const a = await customer("dsIsoA");
    const s = await site(a.orgId);
    const [scan] = await scanNow(env, [s.id]);
    const finding = (await env.owner.query(`SELECT id FROM scan_findings WHERE website_id = $1 LIMIT 1`, [s.id])).rows[0];
    const b = await customer("dsIsoB");
    const paths = [`/websites/${s.id}/deep-scan`, `/websites/${s.id}/deep-scan/scans`, `/websites/${s.id}/deep-scan/scans/${scan!.execution_id}`,
      `/websites/${s.id}/deep-scan/scans/${scan!.execution_id}/pages`, `/websites/${s.id}/deep-scan/findings`, `/websites/${s.id}/deep-scan/findings/${finding.id}`];
    for (const p of paths) {
      expect((await b.client.get(`/api/v1/orgs/${b.orgId}${p}`)).status, p).toBe(404);
      expect((await b.client.get(`/api/v1/orgs/${a.orgId}${p}`)).status, p).toBe(404);
    }
    for (const [m, p, body] of [["post", "start", {}], ["post", "pause", { paused: true }], ["put", "config", { maxPages: 1 }], ["post", `scans/${scan!.execution_id}/cancel`, {}]] as const) {
      const r = await (b.client as any)[m](`/api/v1/orgs/${b.orgId}/websites/${s.id}/deep-scan/${p}`, body);
      expect(r.status, p).toBe(404);
    }
    const app = createDb({ url: process.env.DATABASE_URL!, max: 1, omitSecrets: true });
    for (const sql of [
      `UPDATE scan_findings SET status = 'RESOLVED'`, `INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}')`,
      `DELETE FROM deep_scan_urls`, `UPDATE usage_counters SET value = 0`, `INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'T3_DEEP', now(), 'PASSED', 1)`,
    ]) await expect(app.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    await app.$disconnect();
    // not entitled → no scans, start refused
    const c = await customer("dsNoEnt", false);
    const cs = await site(c.orgId);
    await env.scheduler().runCycle();
    expect((await c.client.post(`/api/v1/orgs/${c.orgId}/websites/${cs.id}/deep-scan/start`, {})).status).toBe(409);
  }, 240_000);

  it("admin: aggregate deep-scan health only — no domains, URLs, findings or organisation identifiers", async () => {
    const u = await customer("dsAdmin");
    const s = await site(u.orgId);
    await scanNow(env, [s.id]);
    const a = await createAdmin("ADMIN_SUPPORT");
    const c = Client.admin(h.app);
    expect((await c.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) })).status).toBe(200);
    const r = await c.get("/api/admin/v1/monitoring/health");
    expect(r.status).toBe(200);
    expect(r.body.data.deepScans.completed24h).toBeGreaterThanOrEqual(1);
    expect(r.body.data.deepScans.pages24h).toBeGreaterThan(0);
    const text = JSON.stringify(r.body);
    for (const needle of [s.host, u.orgId, s.id, "/missing", "Broken internal page"]) expect(text).not.toContain(needle);
    const admin = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    for (const t of ["deep_scans", "deep_scan_urls", "scan_findings"]) await expect(admin.$queryRawUnsafe(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    await admin.$disconnect();
  }, 180_000);
});
