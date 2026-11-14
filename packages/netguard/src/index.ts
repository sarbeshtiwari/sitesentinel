import { BlockList, isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { gatewayError, proxyAuthorization } from "./gateway.js";

export * from "./gateway.js";
export * from "./browser.js";

/**
 * SSRF-safe outbound access for anything that contacts a customer-supplied host
 * (SECURITY.md §5). Every hop:
 *   1. scheme http/https, port 80/443 only
 *   2. DNS resolved by us; EVERY returned address must be public (one bad record rejects the host)
 *   3. the socket connects to exactly the validated address (pinned lookup) — no second
 *      resolution, so DNS rebinding between check and connect is impossible
 *   4. redirects are followed manually and each target goes through 1–3 again
 * Responses are size- and time-limited. No cookies, no auth, identifiable User-Agent.
 */

export type NetguardErrorCode =
  | "BLOCKED_SCHEME" | "BLOCKED_PORT" | "BLOCKED_ADDRESS" | "DNS_FAILURE" | "NO_ADDRESSES"
  | "TOO_MANY_REDIRECTS" | "REDIRECT_NOT_ALLOWED" | "TIMEOUT" | "TOO_LARGE" | "CONNECTION_FAILED" | "INVALID_URL"
  // egress gateway outcomes (fail closed: none of these is ever reported as "customer site down" without classification)
  | "EGRESS_UNAVAILABLE" | "EGRESS_UNAUTHORIZED" | "EGRESS_RATE_LIMITED";

export class NetguardError extends Error {
  constructor(readonly code: NetguardErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "NetguardError";
  }
}

// ---------------------------------------------------------------- address policy
const DENY_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32],
] as const;
const DENY_V6 = [
  // ::ffff:0:0/96 (IPv4-mapped) is deliberately absent: BlockList matches plain IPv4 addresses
  // against it. Mapped forms are rejected explicitly in isPublicAddress().
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const;

const denyList = new BlockList();
for (const [a, p] of DENY_V4) denyList.addSubnet(a, p, "ipv4");
// IPv6 rules live in their own list and are only ever checked for IPv6 addresses
// (Node's BlockList would otherwise match IPv4 addresses against IPv4-mapped rules).
const denyV6 = new BlockList();
for (const [a, p] of DENY_V6) denyV6.addSubnet(a, p, "ipv6");
denyV6.addSubnet("3fff::", 20, "ipv6"); // documentation (RFC 9637)
/** IPv6 is allow-listed: only global unicast 2000::/3 can be public (excludes all of ::/8, fc00::/7, fe80::/10, fec0::/10, ff00::/8, …). */
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");

export interface NetPolicy {
  /**
   * TEST ONLY: permit 127.0.0.0/8 so integration tests can serve fixture sites.
   * The services refuse to start with this enabled unless NODE_ENV=test.
   */
  allowLoopbackForTests?: boolean;
  /** TEST ONLY: connect to this port when the validated address is loopback (fixtures can't bind :80). */
  loopbackPortForTests?: number;
}

/** Extract an IPv4 address embedded in an IPv4-mapped / NAT64 IPv6 address. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (m) return m[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

export function isPublicAddress(ip: string, policy: NetPolicy = {}): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  // IPv4-mapped / NAT64 forms are never accepted, even when the embedded IPv4 address is public:
  // they exist mainly to smuggle internal addresses past naive filters.
  if (family === 6 && embeddedV4(ip)) return false;
  if (policy.allowLoopbackForTests && family === 4 && ip.startsWith("127.")) return true;
  if (family === 6) return globalUnicastV6.check(ip, "ipv6") && !denyV6.check(ip, "ipv6");
  return !denyList.check(ip, "ipv4");
}

// ---------------------------------------------------------------- DNS
export interface DnsClient {
  /** All A + AAAA records for a host. */
  addresses(host: string): Promise<string[]>;
  /** TXT records per resolver: [{server, records|error}] (records joined from chunks). */
  txt(name: string): Promise<Array<{ server: string; records?: string[]; error?: string }>>;
}

/**
 * Resolver bound to explicit servers (deployment config DNS_RESOLVERS). Using
 * public resolvers rather than the host's stub avoids local/split-horizon answers.
 */
export function createDnsClient(servers: string[], timeoutMs = 4000): DnsClient {
  const make = (s?: string[]) => {
    const r = new Resolver({ timeout: timeoutMs, tries: 2 });
    if (s?.length) r.setServers(s);
    return r;
  };
  const all = make(servers);
  return {
    async addresses(host) {
      const [v4, v6] = await Promise.allSettled([all.resolve4(host), all.resolve6(host)]);
      const out = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
      if (!out.length) {
        const reason = [v4, v6].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        const code = (reason?.reason as { code?: string })?.code;
        if (code && code !== "ENODATA" && code !== "ENOTFOUND") throw new NetguardError("DNS_FAILURE", `DNS lookup failed (${code})`);
      }
      return out;
    },
    async txt(name) {
      const targets = servers.length ? servers : ["system"];
      return Promise.all(targets.map(async (server) => {
        try {
          const r = server === "system" ? make() : make([server]);
          const recs = await r.resolveTxt(name);
          return { server, records: recs.map((chunks) => chunks.join("")) };
        } catch (e) {
          return { server, error: (e as { code?: string }).code ?? "ERROR" };
        }
      }));
    },
  };
}

/** Resolve and validate a host; returns the public addresses or throws BLOCKED_ADDRESS. */
export async function resolvePublic(host: string, dns: DnsClient, policy: NetPolicy = {}): Promise<string[]> {
  if (isIP(host)) throw new NetguardError("BLOCKED_ADDRESS", "IP-address hosts are not allowed");
  const addrs = await dns.addresses(host);
  if (!addrs.length) throw new NetguardError("NO_ADDRESSES", `${host} does not resolve`);
  const blocked = addrs.filter((a) => !isPublicAddress(a, policy));
  if (blocked.length) {
    throw new NetguardError("BLOCKED_ADDRESS", `${host} resolves to a private, reserved or internal address`, { blocked });
  }
  return addrs;
}

// ---------------------------------------------------------------- fetch
export interface SafeFetchOptions {
  dns: DnsClient;
  policy?: NetPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Decide whether a redirect target is acceptable (e.g. same website identity only). */
  allowRedirect?: (from: URL, to: URL) => boolean;
  userAgent?: string;
  accept?: string;
  method?: "GET" | "HEAD";
  /**
   * Route through the egress gateway (mandatory in production). The gateway resolves,
   * validates and pins the destination independently; this process never connects to
   * the customer host itself. `dns` is then only used when the caller asks for it.
   */
  egress?: { url: string; token: () => string };
}

export interface Hop { url: string; status: number; address: string }
export interface SafeResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  chain: Hop[];
}

const DEFAULT_UA = "SiteSentinel-Verifier/1.0 (+ownership verification)";

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const policy = opts.policy ?? {};
  const maxRedirects = opts.maxRedirects ?? 3;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  const chain: Hop[] = [];
  let url = parseUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    checkUrl(url);
    if (opts.egress) {
      const r = await viaGateway(url, opts, deadline, maxBytes);
      chain.push({ url: url.toString(), status: r.status, address: "egress-gateway" });
      if ("redirect" in r) {
        if (hop >= maxRedirects) throw new NetguardError("TOO_MANY_REDIRECTS", `More than ${maxRedirects} redirects`, { chain });
        const next = parseUrl(new URL(r.redirect, url).toString());
        if (opts.allowRedirect && !opts.allowRedirect(url, next)) {
          throw new NetguardError("REDIRECT_NOT_ALLOWED", `Redirect to ${next.host} is not allowed`, { chain, to: next.toString() });
        }
        url = next;
        continue;
      }
      return { ...r, finalUrl: url.toString(), chain };
    }
    const addresses = await resolvePublic(url.hostname, opts.dns, policy);
    const address = addresses[0]!;
    const family = isIP(address);
    const isLoopback = family === 4 && address.startsWith("127.");
    const port = isLoopback && policy.loopbackPortForTests ? policy.loopbackPortForTests : Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new NetguardError("TIMEOUT", "Timed out");

    // Pinned lookup: the socket can only ever connect to the address validated above.
    const agent = new Agent({
      connect: {
        lookup: (_h: string, _o: unknown, cb: (err: Error | null, addr: string | Array<{ address: string; family: number }>, fam?: number) => void) => {
          const o = _o as { all?: boolean } | undefined;
          if (o?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
        timeout: Math.min(remaining, 5000),
        rejectUnauthorized: true,
      },
      connections: 1,
      pipelining: 0,
    });
    const target = new URL(url);
    target.port = String(port);
    try {
      const res = await request(target, {
        method: opts.method ?? "GET",
        dispatcher: agent,
        headers: {
          host: url.host,
          "user-agent": opts.userAgent ?? DEFAULT_UA,
          accept: opts.accept ?? "*/*",
          "accept-encoding": "identity",
        },
        headersTimeout: remaining,
        bodyTimeout: remaining,
        maxRedirections: 0,
        // TLS SNI/hostname verification use the original host name, not the pinned IP.
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      } as Parameters<typeof request>[1]);
      chain.push({ url: url.toString(), status: res.statusCode, address });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && headers.location) {
        await res.body.dump();
        if (hop >= maxRedirects) throw new NetguardError("TOO_MANY_REDIRECTS", `More than ${maxRedirects} redirects`, { chain });
        const next = parseUrl(new URL(headers.location, url).toString());
        if (opts.allowRedirect && !opts.allowRedirect(url, next)) {
          throw new NetguardError("REDIRECT_NOT_ALLOWED", `Redirect to ${next.host} is not allowed`, { chain, to: next.toString() });
        }
        url = next;
        continue;
      }

      const parts: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk as Uint8Array);
        if (size + buf.length > maxBytes) {
          parts.push(buf.subarray(0, maxBytes - size));
          truncated = true;
          res.body.destroy();
          break;
        }
        parts.push(buf);
        size += buf.length;
      }
      return { status: res.statusCode, finalUrl: url.toString(), headers, body: Buffer.concat(parts), truncated, chain };
    } catch (e) {
      if (e instanceof NetguardError) throw e;
      const c = (e as { code?: string }).code ?? "";
      if (/TIMEOUT/i.test(c)) throw new NetguardError("TIMEOUT", "Timed out", { chain });
      throw new NetguardError("CONNECTION_FAILED", `Could not connect to ${url.host} (${c || (e as Error).message})`, { chain });
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}

type GatewayResult =
  | { status: number; redirect: string }
  | { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean };

/** One hop through the egress gateway (CONNECT tunnel; TLS terminates here, with SNI = the real host). */
async function viaGateway(url: URL, opts: SafeFetchOptions, deadline: number, maxBytes: number): Promise<GatewayResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new NetguardError("TIMEOUT", "Timed out");
  const agent: Dispatcher = new ProxyAgent({
    uri: opts.egress!.url,
    token: proxyAuthorization(opts.egress!.token()),
    requestTls: { rejectUnauthorized: true, servername: url.hostname },
    proxyTls: { rejectUnauthorized: true },
    connect: { timeout: Math.min(remaining, 8000) },
  } as ConstructorParameters<typeof ProxyAgent>[0]);
  try {
    const res = await request(url, {
      method: opts.method ?? "GET",
      dispatcher: agent,
      headers: { "user-agent": opts.userAgent ?? DEFAULT_UA, accept: opts.accept ?? "*/*", "accept-encoding": "identity" },
      headersTimeout: remaining,
      bodyTimeout: remaining,
      maxRedirections: 0,
    } as Parameters<typeof request>[1]);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    // Plain-http targets are forwarded (not tunnelled): a gateway refusal arrives as a response
    // carrying X-Egress-Error (which the gateway strips from upstream responses, so it can't be forged).
    if (headers["x-egress-error"]) {
      await res.body.dump();
      throw gatewayError(res.statusCode, headers["x-egress-error"]);
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && headers.location) {
      await res.body.dump();
      return { status: res.statusCode, redirect: headers.location };
    }
    const parts: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk as Uint8Array);
      if (size + buf.length > maxBytes) {
        parts.push(buf.subarray(0, maxBytes - size));
        truncated = true;
        res.body.destroy();
        break;
      }
      parts.push(buf);
      size += buf.length;
    }
    return { status: res.statusCode, headers, body: Buffer.concat(parts), truncated };
  } catch (e) {
    if (e instanceof NetguardError) throw e;
    const msg = String((e as Error).message ?? "");
    // undici: "Proxy response (403) !== 200 when HTTP Tunneling"
    const m = /Proxy response \((\d{3})\)/.exec(msg);
    if (m) throw gatewayError(Number(m[1]));
    const c = (e as { code?: string }).code ?? "";
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(c) && /proxy|egress/i.test(msg + opts.egress!.url)) {
      throw new NetguardError("EGRESS_UNAVAILABLE", "egress gateway unreachable");
    }
    if (/TIMEOUT/i.test(c)) throw new NetguardError("TIMEOUT", "Timed out");
    if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(c + msg)) throw new NetguardError("CONNECTION_FAILED", `TLS error (${c || msg})`, { tls: true });
    throw new NetguardError("CONNECTION_FAILED", `Could not connect to ${url.host} (${c || msg})`);
  } finally {
    await agent.close().catch(() => undefined);
  }
}

function parseUrl(s: string): URL {
  try {
    return new URL(s);
  } catch {
    throw new NetguardError("INVALID_URL", "Invalid URL");
  }
}

function checkUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetguardError("BLOCKED_SCHEME", `Scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new NetguardError("INVALID_URL", "Credentials in URL are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new NetguardError("BLOCKED_PORT", `Port ${url.port} is not allowed`);
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new NetguardError("BLOCKED_ADDRESS", "IP-address hosts are not allowed");
}
export * from "./probe.js";
