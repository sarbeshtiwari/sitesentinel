import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { startDnsServer, startSiteServer, type FixtureDns, type FixtureSite } from "@wim/test-fixtures";
import { createDnsClient, createGatewayDnsClient, proxyAuthorization, safeFetch, signCapability, verifyCapability, NetguardError } from "@wim/netguard";
import { Gateway, type GatewayConfig } from "../src/index.js";

const SECRET = "test-secret-0123456789abcdef0123456789";
let dns: FixtureDns;
let site: FixtureSite;
let gw: Gateway;
let url = "";
const token = (o: string | null = "org-1") => signCapability(SECRET, { o, w: "w1", e: "exec-1", k: "probe" });

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    resolvers: [dns.server], tokenSecret: SECRET, allowedPorts: [80, 443], maxConnectionsPerOrg: 50, maxConnectionsTotal: 100,
    maxTunnelBytes: 1024 * 1024, tunnelMaxMs: 10_000, idleMs: 5000, connectTimeoutMs: 2000,
    testAllowCidrs: ["127.0.0.0/8"], testPortMap: { 80: site.port, 443: site.port }, ...over,
  };
}

/** Raw CONNECT; returns the status line. */
function rawConnect(target: string, auth?: string, gatewayUrl = url): Promise<string> {
  const u = new URL(gatewayUrl);
  return new Promise((resolve, reject) => {
    const s = connect(Number(u.port), u.hostname, () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
    });
    s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]!); s.destroy(); });
    s.once("error", reject);
  });
}

/** Plain-HTTP absolute-form request through the gateway (what Chromium does for http://). */
function rawHttp(target: string, auth?: string): Promise<{ status: number; body: string; error: string | undefined }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path: target, method: "GET", headers: auth ? { "proxy-authorization": auth } : {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, error: res.headers["x-egress-error"] as string | undefined }));
    });
    r.on("error", reject);
    r.end();
  });
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  dns = await startDnsServer();
  site = await startSiteServer();
  dns.setA("ok.example.co.in", ["127.0.0.1"]);
  site.route("ok.example.co.in", "/", { body: "hello from fixture", type: "text/plain" });
  dns.setA("meta.attacker.co.in", ["169.254.169.254"]);
  dns.setA("ten.attacker.co.in", ["10.0.0.7"]);
  dns.setA("mixed.attacker.co.in", ["127.0.0.1", "192.168.1.10"]);
  dns.zone.aaaa.set("v6loop.attacker.co.in", ["::1"]);
  dns.zone.aaaa.set("v6ula.attacker.co.in", ["fd00:ec2::254"]);
  dns.zone.aaaa.set("v6mapped.attacker.co.in", ["::ffff:7f00:1"]);
  dns.setA("cgnat.attacker.co.in", ["100.64.1.1"]);
  dns.setA("bench.attacker.co.in", ["198.18.0.1"]);
  dns.setTxt("_v.example.co.in", ["proof=abc"]);
  gw = new Gateway(cfg());
  await gw.listen(0, "127.0.0.1");
  url = `http://127.0.0.1:${(gw.server.address() as { port: number }).port}`;
});
afterAll(async () => { await gw.close(); await dns.close(); await site.close(); });

describe("capability tokens", () => {
  it("are signed, expiring and tamper-evident", () => {
    const t = token();
    expect(verifyCapability(SECRET, t)).toMatchObject({ o: "org-1", w: "w1", k: "probe" });
    expect(verifyCapability("another-secret-0123456789abcdef01234", t)).toBeNull();
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), o: "org-2" })).toString("base64url");
    expect(verifyCapability(SECRET, `${forged}.${s}`)).toBeNull();
    const expired = signCapability(SECRET, { o: null, w: null, e: "x", k: "probe" }, -10);
    expect(verifyCapability(SECRET, expired)).toBeNull();
  });
  it("the gateway refuses anonymous and badly-signed traffic", async () => {
    expect(await rawConnect("ok.example.co.in:443")).toMatch(/^HTTP\/1.1 407/);
    expect(await rawConnect("ok.example.co.in:443", proxyAuthorization("garbage.token"))).toMatch(/^HTTP\/1.1 407/);
    expect((await rawHttp("http://ok.example.co.in/")).status).toBe(407);
  });
});

describe("destination policy (independent of the caller)", () => {
  const auth = () => proxyAuthorization(token());
  it.each([
    ["IP literal", "127.0.0.1:443", 403],
    ["IPv6 literal", "[::1]:443", 403],
    ["metadata via DNS", "meta.attacker.co.in:443", 403],
    ["RFC1918 via DNS", "ten.attacker.co.in:443", 403],
    ["mixed public/private answers", "mixed.attacker.co.in:443", 403],
    ["IPv6 loopback AAAA", "v6loop.attacker.co.in:443", 403],
    ["IPv6 ULA (AWS IMDSv6) AAAA", "v6ula.attacker.co.in:443", 403],
    ["IPv4-mapped IPv6 AAAA", "v6mapped.attacker.co.in:443", 403],
    ["CGNAT", "cgnat.attacker.co.in:443", 403],
    ["benchmarking range", "bench.attacker.co.in:443", 403],
    ["internal service name", "redis:6379", 421],
    ["internal service name on 443", "redis:443", 403],
    ["SSH port", "ok.example.co.in:22", 421],
    ["Redis port", "ok.example.co.in:6379", 421],
    ["unresolvable", "nope.attacker.co.in:443", 424],
  ])("%s → %i", async (_n, target, status) => {
    expect(await rawConnect(target, auth())).toMatch(new RegExp(`^HTTP/1.1 ${status}`));
  });

  it("allows a validated destination and connects to the pinned address", async () => {
    expect(await rawConnect("ok.example.co.in:443", auth())).toMatch(/^HTTP\/1.1 200/);
    const r = await rawHttp("http://ok.example.co.in/", auth());
    expect(r).toMatchObject({ status: 200, body: "hello from fixture" });
  });

  it("plain-HTTP requests get the same checks (metadata, private, odd ports, https absolute-form)", async () => {
    expect((await rawHttp("http://meta.attacker.co.in/latest/meta-data/", auth())).error).toBe("BLOCKED_ADDRESS");
    expect((await rawHttp("http://169.254.169.254/latest/meta-data/", auth())).error).toBe("BLOCKED_HOST");
    expect((await rawHttp("http://ok.example.co.in:8080/", auth())).error).toBe("BLOCKED_PORT");
    expect((await rawHttp("https://ok.example.co.in/", auth())).status).toBe(400);
  });

  it("DNS rebinding: each connection re-resolves and re-validates; a flipped answer is refused", async () => {
    let n = 0;
    dns.setA("rebind.attacker.co.in", () => (n++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]));
    expect(await rawConnect("rebind.attacker.co.in:443", auth())).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("rebind.attacker.co.in:443", auth())).toMatch(/^HTTP\/1.1 403/);
  });

  it("limits concurrent connections per organization", async () => {
    const small = new Gateway(cfg({ maxConnectionsPerOrg: 1 }));
    await small.listen(0, "127.0.0.1");
    const surl = `http://127.0.0.1:${(small.server.address() as { port: number }).port}`;
    const u = new URL(surl);
    const held = connect(Number(u.port), "127.0.0.1");
    await new Promise<void>((r) => held.once("connect", () => r()));
    held.write(`CONNECT ok.example.co.in:443 HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`);
    await new Promise((r) => held.once("data", r));
    expect(await rawConnect("ok.example.co.in:443", auth(), surl)).toMatch(/^HTTP\/1.1 429/);
    expect(await rawConnect("ok.example.co.in:443", proxyAuthorization(token("org-2")), surl)).toMatch(/^HTTP\/1.1 200/);
    held.destroy();
    await small.close();
  });

  it("caps bytes per tunnel", async () => {
    dns.setA("big.example.co.in", ["127.0.0.1"]);
    site.route("big.example.co.in", "/", { body: "x".repeat(300_000), type: "text/plain" });
    const tiny = new Gateway(cfg({ maxTunnelBytes: 10_000 }));
    await tiny.listen(0, "127.0.0.1");
    const turl = `http://127.0.0.1:${(tiny.server.address() as { port: number }).port}`;
    const r = await safeFetch("http://big.example.co.in/", { dns: createDnsClient([]), egress: { url: turl, token: () => token() }, maxBytes: 1_000_000 }).catch((e) => e);
    const received = r instanceof Error ? 0 : r.body.length;
    expect(received).toBeLessThan(300_000);
    await tiny.close();
  });

  it("test allowances are refused outside NODE_ENV=test", () => {
    process.env.NODE_ENV = "production";
    try {
      expect(() => new Gateway(cfg())).toThrow(/only permitted when NODE_ENV=test/);
      expect(() => new Gateway(cfg({ testAllowCidrs: [], testPortMap: {} }))).not.toThrow();
    } finally {
      process.env.NODE_ENV = "test";
    }
  });
});

describe("netguard clients through the gateway", () => {
  it("safeFetch(egress) fetches allowed hosts and surfaces refusals as classified errors", async () => {
    const egress = { url, token: () => token() };
    const ok = await safeFetch("http://ok.example.co.in/", { dns: createDnsClient([]), egress });
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe("hello from fixture");
    const err = await safeFetch("http://meta.attacker.co.in/", { dns: createDnsClient([]), egress }).catch((e) => e);
    expect(err).toBeInstanceOf(NetguardError);
    expect((err as NetguardError).code).toBe("BLOCKED_ADDRESS");
    const dead = await safeFetch("http://ok.example.co.in/", { dns: createDnsClient([]), egress: { url: "http://127.0.0.1:1", token: () => token() } }).catch((e) => e);
    expect((dead as NetguardError).code).toMatch(/EGRESS_UNAVAILABLE|CONNECTION_FAILED/);
  });

  it("redirect to an internal target is re-validated by the gateway on the next hop", async () => {
    site.route("ok.example.co.in", "/to-meta", { status: 302, body: "", headers: { location: "http://meta.attacker.co.in/latest" } });
    const err = await safeFetch("http://ok.example.co.in/to-meta", { dns: createDnsClient([]), egress: { url, token: () => token() } }).catch((e) => e);
    expect((err as NetguardError).code).toBe("BLOCKED_ADDRESS");
  });

  it("DNS API returns TXT answers and refuses address lookups that resolve internally", async () => {
    const client = createGatewayDnsClient({ url, token: () => token() });
    expect((await client.txt("_v.example.co.in"))[0]!.records).toEqual(["proof=abc"]);
    expect(await client.addresses("ok.example.co.in")).toEqual(["127.0.0.1"]);
    await expect(client.addresses("meta.attacker.co.in")).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    const anon = await fetch(`${url}/v1/dns?type=TXT&name=_v.example.co.in`);
    expect(anon.status).toBe(401);
  });
});

describe("per-execution connection budget (Phase 4D)", () => {
  it("one execution can't open more connections than its budget; other executions are unaffected", async () => {
    const { Gateway } = await import("../src/index.js");
    const { startDnsServer, startSiteServer } = await import("@wim/test-fixtures");
    const { signCapability, proxyAuthorization } = await import("@wim/netguard");
    const { request } = await import("node:http");
    process.env.NODE_ENV = "test";
    const dns = await startDnsServer();
    const site = await startSiteServer();
    site.route("budget.example", "/", { body: "ok" });
    dns.setA("budget.example", ["127.0.0.1"]);
    const secret = "budget-secret-0123456789abcdef0123456789";
    const g = new Gateway({ resolvers: [dns.server], tokenSecret: secret, allowedPorts: [80, 443], maxConnectionsPerOrg: 100, maxConnectionsTotal: 100,
      maxConnectionsPerExecution: 3, maxTunnelBytes: 1e6, tunnelMaxMs: 5000, idleMs: 2000, connectTimeoutMs: 2000, testAllowCidrs: ["127.0.0.0/8"], testPortMap: { 80: site.port } });
    await g.listen(0, "127.0.0.1");
    const port = (g.server.address() as { port: number }).port;
    const get = (exec: string) => new Promise<number>((resolve) => {
      const tok = signCapability(secret, { o: "o1", w: "w1", e: exec, k: "browser" }, 60);
      const r = request({ host: "127.0.0.1", port, path: "http://budget.example/", headers: { "proxy-authorization": proxyAuthorization(tok), connection: "close" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      r.on("error", () => resolve(0));
      r.end();
    });
    const a = [];
    for (let i = 0; i < 5; i++) a.push(await get("exec-a"));
    expect(a).toEqual([200, 200, 200, 429, 429]);
    expect(await get("exec-b")).toBe(200);
    await g.close();
    await site.close();
    await dns.close();
  });
});

describe("per-execution budget per capability kind (issue #35)", () => {
  /** Raw CONNECT; returns the whole response head. */
  const connectHead = (port: number, target: string, auth: string) => new Promise<string>((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
    s.once("data", (d) => { resolve(d.toString().split("\r\n\r\n")[0]!); s.destroy(); });
    s.once("error", reject);
  });

  it("each kind of one execution has its own budget (rendering can't starve the crawl); per-kind overrides apply", async () => {
    const g = new Gateway(cfg({ maxConnectionsPerExecution: 2, maxConnectionsPerExecutionKind: { deepscan: 4 } }));
    await g.listen(0, "127.0.0.1");
    const port = (g.server.address() as { port: number }).port;
    const tok = (k: string, e = "exec-k") => proxyAuthorization(signCapability(SECRET, { o: "org-k", w: "w1", e, k }, 60));
    const status = async (k: string, e?: string) => (await connectHead(port, "ok.example.co.in:443", tok(k, e))).split("\r\n")[0]!.split(" ")[1];
    const browser = [];
    for (let i = 0; i < 3; i++) browser.push(await status("deepscan-browser"));
    expect(browser).toEqual(["200", "200", "429"]); // default budget (2) for the browser kind
    const crawl = [];
    for (let i = 0; i < 5; i++) crawl.push(await status("deepscan"));
    expect(crawl).toEqual(["200", "200", "200", "200", "429"]); // its own (overridden) budget, untouched by rendering
    expect(await status("deepscan-browser", "exec-other")).toBe("200"); // other executions unaffected
    await g.close();
  });

  it("a used-up execution budget is marked X-Egress-Refusal: EXECUTION_BUDGET (CONNECT and plain HTTP); concurrency limits are not", async () => {
    const g = new Gateway(cfg({ maxConnectionsPerExecution: 1 }));
    await g.listen(0, "127.0.0.1");
    const port = (g.server.address() as { port: number }).port;
    const auth = proxyAuthorization(signCapability(SECRET, { o: "org-r", w: "w1", e: "exec-r", k: "deepscan" }, 60));
    expect(await connectHead(port, "ok.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    const head = await connectHead(port, "ok.example.co.in:443", auth);
    expect(head).toMatch(/^HTTP\/1.1 429/);
    expect(head).toMatch(/X-Egress-Error: RATE_LIMITED/);
    expect(head).toMatch(/X-Egress-Refusal: EXECUTION_BUDGET/);
    const plain = await new Promise<{ status: number; error?: string; refusal?: string }>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "http://ok.example.co.in/", headers: { "proxy-authorization": auth, connection: "close" } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, error: res.headers["x-egress-error"] as string, refusal: res.headers["x-egress-refusal"] as string }));
      });
      r.on("error", reject);
      r.end();
    });
    expect(plain).toEqual({ status: 429, error: "RATE_LIMITED", refusal: "EXECUTION_BUDGET" });
    await g.close();

    // per-org concurrency: plain RATE_LIMITED, no budget marker
    const small = new Gateway(cfg({ maxConnectionsPerOrg: 1 }));
    await small.listen(0, "127.0.0.1");
    const sport = (small.server.address() as { port: number }).port;
    const held = connect(sport, "127.0.0.1");
    await new Promise<void>((r) => held.once("connect", () => r()));
    held.write(`CONNECT ok.example.co.in:443 HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    await new Promise((r) => held.once("data", r));
    const limited = await connectHead(sport, "ok.example.co.in:443", auth);
    expect(limited).toMatch(/^HTTP\/1.1 429/);
    expect(limited).not.toMatch(/X-Egress-Refusal/);
    held.destroy();
    await small.close();
  });

  it("httpProbe reports the refusal (gatewayRefusal) and keeps the EGRESS_RATE_LIMITED code every other caller handles", async () => {
    const { httpProbe } = await import("@wim/netguard");
    const g = new Gateway(cfg({ maxConnectionsPerExecution: 1 }));
    await g.listen(0, "127.0.0.1");
    const gurl = `http://127.0.0.1:${(g.server.address() as { port: number }).port}`;
    const probe = () => httpProbe({ url: "http://ok.example.co.in/", timeoutMs: 5000, maxRedirects: 0, maxBodyBytes: 1024,
      gateway: { url: gurl, token: (h) => signCapability(SECRET, { o: "org-p", w: "w1", e: "exec-p", k: "http", h }, 60) } });
    const first = await probe();
    expect(first.error).toBeNull();
    expect(first.gatewayRefusal).toBeNull();
    const refused = await probe();
    expect(refused.error).toBe("EGRESS_RATE_LIMITED");
    expect(refused.gatewayRefusal).toBe("EXECUTION_BUDGET");
    await g.close();
  });

  it("an upstream site can't forge the refusal marker", async () => {
    site.route("forge.example.co.in", "/", { body: "x", headers: { "x-egress-refusal": "EXECUTION_BUDGET", "x-egress-error": "RATE_LIMITED" } });
    dns.setA("forge.example.co.in", ["127.0.0.1"]);
    const u = new URL(url);
    const r = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const q = httpRequest({ host: u.hostname, port: u.port, path: "http://forge.example.co.in/", headers: { "proxy-authorization": proxyAuthorization(token()) } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ...res.headers, status: res.statusCode }));
      });
      q.on("error", reject);
      q.end();
    });
    expect(r.status).toBe(200);
    expect(r["x-egress-refusal"]).toBeUndefined();
    expect(r["x-egress-error"]).toBeUndefined();
  });

  it("env: EGRESS_MAX_CONNECTIONS_PER_EXECUTION applies per kind; the deep-scan crawl gets EGRESS_MAX_CONNECTIONS_PER_DEEPSCAN", async () => {
    const { configFromEnv } = await import("../src/index.js");
    const c = configFromEnv({ EGRESS_TOKEN_SECRET: SECRET });
    expect(c.maxConnectionsPerExecution).toBe(300);
    expect(c.maxConnectionsPerExecutionKind).toEqual({ deepscan: 2500 });
    expect(configFromEnv({ EGRESS_TOKEN_SECRET: SECRET, EGRESS_MAX_CONNECTIONS_PER_DEEPSCAN: "4000" }).maxConnectionsPerExecutionKind).toEqual({ deepscan: 4000 });
  });
});

describe("plain-HTTP timeouts (Phase 4D fix)", () => {
  it("a response slower than the connect timeout is not cut off (connect timeout ≠ response timeout)", async () => {
    const { Gateway } = await import("../src/index.js");
    const { startDnsServer, startSiteServer } = await import("@wim/test-fixtures");
    const { signCapability, proxyAuthorization } = await import("@wim/netguard");
    const { request } = await import("node:http");
    process.env.NODE_ENV = "test";
    const dns = await startDnsServer();
    const site = await startSiteServer();
    site.route("slow.example", "/", (_q, r) => { setTimeout(() => { r.writeHead(200); r.end("late"); }, 1500); });
    dns.setA("slow.example", ["127.0.0.1"]);
    const secret = "slow-secret-0123456789abcdef0123456789ab";
    const g = new Gateway({ resolvers: [dns.server], tokenSecret: secret, allowedPorts: [80], maxConnectionsPerOrg: 10, maxConnectionsTotal: 10,
      maxTunnelBytes: 1e6, tunnelMaxMs: 10_000, idleMs: 5000, connectTimeoutMs: 500, testAllowCidrs: ["127.0.0.0/8"], testPortMap: { 80: site.port } });
    await g.listen(0, "127.0.0.1");
    const status = await new Promise<number>((resolve) => {
      const r = request({ host: "127.0.0.1", port: (g.server.address() as { port: number }).port, path: "http://slow.example/",
        headers: { "proxy-authorization": proxyAuthorization(signCapability(secret, { o: "o", w: "w", e: "e", k: "http" }, 60)) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", () => resolve(0));
      r.end();
    });
    expect(status).toBe(200);
    await g.close();
    await site.close();
    await dns.close();
  });
});

describe("third-party policy in browser tokens (release readiness, blocker 5)", () => {
  const tp = (t: Record<string, unknown>, e = `tp-${Math.random()}`) => proxyAuthorization(signCapability(SECRET, { o: "org-tp", w: "w-tp", e, k: "browser", t } as never, 60));
  beforeAll(() => {
    for (const h of ["shop.example.co.in", "www.shop.example.co.in", "cdn.thirdparty.co.in", "a.tracker.co.in", "b.tracker.co.in", "c.tracker.co.in", "shop.example.co.in.evil.co.in"]) dns.setA(h, ["127.0.0.1"]);
    dns.setA("meta.shop.example.co.in", ["169.254.169.254"]);
    let n = 0;
    dns.setA("rebind.shop.example.co.in", () => (n++ === 0 ? ["127.0.0.1"] : ["10.0.0.5"]));
  });

  it("mode none: first party (any subdomain) allowed; every third-party host refused — CONNECT and plain HTTP", async () => {
    const auth = tp({ f: ["shop.example.co.in"], m: "none" });
    expect(await rawConnect("shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("www.shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("cdn.thirdparty.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
    expect((await rawHttp("http://cdn.thirdparty.co.in/x.js", auth)).error).toBe("BLOCKED_HOST");
    // suffix tricks are third parties, not first parties
    expect(await rawConnect("shop.example.co.in.evil.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
  });

  it("allowlist: only listed registrable domains (and their subdomains) besides the first party", async () => {
    const auth = tp({ f: ["shop.example.co.in"], m: "allowlist", a: ["thirdparty.co.in"] });
    expect(await rawConnect("cdn.thirdparty.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("a.tracker.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
  });

  it("mode all: distinct third-party hosts are budgeted per execution; repeats of an admitted host are not", async () => {
    const auth = tp({ f: ["shop.example.co.in"], m: "all", n: 2 });
    expect(await rawConnect("a.tracker.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("b.tracker.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("a.tracker.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("c.tracker.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
    expect(await rawConnect("shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/); // first party never budgeted
  });

  it("an allowed host never bypasses the base rules: private/metadata answers, rebinding, ports, IP literals", async () => {
    const auth = tp({ f: ["shop.example.co.in"], m: "all" });
    expect(await rawConnect("meta.shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
    expect(await rawConnect("rebind.shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 200/);
    expect(await rawConnect("rebind.shop.example.co.in:443", auth)).toMatch(/^HTTP\/1.1 403/);
    expect(await rawConnect("shop.example.co.in:22", auth)).toMatch(/^HTTP\/1.1 421/);
    expect(await rawConnect("127.0.0.1:443", auth)).toMatch(/^HTTP\/1.1 403/);
    expect((await rawHttp("http://169.254.169.254/", auth)).error).toBe("BLOCKED_HOST");
  });

  it("a tampered or malformed policy invalidates the token (fail closed)", async () => {
    const good = signCapability(SECRET, { o: "o", w: "w", e: "e-tamper", k: "browser", t: { f: ["shop.example.co.in"], m: "none" } } as never, 60);
    const [payload, sig] = good.split(".");
    const body = JSON.parse(Buffer.from(payload!, "base64url").toString());
    body.t.m = "all";
    const forged = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
    expect(verifyCapability(SECRET, forged)).toBeNull();
    for (const bad of [{ f: [], m: "none" }, { f: ["shop.example.co.in"], m: "everything" }, { f: ["*.co.in"], m: "none" }, { f: ["shop.example.co.in"], m: "allowlist", a: ["x".repeat(300)] }, { f: ["shop.example.co.in"], m: "all", n: 10_000 }, { f: ["shop.example.co.in"], m: "none", extra: 1 }]) {
      expect(verifyCapability(SECRET, signCapability(SECRET, { o: "o", w: "w", e: "e", k: "browser", t: bad } as never, 60)), JSON.stringify(bad)).toBeNull();
    }
    expect(await rawConnect("cdn.thirdparty.co.in:443", proxyAuthorization(forged))).toMatch(/^HTTP\/1.1 407/);
  });
});

describe("WebSocket through the gateway (blocker 5 model check)", () => {
  it("a ws:// upgrade sent as an absolute-form proxy request is not tunnelled as a live socket", async () => {
    const u = new URL(url);
    const auth = proxyAuthorization(signCapability(SECRET, { o: "o", w: "w", e: `ws-${Math.random()}`, k: "browser" }, 60));
    const line = await new Promise<string>((resolve, reject) => {
      const s = connect(Number(u.port), u.hostname, () => {
        s.write(`GET http://ok.example.co.in/ws HTTP/1.1\r\nHost: ok.example.co.in\r\nProxy-Authorization: ${auth}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]!); s.destroy(); });
      s.once("error", reject);
      setTimeout(() => { resolve("TIMEOUT"); s.destroy(); }, 5000);
    });
    expect(line).not.toMatch(/^HTTP\/1.1 101/);
  });
});
