import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, userWithOrg, type Harness } from "../helpers/harness.js";

/**
 * Real-time notification delivery support: `since` polling filter, website name on notifications (same
 * organisation only), and the in-app sound / quiet-hours preferences — against real Postgres with RLS.
 */
let h: Harness;
beforeAll(async () => { h = await startHarness(); }, 120_000);
afterAll(async () => { await h.stop(); });

const api = (o: string) => `/api/v1/orgs/${o}`;

async function website(c: pg.Client, orgId: string, name: string) {
  const tag = randomBytes(4).toString("hex");
  const host = `rt-${tag}.example`;
  const regId = randomUUID(), claimId = randomUUID();
  await c.query(`INSERT INTO domain_registry (id, identity_key, host_key, registrable_domain, display_host, is_root) VALUES ($1, $2, $2, $2, $2, true)`, [regId, host]);
  await c.query(`INSERT INTO domain_claims (id, org_id, domain_registry_id, scope, policy, verification_token, status, verified_at, verified_method, updated_at)
    VALUES ($1, $2, $3, 'HOST', 'SUBDOMAIN_INDEPENDENT', $4, 'VERIFIED', now(), 'DNS_TXT', now())`, [claimId, orgId, regId, `wim-verify-${tag}`]);
  const { rows } = await c.query<{ id: string }>(`INSERT INTO websites (org_id, domain_claim_id, name, canonical_origin, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`, [orgId, claimId, name, `https://${host}`]);
  return rows[0]!.id;
}
async function note(c: pg.Client, orgId: string, userId: string, o: { title: string; link?: string | null; severity?: string; at?: Date }) {
  const { rows } = await c.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications (org_id, user_id, type, severity, title, body, link, created_at) VALUES ($1, $2, 'INCIDENT_CREATED', $3::"Severity", $4, 'body', $5, $6) RETURNING id, created_at`,
    [orgId, userId, o.severity ?? "HIGH", o.title, o.link ?? null, o.at ?? new Date()]);
  return rows[0]!;
}

describe("real-time notification polling", () => {
  it("`since` returns only notifications created at or after the instant; website name resolved in-org only", async () => {
    const a = await userWithOrg(h.app, "rtA");
    const b = await userWithOrg(h.app, "rtB");
    const siteA = await website(h.owner, a.orgId, "Shop A");
    const siteB = await website(h.owner, b.orgId, "Secret B");
    const t0 = new Date(Date.now() - 60_000);
    await note(h.owner, a.orgId, a.userId, { title: "old", at: new Date(t0.getTime() - 1000) });
    const n1 = await note(h.owner, a.orgId, a.userId, { title: "fresh", at: t0, link: `https://app.example/o/${a.orgId}/websites/${siteA}?tab=monitoring#evt-1` });
    // a forged link to another organisation's website must not leak its name
    const n2 = await note(h.owner, a.orgId, a.userId, { title: "forged", at: new Date(t0.getTime() + 1000), link: `https://app.example/o/${a.orgId}/websites/${siteB}` });

    const r = await a.client.get(`${api(a.orgId)}/notifications?since=${encodeURIComponent(t0.toISOString())}&unread=true&limit=20`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((n: { title: string }) => n.title)).toEqual(["forged", "fresh"]);
    const fresh = r.body.data.find((n: { id: string }) => n.id === n1.id);
    expect(fresh).toMatchObject({ websiteId: siteA, websiteName: "Shop A", link: `/o/${a.orgId}/websites/${siteA}?tab=monitoring` });
    expect(r.body.data.find((n: { id: string }) => n.id === n2.id)).toMatchObject({ websiteId: null, websiteName: null });
    expect(JSON.stringify(r.body)).not.toContain("Secret B");

    // later instant → nothing; invalid instant → 400
    expect((await a.client.get(`${api(a.orgId)}/notifications?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).body.data).toEqual([]);
    expect((await a.client.get(`${api(a.orgId)}/notifications?since=yesterday`)).status).toBe(400);
    // tenant isolation: B can't poll A's organisation
    expect((await b.client.get(`${api(a.orgId)}/notifications?since=${encodeURIComponent(t0.toISOString())}`)).status).toBe(404);
    expect((await b.client.get(`${api(b.orgId)}/notifications?since=${encodeURIComponent(t0.toISOString())}`)).body.data).toEqual([]);
  });
});

describe("in-app sound and quiet hours preferences", () => {
  it("defaults, save, keep when omitted, clear with null, validation", async () => {
    const u = await userWithOrg(h.app, "rtPrefs");
    const p0 = (await u.client.get(`${api(u.orgId)}/notification-preferences`)).body.data;
    expect(p0[1]).toMatchObject({ channel: "IN_APP", soundEnabled: true, soundMinSeverity: "HIGH", quietHours: null, isDefault: true });

    const quietHours = { start: "22:00", end: "07:00", tz: "Asia/Kolkata", exceptCritical: true };
    const base = { channel: "IN_APP", enabled: true, minSeverity: "MEDIUM", eventTypes: [], websiteIds: [] };
    const s1 = await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ ...base, soundEnabled: false, soundMinSeverity: "CRITICAL", quietHours }] });
    expect(s1.status).toBe(200);
    expect(s1.body.data[1]).toMatchObject({ soundEnabled: false, soundMinSeverity: "CRITICAL", quietHours, isDefault: false });

    // an older client omitting the new fields keeps them
    const s2 = await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ ...base, minSeverity: "LOW" }] });
    expect(s2.body.data[1]).toMatchObject({ minSeverity: "LOW", soundEnabled: false, soundMinSeverity: "CRITICAL", quietHours });

    const s3 = await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ ...base, quietHours: null, soundEnabled: true }] });
    expect(s3.body.data[1]).toMatchObject({ soundEnabled: true, quietHours: null });
    expect((await h.owner.query(`SELECT quiet_hours FROM notification_preferences WHERE org_id = $1 AND channel = 'IN_APP'`, [u.orgId])).rows[0].quiet_hours).toBeNull();

    for (const bad of [{ ...quietHours, start: "25:00" }, { ...quietHours, tz: "Mars/Olympus" }, { ...quietHours, extra: 1 }]) {
      expect((await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ ...base, quietHours: bad }] })).status).toBe(400);
    }
    expect((await u.client.put(`${api(u.orgId)}/notification-preferences`, { preferences: [{ ...base, soundMinSeverity: "LOUD" }] })).status).toBe(400);
  });
});
