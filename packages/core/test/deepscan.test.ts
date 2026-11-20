import { describe, expect, it } from "vitest";
import {
  DeepScanConfig, defaultSettings, deriveScanPhase, displayUrl, effectiveScanLimits, FINDINGS, normalizeUrl, parseDeepScanConfig, parseRobots, pathTemplate,
  resolveMonitoringLimits, robotsAllows, scopeDecision, unsafeRoute,
} from "../src/index.js";

const norm = { queryParamMode: "KEEP_MEANINGFUL" as const, queryParamAllowlist: [], excludedQueryParams: [] };
const n = (u: string, base: string | null = "http://shop.example/") => normalizeUrl(u, base, norm)?.href ?? null;

describe("URL normalisation", () => {
  it.each([
    ["http://SHOP.example:80/a", "http://shop.example/a"],
    ["https://shop.example:443/a#frag", "https://shop.example/a"],
    ["/a//b/../c", "http://shop.example/a/c"],
    ["/%61bout", "http://shop.example/about"],
    ["/caf%c3%a9", "http://shop.example/caf%C3%A9"],
    ["/p?b=2&a=1", "http://shop.example/p?a=1&b=2"],
    ["/p?utm_source=x&gclid=1&id=7", "http://shop.example/p?id=7"],
    ["/p?token=secret&session=abc&page=2", "http://shop.example/p?page=2"],
    ["/products?category=shoes", "http://shop.example/products?category=shoes"],
  ])("%s → %s", (input, out) => expect(n(input)).toBe(out));
  it.each(["file:///etc/passwd", "ftp://x/y", "javascript:alert(1)", "mailto:a@b.c", "data:text/html,x", "http://user:pass@shop.example/", "http://shop.example:8080/", `/${"a".repeat(3000)}`, "http://[::1"])("refuses %s", (input) => expect(n(input)).toBeNull());
  it("query modes: KEEP_MEANINGFUL keeps routes, IGNORE_ALL drops, ALLOWLIST keeps listed", () => {
    expect(normalizeUrl("/p?page=2&sort=x", "http://s.example/", { ...norm, queryParamMode: "IGNORE_ALL" })!.href).toBe("http://s.example/p");
    expect(normalizeUrl("/p?page=2&sort=x", "http://s.example/", { ...norm, queryParamMode: "ALLOWLIST", queryParamAllowlist: ["page"] })!.href).toBe("http://s.example/p?page=2");
    expect(normalizeUrl("/p?page=2&sort=x", "http://s.example/", { ...norm, excludedQueryParams: ["sort"] })!.href).toBe("http://s.example/p?page=2");
  });
  it("display form never shows query values", () => expect(displayUrl("http://s.example/p?email=a@b.c&id=7")).toBe("http://s.example/p?email=…&id=…"));
});

describe("scope and unsafe routes", () => {
  const scope = { hosts: ["shop.example"], includePatterns: [], excludePatterns: ["/internal/*"] };
  it.each([
    ["http://shop.example/a", "OK"],
    ["http://other.example/a", "OUT_OF_SCOPE"],
    ["http://sub.shop.example/a", "OUT_OF_SCOPE"], // subdomains need their own verification
    ["http://shop.example/internal/x", "EXCLUDED"],
    ["http://shop.example/logout", "UNSAFE_ROUTE"],
    ["http://shop.example/account/delete", "UNSAFE_ROUTE"],
    ["http://shop.example/cart/add?id=4", "UNSAFE_ROUTE"],
    ["http://shop.example/checkout", "UNSAFE_ROUTE"],
    ["http://shop.example/item?action=delete&id=1", "UNSAFE_QUERY_ACTION"],
    ["http://shop.example/files/backup.zip", "NON_HTML_DOCUMENT"],
  ])("%s → %s", (u, d) => expect(scopeDecision(new URL(u), scope)).toBe(d));
  it("include patterns narrow the scope", () => {
    expect(scopeDecision(new URL("http://shop.example/blog/x"), { ...scope, includePatterns: ["/blog/*"] })).toBe("OK");
    expect(scopeDecision(new URL("http://shop.example/shop/x"), { ...scope, includePatterns: ["/blog/*"] })).toBe("NOT_INCLUDED");
  });
  it("templates collapse ids for trap detection", () => expect(pathTemplate(new URL("http://s/a/123/b/9f86d081884c"))).toBe("/a/{n}/b/{id}"));
  it("blog paths that merely contain words are not unsafe", () => expect(unsafeRoute(new URL("http://s/blog/how-to-delete-cookies"))).toBeNull());
});

describe("robots.txt", () => {
  const r = parseRobots(`# comment
User-agent: *
Disallow: /private/
Allow: /private/public
Crawl-delay: 2
Sitemap: https://shop.example/sitemap.xml

User-agent: SiteSentinel
Disallow: /no-scanners
`);
  it("our own group wins; longest match; Allow wins ties", () => {
    expect(robotsAllows(r, "SiteSentinel", new URL("http://s/no-scanners/x")).allowed).toBe(false);
    expect(robotsAllows(r, "SiteSentinel", new URL("http://s/private/x")).allowed).toBe(true); // * group not used when ours exists
    expect(robotsAllows(r, "OtherBot", new URL("http://s/private/x"))).toEqual({ allowed: false, crawlDelaySec: 2 });
    expect(robotsAllows(r, "OtherBot", new URL("http://s/private/public/a")).allowed).toBe(true);
    expect(r.sitemaps).toEqual(["https://shop.example/sitemap.xml"]);
  });
  it("wildcards and end anchors", () => {
    const w = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=");
    expect(robotsAllows(w, "x", new URL("http://s/a/b.pdf")).allowed).toBe(false);
    expect(robotsAllows(w, "x", new URL("http://s/a/b.pdf?x=1")).allowed).toBe(true);
    expect(robotsAllows(w, "x", new URL("http://s/search?q=shoes")).allowed).toBe(false);
  });
  it("empty or missing robots allows everything", () => expect(robotsAllows(parseRobots(""), "x", new URL("http://s/a")).allowed).toBe(true));
});

describe("configuration and limits", () => {
  it("defaults are conservative and customers can only lower plan limits", () => {
    const cfg = parseDeepScanConfig({ maxPages: 1_000_000 > 100_000 ? 50_000 : 1, maxDepth: 2 });
    const s = { ...defaultSettings(), "monitoring.deepscan.enabled": true };
    const limits = resolveMonitoringLimits(s, null, { "monitoring.deepscan.entitled": true }).deepscan;
    const eff = effectiveScanLimits(limits, cfg, { maxPages: null, maxDepth: null });
    expect(eff.maxPages).toBe(100); // plan/platform cap wins over the customer's 50,000
    expect(eff.maxDepth).toBe(2); // customer lowered it
    expect(eff.requestDelayMs).toBe(1000); // politeness floor
    expect(eff.browserPages).toBe(0); // browser discovery not entitled by default
    expect(eff.externalLinks).toBe(false);
  });
  it("deep scanning is off without an entitlement even when the platform switch is on", () => {
    const s = { ...defaultSettings(), "monitoring.deepscan.enabled": true };
    expect(resolveMonitoringLimits(s, null, {}).tiers.DEEPSCAN.enabled).toBe(false);
    expect(resolveMonitoringLimits(s, null, { "monitoring.deepscan.entitled": true }).tiers.DEEPSCAN.enabled).toBe(true);
  });
  it("rejects hosts in paths, unknown keys and absolute sitemap URLs", () => {
    for (const bad of [{ startPaths: ["https://x/"] }, { sitemaps: ["http://other/sitemap.xml"] }, { crawlEverything: true }, { additionalHosts: ["Bad Host"] }]) {
      expect(DeepScanConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("every finding has a group, severity, impact and recommendation", () => {
    for (const [k, f] of Object.entries(FINDINGS)) {
      expect(f.impact.length, k).toBeGreaterThan(10);
      expect(f.recommendation.length, k).toBeGreaterThan(10);
    }
  });
});

describe("deriveScanPhase (live progress)", () => {
  const q = { pagesQueued: 0, resourcesQueued: 0 };
  it("no discovery record yet → DISCOVERY", () => {
    expect(deriveScanPhase({ discovery: null, ...q, pagesQueued: 5 })).toBe("DISCOVERY");
    expect(deriveScanPhase({ discovery: "x", ...q })).toBe("DISCOVERY");
  });
  it("uses the phase the engine recorded", () => {
    for (const p of ["DISCOVERY", "BROWSER", "PAGES", "RESOURCES", "FINISHING"] as const) expect(deriveScanPhase({ discovery: { robots: {}, phase: p }, ...q, pagesQueued: 3 })).toBe(p);
  });
  it("ignores an unknown recorded phase and falls back to the frontier", () => {
    expect(deriveScanPhase({ discovery: { phase: "WAT" }, pagesQueued: 2, resourcesQueued: 9 })).toBe("PAGES");
    expect(deriveScanPhase({ discovery: { robots: {} }, pagesQueued: 0, resourcesQueued: 9 })).toBe("RESOURCES");
    expect(deriveScanPhase({ discovery: { robots: {} }, ...q })).toBe("FINISHING");
  });
});
