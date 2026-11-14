import { describe, expect, it } from "vitest";
import {
  BrowserCheckConfig, evaluateBrowser, groupIssues, normalizeErrorMessage, parseBrowserCheckConfig, resolveMonitoringLimits, sameSite,
  viewportsForRun, defaultSettings, type ViewportObservation,
} from "../src/index.js";

const cfg = parseBrowserCheckConfig({});
const perf = { lcpWarnMs: 2500, lcpCritMs: 4000, clsWarn: 0.1, clsCrit: 0.25 };
const ok = (patch: Partial<ViewportObservation> = {}): ViewportObservation => ({
  viewport: "desktop", width: 1366, height: 768, navError: null, mainStatus: 200, finalUrl: "http://a.example/", redirects: 0,
  readiness: { strategy: "load", met: true, ms: 10 }, durationMs: 900,
  rendering: { textLength: 120, meaningfulElements: 3, contentCoverage: 0.4, brokenImages: [], failedStylesheets: 0, failedFonts: 0 },
  scripts: { exceptions: [], rejections: [], consoleErrors: [] },
  network: { failed: [], httpErrors: [], requests: 10, transferBytes: 1000 },
  layout: { overflowPx: 0, offscreenText: 0, firstViewportVisible: true },
  perf: { ttfbMs: 50, fcpMs: 300, lcpMs: 900, cls: 0.01, tbtMs: 0, longTasks: 0, loadMs: 600 }, ...patch,
});
const grp = (message: string, count = 1) => ({ signature: "x", message, count, source: null });

describe("configuration", () => {
  it("safe defaults: GET /, load + bounded settle, 30 s navigation, desktop primary + 1 rotating viewport, failure screenshots only", () => {
    expect(cfg).toMatchObject({ enabled: true, path: "/", readiness: { strategy: "load", settleMs: 1000 }, navigationTimeoutMs: 30_000, primaryViewport: "desktop", extraViewportsPerRun: 1,
      screenshots: { onFailure: true, onSuccess: false, fullPage: false }, consoleErrorsAreFailures: false, thirdPartyFailuresAreFailures: false });
    expect(cfg.viewports).toEqual(["desktop", "mobile-small", "mobile-large", "mobile-landscape", "tablet", "desktop-large"]); // Phase 4F matrix adds landscape
  });
  it("rejects hosts, unknown viewports, unbounded timeouts and unknown keys", () => {
    for (const bad of [{ path: "https://x/" }, { viewports: ["watch"] }, { navigationTimeoutMs: 600_000 }, { readiness: { settleMs: 60_000 } }, { proxy: "x" }]) {
      expect(BrowserCheckConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("viewport policy", () => {
  it("primary every run, others rotate within the per-run cap", () => {
    const all = ["desktop", "mobile-small", "mobile-large", "tablet", "desktop-large"] as const;
    const runs = [0, 1, 2, 3].map((i) => viewportsForRun("desktop", [...all], 1, i));
    expect(runs.every((r) => r[0] === "desktop" && r.length === 2)).toBe(true);
    expect(new Set(runs.map((r) => r[1]))).toEqual(new Set(["mobile-small", "mobile-large", "tablet", "desktop-large"]));
    expect(viewportsForRun("desktop", [...all], 0, 5)).toEqual(["desktop"]);
  });
});

describe("evaluation", () => {
  it.each([
    [[ok()], "PASSED", null, true],
    [[ok({ rendering: { ...ok().rendering!, textLength: 0, meaningfulElements: 0 } })], "FAILED", "BLANK_PAGE", false],
    [[ok({ navError: "NAVIGATION_TIMEOUT", rendering: null, perf: null })], "FAILED", "NAVIGATION_TIMEOUT", false],
    [[ok({ mainStatus: 503 })], "FAILED", "HTTP_503", false],
    [[ok({ mainStatus: 404 })], "PASSED", null, true],
    [[ok({ scripts: { exceptions: [grp("TypeError: x is undefined")], rejections: [], consoleErrors: [] } })], "FAILED", "UNCAUGHT_EXCEPTION", true],
    [[ok({ scripts: { exceptions: [], rejections: [grp("boom")], consoleErrors: [] } })], "FAILED", "UNHANDLED_REJECTION", true],
    [[ok({ scripts: { exceptions: [], rejections: [], consoleErrors: [grp("meh")] } })], "PASSED", null, true],
    [[ok({ network: { ...ok().network, httpErrors: [{ host: "a.example", type: "stylesheet", firstParty: true, error: "HTTP_404", count: 1 }] } })], "FAILED", "STYLESHEET_FAILED", true],
    [[ok({ network: { ...ok().network, httpErrors: [{ host: "cdn.other", type: "script", firstParty: false, error: "HTTP_500", count: 1 }] } })], "PASSED", null, true],
    [[ok({ rendering: { ...ok().rendering!, brokenImages: [{ src: "a/b.png" }] } })], "FAILED", "BROKEN_IMAGES_1", true],
    [[ok({ layout: { overflowPx: 300, offscreenText: 2, firstViewportVisible: true } })], "FAILED", "HORIZONTAL_OVERFLOW_DESKTOP", true],
    [[ok({ layout: { overflowPx: 2, offscreenText: 3, firstViewportVisible: true } })], "PASSED", null, true],
    [[ok({ perf: { ...ok().perf!, lcpMs: 4500 } })], "FAILED", "LCP_POOR", true],
    [[ok({ perf: { ...ok().perf!, lcpMs: 3000 } })], "PASSED", null, true],
    [[ok({ perf: { ...ok().perf!, cls: 0.4 } })], "FAILED", "CLS_POOR", true],
  ] as const)("%# → %s %s", (obs, status, kind, available) => {
    const e = evaluateBrowser([...obs] as ViewportObservation[], cfg, perf);
    expect([e.status, e.failureKind, e.available]).toEqual([status, kind, available]);
  });
  it("warnings never fail the check (console errors, third-party, fonts, heuristics, LCP between warn and critical)", () => {
    const e = evaluateBrowser([ok({ perf: { ...ok().perf!, lcpMs: 3000, cls: 0.15 }, layout: { overflowPx: 0, offscreenText: 2, firstViewportVisible: true }, scripts: { exceptions: [], rejections: [], consoleErrors: [grp("x")] } })], cfg, perf);
    expect(e.status).toBe("PASSED");
    expect(e.warnings.join(" | ")).toMatch(/console error.*heuristic.*LCP 3000.*CLS 0\.150|console error/);
  });
  it("console errors and third-party failures can be configured as failures", () => {
    expect(evaluateBrowser([ok({ scripts: { exceptions: [], rejections: [], consoleErrors: [grp("x")] } })], { ...cfg, consoleErrorsAreFailures: true }, perf).failureKind).toBe("CONSOLE_ERROR");
    expect(evaluateBrowser([ok({ network: { ...ok().network, failed: [{ host: "cdn", type: "script", firstParty: false, error: "x", count: 1 }] } })], { ...cfg, thirdPartyFailuresAreFailures: true }, perf).failureKind).toBe("SCRIPT_FAILED");
  });
  it("infrastructure outcomes are inconclusive (excluded from uptime, never the customer's outage)", () => {
    for (const [k, cat] of [["BROWSER_CRASHED", "BROWSER_INFRASTRUCTURE"], ["BROWSER_UNAVAILABLE", "BROWSER_INFRASTRUCTURE"], ["GATEWAY_UNAVAILABLE", "GATEWAY_INFRASTRUCTURE"], ["EGRESS_UNAUTHORIZED", "SECURITY_REJECTION"]] as const) {
      const e = evaluateBrowser([ok({ navError: k })], cfg, perf);
      expect([e.status, e.available, e.failureCategory]).toEqual(["INCONCLUSIVE", null, cat]);
    }
    const blocked = evaluateBrowser([ok({ navError: "REDIRECTED_OFF_SITE" })], cfg, perf);
    expect([blocked.status, blocked.available, blocked.failureCategory]).toEqual(["FAILED", null, "INVALID_CONFIGURATION"]);
  });
  it("responsive failures are attributed per viewport; performance only judged on the primary viewport", () => {
    const e = evaluateBrowser([ok(), ok({ viewport: "mobile-small", width: 375, height: 812, layout: { overflowPx: 500, offscreenText: 0, firstViewportVisible: true }, perf: { ...ok().perf!, lcpMs: 9000 } })], cfg, perf);
    expect(e.failureKind).toBe("HORIZONTAL_OVERFLOW_MOBILE_SMALL");
    expect(e.verdicts.performance).toBe("PASS");
    expect(e.perViewport).toEqual([{ viewport: "desktop", status: "PASSED", kinds: [] }, { viewport: "mobile-small", status: "FAILED", kinds: ["HORIZONTAL_OVERFLOW_MOBILE_SMALL"] }]);
  });
});

describe("grouping and scope", () => {
  it("normalises volatile parts so one failing script is one group", () => {
    expect(normalizeErrorMessage("Failed to load https://cdn.example.com/a/b.js?v=123 at line 42")).toBe("Failed to load <cdn.example.com> at line N");
    const g = groupIssues(Array.from({ length: 300 }, (_, i) => ({ message: `TypeError: Cannot read properties of undefined (reading 'id') order ${i}` })));
    expect(g).toHaveLength(1);
    expect(g[0]!.count).toBe(300);
  });
  it("same-site means the registrable domain (www/apex/subdomains), never look-alikes", () => {
    expect(sameSite("www.shop.example", "shop.example")).toBe(true);
    expect(sameSite("shop.example", "shop.example")).toBe(true);
    expect(sameSite("evilshop.example", "shop.example")).toBe(false);
    expect(sameSite("shop.example.attacker.com", "shop.example")).toBe(false);
  });
  it("browser entitlement: platform switch AND org entitlement (default off)", () => {
    const s = { ...defaultSettings(), "monitoring.browser.enabled": true };
    expect(resolveMonitoringLimits(s, null, {}).tiers.BROWSER.enabled).toBe(false);
    expect(resolveMonitoringLimits(s, null, { "monitoring.browser.entitled": true }).tiers.BROWSER.enabled).toBe(true);
    expect(resolveMonitoringLimits(s, { "monitoring.browser.entitled": true }, {}).tiers.BROWSER.enabled).toBe(true);
    expect(resolveMonitoringLimits(defaultSettings(), null, { "monitoring.browser.entitled": true }).tiers.BROWSER.enabled).toBe(false);
  });
});
