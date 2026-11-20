import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as tlsConnect, rootCertificates, type PeerCertificate, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { proxyAuthorization } from "./gateway.js";

/**
 * Gateway-only HTTP probe for availability monitoring (Phase 4C).
 *
 * Every request hop is a fresh CONNECT through the egress gateway, which resolves the
 * host itself, refuses non-public destinations and pins the validated address — so each
 * redirect target is independently validated. The probe never connects anywhere else:
 * there is no direct mode. TLS is negotiated end-to-end inside the tunnel so the
 * certificate can be inspected; an untrusted certificate aborts the hop before any
 * HTTP request is sent. No cookies, credentials or custom headers are ever sent.
 *
 * Measurements and where they come from:
 *  - dnsMs, connectMs, address: measured by the gateway (it resolves and connects) and
 *    returned in the CONNECT response headers
 *  - gatewayMs: CONNECT round trip as seen by the worker (includes dnsMs + connectMs)
 *  - tlsMs: TLS handshake inside the tunnel, measured by the worker
 *  - ttfbMs: request written → response headers received
 *  - totalMs: whole probe including redirects and body read
 */

export type ProbeErrorCode =
  | "GATEWAY_UNAVAILABLE" | "EGRESS_UNAUTHORIZED" | "EGRESS_RATE_LIMITED" | "GATEWAY_ERROR"
  | "DNS_FAILURE" | "NO_ADDRESSES" | "BLOCKED_ADDRESS" | "BLOCKED_HOST" | "BLOCKED_PORT"
  | "CONNECTION_FAILED" | "CONNECT_TIMEOUT" | "RESPONSE_TIMEOUT" | "TLS_INVALID" | "PROTOCOL_ERROR"
  | "REDIRECT_LOOP" | "TOO_MANY_REDIRECTS" | "INVALID_REDIRECT" | "INVALID_TARGET" | "ABORTED";

export interface ProbeHop {
  url: string; // sanitised
  method: "GET" | "HEAD";
  status: number | null;
  address: string | null;
  dnsMs: number | null;
  connectMs: number | null;
  gatewayMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  error: ProbeErrorCode | null;
}

export interface ProbeTls {
  authorized: boolean;
  error: string | null;
  validFrom: string | null;
  validTo: string | null;
  issuer: string | null;
  protocol: string | null;
  hostnameMatch: boolean | null;
}

export interface ProbeResponse {
  url: string; // sanitised final URL
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  bytes: number; // body bytes received on the wire (identity or compressed)
  truncated: boolean;
  /** decoded body prefix (≤ maxBodyBytes), for content assertions only — never persisted */
  body: Buffer;
  /** unsanitised Location (for a caller that follows redirects itself and re-validates each hop) — never persisted */
  rawLocation: string | null;
}

export interface ProbeResult {
  error: ProbeErrorCode | null;
  errorDetail: string | null;
  /**
   * Why the gateway refused, when it says more than the error code: "EXECUTION_BUDGET" on an EGRESS_RATE_LIMITED
   * refusal means this execution's (and capability kind's) lifetime connection budget is used up — not a
   * concurrency limit or an outage. Null otherwise.
   */
  gatewayRefusal: string | null;
  hops: ProbeHop[];
  final: ProbeResponse | null;
  /** last HTTPS hop's certificate (also present when TLS_INVALID) */
  tls: ProbeTls | null;
  timings: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null; totalMs: number; gatewayMs: number };
  methodUsed: "GET" | "HEAD";
  headFallback: boolean;
}

export interface ProbeOptions {
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  gateway: { url: string; token: (host: string) => string };
  userAgent?: string;
  signal?: AbortSignal;
  /** TEST ONLY: extra trusted CA (fixture PKI). Ignored unless NODE_ENV=test. */
  testCa?: string;
}

const SAFE_HEADERS = ["content-type", "content-length", "cache-control", "server", "age", "via", "x-cache", "retry-after", "content-encoding", "last-modified", "x-robots-tag"];

/** scheme://host[:port]/path, query replaced, no credentials or fragment. */
export function sanitizeUrl(u: string | URL): string {
  try {
    const x = typeof u === "string" ? new URL(u) : u;
    return `${x.protocol}//${x.host}${x.pathname}${x.search ? "?[redacted]" : ""}`.slice(0, 500);
  } catch {
    return "[invalid-url]";
  }
}

class HopError extends Error {
  constructor(readonly code: ProbeErrorCode, detail?: string, readonly refusal: string | null = null) { super(detail ?? code); }
}

const OUTCOME_CODE: Record<string, ProbeErrorCode> = {
  UNAUTHORIZED: "EGRESS_UNAUTHORIZED", RATE_LIMITED: "EGRESS_RATE_LIMITED", DNS_FAILURE: "DNS_FAILURE", NO_ADDRESSES: "NO_ADDRESSES",
  BLOCKED_ADDRESS: "BLOCKED_ADDRESS", BLOCKED_HOST: "BLOCKED_HOST", BLOCKED_PORT: "BLOCKED_PORT", CONNECT_FAILED: "CONNECTION_FAILED",
  TIMEOUT: "CONNECT_TIMEOUT", BAD_REQUEST: "GATEWAY_ERROR",
};

export async function httpProbe(o: ProbeOptions): Promise<ProbeResult> {
  const started = performance.now();
  const deadline = started + o.timeoutMs;
  const hops: ProbeHop[] = [];
  const seen = new Set<string>();
  let tls: ProbeTls | null = null;
  let gatewayMs = 0;
  let method: "GET" | "HEAD" = o.method ?? "GET";
  let headFallback = false;
  const testCa = process.env.NODE_ENV === "test" ? o.testCa : undefined;

  let gatewayRefusal: string | null = null;
  const result = (error: ProbeErrorCode | null, detail: string | null, final: ProbeResponse | null): ProbeResult => {
    const last = [...hops].reverse().find((h) => h.status !== null) ?? hops[hops.length - 1];
    return {
      error, errorDetail: detail, gatewayRefusal, hops, final, tls,
      timings: {
        dnsMs: last?.dnsMs ?? null, connectMs: last?.connectMs ?? null, tlsMs: last?.tlsMs ?? null, ttfbMs: last?.ttfbMs ?? null,
        totalMs: Math.round(performance.now() - started), gatewayMs: Math.round(gatewayMs),
      },
      methodUsed: method, headFallback,
    };
  };

  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    return result("INVALID_TARGET", "unparseable URL", null);
  }
  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return result(redirects ? "INVALID_REDIRECT" : "INVALID_TARGET", `scheme ${url.protocol}`, null);
    if (url.username || url.password) return result(redirects ? "INVALID_REDIRECT" : "INVALID_TARGET", "credentials in URL", null);
    const key = `${method} ${url.protocol}//${url.host}${url.pathname}${url.search}`;
    if (seen.has(key)) return result("REDIRECT_LOOP", sanitizeUrl(url), null);
    seen.add(key);

    const hop: ProbeHop = { url: sanitizeUrl(url), method, status: null, address: null, dnsMs: null, connectMs: null, gatewayMs: null, tlsMs: null, ttfbMs: null, error: null };
    hops.push(hop);
    let res: { response: ProbeResponse; location: string | null };
    try {
      res = await oneHop(url, method, hop, deadline, o, testCa, (t) => { tls = t; }, (ms) => { gatewayMs += ms; });
    } catch (e) {
      const code = e instanceof HopError ? e.code : "PROTOCOL_ERROR";
      if (e instanceof HopError) gatewayRefusal = e.refusal;
      hop.error = code;
      return result(code, e instanceof Error ? e.message.slice(0, 200) : null, null);
    }
    const r = res.response;
    hop.status = r.status;
    // HEAD is unreliable on many servers: confirm anything but a clean 2xx/3xx with GET.
    if (method === "HEAD" && (r.status >= 400)) {
      method = "GET";
      headFallback = true;
      seen.clear();
      redirects--;
      continue;
    }
    if (r.status >= 300 && r.status < 400 && res.location !== null && o.maxRedirects > 0) {
      if (redirects >= o.maxRedirects) return result("TOO_MANY_REDIRECTS", `limit ${o.maxRedirects}`, r);
      try {
        url = new URL(res.location, url);
      } catch {
        return result("INVALID_REDIRECT", "unparseable Location", r);
      }
      if (r.status === 303) method = "GET";
      continue;
    }
    return result(null, null, r);
  }
}

async function oneHop(
  url: URL, method: "GET" | "HEAD", hop: ProbeHop, deadline: number, o: ProbeOptions, testCa: string | undefined,
  onTls: (t: ProbeTls) => void, onGateway: (ms: number) => void,
): Promise<{ response: ProbeResponse; location: string | null }> {
  const https = url.protocol === "https:";
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || (https ? 443 : 80));
  const gw = new URL(o.gateway.url);
  const sockets: Duplex[] = [];
  let tunnelUp = false;
  let timer: NodeJS.Timeout | undefined;
  // Innermost first: destroying a socket before the TLS socket wrapping it crashes Node 25 (native).
  const destroyAll = () => { for (const s of [...sockets].reverse()) s.destroy(); };

  const work = new Promise<{ response: ProbeResponse; location: string | null }>((resolve, reject) => {
    const fail = (e: HopError) => { destroyAll(); reject(e); };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return fail(new HopError("RESPONSE_TIMEOUT"));
    timer = setTimeout(() => fail(new HopError(tunnelUp ? "RESPONSE_TIMEOUT" : "CONNECT_TIMEOUT", "probe deadline")), remaining);
    const onAbort = () => fail(new HopError("ABORTED"));
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });

    const t0 = performance.now();
    const req = httpRequest({
      host: gw.hostname, port: Number(gw.port || 80), method: "CONNECT", path: `${host}:${port}`, agent: false,
      headers: { host: `${host}:${port}`, "proxy-authorization": proxyAuthorization(o.gateway.token(host)) },
    });
    req.on("error", (e: NodeJS.ErrnoException) => fail(new HopError("GATEWAY_UNAVAILABLE", e.code ?? e.message)));
    req.on("connect", (cres: IncomingMessage, socket: Duplex, head: Buffer) => {
      sockets.push(socket);
      const ms = performance.now() - t0;
      onGateway(ms);
      hop.gatewayMs = Math.round(ms);
      if (cres.statusCode !== 200) {
        const outcome = String(cres.headers["x-egress-error"] ?? "");
        const refusal = typeof cres.headers["x-egress-refusal"] === "string" ? String(cres.headers["x-egress-refusal"]).slice(0, 40) : null;
        socket.destroy();
        return fail(new HopError(OUTCOME_CODE[outcome] ?? (cres.statusCode === 407 ? "EGRESS_UNAUTHORIZED" : "GATEWAY_ERROR"), `gateway ${cres.statusCode} ${outcome}${refusal ? ` ${refusal}` : ""}`, refusal));
      }
      tunnelUp = true;
      const num = (h: string) => (cres.headers[h] !== undefined && /^\d+$/.test(String(cres.headers[h])) ? Number(cres.headers[h]) : null);
      hop.dnsMs = num("x-egress-dns-ms");
      hop.connectMs = num("x-egress-connect-ms");
      hop.address = typeof cres.headers["x-egress-address"] === "string" ? String(cres.headers["x-egress-address"]).slice(0, 64) : null;
      if (head.length) socket.unshift(head);
      socket.on("error", () => undefined);
      if (!https) return send(socket);
      const tlsStarted = performance.now();
      const ts: TLSSocket = tlsConnect({
        socket, servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"],
        ...(testCa ? { ca: [...rootCertificates, testCa] } : {}),
      });
      sockets.push(ts);
      ts.on("error", (e: NodeJS.ErrnoException) => fail(new HopError("TLS_INVALID", e.code ?? e.message)));
      ts.once("secureConnect", () => {
        hop.tlsMs = Math.round(performance.now() - tlsStarted);
        const cert = ts.getPeerCertificate() as PeerCertificate | Record<string, never>;
        const err = ts.authorizationError ? String((ts.authorizationError as unknown as { code?: string }).code ?? ts.authorizationError) : null;
        const info: ProbeTls = {
          authorized: ts.authorized, error: err,
          validFrom: cert && "valid_from" in cert ? new Date(cert.valid_from).toISOString() : null,
          validTo: cert && "valid_to" in cert ? new Date(cert.valid_to).toISOString() : null,
          issuer: cert && "issuer" in cert && cert.issuer ? String(cert.issuer.O ?? cert.issuer.CN ?? "").slice(0, 120) || null : null,
          protocol: ts.getProtocol(),
          hostnameMatch: err === "ERR_TLS_CERT_ALTNAME_INVALID" ? false : ts.authorized ? true : null,
        };
        onTls(info);
        // Never send a request over a connection a browser would refuse.
        if (!ts.authorized) return fail(new HopError("TLS_INVALID", err ?? "untrusted certificate"));
        send(ts);
      });
    });
    req.end();

    function send(sock: Duplex) {
      const sent = performance.now();
      const r = httpRequest({
        // No agent: with an agent Node would open its own socket (and resolve DNS locally) instead of using the tunnel.
        createConnection: () => sock as never, host, port, method, path: `${url.pathname}${url.search}`,
        headers: {
          host: url.host, "user-agent": o.userAgent ?? "SiteSentinel-Monitor/1.0", accept: "*/*",
          "accept-encoding": "gzip, deflate, br", connection: "close",
        },
      });
      r.on("error", (e: NodeJS.ErrnoException) => fail(new HopError("PROTOCOL_ERROR", e.code ?? e.message)));
      r.on("response", (res: IncomingMessage) => {
        hop.ttfbMs = Math.round(performance.now() - sent);
        const headers: Record<string, string> = {};
        for (const h of SAFE_HEADERS) {
          const v = res.headers[h];
          if (v !== undefined) headers[h] = String(Array.isArray(v) ? v[0] : v).replace(/[\r\n\0]/g, "").slice(0, 200);
        }
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (location) headers.location = (() => { try { return sanitizeUrl(new URL(location, url)); } catch { return "[invalid]"; } })();
        let bytes = 0;
        let truncated = false;
        const parts: Buffer[] = [];
        let decoded = 0;
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const decoder = enc === "gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : null;
        const finish = () => {
          clearTimeout(timer);
          destroyAll();
          resolve({
            response: {
              url: sanitizeUrl(url), status: res.statusCode ?? 0, headers, contentType: headers["content-type"] ?? null,
              bytes, truncated, body: Buffer.concat(parts), rawLocation: location ? location.slice(0, 4096) : null,
            },
            location,
          });
        };
        const keep = (chunk: Buffer) => {
          if (decoded >= o.maxBodyBytes) return;
          const room = o.maxBodyBytes - decoded;
          parts.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          decoded += Math.min(chunk.length, room);
        };
        if (decoder) {
          decoder.on("data", keep);
          decoder.on("error", () => undefined); // a corrupt encoding leaves the body empty; status still counts
        }
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (decoder) decoder.write(chunk); else keep(chunk);
          // Bounded read: stop once enough is held for assertions (and cap wire bytes at 4× that).
          if ((!decoder && decoded >= o.maxBodyBytes) || bytes >= o.maxBodyBytes * 4) {
            truncated = true;
            res.destroy();
            finish();
          }
        });
        res.on("end", () => {
          if (decoder) decoder.end(() => finish()); else finish();
        });
        res.on("error", () => (truncated ? undefined : fail(new HopError("PROTOCOL_ERROR", "response aborted"))));
      });
      r.end();
    }
  });
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    destroyAll();
  }
}
