import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createAdmin, startHarness, totpCode, userWithOrg, inviteAndAccept, verifiedUser, type Harness } from "../helpers/harness.js";
import { resetMonitoringSettings, sleep, until } from "../helpers/monitoring.js";
import { addVerifiedSite, ensureTrial, nextWindow, results, settle, startHttpEnv, type HttpEnv } from "../helpers/http-monitoring.js";

/**
 * Phase 4F customer dashboard API against real Postgres, Redis, the egress gateway, the real HTTP engine, the
 * real email/notification worker and the fault website: overview, analytics, incidents (filters, cursor,
 * acknowledgement), history, schedule, usage, notifications, change feed, admin aggregates, tenant isolation.
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
  const u = await userWithOrg(h.app, tag);
  orgs.push(u.orgId);
  await ensureTrial(env.owner, u.orgId);
  return u;
}
function fixtureSite(name: string) {
  const host = `${name}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  return { host, origin: `http://${host}` };
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
/** A website with 2 passing then 2 failing real checks → an open "website down" incident. */
async function outage(u: { orgId: string }, name: string) {
  const f = fixtureSite(name);
  const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: "/toggle" });
  env.site.toggles.set(f.host, "up");
  await windowFor([id], true);
  await windowFor([id]);
  env.site.toggles.set(f.host, "down");
  await windowFor([id]);
  await windowFor([id]);
  return { id, ...f };
}
const api = (o: string) => `/api/v1/orgs/${o}`;

describe("overview and analytics (real persisted data)", () => {
  it("empty organisation: no fabricated numbers, onboarding state", async () => {
    const u = await customer("dashEmpty");
    const r = await u.client.get(`${api(u.orgId)}/monitoring/overview`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ websites: [], timezone: "UTC", totals: { websites: 0, monitored: 0, activeIncidents: 0, httpChecks: { passed: 0, failed: 0, successRatePercent: null } } });
    expect(r.body.data.entitlements.HTTP.available).toBe(true);
    expect(r.body.data.entitlements.BROWSER).toMatchObject({ available: false, reason: expect.any(String) });
  });

  it("overview, analytics and the HTTP summary agree; outage is DOWN; uptime and coverage are the backend's", async () => {
    const u = await customer("dashOverview");
    const s = await outage(u, "dash");
    const unverified = await addVerifiedSite(env.owner, u.orgId, fixtureSite("unv").origin);
    await env.owner.query(`UPDATE domain_claims SET status = 'PENDING', verified_at = NULL, pending_expires_at = now() + interval '7 days' WHERE id = (SELECT domain_claim_id FROM websites WHERE id = $1)`, [unverified]);
    const o = (await u.client.get(`${api(u.orgId)}/monitoring/overview`)).body.data;
    const w = o.websites.find((x: { id: string }) => x.id === s.id);
    expect(w).toMatchObject({ health: "DOWN", activeIncidents: 1, http: { state: "DOWN", lastOutcome: "FAILED" } });
    expect(w.reasons).toContain("Website is down (HTTP)");
    expect(w.http.uptime).toMatchObject({ uptimePercent: 50, upChecks: 2, downChecks: 2, scheduledChecks: 4, coveragePercent: 100 });
    expect(o.websites.find((x: { id: string }) => x.id === unverified).health).toBe("NOT_VERIFIED");
    expect(o.totals).toMatchObject({ websites: 2, activeIncidents: 1, httpChecks: { passed: 2, failed: 2, successRatePercent: 50 } });
    const a = (await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http/analytics`)).body.data;
    const sum = (await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http`)).body.data;
    expect(a.uptime).toEqual(sum.uptime.h24); // one authoritative calculation
    expect(a.checks).toMatchObject({ total: 4, passed: 2, failed: 2, inconclusive: 0, scheduled: 4, skippedOrMissing: 0 });
    expect(a.bucketSec).toBe(3600);
    expect(a.series.length).toBeGreaterThanOrEqual(24);
    expect(a.series.reduce((x: number, b: { up: number; down: number }) => x + b.up + b.down, 0)).toBe(4);
    expect(a.statusDistribution).toEqual(expect.arrayContaining([{ status: "2xx", count: 2 }, { status: "5xx", count: 2 }]));
    expect(a.incidents).toHaveLength(1);
    expect(a.downtimeSec).toBeGreaterThanOrEqual(0);
    expect(a.responseMs.avg).not.toBeNull();
    // range validation
    expect((await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http/analytics?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`)).status).toBe(400);
    expect((await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http/analytics?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
    const week = (await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http/analytics?from=${new Date(Date.now() - 7 * 86_400_000).toISOString()}`)).body.data;
    expect(week.bucketSec).toBe(21_600);
    // HTTP results range filter
    const fromNow = await u.client.get(`${api(u.orgId)}/websites/${s.id}/monitoring/http/results?from=${new Date(Date.now() + 3_600_000).toISOString()}`);
    expect(fromNow.body.data).toHaveLength(0);
  }, 240_000);

  it("thin data never shows as healthy; infrastructure failures are not outages", async () => {
    const u = await customer("dashCoverage");
    const f = fixtureSite("cov");
    const id = await addVerifiedSite(env.owner, u.orgId, f.origin, { path: "/toggle" });
    env.site.toggles.set(f.host, "up");
    await windowFor([id], true);
    // Many scheduled executions that produced no result (e.g. worker outage): coverage drops below 80 %.
    const { rows: [sch] } = await env.owner.query(`SELECT id FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [id]);
    for (let i = 1; i <= 5; i++) {
      await env.owner.query(`INSERT INTO monitoring_executions (org_id, website_id, schedule_id, tier, trigger, status, queued_at, slot) VALUES ($1, $2, $3, 'T1_HTTP', 'SCHEDULE', 'DEAD_LETTERED', now() - make_interval(mins => $4 * 10), $4)`, [u.orgId, id, sch.id, i]);
    }
    const w = (await u.client.get(`${api(u.orgId)}/monitoring/overview`)).body.data.websites[0];
    expect(w.http.uptime.uptimePercent).toBe(100);
    expect(w.http.uptime.coveragePercent).toBeLessThan(80);
    expect(w.health).toBe("INCONCLUSIVE"); // 100 % uptime on 1 of 6 checks is not "healthy"
    expect(w.reasons.join(" ")).toMatch(/Insufficient monitoring coverage/);
  }, 120_000);
});

describe("incidents: filters, cursor, acknowledgement, recovery", () => {
  it("acknowledge: authorised, audited, idempotent, never resolves; the engine still recovers it", async () => {
    const u = await customer("dashAck");
    const s = await outage(u, "ack");
    const list = await u.client.get(`${api(u.orgId)}/incidents?status=OPEN&source=HTTP`);
    expect(list.body.data).toHaveLength(1);
    const inc = list.body.data[0];
    expect(inc).toMatchObject({ source: "HTTP", websiteName: expect.any(String), acknowledgedAt: null });
    // a viewer can't acknowledge
    const viewer = await verifiedUser(h.app, "dashViewer");
    await inviteAndAccept(u.client, u.orgId, viewer, "VIEWER");
    expect((await viewer.client.post(`${api(u.orgId)}/incidents/${inc.id}/acknowledge`)).status).toBe(403);
    const a1 = await u.client.post(`${api(u.orgId)}/incidents/${inc.id}/acknowledge`);
    expect(a1.status).toBe(200);
    expect(a1.body.data).toMatchObject({ status: "ACKNOWLEDGED", changed: true });
    const a2 = await u.client.post(`${api(u.orgId)}/incidents/${inc.id}/acknowledge`); // retried request
    expect(a2.body.data).toMatchObject({ status: "ACKNOWLEDGED", changed: false });
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM incident_events WHERE incident_id = $1 AND type = 'ACKNOWLEDGED'`, [inc.id])).rows[0].n).toBe(1);
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'incident.acknowledged'`, [u.orgId])).rows[0].n).toBe(1);
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1 AND topic = 'incident.opened'`, [u.orgId])).rows[0].n).toBe(1); // no extra notification
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=ACKNOWLEDGED`)).body.data.map((x: { id: string }) => x.id)).toEqual([inc.id]);
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=ACTIVE`)).body.data).toHaveLength(1); // still active
    // still failing → occurrences keep counting on the acknowledged incident
    await windowFor([s.id]);
    const d1 = (await u.client.get(`${api(u.orgId)}/incidents/${inc.id}`)).body.data;
    expect(d1).toMatchObject({ status: "ACKNOWLEDGED" });
    expect(d1.occurrenceCount).toBeGreaterThan(inc.occurrenceCount);
    expect(d1.notifications.some((n: { event: string; channel: string; status: string }) => n.event === "Incident opened" && n.channel === "EMAIL" && n.status === "SENT")).toBe(true);
    expect(JSON.stringify(d1.notifications)).not.toMatch(/@/); // no recipient addresses
    expect(d1.occurrences[0].link).toBe(`/websites/${s.id}?tab=availability`);
    // recovery stays with the engine
    env.site.toggles.set(s.host, "up");
    await windowFor([s.id]);
    await windowFor([s.id]);
    const d2 = (await u.client.get(`${api(u.orgId)}/incidents/${inc.id}`)).body.data;
    expect(d2).toMatchObject({ status: "RESOLVED", autoResolved: true });
    expect(d2.events.map((e: { type: string }) => e.type)).toEqual(["CREATED", "ACKNOWLEDGED", "AUTO_RESOLVED"]);
    expect((await u.client.post(`${api(u.orgId)}/incidents/${inc.id}/acknowledge`)).status).toBe(409);
    // the customer role can't write incidents directly any more (only through acknowledge_incident)
    expect((await env.owner.query(`SELECT has_table_privilege('wim_app', 'incidents', 'UPDATE') AS u, has_table_privilege('wim_app', 'incident_events', 'INSERT') AS i`)).rows[0]).toEqual({ u: false, i: false });
  }, 300_000);

  it("filters and keyset pagination over many incidents", async () => {
    const u = await customer("dashIncPage");
    const site = await addVerifiedSite(env.owner, u.orgId, fixtureSite("pg").origin);
    // fixture rows (inserted as the schema owner) to exercise pagination; the engine path is covered above
    for (let i = 0; i < 25; i++) {
      await env.owner.query(`INSERT INTO incidents (org_id, website_id, number, fingerprint, check_key, category, source, severity, status, title, description, scope, diagnostics, first_detected_at, last_detected_at, resolved_at, updated_at)
        VALUES ($1, $2, 2000 + $3, 'fx' || $3, 'http.down', 'AVAILABILITY', $4, $5, $6, 'Fixture ' || $3, 'd', 'site', '{}', now() - make_interval(hours => $3 + 1), now() - make_interval(hours => $3), $7, now())`,
        [u.orgId, site, i, i % 3 === 0 ? "BROWSER" : "HTTP_PROBE", i % 2 ? "HIGH" : "LOW", i < 5 ? "OPEN" : "RESOLVED", i < 5 ? null : new Date(Date.now() - i * 3_600_000)]);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: { data: Array<{ id: string; lastDetectedAt: string }>; nextCursor: string | null } } = await u.client.get(`${api(u.orgId)}/incidents?status=ALL&limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.data.map((x) => x.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=RESOLVED&limit=100`)).body.data).toHaveLength(20);
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=ALL&severity=HIGH&limit=100`)).body.data).toHaveLength(12);
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=ALL&source=BROWSER&limit=100`)).body.data).toHaveLength(9);
    expect((await u.client.get(`${api(u.orgId)}/incidents?status=ALL&from=${new Date(Date.now() - 2.5 * 3_600_000).toISOString()}&limit=100`)).body.data.length).toBeGreaterThanOrEqual(5);
    expect((await u.client.get(`${api(u.orgId)}/incidents?cursor=not-a-cursor`)).status).toBe(400);
  });
});

describe("history, schedule, usage", () => {
  it("history merges persisted checks, incident events and configuration changes; paginates large histories", async () => {
    const u = await customer("dashHist");
    const s = await outage(u, "hist");
    expect((await u.client.put(`${api(u.orgId)}/websites/${s.id}/monitoring/http/config`, { timeoutMs: 20_000 })).status).toBe(200);
    const all = (await u.client.get(`${api(u.orgId)}/monitoring/history?limit=100`)).body.data;
    expect(all.filter((e: { type: string }) => e.type === "CHECK")).toHaveLength(4);
    expect(all.some((e: { type: string; title: string }) => e.type === "INCIDENT" && /opened/.test(e.title))).toBe(true);
    expect(all.some((e: { type: string; title: string }) => e.type === "CONFIG" && /Http check updated/.test(e.title))).toBe(true);
    expect(all.some((e: { type: string }) => e.type === "VERIFICATION")).toBe(false); // seeded websites have no verification audit
    for (let i = 1; i < all.length; i++) expect(all[i - 1].at >= all[i].at).toBe(true);
    expect((await u.client.get(`${api(u.orgId)}/monitoring/history?result=FAILED`)).body.data).toHaveLength(2);
    expect((await u.client.get(`${api(u.orgId)}/monitoring/history?type=INCIDENT`)).body.data.every((e: { type: string }) => e.type === "INCIDENT")).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/@example|actor|ip/i); // no actor identity in the timeline
    // large history: 600 ledger rows (fixture, schema owner) page through without gaps or duplicates
    await env.owner.query(`INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
      SELECT gen_random_uuid(), $1, $2, 'T1_HTTP', now() - interval '3 days' - make_interval(mins => g), 'PASSED', 1 FROM generate_series(1, 600) g`, [u.orgId, s.id]);
    const ids = new Set<string>();
    let cursor: string | null = null, pages = 0;
    do {
      const r: { body: { data: Array<{ id: string }>; nextCursor: string | null } } = await u.client.get(`${api(u.orgId)}/monitoring/history?type=CHECK&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      for (const e of r.body.data) ids.add(e.id);
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(ids.size).toBe(604);
    expect(pages).toBe(7);
  }, 240_000);

  it("schedule: can only slow a tier down; audited; replay-safe; needs CSRF and monitoring:write", async () => {
    const u = await customer("dashSched");
    const id = await addVerifiedSite(env.owner, u.orgId, fixtureSite("sch").origin);
    const url = `${api(u.orgId)}/websites/${id}/monitoring/schedule`;
    const r0 = (await u.client.get(url)).body.data;
    const min = r0.entitlements.HTTP.minIntervalSec;
    const tooFast = await u.client.put(url, { httpIntervalSec: Math.max(30, min - 1) });
    if (min > 30) expect(tooFast.status).toBe(400);
    const ok = await u.client.put(url, { httpIntervalSec: min * 5 });
    expect(ok.body.data.httpIntervalSec).toBe(min * 5);
    expect((await u.client.put(url, { httpIntervalSec: min * 5 })).body.data.httpIntervalSec).toBe(min * 5); // replay: same state
    expect((await u.client.put(url, { httpIntervalSec: 5 })).status).toBe(400);
    expect((await u.client.put(url, { browserIntervalSec: 600, extra: 1 })).status).toBe(400);
    expect((await u.client.request("PUT", url, { httpIntervalSec: min * 6 }, { noCsrf: true })).status).toBe(403);
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'website.monitoring_schedule_updated'`, [u.orgId])).rows[0].n).toBe(2);
    const viewer = await verifiedUser(h.app, "schedViewer");
    await inviteAndAccept(u.client, u.orgId, viewer, "VIEWER");
    expect((await viewer.client.put(url, { httpIntervalSec: min * 7 })).status).toBe(403);
    await env.scheduler().runCycle();
    expect((await env.owner.query(`SELECT interval_sec FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [id])).rows[0].interval_sec).toBe(min * 5);
  }, 120_000);

  it("usage: real counters and limits; warnings near limits; customers can't change counters", async () => {
    const u = await customer("dashUsage");
    await outage(u, "use");
    const d = (await u.client.get(`${api(u.orgId)}/monitoring/usage`)).body.data;
    expect(d.websites).toMatchObject({ total: 1, httpMonitored: 1, browserMonitored: 0, deepScanned: 0 });
    expect(d.usage["http.checks"]?.today ?? d.usage["http.executions"]?.today).toBeGreaterThanOrEqual(4);
    expect(d.limits.resultRetentionDays).toEqual({ http: 62, browser: 62 });
    expect(d.limits.browser.enabled).toBe(false);
    expect(d.storage).toEqual({ screenshotBytes: 0, screenshots: 0 });
    await env.owner.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.maxWebsites', '1', 'test', gen_random_uuid())`, [u.orgId]);
    const w = (await u.client.get(`${api(u.orgId)}/monitoring/usage`)).body.data;
    expect(w.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ key: "websites", percent: 100 })]));
    // no write path exists; the role itself can't write
    expect((await env.owner.query(`SELECT has_table_privilege('wim_app', 'usage_counters', 'UPDATE') AS u`)).rows[0].u).toBe(false);
    expect((await u.client.request("PUT", `${api(u.orgId)}/monitoring/usage`, {})).status).toBe(404);
  }, 240_000);
});

describe("notifications", () => {
  it("in-app notifications from the real worker; per-user read state; preferences route by source and channel", async () => {
    const u = await customer("dashNotif");
    const member = await verifiedUser(h.app, "dashMember");
    await inviteAndAccept(u.client, u.orgId, member, "MEMBER");
    // defaults: owner gets email + in-app; a plain member gets nothing until they opt in
    const p0 = (await u.client.get(`${api(u.orgId)}/notification-preferences`)).body.data;
    expect(p0).toEqual([
      expect.objectContaining({ channel: "EMAIL", enabled: true, isDefault: true }),
      expect.objectContaining({ channel: "IN_APP", enabled: true, isDefault: true }),
    ]);
    expect((await member.client.get(`${api(u.orgId)}/notification-preferences`)).body.data[1]).toMatchObject({ enabled: false, isDefault: true });
    // the member opts into in-app outage notices only; the owner turns in-app recovery notices off
    const mp = await member.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ channel: "IN_APP", enabled: true, minSeverity: "LOW", eventTypes: ["INCIDENT_OPENED"], websiteIds: [] }] });
    expect(mp.status).toBe(200);
    expect(mp.body.data[1]).toMatchObject({ channel: "IN_APP", enabled: true, isDefault: false });
    await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ channel: "IN_APP", enabled: true, minSeverity: "MEDIUM", eventTypes: ["INCIDENT_OPENED"], websiteIds: [] }] });
    expect((await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ channel: "SMS", enabled: true, minSeverity: "LOW", eventTypes: [], websiteIds: [] }] })).status).toBe(400);
    expect((await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ channel: "EMAIL", enabled: true, minSeverity: "LOW", eventTypes: [], websiteIds: [randomUUID()] }] })).status).toBe(400);
    const s = await outage(u, "notif");
    const ownerList = await until(async () => { const r = await u.client.get(`${api(u.orgId)}/notifications`); return r.body.data.length ? r : null; }, 30_000, 300);
    expect(ownerList.body.data[0]).toMatchObject({ type: "INCIDENT_CREATED", read: false, link: expect.stringMatching(/^\/o\/.+\/incidents\?incident=/) });
    expect(ownerList.body.unread).toBe(1);
    const memberList = await until(async () => { const r = await member.client.get(`${api(u.orgId)}/notifications`); return r.body.data.length ? r : null; }, 30_000, 300);
    const memberNote = memberList.body.data[0];
    // per user: the owner can't see or mark the member's notification
    expect(ownerList.body.data.some((n: { id: string }) => n.id === memberNote.id)).toBe(false);
    expect((await u.client.post(`${api(u.orgId)}/notifications/${memberNote.id}/read`)).status).toBe(404);
    expect((await member.client.post(`${api(u.orgId)}/notifications/${memberNote.id}/read`)).status).toBe(200);
    expect((await member.client.get(`${api(u.orgId)}/notifications?unread=true`)).body.data).toHaveLength(0);
    const ra = await u.client.post(`${api(u.orgId)}/notifications/read-all`);
    expect(ra.body.data.marked).toBe(1);
    expect((await u.client.post(`${api(u.orgId)}/notifications/read-all`)).body.data.marked).toBe(0); // retry-safe
    // recovery: the owner opted out of in-app recovery notices
    env.site.toggles.set(s.host, "up");
    await windowFor([s.id]);
    await windowFor([s.id]);
    await env.relay();
    await sleep(2500);
    const types = (await u.client.get(`${api(u.orgId)}/notifications`)).body.data.map((n: { type: string }) => n.type);
    expect(types).toEqual(["INCIDENT_CREATED"]);
    // the customer role can only set read_at
    const g = (await env.owner.query(`SELECT has_table_privilege('wim_app', 'notifications', 'INSERT') AS i, has_column_privilege('wim_app', 'notifications', 'title', 'UPDATE') AS t, has_column_privilege('wim_app', 'notifications', 'read_at', 'UPDATE') AS r`)).rows[0];
    expect(g).toEqual({ i: false, t: false, r: true });
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'notification.preferences_updated'`, [u.orgId])).rows[0].n).toBe(2);
  }, 300_000);
});

describe("change feed and tenant isolation", () => {
  it("change feed: kinds only, scoped to the tenant and user, cursor-based with overlap", async () => {
    const a = await customer("feedA");
    const b = await customer("feedB");
    const f0 = (await a.client.get(`${api(a.orgId)}/changes`)).body.data;
    expect(f0.cursor).toMatch(/^\d{13}$/);
    const s = await outage(a, "feed");
    const f1 = (await a.client.get(`${api(a.orgId)}/changes?since=${f0.cursor}`)).body.data;
    expect(f1.changes.some((c: { kind: string; websiteId: string }) => c.kind === "CHECK" && c.websiteId === s.id)).toBe(true);
    expect(f1.changes.some((c: { kind: string }) => c.kind === "INCIDENT")).toBe(true);
    expect(Object.keys(f1.changes[0]).sort()).toEqual(["at", "kind", "websiteId"]); // no payloads
    const fb = (await b.client.get(`${api(b.orgId)}/changes?since=${f0.cursor}`)).body.data;
    expect(fb.changes).toEqual([]);
    expect((await b.client.get(`${api(a.orgId)}/changes`)).status).toBe(404);
    expect((await a.client.get(`${api(a.orgId)}/changes?since=garbage`)).status).toBe(200); // treated as "recent"
    // permissions are re-validated on every poll: a removed member's next poll is refused
    const m = await verifiedUser(h.app, "feedMember");
    const member = await inviteAndAccept(a.client, a.orgId, m, "VIEWER");
    expect((await m.client.get(`${api(a.orgId)}/changes`)).status).toBe(200);
    expect((await a.client.del(`${api(a.orgId)}/members/${member.id}`)).status).toBeLessThan(300);
    expect((await m.client.get(`${api(a.orgId)}/changes?since=${f0.cursor}`)).status).toBe(404);
  }, 240_000);

  it("every Phase 4F endpoint refuses other tenants and forged identifiers", async () => {
    const a = await customer("isoA4f");
    const b = await customer("isoB4f");
    const s = await outage(a, "iso4f");
    const inc = (await a.client.get(`${api(a.orgId)}/incidents?status=ALL`)).body.data[0];
    const note = await until(async () => (await a.client.get(`${api(a.orgId)}/notifications`)).body.data[0], 30_000, 300);
    const reads = [
      `/websites/${s.id}/monitoring/http/analytics`, `/websites/${s.id}/monitoring/schedule`, `/incidents/${inc.id}`,
      `/websites/${s.id}/monitoring/browser/results/${randomUUID()}`,
    ];
    for (const p of reads) {
      expect((await b.client.get(`${api(b.orgId)}${p}`)).status, p).toBe(404);
      expect((await b.client.get(`${api(a.orgId)}${p}`)).status, p).toBe(404);
    }
    for (const p of ["/monitoring/overview", "/monitoring/history", "/monitoring/usage", "/notifications", "/notification-preferences"]) {
      expect((await b.client.get(`${api(a.orgId)}${p}`)).status, p).toBe(404);
    }
    const ob = (await b.client.get(`${api(b.orgId)}/monitoring/overview`)).body.data;
    expect(ob.websites).toEqual([]);
    expect((await b.client.get(`${api(b.orgId)}/monitoring/history?websiteId=${s.id}`)).body.data).toEqual([]);
    expect((await b.client.get(`${api(b.orgId)}/incidents?status=ALL&websiteId=${s.id}`)).body.data).toEqual([]);
    expect((await b.client.post(`${api(b.orgId)}/incidents/${inc.id}/acknowledge`)).status).toBe(404);
    expect((await b.client.post(`${api(b.orgId)}/notifications/${note.id}/read`)).status).toBe(404);
    expect((await b.client.put(`${api(b.orgId)}/websites/${s.id}/monitoring/schedule`, { httpIntervalSec: 600 })).status).toBe(404);
    expect((await a.client.post(`${api(a.orgId)}/incidents/${randomUUID()}/acknowledge`)).status).toBe(404);
    expect((await a.client.get(`${api(a.orgId)}/incidents/not-a-uuid`)).status).toBe(400);
    expect((await a.client.get(`${api(a.orgId)}/websites/${s.id}/monitoring/browser/results/${randomUUID()}`)).status).toBe(404);
    expect((await env.owner.query(`SELECT status::text FROM incidents WHERE id = $1`, [inc.id])).rows[0].status).toBe("OPEN");
  }, 240_000);

  it("Super Admin: aggregate outcomes, usage and gateway signal only — no customer identifiers or content", async () => {
    const u = await customer("dashAdmin");
    const s = await outage(u, "adm4f");
    const adm = await createAdmin("ADMIN_SUPPORT");
    const c = Client.admin(h.app);
    expect((await c.post("/api/admin/v1/auth/login", { email: adm.email, password: adm.password, code: await totpCode(adm.secret) })).status).toBe(200);
    const r = await c.get("/api/admin/v1/monitoring/health");
    expect(r.status).toBe(200);
    const t1 = r.body.data.outcomes.find((o: { tier: string }) => o.tier === "T1_HTTP");
    expect(t1.results24h).toBeGreaterThanOrEqual(4);
    expect(t1.failureRatePercent24h).not.toBeNull();
    expect(r.body.data.gateway.source).toBe("derived from execution outcomes");
    expect(r.body.data.usage.length).toBeGreaterThan(0);
    const text = JSON.stringify(r.body);
    for (const needle of [s.host, s.id, u.orgId, "toggle", "Website down"]) expect(text).not.toContain(needle);
    // the admin session can't use customer endpoints
    expect((await c.get(`${api(u.orgId)}/monitoring/overview`)).status).toBe(401);
  }, 240_000);
});
