import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, countEmails, createAdmin, startHarness, totpCode, userWithOrg, waitForEmail, type Harness } from "../helpers/harness.js";
import { Redis } from "ioredis";
import { resetMonitoringSettings, setSettings as setSettingsDb, until } from "../helpers/monitoring.js";

/** Direct settings write + the change notification the admin API publishes (the API caches settings otherwise). */
async function setSettings(c: Parameters<typeof setSettingsDb>[0], values: Record<string, unknown>) {
  await setSettingsDb(c, values);
  const r = new Redis(process.env.REDIS_URL!);
  await r.publish("wim:config:changed", JSON.stringify({ keys: Object.keys(values), at: Date.now() }));
  r.disconnect();
  await new Promise((res) => setTimeout(res, 200));
}
import { addVerifiedSite, ensureTrial } from "../helpers/http-monitoring.js";
import { browserSettings, entitleBrowser, ledger, startBrowserEnv, type BrowserEnv } from "../helpers/browser-monitoring.js";

/**
 * Phase 4D API surface: browser results (tenant-scoped), configuration, screenshot access through
 * short-lived signed links, notifications, and aggregate-only admin metrics.
 */
let h: Harness;
let env: BrowserEnv;
let parked: string[] = [];
const orgs: string[] = [];

beforeAll(async () => {
  process.env.S3_BUCKET_ARTIFACTS = "wim-artifacts-test"; // the API streams from the same bucket the test worker writes
  h = await startHarness();
  env = await startBrowserEnv();
  parked = (await env.owner.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await resetMonitoringSettings(env.owner);
  await browserSettings(env);
  await env.startBrowserWorker();
}, 120_000);
afterAll(async () => {
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await env.owner.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(env.owner);
  await env.close();
  await h.stop();
});

async function customer(tag: string) {
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  const u = await userWithOrg(h.app, tag);
  orgs.push(u.orgId);
  await ensureTrial(env.owner, u.orgId);
  await entitleBrowser(env, u.orgId);
  return u;
}

async function browserSite(orgId: string, name: string, path: string, extra: Record<string, unknown> = {}) {
  const host = `${name}-${Date.now().toString(36)}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  await env.owner.query(`INSERT INTO monitoring_configurations (org_id, website_id, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, now())`,
    [orgId, id, JSON.stringify({ path, extraViewportsPerRun: 0, ...extra })]);
  return { id, host };
}

async function run(ids: string[], first = true) {
  if (!first) {
    for (const w of ids) {
      const { rows } = await env.owner.query<{ id: string; min: Date }>(`SELECT id, (SELECT min(queued_at) FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER') AS min FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' ORDER BY queued_at DESC LIMIT 1`, [w]);
      const t = new Date(rows[0]!.min.getTime() - 900_000);
      await env.owner.query(`UPDATE monitoring_executions SET queued_at = $2, slot = floor(extract(epoch FROM $2::timestamptz)) WHERE id = $1`, [rows[0]!.id, t]);
      for (const tb of ["page_test_results", "responsive_test_results"]) await env.owner.query(`UPDATE ${tb} SET tested_at = $2 WHERE execution_id = $1`, [rows[0]!.id, t]);
      await env.owner.query(`UPDATE performance_metrics SET measured_at = $2 WHERE execution_id = $1`, [rows[0]!.id, t]);
      await env.owner.query(`UPDATE execution_results SET window_start = $2 WHERE execution_id = $1`, [rows[0]!.id, t]);
      await env.owner.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second', state_window_at = LEAST(state_window_at, $2) WHERE website_id = $1 AND tier = 'T2_RENDER'`, [w, t]);
    }
  }
  const before = new Map<string, number>();
  for (const w of ids) before.set(w, (await ledger(env, w)).length);
  await env.scheduler().runCycle();
  await until(async () => {
    for (const w of ids) if ((await ledger(env, w)).length <= before.get(w)!) return false;
    return true;
  }, 90_000, 200);
  await env.relay();
}

describe("customer browser API", () => {
  it("summary and history are real persisted results, labelled synthetic; config is validated and audited", async () => {
    const u = await customer("brApi");
    const s = await browserSite(u.orgId, "brapi", "/b/js-exception");
    const empty = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${s.id}/monitoring/browser`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ latest: null, measurement: "SYNTHETIC_BROWSER" });
    await run([s.id]);
    const r = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${s.id}/monitoring/browser`);
    const d = r.body.data;
    expect(d.state).toBe("DEGRADED");
    expect(d.latest.outcome).toBe("FAILED");
    const vp = d.latest.viewports[0];
    expect(vp).toMatchObject({ viewport: "desktop", width: 1366, outcome: "FAILED", failureKind: "UNCAUGHT_EXCEPTION", failureDescription: "Uncaught JavaScript exception during page load" });
    expect(vp.scripts.exceptions[0].message).toMatch(/undefinedFunctionCall/);
    expect(vp.syntheticPerformance.fcpMs).toBeGreaterThan(0);
    expect(vp.syntheticPerformance).not.toHaveProperty("inpMs");
    expect(vp.artifacts).toHaveLength(1);
    expect(vp.overlay).toMatchObject({ found: false, items: [] }); // popups: none on this page
    expect(vp.dialogs).toBeNull();
    const hist = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${s.id}/monitoring/browser/results?limit=5`);
    expect(hist.body.data).toHaveLength(1);
    const url = `/api/v1/orgs/${u.orgId}/websites/${s.id}/monitoring/browser/config`;
    expect((await u.client.put(url, { path: "https://evil.example/" })).status).toBe(400);
    expect((await u.client.put(url, { viewports: ["watch"] })).status).toBe(400);
    expect((await u.client.put(url, { navigationTimeoutMs: 600_000 })).status).toBe(400);
    expect((await u.client.put(url, { proxy: "http://x" })).status).toBe(400);
    // first save on a website without stored settings, with the null the dashboard form sends (regression found in 4G)
    expect((await u.client.put(url, { readiness: { strategy: "load", selector: null } })).status).toBe(200);
    const ok = await u.client.put(url, { readiness: { strategy: "selector", selector: "#app" }, viewports: ["desktop", "mobile-small"], screenshots: { onSuccess: true, mask: [".price"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ readiness: { strategy: "selector", selector: "#app", quietMs: 500 }, viewports: ["desktop", "mobile-small"], screenshots: { onSuccess: true, onFailure: true, mask: [".price"] } });
    expect(ok.body.data.popups).toEqual({ dismiss: true, closeSelector: null }); // defaults for configurations saved before popups existed
    // popups: the close selector is a plausible CSS selector only (evaluated with document.querySelector in the page)
    for (const bad of ["javascript:alert(1)", "<img src=x onerror=alert(1)>", ".a > .b", "a{}", "x".repeat(201)]) {
      const r = await u.client.put(url, { popups: { closeSelector: bad } });
      expect(r.status, bad).toBe(400);
    }
    expect((await u.client.put(url, { popups: { dismiss: "yes" } })).status).toBe(400);
    const pop = await u.client.put(url, { popups: { dismiss: false, closeSelector: "#newsletter .close" } });
    expect(pop.status).toBe(200);
    expect(pop.body.data.popups).toEqual({ dismiss: false, closeSelector: "#newsletter .close" });
    const cleared = await u.client.put(url, { popups: { dismiss: true, closeSelector: null } });
    expect(cleared.body.data.popups).toEqual({ dismiss: true, closeSelector: null });
    const audit = await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'website.browser_check_updated'`, [u.orgId]);
    expect(audit.rows[0].n).toBe(4); // the accepted saves; rejected ones are not audited
  }, 120_000);

  it("screenshots: short-lived signed links, PNG streamed from private storage; tampered, expired and cross-tenant access refused", async () => {
    const a = await customer("brShotA");
    const s = await browserSite(a.orgId, "brshot", "/b/blank");
    await run([s.id]);
    const art = (await a.client.get(`/api/v1/orgs/${a.orgId}/websites/${s.id}/monitoring/browser`)).body.data.latest.viewports[0].artifacts[0];
    const link = await a.client.get(`/api/v1/orgs/${a.orgId}/artifacts/${art.id}/link`);
    expect(link.status).toBe(200);
    const exp = new Date(link.body.data.expiresAt).getTime();
    expect(exp - Date.now()).toBeLessThanOrEqual(300_000);
    const linkUrl = new URL(link.body.data.url);
    const path = `${linkUrl.pathname}${linkUrl.search}`;
    const anon = Client.customer(h.app);
    const dl = await h.app.inject({ method: "GET", url: path });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("image/png");
    expect(dl.headers["cache-control"]).toBe("private, no-store");
    expect(dl.headers["content-security-policy"]).toContain("sandbox");
    expect(dl.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    // tampered token: switch artifact id inside the signed payload
    const [payload, sig] = linkUrl.searchParams.get("token")!.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, x: claims.x + 3600 })).toString("base64url");
    expect((await h.app.inject({ method: "GET", url: `/api/v1/artifact-downloads?token=${forged}.${sig}` })).statusCode).toBe(404);
    // expired (a correctly signed but old link is refused)
    const { createHmac } = await import("node:crypto");
    const keys = h.app.get((await import("../../src/crypto/keys.service.js")).KeysService);
    const oldPayload = Buffer.from(JSON.stringify({ ...claims, x: Math.floor(Date.now() / 1000) - 5 })).toString("base64url");
    const oldSig = createHmac("sha256", keys.hmacKey("artifact-download-links")).update(oldPayload).digest("base64url");
    expect((await h.app.inject({ method: "GET", url: `/api/v1/artifact-downloads?token=${oldPayload}.${oldSig}` })).statusCode).toBe(410);
    // a correctly signed link naming another organisation finds nothing under that organisation's RLS context
    const b = await customer("brShotB");
    const crossPayload = Buffer.from(JSON.stringify({ ...claims, o: b.orgId })).toString("base64url");
    const crossSig = createHmac("sha256", keys.hmacKey("artifact-download-links")).update(crossPayload).digest("base64url");
    expect((await h.app.inject({ method: "GET", url: `/api/v1/artifact-downloads?token=${crossPayload}.${crossSig}` })).statusCode).toBe(404);
    // another tenant can't mint a link, read results or configure
    expect((await b.client.get(`/api/v1/orgs/${b.orgId}/artifacts/${art.id}/link`)).status).toBe(404);
    expect((await b.client.get(`/api/v1/orgs/${a.orgId}/artifacts/${art.id}/link`)).status).toBe(404);
    expect((await b.client.get(`/api/v1/orgs/${b.orgId}/websites/${s.id}/monitoring/browser`)).status).toBe(404);
    expect((await b.client.put(`/api/v1/orgs/${b.orgId}/websites/${s.id}/monitoring/browser/config`, { path: "/" })).status).toBe(404);
    void anon;
  }, 120_000);

  it("Phase 4F: execution detail, history filters (date, result, viewport, problem), expired screenshots are 410 not 404", async () => {
    const u = await customer("brDetail");
    const s = await browserSite(u.orgId, "brdet", "/b/blank");
    await run([s.id]);
    const base = `/api/v1/orgs/${u.orgId}/websites/${s.id}/monitoring/browser`;
    const latest = (await u.client.get(base)).body.data.latest;
    const d = await u.client.get(`${base}/results/${latest.executionId}`);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ executionId: latest.executionId, outcome: "FAILED" });
    expect(d.body.data.viewports[0]).toMatchObject({ viewport: "desktop", failureKind: "BLANK_PAGE" });
    expect(d.body.data.viewports[0].rendering).toBeTruthy();
    expect((await u.client.get(`${base}/results/${randomUUID()}`)).status).toBe(404);
    const q = async (qs: string) => (await u.client.get(`${base}/results?${qs}`)).body.data.length;
    expect(await q("outcome=FAILED")).toBe(1);
    expect(await q("outcome=PASSED")).toBe(0);
    expect(await q("viewport=desktop")).toBe(1);
    expect(await q("viewport=tablet")).toBe(0);
    expect(await q("problem=RENDERING")).toBe(1);
    expect(await q("problem=JAVASCRIPT")).toBe(0);
    expect(await q(`from=${new Date(Date.now() + 3_600_000).toISOString()}`)).toBe(0);
    expect((await u.client.get(`${base}/results?problem=EVERYTHING`)).status).toBe(400);
    expect((await u.client.get(`${base}/results?limit=500`)).status).toBe(400);
    // a screenshot past retention: explicit 410 for its own organisation, still 404 for anyone else
    const art = d.body.data.viewports[0].artifacts[0];
    await env.owner.query(`UPDATE artifacts SET expires_at = now() - interval '1 minute' WHERE id = $1`, [art.id]);
    const gone = await u.client.get(`/api/v1/orgs/${u.orgId}/artifacts/${art.id}/link`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe("ARTIFACT_EXPIRED");
    const other = await customer("brDetailOther");
    expect((await other.client.get(`/api/v1/orgs/${other.orgId}/artifacts/${art.id}/link`)).status).toBe(404);
    expect((await other.client.get(`/api/v1/orgs/${other.orgId}/websites/${s.id}/monitoring/browser/results/${latest.executionId}`)).status).toBe(404);
  }, 180_000);

  it("Phase 4F: components, component history, functional and responsive results through the API; tenant-isolated", async () => {
    const u = await customer("cmpApi");
    // Phase 4H: interactions need the platform switch and a recorded risk acknowledgement (fixture: as the API records it)
    await setSettings(env.owner, { "monitoring.functional.enabled": true });
    const s = await browserSite(u.orgId, "cmpapi", "/c/shop", { functional: { enabled: true, maxNavigationLinks: 1, maxButtons: 2, allowedPaths: ["/c"], riskAcknowledgement: { version: 1, at: new Date().toISOString(), by: u.userId } } });
    await new Promise((res) => setTimeout(res, 10_500)); // engine settings cache
    await run([s.id]);
    const base = `/api/v1/orgs/${u.orgId}/websites/${s.id}`;
    const comps = await u.client.get(`${base}/components`);
    expect(comps.status).toBe(200);
    expect(comps.body.data.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(["NAV", "SEARCH", "FORM", "BUTTON"]));
    expect(comps.body.data[0]).toMatchObject({ status: "PRESENT", pagePath: "/c/shop" });
    expect((await u.client.get(`${base}/components?type=SEARCH`)).body.data).toHaveLength(1);
    expect((await u.client.get(`${base}/components?status=REMOVED`)).body.data).toEqual([]);
    expect((await u.client.get(`${base}/components/history`)).body).toMatchObject({ data: [], nextCursor: null });
    const latest = (await u.client.get(`${base}/monitoring/browser`)).body.data.latest;
    const detail = (await u.client.get(`${base}/monitoring/browser/results/${latest.executionId}`)).body.data;
    expect(detail.functional.find((f: { kind: string }) => f.kind === "SEARCH")).toMatchObject({ outcome: "PASSED", safety: "SAFE" });
    expect(detail.functional.some((f: { outcome: string; safety: string }) => f.outcome === "SKIPPED" && f.safety === "UNSAFE")).toBe(true);
    expect(detail.responsive[0]).toMatchObject({ viewport: "desktop", status: "PASSED", navState: "VISIBLE" });
    expect(env.site.toggles.get(`${s.host}#danger-hit`)).toBeUndefined();
    expect((await u.client.get(`${base}/components?type=<x>`)).status).toBe(400);
    // functional tests are opt-in and validated server-side
    expect((await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: true, searchQuery: "<script>" } })).status).toBe(400);
    // Phase 4H: the acknowledgement cannot be forged through the API; turning off withdraws it; turning on again needs a new one
    expect((await u.client.put(`${base}/monitoring/browser/config`, { functional: { riskAcknowledgement: { version: 1, at: new Date().toISOString(), by: u.userId } } })).status).toBe(400);
    const off = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: false } });
    expect(off.body.data.functional.riskAcknowledgement).toBeNull();
    const noAck = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: true } });
    expect(noAck.status).toBe(400);
    expect(noAck.body.error.code).toBe("RISK_ACKNOWLEDGEMENT_REQUIRED");
    expect(noAck.body.error.message).toMatch(/GET request/);
    // release readiness (blocker 9): explicit safe destinations are mandatory
    const noPaths = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: true, allowedPaths: [] }, acknowledgeFunctionalRisk: true });
    expect(noPaths.status).toBe(400);
    expect(JSON.stringify(noPaths.body)).toMatch(/functional\.allowedPaths/);
    const acked = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: true, allowedPaths: ["/c/products"] }, acknowledgeFunctionalRisk: true });
    expect(acked.status).toBe(200);
    expect(acked.body.data.functional).toMatchObject({ enabled: true, allowedPaths: ["/c/products"], riskAcknowledgement: { version: 1, by: u.userId } });
    const audit = (await env.owner.query(`SELECT changes FROM audit_logs WHERE action = 'website.browser_check_updated' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [s.id])).rows[0];
    expect(audit.changes).toMatchObject({ functionalRiskAcknowledged: 1, functionalEnabled: true });
    // platform switch off: enabling is refused (an already-enabled website keeps its setting, but nothing runs)
    await setSettings(env.owner, { "monitoring.functional.enabled": false });
    await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: false } });
    const refused = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: true }, acknowledgeFunctionalRisk: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect((await u.client.put(`${base}/monitoring/browser/config`, { functional: { budgetMs: 999_999 } })).status).toBe(400);
    const ok = await u.client.put(`${base}/monitoring/browser/config`, { functional: { enabled: false } });
    expect(ok.body.data.functional).toMatchObject({ enabled: false, search: true });
    // another tenant: nothing
    const b = await customer("cmpApiB");
    for (const p of ["/components", "/components/history", `/monitoring/browser/results/${latest.executionId}`]) {
      expect((await b.client.get(`/api/v1/orgs/${b.orgId}/websites/${s.id}${p}`)).status, p).toBe(404);
      expect((await b.client.get(`${base}${p}`)).status, p).toBe(404);
    }
  }, 180_000);

  it("browser incident: one email when it opens, one when it recovers", async () => {
    const u = await customer("brNotify");
    const s = await browserSite(u.orgId, "brnotify", "/b/toggle");
    env.site.toggles.set(s.host, "down");
    await run([s.id]);
    await run([s.id], false);
    await run([s.id], false);
    await waitForEmail(u.email, "Page renders blank");
    env.site.toggles.set(s.host, "up");
    await run([s.id], false);
    await run([s.id], false);
    await waitForEmail(u.email, "Recovered: Page renders blank");
    expect(await countEmails(u.email, "[HIGH] Page renders blank")).toBe(1);
    expect(await countEmails(u.email, "Recovered: Page renders blank")).toBe(1);
  }, 180_000);
});

describe("admin", () => {
  it("browser health is aggregate-only: no domains, organisations, URLs or screenshots", async () => {
    const u = await customer("brAdmin");
    const s = await browserSite(u.orgId, "bradmin", "/b/blank");
    await run([s.id]);
    const a = await createAdmin("ADMIN_SUPPORT");
    const c = Client.admin(h.app);
    expect((await c.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) })).status).toBe(200);
    const r = await c.get("/api/admin/v1/monitoring/health");
    expect(r.status).toBe(200);
    expect(r.body.data.browserChecks.executions1h).toBeGreaterThanOrEqual(1);
    expect(r.body.data.browserChecks.screenshotBytes24h).toBeGreaterThan(0);
    const text = JSON.stringify(r.body);
    for (const needle of [s.host, u.orgId, s.id, "orgs/", ".png"]) expect(text).not.toContain(needle);
    // the admin role can't read artifacts or browser results directly
    const { createDb } = await import("@wim/db");
    const adminDb = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    await expect(adminDb.$queryRaw`SELECT * FROM artifacts LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(adminDb.$queryRaw`SELECT * FROM page_test_results LIMIT 1`).rejects.toThrow(/permission denied/);
    await adminDb.$disconnect();
  }, 120_000);
});
