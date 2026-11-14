import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userWithOrg } from "../helpers/harness.js";
import { addWebsite, serve, startWebsiteHarness, uniqueDomain, verifiedWebsite, verifyNow, type WebsiteHarness } from "../helpers/websites.js";

let h: WebsiteHarness;
beforeAll(async () => { h = await startWebsiteHarness(); });
afterAll(async () => { await h.stopAll(); });

describe("website registration", () => {
  it("normalizes the URL, creates a pending claim with a 72 h window, a site key and an audit entry", async () => {
    const o = await userWithOrg(h.app, "reg");
    const d = uniqueDomain("shop");
    const pre = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/preview`, { url: `HTTPS://WWW.${d.toUpperCase()}/catalog/?ref=1` });
    expect(pre.body.data).toMatchObject({ identityKey: d, host: `www.${d}`, availability: "AVAILABLE", isRoot: true });
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "Shop", url: `HTTPS://WWW.${d.toUpperCase()}/catalog/?ref=1`, description: "Main store", category: "ECOMMERCE", monitoringTimezone: "Asia/Kolkata" });
    expect(r.status).toBe(201);
    const w = r.body.data;
    expect(w).toMatchObject({ hostKey: d, status: "PENDING_VERIFICATION", verification: "PENDING", installation: "NOT_INSTALLED", category: "ECOMMERCE", monitoringTimezone: "Asia/Kolkata", description: "Main store" });
    const hours = (new Date(w.claim.pendingExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    expect(w.instructions.dns.hostRecord.name).toBe(`_sitesentinel-verification.${d}`);
    expect(w.instructions.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.install.siteKey).toMatch(/^pk_[A-Za-z0-9_-]{32}$/);
    expect(w.install.snippet).toContain(`data-site-key="${w.install.siteKey}"`);
    expect(w.install.snippet).toContain("/sdk/monitor.v1.js");
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/audit`)).body.data;
    expect(audit[0]).toMatchObject({ action: "website.created" });
  });

  it("rejects invalid, internal and IP addresses with INVALID_URL", async () => {
    const o = await userWithOrg(h.app, "invalid");
    for (const url of ["http://127.0.0.1", "http://169.254.169.254/latest", "localhost", "http://intranet", "ftp://x.co.in", "https://x.co.in:8443", "co.in"]) {
      const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "x", url });
      expect(r.status, url).toBe(400);
      expect(r.body.error.code, url).toBe("INVALID_URL");
    }
  });

  it("accepts internationalized domains and stores punycode", async () => {
    const o = await userWithOrg(h.app, "idn");
    const label = `bücher${Math.random().toString(36).slice(2, 7)}`;
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "IDN", url: `https://${label}.de` });
    expect(r.status).toBe(201);
    expect(r.body.data.hostKey).toMatch(/^xn--/);
    expect(r.body.data.displayHost).toBe(`${label}.de`);
  });

  it("rejects duplicates: same org (CONFLICT), other org (DOMAIN_ALREADY_REGISTERED, no owner details), www/scheme variants", async () => {
    const a = await userWithOrg(h.app, "dupA");
    const b = await userWithOrg(h.app, "dupB");
    const d = uniqueDomain("dupe");
    await addWebsite(a.client, a.orgId, `https://${d}`);
    const own = await a.client.post(`/api/v1/orgs/${a.orgId}/websites`, { name: "again", url: `http://www.${d}/` });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe("CONFLICT");
    for (const url of [d, `https://www.${d}`, `http://${d.toUpperCase()}/path`]) {
      const r = await b.client.post(`/api/v1/orgs/${b.orgId}/websites`, { name: "steal", url });
      expect(r.status, url).toBe(409);
      expect(r.body.error.code).toBe("DOMAIN_ALREADY_REGISTERED");
      expect(JSON.stringify(r.body)).not.toContain(a.orgId);
      expect(JSON.stringify(r.body)).not.toContain(a.email);
    }
    const pre = await b.client.post(`/api/v1/orgs/${b.orgId}/websites/preview`, { url: d });
    expect(pre.body.data.availability).toBe("PENDING_ELSEWHERE");
    const { rows } = await h.owner.query("SELECT outcome FROM domain_registration_attempts WHERE input_host = $1 ORDER BY created_at", [d]);
    expect(rows.map((r) => r.outcome)).toEqual(["ACCEPTED", "DUPLICATE_OWN", "DUPLICATE", "DUPLICATE", "DUPLICATE"]);
  });

  it("is race-safe: 6 organizations registering the same domain concurrently → exactly one wins", async () => {
    const orgs = await Promise.all(Array.from({ length: 6 }, (_, i) => userWithOrg(h.app, `race${i}`)));
    const d = uniqueDomain("race");
    const results = await Promise.all(orgs.map((o) => o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "race", url: d })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === "DOMAIN_ALREADY_REGISTERED")).toHaveLength(5);
    const live = await h.owner.query("SELECT count(*)::int AS n FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id WHERE r.identity_key = $1 AND c.status IN ('PENDING','VERIFIED','LAPSED')", [d]);
    expect(live.rows[0].n).toBe(1);
  });

  it("limits how many unverified websites an org may hold", async () => {
    const o = await userWithOrg(h.app, "pendinglimit");
    await h.owner.query("UPDATE platform_settings SET value = '2' WHERE key = 'websites.maxPendingPerOrg'");
    h.app.get((await import("../../src/settings/settings.service.js")).SettingsService).invalidate();
    try {
      await addWebsite(o.client, o.orgId, uniqueDomain("p1"));
      await addWebsite(o.client, o.orgId, uniqueDomain("p2"));
      const third = await o.client.post(`/api/v1/orgs/${o.orgId}/websites`, { name: "3", url: uniqueDomain("p3") });
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe("WEBSITE_LIMIT");
    } finally {
      await h.owner.query("UPDATE platform_settings SET value = '10' WHERE key = 'websites.maxPendingPerOrg'");
      h.app.get((await import("../../src/settings/settings.service.js")).SettingsService).invalidate();
    }
  });
});

describe("ownership verification", () => {
  it("DNS TXT: verifies, activates a 30-day trial, records history and audit", async () => {
    const o = await userWithOrg(h.app, "dns");
    const d = uniqueDomain("dns");
    const w = await verifiedWebsite(h, o.client, o.orgId, d);
    expect(w.verification).toMatchObject({ status: "VERIFIED", method: "DNS_TXT", scope: "ROOT", trialOutcome: "ACTIVATED" });
    const det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det).toMatchObject({ status: "ACTIVE", verification: "VERIFIED", trialOutcome: "ACTIVATED", instructions: null });
    const trialDays = (new Date(det.orgTrial.endsAt).getTime() - new Date(det.orgTrial.startsAt).getTime()) / 86_400_000;
    expect(Math.round(trialDays)).toBe(30);
    const ledger = await h.owner.query("SELECT trial_consumed_at, first_verified_at FROM domain_trial_ledger WHERE registrable_domain = $1", [d]);
    expect(ledger.rows[0].trial_consumed_at).not.toBeNull();
    const hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0]).toMatchObject({ method: "DNS_TXT", status: "SUCCEEDED", scopeGranted: "ROOT" });
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/audit`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["website.verified", "trial.activated", "website.verification_requested"]));
  });

  it("HTML file: requires the exact value as a line at /.well-known/…; HTML echoes and 404 bodies don't count", async () => {
    const o = await userWithOrg(h.app, "file");
    const d = uniqueDomain("file");
    serve(h, d);
    const w = await addWebsite(o.client, o.orgId, d);
    const path = new URL(w.instructions.file.url).pathname;
    h.site.route(d, path, { status: 404, body: `not found: ${w.instructions.value}` });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE")).result).toMatchObject({ status: "FAILED" });
    h.site.route(d, path, { body: `<p>${w.instructions.value}</p>`, type: "text/html" });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE")).result).toMatchObject({ status: "FAILED" });
    h.site.route(d, path, { body: w.instructions.value.slice(0, -1), type: "text/plain" });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE")).result).toMatchObject({ status: "FAILED" });
    h.site.route(d, path, { body: `# verification\n${w.instructions.value}\n`, type: "text/plain" });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE")).result).toMatchObject({ status: "VERIFIED", method: "WELL_KNOWN_FILE", scope: "HOST" });
    const hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist.filter((v: { status: string }) => v.status === "FAILED").map((v: { failureReason: string }) => v.failureReason))
      .toEqual(expect.arrayContaining(["HTTP_404", "TOKEN_NOT_FOUND_IN_FILE"]));
  });

  it("HTML meta tag: must be in <head> with the exact token", async () => {
    const o = await userWithOrg(h.app, "meta");
    const d = uniqueDomain("meta");
    serve(h, d);
    const w = await addWebsite(o.client, o.orgId, d);
    h.site.route(d, "/", { body: `<html><head></head><body>${w.instructions.meta.tag}</body></html>` });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "HTML_META")).result).toMatchObject({ status: "FAILED" });
    h.site.route(d, "/", { body: `<html><head><meta name="sitesentinel-verification" content="wrong-token"></head></html>` });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "HTML_META")).result).toMatchObject({ status: "FAILED" });
    h.site.route(d, "/", { body: `<!doctype html><html><head><title>x</title>${w.instructions.meta.tag}</head><body></body></html>` });
    expect((await verifyNow(h, o.client, o.orgId, w.id, "HTML_META")).result).toMatchObject({ status: "VERIFIED", method: "HTML_META" });
  });

  it("a site that simply responds 200 is never verified", async () => {
    const o = await userWithOrg(h.app, "noproof");
    const d = uniqueDomain("noproof");
    serve(h, d);
    h.site.route(d, "*", { body: "ok" });
    h.site.route(d, "/.well-known/sitesentinel-verification.txt", { body: "ok", type: "text/plain" });
    const w = await addWebsite(o.client, o.orgId, d);
    const v = await verifyNow(h, o.client, o.orgId, w.id, "ANY");
    expect(v.result).toMatchObject({ status: "FAILED" });
    const det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
    expect(det.status).toBe("PENDING_VERIFICATION");
  });

  it("regenerating the token invalidates the old proof", async () => {
    const o = await userWithOrg(h.app, "regen");
    const d = uniqueDomain("regen");
    serve(h, d);
    const w = await addWebsite(o.client, o.orgId, d);
    h.dns.setTxt(w.instructions.dns.hostRecord.name, [w.instructions.value]);
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verification/token`);
    expect(r.body.data.instructions.token).not.toBe(w.instructions.token);
    const v = await verifyNow(h, o.client, o.orgId, w.id, "DNS_TXT");
    expect(v.result).toMatchObject({ status: "FAILED" }); // old TXT value no longer accepted
    h.dns.setTxt(w.instructions.dns.hostRecord.name, [r.body.data.instructions.value]);
    expect((await verifyNow(h, o.client, o.orgId, w.id, "DNS_TXT")).result).toMatchObject({ status: "VERIFIED" });
  });

  it("expired claims cannot be verified, free the domain for others, and can be restarted only while free", async () => {
    const a = await userWithOrg(h.app, "expA");
    const b = await userWithOrg(h.app, "expB");
    const d = uniqueDomain("exp");
    serve(h, d);
    const w = await addWebsite(a.client, a.orgId, d);
    h.dns.setTxt(w.instructions.dns.hostRecord.name, [w.instructions.value]);
    await h.owner.query("UPDATE domain_claims SET pending_expires_at = now() - interval '1 minute' WHERE verification_token = $1", [w.instructions.token]);
    const v = await a.client.post(`/api/v1/orgs/${a.orgId}/websites/${w.id}/verify`, { method: "DNS_TXT" });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe("VERIFICATION_EXPIRED");
    expect((await a.client.get(`/api/v1/orgs/${a.orgId}/websites/${w.id}`)).body.data.verification).toBe("EXPIRED");
    // Another org may now register it.
    expect((await b.client.post(`/api/v1/orgs/${b.orgId}/websites`, { name: "mine now", url: d })).status).toBe(201);
    const restart = await a.client.post(`/api/v1/orgs/${a.orgId}/websites/${w.id}/verification/restart`);
    expect(restart.body.error.code).toBe("DOMAIN_ALREADY_REGISTERED");
    const { rows } = await h.owner.query("SELECT status FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id WHERE r.identity_key = $1 ORDER BY c.created_at", [d]);
    expect(rows.map((r) => r.status)).toEqual(["EXPIRED", "PENDING"]);
  });

  it("restart issues a fresh token and window when the domain is still free", async () => {
    const o = await userWithOrg(h.app, "restart");
    const d = uniqueDomain("restart");
    const w = await addWebsite(o.client, o.orgId, d);
    await h.owner.query("UPDATE domain_claims SET pending_expires_at = now() - interval '1 minute' WHERE verification_token = $1", [w.instructions.token]);
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verification/restart`);
    expect(r.status).toBe(200);
    expect(r.body.data.verification).toBe("PENDING");
    expect(r.body.data.instructions.token).not.toBe(w.instructions.token);
  });

  it("limits verification attempts (brute force / abuse of the checker)", async () => {
    const o = await userWithOrg(h.app, "brute");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("brute"));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verify`, { method: "DNS_TXT" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("per-token attempt budget forces regeneration", async () => {
    const o = await userWithOrg(h.app, "budget");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("budget"));
    await h.owner.query("UPDATE domain_claims SET verification_attempts = 50 WHERE verification_token = $1", [w.instructions.token]);
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verify`, { method: "DNS_TXT" });
    expect(r.body.error.code).toBe("TOKEN_EXHAUSTED");
    await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verification/token`);
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verify`, { method: "DNS_TXT" })).status).toBe(202);
  });

  it("ROOT_EXCLUSIVE: a DNS-verified root reserves subdomains; the owner's subdomains inherit verification", async () => {
    const a = await userWithOrg(h.app, "rootA");
    const b = await userWithOrg(h.app, "rootB");
    const d = uniqueDomain("root");
    await verifiedWebsite(h, a.client, a.orgId, d);
    const stolen = await b.client.post(`/api/v1/orgs/${b.orgId}/websites`, { name: "sub", url: `shop.${d}` });
    expect(stolen.body.error.code).toBe("DOMAIN_ALREADY_REGISTERED");
    const own = await a.client.post(`/api/v1/orgs/${a.orgId}/websites`, { name: "blog", url: `blog.${d}` });
    expect(own.status).toBe(201);
    expect(own.body.data).toMatchObject({ status: "ACTIVE", verification: "VERIFIED", claim: { inherited: true } });
  });
});

describe("trial eligibility and abuse prevention", () => {
  it("a second verified domain of a trialing org is covered and marked as trialed", async () => {
    const o = await userWithOrg(h.app, "second");
    await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("first"));
    const d2 = uniqueDomain("second");
    const w2 = await verifiedWebsite(h, o.client, o.orgId, d2);
    expect(w2.verification.trialOutcome).toBe("COVERED_BY_ACTIVE_TRIAL");
    const ledger = await h.owner.query("SELECT trial_consumed_at FROM domain_trial_ledger WHERE registrable_domain = $1", [d2]);
    expect(ledger.rows[0].trial_consumed_at).not.toBeNull();
  });

  it("deleting the website and re-adding the domain from a brand-new account never grants a new trial", async () => {
    const a = await userWithOrg(h.app, "abuseA");
    const d = uniqueDomain("abuse");
    const w = await verifiedWebsite(h, a.client, a.orgId, d);
    expect(w.verification.trialOutcome).toBe("ACTIVATED");
    expect((await a.client.post(`/api/v1/orgs/${a.orgId}/websites/${w.id}/delete`, { confirmHost: d })).status).toBe(204);
    // Hard-delete the whole organization (what the Phase 10 purge does).
    await h.owner.query("DELETE FROM organizations WHERE id = $1", [a.orgId]);
    const b = await userWithOrg(h.app, "abuseB");
    const again = await verifiedWebsite(h, b.client, b.orgId, d);
    expect(again.verification.trialOutcome).toBe("DOMAIN_PREVIOUSLY_TRIALED");
    expect((await h.owner.query("SELECT count(*)::int AS n FROM trials WHERE org_id = $1", [b.orgId])).rows[0].n).toBe(0);
    const ledger = await h.owner.query("SELECT trial_count, registration_count FROM domain_trial_ledger WHERE registrable_domain = $1", [d]);
    expect(ledger.rows[0]).toMatchObject({ trial_count: 1, registration_count: 2 });
  });

  it("deleting the org releases its claims but keeps the ledger (trigger)", async () => {
    const a = await userWithOrg(h.app, "orgdel");
    const d = uniqueDomain("orgdel");
    await verifiedWebsite(h, a.client, a.orgId, d);
    await h.owner.query("DELETE FROM organizations WHERE id = $1", [a.orgId]);
    const { rows } = await h.owner.query("SELECT c.status, c.org_id, c.release_reason FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id WHERE r.identity_key = $1", [d]);
    expect(rows[0]).toMatchObject({ status: "RELEASED", org_id: null, release_reason: "ORG_DELETED" });
    expect((await h.owner.query("SELECT trial_consumed_at FROM domain_trial_ledger WHERE registrable_domain = $1", [d])).rows[0].trial_consumed_at).not.toBeNull();
  });

  it("is race-safe: two websites of one org verifying at the same moment create exactly one trial", async () => {
    const o = await userWithOrg(h.app, "trialrace");
    const sites = await Promise.all([uniqueDomain("tr1"), uniqueDomain("tr2"), uniqueDomain("tr3")].map(async (d) => {
      serve(h, d);
      const w = await addWebsite(o.client, o.orgId, d);
      h.dns.setTxt(w.instructions.dns.hostRecord.name, [w.instructions.value]);
      return w;
    }));
    const results = await Promise.all(sites.map((w) => verifyNow(h, o.client, o.orgId, w.id, "DNS_TXT")));
    const outcomes = results.map((r) => r.result?.trialOutcome).sort();
    expect(outcomes).toEqual(["ACTIVATED", "COVERED_BY_ACTIVE_TRIAL", "COVERED_BY_ACTIVE_TRIAL"]);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM trials WHERE org_id = $1", [o.orgId])).rows[0].n).toBe(1);
  });

  it("honours trial settings (duration, disabled)", async () => {
    await h.owner.query("UPDATE platform_settings SET value = '14' WHERE key = 'trial.days'");
    try {
      const o = await userWithOrg(h.app, "trial14");
      const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("t14"));
      const det = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}`)).body.data;
      expect(Math.round((new Date(det.orgTrial.endsAt).getTime() - new Date(det.orgTrial.startsAt).getTime()) / 86_400_000)).toBe(14);
    } finally {
      await h.owner.query("UPDATE platform_settings SET value = '30' WHERE key = 'trial.days'");
    }
    await h.owner.query("UPDATE platform_settings SET value = 'false' WHERE key = 'trial.enabled'");
    try {
      const o = await userWithOrg(h.app, "notrial");
      const w = await verifiedWebsite(h, o.client, o.orgId, uniqueDomain("nt"));
      expect(w.verification.trialOutcome).toBe("TRIALS_DISABLED");
    } finally {
      await h.owner.query("UPDATE platform_settings SET value = 'true' WHERE key = 'trial.enabled'");
    }
  });
});

describe("SSRF and DNS rebinding during verification", () => {
  it("a domain resolving to the cloud metadata address is never contacted", async () => {
    const o = await userWithOrg(h.app, "ssrf");
    const d = uniqueDomain("ssrf");
    h.dns.setA(d, ["169.254.169.254"]);
    const w = await addWebsite(o.client, o.orgId, d);
    const before = h.site.hits.length;
    const v = await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE");
    expect(v.result).toMatchObject({ status: "FAILED" });
    const hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0].failureReason).toBe("BLOCKED_DESTINATION");
    expect(h.site.hits.length).toBe(before);
  });

  it("private-network answers (including mixed answers) are refused", async () => {
    const o = await userWithOrg(h.app, "ssrf2");
    const d = uniqueDomain("ssrf2");
    h.dns.setA(d, ["127.0.0.1", "10.0.0.8"]);
    const w = await addWebsite(o.client, o.orgId, d);
    await verifyNow(h, o.client, o.orgId, w.id, "HTML_META");
    const hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0].failureReason).toBe("BLOCKED_DESTINATION");
  });

  it("redirects off the website (or to internal targets) are refused; rebinding answers can't be reached", async () => {
    const o = await userWithOrg(h.app, "ssrf3");
    const d = uniqueDomain("ssrf3");
    serve(h, d);
    const w = await addWebsite(o.client, o.orgId, d);
    h.site.route(d, "/.well-known/sitesentinel-verification.txt", { status: 302, body: "", headers: { location: "http://attacker-controlled.co.in/token.txt" } });
    h.dns.setA("attacker-controlled.co.in", ["127.0.0.1"]);
    h.site.route("attacker-controlled.co.in", "/token.txt", { body: w.instructions.value, type: "text/plain" });
    await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE");
    let hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0].failureReason).toBe("REDIRECTS_OFF_SITE");
    expect(h.site.hits.some((x) => x.host === "attacker-controlled.co.in")).toBe(false);
    // Same-identity redirect whose second resolution flips to the metadata IP.
    let n = 0;
    h.dns.setA(`www.${d}`, () => (n++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]));
    h.site.route(d, "/.well-known/sitesentinel-verification.txt", { status: 301, body: "", headers: { location: `http://www.${d}/.well-known/sitesentinel-verification.txt` } });
    h.site.route(`www.${d}`, "/.well-known/sitesentinel-verification.txt", { status: 302, body: "", headers: { location: `http://www.${d}/x` } });
    await verifyNow(h, o.client, o.orgId, w.id, "WELL_KNOWN_FILE");
    hist = (await o.client.get(`/api/v1/orgs/${o.orgId}/websites/${w.id}/verifications`)).body.data;
    expect(hist[0].failureReason).toBe("BLOCKED_DESTINATION");
    expect(h.site.hits.filter((x) => x.host === `www.${d}` && x.path === "/x")).toHaveLength(0);
  });
});

describe("database-level protection of verification state", () => {
  it("the API role cannot mark claims verified, change website status or touch the ledger", async () => {
    const o = await userWithOrg(h.app, "dbguard");
    const w = await addWebsite(o.client, o.orgId, uniqueDomain("dbguard"));
    const pg = (await import("pg")).default;
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT app_enter_org($1, $2, NULL)", [o.orgId, o.userId]);
      await expect(app.query("UPDATE domain_claims SET status = 'VERIFIED' WHERE org_id = $1", [o.orgId])).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT app_enter_org($1, $2, NULL)", [o.orgId, o.userId]);
      await expect(app.query("UPDATE websites SET status = 'ACTIVE' WHERE id = $1", [w.id])).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await expect(app.query("UPDATE domain_trial_ledger SET trial_consumed_at = NULL")).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT app_enter_org($1, $2, NULL)", [o.orgId, o.userId]);
      await expect(app.query("INSERT INTO trials (org_id, registrable_domain, status, starts_at, ends_at) VALUES ($1, 'x.co.in', 'ACTIVE', now(), now() + interval '1 year')", [o.orgId])).rejects.toThrow(/permission denied/);
      await app.query("ROLLBACK");
      // Inserting a website on someone else's claim is impossible: status comes from the claim (trigger) and RLS hides the claim.
      await app.query("BEGIN");
      await app.query("SELECT app_enter_org($1, $2, NULL)", [o.orgId, o.userId]);
      const r = await app.query("INSERT INTO websites (org_id, domain_claim_id, name, canonical_origin, status, updated_at) SELECT $1, id, 'x', 'https://x', 'ACTIVE', now() FROM domain_claims WHERE org_id = $1 LIMIT 1 RETURNING status", [o.orgId]).catch((e) => e);
      expect(String(r.message ?? r.rows?.[0]?.status)).toMatch(/duplicate key|PENDING_VERIFICATION/);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });
});
