import { z } from "zod";
import type { Thresholds, Verdict } from "./http.js";
import { evaluateFunctional, evaluateLayout, FunctionalConfig, type FunctionalResult, type LayoutFacts } from "./components.js";
import { blockingOverlay, describeOverlayItem, PopupConfig, type DialogFacts, type OverlayFacts } from "./overlay.js";
import { classifyPerf, DEFAULT_ALERT_ON, DEFAULT_PERF_THRESHOLDS, PERF_METRIC_INFO, PERF_METRICS, PerformanceConfig, type PerfMetric, type PerfThresholdSet } from "./performance.js";

/**
 * Tier B synthetic browser monitoring policy (Phase 4D). Pure: the engine collects observations
 * in Chromium, these functions decide what they mean. All numbers are SYNTHETIC (one browser,
 * our infrastructure, through the egress gateway) — never real-user measurements; INP is not
 * produced here (it needs real interactions; it comes from the RUM SDK).
 */

// ---------------------------------------------------------------- viewports
export const VIEWPORT_PRESETS = {
  "mobile-small": { width: 375, height: 812, mobile: true },
  "mobile-large": { width: 390, height: 844, mobile: true },
  /** Phase 4F responsive matrix: landscape phone */
  "mobile-landscape": { width: 844, height: 390, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1366, height: 768, mobile: false },
  "desktop-large": { width: 1920, height: 1080, mobile: false },
} as const;
export type ViewportName = keyof typeof VIEWPORT_PRESETS;
const ViewportName = z.enum(Object.keys(VIEWPORT_PRESETS) as [ViewportName, ...ViewportName[]]);

/**
 * Cost-aware viewport policy: the primary viewport every run, plus `extraPerRun` of the others in
 * rotation by window index — every configured viewport is covered every ⌈n/extra⌉ runs, never all at once.
 */
export function viewportsForRun(primary: ViewportName, configured: ViewportName[], extraPerRun: number, windowIndex: number): ViewportName[] {
  const others = [...new Set(configured)].filter((v) => v !== primary);
  if (!others.length || extraPerRun <= 0) return [primary];
  const n = Math.min(extraPerRun, others.length);
  const start = ((windowIndex * n) % others.length + others.length) % others.length;
  return [primary, ...Array.from({ length: n }, (_, i) => others[(start + i) % others.length]!)];
}

// ---------------------------------------------------------------- configuration
export const BrowserCheckConfig = z.object({
  /** per-website opt-out (the organisation must also be entitled and the platform switch on) */
  enabled: z.boolean().default(true),
  path: z.string().max(500).regex(/^\/(?!\/)[^\s\\#]*$/, "must be a path starting with /").default("/"),
  readiness: z.object({
    strategy: z.enum(["load", "domcontentloaded", "networkquiet", "selector", "fixed"]).default("load"),
    selector: z.string().min(1).max(200).optional(),
    /** network quiet window (networkquiet) */
    quietMs: z.number().int().min(100).max(5000).default(500),
    /** bounded extra wait after readiness for late rendering (all strategies; never unbounded) */
    settleMs: z.number().int().min(0).max(10_000).default(1000),
  }).strict().default({ strategy: "load", quietMs: 500, settleMs: 1000 }),
  navigationTimeoutMs: z.number().int().min(5000).max(60_000).default(30_000),
  maxRedirects: z.number().int().min(0).max(20).default(10),
  primaryViewport: ViewportName.default("desktop"),
  /** the responsive matrix: every configured viewport is covered in rotation (see viewportsForRun) */
  viewports: z.array(ViewportName).min(1).max(6).default(["desktop", "mobile-small", "mobile-large", "mobile-landscape", "tablet", "desktop-large"]),
  extraViewportsPerRun: z.number().int().min(0).max(5).default(1),
  /** Phase 4F: passive component detection (read-only, every observed viewport) */
  components: z.object({ detect: z.boolean().default(true) }).strict().default({ detect: true }),
  /**
   * Release readiness (blocker 5): which third-party hosts the page may load from. Enforced by the egress gateway
   * (signed into the per-execution capability), not by page logic. "all" = any public host within a per-execution
   * distinct-host budget (default: real sites need CDNs, fonts, analytics); "allowlist" = only `allowedDomains`;
   * "none" = first party only. The base rules (public addresses only, ports 80/443, rebinding-safe) always apply.
   */
  thirdParty: z.object({
    mode: z.enum(["all", "allowlist", "none"]).default("all"),
    allowedDomains: z.array(z.string().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/, "a domain name such as cdn.example.com")).max(50).default([]),
    maxHosts: z.number().int().min(0).max(500).default(100),
  }).strict().refine((t) => t.mode !== "allowlist" || t.allowedDomains.length > 0, { message: "an allowlist needs at least one domain" })
    .default({ mode: "all", allowedDomains: [], maxHosts: 100 }),
  /** Phase 4F: safe functional tests — interactions are opt-in per website */
  functional: FunctionalConfig.default(FunctionalConfig.parse({})),
  screenshots: z.object({
    onFailure: z.boolean().default(true),
    onSuccess: z.boolean().default(false),
    fullPage: z.boolean().default(false),
    /** extra CSS selectors masked before capture (inputs, password fields etc. are always masked) */
    mask: z.array(z.string().min(1).max(200)).max(20).default([]),
  }).strict().default({ onFailure: true, onSuccess: false, fullPage: false, mask: [] }),
  /** popups / cookie banners on load: closed (privacy-preserving, side-effect-free) before layout and functional checks */
  popups: PopupConfig.default({ dismiss: true, closeSelector: null }),
  consoleErrorsAreFailures: z.boolean().default(false),
  thirdPartyFailuresAreFailures: z.boolean().default(false),
  performance: PerformanceConfig.default({}),
  failureThreshold: z.number().int().min(1).max(20).optional(),
  recoveryThreshold: z.number().int().min(1).max(20).optional(),
}).strict();
export type BrowserCheckConfig = z.infer<typeof BrowserCheckConfig>;

export function parseBrowserCheckConfig(raw: unknown): BrowserCheckConfig {
  const r = BrowserCheckConfig.safeParse(raw ?? {});
  return r.success ? r.data : BrowserCheckConfig.parse({});
}

// ---------------------------------------------------------------- observations (collected by the engine)
export interface GroupedIssue { signature: string; message: string; count: number; source?: string | null }
export interface ResourceIssue { host: string; type: string; firstParty: boolean; error: string; count: number; status?: number | null }

export interface ViewportObservation {
  viewport: ViewportName;
  width: number;
  height: number;
  /** null = navigation succeeded */
  navError: string | null;
  mainStatus: number | null;
  finalUrl: string | null;
  redirects: number;
  readiness: { strategy: string; met: boolean; ms: number };
  durationMs: number;
  rendering: {
    textLength: number;
    meaningfulElements: number;
    contentCoverage: number; // 0..1 of the first viewport covered by visible meaningful elements
    brokenImages: Array<{ src: string }>;
    failedStylesheets: number;
    failedFonts: number;
  } | null;
  scripts: { exceptions: GroupedIssue[]; rejections: GroupedIssue[]; consoleErrors: GroupedIssue[] };
  network: { failed: ResourceIssue[]; httpErrors: ResourceIssue[]; requests: number; transferBytes: number };
  layout: ({ overflowPx: number; offscreenText: number; firstViewportVisible: boolean } & Partial<Omit<LayoutFacts, "overflowPx" | "offscreenText">>) | null;
  perf: { ttfbMs: number | null; fcpMs: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; longTasks: number | null; loadMs: number | null } | null;
  /** popup / cookie banner found after load (measured before any dismissal) and what closing it did; absent = not inspected */
  overlay?: OverlayFacts | null;
  /** JavaScript dialogs (alert / confirm / prompt / beforeunload) the page opened — all dismissed, never accepted */
  dialogs?: DialogFacts | null;
}

// ---------------------------------------------------------------- evaluation
export const BROWSER_CLASSES = ["navigation", "blank", "js", "resource", "image", "layout", "performance", "functional"] as const;
export type BrowserClass = (typeof BROWSER_CLASSES)[number];

export const BROWSER_INCIDENT_CLASSES: Record<BrowserClass, { category: "AVAILABILITY" | "JS_ERROR" | "RESOURCE" | "RESPONSIVE" | "PERFORMANCE" | "FUNCTIONAL"; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; title: string; fixedThreshold?: number }> = {
  navigation: { category: "AVAILABILITY", severity: "CRITICAL", title: "Page failed to load in the browser" },
  blank: { category: "AVAILABILITY", severity: "HIGH", title: "Page renders blank" },
  js: { category: "JS_ERROR", severity: "HIGH", title: "JavaScript errors on page load" },
  resource: { category: "RESOURCE", severity: "MEDIUM", title: "Critical resources failed to load" },
  image: { category: "RESOURCE", severity: "LOW", title: "Broken images" },
  layout: { category: "RESPONSIVE", severity: "MEDIUM", title: "Responsive layout overflow" },
  performance: { category: "PERFORMANCE", severity: "MEDIUM", title: "Synthetic performance below threshold" },
  functional: { category: "FUNCTIONAL", severity: "HIGH", title: "Functional check failed" },
};

export type BrowserFailureCategory = "TARGET_TEMPORARY" | "TARGET_PERMANENT" | "BROWSER_INFRASTRUCTURE" | "GATEWAY_INFRASTRUCTURE" | "SECURITY_REJECTION" | "INVALID_CONFIGURATION";

/** Legacy 4D shape (LCP / CLS only), still accepted by evaluateBrowser. */
export interface PerfThresholds { lcpWarnMs: number; lcpCritMs: number; clsWarn: number; clsCrit: number }
/** Phase 4G: all metrics, and which of them may fail the check. */
export interface PerfEvaluation { thresholds: PerfThresholdSet; alertOn: PerfMetric[] }
function toPerfEvaluation(p: PerfThresholds | PerfEvaluation): PerfEvaluation {
  if ("thresholds" in p) return p;
  return { thresholds: { ...DEFAULT_PERF_THRESHOLDS, lcp: { good: p.lcpWarnMs, poor: p.lcpCritMs }, cls: { good: p.clsWarn, poor: p.clsCrit } }, alertOn: DEFAULT_ALERT_ON };
}

export interface BrowserEvaluation {
  status: "PASSED" | "FAILED" | "INCONCLUSIVE";
  available: boolean | null;
  failureKind: string | null;
  failureCategory: BrowserFailureCategory | null;
  verdicts: Record<BrowserClass, Verdict>;
  kinds: Partial<Record<BrowserClass, string>>;
  /** observations that don't fail the check (heuristics, warnings, third-party noise) */
  warnings: string[];
  perViewport: Array<{ viewport: ViewportName; status: "PASSED" | "FAILED"; kinds: string[] }>;
}

/** Navigation errors that are the target's fault (Chromium net:: codes, plus the probe's classification). */
const NAV_TARGET = /^(DOWNLOAD_REFUSED|NAVIGATION_ABORTED|DNS_FAILURE|NO_ADDRESSES|CONNECTION_FAILED|CONNECT_TIMEOUT|RESPONSE_TIMEOUT|PROTOCOL_ERROR|TLS_INVALID|REDIRECT_LOOP|TOO_MANY_REDIRECTS|NAVIGATION_TIMEOUT|READINESS_TIMEOUT|HTTP_5\d\d|ERR_[A-Z_]+)$/;
const NAV_INFRA = new Set(["GATEWAY_UNAVAILABLE", "EGRESS_RATE_LIMITED", "GATEWAY_ERROR", "BROWSER_CRASHED", "BROWSER_UNAVAILABLE"]);
const NAV_CONFIG = new Set(["BLOCKED_ADDRESS", "BLOCKED_HOST", "BLOCKED_PORT", "INVALID_TARGET", "REDIRECTED_OFF_SITE"]);

export function evaluateBrowser(obs: ViewportObservation[], cfg: BrowserCheckConfig, perfIn: PerfThresholds | PerfEvaluation, functional: FunctionalResult[] = []): BrowserEvaluation {
  const perf = toPerfEvaluation(perfIn);
  const v = Object.fromEntries(BROWSER_CLASSES.map((c) => [c, "UNKNOWN"])) as Record<BrowserClass, Verdict>;
  const kinds: Partial<Record<BrowserClass, string>> = {};
  const warnings: string[] = [];
  const perViewport: BrowserEvaluation["perViewport"] = [];
  const fail = (c: BrowserClass, k: string, vp: string[]) => { v[c] = "FAIL"; kinds[c] ??= k; vp.push(k); };
  const pass = (c: BrowserClass) => { if (v[c] === "UNKNOWN") v[c] = "PASS"; };

  const primary = obs[0];
  if (!primary) return inconclusive("BROWSER_UNAVAILABLE", "BROWSER_INFRASTRUCTURE");
  if (primary.navError === "EGRESS_UNAUTHORIZED") return inconclusive("EGRESS_UNAUTHORIZED", "SECURITY_REJECTION");
  if (primary.navError && NAV_INFRA.has(primary.navError)) {
    return inconclusive(primary.navError, primary.navError.startsWith("BROWSER") ? "BROWSER_INFRASTRUCTURE" : "GATEWAY_INFRASTRUCTURE");
  }
  if (primary.navError && NAV_CONFIG.has(primary.navError)) {
    return { status: "FAILED", available: null, failureKind: primary.navError, failureCategory: "INVALID_CONFIGURATION", verdicts: v, kinds: { navigation: primary.navError }, warnings, perViewport: [{ viewport: primary.viewport, status: "FAILED", kinds: [primary.navError] }] };
  }

  for (const o of obs) {
    const vp: string[] = [];
    // navigation (main document)
    if (o.navError) fail("navigation", NAV_TARGET.test(o.navError) ? o.navError : "NAVIGATION_FAILED", vp);
    else if (o.mainStatus !== null && o.mainStatus >= 500) fail("navigation", `HTTP_${o.mainStatus}`, vp);
    else if (!o.readiness.met && o.readiness.strategy === "selector") fail("navigation", "READINESS_TIMEOUT", vp);
    else {
      pass("navigation");
      if (!o.readiness.met) warnings.push(`${o.viewport}: readiness (${o.readiness.strategy}) not reached within the bound; evaluated what had rendered`);
      if (o.mainStatus !== null && o.mainStatus >= 400) warnings.push(`${o.viewport}: main document HTTP ${o.mainStatus}`);
    }
    if (!o.navError && o.rendering) {
      const r = o.rendering;
      // blank: objective — no visible text and no visible media at all
      if (r.textLength === 0 && r.meaningfulElements === 0) fail("blank", "BLANK_PAGE", vp);
      else {
        pass("blank");
        if (r.contentCoverage < 0.02) warnings.push(`${o.viewport}: very little visible content in the first viewport (heuristic)`);
      }
      if (r.brokenImages.length) fail("image", `BROKEN_IMAGES_${r.brokenImages.length}`, vp);
      else pass("image");
    }
    // JavaScript: uncaught exceptions and unhandled rejections fail; console errors only when configured
    const exc = o.scripts.exceptions.reduce((a, b) => a + b.count, 0) + o.scripts.rejections.reduce((a, b) => a + b.count, 0);
    const con = o.scripts.consoleErrors.reduce((a, b) => a + b.count, 0);
    if (!o.navError) {
      if (exc) fail("js", o.scripts.exceptions.length ? "UNCAUGHT_EXCEPTION" : "UNHANDLED_REJECTION", vp);
      else if (con && cfg.consoleErrorsAreFailures) fail("js", "CONSOLE_ERROR", vp);
      else {
        pass("js");
        if (con) warnings.push(`${o.viewport}: ${con} console error(s)`);
      }
    }
    // resources: first-party scripts/stylesheets/documents (and third-party only when configured)
    if (!o.navError) {
      const critical = [...o.network.failed, ...o.network.httpErrors].filter((x) =>
        (x.firstParty || cfg.thirdPartyFailuresAreFailures) && ["script", "stylesheet", "document"].includes(x.type));
      if (critical.length) fail("resource", `${critical[0]!.type.toUpperCase()}_FAILED`, vp);
      else pass("resource");
      const thirdParty = [...o.network.failed, ...o.network.httpErrors].filter((x) => !x.firstParty);
      if (thirdParty.length) warnings.push(`${o.viewport}: ${thirdParty.length} third-party resource group(s) failed`);
      if (o.rendering?.failedFonts) warnings.push(`${o.viewport}: ${o.rendering.failedFonts} font(s) failed`);
    }
    // layout: objective findings fail the viewport (sideways scroll, unusable navigation, covered or off-screen
    // controls); clipped text, overlaps and off-screen text are heuristics recorded as warnings
    // popups on load: a dismissed overlay (or one the customer chose not to close) is a warning; one we could not close
    // with any safe control blocks real visitors too and fails the viewport — and then explains any covered controls.
    // (Controls covered by a detected overlay that stays open are counted in overlay.coveredControls by the engine, not
    // as obscuredControls, so they are never reported a second time as CONTROLS_OBSCURED.)
    const tag = o.viewport.toUpperCase().replaceAll("-", "_");
    const blocking = o.navError ? null : blockingOverlay(o.overlay);
    if (!o.navError && o.overlay?.found) {
      for (const it of o.overlay.items) if (it !== blocking) warnings.push(`${o.viewport}: ${describeOverlayItem(it)}`);
      if (o.overlay.blockedRequests) warnings.push(`${o.viewport}: ${o.overlay.blockedRequests} request(s) refused by the safety guard while closing the popup`);
    }
    if (!o.navError && o.dialogs?.count) {
      const types = [...new Set(o.dialogs.items.map((d) => d.type))].join(", ");
      const first = o.dialogs.items[0]?.message;
      warnings.push(`${o.viewport}: the page opened ${o.dialogs.count} JavaScript dialog(s) (${types || "dialog"}) — dismissed${first ? `: "${first.slice(0, 120)}"` : ""}`);
    }
    if (blocking) fail("layout", `OVERLAY_BLOCKING_${tag}`, vp);
    if (o.layout) {
      const l = evaluateLayout({ clippedText: 0, overlaps: 0, obscuredControls: 0, offscreenControls: 0, oversizedImages: 0, navState: "NONE", samples: [], ...o.layout });
      if (o.layout.overflowPx > 4) fail("layout", `HORIZONTAL_OVERFLOW_${tag}`, vp);
      else if (o.layout.navState === "BROKEN") fail("layout", `NAV_BROKEN_${tag}`, vp);
      else if (o.layout.navState === "MISSING") fail("layout", `NAV_MISSING_${tag}`, vp);
      else if ((o.layout.obscuredControls ?? 0) > 0 && !blocking) fail("layout", `CONTROLS_OBSCURED_${tag}`, vp);
      else if ((o.layout.offscreenControls ?? 0) > 0) fail("layout", `CONTROLS_OFFSCREEN_${tag}`, vp);
      else if (!blocking) pass("layout");
      for (const h of l.heuristic) warnings.push(`${o.viewport}: ${h} (heuristic)`);
    }
    // performance: critical thresholds fail, warning thresholds only warn (primary viewport only — others aren't comparable)
    // (Phase 4G: every metric is classified; only the metrics in alertOn can fail the check, POOR fails, NEEDS_IMPROVEMENT warns)
    if (o === primary && o.perf && !o.navError) {
      const p = o.perf;
      const values: Record<PerfMetric, number | null> = { fcp: p.fcpMs, lcp: p.lcpMs, cls: p.cls, tbt: p.tbtMs, ttfb: p.ttfbMs, load: p.loadMs };
      let measured = false;
      let failed: PerfMetric | null = null;
      for (const m of PERF_METRICS) {
        const st = classifyPerf(values[m], perf.thresholds[m]);
        if (st === "INSUFFICIENT_DATA") continue;
        const alerting = perf.alertOn.includes(m);
        if (alerting) measured = true;
        const shown = PERF_METRIC_INFO[m].unit === "ms" ? `${values[m]} ms` : values[m]!.toFixed(3);
        if (st === "POOR" && alerting) failed ??= m;
        else if (st !== "GOOD") warnings.push(`${m.toUpperCase()} ${shown} ${st === "POOR" ? "poor" : "needs improvement"} (synthetic)`);
      }
      if (failed) fail("performance", `${failed.toUpperCase()}_POOR`, vp);
      else if (measured) pass("performance");
    }
    // functional tests run on the primary viewport only; skipped / inconclusive tests never fail the check
    if (o === primary && !o.navError && functional.length) {
      const f = evaluateFunctional(functional);
      if (f.status === "FAILED") fail("functional", `FUNCTIONAL_${f.failed[0]!.kind}`, vp);
      else if (f.status === "PASSED") pass("functional");
      if (f.counts.SKIPPED) warnings.push(`${f.counts.SKIPPED} functional test(s) skipped (unsafe or not applicable)`);
      if (f.counts.INCONCLUSIVE) warnings.push(`${f.counts.INCONCLUSIVE} functional test(s) inconclusive`);
    }
    perViewport.push({ viewport: o.viewport, status: vp.length ? "FAILED" : "PASSED", kinds: vp });
  }
  const order: BrowserClass[] = ["navigation", "blank", "js", "resource", "layout", "functional", "image", "performance"];
  const first = order.find((c) => v[c] === "FAIL");
  const down = v.navigation === "FAIL" || v.blank === "FAIL";
  return {
    status: first ? "FAILED" : "PASSED",
    available: !down,
    failureKind: first ? kinds[first]! : null,
    failureCategory: first ? (v.navigation === "FAIL" && /^(HTTP_5|DNS|CONNECT|RESPONSE|ERR_)/.test(kinds.navigation ?? "") ? "TARGET_TEMPORARY" : "TARGET_PERMANENT") : null,
    verdicts: v, kinds, warnings, perViewport,
  };

  function inconclusive(kind: string, category: BrowserFailureCategory): BrowserEvaluation {
    return { status: "INCONCLUSIVE", available: null, failureKind: kind, failureCategory: category, verdicts: v, kinds: {}, warnings, perViewport: [] };
  }
}

// ---------------------------------------------------------------- error grouping
/**
 * Normalise an error message into a stable signature: URLs → host, numbers → N, quoted strings
 * and identifiers' hex/uuid noise removed. One failing third-party script then produces one group,
 * not hundreds of distinct entries.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\bhttps?:\/\/([^/\s'"?#)]+)[^\s'")]*/gi, (_m, host: string) => `<${host.toLowerCase()}>`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "<str>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function groupIssues(items: Array<{ message: string; source?: string | null }>, max = 20): GroupedIssue[] {
  const groups = new Map<string, GroupedIssue>();
  for (const it of items) {
    const norm = normalizeErrorMessage(it.message);
    const sig = `${it.source ?? ""}|${norm}`;
    const g = groups.get(sig);
    if (g) g.count++;
    else groups.set(sig, { signature: fnv(sig), message: norm, count: 1, source: it.source ?? null });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Same registrable site? (the main document may move between www/apex/subdomains, never to another site) */
export function sameSite(host: string, registrableDomain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const r = registrableDomain.toLowerCase();
  return h === r || h.endsWith(`.${r}`);
}

export function describeBrowserFailure(kind: string): string {
  const m = /^HTTP_(\d{3})$/.exec(kind);
  if (m) return `The page returned HTTP ${m[1]}`;
  const b = /^BROKEN_IMAGES_(\d+)$/.exec(kind);
  if (b) return `${b[1]} image${b[1] === "1" ? " is" : "s are"} broken`;
  const o = /^HORIZONTAL_OVERFLOW_(.+)$/.exec(kind);
  if (o) return `The page scrolls horizontally at the ${o[1]!.toLowerCase().replace("_", "-")} viewport`;
  const nav = /^NAV_(BROKEN|MISSING)_(.+)$/.exec(kind);
  if (nav) return nav[1] === "BROKEN" ? `The navigation menu does not open at the ${nav[2]!.toLowerCase().replaceAll("_", "-")} viewport` : `The navigation is not reachable at the ${nav[2]!.toLowerCase().replaceAll("_", "-")} viewport`;
  const ov = /^OVERLAY_BLOCKING_(.+)$/.exec(kind);
  if (ov) return `A popup or overlay covers the page at the ${ov[1]!.toLowerCase().replaceAll("_", "-")} viewport and could not be closed — real visitors are blocked too`;
  const ctl = /^CONTROLS_(OBSCURED|OFFSCREEN)_(.+)$/.exec(kind);
  if (ctl) return `Controls are ${ctl[1] === "OBSCURED" ? "covered by other elements" : "outside the screen"} at the ${ctl[2]!.toLowerCase().replaceAll("_", "-")} viewport`;
  const fn = /^FUNCTIONAL_(.+)$/.exec(kind);
  if (fn) return ({ SEARCH: "Site search does not work", NAVIGATION: "A navigation link is broken", FORM: "A form does not validate input", BUTTON: "A button raised an error when used", RESPONSIVE_NAV: "The mobile menu does not open" } as Record<string, string>)[fn[1]!] ?? "A functional check failed";
  return ({
    BLANK_PAGE: "The page rendered no visible content", UNCAUGHT_EXCEPTION: "Uncaught JavaScript exception during page load",
    UNHANDLED_REJECTION: "Unhandled promise rejection during page load", CONSOLE_ERROR: "Console errors during page load",
    SCRIPT_FAILED: "A first-party script failed to load", STYLESHEET_FAILED: "A first-party stylesheet failed to load", DOCUMENT_FAILED: "A first-party frame failed to load",
    LCP_POOR: "Largest Contentful Paint above the critical threshold (synthetic)", CLS_POOR: "Cumulative Layout Shift above the critical threshold (synthetic)",
    FCP_POOR: "First Contentful Paint above the critical threshold (synthetic)", TBT_POOR: "Total Blocking Time above the critical threshold (synthetic)",
    TTFB_POOR: "Time to First Byte above the critical threshold (synthetic)", LOAD_POOR: "Page load time above the critical threshold (synthetic)",
    NAVIGATION_TIMEOUT: "The page did not finish loading within the timeout", READINESS_TIMEOUT: "The configured readiness element never appeared",
    REDIRECTED_OFF_SITE: "The page redirected to another website", DOWNLOAD_REFUSED: "The page is a file download, not a web page", BLOCKED_ADDRESS: "The domain resolves to a private or reserved address",
    TLS_INVALID: "The TLS certificate is not trusted", DNS_FAILURE: "DNS lookup failed", NO_ADDRESSES: "The domain has no DNS address records",
    CONNECTION_FAILED: "Connection refused or reset", CONNECT_TIMEOUT: "Connection timed out", REDIRECT_LOOP: "Redirect loop", TOO_MANY_REDIRECTS: "Too many redirects",
  } as Record<string, string>)[kind] ?? "Browser check failed";
}

export type BrowserThresholds = (c: BrowserClass) => Thresholds;
