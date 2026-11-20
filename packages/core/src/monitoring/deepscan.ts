import { z } from "zod";

/**
 * Tier C deep-scan policy (Phase 4E). Pure functions: URL normalisation and scope, unsafe-route rules,
 * robots.txt, the finding catalogue. The worker does I/O; this module decides what is allowed and what it means.
 */

// ---------------------------------------------------------------- configuration
/** The harmless term every search the scanner makes uses (static GET search-form probes and JavaScript search boxes). */
export const SEARCH_PROBE_TERM = "test";

export const DeepScanConfig = z.object({
  /** customer pause (schedule paused; a running scan stops) */
  paused: z.boolean().default(false),
  startPaths: z.array(z.string().max(500).regex(/^\/(?!\/)[^\s\\#]*$/)).min(1).max(20).default(["/"]),
  /** extra sitemap paths on the website itself (absolute URLs to other hosts are not accepted) */
  sitemaps: z.array(z.string().max(500).regex(/^\/(?!\/)[^\s\\#]*$/)).max(10).default([]),
  /** additional hosts: each must be a separately verified, active website of the same organisation */
  additionalHosts: z.array(z.string().max(253).regex(/^[a-z0-9.-]+$/)).max(10).default([]),
  maxPages: z.number().int().min(1).max(100_000).optional(),
  maxDepth: z.number().int().min(0).max(50).optional(),
  maxDurationSec: z.number().int().min(30).max(86_400).optional(),
  requestDelayMs: z.number().int().min(0).max(60_000).optional(),
  includePatterns: z.array(z.string().min(1).max(200)).max(50).default([]),
  excludePatterns: z.array(z.string().min(1).max(200)).max(50).default([]),
  excludedQueryParams: z.array(z.string().min(1).max(100)).max(50).default([]),
  queryParamMode: z.enum(["KEEP_MEANINGFUL", "IGNORE_ALL", "ALLOWLIST"]).default("KEEP_MEANINGFUL"),
  queryParamAllowlist: z.array(z.string().min(1).max(100)).max(50).default([]),
  respectRobots: z.boolean().default(true),
  checkResources: z.boolean().default(true),
  /** off by default; only the status of external links is checked (HEAD, never followed, separate quota) */
  checkExternalLinks: z.boolean().default(false),
  browserDiscovery: z.boolean().default(false),
  severityOverrides: z.record(z.string(), z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"])).default({}),
  /** finding groups that open incidents (others stay findings) */
  incidentGroups: z.array(z.enum(["broken_pages", "broken_resources", "sitemap", "seo", "accessibility"])).default(["broken_pages", "broken_resources"]),
}).strict();
export type DeepScanConfig = z.infer<typeof DeepScanConfig>;

export function parseDeepScanConfig(raw: unknown): DeepScanConfig {
  const r = DeepScanConfig.safeParse(raw ?? {});
  return r.success ? r.data : DeepScanConfig.parse({});
}

/** Platform/plan limits (entitlement ⊕ settings); customer values can only reduce them. */
export interface DeepScanLimits {
  maxPages: number;
  maxDepth: number;
  maxDurationSec: number;
  minRequestDelayMs: number;
  maxRequests: number;
  maxResponseBytes: number;
  pagesPerDay: number;
  browserPages: number;
  externalLinks: boolean;
  maxExternalLinks: number;
  maxConcurrentScans: number;
}

export function effectiveScanLimits(l: DeepScanLimits, c: DeepScanConfig, columns: { maxPages?: number | null; maxDepth?: number | null }) {
  const lower = (cap: number, ...v: Array<number | null | undefined>) => Math.min(cap, ...v.filter((x): x is number => typeof x === "number"));
  return {
    maxPages: lower(l.maxPages, c.maxPages, columns.maxPages),
    maxDepth: lower(l.maxDepth, c.maxDepth, columns.maxDepth),
    maxDurationSec: lower(l.maxDurationSec, c.maxDurationSec),
    requestDelayMs: Math.max(l.minRequestDelayMs, c.requestDelayMs ?? 0),
    maxRequests: l.maxRequests,
    maxResponseBytes: l.maxResponseBytes,
    pagesPerDay: l.pagesPerDay,
    browserPages: c.browserDiscovery ? l.browserPages : 0,
    externalLinks: c.checkExternalLinks && l.externalLinks,
    maxExternalLinks: l.maxExternalLinks,
  };
}
export type EffectiveScanLimits = ReturnType<typeof effectiveScanLimits>;

// ---------------------------------------------------------------- URL normalisation and scope
const TRACKING = /^(utm_[a-z]+|gclid|dclid|fbclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src|spm|_hsenc|_hsmi|mkt_tok)$/i;
/** parameters whose values look like secrets: never stored, never crawled with */
const SENSITIVE = /^(token|access_token|id_token|auth|authorization|session|sessionid|sid|jsessionid|phpsessid|key|api_key|apikey|secret|password|passwd|pwd|code|state|signature|sig|otp)$/i;

export interface UrlNormalizeOptions {
  queryParamMode: DeepScanConfig["queryParamMode"];
  queryParamAllowlist: string[];
  excludedQueryParams: string[];
  /** Same-website host rewrites (e.g. example.com → www.example.com when the site serves itself from www). */
  hostAliases?: Record<string, string>;
}

/**
 * Canonical crawl form: http(s) only, lower-case scheme and host, default port removed, fragment removed,
 * percent-encoding normalised, dot segments resolved, duplicate slashes collapsed, query parameters sorted with
 * tracking/sensitive/excluded ones removed. Query parameters are KEPT by default (they can be distinct pages).
 * Returns null for anything that must never be fetched.
 */
export function normalizeUrl(raw: string, base: string | URL | null, o: UrlNormalizeOptions): URL | null {
  let u: URL;
  try {
    u = base ? new URL(raw.trim(), base) : new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && !((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443"))) {
    // non-default ports are out of policy (the gateway allows 80/443 only)
    return null;
  }
  if (raw.length > 2048) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  const alias = o.hostAliases?.[u.hostname];
  if (alias) u.hostname = alias;
  // percent-encoding: decode unreserved characters, upper-case the rest
  let path = u.pathname.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => {
    const c = String.fromCharCode(parseInt(h, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${h.toUpperCase()}`;
  });
  path = path.replace(/\/{2,}/g, "/");
  u.pathname = path;
  const params = [...u.searchParams.entries()].filter(([k]) => {
    if (TRACKING.test(k) || SENSITIVE.test(k)) return false;
    if (o.excludedQueryParams.some((x) => x.toLowerCase() === k.toLowerCase())) return false;
    if (o.queryParamMode === "IGNORE_ALL") return false;
    if (o.queryParamMode === "ALLOWLIST") return o.queryParamAllowlist.includes(k);
    return true;
  }).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u;
}

/** Display/evidence form: sensitive and all query VALUES redacted. */
export function displayUrl(u: string | URL): string {
  try {
    const x = typeof u === "string" ? new URL(u) : u;
    const q = [...x.searchParams.keys()];
    return `${x.protocol}//${x.host}${x.pathname}${q.length ? `?${q.map((k) => `${encodeURIComponent(k)}=…`).join("&")}` : ""}`.slice(0, 600);
  } catch {
    return "[invalid-url]";
  }
}

/** Conservative exclusions: GET is not assumed harmless. Matches path segments and action-like query parameters. */
const UNSAFE_PATH = /(^|\/)(log-?out|sign-?out|logoff|delete|destroy|remove|unsubscribe|deactivate|cancel(-subscription)?|checkout|payment|pay|purchase|buy|order\/(confirm|place|submit)|cart\/(add|remove|update|clear|empty)|account\/(delete|close|deactivate)|subscription\/cancel|admin|wp-admin|wp-login\.php|reset-password|confirm-email|verify|oauth|callback|api)(\/|$|\.)/i;
const UNSAFE_QUERY = /(^|&)(action|do|cmd|op)=(delete|remove|destroy|logout|signout|cancel|purchase|pay|confirm|approve|reject|unsubscribe)(&|$)/i;

export function unsafeRoute(u: URL): string | null {
  if (UNSAFE_PATH.test(u.pathname)) return "UNSAFE_ROUTE";
  // CDN-internal endpoints (Cloudflare email obfuscation, challenges, insights): not the site's pages; they 404 without JavaScript.
  if (/^\/cdn-cgi\//i.test(u.pathname)) return "CDN_INTERNAL";
  if (UNSAFE_QUERY.test(u.searchParams.toString())) return "UNSAFE_QUERY_ACTION";
  if (/\.(zip|gz|tgz|tar|rar|7z|exe|dmg|pkg|msi|iso|apk|bin|mp4|mov|avi|mkv|mp3|wav|pdf|docx?|xlsx?|pptx?)$/i.test(u.pathname)) return "NON_HTML_DOCUMENT";
  return null;
}

/** Glob-ish patterns: `*` matches within the path; patterns start with "/". */
function patternMatches(pattern: string, path: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}`, "i");
  return re.test(path);
}

export interface Scope { hosts: string[]; includePatterns: string[]; excludePatterns: string[] }

/** In scope = authorized host (exact) + include/exclude rules + not unsafe. Returns the reason when not. */
export function scopeDecision(u: URL, s: Scope): "OK" | "OUT_OF_SCOPE" | "EXCLUDED" | "NOT_INCLUDED" | string {
  if (!s.hosts.includes(u.hostname)) return "OUT_OF_SCOPE";
  const pathAndQuery = `${u.pathname}${u.search}`;
  if (s.excludePatterns.some((p) => patternMatches(p, pathAndQuery))) return "EXCLUDED";
  if (s.includePatterns.length && !s.includePatterns.some((p) => patternMatches(p, pathAndQuery))) return "NOT_INCLUDED";
  return unsafeRoute(u) ?? "OK";
}

/** Path template for trap detection: numeric and hex-ish segments collapse to {n}. */
export function pathTemplate(u: URL): string {
  return u.pathname.split("/").map((seg) => (/^\d+$/.test(seg) ? "{n}" : /^[0-9a-f-]{8,}$/i.test(seg) ? "{id}" : seg)).join("/");
}

// ---------------------------------------------------------------- robots.txt
export interface Robots { groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; crawlDelay: number | null }>; sitemaps: string[] }

export function parseRobots(text: string): Robots {
  const out: Robots = { groups: [], sitemaps: [] };
  let cur: Robots["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "sitemap") { if (val) out.sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], crawlDelay: null }; out.groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") { if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val }); }
    else if (key === "crawl-delay") { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n; }
  }
  return out;
}

/** Group for our user agent ("sitesentinel"), else "*". Longest match wins; Allow wins ties. */
export function robotsAllows(r: Robots, agent: string, u: URL): { allowed: boolean; crawlDelaySec: number | null } {
  const a = agent.toLowerCase();
  const group = r.groups.find((g) => g.agents.some((x) => x !== "*" && a.includes(x))) ?? r.groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, crawlDelaySec: null };
  const path = `${u.pathname}${u.search}`;
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    const re = new RegExp(`^${rule.path.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$")}`);
    if (re.test(path)) {
      const len = rule.path.length;
      if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelaySec: group.crawlDelay };
}

// ---------------------------------------------------------------- findings
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type FindingGroup = "broken_pages" | "broken_resources" | "forms" | "sitemap" | "seo" | "accessibility" | "structure";

export interface FindingSpec { group: FindingGroup; severity: Severity; title: string; impact: string; recommendation: string; method: "HTTP" | "HTML_ANALYSIS" | "SITEMAP" | "ROBOTS" | "BROWSER" | "SEARCH_PROBE" }

export const FINDINGS = {
  BROKEN_PAGE: { group: "broken_pages", severity: "HIGH", title: "Broken internal page", method: "HTTP", impact: "Visitors and search engines following internal links reach an error page.", recommendation: "Restore the page, redirect it to its replacement, or remove links to it." },
  REDIRECT_LOOP: { group: "broken_pages", severity: "HIGH", title: "Redirect loop", method: "HTTP", impact: "The URL never resolves to a page; browsers show an error.", recommendation: "Fix the redirect rules so the chain ends at a page." },
  REDIRECT_CHAIN: { group: "structure", severity: "LOW", title: "Long redirect chain", method: "HTTP", impact: "Each hop adds latency and can lose link equity.", recommendation: "Link and redirect directly to the final URL." },
  REDIRECT_OUT_OF_SCOPE: { group: "structure", severity: "INFO", title: "Internal URL redirects to another site", method: "HTTP", impact: "An internal URL leaves the website; it was not followed.", recommendation: "Confirm the redirect is intended." },
  BROKEN_RESOURCE: { group: "broken_resources", severity: "MEDIUM", title: "Broken first-party resource", method: "HTTP", impact: "Images, styles, scripts or fonts fail to load, degrading or breaking the page.", recommendation: "Restore the file or update the references." },
  BROKEN_EXTERNAL_LINK: { group: "structure", severity: "LOW", title: "Broken external link", method: "HTTP", impact: "A link to another website returns an error.", recommendation: "Update or remove the link." },
  MISSING_TITLE: { group: "seo", severity: "MEDIUM", title: "Missing page title", method: "HTML_ANALYSIS", impact: "Search results and browser tabs show no meaningful title.", recommendation: "Add a unique, descriptive <title>." },
  EMPTY_TITLE: { group: "seo", severity: "MEDIUM", title: "Empty page title", method: "HTML_ANALYSIS", impact: "The <title> element is empty.", recommendation: "Add a unique, descriptive title." },
  DUPLICATE_TITLE: { group: "seo", severity: "LOW", title: "Duplicate page title", method: "HTML_ANALYSIS", impact: "Several pages share one title, making them hard to tell apart in search results.", recommendation: "Give each page a distinct title." },
  MISSING_DESCRIPTION: { group: "seo", severity: "LOW", title: "Missing meta description", method: "HTML_ANALYSIS", impact: "Search engines generate a snippet themselves; not an indexing error.", recommendation: "Add a meta description summarising the page." },
  EMPTY_DESCRIPTION: { group: "seo", severity: "LOW", title: "Empty meta description", method: "HTML_ANALYSIS", impact: "The description tag exists but is empty.", recommendation: "Fill in the description or remove the tag." },
  DUPLICATE_DESCRIPTION: { group: "seo", severity: "LOW", title: "Duplicate meta description", method: "HTML_ANALYSIS", impact: "Several pages share one description.", recommendation: "Write a distinct description per page." },
  MISSING_CANONICAL: { group: "seo", severity: "INFO", title: "No canonical URL declared", method: "HTML_ANALYSIS", impact: "Optional; helps search engines choose between URL variants.", recommendation: "Consider adding <link rel=\"canonical\">, especially for pages reachable under several URLs." },
  INVALID_CANONICAL: { group: "seo", severity: "MEDIUM", title: "Canonical URL problem", method: "HTML_ANALYSIS", impact: "The canonical URL is malformed, points to another site, or to a URL that doesn't return a page.", recommendation: "Point the canonical at the page's own working URL (or its intended primary variant)." },
  MISSING_H1: { group: "seo", severity: "LOW", title: "No H1 heading", method: "HTML_ANALYSIS", impact: "The page has no top-level heading.", recommendation: "Add one H1 describing the page." },
  MULTIPLE_H1: { group: "seo", severity: "INFO", title: "Several H1 headings", method: "HTML_ANALYSIS", impact: "Allowed by HTML, but a single H1 is clearer.", recommendation: "Consider one H1 per page." },
  MISSING_VIEWPORT: { group: "seo", severity: "LOW", title: "No viewport meta tag", method: "HTML_ANALYSIS", impact: "Mobile browsers render the desktop layout zoomed out.", recommendation: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." },
  MISSING_OPEN_GRAPH: { group: "seo", severity: "INFO", title: "No Open Graph metadata", method: "HTML_ANALYSIS", impact: "Shared links show generic previews.", recommendation: "Add og:title, og:description and og:image." },
  INVALID_JSON_LD: { group: "seo", severity: "MEDIUM", title: "Broken structured data (JSON-LD)", method: "HTML_ANALYSIS", impact: "Search engines ignore structured data that doesn't parse.", recommendation: "Fix the JSON syntax of the application/ld+json block." },
  NOINDEX_IN_SITEMAP: { group: "seo", severity: "MEDIUM", title: "Sitemap page marked noindex", method: "HTML_ANALYSIS", impact: "The sitemap asks for indexing while the page asks not to be indexed — one of them is probably unintended.", recommendation: "Remove the noindex directive or remove the page from the sitemap." },
  DUPLICATE_CONTENT: { group: "seo", severity: "LOW", title: "Same content under several URLs", method: "HTML_ANALYSIS", impact: "URL variants serve identical content without a canonical pointing to one of them.", recommendation: "Redirect variants or declare a canonical URL." },
  MISSING_LANG: { group: "accessibility", severity: "MEDIUM", title: "Document language missing", method: "HTML_ANALYSIS", impact: "Screen readers can't choose the right pronunciation.", recommendation: "Add a lang attribute to <html>." },
  IMG_MISSING_ALT: { group: "accessibility", severity: "MEDIUM", title: "Images without alternative text", method: "HTML_ANALYSIS", impact: "Screen-reader users don't know what the image shows.", recommendation: "Add alt text (alt=\"\" for decorative images)." },
  EMPTY_LINK: { group: "accessibility", severity: "MEDIUM", title: "Links without an accessible name", method: "HTML_ANALYSIS", impact: "Assistive technology announces the link without a purpose.", recommendation: "Give the link text or an aria-label." },
  EMPTY_BUTTON: { group: "accessibility", severity: "MEDIUM", title: "Buttons without an accessible name", method: "HTML_ANALYSIS", impact: "Assistive technology can't say what the button does.", recommendation: "Add text, aria-label or aria-labelledby." },
  UNLABELLED_CONTROL: { group: "accessibility", severity: "MEDIUM", title: "Form controls without labels", method: "HTML_ANALYSIS", impact: "Users of assistive technology can't tell what to enter.", recommendation: "Associate a <label for>, wrap in <label>, or add aria-label." },
  HEADING_SKIP: { group: "accessibility", severity: "LOW", title: "Heading levels skipped", method: "HTML_ANALYSIS", impact: "The document outline jumps levels (e.g. H2 → H4).", recommendation: "Use consecutive heading levels." },
  MISSING_MAIN_LANDMARK: { group: "accessibility", severity: "LOW", title: "No main landmark", method: "HTML_ANALYSIS", impact: "Assistive-technology users can't jump to the main content.", recommendation: "Wrap the main content in <main> (or role=\"main\")." },
  DUPLICATE_ID: { group: "accessibility", severity: "LOW", title: "Duplicate element IDs", method: "HTML_ANALYSIS", impact: "Labels and ARIA references can point at the wrong element.", recommendation: "Make id attributes unique." },
  SITEMAP_INVALID: { group: "sitemap", severity: "MEDIUM", title: "Sitemap can't be parsed", method: "SITEMAP", impact: "Search engines and the scanner can't use this sitemap.", recommendation: "Serve valid sitemap XML." },
  SITEMAP_TOO_LARGE: { group: "sitemap", severity: "LOW", title: "Sitemap exceeds limits", method: "SITEMAP", impact: "Sitemaps are limited to 50,000 URLs / 50 MB; part of it was not used.", recommendation: "Split it with a sitemap index." },
  SITEMAP_LOOP: { group: "sitemap", severity: "LOW", title: "Sitemap index loop", method: "SITEMAP", impact: "A sitemap index references itself (directly or indirectly).", recommendation: "Remove the circular reference." },
  SITEMAP_UNREACHABLE: { group: "sitemap", severity: "MEDIUM", title: "Sitemap can't be fetched", method: "SITEMAP", impact: "A declared sitemap returns an error.", recommendation: "Fix the sitemap URL or the robots.txt declaration." },
  SITEMAP_URL_OUT_OF_SCOPE: { group: "sitemap", severity: "LOW", title: "Sitemap lists URLs of another site", method: "SITEMAP", impact: "Those URLs are ignored (not authorised for this website).", recommendation: "List only this website's URLs." },
  SITEMAP_URL_BROKEN: { group: "sitemap", severity: "MEDIUM", title: "Broken URL listed in the sitemap", method: "SITEMAP", impact: "Search engines crawl this sitemap entry and get an error page; no page on the site links to it, so it is most likely an old or renamed address.", recommendation: "Remove the entry from sitemap.xml, or add a 301 redirect from it to the current page (see the suggested page in the evidence)." },
  PAGE_NOT_IN_SITEMAP: { group: "sitemap", severity: "LOW", title: "Linked page missing from the sitemap", method: "SITEMAP", impact: "The page works and is linked on the site, but search engines don't get it from your sitemap, so it may be found or refreshed later than your other pages.", recommendation: "Add the page to sitemap.xml (filter or search URLs with a query string are not reported)." },
  ORPHAN_PAGE: { group: "structure", severity: "LOW", title: "Sitemap page not linked from any other page", method: "HTML_ANALYSIS", impact: "No other page links to it in its HTML, so visitors and crawlers can only reach it from the sitemap or from links built by JavaScript.", recommendation: "Link to it with a normal <a href> from a relevant page (for example a listing or the menu), or remove it from the sitemap if it is no longer used." },
  SITEMAP_BAD_LASTMOD: { group: "sitemap", severity: "INFO", title: "Invalid lastmod dates in sitemap", method: "SITEMAP", impact: "Search engines ignore invalid dates.", recommendation: "Use W3C datetime format." },
  SEARCH_BROKEN: { group: "forms", severity: "HIGH", title: "Site search returns an error", method: "SEARCH_PROBE", impact: "Visitors who search the site get an error page instead of results.", recommendation: "Fix the search results page; the scanner submitted one test query with the site's own search form (GET)." },
  SEARCH_FIELD_UNNAMED: { group: "forms", severity: "LOW", title: "Search box only works with JavaScript", method: "HTML_ANALYSIS", impact: "The search field has no name, so submitting the form without JavaScript sends no query; the scanner can't test it either.", recommendation: "Give the search input a name (e.g. name=\"q\") so the form works without scripts and can be monitored." },
  FORM_INSECURE_ACTION: { group: "forms", severity: "HIGH", title: "Form submits over plain HTTP", method: "HTML_ANALYSIS", impact: "Data typed into this form on a secure page is sent unencrypted.", recommendation: "Point the form action at an https:// URL." },
  PASSWORD_FIELD_INSECURE: { group: "forms", severity: "HIGH", title: "Password field on a page without HTTPS", method: "HTML_ANALYSIS", impact: "Passwords can be read or changed in transit, and browsers warn visitors.", recommendation: "Serve the page over HTTPS only." },
  FORM_NO_SUBMIT: { group: "forms", severity: "LOW", title: "Form without a submit button", method: "HTML_ANALYSIS", impact: "Without JavaScript (or for keyboard and assistive-technology users) the form may not be submittable.", recommendation: "Add a <button type=\"submit\">, or confirm the form is intentionally script-driven." },
  SPA_ROUTE_NOT_IN_HTML: { group: "structure", severity: "INFO", title: "Links only visible after JavaScript", method: "BROWSER", impact: "Some internal links appear only after client-side rendering; crawlers without JavaScript miss them.", recommendation: "Render navigation links server-side or list the routes in the sitemap." },
} as const satisfies Record<string, FindingSpec>;
export type FindingCategory = keyof typeof FINDINGS;

export const FINDING_GROUP_INCIDENTS: Record<FindingGroup, { category: "AVAILABILITY" | "RESOURCE" | "SYSTEM" | "HTTP_ERROR"; severity: Severity; title: string }> = {
  broken_pages: { category: "AVAILABILITY", severity: "HIGH", title: "Broken internal pages found by the deep scan" },
  broken_resources: { category: "RESOURCE", severity: "MEDIUM", title: "Broken resources found by the deep scan" },
  forms: { category: "AVAILABILITY", severity: "MEDIUM", title: "Form or site-search problems found by the deep scan" },
  sitemap: { category: "SYSTEM", severity: "LOW", title: "Sitemap problems found by the deep scan" },
  seo: { category: "HTTP_ERROR", severity: "LOW", title: "SEO metadata issues found by the deep scan" },
  accessibility: { category: "HTTP_ERROR", severity: "LOW", title: "Accessibility issues found by the deep scan (automated checks)" },
  structure: { category: "HTTP_ERROR", severity: "INFO", title: "Site structure issues found by the deep scan" },
};

export const SEVERITY_ORDER: Severity[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function findingSeverity(cat: FindingCategory, overrides: Record<string, Severity>): Severity {
  return overrides[cat] ?? FINDINGS[cat].severity;
}

// ---------------------------------------------------------------- entitlements
export const DEEPSCAN_ENTITLEMENT_KEYS = [
  "monitoring.deepscan.entitled", "monitoring.deepscan.maxWebsites", "monitoring.deepscan.maxPages", "monitoring.deepscan.maxDepth",
  "monitoring.deepscan.maxDurationSec", "monitoring.deepscan.pagesPerDay", "monitoring.deepscan.browserPages", "monitoring.deepscan.externalLinks",
  "monitoring.deepscan.maxConcurrentScans", "monitoring.deepscan.retentionDays",
] as const;

// ---------------------------------------------------------------- live progress of a running scan
export const DEEP_SCAN_PHASES = ["DISCOVERY", "BROWSER", "PAGES", "RESOURCES", "FINISHING"] as const;
export type DeepScanPhase = (typeof DEEP_SCAN_PHASES)[number];

/**
 * The phase of a RUNNING scan. The engine records it in deep_scans.discovery ("phase") at every transition; a scan
 * without it (started before, or a record without the key) falls back to what the frontier shows: no discovery record
 * yet → DISCOVERY, pages still queued → PAGES, resources still queued → RESOURCES, nothing left → FINISHING.
 */
export function deriveScanPhase(i: { discovery: unknown; pagesQueued: number; resourcesQueued: number }): DeepScanPhase {
  if (!i.discovery || typeof i.discovery !== "object") return "DISCOVERY";
  const recorded = (i.discovery as { phase?: unknown }).phase;
  if (typeof recorded === "string" && (DEEP_SCAN_PHASES as readonly string[]).includes(recorded)) return recorded as DeepScanPhase;
  if (i.pagesQueued > 0) return "PAGES";
  if (i.resourcesQueued > 0) return "RESOURCES";
  return "FINISHING";
}
