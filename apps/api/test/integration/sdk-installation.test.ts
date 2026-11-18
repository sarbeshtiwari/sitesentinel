import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { SDK_MANIFEST } from "@wim/sdk";
import { userWithOrg, verifiedUser, inviteAndAccept } from "../helpers/harness.js";
import { addWebsite, heartbeat, sdkCollect, serve, startWebsiteHarness, uniqueDomain, verifiedWebsite, type WebsiteHarness } from "../helpers/websites.js";

let h: WebsiteHarness;
beforeAll(async () => { h = await startWebsiteHarness(); });
afterAll(async () => { await h.stopAll(); });

const detail = async (c: { get: (u: string) => Promise<{ body: any }> }, orgId: string, id: string) => (await c.get(`/api/v1/orgs/${orgId}/websites/${id}`)).body.data;

describe("SDK delivery and remote configuration", () => {
  it("serves the versioned SDK with integrity metadata and caching", async () => {
    const r = await h.ingest.inject({ method: "GET", url: `/sdk/monitor.v1.js` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("javascript");
    expect(r.headers["x-sdk-version"]).toBe(SDK_MANIFEST.version);
    expect(r.body).toContain(`v${SDK_MANIFEST.version}`);
    const exact = await h.ingest.inject({ method: "GET", url: `/sdk/monitor.${SDK_MANIFEST.version}.js` });
    expect(exact.headers["cache-control"]).toContain("immutable");
    expect((await h.ingest.inject({ method: "GET", url: "/sdk/../../package.json" })).statusCode).toBe(404);
  });

  it("returns configuration only for verified websites with a live key, and never secrets", async () => {
    const o = await userWithOrg(h.app, "cfg");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("cfg"));
    const off = JSON.parse((await h.ingest.inject({ method: "GET", url: `/v1/config/${w.install.siteKey}` })).body);
    expect(off).toEqual({ v: 1, enabled: false, heartbeat: false }); // not verified yet
    const v = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("cfg2"));
    const on = JSON.parse((await h.ingest.inject({ method: "GET", url: `/v1/config/${v.install.siteKey}` })).body);
    expect(on).toMatchObject({ v: 1, enabled: true, heartbeat: true, captureErrors: true, captureApiFailures: false });
    expect(JSON.stringify(on)).not.toMatch(/org|website|secret|token/i);
    const bogus = JSON.parse((await h.ingest.inject({ method: "GET", url: `/v1/config/pk_${randomBytes(24).toString("base64url")}` })).body);
    expect(bogus.enabled).toBe(false);
  });
});

describe("installation verification via heartbeats", () => {
  it("NOT_INSTALLED → DETECTED → ACTIVE only for heartbeats from the registered origin", async () => {
    const o = await userWithOrg(h.app, "hb");
    const d = uniqueDomain("hb");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    expect((await detail(o.client, o.orgId, w.id)).installation).toBe("NOT_INSTALLED");
    // Script fetched but no heartbeat: still not installed.
    await h.ingest.inject({ method: "GET", url: "/sdk/monitor.v1.js", headers: { referer: `https://${d}/` } });
    await h.ingest.inject({ method: "GET", url: `/v1/config/${w.install.siteKey}`, headers: { origin: `https://${d}` } });
    expect((await detail(o.client, o.orgId, w.id)).installation).toBe("NOT_INSTALLED");
    expect(await sdkCollect(h, heartbeat(w.install.siteKey), `https://www.${d}`)).toBe(204);
    let det = await detail(o.client, o.orgId, w.id);
    expect(det.installation).toBe("DETECTED");
    expect(det.install).toMatchObject({ sdkVersion: "1.0.0", pageLoads: 1 });
    expect(det.install.lastSeenAt).not.toBeNull();
    await sdkCollect(h, heartbeat(w.install.siteKey), `https://${d}`);
    det = await detail(o.client, o.orgId, w.id);
    expect(det.installation).toBe("ACTIVE");
  });

  it("replayed heartbeats (same page load) are counted once", async () => {
    const o = await userWithOrg(h.app, "replay");
    const d = uniqueDomain("replay");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    const body = heartbeat(w.install.siteKey, "replayedpageload01");
    for (let i = 0; i < 5; i++) await sdkCollect(h, body, `https://${d}`);
    expect((await detail(o.client, o.orgId, w.id)).install.pageLoads).toBe(1);
  });

  it("SDK spoofing: foreign origins are recorded as INVALID_CONFIGURATION and never count", async () => {
    const o = await userWithOrg(h.app, "spoof");
    const d = uniqueDomain("spoof");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    for (const origin of ["https://evil-copycat.co.in", `https://${d}.evil.co.in`, "null", ""]) {
      expect(await sdkCollect(h, heartbeat(w.install.siteKey), origin)).toBe(204); // same response, no oracle
    }
    const det = await detail(o.client, o.orgId, w.id);
    expect(det.installation).toBe("INVALID_CONFIGURATION");
    // the last spoofing request had no Origin at all: recorded separately (bot / tool), still never counted
    expect(det.install).toMatchObject({ pageLoads: 0, lastSeenAt: null, lastInvalidReason: "ORIGIN_MISSING" });
    // A subdomain is a different website identity.
    const sub = await sdkCollect(h, heartbeat(w.install.siteKey), `https://shop.${d}`);
    expect(sub).toBe(204);
    expect((await detail(o.client, o.orgId, w.id)).install.pageLoads).toBe(0);
  });

  it("unverified websites cannot become installed", async () => {
    const o = await userWithOrg(h.app, "unver");
    const d = uniqueDomain("unver");
    const w = await addWebsite(o.client, o.orgId, d);
    await sdkCollect(h, heartbeat(w.install.siteKey), `https://${d}`);
    const det = await detail(o.client, o.orgId, w.id);
    expect(det.install).toMatchObject({ pageLoads: 0, lastInvalidReason: "WEBSITE_NOT_VERIFIED" });
  });

  it("invalid site keys and malformed payloads get the same 204 and change nothing", async () => {
    const statuses = await Promise.all([
      sdkCollect(h, heartbeat(`pk_${randomBytes(24).toString("base64url")}`), "https://anything.co.in"),
      sdkCollect(h, heartbeat("sk_live_not_a_site_key"), "https://anything.co.in"),
      sdkCollect(h, { garbage: true }, "https://anything.co.in"),
    ]);
    expect(statuses).toEqual([204, 204, 204]);
    const r = await h.ingest.inject({ method: "POST", url: "/v1/collect", headers: { "content-type": "text/plain" }, payload: "x".repeat(70 * 1024) });
    expect(r.statusCode).toBe(413);
  });

  it("becomes INACTIVE when heartbeats stop", async () => {
    const o = await userWithOrg(h.app, "inactive");
    const d = uniqueDomain("inactive");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    await sdkCollect(h, heartbeat(w.install.siteKey), `https://${d}`);
    await sdkCollect(h, heartbeat(w.install.siteKey), `https://${d}`);
    await h.owner.query("UPDATE site_installations SET last_seen_at = now() - interval '25 hours' WHERE website_id = $1", [w.id]);
    expect((await detail(o.client, o.orgId, w.id)).installation).toBe("INACTIVE");
  });

  it("the server-side installation check finds the script tag and the matching key", async () => {
    const o = await userWithOrg(h.app, "check");
    const d = uniqueDomain("check");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    h.site.route(d, "/", { body: `<html><head><script src="http://localhost:4200/sdk/monitor.v1.js" data-site-key="${w.install.siteKey}" async></script></head><body></body></html>` });
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/installation/check`);
    expect(r.status).toBe(202);
    const result = await h.waitJob(r.body.data.jobId);
    expect(result).toMatchObject({ status: "CHECKED", pageReachable: true, scriptTagFound: true, siteKeyMatches: true });
    // The check is diagnostic: without a heartbeat the state is still NOT_INSTALLED.
    const det = await detail(o.client, o.orgId, w.id);
    expect(det.installation).toBe("NOT_INSTALLED");
    expect(det.install.lastCheck).toMatchObject({ scriptTagFound: true, siteKeyMatches: true });
    h.site.route(d, "/", { body: `<html><head><script src="http://localhost:4200/sdk/monitor.v1.js" data-site-key="pk_${"x".repeat(32)}"></script></head></html>` });
    const r2 = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/installation/check`);
    expect(await h.waitJob(r2.body.data.jobId)).toMatchObject({ scriptTagFound: true, siteKeyMatches: false });
  });
});

describe("telemetry", () => {
  it("stores sanitised events only, drops replays, and honours pause/resume", async () => {
    const o = await userWithOrg(h.app, "events");
    const d = uniqueDomain("events");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    const events = [
      { type: "JS_ERROR", seq: 0, path: "/account/jane@example.com/orders/123456789?token=abc", data: { message: "Failed for jane@example.com card 4111 1111 1111 1111 token eyJhbGciOiJIUzI1NiJ9xxxxxxxx", stack: "Error at x", password: "hunter2", formValue: "secret" } },
      { type: "KEYLOGGER", seq: 1, data: { keys: "secret" } },
      { type: "VITALS", seq: 2, data: { lcp: 1234.5, cls: 0.05 } },
    ];
    await sdkCollect(h, heartbeat(w.install.siteKey, "eventspageload01", events), `https://${d}`);
    await sdkCollect(h, heartbeat(w.install.siteKey, "eventspageload01", events), `https://${d}`); // replay
    const { rows } = await h.owner.query("SELECT type, page_path, payload FROM sdk_events WHERE website_id = $1 ORDER BY type", [w.id]);
    expect(rows.map((r) => r.type)).toEqual(["JS_ERROR", "VITALS"]);
    const err = rows[0];
    expect(err.page_path).toBe("/account/[email]/orders/[n]");
    expect(JSON.stringify(err.payload)).not.toMatch(/jane@|4111|hunter2|secret|eyJhbGci/);
    expect(Object.keys(err.payload).sort()).toEqual(["message", "stack"]);

    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/telemetry/pause`)).body.data.install.telemetryPaused).toBe(true);
    await new Promise((r) => setTimeout(r, 15_500)); // ingest lookup cache TTL
    await sdkCollect(h, heartbeat(w.install.siteKey, "pausedpageload001", [{ type: "JS_ERROR", seq: 0, data: { message: "while paused" } }]), `https://${d}`);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM sdk_events WHERE website_id = $1", [w.id])).rows[0].n).toBe(2);
    // Heartbeats continue while paused, so installation status stays accurate.
    expect((await detail(o.client, o.orgId, w.id)).install.pageLoads).toBe(2);
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/telemetry/resume`)).body.data.install.telemetryPaused).toBe(false);
  }, 60_000);
});

describe("site key lifecycle", () => {
  it("regenerate: old key keeps working only during the grace period; revoke: stops immediately", async () => {
    const o = await userWithOrg(h.app, "keys");
    const d = uniqueDomain("keys");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    const oldKey = w.install.siteKey;
    const regen = (await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/site-key/regenerate`)).body.data;
    expect(regen.install.siteKey).not.toBe(oldKey);
    expect(regen.install.previousKeyValidUntil).not.toBeNull();
    await new Promise((r) => setTimeout(r, 15_500));
    await sdkCollect(h, heartbeat(oldKey), `https://${d}`);
    expect((await detail(o.client, o.orgId, w.id)).install.pageLoads).toBe(1); // grace
    await h.owner.query("UPDATE site_installations SET previous_key_expires_at = now() - interval '1 second' WHERE website_id = $1", [w.id]);
    await new Promise((r) => setTimeout(r, 15_500));
    await sdkCollect(h, heartbeat(oldKey), `https://${d}`);
    let det = await detail(o.client, o.orgId, w.id);
    expect(det.install).toMatchObject({ pageLoads: 1, lastInvalidReason: "EXPIRED_KEY" });

    const rev = (await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/site-key/revoke`)).body.data;
    expect(rev.install).toMatchObject({ revoked: true, siteKey: null, snippet: null });
    await new Promise((r) => setTimeout(r, 15_500));
    await sdkCollect(h, heartbeat(regen.install.siteKey), `https://${d}`);
    det = await detail(o.client, o.orgId, w.id);
    expect(det.install.lastInvalidReason).toBe("REVOKED_KEY");
    expect(JSON.parse((await h.ingest.inject({ method: "GET", url: `/v1/config/${regen.install.siteKey}` })).body).enabled).toBe(false);
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/audit`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["website.site_key_regenerated", "website.site_key_revoked"]));
  }, 90_000);

  it("SDK configuration is validated (no unknown capture options)", async () => {
    const o = await userWithOrg(h.app, "sdkcfg");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("sdkcfg"));
    expect((await o.client.patch(`/api/v1/orgs/${o.orgId}/websites/${w.id}/sdk-config`, { captureFormValues: true })).status).toBe(400);
    expect((await o.client.patch(`/api/v1/orgs/${o.orgId}/websites/${w.id}/sdk-config`, { errorSampleRate: 2 })).status).toBe(400);
    const ok = await o.client.patch(`/api/v1/orgs/${o.orgId}/websites/${w.id}/sdk-config`, { requireConsent: true, maskPatterns: ["^/orders/\\d+"] });
    expect(ok.body.data.install.sdkConfig).toMatchObject({ requireConsent: true, maskPatterns: ["^/orders/\\d+"] });
  });
});

describe("website management", () => {
  it("edits details with an audited diff and lists websites with status columns", async () => {
    const o = await userWithOrg(h.app, "edit");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("edit"));
    const r = await o.client.patch(`/api/v1/orgs/${o.orgId}/websites/${w.id}`, { name: "Renamed", category: "SAAS", monitoringTimezone: "Europe/London", description: null });
    expect(r.body.data).toMatchObject({ name: "Renamed", category: "SAAS", monitoringTimezone: "Europe/London" });
    expect((await o.client.patch(`/api/v1/orgs/${o.orgId}/websites/${w.id}`, { monitoringTimezone: "Mars/Olympus" })).status).toBe(400);
    const list = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites`)).body.data;
    expect(list[0]).toMatchObject({ id: w.id, name: "Renamed", verification: "PENDING", installation: "NOT_INSTALLED" });
    expect(Object.keys(list[0])).toEqual(expect.arrayContaining(["displayHost", "createdAt", "lastActivityAt", "trialOutcome"]));
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/audit`)).body.data;
    expect(audit[0]).toMatchObject({ action: "website.updated", changes: { name: { to: "Renamed" } } });
  });

  it("deletion requires the typed domain and website:delete; it releases the claim but keeps history", async () => {
    const o = await userWithOrg(h.app, "del");
    const member = await verifiedUser(h.app, "delmember");
    await inviteAndAccept(o.client, o.orgId, member, "MEMBER");
    const d = uniqueDomain("del");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    expect((await member.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/delete`, { confirmHost: d })).status).toBe(403);
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/delete`, { confirmHost: "wrong.co.in" })).status).toBe(409);
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/delete`, { confirmHost: d })).status).toBe(204);
    expect((await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).status).toBe(404);
    const { rows } = await h.owner.query("SELECT c.status, c.release_reason, w.status AS ws, si.revoked_at FROM websites w JOIN domain_claims c ON c.id = w.domain_claim_id JOIN site_installations si ON si.website_id = w.id WHERE w.id = $1", [w.id]);
    expect(rows[0]).toMatchObject({ status: "RELEASED", release_reason: "WEBSITE_DELETED", ws: "ARCHIVED" });
    expect(rows[0].revoked_at).not.toBeNull();
    // The domain can be registered again (claim released) by anyone.
    const other = await userWithOrg(h.app, "delother");
    expect((await other.client.post(`/api/v1/orgs/${other.orgId}/websites`, { name: "x", url: d })).status).toBe(201);
  });

  it("viewers can read websites but not change them", async () => {
    const o = await userWithOrg(h.app, "viewerweb");
    const viewer = await verifiedUser(h.app, "webviewer");
    await inviteAndAccept(o.client, o.orgId, viewer, "VIEWER");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("viewer"));
    expect((await viewer.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).status).toBe(200);
    for (const [m, path, body] of [
      ["POST", `/websites`, { name: "x", url: uniqueDomain("v") }], ["PATCH", `/websites/${w.id}`, { name: "x" }],
      ["POST", `/websites/${w.id}/verify`, {}], ["POST", `/websites/${w.id}/site-key/revoke`, {}], ["POST", `/websites/${w.id}/telemetry/pause`, {}],
    ] as const) {
      expect((await viewer.client.request(m, `/api/v1/orgs/${o.orgId}${path}`, body)).status, path).toBe(403);
    }
  });

  it("cross-tenant: another org's website ids are 404 on every website route", async () => {
    const a = await userWithOrg(h.app, "xA");
    const b = await userWithOrg(h.app, "xB");
    const w = await addWebsite(a.client, a.orgId, uniqueDomain("xa"));
    const paths: Array<[string, string, unknown]> = [
      ["GET", `/websites/${w.id}`, undefined], ["PATCH", `/websites/${w.id}`, { name: "x" }], ["POST", `/websites/${w.id}/verify`, {}],
      ["POST", `/websites/${w.id}/delete`, { confirmHost: "x" }], ["POST", `/websites/${w.id}/site-key/regenerate`, {}],
      ["POST", `/websites/${w.id}/site-key/revoke`, {}], ["GET", `/websites/${w.id}/verifications`, undefined],
      ["GET", `/websites/${w.id}/audit`, undefined], ["POST", `/websites/${w.id}/telemetry/pause`, {}],
      ["PATCH", `/websites/${w.id}/sdk-config`, { requireConsent: true }], ["POST", `/websites/${w.id}/verification/token`, {}],
      ["GET", `/websites/${w.id}/registration-history`, undefined],
    ];
    for (const [m, p, body] of paths) {
      const r = await b.client.request(m, `/api/v1/orgs/${b.orgId}${p}`, body);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await b.client.get(`/api/v1/orgs/${b.orgId}/websites`)).body.data.map((x: { id: string }) => x.id)).not.toContain(w.id);
    expect((await a.client.get(`/api/v1/orgs/${a.orgId}/websites/${w.id}`)).body.data.install.siteKey).toBe(w.install.siteKey);
  });
});
