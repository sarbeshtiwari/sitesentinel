import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHttpEngine } from "@wim/worker-http";
import { createLogger } from "@wim/logger";
import { httpProbe, signCapability } from "@wim/netguard";
import { resetMonitoringSettings, seedOrg, sleep, until } from "../helpers/monitoring.js";
import {
  addVerifiedSite, EGRESS_SECRET_4C, incidentsOf, nextWindow, PREFIX_4C, results, settle, startHttpEnv, type HttpEnv,
} from "../helpers/http-monitoring.js";

/**
 * Phase 4C — HTTP availability engine against real PostgreSQL, Redis, the egress gateway,
 * fixture DNS and the controlled fault website (HTTP + HTTPS with a test CA).
 */
let env: HttpEnv;
let parked: string[] = [];
const orgs: string[] = [];
let tag = "";

beforeAll(async () => {
  env = await startHttpEnv();
  // The scheduler is platform-wide: park tenants left active by other suites (restored afterwards).
  parked = (await env.owner.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await settle(env);
  await env.startWorker();
});
afterEach(async () => {
  await settle(env);
});
afterAll(async () => {
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await env.owner.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(env.owner);
  for (const q of Object.values(env.queues)) await q.obliterate({ force: true });
  await env.close();
});

async function newOrg() {
  // Only the current test's tenant is scheduled (the scheduler is platform-wide).
  await env.owner.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await env.owner.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  const o = await seedOrg(env.owner, 0, { tag: "http4c" });
  orgs.push(o.orgId);
  tag = randomBytes(3).toString("hex");
  return o.orgId;
}

/** Register a verified website on a fixture host and point fixture DNS at the fault site. */
async function site(orgId: string, name: string, path: string, opts: { https?: boolean; check?: Record<string, unknown>; a?: string[]; cert?: "ok" | "expired" | "self" | "wrong" | "expiring"; aaaa?: string[] } = {}) {
  const host = `${name}-${tag}.fixture.example`;
  if (opts.a !== undefined || opts.aaaa !== undefined) {
    if (opts.a?.length) env.dns.setA(host, opts.a);
    if (opts.aaaa?.length) env.dns.zone.aaaa.set(host, opts.aaaa);
  } else env.dns.setA(host, ["127.0.0.1"]);
  if (opts.https) {
    const day = 86_400_000;
    if (opts.cert === "expired") env.site.issueCert(host, { notBefore: new Date(Date.now() - 100 * day), notAfter: new Date(Date.now() - day) });
    else if (opts.cert === "self") env.site.issueCert(host, { selfSigned: true });
    else if (opts.cert === "wrong") env.site.certFor(host, `other-${tag}.fixture.example`);
    else if (opts.cert === "expiring") env.site.issueCert(host, { notAfter: new Date(Date.now() + 10 * day + 3_600_000) });
    else env.site.issueCert(host);
  }
  const id = await addVerifiedSite(env.owner, orgId, `${opts.https ? "https" : "http"}://${host}`, { path, ...(opts.check ?? {}) });
  return { id, host };
}

/** One scheduling window: create executions for due HTTP schedules and wait for each website's result. */
async function windowFor(websiteIds: string[], first = false) {
  if (!first) await nextWindow(env.owner, websiteIds);
  const before = new Map<string, number>();
  for (const w of websiteIds) before.set(w, (await results(env.owner, w)).length);
  await env.scheduler().runCycle();
  await until(async () => {
    for (const w of websiteIds) if ((await results(env.owner, w)).length <= before.get(w)!) return false;
    return true;
  }, 45_000, 150);
  return Promise.all(websiteIds.map(async (w) => (await results(env.owner, w)).at(-1)!));
}

// =====================================================================================================
describe("measurements and evaluation against the controlled fault site", () => {
  it("evaluates healthy, redirect, auth, client/server error, timeout, DNS and content scenarios", async () => {
    const org = await newOrg();
    const s = {
      healthy: await site(org, "healthy", "/healthy"),
      s204: await site(org, "nocontent", "/204"),
      r301: await site(org, "moved", "/301"),
      r302: await site(org, "found", "/302"),
      loop: await site(org, "loop", "/loop-a"),
      chain: await site(org, "chain", "/chain/8", { check: { maxRedirects: 3 } }),
      s401: await site(org, "auth401", "/401"),
      s403: await site(org, "auth403", "/403"),
      s404: await site(org, "missing", "/404"),
      s500: await site(org, "error500", "/500"),
      s503: await site(org, "error503", "/503"),
      slow: await site(org, "slow", "/slow?ms=1500", { check: { timeoutMs: 8000 } }),
      hang: await site(org, "hang", "/hang", { check: { timeoutMs: 2000 } }),
      nxdomain: await site(org, "nxdomain", "/healthy", { a: [] }),
      servfail: await site(org, "servfail", "/healthy", { a: [] }),
      content: await site(org, "content", "/content", { check: { contentMarker: "SITE-OK" } }),
      ctype: await site(org, "ctype", "/healthy", { check: { expectedContentType: "application/json" } }),
      json: await site(org, "json", "/json", { check: { expectedContentType: "application/json" } }),
      large: await site(org, "large", "/large?mb=8", { check: { timeoutMs: 15_000 } }),
      head: await site(org, "headless", "/head-unsupported", { check: { method: "HEAD" } }),
      gzip: await site(org, "gzip", "/gzip", { check: { contentMarker: "SITE-OK" } }),
      cookie: await site(org, "cookie", "/set-cookie"),
      custom404: await site(org, "custom", "/404", { check: { expectedStatus: ["200-299", "404"] } }),
    };
    env.dns.servfail.add(s.servfail.host);
    const ids = Object.values(s).map((x) => x.id);
    const out = Object.fromEntries((await windowFor(ids, true)).map((r) => [r.website_id, r]));
    const r = (k: keyof typeof s) => out[s[k].id]!;

    expect(r("healthy")).toMatchObject({ status: "PASSED", available: true, http_status: 200, method: "GET", failure_kind: null });
    expect(r("healthy").content_type).toMatch(/text\/html/);
    expect(r("healthy").response_headers).toMatchObject({ "cache-control": "no-store", server: "fault-site" });
    expect(r("healthy").total_ms).toBeGreaterThanOrEqual(0);
    expect(r("healthy").ttfb_ms).not.toBeNull();
    expect(r("healthy").dns_ms).not.toBeNull(); // measured by the gateway
    expect(r("healthy").connect_ms).not.toBeNull(); // measured by the gateway
    expect(r("healthy").tls_ms).toBeNull(); // plain HTTP: no handshake, not fabricated
    expect(r("healthy").resolved_ip).toBe("127.0.0.1");
    expect(r("s204")).toMatchObject({ status: "PASSED", http_status: 204 });
    expect(r("r301")).toMatchObject({ status: "PASSED", http_status: 200, final_url: `http://${s.r301.host}/healthy` });
    expect(r("r301").redirect_chain).toEqual([{ url: `http://${s.r301.host}/301`, status: 301 }]);
    expect(r("r302").final_url).toBe(`http://${s.r302.host}/healthy?[redacted]`); // query values never stored
    expect(JSON.stringify(r("r302"))).not.toContain("secret-session-value");
    expect(r("loop")).toMatchObject({ status: "FAILED", failure_kind: "REDIRECT_LOOP", available: true, failure_category: "TARGET_PERMANENT" });
    expect(r("chain")).toMatchObject({ status: "FAILED", failure_kind: "TOO_MANY_REDIRECTS" });
    // 401/403: the site deliberately requires authentication — up, and not an outage by default.
    expect(r("s401")).toMatchObject({ status: "PASSED", available: true, http_status: 401 });
    expect(r("s403")).toMatchObject({ status: "PASSED", available: true, http_status: 403 });
    // 404: unexpected status, but the server is up — not downtime.
    expect(r("s404")).toMatchObject({ status: "FAILED", failure_kind: "HTTP_404", available: true, failure_category: "TARGET_PERMANENT" });
    expect(r("custom404")).toMatchObject({ status: "PASSED", http_status: 404 });
    expect(r("s500")).toMatchObject({ status: "FAILED", failure_kind: "HTTP_500", available: false, failure_category: "TARGET_TEMPORARY" });
    expect(r("s503")).toMatchObject({ status: "FAILED", failure_kind: "HTTP_503", available: false });
    expect(r("s503").response_headers).toMatchObject({ "retry-after": "30" });
    expect(r("slow")).toMatchObject({ status: "PASSED" });
    expect(r("slow").ttfb_ms).toBeGreaterThanOrEqual(1400);
    expect(r("hang")).toMatchObject({ status: "FAILED", failure_kind: "RESPONSE_TIMEOUT", available: false });
    expect(r("hang").total_ms).toBeLessThan(4000);
    expect(r("nxdomain")).toMatchObject({ status: "FAILED", failure_kind: "NO_ADDRESSES", available: false });
    expect(r("servfail")).toMatchObject({ status: "FAILED", failure_kind: "DNS_FAILURE", available: false });
    expect(r("content")).toMatchObject({ status: "FAILED", failure_kind: "CONTENT_MISMATCH", available: true });
    expect(r("ctype")).toMatchObject({ status: "FAILED", failure_kind: "CONTENT_TYPE_MISMATCH" });
    expect(r("json")).toMatchObject({ status: "PASSED", content_type: "application/json" });
    // Large response: bounded read (truncated), not a failure; wire bytes capped.
    expect(r("large")).toMatchObject({ status: "PASSED" });
    expect(r("large").details.truncated).toBe(true);
    expect(r("large").bytes).toBeLessThanOrEqual(4 * 1_048_576 + 65_536);
    // HEAD unsupported: falls back to GET.
    expect(r("head")).toMatchObject({ status: "PASSED", method: "GET", http_status: 200 });
    expect(r("head").details.headFallback).toBe(true);
    expect(r("gzip")).toMatchObject({ status: "PASSED" }); // decoded before the content check
    // Cookies are neither stored nor sent back.
    expect(r("cookie").response_headers).not.toHaveProperty("set-cookie");
    expect(JSON.stringify(r("cookie"))).not.toContain("fixture-session-cookie-value");
    const sent = env.site.hits.filter((h) => h.host.endsWith(`${tag}.fixture.example`));
    expect(sent.length).toBeGreaterThan(20);
    for (const h of sent) {
      expect(h.headers.cookie).toBeUndefined();
      expect(h.headers.authorization).toBeUndefined();
      expect(h.headers["proxy-authorization"]).toBeUndefined(); // the gateway credential never reaches the site
      expect(h.method === "GET" || h.method === "HEAD").toBe(true);
    }
  }, 120_000);

  it("collects TLS facts and detects invalid, expired, self-signed, wrong-host and expiring certificates", async () => {
    const org = await newOrg();
    const s = {
      ok: await site(org, "tls-ok", "/healthy", { https: true }),
      expired: await site(org, "tls-expired", "/healthy", { https: true, cert: "expired" }),
      self: await site(org, "tls-self", "/healthy", { https: true, cert: "self" }),
      wrong: await site(org, "tls-wrong", "/healthy", { https: true, cert: "wrong" }),
      expiring: await site(org, "tls-expiring", "/healthy", { https: true, cert: "expiring" }),
    };
    const out = Object.fromEntries((await windowFor(Object.values(s).map((x) => x.id), true)).map((r) => [r.website_id, r]));
    const ok = out[s.ok.id]!;
    expect(ok).toMatchObject({ status: "PASSED", ssl_valid: true, ssl_issuer: "WIM Test CA" });
    expect(ok.tls_ms).not.toBeNull();
    expect(ok.details.tls).toMatchObject({ authorized: true, hostnameMatch: true, protocol: expect.stringMatching(/TLSv1\.[23]/) });
    expect(ok.details.tls.daysRemaining).toBeGreaterThanOrEqual(88);
    expect(out[s.expired.id]).toMatchObject({ status: "FAILED", failure_kind: "TLS_INVALID", available: false, ssl_valid: false });
    expect(out[s.expired.id]!.details.tls.error).toBe("CERT_HAS_EXPIRED");
    expect(out[s.expired.id]!.http_status).toBeNull(); // no request is sent over an untrusted connection
    expect(out[s.self.id]!.details.tls.error).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(out[s.wrong.id]!.details.tls).toMatchObject({ error: "ERR_TLS_CERT_ALTNAME_INVALID", hostnameMatch: false });
    const exp = out[s.expiring.id]!;
    expect(exp).toMatchObject({ status: "PASSED", ssl_valid: true });
    expect(exp.details.verdicts.ssl_expiry).toBe("FAIL");
    expect(exp.details.tls.daysRemaining).toBe(10);
    // Certificate incidents open on the first observation (TLS failures use the configured threshold).
    const sslInc = await incidentsOf(env.owner, s.expiring.id);
    expect(sslInc).toHaveLength(1);
    expect(sslInc[0]).toMatchObject({ category: "SSL", check_key: "http.ssl_expiry", severity: "LOW", status: "OPEN" });
    const outbox = await env.owner.query(`SELECT topic, payload FROM outbox_events WHERE org_id = $1 AND topic = 'ssl.expiring'`, [org]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({ threshold: 14, daysRemaining: 10 });
    // The next window does not repeat the notice.
    await windowFor([s.expiring.id]);
    expect((await env.owner.query(`SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1 AND topic = 'ssl.expiring'`, [org])).rows[0].n).toBe(1);
  }, 90_000);
});

// =====================================================================================================
describe("SSRF protections hold for monitoring targets and redirects", () => {
  it("refuses private, IPv6, mapped, metadata and mixed answers, IP literals and redirects to internal targets", async () => {
    const org = await newOrg();
    env.dns.setA(`internal-${tag}.fixture.example`, ["10.0.0.5"]);
    const s = {
      private4: await site(org, "priv4", "/healthy", { a: ["10.1.2.3"] }),
      mixed: await site(org, "mixed", "/healthy", { a: ["127.0.0.1", "10.0.0.1"] }),
      v6loop: await site(org, "v6loop", "/healthy", { a: [], aaaa: ["::1"] }),
      v6ula: await site(org, "v6ula", "/healthy", { a: [], aaaa: ["fd00:ec2::254"] }),
      mapped: await site(org, "mapped", "/healthy", { a: [], aaaa: ["::ffff:127.0.0.1"] }),
      metadata: await site(org, "metadata", "/healthy", { a: ["169.254.169.254"] }),
      redirInternal: await site(org, "redir-int", `/redirect?to=${encodeURIComponent(`http://internal-${tag}.fixture.example/`)}`),
      redirIp: await site(org, "redir-ip", `/redirect?to=${encodeURIComponent("http://10.0.0.1/")}`),
      redirMapped: await site(org, "redir-mapped", `/redirect?to=${encodeURIComponent("http://[::ffff:127.0.0.1]/")}`),
      redirMeta: await site(org, "redir-meta", `/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`),
      redirPort: await site(org, "redir-port", `/redirect?to=${encodeURIComponent(`http://healthy-${tag}.fixture.example:6379/`)}`),
      redirFile: await site(org, "redir-file", `/redirect?to=${encodeURIComponent("file:///etc/passwd")}`),
    };
    // A website whose stored origin is an IP literal (cannot be registered; forged DB state).
    const ipSite = await addVerifiedSite(env.owner, org, "http://127.0.0.1");
    const ids = [...Object.values(s).map((x) => x.id), ipSite];
    const out = Object.fromEntries((await windowFor(ids, true)).map((r) => [r.website_id, r]));
    const kind = (k: keyof typeof s) => out[s[k].id]!.failure_kind;
    for (const k of ["private4", "mixed", "v6loop", "v6ula", "mapped", "metadata", "redirInternal"] as const) expect(kind(k), k).toBe("BLOCKED_ADDRESS");
    for (const k of ["redirIp", "redirMapped", "redirMeta"] as const) expect(kind(k), k).toBe("BLOCKED_HOST");
    expect(kind("redirPort")).toBe("BLOCKED_PORT");
    expect(kind("redirFile")).toBe("INVALID_REDIRECT");
    expect(out[ipSite]).toMatchObject({ failure_kind: "BLOCKED_HOST", failure_category: "INVALID_CONFIGURATION", available: null });
    for (const id of ids) {
      const r = out[id]!;
      expect(r.available === null || r.failure_kind === "INVALID_REDIRECT").toBe(true); // blocked targets never count as downtime
      expect(r.resolved_ip === null || r.resolved_ip === "127.0.0.1").toBe(true);
    }
    // The fault site never saw a request for an internal destination.
    expect(env.site.hits.some((h) => h.host.startsWith("internal-") || h.host.includes("169.254"))).toBe(false);
    // Blocked destinations open a "monitoring blocked by security policy" incident for the customer (first observation).
    const inc = await incidentsOf(env.owner, s.private4.id);
    expect(inc[0]).toMatchObject({ category: "SYSTEM", check_key: "http.config", status: "OPEN" });
  }, 90_000);

  it("DNS rebinding: each hop is resolved once by the gateway and the pinned address is the validated one", async () => {
    const org = await newOrg();
    let n = 0;
    const s = await site(org, "rebind", "/301", { a: [] });
    env.dns.setA(s.host, () => (n++ % 2 === 0 ? ["127.0.0.1"] : ["10.9.9.9"]));
    const ids = [s.id];
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const [r] = await windowFor(ids, i === 0);
      seen.push(r!.failure_kind ?? `PASS:${r!.resolved_ip}`);
      expect(r!.resolved_ip === null || r!.resolved_ip === "127.0.0.1").toBe(true);
    }
    expect(seen.some((x) => x === "BLOCKED_ADDRESS")).toBe(true);
  }, 90_000);

  it("gateway credentials: expired, forged and host-bound tokens are refused; a token for one host can't reach another", async () => {
    const org = await newOrg();
    const a = await site(org, "tok-a", "/healthy");
    const b = await site(org, "tok-b", "/healthy");
    const probe = (url: string, token: (h: string) => string) => httpProbe({ url, timeoutMs: 5000, maxRedirects: 0, maxBodyBytes: 1024, gateway: { url: env.gatewayUrl, token } });
    const good = (h: string) => signCapability(EGRESS_SECRET_4C, { o: org, w: a.id, e: "t", k: "http", h }, 60);
    expect((await probe(`http://${a.host}/healthy`, good)).final?.status).toBe(200);
    // bound to host A, used for host B
    expect((await probe(`http://${b.host}/healthy`, () => good(a.host))).error).toBe("EGRESS_UNAUTHORIZED");
    // forged (wrong secret)
    expect((await probe(`http://${a.host}/healthy`, (h) => signCapability("not-the-gateway-secret-0123456789abcdef", { o: org, w: a.id, e: "t", k: "http", h }, 60))).error).toBe("EGRESS_UNAUTHORIZED");
    // expired
    const expired = (() => {
      const body = Buffer.from(JSON.stringify({ o: org, w: a.id, e: "t", k: "http", h: a.host, x: Math.floor(Date.now() / 1000) - 5 })).toString("base64url");
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      return `${body}.${createHmac("sha256", EGRESS_SECRET_4C).update(body).digest("base64url")}`;
    })();
    expect((await probe(`http://${a.host}/healthy`, () => expired)).error).toBe("EGRESS_UNAUTHORIZED");
    // tampered claims (switch org/website/host) invalidate the signature
    const [p, sig] = good(a.host).split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const tampered = `${Buffer.from(JSON.stringify({ ...claims, h: b.host, o: "00000000-0000-4000-8000-000000000000" })).toString("base64url")}.${sig}`;
    expect((await probe(`http://${b.host}/healthy`, () => tampered)).error).toBe("EGRESS_UNAUTHORIZED");
  });

  it("a worker whose gateway credential is rejected records an inconclusive result, dead-letters, and never retries", async () => {
    const org = await newOrg();
    const s = await site(org, "badcred", "/healthy");
    await env.stopWorkers();
    const { Redis } = await import("ioredis");
    const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const { createExecutionWorker } = await import("@wim/queue");
    const w = createExecutionWorker({
      db: env.db, connection: conn, prefix: PREFIX_4C, tier: "HTTP", log: createLogger("x", { level: "silent" }), workerId: "bad-cred",
      lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
      handler: createHttpEngine({ db: env.db, redis: conn, prefix: PREFIX_4C, log: createLogger("x", { level: "silent" }), gatewayUrl: env.gatewayUrl, tokenSecret: "a-wrong-but-long-enough-secret-0123456789" }),
    });
    await w.start();
    let r: Record<string, any> | undefined;
    try {
      [r] = await windowFor([s.id], true);
    } finally {
      await w.stop();
      conn.disconnect();
      await env.startWorker();
    }
    expect(r).toMatchObject({ status: "INCONCLUSIVE", failure_kind: "EGRESS_UNAUTHORIZED", failure_category: "SECURITY_REJECTION", available: null });
    const ex = await until(async () => {
      const { rows } = await env.owner.query(`SELECT status::text, attempt, failure_category FROM monitoring_executions WHERE website_id = $1`, [s.id]);
      return rows[0]?.status === "DEAD_LETTERED" ? rows[0] : null;
    });
    expect(ex).toMatchObject({ attempt: 1, failure_category: "SECURITY" });
    expect(await incidentsOf(env.owner, s.id)).toHaveLength(0);
  });
});

// =====================================================================================================
describe("infrastructure failures are not customer outages", () => {
  it("gateway unavailable: retried, then recorded INCONCLUSIVE, excluded from uptime, no incident, visible to operators", async () => {
    const org = await newOrg();
    const s = await site(org, "gw-down", "/healthy");
    await env.stopWorkers();
    await env.startWorker({ gatewayUrl: "http://127.0.0.1:9" });
    const before = Number((await env.owner.query(`SELECT count(*) FROM system_health_logs WHERE component = 'http-monitoring' AND metric = 'infra_failure'`)).rows[0].count);
    try {
      for (let i = 0; i < 3; i++) await windowFor([s.id], i === 0);
    } finally {
      await env.stopWorkers();
      await env.startWorker();
    }
    const rs = await results(env.owner, s.id);
    expect(rs.map((r) => [r.status, r.failure_kind, r.failure_category, r.available])).toEqual(Array(3).fill(["INCONCLUSIVE", "GATEWAY_UNAVAILABLE", "GATEWAY_INFRASTRUCTURE", null]));
    expect(rs.every((r) => r.attempt === 3)).toBe(true); // the same execution, retried — not three separate website failures
    expect(await incidentsOf(env.owner, s.id)).toHaveLength(0);
    const after = Number((await env.owner.query(`SELECT count(*) FROM system_health_logs WHERE component = 'http-monitoring' AND metric = 'infra_failure'`)).rows[0].count);
    expect(after - before).toBe(9);
    const sched = await env.owner.query(`SELECT state FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [s.id]);
    expect(sched.rows[0].state.inconclusiveStreak).toBe(3);
  }, 90_000);

  it("resolver outage: a DNS failure is classified as infrastructure when the canary fails too, and as the customer's when it doesn't", async () => {
    const org = await newOrg();
    const target = await site(org, "dns-target", "/healthy", { a: [] });
    env.dns.servfail.add(target.host);
    const canaryHost = `canary-${tag}.fixture.example`;
    env.dns.servfail.add(canaryHost); // our resolver can't resolve anything
    await settle(env, { "monitoring.http.canaryUrl": `http://${canaryHost}/healthy`, "queue.http-monitoring": { concurrency: 20, globalConcurrency: 200, ratePerSecond: 1000, attempts: 1, backoffBaseMs: 200, backoffMaxMs: 1000, timeoutMs: 20_000, keepCompletedHours: 1, keepFailedDays: 1 } });
    await sleep(300);
    const [r1] = await windowFor([target.id], true);
    expect(r1).toMatchObject({ status: "INCONCLUSIVE", failure_kind: "INFRA_DNS_FAILURE", failure_category: "GATEWAY_INFRASTRUCTURE", available: null });
    env.dns.servfail.delete(canaryHost);
    env.dns.setA(canaryHost, ["127.0.0.1"]);
    await sleep(15_500); // canary cache
    const [r2] = await windowFor([target.id]);
    expect(r2).toMatchObject({ status: "FAILED", failure_kind: "DNS_FAILURE", failure_category: "TARGET_TEMPORARY", available: false });
  }, 90_000);
});

// =====================================================================================================
describe("incident lifecycle", () => {
  it("opens after the failure threshold, groups repeats, resolves after recovery, reopens, and emits each event once", async () => {
    const org = await newOrg();
    const s = await site(org, "toggle", "/toggle");
    const ids = [s.id];
    const set = (v: "up" | "down") => env.site.toggles.set(s.host, v);
    set("up");
    await windowFor(ids, true);
    set("down");
    await windowFor(ids);
    expect(await incidentsOf(env.owner, s.id)).toHaveLength(0); // one failure (threshold 2): no incident
    await windowFor(ids);
    let inc = await incidentsOf(env.owner, s.id);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ category: "AVAILABILITY", severity: "CRITICAL", status: "OPEN", occurrence_count: 2, check_key: "http.down", fingerprint: `http.down:${s.id}` });
    await windowFor(ids);
    await windowFor(ids);
    inc = await incidentsOf(env.owner, s.id);
    expect(inc).toHaveLength(1);
    expect(inc[0].occurrence_count).toBe(4);
    set("up");
    await windowFor(ids);
    expect((await incidentsOf(env.owner, s.id))[0].status).toBe("OPEN"); // recovery threshold 2
    await windowFor(ids);
    inc = await incidentsOf(env.owner, s.id);
    expect(inc[0]).toMatchObject({ status: "RESOLVED", auto_resolved: true });
    expect(inc[0].resolved_at.getTime()).toBeGreaterThan(inc[0].first_detected_at.getTime());
    await windowFor(ids); // further passes: no further events
    const events = (await env.owner.query(`SELECT type::text, data FROM incident_events WHERE incident_id = $1 ORDER BY created_at`, [inc[0].id])).rows;
    expect(events.map((e) => e.type)).toEqual(["CREATED", "AUTO_RESOLVED"]);
    expect(events[1].data.durationSec).toBeGreaterThanOrEqual(0);
    const occ = (await env.owner.query(`SELECT count(*)::int AS n FROM incident_occurrences WHERE incident_id = $1`, [inc[0].id])).rows[0].n;
    expect(occ).toBe(3); // the opening occurrence + 2 repeats (occurrence_count includes the first failure of the streak)
    // Fails again: the same incident reopens (reopen window), no duplicate.
    set("down");
    await windowFor(ids);
    await windowFor(ids);
    inc = await incidentsOf(env.owner, s.id);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ status: "REOPENED", reopen_count: 1 });
    set("up");
    await windowFor(ids);
    await windowFor(ids);
    const ob = (await env.owner.query(`SELECT topic, dedupe_key FROM outbox_events WHERE org_id = $1 ORDER BY id`, [org])).rows;
    expect(ob.map((o) => o.topic)).toEqual(["incident.opened", "incident.resolved", "incident.opened", "incident.resolved"]);
    // Uptime/history: every result persisted, availability verdicts consistent.
    const rs = await results(env.owner, s.id);
    expect(rs.filter((r) => r.available === false)).toHaveLength(6);
    expect(rs.filter((r) => r.available === true)).toHaveLength(6);
  }, 150_000);

  it("an isolated transient failure does not open an incident; different failure kinds group per category", async () => {
    const org = await newOrg();
    const s = await site(org, "blip", "/toggle");
    env.site.toggles.set(s.host, "up");
    await windowFor([s.id], true);
    env.site.toggles.set(s.host, "down");
    await windowFor([s.id]);
    env.site.toggles.set(s.host, "up");
    await windowFor([s.id]);
    expect(await incidentsOf(env.owner, s.id)).toHaveLength(0);
    // 500 then a timeout: both "website unavailable" → one incident with both kinds recorded.
    await env.owner.query(`UPDATE monitoring_configurations SET http_check = http_check || '{"timeoutMs": 2000}'::jsonb WHERE website_id = $1`, [s.id]);
    env.site.toggles.set(s.host, "down");
    await windowFor([s.id]);
    env.site.toggles.set(s.host, "slow");
    await windowFor([s.id]);
    const inc = await incidentsOf(env.owner, s.id);
    expect(inc).toHaveLength(1);
    expect(inc[0].diagnostics.kinds).toEqual({ HTTP_500: 1, RESPONSE_TIMEOUT: 1 });
    env.site.toggles.set(s.host, "up");
  }, 90_000);

  it("per-website thresholds from configuration and incident rules are honoured", async () => {
    const org = await newOrg();
    const s = await site(org, "thresh", "/toggle", { check: { failureThreshold: 1, recoveryThreshold: 1 } });
    env.site.toggles.set(s.host, "down");
    await windowFor([s.id], true);
    expect((await incidentsOf(env.owner, s.id))[0]?.status).toBe("OPEN");
    env.site.toggles.set(s.host, "up");
    await windowFor([s.id]);
    expect((await incidentsOf(env.owner, s.id))[0]?.status).toBe("RESOLVED");
    // An org incident rule (threshold 3) applies when the website config doesn't set one.
    const r = await site(org, "rule", "/toggle");
    await env.owner.query(`INSERT INTO incident_rules (org_id, category, failure_threshold, severity, recovery_passes, updated_at) VALUES ($1, 'AVAILABILITY', 3, 'CRITICAL', 1, now())`, [org]);
    env.site.toggles.set(r.host, "down");
    await windowFor([r.id], true);
    await windowFor([r.id]);
    expect(await incidentsOf(env.owner, r.id)).toHaveLength(0);
    await windowFor([r.id]);
    expect(await incidentsOf(env.owner, r.id)).toHaveLength(1);
    env.site.toggles.set(r.host, "up");
  }, 90_000);
});

// =====================================================================================================
describe("scheduling of HTTP checks", () => {
  it("a stored HTTP configuration never changes the interval: 60 s default unless the customer asks for slower", async () => {
    const org = await newOrg();
    const a = await site(org, "interval", "/healthy", { check: { contentMarker: "SITE-OK" } });
    await env.scheduler().runCycle();
    const iv = async (id: string) => (await env.owner.query(`SELECT interval_sec FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [id])).rows[0].interval_sec;
    expect(await iv(a.id)).toBe(60);
    const { rows } = await env.owner.query(`SELECT t1_interval_sec FROM monitoring_configurations WHERE website_id = $1`, [a.id]);
    expect(rows[0].t1_interval_sec).toBeNull();
    await env.owner.query(`UPDATE monitoring_configurations SET t1_interval_sec = 300 WHERE website_id = $1`, [a.id]);
    await env.scheduler().runCycle();
    expect(await iv(a.id)).toBe(300);
  });
});

// =====================================================================================================
describe("idempotency under re-execution and crashes", () => {
  it("processing the same execution twice creates one result, one counter step, no extra incident or event", async () => {
    const org = await newOrg();
    const s = await site(org, "twice", "/500", { check: { failureThreshold: 1 } });
    const [r] = await windowFor([s.id], true);
    const ctxBase = { executionId: r!.execution_id, orgId: org, websiteId: s.id, tier: "HTTP" as const, attempt: 1, maxAttempts: 3, windowStart: r!.checked_at };
    const engine = createHttpEngine({ db: env.db, redis: env.redis, prefix: PREFIX_4C, log: createLogger("x", { level: "silent" }), gatewayUrl: env.gatewayUrl, tokenSecret: EGRESS_SECRET_4C });
    const snapshot = async () => ({
      results: (await results(env.owner, s.id)).length,
      incidents: (await incidentsOf(env.owner, s.id)).map((i) => [i.id, i.occurrence_count]),
      outbox: (await env.owner.query(`SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1`, [org])).rows[0].n,
      events: (await env.owner.query(`SELECT count(*)::int AS n FROM incident_events WHERE org_id = $1`, [org])).rows[0].n,
      state: (await env.owner.query(`SELECT state FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [s.id])).rows[0].state,
      usage: (await env.owner.query(`SELECT value::int FROM usage_counters WHERE org_id = $1 AND key = 'http.checks'`, [org])).rows[0]?.value,
    });
    const before = await snapshot();
    expect(before.incidents).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const out = await engine({ ...ctxBase, attempt: 2 + i, signal: new AbortController().signal });
      expect(out.summary).toMatchObject({ duplicate: true });
    }
    expect(await snapshot()).toEqual(before);
  });

  const crashTest = (at: "probe" | "persist") => async () => {
    const org = await newOrg();
    const s = await site(org, `crash-${at}`, "/500");
    await env.stopWorkers();
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "fixtures", "crash-http-worker.mjs")], {
      env: { ...process.env, TEST_PREFIX: PREFIX_4C, TEST_GATEWAY_URL: env.gatewayUrl, TEST_EGRESS_SECRET: EGRESS_SECRET_4C, TEST_CA_PEM: env.pki.caPem, CRASH_AT: at },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    await until(async () => out.includes("READY"), 20_000);
    const hitsBefore = env.site.hits.filter((h) => h.host === s.host).length;
    await env.scheduler().runCycle();
    await new Promise((res) => child.once("exit", res));
    expect(out).toContain(`CRASHING ${at}`);
    const afterCrash = await results(env.owner, s.id);
    expect(afterCrash).toHaveLength(at === "persist" ? 1 : 0);
    // A healthy worker takes over after the lease expires.
    await env.startWorker({ workerId: `rescuer-${at}` });
    const ex = await until(async () => {
      const { rows } = await env.owner.query(`SELECT status::text, attempt FROM monitoring_executions WHERE website_id = $1`, [s.id]);
      return rows[0]?.status === "SUCCEEDED" ? rows[0] : null;
    }, 45_000, 250);
    expect(ex.attempt).toBe(2);
    const rs = await results(env.owner, s.id);
    expect(rs).toHaveLength(1); // one logical result
    expect(rs[0].attempt).toBe(at === "persist" ? 1 : 2); // the committed result is never replaced
    expect(env.site.hits.filter((h) => h.host === s.host).length - hitsBefore).toBe(2); // the request ran twice
    const state = (await env.owner.query(`SELECT state FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T1_HTTP'`, [s.id])).rows[0].state;
    expect(state.classes.down.fails).toBe(1); // counted once
    expect(await incidentsOf(env.owner, s.id)).toHaveLength(0); // threshold 2 not reached by a retry
    await windowFor([s.id]);
    const inc = await incidentsOf(env.owner, s.id);
    expect(inc).toHaveLength(1);
    expect(inc[0].occurrence_count).toBe(2);
  };
  it("worker SIGKILLed after the HTTP request, before persistence", crashTest("probe"), 90_000);
  it("worker SIGKILLed after persistence, before the queue acknowledgement", crashTest("persist"), 90_000);

  it("Redis loses the queue: executions are re-enqueued from PostgreSQL; completed work is not repeated", async () => {
    const org = await newOrg();
    const s = await site(org, "redisloss", "/healthy");
    await env.stopWorkers();
    await env.scheduler().runCycle();
    const keys = await env.redis.keys(`${PREFIX_4C}:http-monitoring:*`);
    if (keys.length) await env.redis.del(...keys);
    await env.owner.query(`UPDATE monitoring_executions SET enqueued_at = now() - interval '10 seconds' WHERE website_id = $1`, [s.id]);
    await env.startWorker();
    const rep = await env.scheduler().runCycle();
    expect(rep.reconciled.reenqueued).toBeGreaterThanOrEqual(1);
    await until(async () => (await results(env.owner, s.id)).length === 1);
    // Completed: losing Redis again and reconciling repeats nothing.
    const k2 = await env.redis.keys(`${PREFIX_4C}:http-monitoring:*`);
    if (k2.length) await env.redis.del(...k2);
    await env.scheduler().runCycle();
    await sleep(1500);
    expect(await results(env.owner, s.id)).toHaveLength(1);
  }, 60_000);
});

// =====================================================================================================
describe("privacy", () => {
  it("results, logs and outbox events contain no credentials, tokens, cookies, query values or bodies", async () => {
    const org = await newOrg();
    const s = await site(org, "privacy", "/302");
    const c = await site(org, "privacy-cookie", "/set-cookie");
    await windowFor([s.id, c.id], true);
    const stored = JSON.stringify([...(await results(env.owner, s.id)), ...(await results(env.owner, c.id))]);
    for (const needle of ["secret-session-value", "fixture-session-cookie-value", "marker:SITE-OK", "Basic ", "cap:", EGRESS_SECRET_4C]) {
      expect(stored).not.toContain(needle);
      expect(env.logs.join("")).not.toContain(needle);
    }
    const outbox = JSON.stringify((await env.owner.query(`SELECT payload FROM outbox_events WHERE org_id = $1`, [org])).rows);
    expect(outbox).not.toMatch(/session|cookie|marker/);
    const cfg = (await env.owner.query(`SELECT retain FROM partitions.config WHERE parent = 'check_results'`)).rows[0].retain;
    expect(cfg.days ?? cfg).toBeTruthy();
  });
});
