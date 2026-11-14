import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REVALIDATE_QUEUE } from "@wim/contracts";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createGatewayDnsClient, signCapability } from "@wim/netguard";
import { createRevalidationProcessor } from "@wim/worker-http";
import { userWithOrg, waitForEmail } from "../helpers/harness.js";
import { EGRESS_SECRET, heartbeat, sdkCollect, serve, startWebsiteHarness, uniqueDomain, verifiedWebsite, addWebsite, verifyNow, type WebsiteHarness } from "../helpers/websites.js";

let h: WebsiteHarness;
let q: Queue;
let conn: Redis;

beforeAll(async () => {
  h = await startWebsiteHarness();
  conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  q = new Queue(REVALIDATE_QUEUE, { connection: conn, prefix: process.env.QUEUE_PREFIX });
});
afterAll(async () => { await q.close(); conn.disconnect(); await h.stopAll(); });

const claimOf = async (websiteId: string) =>
  (await h.owner.query("SELECT c.* FROM domain_claims c JOIN websites w ON w.domain_claim_id = c.id WHERE w.id = $1", [websiteId])).rows[0];

/** Run one revalidation of a website's claim through the real queue and worker. */
async function revalidate(websiteId: string) {
  const c = await claimOf(websiteId);
  const job = await q.add("REVALIDATE_DOMAIN", { kind: "REVALIDATE_DOMAIN", claimId: c.id, manual: false });
  return h.waitJob(job.id!, "revalidate");
}

describe("ownership revalidation with the original method", () => {
  it("a healthy DNS-verified claim is re-confirmed; history records it without the token", async () => {
    const o = await userWithOrg(h.app, "revok");
    const d = uniqueDomain("revok");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    const before = await claimOf(w.id);
    expect(before.next_revalidation_at.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000); // first check in ~24 h
    expect(await revalidate(w.id)).toMatchObject({ status: "REVALIDATED", outcome: "SUCCEEDED", state: "OK", effect: "NONE" });
    const after = await claimOf(w.id);
    expect(after.last_reverified_at.getTime()).toBeGreaterThan(before.last_reverified_at.getTime());
    const hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0]).toMatchObject({ method: "DNS_TXT", status: "SUCCEEDED" });
    const json = JSON.stringify(hist) + JSON.stringify((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/audit`)).body);
    expect(json).not.toContain(w.instructions.token);
    const det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det.claim.revalidation).toMatchObject({ state: "OK", lastOutcome: "SUCCEEDED" });
    expect(det.instructions).toBeNull();
  });

  it("temporary DNS failure (SERVFAIL) never advances the state", async () => {
    const o = await userWithOrg(h.app, "revtemp");
    const d = uniqueDomain("revtemp");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    h.dns.servfail.add(w.instructions.dns.hostRecord.name);
    try {
      for (let i = 0; i < 3; i++) expect(await revalidate(w.id)).toMatchObject({ outcome: "TEMPORARY_FAILURE", state: "OK", effect: "NONE" });
      const c = await claimOf(w.id);
      expect(c).toMatchObject({ status: "VERIFIED", revalidation_state: "OK", revalidation_failures: 0, transient_failures: 3 });
      expect((c.next_revalidation_at.getTime() - Date.now()) / 60_000).toBeLessThan(31); // retried soon, not in 24 h
    } finally {
      h.dns.servfail.delete(w.instructions.dns.hostRecord.name);
    }
  });

  it("removed record → FAILING (monitoring continues, customer notified) → LAPSED after grace → restored by the customer", async () => {
    const o = await userWithOrg(h.app, "revlapse");
    const d = uniqueDomain("revlapse");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    // A subdomain registered later inherits verification from the DNS-verified root claim.
    const sub = (await o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "blog", url: `blog.${d}` })).body.data;
    expect(sub.claim.inherited).toBe(true);
    h.dns.setTxt(w.instructions.dns.hostRecord.name, []);

    expect(await revalidate(w.id)).toMatchObject({ outcome: "DEFINITIVE_FAILURE", state: "FAILING", effect: "NOTIFY_FAILING" });
    let det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det).toMatchObject({ status: "ACTIVE", verification: "VERIFIED", claim: { revalidation: { state: "FAILING" } } });
    expect(det.claim.revalidation.lapsesAt).not.toBeNull();
    expect(det.instructions.dns.hostRecord.name).toBe(w.instructions.dns.hostRecord.name); // shown again to restore
    await waitForEmail(o.email, "Ownership check failing");
    // A second failure within grace does not notify again.
    expect(await revalidate(w.id)).toMatchObject({ state: "FAILING", effect: "NONE" });

    // Grace exhausted.
    await h.owner.query("UPDATE domain_claims SET failing_since = now() - interval '73 hours' WHERE id = $1", [(await claimOf(w.id)).id]);
    expect(await revalidate(w.id)).toMatchObject({ state: "LAPSED", effect: "LAPSE", websites: 2 });
    det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det).toMatchObject({ status: "LAPSED", verification: "LAPSED" });
    expect(det.claim.revalidation.releaseAt).not.toBeNull();
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${sub.id}`)).body.data.status).toBe("LAPSED");
    await waitForEmail(o.email, "Monitoring paused");
    // Suspended: SDK heartbeats no longer count.
    await new Promise((r) => setTimeout(r, 15_500));
    await sdkCollect(h, heartbeat(w.install.siteKey), `https://${d}`);
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data.install.lastInvalidReason).toBe("WEBSITE_NOT_VERIFIED");

    // Customer restores the record and asks for a check: routed to revalidation, monitoring resumes.
    h.dns.setTxt(w.instructions.dns.hostRecord.name, [w.instructions.value]);
    const v = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verify`, { method: "DNS_TXT" });
    expect(v.body.data.queue).toBe("revalidate");
    expect(await h.waitJob(v.body.data.jobId, "revalidate")).toMatchObject({ outcome: "SUCCEEDED", state: "OK", effect: "RESTORE" });
    det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det).toMatchObject({ status: "ACTIVE", verification: "VERIFIED", claim: { revalidation: { state: "OK" } } });
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${sub.id}`)).body.data.status).toBe("ACTIVE");
    await waitForEmail(o.email, "Ownership confirmed");
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs?limit=100`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["website.ownership_failing", "website.ownership_lapsed", "website.revalidation_requested", "website.ownership_restored"]));
  }, 120_000);

  it("lapsed past the release period → ownership lost: archived, released, ledger kept", async () => {
    const o = await userWithOrg(h.app, "revlost");
    const d = uniqueDomain("revlost");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    h.dns.setTxt(w.instructions.dns.hostRecord.name, []);
    const c = await claimOf(w.id);
    await h.owner.query("UPDATE domain_claims SET status = 'LAPSED', revalidation_state = 'LAPSED', lapsed_at = now() - interval '31 days', failing_since = now() - interval '35 days' WHERE id = $1", [c.id]);
    await h.owner.query("UPDATE websites SET status = 'LAPSED' WHERE id = $1", [w.id]);
    expect(await revalidate(w.id)).toMatchObject({ state: "RELEASED", effect: "RELEASE" });
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).status).toBe(404);
    expect((await claimOf(w.id))).toMatchObject({ status: "RELEASED", release_reason: "LAPSED" });
    await waitForEmail(o.email, "released from your organization");
    const ledger = (await h.owner.query("SELECT trial_consumed_at, last_released_at FROM domain_trial_ledger WHERE registrable_domain = $1", [d])).rows[0];
    expect(ledger.trial_consumed_at).not.toBeNull();
    expect(ledger.last_released_at).not.toBeNull();
    const other = await userWithOrg(h.app, "revlostnew");
    expect((await other.client.post(`/api/v1/orgs/${other.orgId}/websites`, { name: "mine", url: d })).status).toBe(201);
  });

  it("file-verified claims are re-checked with the file (removing it fails definitively)", async () => {
    const o = await userWithOrg(h.app, "revfile");
    const d = uniqueDomain("revfile");
    serve(h, d);
    const w = await addWebsite(o.client, o.orgId, d);
    const path = new URL(w.instructions.file.url).pathname;
    h.site.route(d, path, { body: w.instructions.value, type: "text/plain" });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE")).result).toMatchObject({ status: "VERIFIED" });
    expect(await revalidate(w.id)).toMatchObject({ outcome: "SUCCEEDED" });
    h.site.unroute(d, path);
    expect(await revalidate(w.id)).toMatchObject({ outcome: "DEFINITIVE_FAILURE", failureReason: "HTTP_404", state: "FAILING" });
  });
});

describe("distribution, locking and our own outages", () => {
  it("the sweep leases due claims: two sweeps in a row enqueue each claim once", async () => {
    const o = await userWithOrg(h.app, "revsweep");
    const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("revsweep"));
    const c = await claimOf(w.id);
    await h.owner.query("UPDATE domain_claims SET next_revalidation_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    const s1 = await h.waitJob((await q.add("SWEEP_REVALIDATION", { kind: "SWEEP_REVALIDATION" })).id!, "revalidate");
    const s2 = await h.waitJob((await q.add("SWEEP_REVALIDATION", { kind: "SWEEP_REVALIDATION" })).id!, "revalidate");
    expect(Number(s1.enqueued)).toBeGreaterThanOrEqual(1);
    expect(s2.enqueued).toBe(0);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await claimOf(w.id)).last_revalidation_at).not.toBeNull();
  });

  it("simultaneous revalidations of one claim: only one runs", async () => {
    const o = await userWithOrg(h.app, "revlock");
    const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("revlock"));
    const c = await claimOf(w.id);
    const db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 4 });
    const redis = new Redis(process.env.REDIS_URL!);
    const gw = `http://127.0.0.1:${(h.gateway.server.address() as { port: number }).port}`;
    const proc = createRevalidationProcessor({
      db, redis, log: createLogger("test"),
      ctxFor: (cap) => { const token = () => signCapability(EGRESS_SECRET, cap); return { dns: createGatewayDnsClient({ url: gw, token }), policy: {}, normalize: {}, egress: { url: gw, token } }; },
      enqueue: async () => undefined, enqueueEmail: async () => undefined,
    });
    const results = await Promise.all([1, 2, 3].map(() => proc({ kind: "REVALIDATE_DOMAIN", claimId: c.id, manual: false })));
    expect(results.filter((r) => r.status === "REVALIDATED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "SKIPPED")).toHaveLength(2);
    await db.$disconnect();
    redis.disconnect();
  });

  it("when our egress gateway is down, nothing is counted against the customer and operators can see it", async () => {
    const o = await userWithOrg(h.app, "revdown");
    const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("revdown"));
    const c = await claimOf(w.id);
    const db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 2 });
    const redis = new Redis(process.env.REDIS_URL!);
    const dead = "http://127.0.0.1:1";
    const proc = createRevalidationProcessor({
      db, redis, log: createLogger("test"),
      ctxFor: (cap) => { const token = () => signCapability(EGRESS_SECRET, cap); return { dns: createGatewayDnsClient({ url: dead, token }), policy: {}, normalize: {}, egress: { url: dead, token } }; },
      enqueue: async () => undefined, enqueueEmail: async () => undefined,
    });
    const before = Number((await h.owner.query("SELECT count(*) FROM system_health_logs WHERE component = 'revalidation'")).rows[0].count);
    expect(await proc({ kind: "REVALIDATE_DOMAIN", claimId: c.id, manual: false })).toMatchObject({ outcome: "SERVICE_UNAVAILABLE", state: "OK" });
    expect(await claimOf(w.id)).toMatchObject({ revalidation_state: "OK", revalidation_failures: 0, transient_failures: 0, status: "VERIFIED" });
    const after = Number((await h.owner.query("SELECT count(*) FROM system_health_logs WHERE component = 'revalidation'")).rows[0].count);
    expect(after).toBe(before + 1);
    await db.$disconnect();
    redis.disconnect();
  });

  it("revalidation traffic carries a capability token attributed to the org", async () => {
    const o = await userWithOrg(h.app, "revcap");
    const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("revcap"));
    const allowedBefore = h.gateway.stats.get("ALLOWED") ?? 0;
    await revalidate(w.id);
    expect((h.gateway.stats.get("ALLOWED") ?? 0)).toBeGreaterThan(allowedBefore);
  });
});
