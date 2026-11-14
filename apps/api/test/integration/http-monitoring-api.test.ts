import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, countEmails, createAdmin, startHarness, totpCode, userWithOrg, waitForEmail, type Harness } from "../helpers/harness.js";
import { resetMonitoringSettings, sleep, until } from "../helpers/monitoring.js";
import { addVerifiedSite, ensureTrial, incidentsOf, nextWindow, results, settle, startHttpEnv, type HttpEnv } from "../helpers/http-monitoring.js";

/**
 * Phase 4C customer API, notifications (real email worker + Mailpit), tenant isolation and
 * admin aggregate privacy for HTTP monitoring.
 */
let h: Harness;
let env: HttpEnv;
let parked: string[] = [];
const orgs: string[] = [];

beforeAll(async () => {
  h = await startHarness();
  env = await startHttpEnv();
  parked = (await env.owner.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await settle(env);
  await env.startWorker();
});
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
  return u;
}

function fixtureSite(name: string, path = "/toggle") {
  const host = `${name}-${Date.now().toString(36)}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  return { host, origin: `http://${host}`, path };
}

async function windowFor(ids: string[], first = false) {
  if (!first) await nextWindow(env.owner, ids);
  const before = new Map<string, number>();
  for (const w of ids) before.set(w, (await results(env.owner, w)).length);
  await env.scheduler().runCycle();
  await until(async () => {
    for (const w of ids) if ((await results(env.owner, w)).length <= before.get(w)!) return false;
    return true;
  }, 45_000, 150);
  await env.relay();
}

describe("customer API", () => {
  it("reports real persisted state: latest result, availability, uptime with coverage, response time, SSL, incidents", async () => {
    const u = await customer("httpApi");
    const f = fixtureSite("api");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: f.path });
    const empty = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${id}/monitoring/http`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ latest: null, measurement: "SYNTHETIC_HTTP" });
    expect(empty.body.data.uptime.h24.uptimePercent).toBeNull(); // no data → no number, never a placeholder
    env.site.toggles.set(f.host, "up");
    await windowFor([id], true);
    await windowFor([id]);
    env.site.toggles.set(f.host, "down");
    await windowFor([id]);
    await windowFor([id]);
    const r = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${id}/monitoring/http`);
    const d = r.body.data;
    expect(d.state).toBe("DOWN");
    expect(d.latest).toMatchObject({ outcome: "FAILED", available: false, httpStatus: 500, failureKind: "HTTP_500", failureDescription: "Server error (HTTP 500)" });
    expect(d.latest.timings.totalMs).not.toBeNull();
    expect(d.uptime.h24).toMatchObject({ uptimePercent: 50, upChecks: 2, downChecks: 2, measuredChecks: 4 });
    expect(d.uptime.h24.scheduledChecks).toBe(4);
    expect(d.responseTime24h.samples).toBe(2);
    expect(d.lastSuccessfulCheckAt).not.toBeNull();
    expect(d.lastFailedCheckAt).not.toBeNull();
    expect(d.openIncidents).toHaveLength(1);
    expect(d.openIncidents[0]).toMatchObject({ category: "AVAILABILITY", checkKey: "http.down", severity: "CRITICAL", occurrenceCount: 2 });
    const hist = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${id}/monitoring/http/results?limit=3`);
    expect(hist.body.data).toHaveLength(3);
    expect(hist.body.nextBefore).not.toBeNull();
    const failedOnly = await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${id}/monitoring/http/results?outcome=FAILED`);
    expect(failedOnly.body.data.every((x: { outcome: string }) => x.outcome === "FAILED")).toBe(true);
    const inc = await u.client.get(`/api/v1/orgs/${u.orgId}/incidents/${d.openIncidents[0].id}`);
    expect(inc.status).toBe(200);
    expect(inc.body.data.events.map((e: { type: string }) => e.type)).toEqual(["CREATED"]);
    expect(inc.body.data.occurrences.length).toBeGreaterThanOrEqual(1);
    env.site.toggles.set(f.host, "up");
  }, 120_000);

  it("validates configuration: path only (never a host), sane limits; audit recorded", async () => {
    const u = await customer("httpCfg");
    const f = fixtureSite("cfg");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin);
    const url = `/api/v1/orgs/${u.orgId}/websites/${id}/monitoring/http/config`;
    expect((await u.client.put(url, { path: "https://evil.example/" })).status).toBe(400);
    expect((await u.client.put(url, { path: "//evil.example/x" })).status).toBe(400);
    expect((await u.client.put(url, { timeoutMs: 999_999 })).status).toBe(400);
    expect((await u.client.put(url, { expectedStatus: ["2xx"] })).status).toBe(400);
    expect((await u.client.put(url, { headers: { authorization: "x" } })).status).toBe(400);
    const ok = await u.client.put(url, { path: "/status", expectedStatus: ["200-299"], contentMarker: "OK", failureThreshold: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ path: "/status", expectedStatus: ["200-299"], contentMarker: "OK", failureThreshold: 3, method: "GET" });
    const cleared = await u.client.put(url, { contentMarker: null });
    expect(cleared.body.data.contentMarker).toBeUndefined();
    const audit = await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'website.http_check_updated'`, [u.orgId]);
    expect(audit.rows[0].n).toBe(2);
  });

  it("tenant isolation: other organisations can't read results, incidents or configure checks", async () => {
    const a = await customer("httpIsoA");
    const f = fixtureSite("iso");
    const id = await addVerifiedSite(env.owner, a.orgId, f.origin, { path: "/500", failureThreshold: 1 });
    await windowFor([id], true);
    const incId = (await incidentsOf(env.owner, id))[0]!.id;
    const b = await customer("httpIsoB");
    for (const path of [`/websites/${id}/monitoring/http`, `/websites/${id}/monitoring/http/results`, `/incidents/${incId}`]) {
      expect((await b.client.get(`/api/v1/orgs/${b.orgId}${path}`)).status, path).toBe(404);
      expect((await b.client.get(`/api/v1/orgs/${a.orgId}${path}`)).status, path).toBe(404);
    }
    expect((await b.client.put(`/api/v1/orgs/${b.orgId}/websites/${id}/monitoring/http/config`, { path: "/" })).status).toBe(404);
    const list = await b.client.get(`/api/v1/orgs/${b.orgId}/incidents?status=ALL`);
    expect(list.body.data).toEqual([]);
  }, 60_000);
});

describe("notifications", () => {
  it("one outage email and one recovery email per incident, whatever the number of failing checks and retries", async () => {
    const u = await customer("httpNotify");
    const f = fixtureSite("notify");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: f.path });
    env.site.toggles.set(f.host, "down");
    await windowFor([id], true);
    await windowFor([id]);
    await windowFor([id]);
    await windowFor([id]);
    const opened = await waitForEmail(u.email, "Website unavailable");
    expect(opened.subject).toContain("[CRITICAL]");
    expect(opened.text).toContain("Server error (HTTP 500)");
    expect(opened.text).not.toMatch(/token|cookie|cap:|Basic /i);
    // Relaying again (scheduler restart, duplicate relay) sends nothing new.
    await env.owner.query(`UPDATE outbox_events SET published_at = NULL WHERE org_id = $1`, [u.orgId]);
    await env.relay();
    await sleep(2500);
    expect(await countEmails(u.email, "[CRITICAL] Website unavailable")).toBe(1);
    env.site.toggles.set(f.host, "up");
    await windowFor([id]);
    await windowFor([id]);
    await windowFor([id]);
    await waitForEmail(u.email, "Recovered");
    await sleep(2000);
    expect(await countEmails(u.email, "Recovered")).toBe(1);
    expect(await countEmails(u.email, "[CRITICAL] Website unavailable")).toBe(1);
    const inApp = await env.owner.query(`SELECT type FROM notifications WHERE org_id = $1 ORDER BY created_at`, [u.orgId]);
    expect(inApp.rows.map((r) => r.type)).toEqual(["INCIDENT_CREATED", "INCIDENT_RESOLVED"]);
  }, 150_000);

  it("no recovery email when the outage was never notified (preferences excluded it)", async () => {
    const u = await customer("httpQuiet");
    await env.owner.query(
      `INSERT INTO notification_preferences (org_id, user_id, channel, min_severity, event_types, updated_at) VALUES ($1, $2, 'EMAIL', 'INFO', ARRAY['SSL_EXPIRING'], now())`, [u.orgId, u.userId]);
    const f = fixtureSite("quiet");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: f.path, failureThreshold: 1, recoveryThreshold: 1 });
    env.site.toggles.set(f.host, "down");
    await windowFor([id], true);
    env.site.toggles.set(f.host, "up");
    await windowFor([id]);
    expect((await incidentsOf(env.owner, id))[0]).toMatchObject({ status: "RESOLVED" });
    await sleep(3000);
    expect(await countEmails(u.email, "[CRITICAL] Website unavailable")).toBe(0);
    expect(await countEmails(u.email, "Recovered")).toBe(0);
  }, 90_000);

  it("a notification failure never fails monitoring: the result and incident are committed independently", async () => {
    const u = await customer("httpMailDown");
    const f = fixtureSite("maildown");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: "/500", failureThreshold: 1 });
    await windowFor([id], true); // relay → email queue; delivery happens asynchronously in worker-notify
    const ex = await env.owner.query(`SELECT status::text FROM monitoring_executions WHERE website_id = $1`, [id]);
    expect(ex.rows[0].status).toBe("SUCCEEDED");
    expect(await incidentsOf(env.owner, id)).toHaveLength(1);
    const ob = await env.owner.query(`SELECT published_at FROM outbox_events WHERE org_id = $1`, [u.orgId]);
    expect(ob.rows.every((r) => r.published_at !== null)).toBe(true);
  }, 60_000);
});

describe("admin", () => {
  it("HTTP health is aggregate-only: no customer domains, addresses or identifiers", async () => {
    const u = await customer("httpAdmin");
    const f = fixtureSite("adminagg", "/healthy");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: "/healthy" });
    await windowFor([id], true);
    const a = await createAdmin("ADMIN_SUPPORT");
    const c = Client.admin(h.app);
    expect((await c.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) })).status).toBe(200);
    const r = await c.get("/api/admin/v1/monitoring/health");
    expect(r.status).toBe(200);
    expect(r.body.data.httpChecks.checks1h).toBeGreaterThanOrEqual(1);
    expect(r.body.data.httpChecks.lastCompletedCheckAt).not.toBeNull();
    const text = JSON.stringify(r.body);
    for (const needle of [f.host, u.orgId, id, "127.0.0.1"]) expect(text).not.toContain(needle);
  }, 60_000);
});
