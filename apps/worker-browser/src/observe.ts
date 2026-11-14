import type { Browser, Page, Request, Response } from "playwright-core";
import {
  groupIssues, sameSite, VIEWPORT_PRESETS, type BrowserCheckConfig, type DetectedComponent, type FunctionalResult, type ResourceIssue, type ViewportName, type ViewportObservation,
} from "@wim/core";
import { guardedGoto, sanitizeUrl } from "@wim/netguard";
import { collectInPage, INIT_SCRIPT } from "./page-scripts.js";
import { detectAndInspect, installGuard, resolveNavToggle, runFunctionalTests, type GuardLog } from "./interact.js";

/** Gateway refusals reach Chromium as HTTP responses (plain HTTP) carrying this header. */
const GATEWAY_OUTCOME: Record<string, string> = {
  BLOCKED_ADDRESS: "BLOCKED_ADDRESS", BLOCKED_HOST: "BLOCKED_HOST", BLOCKED_PORT: "BLOCKED_PORT", NO_ADDRESSES: "NO_ADDRESSES",
  DNS_FAILURE: "DNS_FAILURE", UNAUTHORIZED: "EGRESS_UNAUTHORIZED", RATE_LIMITED: "EGRESS_RATE_LIMITED", CONNECT_FAILED: "CONNECTION_FAILED", TIMEOUT: "CONNECT_TIMEOUT",
};

/** Map a Chromium navigation error to a failure kind. Ambiguous tunnel errors are classified later by a gateway probe. */
export function chromiumNavError(message: string): string {
  const m = /net::(ERR_[A-Z_]+)/.exec(message);
  const code = m?.[1];
  if (/Timeout \d+ms exceeded|TimeoutError/.test(message) || code === "ERR_TIMED_OUT") return "NAVIGATION_TIMEOUT";
  if (/Download is starting/i.test(message)) return "DOWNLOAD_REFUSED"; // downloads are disabled; the page itself is a file
  if (!code) return /Target (page|crashed)|crash/i.test(message) ? "BROWSER_CRASHED" : /closed/i.test(message) ? "BROWSER_CRASHED" : "NAVIGATION_FAILED";
  if (code.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR" || code === "ERR_BAD_SSL_CLIENT_AUTH_CERT") return "TLS_INVALID";
  if (code === "ERR_PROXY_CONNECTION_FAILED") return "GATEWAY_UNAVAILABLE";
  if (code === "ERR_TUNNEL_CONNECTION_FAILED") return "TUNNEL_FAILED"; // gateway refused or couldn't connect: classify via probe
  if (code === "ERR_TOO_MANY_REDIRECTS") return "TOO_MANY_REDIRECTS";
  if (code === "ERR_BLOCKED_BY_CLIENT") return "REDIRECTED_OFF_SITE";
  if (code === "ERR_EMPTY_RESPONSE" || code === "ERR_INVALID_RESPONSE" || code === "ERR_INVALID_HTTP_RESPONSE") return "PROTOCOL_ERROR";
  if (code === "ERR_CONNECTION_RESET" || code === "ERR_CONNECTION_CLOSED" || code === "ERR_CONNECTION_REFUSED") return "CONNECTION_FAILED";
  if (code === "ERR_ABORTED") return "NAVIGATION_ABORTED";
  return code;
}

export interface ObserveInput {
  browser: Browser;
  url: string;
  viewport: ViewportName;
  config: BrowserCheckConfig;
  registrableDomain: string;
  deadline: number;
  signal: AbortSignal;
  screenshot: (o: ViewportObservation) => boolean;
  maskSelectors: string[];
  /** Phase 4F: run the functional tests on this (primary) viewport */
  functional?: boolean;
  /** Phase 4H: functional tests permitted (platform switch on AND risk acknowledged) */
  functionalAllowed?: boolean;
}

export interface ObserveOutput {
  observation: ViewportObservation;
  screenshot: Buffer | null;
  offsiteTarget: string | null;
  /** Phase 4F: components detected at this viewport (deduplicated, validated) */
  components: DetectedComponent[];
  /** Phase 4F: functional and mobile-menu test results at this viewport */
  functional: FunctionalResult[];
  /** requests the safety guard blocked during interactions (never sent) */
  blocked: GuardLog["blocked"];
}

export async function observeViewport(i: ObserveInput): Promise<ObserveOutput> {
  const vp = VIEWPORT_PRESETS[i.viewport];
  const started = Date.now();
  const ctx = await i.browser.newContext({
    viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 1,
    acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, javaScriptEnabled: true, bypassCSP: false,
    permissions: [], userAgent: undefined, locale: "en-US", timezoneId: "UTC",
  });
  const page = await ctx.newPage();
  await ctx.addInitScript({ content: INIT_SCRIPT });
  const onAbort = () => void ctx.close().catch(() => undefined);
  i.signal.addEventListener("abort", onAbort, { once: true });

  const exceptions: Array<{ message: string; source: string | null }> = [];
  const consoleErrors: Array<{ message: string; source: string | null }> = [];
  const failed = new Map<string, ResourceIssue>();
  const httpErrors = new Map<string, ResourceIssue>();
  let requests = 0, transferBytes = 0, inflight = 0, lastActivity = Date.now(), crashed = false;
  let offsiteTarget: string | null = null;
  let mainResponse: Response | null = null;
  const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return "?"; } };
  const firstParty = (u: string) => sameSite(hostOf(u), i.registrableDomain);
  const bump = (map: Map<string, ResourceIssue>, r: Request, error: string, status: number | null) => {
    const key = `${hostOf(r.url())}|${r.resourceType()}|${error}`;
    const g = map.get(key);
    if (g) g.count++;
    else map.set(key, { host: hostOf(r.url()), type: r.resourceType(), firstParty: firstParty(r.url()), error, count: 1, status });
  };

  // The main document may only move within the website's registrable domain (scope, not the security boundary:
  // the gateway refuses non-public destinations for every request regardless).
  await page.route("**/*", (route) => {
    const r = route.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !firstParty(r.url())) {
      offsiteTarget = hostOf(r.url());
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
  // URLs requested by the passive page load (before any interaction): the destination policy's baseline
  const baseline = new Set<string>();
  let interacting = false;
  page.on("request", (r) => { if (!interacting && baseline.size < 2000) baseline.add(r.url()); });
  page.on("request", (r) => { requests++; if (r.resourceType() !== "eventsource" && r.resourceType() !== "websocket") inflight++; lastActivity = Date.now(); });
  const done = (r: Request) => { if (r.resourceType() !== "eventsource" && r.resourceType() !== "websocket") inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); };
  page.on("requestfinished", (r) => { done(r); void r.sizes().then((s) => { transferBytes += s.responseBodySize + s.responseHeadersSize; }).catch(() => undefined); });
  const answered = new WeakSet<Request>(); // requests already counted from their HTTP error response
  page.on("requestfailed", (r) => {
    done(r);
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) return; // reported as the navigation outcome
    if (answered.has(r)) return; // e.g. a 404 stylesheet is aborted after its error response: count it once
    bump(failed, r, (r.failure()?.errorText ?? "failed").replace(/^net::/, "").slice(0, 60), null);
  });
  page.on("response", (res) => {
    const r = res.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) return;
    const egress = res.headers()["x-egress-error"];
    if (egress) { answered.add(r); bump(failed, r, `GATEWAY_${egress}`.slice(0, 60), res.status()); }
    else if (res.status() >= 400) { answered.add(r); bump(httpErrors, r, `HTTP_${res.status()}`, res.status()); }
  });
  page.on("pageerror", (e) => { if (exceptions.length < 200) exceptions.push({ message: `${e.name}: ${e.message}`.slice(0, 500), source: null }); });
  page.on("console", (m) => {
    if (m.type() !== "error" || consoleErrors.length >= 200) return;
    const loc = m.location()?.url;
    consoleErrors.push({ message: m.text().slice(0, 500), source: loc ? hostOf(loc) : null });
  });
  page.on("crash", () => { crashed = true; });

  const remaining = () => Math.max(0, i.deadline - Date.now());
  const navTimeout = Math.max(1000, Math.min(i.config.navigationTimeoutMs, remaining()));
  const strategy = i.config.readiness.strategy;
  let navError: string | null = null;
  let readiness = { strategy, met: false, ms: 0 };
  try {
    const waitUntil = strategy === "domcontentloaded" || strategy === "selector" || strategy === "fixed" ? "domcontentloaded" : "load";
    mainResponse = await guardedGoto(page, i.url, { timeout: navTimeout, waitUntil });
    const navDone = Date.now();
    if (strategy === "selector" && i.config.readiness.selector) {
      readiness.met = await page.locator(i.config.readiness.selector).first().waitFor({ state: "visible", timeout: Math.max(500, Math.min(navTimeout, remaining())) }).then(() => true, () => false);
    } else if (strategy === "networkquiet") {
      const until = Math.min(Date.now() + navTimeout, i.deadline);
      while (Date.now() < until && !(inflight === 0 && Date.now() - lastActivity >= i.config.readiness.quietMs)) await page.waitForTimeout(100);
      readiness.met = inflight === 0 && Date.now() - lastActivity >= i.config.readiness.quietMs;
    } else {
      readiness.met = true;
    }
    readiness.ms = Date.now() - navDone;
    const settle = Math.min(i.config.readiness.settleMs, remaining());
    if (settle > 0) await page.waitForTimeout(settle);
  } catch (e) {
    navError = crashed ? "BROWSER_CRASHED" : chromiumNavError((e as Error).message);
    if (offsiteTarget) navError = "REDIRECTED_OFF_SITE";
  }
  if (i.signal.aborted) throw new Error("aborted");

  // Main document outcome
  let mainStatus: number | null = null;
  let redirects = 0;
  if (!navError && mainResponse) {
    mainStatus = mainResponse.status();
    const egress = mainResponse.headers()["x-egress-error"];
    if (egress) navError = GATEWAY_OUTCOME[egress] ?? "GATEWAY_ERROR";
    for (let r = mainResponse.request().redirectedFrom(); r; r = r.redirectedFrom()) redirects++;
    if (redirects > i.config.maxRedirects) navError = "TOO_MANY_REDIRECTS";
    // Redirect hops are followed inside Chromium (route handlers don't see them): if the main document left the
    // website's registrable domain, the page is someone else's — classified, never evaluated as the customer's.
    if (!firstParty(mainResponse.url())) { offsiteTarget = hostOf(mainResponse.url()); navError = "REDIRECTED_OFF_SITE"; }
  }
  let inPage: ReturnType<typeof normalizeInPage> | null = null;
  let detected: Awaited<ReturnType<typeof detectAndInspect>> | null = null;
  if (!navError || navError === "TOO_MANY_REDIRECTS") {
    inPage = normalizeInPage(await page.evaluate(collectInPage).catch(() => null));
    if (!inPage && crashed) navError = "BROWSER_CRASHED";
    // Phase 4F: read-only component detection and responsive inspection (no interaction yet)
    if (inPage && !navError && remaining() > 2000) detected = await detectAndInspect(page, i.config.components.detect).catch(() => null);
  }
  const observation: ViewportObservation = {
    viewport: i.viewport, width: vp.width, height: vp.height, navError, mainStatus,
    finalUrl: page.url().startsWith("http") ? sanitizeUrl(page.url()) : null, redirects, readiness, durationMs: Date.now() - started,
    rendering: inPage ? {
      textLength: inPage.rendering.textLength, meaningfulElements: inPage.rendering.meaningfulElements, contentCoverage: inPage.rendering.contentCoverage,
      brokenImages: inPage.rendering.brokenImages.map((src) => ({ src })),
      failedStylesheets: [...failed.values(), ...httpErrors.values()].filter((x) => x.type === "stylesheet").reduce((a, b) => a + b.count, 0),
      failedFonts: inPage.rendering.fontsFailed + [...failed.values(), ...httpErrors.values()].filter((x) => x.type === "font").reduce((a, b) => a + b.count, 0),
    } : null,
    scripts: {
      exceptions: groupIssues(exceptions.filter((e) => !inPage?.rejections.some((r) => e.message.includes(r)))),
      rejections: groupIssues((inPage?.rejections ?? []).map((m) => ({ message: m, source: null }))),
      consoleErrors: groupIssues(consoleErrors),
    },
    network: { failed: [...failed.values()].slice(0, 30), httpErrors: [...httpErrors.values()].slice(0, 30), requests, transferBytes },
    layout: inPage ? { ...inPage.layout, ...(detected?.layout ? { ...detected.layout, overflowPx: inPage.layout.overflowPx, offscreenText: inPage.layout.offscreenText } : {}) } : null,
    perf: inPage ? { ttfbMs: inPage.timing?.ttfbMs ?? null, fcpMs: inPage.fcpMs, lcpMs: inPage.lcpMs, cls: inPage.cls, tbtMs: inPage.tbtMs, longTasks: inPage.longTasks, loadMs: inPage.timing?.loadMs ?? null } : null,
  };
  let shot: Buffer | null = null;
  // Never capture another site's page (off-site redirect) — evidence must be the customer's own website.
  if (!crashed && observation.navError !== "REDIRECTED_OFF_SITE" && i.screenshot(observation) && page.url().startsWith("http") && firstParty(page.url())) {
    const mask = ["input", "textarea", "select", "[contenteditable]", "iframe", ...i.maskSelectors].map((s) => page.locator(s));
    shot = await page.screenshot({ type: "png", fullPage: i.config.screenshots.fullPage, mask, maskColor: "#9e9e9e", animations: "disabled", timeout: Math.max(1000, Math.min(10_000, remaining())) }).catch(() => null);
    // Bound the full-page case: never more than ~8 MB per capture.
    if (shot && shot.length > 8 * 1024 * 1024) shot = null;
  }
  // Phase 4F interactions — after the evidence (screenshot) is taken, behind the request guard.
  const functional: FunctionalResult[] = [];
  let guard: GuardLog = { blocked: [] };
  const components = detected?.components ?? [];
  if (detected && !crashed && !i.signal.aborted) {
    const pendingToggle = Boolean((detected.layout as { pendingToggle?: boolean } | null)?.pendingToggle);
    // Phase 4H: platform switch + customer risk acknowledgement are both required (decided by the engine)
    const wantsFunctional = Boolean(i.functional && i.config.functional.enabled && i.functionalAllowed);
    // the destination policy applies to functional tests only; the mobile-menu probe keeps the 4F guard
    interacting = true;
    if (pendingToggle || wantsFunctional) guard = await installGuard(ctx, firstParty, wantsFunctional ? i.config.functional.allowedPaths : [], i.url, baseline);
    if (pendingToggle && observation.layout && remaining() > 3000) {
      const toggle = components.find((c) => c.type === "RESPONSIVE_NAV" && c.visible) ?? null;
      const r = await resolveNavToggle(page, i.viewport, i.deadline, firstParty, guard, toggle?.selector ?? null).catch(() => ({ navState: "NONE" as const, result: null }));
      observation.layout.navState = r.navState;
      if (r.result) functional.push(r.result);
    }
    if (wantsFunctional && remaining() > 5000) {
      functional.push(...await runFunctionalTests(page, { url: i.url, viewport: i.viewport, deadline: i.deadline - 3000, cfg: i.config.functional, components, guard, firstParty }).catch(() => []));
    }
  }
  i.signal.removeEventListener("abort", onAbort);
  await ctx.close().catch(() => undefined);
  return { observation, screenshot: shot, offsiteTarget, components, functional, blocked: guard.blocked };
}

function normalizeInPage(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    timing: { ttfbMs: number; loadMs: number | null } | null; fcpMs: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; longTasks: number | null;
    rejections: string[]; rendering: { textLength: number; meaningfulElements: number; contentCoverage: number; brokenImages: string[]; fontsFailed: number };
    layout: { overflowPx: number; offscreenText: number; firstViewportVisible: boolean };
  };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    timing: r.timing ? { ttfbMs: n(r.timing.ttfbMs), loadMs: n(r.timing.loadMs) } : null,
    fcpMs: n(r.fcpMs), lcpMs: n(r.lcpMs), cls: n(r.cls), tbtMs: n(r.tbtMs), longTasks: n(r.longTasks),
    rejections: Array.isArray(r.rejections) ? r.rejections.map(String).slice(0, 50) : [],
    rendering: {
      textLength: n(r.rendering?.textLength) ?? 0, meaningfulElements: n(r.rendering?.meaningfulElements) ?? 0, contentCoverage: n(r.rendering?.contentCoverage) ?? 0,
      brokenImages: Array.isArray(r.rendering?.brokenImages) ? r.rendering.brokenImages.map((x) => String(x).slice(0, 200)).slice(0, 20) : [], fontsFailed: n(r.rendering?.fontsFailed) ?? 0,
    },
    layout: { overflowPx: n(r.layout?.overflowPx) ?? 0, offscreenText: n(r.layout?.offscreenText) ?? 0, firstViewportVisible: Boolean(r.layout?.firstViewportVisible) },
  };
}

export type { Page };
