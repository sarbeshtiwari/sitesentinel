import { gunzipSync } from "node:zlib";
import { displayUrl, normalizeUrl, scopeDecision, type Scope, type UrlNormalizeOptions } from "@wim/core";
import { httpProbe, signCapability } from "@wim/netguard";

/**
 * Gateway-only fetch for the deep scanner. Redirects are followed HERE (the probe makes one hop per call),
 * so every hop is normalised, scope-checked and re-validated by the gateway before it is requested; a hop
 * that leaves the authorised scope is recorded, never fetched.
 */
export interface FetchDeps {
  gatewayUrl: string;
  tokenSecret: string;
  cap: { o: string; w: string; e: string };
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  onRequest: () => void;
  testCa?: string;
}

export interface FetchResult {
  status: number | null;
  error: string | null;
  finalUrl: URL;
  chain: Array<{ url: string; status: number }>;
  outOfScopeRedirect: string | null;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  durationMs: number;
  body: Buffer | null;
  lastModified: string | null;
  xRobots: string | null;
}

export async function fetchChain(start: URL, d: FetchDeps, scope: Scope, norm: UrlNormalizeOptions, opts: { method?: "GET" | "HEAD"; maxRedirects: number; readBody: boolean }): Promise<FetchResult> {
  const t0 = Date.now();
  const chain: FetchResult["chain"] = [];
  const seen = new Set<string>();
  let url = start;
  for (let hop = 0; ; hop++) {
    if (seen.has(url.href)) return done(null, "REDIRECT_LOOP");
    seen.add(url.href);
    d.onRequest();
    const r = await httpProbe({
      url: url.href, method: opts.method ?? "GET", timeoutMs: d.timeoutMs, maxRedirects: 0, maxBodyBytes: opts.readBody ? d.maxBytes : 1024, signal: d.signal,
      userAgent: "SiteSentinel-DeepScan/1.0 (+https://sitesentinel.app/bot)", testCa: d.testCa,
      gateway: { url: d.gatewayUrl, token: (host) => signCapability(d.tokenSecret, { ...d.cap, k: "deepscan", h: host }, 120) },
    });
    if (r.error) return done(null, r.error);
    const f = r.final!;
    const status = f.status;
    if (status >= 300 && status < 400 && r.hops.length) {
      // the raw Location (the stored header is sanitised); it's normalised and scope-checked before any use
      const raw = locationOf(r);
      if (!raw) return done(f, null);
      chain.push({ url: displayUrl(url), status });
      if (hop >= opts.maxRedirects) return done(f, "TOO_MANY_REDIRECTS");
      const next = normalizeUrl(raw, url, norm);
      if (!next) return done(f, "INVALID_REDIRECT");
      const decision = scopeDecision(next, scope);
      if (decision !== "OK") return { ...done(f, null), outOfScopeRedirect: `${decision}:${displayUrl(next)}` };
      url = next;
      continue;
    }
    return done(f, null);

    function done(final: typeof f | null, error: string | null): FetchResult {
      let body = final?.body ?? null;
      let truncated = final?.truncated ?? false;
      // a gzip *file* (e.g. sitemap.xml.gz): decompress with a hard output cap (decompression-bomb safe)
      if (body && opts.readBody && body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
        try { body = gunzipSync(body, { maxOutputLength: d.maxBytes }); } catch { body = null; truncated = true; }
      }
      return {
        status: final?.status ?? null, error, finalUrl: url, chain, outOfScopeRedirect: null,
        contentType: final?.contentType ?? null, bytes: final?.bytes ?? 0, truncated, durationMs: Date.now() - t0, body,
        lastModified: final?.headers["last-modified"] ?? null, xRobots: final?.headers["x-robots-tag"] ?? null,
      };
    }
  }
}

function locationOf(r: Awaited<ReturnType<typeof httpProbe>>): string | null {
  return r.final?.rawLocation ?? null;
}
