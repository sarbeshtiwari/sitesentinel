import { describe, expect, it } from "vitest";
import {
  BrowserCheckConfig, classifyAction, compareViewports, dedupeComponents, diffComponents, evaluateBrowser, evaluateFunctional, evaluateLayout,
  parseBrowserCheckConfig, sanitizeDetected, stableJson, urlIsUnsafe, viewportsForRun, VIEWPORT_PRESETS,
  type DetectedComponent, type FunctionalResult, type ViewportObservation,
} from "../src/index.js";

const comp = (type: DetectedComponent["type"], key: string, detail: Record<string, unknown> = {}, visible = true): DetectedComponent =>
  ({ type, key, selector: "#x", label: key, visible, detail, count: 1, rect: null });

describe("action classification and the destructive deny-list", () => {
  it.each([
    ["Buy now", "UNSAFE"], ["Add to cart", "UNSAFE"], ["Checkout", "UNSAFE"], ["Place order", "UNSAFE"], ["Pay €20", "UNSAFE"],
    ["Delete account", "UNSAFE"], ["Remove item", "UNSAFE"], ["Log out", "UNSAFE"], ["Sign out", "UNSAFE"], ["Change password", "UNSAFE"],
    ["Unsubscribe", "UNSAFE"], ["Send message", "UNSAFE"], ["Submit", "UNSAFE"], ["Save changes", "UNSAFE"], ["Subscribe", "UNSAFE"],
    ["Cancel subscription", "UNSAFE"], ["Upload file", "UNSAFE"], ["Confirm", "UNSAFE"],
  ])("click %s → %s", (text, expected) => {
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text, inputType: "button" }).safety).toBe(expected);
  });
  it("toggles and view controls are safe; unrecognisable buttons are not (skipped, never clicked)", () => {
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Show more", inputType: "button", toggles: true }).safety).toBe("SAFE");
    expect(classifyAction({ action: "CLICK", tag: "SUMMARY", text: "Shipping FAQ", toggles: true }).safety).toBe("SAFE");
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Menu", inputType: "button" }).safety).toBe("SAFE");
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "OK", inputType: "button" })).toEqual({ safety: "UNKNOWN", reason: "purpose not recognisable as safe" });
    // a toggle whose label is destructive is still refused (labels win over mechanics)
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Delete", inputType: "button", toggles: true }).safety).toBe("UNSAFE");
  });
  it("submit buttons, submit-by-default buttons in forms, and resets are never clicked", () => {
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Next", inputType: "submit" }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Next", inputType: "", formMethod: "post" }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "CLICK", tag: "INPUT", text: "", inputType: "reset" }).safety).toBe("UNSAFE");
  });
  it("labels hidden in attributes count too (id, name, class, aria-label, title)", () => {
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "×", ariaLabel: "Delete row", inputType: "button", toggles: true }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "→", className: "btn-checkout", inputType: "button" }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "CLICK", tag: "BUTTON", text: "Go", id: "logout_btn", inputType: "button" }).safety).toBe("UNSAFE");
  });
  it("search: GET only; POST search and searches with sensitive fields are refused", () => {
    expect(classifyAction({ action: "SEARCH", tag: "INPUT", formMethod: "get", formAction: "/search" }).safety).toBe("SAFE");
    expect(classifyAction({ action: "SEARCH", tag: "INPUT", formMethod: "post", formAction: "/search" }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "SEARCH", tag: "INPUT", formMethod: "get", sensitiveFields: true }).safety).toBe("UNSAFE");
    expect(classifyAction({ action: "SEARCH", tag: "INPUT", ariaLabel: "Search", formMethod: "get" }).safety).toBe("SAFE");
  });
  it("navigation: unsafe destinations refused; in-page anchors not navigable", () => {
    for (const href of ["/logout", "/account/delete", "/cart?add=1", "/checkout", "/wp-admin/", "/api/items", "/x?action=delete&id=1", "javascript:alert(1)", "mailto:a@b.c"]) {
      expect(classifyAction({ action: "NAVIGATE", tag: "A", text: "Go", href }).safety, href).toBe("UNSAFE");
    }
    expect(classifyAction({ action: "NAVIGATE", tag: "A", text: "Products", href: "/products" }).safety).toBe("SAFE");
    expect(classifyAction({ action: "NAVIGATE", tag: "A", text: "Top", href: "#top" }).safety).toBe("UNKNOWN");
    expect(urlIsUnsafe("/blog/how-to-delete-cookies")).toBe(false);
  });
  it("form validation is never a submission", () => {
    expect(classifyAction({ action: "FORM_VALIDATE", tag: "FORM", formMethod: "post", formAction: "/contact" }).safety).toBe("SAFE");
    expect(classifyAction({ action: "FORM_VALIDATE", tag: "FORM", formMethod: "post", formAction: "/account/delete" }).safety).toBe("UNSAFE");
  });
});

describe("component identity, deduplication and change detection", () => {
  it("validates untrusted detector output and bounds it", () => {
    const raw = [comp("NAV", "nav:header:main"), { type: "EVIL", key: "x" }, { ...comp("BUTTON", "b"), key: "" }, { ...comp("FORM", "f"), detail: { a: "x".repeat(1000), nested: { no: 1 } } }];
    const out = sanitizeDetected(raw);
    expect(out.map((c) => c.type)).toEqual(["NAV", "FORM"]);
    expect(String(out[1]!.detail.a).length).toBe(200);
    expect(out[1]!.detail.nested).toBeUndefined();
    expect(sanitizeDetected("not an array")).toEqual([]);
  });
  it("repeated elements with the same structural key merge (count), not duplicate", () => {
    const d = dedupeComponents([comp("BUTTON", "button:main:add"), comp("BUTTON", "button:main:add"), comp("BUTTON", "button:main:add", {}, false), comp("NAV", "nav")]);
    expect(d).toHaveLength(2);
    expect(d.find((c) => c.type === "BUTTON")).toMatchObject({ count: 3, visible: true });
  });
  it("stable detail hashing ignores key order", () => {
    expect(stableJson({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(stableJson({ a: [1, { x: 1, y: 2 }], b: 1 }));
  });
  it("added, changed, seen; removal only after two complete runs; incomplete runs never count; restore", () => {
    const stored = [
      { id: "1", type: "NAV" as const, key: "nav", detailHash: "h1", status: "PRESENT" as const, missedRuns: 0 },
      { id: "2", type: "SEARCH" as const, key: "search", detailHash: "s", status: "PRESENT" as const, missedRuns: 0 },
      { id: "3", type: "FORM" as const, key: "form", detailHash: "f", status: "REMOVED" as const, missedRuns: 2 },
    ];
    const cur = [{ ...comp("NAV", "nav"), detailHash: "h2" }, { ...comp("FORM", "form"), detailHash: "f" }, { ...comp("BUTTON", "b"), detailHash: "b" }];
    const d1 = diffComponents(stored, cur, true);
    expect(d1.map((c) => c.kind).sort()).toEqual(["ADDED", "CHANGED", "MISSED", "RESTORED"]);
    expect(diffComponents(stored, cur, false).some((c) => c.kind === "MISSED" || c.kind === "REMOVED")).toBe(false); // page didn't load fully
    const again = diffComponents([{ ...stored[1]!, missedRuns: 1 }], [], true);
    expect(again).toEqual([{ kind: "REMOVED", id: "2", missedRuns: 2 }]);
  });
});

describe("responsive matrix", () => {
  it("adds a landscape phone; covers every configured viewport in rotation", () => {
    expect(VIEWPORT_PRESETS["mobile-landscape"]).toEqual({ width: 844, height: 390, mobile: true });
    const cfg = parseBrowserCheckConfig({});
    expect(cfg.viewports).toHaveLength(6);
    const seen = new Set<string>();
    for (let w = 0; w < 5; w++) for (const v of viewportsForRun(cfg.primaryViewport, cfg.viewports, 1, w)) seen.add(v);
    expect(seen.size).toBe(6);
  });
  it("objective findings fail, heuristics only warn", () => {
    const base = { overflowPx: 0, offscreenText: 0, clippedText: 0, overlaps: 0, obscuredControls: 0, offscreenControls: 0, oversizedImages: 0, navState: "VISIBLE" as const, samples: [] };
    expect(evaluateLayout(base).status).toBe("PASSED");
    expect(evaluateLayout({ ...base, clippedText: 3, overlaps: 2, oversizedImages: 1 }).status).toBe("PASSED");
    expect(evaluateLayout({ ...base, navState: "BROKEN" }).status).toBe("FAILED");
    expect(evaluateLayout({ ...base, navState: "MISSING" }).status).toBe("FAILED");
    expect(evaluateLayout({ ...base, obscuredControls: 1 }).status).toBe("FAILED");
    expect(evaluateLayout({ ...base, navState: "COLLAPSED_OK" }).status).toBe("PASSED");
  });
  it("cross-viewport: components that vanish on smaller screens without a working menu", () => {
    const desk = { viewport: "desktop", width: 1366, navState: "VISIBLE" as const, components: [comp("NAV", "nav"), comp("SEARCH", "s"), comp("BUTTON", "b")] };
    expect(compareViewports([desk, { viewport: "mobile-small", width: 375, navState: "COLLAPSED_OK", components: [comp("NAV", "nav", {}, false), comp("SEARCH", "s", { inMenu: true }, false)] }])).toEqual([]);
    // a search hidden on mobile but NOT inside the menu is a real disappearance (found by a 4G test)
    expect(compareViewports([desk, { viewport: "mobile-small", width: 375, navState: "COLLAPSED_OK", components: [comp("NAV", "nav", {}, false), comp("SEARCH", "s", { inMenu: false }, false)] }]).map((x) => x.type)).toEqual(["SEARCH"]);
    const broken = compareViewports([desk, { viewport: "mobile-small", width: 375, navState: "BROKEN", components: [comp("NAV", "nav", {}, false)] }]);
    expect(broken.map((x) => x.type).sort()).toEqual(["NAV", "SEARCH"]);
  });
});

describe("functional verdicts", () => {
  const r = (outcome: FunctionalResult["outcome"], reason: string | null = null, kind: FunctionalResult["kind"] = "SEARCH"): FunctionalResult =>
    ({ kind, componentKey: "k", componentType: "SEARCH", target: "t", viewport: "desktop", outcome, reason, safety: "SAFE", steps: [], durationMs: 1 });
  it("skipped, inconclusive and infrastructure outcomes never fail the website", () => {
    expect(evaluateFunctional([r("SKIPPED", "deny-list: \"buy\""), r("INCONCLUSIVE", "GATEWAY_UNAVAILABLE"), r("PASSED")]).status).toBe("PASSED");
    expect(evaluateFunctional([r("FAILED", "GATEWAY_UNAVAILABLE")]).status).toBe("NONE");
    expect(evaluateFunctional([r("SKIPPED", "x")]).status).toBe("NONE");
    expect(evaluateFunctional([r("PASSED"), r("FAILED", "SEARCH_HTTP_500")]).status).toBe("FAILED");
  });
  it("evaluateBrowser: a functional failure fails the check with its own class", () => {
    const o: ViewportObservation = { viewport: "desktop", width: 1366, height: 768, navError: null, mainStatus: 200, finalUrl: "http://x/", redirects: 0, readiness: { strategy: "load", met: true, ms: 1 }, durationMs: 1,
      rendering: { textLength: 100, meaningfulElements: 3, contentCoverage: 0.5, brokenImages: [], failedStylesheets: 0, failedFonts: 0 }, scripts: { exceptions: [], rejections: [], consoleErrors: [] },
      network: { failed: [], httpErrors: [], requests: 1, transferBytes: 1 }, layout: { overflowPx: 0, offscreenText: 0, firstViewportVisible: true }, perf: null };
    const cfg = BrowserCheckConfig.parse({});
    const perf = { lcpWarnMs: 2500, lcpCritMs: 4000, clsWarn: 0.1, clsCrit: 0.25 };
    expect(evaluateBrowser([o], cfg, perf, [r("PASSED")]).status).toBe("PASSED");
    const ev = evaluateBrowser([o], cfg, perf, [r("FAILED", "SEARCH_HTTP_500")]);
    expect(ev).toMatchObject({ status: "FAILED", failureKind: "FUNCTIONAL_SEARCH", available: true });
    expect(evaluateBrowser([{ ...o, layout: { ...o.layout!, navState: "BROKEN" } }], cfg, perf).failureKind).toBe("NAV_BROKEN_DESKTOP");
  });
  it("functional tests are opt-in; detection is on by default", () => {
    const cfg = parseBrowserCheckConfig({});
    expect(cfg.functional.enabled).toBe(false);
    expect(cfg.components.detect).toBe(true);
    expect(BrowserCheckConfig.safeParse({ functional: { searchQuery: "<script>" } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- Phase 4G performance policy
import {
  classifyPerf, compareWindows, DEFAULT_PERF_THRESHOLDS, effectivePerfThresholds, histogramOf, histPercentile, mergeHistograms, PerformanceConfig, worstPerfStatus,
} from "../src/index.js";

describe("performance thresholds and status", () => {
  it("classifies good / needs improvement / poor / insufficient data on the bounds", () => {
    const b = DEFAULT_PERF_THRESHOLDS.lcp;
    expect(classifyPerf(2500, b)).toBe("GOOD");
    expect(classifyPerf(2501, b)).toBe("NEEDS_IMPROVEMENT");
    expect(classifyPerf(4000, b)).toBe("NEEDS_IMPROVEMENT");
    expect(classifyPerf(4001, b)).toBe("POOR");
    expect(classifyPerf(null, b)).toBe("INSUFFICIENT_DATA");
    expect(worstPerfStatus(["GOOD", "INSUFFICIENT_DATA", "NEEDS_IMPROVEMENT"])).toBe("NEEDS_IMPROVEMENT");
    expect(worstPerfStatus(["INSUFFICIENT_DATA"])).toBe("INSUFFICIENT_DATA");
  });
  it("validates thresholds server-side: good < poor, bounded, strict keys", () => {
    expect(PerformanceConfig.safeParse({ thresholds: { lcp: { good: 3000, poor: 2000 } } }).success).toBe(false);
    expect(PerformanceConfig.safeParse({ thresholds: { lcp: { good: 1000, poor: 600_000 } } }).success).toBe(false);
    expect(PerformanceConfig.safeParse({ thresholds: { inp: { good: 1, poor: 2 } } }).success).toBe(false); // INP is never synthetic
    expect(PerformanceConfig.safeParse({ thresholds: { tbt: { good: 100, poor: 300 } }, alertOn: ["tbt"], consecutiveFailures: 3 }).success).toBe(true);
  });
  it("customer thresholds apply only with the entitlement; legacy LCP/CLS keys still work", () => {
    const cfg = PerformanceConfig.parse({ thresholds: { ttfb: { good: 100, poor: 200 } }, lcpCritMs: 3000 });
    expect(effectivePerfThresholds(DEFAULT_PERF_THRESHOLDS, cfg, false)).toEqual(DEFAULT_PERF_THRESHOLDS);
    const eff = effectivePerfThresholds(DEFAULT_PERF_THRESHOLDS, cfg, true);
    expect(eff.ttfb).toEqual({ good: 100, poor: 200 });
    expect(eff.lcp).toEqual({ good: 2500, poor: 3000 });
  });
});

describe("trends and rollup histograms", () => {
  it("histogram percentiles are within ±6 % of exact, and merge losslessly in count", () => {
    const vals = Array.from({ length: 500 }, (_, i) => 200 + ((i * 7919) % 3000));
    const sorted = [...vals].sort((a, b) => a - b);
    const exact = (q: number) => sorted[Math.ceil(q * sorted.length) - 1]!;
    const h = histogramOf("lcp", vals);
    for (const q of [0.5, 0.75, 0.95]) expect(Math.abs(histPercentile("lcp", h, q)! - exact(q)) / exact(q)).toBeLessThan(0.06);
    const merged = mergeHistograms([histogramOf("lcp", vals.slice(0, 200)), histogramOf("lcp", vals.slice(200))]);
    expect(merged).toEqual(h);
    expect(histPercentile("cls", histogramOf("cls", [0, 0, 0.05, 0.3]), 0.5)).toBe(0);
    expect(histPercentile("lcp", {}, 0.5)).toBeNull();
  });
  it("regression needs enough samples on both sides and a meaningful change", () => {
    const b = DEFAULT_PERF_THRESHOLDS.lcp;
    expect(compareWindows("lcp", { p75: 3000, n: 2 }, { p75: 1500, n: 20 }, b).change).toBe("INSUFFICIENT_DATA");
    expect(compareWindows("lcp", { p75: 3000, n: 20 }, { p75: 1500, n: 20 }, b)).toEqual({ change: "REGRESSION", deltaPct: 100 });
    expect(compareWindows("lcp", { p75: 1500, n: 20 }, { p75: 3000, n: 20 }, b).change).toBe("IMPROVEMENT");
    expect(compareWindows("lcp", { p75: 1530, n: 20 }, { p75: 1500, n: 20 }, b).change).toBe("STABLE");
    expect(compareWindows("lcp", { p75: 220, n: 20 }, { p75: 180, n: 20 }, b).change).toBe("STABLE"); // +22 % but below the 50 ms floor
  });
});

describe("Phase 4G: GET is not harmless — stricter destination rules", () => {
  it.each(["/newsletter/confirm?id=1", "/email/verify?token=x", "/items/5?add-to-cart=1", "/p?vote=1", "/invite/accept", "/orders/7/approve", "/files/report/download", "/x?action=add", "/u?sig=abc"])("%s is unsafe", (u) => {
    expect(urlIsUnsafe(u)).toBe(true);
  });
  it.each(["/products", "/blog/how-to-add-colour", "/about-us", "/search?q=confirm"])("%s stays allowed", (u) => {
    expect(urlIsUnsafe(u)).toBe(false);
  });
});
