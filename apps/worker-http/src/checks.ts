import { Parser } from "htmlparser2";
import { normalizeWebsiteUrl, type NormalizeOptions } from "@wim/core";
import { NetguardError, safeFetch, type DnsClient, type NetPolicy } from "@wim/netguard";

export interface CheckContext {
  dns: DnsClient;
  policy: NetPolicy;
  normalize: NormalizeOptions;
  /** Egress gateway for all customer-host traffic (mandatory in production). */
  egress?: { url: string; token: () => string };
}

export interface CheckResult {
  ok: boolean;
  failureReason: string | null;
  detail: Record<string, unknown>;
  /** For DNS: the record was found on the registrable domain itself. */
  rootRecord?: boolean;
}

/** Redirects are followed only within the same website identity (www ↔ apex, http → https). */
export function sameIdentityRedirect(ctx: CheckContext, identity: string) {
  return (_from: URL, to: URL) => {
    try {
      return normalizeWebsiteUrl(`${to.protocol}//${to.hostname}`, ctx.normalize).identityKey === identity;
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------- DNS TXT
/**
 * Every resolver that answered must contain the exact value; at least one must answer.
 * A resolver that answered without the value means the record is missing or still propagating.
 */
export async function checkDnsTxt(ctx: CheckContext, names: { host: string; root: string | null }, value: string): Promise<CheckResult> {
  const tried: Array<Record<string, unknown>> = [];
  for (const [name, isRoot] of [[names.host, false], ...(names.root ? [[names.root, true]] : [])] as Array<[string, boolean]>) {
    const answers = await ctx.dns.txt(name);
    const responded = answers.filter((a) => a.records || a.error === "ENODATA" || a.error === "ENOTFOUND");
    const matched = responded.filter((a) => a.records?.some((r) => r.trim() === value));
    tried.push({
      name,
      resolvers: answers.map((a) => ({ server: a.server, found: Boolean(a.records?.some((r) => r.trim() === value)), error: a.error ?? null, records: a.records?.length ?? 0 })),
    });
    if (responded.length > 0 && matched.length === responded.length) {
      return { ok: true, failureReason: null, detail: { names: tried, matchedName: name }, rootRecord: isRoot };
    }
    if (matched.length > 0) {
      return { ok: false, failureReason: "DNS_PROPAGATING", detail: { names: tried, note: "Some resolvers do not see the record yet" } };
    }
  }
  const anyResponded = tried.some((t) => (t.resolvers as Array<{ error: string | null }>).some((r) => r.error === null || r.error === "ENODATA" || r.error === "ENOTFOUND"));
  return { ok: false, failureReason: anyResponded ? "DNS_RECORD_NOT_FOUND" : "DNS_UNAVAILABLE", detail: { names: tried } };
}

// ---------------------------------------------------------------- HTTP: file and meta
async function fetchSite(ctx: CheckContext, host: string, identity: string, path: string, maxBytes: number) {
  const errors: Array<Record<string, unknown>> = [];
  // HTTPS first; plain HTTP only if HTTPS cannot be reached at all.
  for (const scheme of ["https", "http"]) {
    try {
      const res = await safeFetch(`${scheme}://${host}${path}`, {
        dns: ctx.dns, policy: ctx.policy, egress: ctx.egress, maxBytes, maxRedirects: 3, timeoutMs: 8000,
        allowRedirect: sameIdentityRedirect(ctx, identity), accept: path.endsWith(".txt") ? "text/plain" : "text/html",
      });
      return { res, errors };
    } catch (e) {
      if (e instanceof NetguardError) {
        errors.push({ scheme, code: e.code, message: e.message });
        // Security refusals are final: never fall back to another scheme for a blocked destination.
        if (["BLOCKED_ADDRESS", "BLOCKED_PORT", "BLOCKED_SCHEME", "REDIRECT_NOT_ALLOWED", "TOO_MANY_REDIRECTS", "EGRESS_UNAVAILABLE", "EGRESS_UNAUTHORIZED"].includes(e.code)) {
          return { res: null, errors };
        }
        continue;
      }
      throw e;
    }
  }
  return { res: null, errors };
}

function fetchFailure(errors: Array<Record<string, unknown>>): CheckResult {
  const codes = errors.map((e) => e.code);
  const reason = codes.includes("EGRESS_UNAVAILABLE") || codes.includes("EGRESS_UNAUTHORIZED") ? "SERVICE_UNAVAILABLE"
    : codes.includes("BLOCKED_ADDRESS") ? "BLOCKED_DESTINATION"
    : codes.includes("REDIRECT_NOT_ALLOWED") ? "REDIRECTS_OFF_SITE"
    : codes.includes("NO_ADDRESSES") ? "HOST_NOT_FOUND"
    : "SITE_UNREACHABLE";
  return { ok: false, failureReason: reason, detail: { errors } };
}

export async function checkWellKnownFile(ctx: CheckContext, host: string, identity: string, path: string, value: string): Promise<CheckResult> {
  const { res, errors } = await fetchSite(ctx, host, identity, path, 4096);
  if (!res) return fetchFailure(errors);
  const detail = { url: res.finalUrl, status: res.status, chain: res.chain.map((h) => ({ url: h.url, status: h.status })), errors };
  if (res.status !== 200) return { ok: false, failureReason: `HTTP_${res.status}`, detail };
  // The exact value must be a line of the file; partial matches or HTML pages echoing it don't count.
  const lines = res.body.toString("utf8").split(/\r?\n/).map((l) => l.trim());
  const ok = lines.includes(value);
  return { ok, failureReason: ok ? null : "TOKEN_NOT_FOUND_IN_FILE", detail };
}

export async function checkMetaTag(ctx: CheckContext, host: string, identity: string, metaName: string, token: string): Promise<CheckResult> {
  const { res, errors } = await fetchSite(ctx, host, identity, "/", 512 * 1024);
  if (!res) return fetchFailure(errors);
  const detail = { url: res.finalUrl, status: res.status, chain: res.chain.map((h) => ({ url: h.url, status: h.status })), errors };
  if (res.status !== 200) return { ok: false, failureReason: `HTTP_${res.status}`, detail };
  const found = findMeta(res.body.toString("utf8"), metaName);
  const ok = found.includes(token);
  return { ok, failureReason: ok ? null : found.length ? "META_TOKEN_MISMATCH" : "META_TAG_NOT_FOUND", detail: { ...detail, metaTagsFound: found.length } };
}

/** Content values of <meta name="…"> tags inside <head> (htmlparser2, no script execution). */
export function findMeta(html: string, name: string): string[] {
  const out: string[] = [];
  let inBody = false;
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (tag === "body") inBody = true;
      if (!inBody && tag === "meta" && attrs.name?.toLowerCase() === name.toLowerCase() && typeof attrs.content === "string") out.push(attrs.content.trim());
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  return out;
}

/** <script src> tags pointing at the SDK path, with their data-site-key. */
export function findSdkScripts(html: string, pageUrl: string, sdkUrl: string): Array<{ src: string; siteKey: string | null }> {
  const sdk = new URL(sdkUrl);
  const out: Array<{ src: string; siteKey: string | null }> = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (tag !== "script" || !attrs.src) return;
      try {
        const u = new URL(attrs.src, pageUrl);
        if (u.host === sdk.host && u.pathname.startsWith(sdk.pathname.replace(/\/$/, "") + "/") && /monitor(\.v\d+)?\.js$/.test(u.pathname)) {
          out.push({ src: u.toString(), siteKey: attrs["data-site-key"] ?? null });
        }
      } catch { /* ignore malformed src */ }
    },
  }, { lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  return out;
}

export async function fetchPageForInstallCheck(ctx: CheckContext, host: string, identity: string) {
  return fetchSite(ctx, host, identity, "/", 1024 * 1024);
}
