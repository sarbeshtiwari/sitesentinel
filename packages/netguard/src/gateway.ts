import { createHmac, timingSafeEqual } from "node:crypto";
import type { DnsClient } from "./index.js";
import { NetguardError, type NetguardErrorCode } from "./index.js";

/**
 * Capability tokens for the egress gateway. Every outbound request on the
 * monitoring path carries one: it says which organization/website/execution the
 * traffic belongs to and expires quickly. The gateway refuses anonymous traffic
 * and attributes usage per organization. Tokens grant no other authority.
 */
export interface EgressCapability {
  /** organization id (null for platform jobs such as revalidation sweeps) */
  o: string | null;
  /** website id */
  w: string | null;
  /** execution / job reference for tracing */
  e: string;
  /** job kind: verify | revalidate | http | browser | deepscan | probe */
  k: string;
  /**
   * Optional host binding: when present the gateway only tunnels to exactly this hostname.
   * The HTTP engine mints one token per request hop, so a leaked token can't reach other hosts.
   */
  h?: string;
  /**
   * Release readiness (blocker 5): third-party policy for browser sessions, enforced by the gateway for EVERY request
   * of the session (page load, subresources, frames, fetch/XHR, WebSocket, redirects — they are all new proxy requests).
   *  - f: first-party registrable domain(s); always allowed (subject to every other gateway rule)
   *  - m: "all" (any public host), "allowlist" (only the listed registrable domains in `a`), "none" (first party only)
   *  - a: allowed third-party registrable domains (mode "allowlist"), ≤ 50
   *  - n: maximum distinct third-party hosts per execution (mode "all" and "allowlist")
   * Absent → no restriction beyond the base rules (non-browser jobs, which are host-bound instead).
   */
  t?: ThirdPartyPolicy;
  /** expiry, epoch seconds */
  x: number;
}

export interface ThirdPartyPolicy { f: string[]; m: "all" | "allowlist" | "none"; a?: string[]; n?: number }

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
/** Validates the policy carried in a token (a malformed policy invalidates the whole token: fail closed). */
export function validThirdPartyPolicy(t: unknown): t is ThirdPartyPolicy {
  if (!t || typeof t !== "object") return false;
  const p = t as Record<string, unknown>;
  if (!Array.isArray(p.f) || p.f.length < 1 || p.f.length > 5 || !p.f.every((d) => typeof d === "string" && DOMAIN_RE.test(d))) return false;
  if (p.m !== "all" && p.m !== "allowlist" && p.m !== "none") return false;
  if (p.a !== undefined && (!Array.isArray(p.a) || p.a.length > 50 || !p.a.every((d) => typeof d === "string" && DOMAIN_RE.test(d)))) return false;
  if (p.n !== undefined && (typeof p.n !== "number" || !Number.isInteger(p.n) || p.n < 0 || p.n > 500)) return false;
  return Object.keys(p).every((k) => ["f", "m", "a", "n"].includes(k));
}

/** Host within one of the registrable domains (exact or a subdomain). */
export function hostInDomains(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Decision for one destination host under a token's third-party policy (budget accounting is the gateway's). */
export function thirdPartyDecision(t: ThirdPartyPolicy, host: string): "first-party" | "third-party" | "blocked" {
  if (hostInDomains(host, t.f)) return "first-party";
  if (t.m === "none") return "blocked";
  if (t.m === "allowlist" && !hostInDomains(host, t.a ?? [])) return "blocked";
  return "third-party";
}

export const MAX_CAPABILITY_TTL_SEC = 15 * 60;

export function signCapability(secret: string, cap: Omit<EgressCapability, "x">, ttlSec = 300): string {
  const body: EgressCapability = { ...cap, x: Math.floor(Date.now() / 1000) + Math.min(ttlSec, MAX_CAPABILITY_TTL_SEC) };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyCapability(secret: string, token: string): EgressCapability | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const cap = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as EgressCapability;
    const now = Math.floor(Date.now() / 1000);
    if (typeof cap.x !== "number" || cap.x < now || cap.x > now + MAX_CAPABILITY_TTL_SEC + 5) return null;
    if (typeof cap.e !== "string" || typeof cap.k !== "string") return null;
    if (cap.h !== undefined && (typeof cap.h !== "string" || !cap.h)) return null;
    if (cap.t !== undefined && !validThirdPartyPolicy(cap.t)) return null;
    return cap;
  } catch {
    return null;
  }
}

/** Basic proxy credentials understood by the gateway (Chromium and undici both send Basic). */
export function proxyAuthorization(token: string): string {
  return `Basic ${Buffer.from(`cap:${token}`).toString("base64")}`;
}

export function parseProxyAuthorization(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value) return null;
  if (scheme?.toLowerCase() === "bearer") return value;
  if (scheme?.toLowerCase() !== "basic") return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return idx >= 0 ? decoded.slice(idx + 1) : null;
}

/**
 * Gateway status codes → netguard error codes. The gateway answers a refused
 * CONNECT or proxied request with these statuses (plus X-Egress-Error).
 */
export const GATEWAY_STATUS: Record<number, NetguardErrorCode> = {
  401: "EGRESS_UNAUTHORIZED",
  403: "BLOCKED_ADDRESS",
  407: "EGRESS_UNAUTHORIZED",
  421: "BLOCKED_PORT",
  424: "NO_ADDRESSES",
  429: "EGRESS_RATE_LIMITED",
  502: "CONNECTION_FAILED",
  503: "DNS_FAILURE",
  504: "TIMEOUT",
};

export function gatewayError(status: number, detail?: string): NetguardError {
  const code = GATEWAY_STATUS[status] ?? "EGRESS_UNAVAILABLE";
  return new NetguardError(code, `egress gateway refused the destination (${status}${detail ? ` ${detail}` : ""})`, { gatewayStatus: status });
}

/**
 * DNS through the gateway's constrained resolver API. Used by workers that have
 * no network route to DNS servers (internal-only Docker networks).
 */
export function createGatewayDnsClient(opts: { url: string; token: () => string; timeoutMs?: number }): DnsClient {
  const call = async (type: "TXT" | "ADDR", name: string) => {
    const u = new URL("/v1/dns", opts.url);
    u.searchParams.set("type", type);
    u.searchParams.set("name", name);
    let res: Response;
    try {
      res = await fetch(u, { headers: { authorization: `Bearer ${opts.token()}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    } catch (e) {
      throw new NetguardError("EGRESS_UNAVAILABLE", `egress gateway unreachable: ${(e as Error).message}`);
    }
    if (res.status === 400) throw new NetguardError("INVALID_URL", "invalid DNS name");
    if (res.status !== 200) throw gatewayError(res.status);
    return res.json() as Promise<unknown>;
  };
  return {
    async addresses(host) {
      const r = (await call("ADDR", host)) as { addresses: string[] };
      return r.addresses;
    },
    async txt(name) {
      const r = (await call("TXT", name)) as { answers: Array<{ server: string; records?: string[]; error?: string }> };
      return r.answers;
    },
  };
}
