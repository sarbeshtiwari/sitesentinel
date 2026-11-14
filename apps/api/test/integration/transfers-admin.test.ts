import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client, createAdmin, totpCode, userWithOrg, waitForEmail } from "../helpers/harness.js";
import { addWebsite, heartbeat, sdkCollect, startWebsiteHarness, uniqueDomain, verifiedWebsite, type WebsiteHarness } from "../helpers/websites.js";

let h: WebsiteHarness;
let sa: Client;
let operator: Client;
let support: Client;

async function adminClient(role: string) {
  const a = await createAdmin(role);
  const c = Client.admin(h.app);
  const r = await c.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) });
  expect(r.status).toBe(200);
  return c;
}

beforeAll(async () => {
  h = await startWebsiteHarness();
  sa = await adminClient("SUPER_ADMIN");
  operator = await adminClient("ADMIN_OPERATOR");
  support = await adminClient("ADMIN_SUPPORT");
});
afterAll(async () => { await h.stopAll(); });

async function openTransfer(owner: Awaited<ReturnType<typeof userWithOrg>>, requester: Awaited<ReturnType<typeof userWithOrg>>, d: string) {
  const r = await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers`, { url: `https://www.${d}` });
  expect(r.status).toBe(201);
  return r.body.data as { id: string; record: { name: string; value: string } };
}

describe("domain ownership transfer", () => {
  it("requires the requester's own DNS proof, owner notification, and admin approval; then moves the identity", async () => {
    const owner = await userWithOrg(h.app, "trOwner");
    const requester = await userWithOrg(h.app, "trReq");
    const d = uniqueDomain("transfer");
    const ownerSite = await verifiedWebsite(h, owner.client, owner.orgId, d);
    await sdkCollect(h, heartbeat(ownerSite.install.siteKey), `https://${d}`);

    const t = await openTransfer(owner, requester, d);
    expect(t.record.name).toBe(`_sitesentinel-verification.${d}`);
    expect(t.record.value).toMatch(/^sitesentinel-transfer=/);
    // Admin cannot approve before DNS proof.
    expect((await sa.post(`/api/admin/v1/domain-transfers/${t.id}/decision`, { decision: "APPROVE", reason: "too early to approve" })).status).toBe(409);
    // Requester's DNS proof is checked by the worker.
    let v = await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers/${t.id}/verify`);
    expect(await h.waitJob(v.body.data.jobId)).toMatchObject({ status: "FAILED" });
    h.dns.setTxt(t.record.name, [ownerSite.instructions.value, t.record.value]);
    v = await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers/${t.id}/verify`);
    expect(await h.waitJob(v.body.data.jobId)).toMatchObject({ status: "VERIFIED" });

    // Owner side: sees the request without the requester's identity, and is emailed.
    const incoming = (await owner.client.get(`/api/v1/orgs/${owner.orgId}/domain-transfers/incoming`)).body.data;
    expect(incoming[0]).toMatchObject({ id: t.id, status: "PENDING_ADMIN", websiteId: ownerSite.id });
    expect(JSON.stringify(incoming)).not.toContain(requester.orgId);
    const mail = await waitForEmail(owner.email, "Ownership transfer requested");
    expect(mail.text).not.toContain(requester.email);
    const ownerDetail = (await owner.client.get(`/api/v1/orgs/${owner.orgId}/websites/${ownerSite.id}`)).body.data;
    expect(ownerDetail.pendingTransfer).toMatchObject({ id: t.id, status: "PENDING_ADMIN" });
    expect((await owner.client.post(`/api/v1/orgs/${owner.orgId}/domain-transfers/incoming/${t.id}/contest`)).status).toBe(204);

    // Admin review queue shows metadata only; support role cannot decide.
    const queue = (await sa.get("/api/admin/v1/domain-transfers")).body.data;
    expect(queue.find((x: { id: string }) => x.id === t.id)).toMatchObject({ status: "PENDING_ADMIN", ownerResponse: "CONTESTED", displayHost: d });
    expect((await support.post(`/api/admin/v1/domain-transfers/${t.id}/decision`, { decision: "APPROVE", reason: "support should not decide" })).status).toBe(403);
    expect((await operator.post(`/api/admin/v1/domain-transfers/${t.id}/decision`, { decision: "APPROVE" })).status).toBe(400); // reason required
    const dec = await operator.post(`/api/admin/v1/domain-transfers/${t.id}/decision`, { decision: "APPROVE", reason: "Requester proved DNS control; owner lapsed" });
    expect(dec.body.data.status).toBe("APPROVED");
    const applied = await h.waitJob(`apply.${t.id}`);
    expect(applied).toMatchObject({ status: "APPLIED", trialOutcome: "DOMAIN_PREVIOUSLY_TRIALED" });

    // Requester now owns a verified website with a fresh site key; owner's website is archived, its key revoked.
    const reqSites = (await requester.client.get(`/api/v1/orgs/${requester.orgId}/websites`)).body.data;
    expect(reqSites[0]).toMatchObject({ hostKey: d, status: "ACTIVE", verification: "VERIFIED", installation: "NOT_INSTALLED" });
    expect((await owner.client.get(`/api/v1/orgs/${owner.orgId}/websites/${ownerSite.id}`)).status).toBe(404);
    const newDetail = (await requester.client.get(`/api/v1/orgs/${requester.orgId}/websites/${reqSites[0].id}`)).body.data;
    expect(newDetail.install.siteKey).not.toBe(ownerSite.install.siteKey);
    // The old owner's SDK data is not visible to the new owner (different website id), and the old key is dead.
    await new Promise((r) => setTimeout(r, 15_500));
    await sdkCollect(h, heartbeat(ownerSite.install.siteKey), `https://${d}`);
    expect((await requester.client.get(`/api/v1/orgs/${requester.orgId}/websites/${reqSites[0].id}`)).body.data.install.pageLoads).toBe(0);
    await waitForEmail(requester.email, "Ownership transfer approved");
    const platform = (await sa.get("/api/admin/v1/audit-logs?stream=platform")).body.data;
    expect(platform.find((a: { action: string; targetId: string }) => a.action === "admin.transfer_approved" && a.targetId === t.id)).toMatchObject({ reason: "Requester proved DNS control; owner lapsed" });
  }, 120_000);

  it("unauthorized transfers: no proof → nothing happens; transfers of unclaimed/own domains are refused; cancel works", async () => {
    const owner = await userWithOrg(h.app, "tr2Owner");
    const requester = await userWithOrg(h.app, "tr2Req");
    const d = uniqueDomain("tr2");
    await verifiedWebsite(h, owner.client, owner.orgId, d);
    expect((await owner.client.post(`/api/v1/orgs/${owner.orgId}/domain-transfers`, { url: d })).body.error.details.reason).toBe("YOURS");
    expect((await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers`, { url: uniqueDomain("free") })).body.error.details.reason).toBe("UNCLAIMED");
    const t = await openTransfer(owner, requester, d);
    expect((await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers`, { url: d })).body.error.details.reason).toBe("ALREADY_REQUESTED");
    // The owner cannot see or cancel the requester's transfer record; another org can't verify it.
    const outsider = await userWithOrg(h.app, "tr2Out");
    expect((await outsider.client.post(`/api/v1/orgs/${outsider.orgId}/domain-transfers/${t.id}/verify`)).status).toBe(404);
    expect((await owner.client.post(`/api/v1/orgs/${owner.orgId}/domain-transfers/${t.id}/cancel`)).status).toBe(404);
    expect((await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers/${t.id}/cancel`)).status).toBe(204);
    const { rows } = await h.owner.query("SELECT status FROM domain_transfers WHERE id = $1", [t.id]);
    expect(rows[0].status).toBe("CANCELLED");
  });

  it("rejection keeps the current owner and notifies both sides", async () => {
    const owner = await userWithOrg(h.app, "tr3Owner");
    const requester = await userWithOrg(h.app, "tr3Req");
    const d = uniqueDomain("tr3");
    const site = await verifiedWebsite(h, owner.client, owner.orgId, d);
    const t = await openTransfer(owner, requester, d);
    h.dns.setTxt(t.record.name, [site.instructions.value, t.record.value]);
    const v = await requester.client.post(`/api/v1/orgs/${requester.orgId}/domain-transfers/${t.id}/verify`);
    await h.waitJob(v.body.data.jobId);
    expect((await sa.post(`/api/admin/v1/domain-transfers/${t.id}/decision`, { decision: "REJECT", reason: "Owner demonstrated active use" })).body.data.status).toBe("REJECTED");
    expect((await owner.client.get(`/api/v1/orgs/${owner.orgId}/websites/${site.id}`)).body.data.status).toBe("ACTIVE");
    await waitForEmail(requester.email, "Ownership transfer rejected");
    await waitForEmail(owner.email, "Ownership transfer rejected");
  });

  it("the API role cannot write transfer state directly", async () => {
    const o = await userWithOrg(h.app, "trDb");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT app_enter_org($1, $2, NULL)", [o.orgId, o.userId]);
      await expect(c.query("UPDATE domain_transfers SET status = 'APPROVED'")).rejects.toThrow(/permission denied/);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  });
});

describe("Super Admin website statistics", () => {
  it("returns aggregate registration, verification, SDK, trial, duplicate and transfer counts matching the database", async () => {
    const a = await userWithOrg(h.app, "statsA");
    const b = await userWithOrg(h.app, "statsB");
    const d = uniqueDomain("stats");
    await addWebsite(a.client, a.orgId, d);
    await b.client.post(`/api/v1/orgs/${b.orgId}/websites`, { name: "dupe", url: d });
    const r = await sa.get("/api/admin/v1/websites/stats");
    expect(r.status).toBe(200);
    const s = r.body.data;
    const db = (await h.owner.query(`SELECT
      (SELECT count(*) FROM websites WHERE archived_at IS NULL)::int AS total,
      (SELECT count(*) FROM websites WHERE status = 'ACTIVE')::int AS verified,
      (SELECT count(*) FROM trials)::int AS trials,
      (SELECT count(*) FROM domain_registration_attempts WHERE outcome IN ('DUPLICATE','DUPLICATE_NAMESPACE') AND created_at > now() - interval '24 hours')::int AS dup`)).rows[0];
    expect(s.websites.total).toBe(db.total);
    expect(s.websites.verified).toBe(db.verified);
    expect(s.trials.activatedTotal).toBe(db.trials);
    expect(s.registrationAttempts.duplicates24h).toBe(db.dup);
    expect(s.registrationAttempts.duplicates24h).toBeGreaterThan(0);
    expect(s.transfers.approved).toBeGreaterThanOrEqual(1);
    expect(s.daily).toHaveLength(30);
    // Aggregates only: no domain names, ids, emails or keys.
    const text = JSON.stringify(s);
    expect(text).not.toContain(d);
    expect(text).not.toMatch(/@|pk_|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("support can read stats; auditor cannot; customers cannot", async () => {
    expect((await support.get("/api/admin/v1/websites/stats")).status).toBe(200);
    const auditor = await adminClient("ADMIN_AUDITOR");
    expect((await auditor.get("/api/admin/v1/websites/stats")).status).toBe(403);
    const cust = await userWithOrg(h.app, "notadmin");
    const imposter = Client.admin(h.app);
    imposter.cookies.set("wim_sid", cust.client.cookies.get("wim_sid")!);
    expect((await imposter.get("/api/admin/v1/websites/stats")).status).toBe(401);
  });

  it("the admin database role still cannot read websites' telemetry, site keys or verification details", async () => {
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    try {
      for (const sql of ["SELECT payload FROM sdk_events LIMIT 1", "SELECT site_key FROM site_installations LIMIT 1", "SELECT detail FROM domain_verifications LIMIT 1", "SELECT verification_token FROM domain_claims LIMIT 1"]) {
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      expect((await c.query("SELECT websites_total FROM admin_v_website_stats")).rowCount).toBe(1);
    } finally {
      await c.end();
    }
  });
});
