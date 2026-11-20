import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { createLogger, type Logger } from "@wim/logger";
import { createDnsClient, isPublicAddress, parseProxyAuthorization, thirdPartyDecision, verifyCapability, type DnsClient, type EgressCapability } from "@wim/netguard";

/**
 * SiteSentinel egress gateway — the ONLY process on the monitoring path with an
 * internet route (SECURITY.md §25). It validates every destination independently
 * of the worker that asked for it:
 *   - signed, short-lived capability token required (no anonymous use; attribution)
 *   - ports 80/443 only; hostnames only (IP literals refused)
 *   - DNS resolved here with configured resolvers; the host is refused if ANY answer is
 *     private / loopback / link-local / CGNAT / documentation / multicast / reserved /
 *     ULA / NAT64 / IPv4-mapped / 6to4 / metadata
 *   - the socket connects to exactly the validated address (no re-resolution → no rebinding)
 *   - byte, duration, idle and per-organization concurrency limits
 * Every decision is logged as metadata (no content, no headers, no tokens).
 */

export interface GatewayConfig {
  resolvers: string[];
  tokenSecret: string;
  allowedPorts: number[];
  maxConnectionsPerOrg: number;
  /**
   * Cumulative connections one execution may open over its lifetime, counted separately per capability kind
   * (`e` + `k`): bounds a page making thousands of requests, without one kind (e.g. a deep scan's browser
   * rendering, `deepscan-browser`) starving another of the same execution (its crawl, `deepscan`). Per-org and
   * total caps still bound everything. Default 300.
   */
  maxConnectionsPerExecution?: number;
  /** per-kind overrides of `maxConnectionsPerExecution`, e.g. `{ deepscan: 2500 }` (a crawl's whole request budget) */
  maxConnectionsPerExecutionKind?: Record<string, number>;
  maxConnectionsTotal: number;
  maxTunnelBytes: number;
  tunnelMaxMs: number;
  idleMs: number;
  connectTimeoutMs: number;
  /** TEST ONLY (refused unless NODE_ENV=test): CIDRs treated as public, e.g. a fixture network. */
  testAllowCidrs: string[];
  /** TEST ONLY: remap destination ports for fixture servers, e.g. {443: 14301, 80: 14300}. */
  testPortMap: Record<number, number>;
}

export type Outcome = "ALLOWED" | "BLOCKED_ADDRESS" | "BLOCKED_PORT" | "BLOCKED_HOST" | "NO_ADDRESSES" | "DNS_FAILURE"
  | "UNAUTHORIZED" | "RATE_LIMITED" | "CONNECT_FAILED" | "TIMEOUT" | "BAD_REQUEST";

/**
 * Sent with a RATE_LIMITED refusal (alongside X-Egress-Error) when the cause is the execution's own lifetime
 * budget being used up, not the per-org / total concurrency caps. Callers that don't know it see RATE_LIMITED.
 */
export const EXECUTION_BUDGET_REFUSAL = "EXECUTION_BUDGET";

const STATUS: Record<Exclude<Outcome, "ALLOWED">, number> = {
  BLOCKED_ADDRESS: 403, BLOCKED_HOST: 403, BLOCKED_PORT: 421, NO_ADDRESSES: 424, DNS_FAILURE: 503, UNAUTHORIZED: 407,
  RATE_LIMITED: 429, CONNECT_FAILED: 502, TIMEOUT: 504, BAD_REQUEST: 400,
};

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

export class Gateway {
  readonly server: Server;
  readonly stats = new Map<Outcome, number>();
  private readonly dns: DnsClient;
  private readonly testAllow = new BlockList();
  private readonly perOrg = new Map<string, number>();
  private total = 0;
  private readonly log: Logger;
  private readonly sockets = new Set<Duplex>();

  constructor(readonly cfg: GatewayConfig, opts: { dns?: DnsClient; logger?: Logger } = {}) {
    if ((cfg.testAllowCidrs.length || Object.keys(cfg.testPortMap).length) && process.env.NODE_ENV !== "test") {
      throw new Error("EGRESS test allowances are only permitted when NODE_ENV=test");
    }
    for (const c of cfg.testAllowCidrs) {
      const [net, bits] = c.split("/");
      this.testAllow.addSubnet(net!, Number(bits), isIP(net!) === 6 ? "ipv6" : "ipv4");
    }
    this.dns = opts.dns ?? createDnsClient(cfg.resolvers, 4000);
    this.log = opts.logger ?? createLogger("egress-gateway");
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.on("connect", (req, sock, head) => void this.onConnect(req, sock, head));
    this.server.on("clientError", (_e, sock) => sock.destroy());
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = cfg.tunnelMaxMs;
  }

  listen(port: number, host = "0.0.0.0") {
    return new Promise<void>((r) => this.server.listen(port, host, r));
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private count(o: Outcome) {
    this.stats.set(o, (this.stats.get(o) ?? 0) + 1);
  }

  private audit(o: Outcome, cap: EgressCapability | null, host: string, port: number, extra: Record<string, unknown> = {}) {
    this.count(o);
    const entry = { outcome: o, org: cap?.o ?? null, website: cap?.w ?? null, exec: cap?.e ?? null, kind: cap?.k ?? null, host, port, ...extra };
    if (o === "ALLOWED") this.log.info(entry, "egress");
    else this.log.warn(entry, "egress refused");
  }

  /** Public = passes the netguard deny list (or the explicit test allowance). */
  isAllowedAddress(ip: string): boolean {
    const fam = isIP(ip);
    // IPv4-mapped / NAT64 IPv6 forms are never allowed — not even by a test allowance
    // (Node's BlockList matches ::ffff:a.b.c.d against IPv4 rules).
    if (fam === 6 && /^(::ffff:|64:ff9b::)/i.test(ip)) return false;
    if (fam && this.testAllow.check(ip, fam === 6 ? "ipv6" : "ipv4")) return true;
    return isPublicAddress(ip);
  }

  /** Resolve and validate; returns the pinned address or an outcome. */
  async decide(host: string, port: number): Promise<{ address: string; dnsMs: number } | { outcome: Exclude<Outcome, "ALLOWED">; detail?: unknown }> {
    if (!this.cfg.allowedPorts.includes(port)) return { outcome: "BLOCKED_PORT" };
    const h = host.toLowerCase().replace(/\.$/, "");
    if (isIP(h.replace(/^\[|\]$/g, ""))) return { outcome: "BLOCKED_HOST", detail: "ip-literal" };
    if (!HOST_RE.test(h)) return { outcome: "BLOCKED_HOST", detail: "invalid-hostname" };
    let addrs: string[];
    const dnsStarted = performance.now();
    try {
      addrs = await this.dns.addresses(h);
    } catch {
      return { outcome: "DNS_FAILURE" }; // resolver failure: our side, never a verdict about the destination
    }
    if (!addrs.length) return { outcome: "NO_ADDRESSES" };
    const blocked = addrs.filter((a) => !this.isAllowedAddress(a));
    if (blocked.length) return { outcome: "BLOCKED_ADDRESS", detail: { blocked } };
    // Prefer IPv4 (container networks are IPv4-only by default); all answers already validated.
    return { address: addrs.find((a) => isIP(a) === 4) ?? addrs[0]!, dnsMs: Math.round(performance.now() - dnsStarted) };
  }

  /** distinct third-party hosts seen per execution (budget `t.n`) */
  private thirdHosts = new Map<string, { hosts: Set<string>; exp: number }>();

  /**
   * Third-party policy of a browser token (blocker 5). Runs BEFORE resolution, so a refused host is never even looked
   * up; an allowed host still goes through every base rule (ports, IP literals, public-address check on every answer,
   * pinned connect, limits). Returns a refusal detail or null.
   */
  private thirdParty(cap: EgressCapability, host: string): string | null {
    if (!cap.t) return null;
    const h = host.toLowerCase().replace(/\.$/, "");
    const d = thirdPartyDecision(cap.t, h);
    if (d === "first-party") return null;
    if (d === "blocked") return cap.t.m === "none" ? "third-party-disallowed" : "third-party-not-allowlisted";
    const budget = cap.t.n ?? 100;
    const seen = this.thirdHosts.get(cap.e) ?? { hosts: new Set<string>(), exp: cap.x };
    if (!seen.hosts.has(h)) {
      if (seen.hosts.size >= budget) return "third-party-host-budget";
      seen.hosts.add(h);
    }
    this.thirdHosts.set(cap.e, seen);
    if (this.thirdHosts.size > 10_000) {
      const now = Math.floor(Date.now() / 1000);
      for (const [k, v] of this.thirdHosts) if (v.exp < now) this.thirdHosts.delete(k);
    }
    return null;
  }

  private auth(header: string | undefined): EgressCapability | null {
    const token = parseProxyAuthorization(header);
    return token ? verifyCapability(this.cfg.tokenSecret, token) : null;
  }

  /** lifetime connection counts keyed by `${execution}:${kind}` (see GatewayConfig.maxConnectionsPerExecution) */
  private perExec = new Map<string, { n: number; exp: number }>();

  /** "OK" (slot taken; release() when done), "LIMIT" (per-org / total concurrency) or "BUDGET" (execution lifetime budget). */
  private acquire(cap: EgressCapability): "OK" | "LIMIT" | "BUDGET" {
    const key = cap.o ?? "platform";
    const n = this.perOrg.get(key) ?? 0;
    if (n >= this.cfg.maxConnectionsPerOrg || this.total >= this.cfg.maxConnectionsTotal) return "LIMIT";
    const kind = cap.k ?? "";
    const budget = this.cfg.maxConnectionsPerExecutionKind?.[kind] ?? this.cfg.maxConnectionsPerExecution ?? 300;
    const execKey = `${cap.e}:${kind}`;
    const ex = this.perExec.get(execKey) ?? { n: 0, exp: cap.x };
    if (ex.n >= budget) return "BUDGET";
    ex.n++;
    ex.exp = Math.max(ex.exp, cap.x); // kept while any token of the execution is still valid
    this.perExec.set(execKey, ex);
    if (this.perExec.size > 10_000) {
      const now = Math.floor(Date.now() / 1000);
      for (const [k, v] of this.perExec) if (v.exp < now) this.perExec.delete(k);
    }
    this.perOrg.set(key, n + 1);
    this.total++;
    return "OK";
  }

  private release(cap: EgressCapability) {
    const key = cap.o ?? "platform";
    this.perOrg.set(key, Math.max(0, (this.perOrg.get(key) ?? 1) - 1));
    this.total = Math.max(0, this.total - 1);
  }

  private port(p: number) {
    return this.cfg.testPortMap[p] ?? p;
  }

  // ---------------------------------------------------------------- CONNECT (HTTPS and undici tunnels)
  private async onConnect(req: IncomingMessage, client: Duplex, head: Buffer) {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => undefined);
    const refuse = (o: Exclude<Outcome, "ALLOWED">, extra = "") => {
      // extra: complete header lines, each ending in \r\n
      client.end(`HTTP/1.1 ${STATUS[o]} Refused\r\nX-Egress-Error: ${o}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const target = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url ?? "");
    const cap = this.auth(req.headers["proxy-authorization"]);
    if (!cap) {
      this.audit("UNAUTHORIZED", null, target?.[1] ?? "?", Number(target?.[2] ?? 0));
      return refuse("UNAUTHORIZED", 'Proxy-Authenticate: Basic realm="egress"\r\n');
    }
    if (!target) {
      this.audit("BAD_REQUEST", cap, String(req.url).slice(0, 100), 0);
      return refuse("BAD_REQUEST");
    }
    const host = target[1]!;
    const port = Number(target[2]);
    if (cap.h && cap.h !== host.toLowerCase().replace(/\.$/, "")) {
      this.audit("UNAUTHORIZED", cap, host, port, { detail: "host-binding" });
      return refuse("UNAUTHORIZED", 'Proxy-Authenticate: Basic realm="egress"\r\n');
    }
    const tp = this.thirdParty(cap, host);
    if (tp) {
      this.audit("BLOCKED_HOST", cap, host, port, { detail: tp });
      return refuse("BLOCKED_HOST");
    }
    const d = await this.decide(host, port);
    if ("outcome" in d) {
      this.audit(d.outcome, cap, host, port, { detail: d.detail });
      return refuse(d.outcome);
    }
    const slot = this.acquire(cap);
    if (slot !== "OK") {
      this.audit("RATE_LIMITED", cap, host, port, slot === "BUDGET" ? { detail: "execution-budget" } : {});
      return refuse("RATE_LIMITED", slot === "BUDGET" ? `X-Egress-Refusal: ${EXECUTION_BUDGET_REFUSAL}\r\n` : "");
    }
    const started = Date.now();
    const connectStarted = performance.now();
    let bytes = 0;
    let done = false;
    const upstream: Socket = connect({ host: d.address, port: this.port(port), timeout: this.cfg.connectTimeoutMs });
    this.sockets.add(upstream);
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      this.release(cap);
      clearTimeout(maxTimer);
      this.audit(o, cap, host, port, { address: d.address, bytes, ms: Date.now() - started, dnsMs: d.dnsMs, connectMs });
      upstream.destroy();
      client.destroy();
      this.sockets.delete(upstream);
    };
    const maxTimer = setTimeout(() => finish("TIMEOUT"), this.cfg.tunnelMaxMs);
    upstream.once("timeout", () => {
      if (upstream.connecting) {
        refuse("TIMEOUT");
        finish("TIMEOUT");
      } else {
        finish("ALLOWED"); // idle after a successful exchange
      }
    });
    upstream.once("error", () => {
      if (upstream.connecting) refuse("CONNECT_FAILED");
      finish(upstream.connecting ? "CONNECT_FAILED" : "ALLOWED");
    });
    let connectMs: number | undefined;
    upstream.once("connect", () => {
      upstream.setTimeout(this.cfg.idleMs);
      connectMs = Math.round(performance.now() - connectStarted);
      // Measurements only the gateway can take (it resolves and connects): reported to the authorised caller.
      client.write(`HTTP/1.1 200 Connection Established\r\nX-Egress-Dns-Ms: ${d.dnsMs}\r\nX-Egress-Connect-Ms: ${connectMs}\r\nX-Egress-Address: ${d.address}\r\n\r\n`);
      if (head.length) upstream.write(head);
      const meter = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.cfg.maxTunnelBytes) finish("ALLOWED");
      };
      upstream.on("data", meter);
      client.on("data", meter);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.once("close", () => finish("ALLOWED"));
    upstream.once("close", () => finish("ALLOWED"));
  }

  // ---------------------------------------------------------------- plain HTTP (absolute-form) + internal API
  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const raw = req.url ?? "/";
    if (raw.startsWith("/")) return this.internal(req, res, raw);
    const cap = this.auth(req.headers["proxy-authorization"]);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.audit("BAD_REQUEST", cap, "?", 0);
      return this.refuseHttp(res, "BAD_REQUEST");
    }
    if (!cap) {
      this.audit("UNAUTHORIZED", null, url.hostname, Number(url.port || 80));
      res.setHeader("Proxy-Authenticate", 'Basic realm="egress"');
      return this.refuseHttp(res, "UNAUTHORIZED");
    }
    if (url.protocol !== "http:" || url.username || url.password) {
      this.audit("BAD_REQUEST", cap, url.hostname, 0, { detail: "https must use CONNECT; no credentials" });
      return this.refuseHttp(res, "BAD_REQUEST");
    }
    const port = Number(url.port || 80);
    if (cap.h && cap.h !== url.hostname.toLowerCase().replace(/\.$/, "")) {
      this.audit("UNAUTHORIZED", cap, url.hostname, port, { detail: "host-binding" });
      res.setHeader("Proxy-Authenticate", 'Basic realm="egress"');
      return this.refuseHttp(res, "UNAUTHORIZED");
    }
    const tp = this.thirdParty(cap, url.hostname);
    if (tp) {
      this.audit("BLOCKED_HOST", cap, url.hostname, port, { detail: tp });
      return this.refuseHttp(res, "BLOCKED_HOST");
    }
    const d = await this.decide(url.hostname, port);
    if ("outcome" in d) {
      this.audit(d.outcome, cap, url.hostname, port, { detail: d.detail });
      return this.refuseHttp(res, d.outcome);
    }
    const slot = this.acquire(cap);
    if (slot !== "OK") {
      this.audit("RATE_LIMITED", cap, url.hostname, port, slot === "BUDGET" ? { detail: "execution-budget" } : {});
      if (slot === "BUDGET") res.setHeader("x-egress-refusal", EXECUTION_BUDGET_REFUSAL);
      return this.refuseHttp(res, "RATE_LIMITED");
    }
    const started = Date.now();
    let bytes = 0;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    headers.host = url.host;
    // Connect timeout covers only the TCP connect; afterwards the idle timeout applies (a slow but live
    // response is not a connect failure). (Phase 4D fix: the connect timeout used to cut slow responses.)
    const up = httpRequest({ host: d.address, port: this.port(port), method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: this.cfg.idleMs });
    up.on("socket", (sock: Socket) => {
      if (!sock.connecting) return;
      const t = setTimeout(() => { if (sock.connecting) up.destroy(new Error("connect timeout")); }, this.cfg.connectTimeoutMs);
      sock.once("connect", () => clearTimeout(t));
      sock.once("close", () => clearTimeout(t));
    });
    let finished = false;
    const finish = (o: Outcome) => {
      if (finished) return;
      finished = true;
      this.release(cap);
      this.audit(o, cap, url.hostname, port, { address: d.address, bytes, ms: Date.now() - started, method: req.method });
    };
    up.on("timeout", () => { up.destroy(); if (!res.headersSent) this.refuseHttp(res, "TIMEOUT"); finish("TIMEOUT"); });
    up.on("error", (e) => {
      const o = e.message === "connect timeout" ? "TIMEOUT" : "CONNECT_FAILED";
      if (!res.headersSent) this.refuseHttp(res, o); else res.destroy();
      finish(o);
    });
    up.on("response", (r) => {
      const out: Record<string, string | string[]> = {};
      // x-egress-error / x-egress-refusal are reserved for gateway decisions; an upstream site must not be able to forge one.
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP_BY_HOP.has(k) && k !== "x-egress-error" && k !== "x-egress-refusal") out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > this.cfg.maxTunnelBytes) { r.destroy(); res.destroy(); }
      });
      r.pipe(res);
      r.on("end", () => finish("ALLOWED"));
      r.on("close", () => finish("ALLOWED"));
    });
    req.pipe(up);
  }

  private refuseHttp(res: ServerResponse, o: Exclude<Outcome, "ALLOWED">) {
    if (res.headersSent) return void res.destroy();
    res.writeHead(STATUS[o], { "x-egress-error": o, "content-type": "text/plain", connection: "close" });
    res.end(o);
  }

  private async internal(req: IncomingMessage, res: ServerResponse, raw: string) {
    const url = new URL(raw, "http://gateway.internal");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", connections: this.total }));
    }
    if (url.pathname !== "/v1/dns" || req.method !== "GET") {
      res.writeHead(404);
      return res.end();
    }
    const auth = req.headers.authorization;
    const cap = auth?.startsWith("Bearer ") ? verifyCapability(this.cfg.tokenSecret, auth.slice(7)) : null;
    if (!cap) {
      this.audit("UNAUTHORIZED", null, "dns", 0);
      res.writeHead(401); // Bearer API, not proxy auth (fetch() treats 407 as a network error)
      return res.end();
    }
    const name = (url.searchParams.get("name") ?? "").toLowerCase().replace(/\.$/, "");
    const type = url.searchParams.get("type");
    if (!/^(?=.{1,253}$)[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})+$/.test(name) || (type !== "TXT" && type !== "ADDR")) {
      res.writeHead(400);
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    try {
      if (type === "TXT") {
        const answers = await this.dns.txt(name);
        this.audit("ALLOWED", cap, name, 53, { dns: "TXT" });
        return res.end(JSON.stringify({ answers }));
      }
      const addresses = await this.dns.addresses(name);
      const blocked = addresses.filter((a) => !this.isAllowedAddress(a));
      if (blocked.length) {
        this.audit("BLOCKED_ADDRESS", cap, name, 53, { dns: "ADDR", blocked });
        res.writeHead(403, { "x-egress-error": "BLOCKED_ADDRESS" });
        return res.end(JSON.stringify({ error: "BLOCKED_ADDRESS" }));
      }
      this.audit("ALLOWED", cap, name, 53, { dns: "ADDR" });
      return res.end(JSON.stringify({ addresses }));
    } catch {
      this.audit("DNS_FAILURE", cap, name, 53);
      res.writeHead(503);
      return res.end(JSON.stringify({ error: "DNS_FAILURE" }));
    }
  }
}

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export const GatewayEnv = z.object({
  EGRESS_PORT: z.coerce.number().int().default(8080),
  EGRESS_TOKEN_SECRET: z.string().min(32),
  DNS_RESOLVERS: z.string().default("1.1.1.1,8.8.8.8"),
  EGRESS_ALLOWED_PORTS: z.string().default("80,443"),
  EGRESS_MAX_CONNECTIONS_PER_ORG: z.coerce.number().int().default(50),
  EGRESS_MAX_CONNECTIONS_TOTAL: z.coerce.number().int().default(2000),
  /** lifetime connections per execution AND capability kind (default for every kind) */
  EGRESS_MAX_CONNECTIONS_PER_EXECUTION: z.coerce.number().int().min(10).default(300),
  /**
   * The deep-scan crawl's (kind `deepscan`) own lifetime budget. Every request hop is a fresh CONNECT and a HEAD
   * answered 4xx is retried as GET, so a crawl needs up to ~2 connections per counted request: the default covers
   * the default `monitoring.deepscan.maxRequests` (1000) with headroom. Raise it with that setting.
   */
  EGRESS_MAX_CONNECTIONS_PER_DEEPSCAN: z.coerce.number().int().min(10).default(2500),
  EGRESS_MAX_TUNNEL_BYTES: z.coerce.number().int().default(50 * 1024 * 1024),
  EGRESS_TUNNEL_MAX_MS: z.coerce.number().int().default(120_000),
  EGRESS_IDLE_MS: z.coerce.number().int().default(30_000),
  EGRESS_CONNECT_TIMEOUT_MS: z.coerce.number().int().default(8000),
  EGRESS_TEST_ALLOW_CIDRS: z.string().optional(),
  EGRESS_TEST_PORT_MAP: z.string().optional(),
});

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const e = GatewayEnv.parse(env);
  return {
    resolvers: list(e.DNS_RESOLVERS),
    tokenSecret: e.EGRESS_TOKEN_SECRET,
    allowedPorts: list(e.EGRESS_ALLOWED_PORTS).map(Number),
    maxConnectionsPerOrg: e.EGRESS_MAX_CONNECTIONS_PER_ORG,
    maxConnectionsTotal: e.EGRESS_MAX_CONNECTIONS_TOTAL,
    maxConnectionsPerExecution: e.EGRESS_MAX_CONNECTIONS_PER_EXECUTION,
    maxConnectionsPerExecutionKind: { deepscan: e.EGRESS_MAX_CONNECTIONS_PER_DEEPSCAN },
    maxTunnelBytes: e.EGRESS_MAX_TUNNEL_BYTES,
    tunnelMaxMs: e.EGRESS_TUNNEL_MAX_MS,
    idleMs: e.EGRESS_IDLE_MS,
    connectTimeoutMs: e.EGRESS_CONNECT_TIMEOUT_MS,
    testAllowCidrs: list(e.EGRESS_TEST_ALLOW_CIDRS),
    testPortMap: Object.fromEntries(list(e.EGRESS_TEST_PORT_MAP).map((p) => p.split(":").map(Number) as [number, number])),
  };
}
