import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Client, createAdmin, inviteAndAccept, totpCode, userWithOrg, verifiedUser } from "../helpers/harness.js";
import { startWebsiteHarness, uniqueDomain, verifiedWebsite, type WebsiteHarness } from "../helpers/websites.js";
import { executions, owner, resetMonitoringSettings, rig, setSettings, type Rig } from "../helpers/monitoring.js";

/**
 * Phase 4B customer and admin API surfaces: monitoring status, pause/resume, cancellation,
 * infrastructure health (aggregates only) and dead-letter replay authorisation.
 */
let h: WebsiteHarness;
let c: pg.Client;
let r: Rig;

async function adminClient(role: string) {
  const a = await createAdmin(role);
  const cl = Client.admin(h.app);
  const res = await cl.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) });
  expect(res.status).toBe(200);
  return cl;
}

beforeAll(async () => {
  h = await startWebsiteHarness();
  c = owner();
  await c.connect();
  r = rig();
  await setSettings(c, { "monitoring.http.enabled": true });
});
afterAll(async () => {
  await resetMonitoringSettings(c);
  await r.stopWorkers();
  await r.close();
  await c.end();
  await h.stopAll();
});

describe("customer monitoring API", () => {
  it("shows schedules and executions to the owning organisation only; viewers read but cannot pause", async () => {
    const o = await userWithOrg(h.app, "monOwner");
    const other = await userWithOrg(h.app, "monOther");
    const site = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("mon"));
    await r.scheduler().runCycle();
    const res = await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring`);
    expect(res.status).toBe(200);
    const http = res.body.data.schedules.find((x: { tier: string }) => x.tier === "HTTP");
    expect(http).toMatchObject({ status: "ACTIVE", intervalSec: 60, pausedReason: null });
    expect(res.body.data.schedules.find((x: { tier: string }) => x.tier === "BROWSER")).toMatchObject({ status: "PAUSED", pausedReason: "TIER_DISABLED" });
    expect(res.body.data.executions).toHaveLength(1);
    expect(Object.keys(res.body.data.executions[0]).sort()).toEqual(["attempt", "durationMs", "failureCategory", "finishedAt", "id", "startedAt", "status", "tier", "trigger", "windowStart"]);
    // Another tenant: not found (no existence oracle), both via its own org path and by guessing ids.
    expect((await other.client.get(`/api/v1/orgs/${other.orgId}/websites/${site.id}/monitoring`)).status).toBe(404);
    expect((await other.client.get(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring`)).status).toBe(404); // non-members: no existence oracle
    const exId = res.body.data.executions[0].id;
    expect((await other.client.post(`/api/v1/orgs/${other.orgId}/websites/${site.id}/executions/${exId}/cancel`, {})).status).toBe(404);
    const viewer = await verifiedUser(h.app, "monViewer");
    await inviteAndAccept(o.client, o.orgId, viewer, "VIEWER");
    expect((await viewer.client.get(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring`)).status).toBe(200);
    expect((await viewer.client.post(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring/pause`, { paused: true })).status).toBe(403);
  });

  it("pause cancels queued work immediately and stops scheduling; resume restarts it", async () => {
    const o = await userWithOrg(h.app, "monPause");
    const site = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("pause"));
    await r.scheduler().runCycle();
    expect((await executions(c, [o.orgId])).map((e) => e.status)).toEqual(["QUEUED"]);
    const paused = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring/pause`, { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.data.monitoringPaused).toBe(true);
    expect(paused.body.data.schedules.every((x: { status: string }) => x.status === "PAUSED")).toBe(true);
    expect((await executions(c, [o.orgId])).map((e) => e.status)).toEqual(["CANCELLED"]);
    // The already-queued Redis job is ignored by workers (eligibility is re-checked at start).
    const ran: string[] = [];
    const w = r.worker("HTTP", async (ctx) => { ran.push(ctx.websiteId); });
    await w.start();
    await new Promise((res) => setTimeout(res, 1500));
    expect(ran).not.toContain(site.id);
    await r.scheduler().runCycle();
    expect(await executions(c, [o.orgId])).toHaveLength(1);
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring/pause`, { paused: true })).status).toBe(409);
    const resumed = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${site.id}/monitoring/pause`, { paused: false });
    expect(resumed.status).toBe(200);
    await c.query(`UPDATE monitoring_executions SET queued_at = queued_at - interval '60 seconds', slot = slot - 60 WHERE org_id = $1`, [o.orgId]);
    await r.scheduler().runCycle();
    const ex = await executions(c, [o.orgId]);
    expect(ex).toHaveLength(2);
    const audit = await c.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND action LIKE 'website.monitoring_%' ORDER BY id`, [o.orgId]);
    expect(audit.rows.map((x) => x.action)).toEqual(["website.monitoring_paused", "website.monitoring_resumed"]);
    await r.stopWorkers();
  });

  it("cancels a queued execution and refuses to cancel finished ones", async () => {
    const o = await userWithOrg(h.app, "monCancel");
    const site = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("cancel"));
    await r.scheduler().runCycle();
    const [e] = await executions(c, [o.orgId]);
    const url = `/api/v1/orgs/${o.orgId}/websites/${site.id}/executions/${e!.id}/cancel`;
    const res = await o.client.post(url, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CANCELLED");
    expect((await o.client.post(url, {})).status).toBe(409);
  });
});

describe("admin monitoring API", () => {
  it("health is aggregate-only and contains no customer domains or identifiers", async () => {
    const o = await userWithOrg(h.app, "monHealth");
    const domain = uniqueDomain("health");
    await verifiedWebsite(h, o.client, o.orgId, domain);
    await r.scheduler("health-sched").runCycle();
    const support = await adminClient("ADMIN_SUPPORT");
    const res = await support.get("/api/admin/v1/monitoring/health");
    expect(res.status).toBe(200);
    expect(res.body.data.queues).toHaveProperty("http-monitoring");
    expect(res.body.data.queues).toHaveProperty("dead-letter");
    expect(res.body.data.scheduler.lastSuccessfulCycleAt).not.toBeNull();
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(domain);
    expect(text).not.toContain(o.orgId);
    const auditor = await adminClient("ADMIN_AUDITOR");
    expect((await auditor.get("/api/admin/v1/monitoring/health")).status).toBe(403);
  });

  it("replay requires admin:monitoring:replay, is audited, single-use, and never applies to security failures", async () => {
    const o = await userWithOrg(h.app, "monReplay");
    await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("replay"));
    await setSettings(c, { "queue.http-monitoring": { concurrency: 4, globalConcurrency: 10, ratePerSecond: 100, attempts: 1, backoffBaseMs: 100, backoffMaxMs: 1000, timeoutMs: 5000, keepCompletedHours: 1, keepFailedDays: 1 } });
    await r.scheduler().runCycle();
    const w = r.worker("HTTP", async (ctx) => { if (ctx.orgId === o.orgId) throw new Error("synthetic infrastructure failure"); });
    await w.start();
    const { rows } = await new Promise<pg.QueryResult<{ id: string }>>((resolve, reject) => {
      const end = Date.now() + 20_000;
      const poll = async () => {
        const q = await c.query<{ id: string }>(`SELECT id FROM job_failures WHERE org_id = $1`, [o.orgId]);
        if (q.rows.length) return resolve(q);
        if (Date.now() > end) return reject(new Error("no dead letter"));
        setTimeout(poll, 200);
      };
      void poll();
    });
    const failureId = rows[0]!.id;
    const support = await adminClient("ADMIN_SUPPORT");
    const list = await support.get("/api/admin/v1/monitoring/dead-letters");
    expect(list.status).toBe(200);
    expect(list.body.data.find((x: { id: string }) => x.id === failureId)).toMatchObject({ failureCategory: "TRANSIENT", replayable: true, jobType: "HTTP" });
    expect((await support.post(`/api/admin/v1/monitoring/dead-letters/${failureId}/replay`, { reason: "gateway fixed" })).status).toBe(403);
    const operator = await adminClient("ADMIN_OPERATOR");
    expect((await operator.post(`/api/admin/v1/monitoring/dead-letters/${failureId}/replay`, { reason: "x" })).status).toBe(400);
    expect((await operator.post(`/api/admin/v1/monitoring/dead-letters/${failureId}/replay`, { reason: "gateway fixed" })).status).toBe(202);
    expect((await operator.post(`/api/admin/v1/monitoring/dead-letters/${failureId}/replay`, { reason: "gateway fixed" })).status).toBe(409);
    const sec = await c.query<{ id: string }>(`INSERT INTO job_failures (queue, job_id, failure_category, attempts, error, payload) VALUES ('http-monitoring', 'forged', 'SECURITY', 1, 'malformed payload', '{}') RETURNING id`);
    expect((await operator.post(`/api/admin/v1/monitoring/dead-letters/${sec.rows[0]!.id}/replay`, { reason: "try anyway" })).status).toBe(409);
    const audit = await c.query(`SELECT action, reason FROM audit_logs WHERE target_id = $1`, [failureId]);
    expect(audit.rows).toEqual([{ action: "admin.dead_letter_replay_requested", reason: "gateway fixed" }]);
    await r.stopWorkers();
  });
});
