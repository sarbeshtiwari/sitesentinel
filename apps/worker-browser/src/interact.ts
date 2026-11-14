import type { BrowserContext, Page, Response, Route } from "playwright-core";
import {
  classifyAction, dedupeComponents, pathAllowed, sanitizeDetected, urlIsUnsafe,
  type DetectedComponent, type FunctionalConfig, type FunctionalResult, type LayoutFacts, type Safety,
} from "@wim/core";
import { detectComponents, inspectLayout } from "./page-scripts.js";

/**
 * Phase 4F interactions, driven from worker-browser through Playwright in the runner's sandboxed Chromium (the same
 * session, capability and gateway as the page observation — no second browser system).
 *
 * Safety layers, outermost first:
 *  1. The egress gateway still decides every connection (non-public destinations refused).
 *  2. A request guard on the context aborts EVERY request that isn't GET/HEAD/OPTIONS and every main-frame navigation
 *     to an unsafe route or another site — so no interaction can submit, purchase, delete or log out, whatever the
 *     page's scripts try. Blocked attempts are recorded and turn the test into SKIPPED (never a website failure).
 *  3. `classifyAction` with the destructive deny-list: anything not confidently SAFE is skipped with a reason.
 *  4. Forms are never submitted: fields are filled and the browser's own constraint validation is queried; password,
 *     payment and file fields are never touched; a submit listener cancels any submission attempt.
 */

export interface GuardLog { blocked: Array<{ method: string; reason: string }>; }

export async function installGuard(ctx: BrowserContext, firstParty: (u: string) => boolean, allowedPaths: readonly string[] = [], startUrl?: string, baseline?: ReadonlySet<string>): Promise<GuardLog> {
  // the monitored page itself is always allowed (tests return to it) — exact path only, never as a prefix
  const startPath = startUrl ? (() => { try { return new URL(startUrl).pathname; } catch { return null; } })() : null;
  const samePage = (u: string) => { try { return startPath !== null && new URL(u).pathname === startPath; } catch { return false; } };
  const log: GuardLog = { blocked: [] };
  const block = (route: Route, method: string, reason: string) => {
    if (log.blocked.length < 50) log.blocked.push({ method, reason });
    return route.abort("blockedbyclient");
  };
  await ctx.route("**/*", (route) => {
    const r = route.request();
    const m = r.method().toUpperCase();
    const u = r.url();
    // 1. nothing but reads
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") return block(route, m, "non-GET request blocked during functional tests");
    // 2. a GET is not harmless by itself: requests to unsafe routes or carrying one-click tokens are refused for EVERY
    //    resource type and frame (images, scripts, fetch, iframes…), not just page navigations
    if (urlIsUnsafe(u)) return block(route, m, "unsafe destination blocked");
    // 3. navigations stay on the website
    if (r.isNavigationRequest() && !firstParty(u)) return block(route, m, "off-site navigation blocked");
    // 3b. Destination policy (release readiness, blocker 9): while interacting, a first-party request of ANY type
    //     (navigation, frame, image, script, stylesheet, font, media, fetch, XHR, WebSocket, beacon…) may only go to
    //     (a) a URL the passive page load already requested — the same request every check makes anyway — or
    //     (b) a path the customer explicitly declared safe. Everything else is refused before it leaves the browser.
    if (allowedPaths.length && firstParty(u) && !samePage(u) && !baseline?.has(u) && !pathAllowed(u, allowedPaths)) {
      return block(route, m, "destination outside the allowed paths");
    }
    // 4. no side-channel calls to third parties while we interact (fetch / XHR / beacons / sockets)
    if (!firstParty(u) && ["fetch", "xhr", "websocket", "eventsource", "ping", "beacon", "other"].includes(r.resourceType())) return block(route, m, "third-party call blocked during functional tests");
    return route.fallback();
  });
  return log;
}

/** Read-only detection + layout facts for one viewport (no interaction). */
export async function detectAndInspect(page: Page, detect: boolean): Promise<{ components: DetectedComponent[]; layout: LayoutFacts | null }> {
  const components = detect ? dedupeComponents(sanitizeDetected(await page.evaluate(detectComponents, 250).catch(() => null))) : [];
  const raw = (await page.evaluate(inspectLayout).catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return { components, layout: null };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const nav = String(raw.navState);
  const layout: LayoutFacts = {
    overflowPx: n(raw.overflowPx), offscreenText: 0, clippedText: n(raw.clippedText), overlaps: n(raw.overlaps), obscuredControls: n(raw.obscuredControls),
    offscreenControls: n(raw.offscreenControls), oversizedImages: n(raw.oversizedImages),
    navState: (["VISIBLE", "MISSING", "NONE"].includes(nav) ? nav : "NONE") as LayoutFacts["navState"], // TOGGLE: resolved by clicking it (resolveNavToggle)
    samples: Array.isArray(raw.samples) ? (raw.samples as Array<{ issue: unknown; selector: unknown }>).slice(0, 20).map((s) => ({ issue: String(s.issue).slice(0, 80), selector: String(s.selector).slice(0, 120) })) : [],
  };
  return { components, layout: Object.assign(layout, { pendingToggle: nav === "TOGGLE" }) };
}

interface Ctx {
  page: Page;
  url: string;
  viewport: string;
  deadline: number;
  guard: GuardLog;
  firstParty: (u: string) => boolean;
  /** Phase 4H destination policy (empty = whole site) */
  allowedPaths: readonly string[];
}

/** Time left for one more interaction, or null if the budget is spent. */
const left = (c: Ctx, need = 3000) => (c.deadline - Date.now() > need ? Math.min(10_000, c.deadline - Date.now() - 500) : null);

function result(c: Ctx, base: Omit<FunctionalResult, "viewport" | "durationMs" | "steps"> & { steps?: FunctionalResult["steps"] }, t0: number): FunctionalResult {
  return { ...base, steps: base.steps ?? [], viewport: c.viewport, durationMs: Date.now() - t0 };
}

/** Classify a navigation/search response: a gateway refusal or our outage is INCONCLUSIVE, never the website's fault. */
function responseOutcome(res: Response | null): { outcome: "PASSED" | "FAILED" | "INCONCLUSIVE"; reason: string | null } {
  if (!res) return { outcome: "INCONCLUSIVE", reason: "NO_RESPONSE" };
  const egress = res.headers()["x-egress-error"];
  if (egress) return { outcome: "INCONCLUSIVE", reason: egress === "BLOCKED_ADDRESS" || egress === "BLOCKED_HOST" ? `BLOCKED_${egress}` : "GATEWAY_UNAVAILABLE" };
  if (res.status() >= 400) return { outcome: "FAILED", reason: `HTTP_${res.status()}` };
  return { outcome: "PASSED", reason: null };
}
const navFailure = (e: unknown) => {
  const m = (e as Error).message ?? "";
  if (/ERR_PROXY|ERR_TUNNEL/.test(m)) return { outcome: "INCONCLUSIVE" as const, reason: "GATEWAY_UNAVAILABLE" };
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return { outcome: "SKIPPED" as const, reason: "BLOCKED_BY_SAFETY_GUARD" };
  if (/Target (page|crashed)|crash/i.test(m)) return { outcome: "INCONCLUSIVE" as const, reason: "BROWSER_CRASHED" };
  if (/Timeout/.test(m)) return { outcome: "FAILED" as const, reason: "TIMEOUT" };
  return { outcome: "FAILED" as const, reason: (/net::(ERR_[A-Z_]+)/.exec(m)?.[1] ?? "NAVIGATION_FAILED") };
};

/**
 * A timeout or connection failure on the way to another page may be OUR path failing (gateway, runner), not the site.
 * Reload the start page — which loaded moments ago — through the same browser and gateway: if that fails too, the
 * path is unhealthy and the result is INCONCLUSIVE; only if it loads is the failure attributed to the destination.
 */
const CONNECTION_LEVEL = /^(TIMEOUT|ERR_CONNECTION_[A-Z_]+|ERR_EMPTY_RESPONSE|ERR_SOCKET_[A-Z_]+|ERR_NETWORK_[A-Z_]+|ERR_TIMED_OUT|NAVIGATION_FAILED)$/;
async function attribute(c: Ctx, nf: { outcome: "PASSED" | "FAILED" | "SKIPPED" | "INCONCLUSIVE"; reason: string | null }) {
  if (nf.outcome !== "FAILED" || !CONNECTION_LEVEL.test(nf.reason ?? "")) return nf;
  const t = Math.min(8000, Math.max(0, c.deadline - Date.now()));
  if (t < 1500) return { outcome: "INCONCLUSIVE" as const, reason: "TIME_BUDGET" };
  const ok = await c.page.goto(c.url, { timeout: t, waitUntil: "load" }).then((r) => Boolean(r && r.status() < 400 && !r.headers()["x-egress-error"]), () => false);
  return ok ? nf : { outcome: "INCONCLUSIVE" as const, reason: "GATEWAY_UNAVAILABLE" };
}

/** Return to the start page between tests. `budget` = the run's interaction budget is used up (a SKIPPED test). */
async function backTo(c: Ctx): Promise<true | "budget" | "failed"> {
  if (c.page.url() === c.url) return true;
  const t = left(c, 2000);
  if (t === null) return "budget";
  return c.page.goto(c.url, { timeout: t, waitUntil: "load" }).then(() => true as const, () => "failed" as const);
}
/** The outcome of a test that couldn't start because returning to the start page didn't work. */
const notStarted = (b: "budget" | "failed") => (b === "budget" ? { outcome: "SKIPPED" as const, reason: "TIME_BUDGET" } : { outcome: "INCONCLUSIVE" as const, reason: "PAGE_RELOAD_FAILED" });

/** Facts for the classifier, read from the live element (bounded strings). */
async function factsOf(c: Ctx, selector: string) {
  return c.page.locator(selector).first().evaluate((el) => {
    const f = (el as HTMLInputElement).form ?? el.closest("form");
    return {
      tag: el.tagName, text: ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      ariaLabel: el.getAttribute("aria-label"), title: el.getAttribute("title"), id: el.id || null, name: el.getAttribute("name"),
      className: typeof el.className === "string" ? el.className.slice(0, 120) : null, href: el.getAttribute("href"),
      inputType: el.getAttribute("type"), formMethod: f ? (f.getAttribute("method") ?? "get") : null, formAction: f ? f.getAttribute("action") : null,
      toggles: el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") || el.tagName === "SUMMARY" || el.hasAttribute("data-toggle") || el.hasAttribute("data-bs-toggle"),
      sensitiveFields: f ? Array.from(f.querySelectorAll("input")).some((i) => i.type === "password" || i.type === "file" || /^cc-|card|cvv|cvc|iban/i.test(`${i.autocomplete} ${i.name}`)) : false,
    };
  }, undefined, { timeout: 2000 }).catch(() => null);
}

/** Mobile menu: the only interaction performed even when functional tests are off (it's a classified-SAFE toggle). */
export async function resolveNavToggle(page: Page, viewport: string, deadline: number, firstParty: (u: string) => boolean, guard: GuardLog, toggleSelector: string | null): Promise<{ navState: LayoutFacts["navState"]; result: FunctionalResult | null }> {
  const c: Ctx = { page, url: page.url(), viewport, deadline, guard, firstParty, allowedPaths: [] };
  const t0 = Date.now();
  if (!toggleSelector) return { navState: "MISSING", result: null };
  const f = await factsOf(c, toggleSelector);
  if (!f) return { navState: "NONE", result: null };
  const cls = classifyAction({ action: "CLICK", ...f, toggles: true });
  if (cls.safety !== "SAFE") return { navState: "NONE", result: result(c, { kind: "RESPONSIVE_NAV", componentKey: null, componentType: "RESPONSIVE_NAV", target: f.ariaLabel ?? f.text ?? "menu", outcome: "SKIPPED", reason: cls.reason, safety: cls.safety }, t0) };
  const t = left(c);
  if (t === null) return { navState: "NONE", result: result(c, { kind: "RESPONSIVE_NAV", componentKey: null, componentType: "RESPONSIVE_NAV", target: "menu", outcome: "SKIPPED", reason: "TIME_BUDGET", safety: "SAFE" }, t0) };
  const errors: string[] = [];
  const onErr = (e: Error) => errors.push(e.message);
  page.on("pageerror", onErr);
  try {
    await page.locator(toggleSelector).first().click({ timeout: t });
    await page.waitForTimeout(400); // menus animate
    const open = await page.evaluate(() => Array.from(document.querySelectorAll("nav a[href], [role=navigation] a[href]")).some((a) => {
      const cs = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      return cs.visibility !== "hidden" && cs.display !== "none" && r.width > 1 && r.height > 1 && r.right > 0 && r.left < innerWidth && r.bottom > 0;
    }));
    const ok = open && !errors.length;
    return {
      navState: ok ? "COLLAPSED_OK" : "BROKEN",
      result: result(c, { kind: "RESPONSIVE_NAV", componentKey: null, componentType: "RESPONSIVE_NAV", target: f.ariaLabel ?? f.text ?? "menu", outcome: ok ? "PASSED" : "FAILED", reason: ok ? null : errors.length ? "SCRIPT_ERROR" : "MENU_DID_NOT_OPEN", safety: "SAFE", steps: [{ step: "click menu toggle", ok: true, ms: Date.now() - t0 }, { step: "navigation links visible", ok: open, ms: Date.now() - t0 }] }, t0),
    };
  } catch (e) {
    const nf = navFailure(e);
    return { navState: nf.outcome === "FAILED" ? "BROKEN" : "NONE", result: result(c, { kind: "RESPONSIVE_NAV", componentKey: null, componentType: "RESPONSIVE_NAV", target: "menu", outcome: nf.outcome === "FAILED" ? "FAILED" : nf.outcome, reason: nf.outcome === "FAILED" ? "TOGGLE_NOT_CLICKABLE" : nf.reason, safety: "SAFE" }, t0) };
  } finally {
    page.off("pageerror", onErr);
  }
}

export async function runFunctionalTests(page: Page, opts: { url: string; viewport: string; deadline: number; cfg: FunctionalConfig; components: DetectedComponent[]; guard: GuardLog; firstParty: (u: string) => boolean }): Promise<FunctionalResult[]> {
  const c: Ctx = { page, url: page.url() || opts.url, viewport: opts.viewport, deadline: Math.min(opts.deadline, Date.now() + opts.cfg.budgetMs), guard: opts.guard, firstParty: opts.firstParty, allowedPaths: opts.cfg.allowedPaths };
  const out: FunctionalResult[] = [];
  const errors: string[] = [];
  const onErr = (e: Error) => { if (errors.length < 50) errors.push(e.message.slice(0, 200)); };
  page.on("pageerror", onErr);
  try {
    if (opts.cfg.search) for (const s of opts.components.filter((x) => x.type === "SEARCH" && x.visible).slice(0, 1)) out.push(await searchTest(c, s, opts.cfg.searchQuery, errors));
    if (opts.cfg.navigation) out.push(...await navigationTests(c, opts.components, opts.cfg.maxNavigationLinks));
    if (opts.cfg.forms) for (const f of opts.components.filter((x) => x.type === "FORM" && x.visible).slice(0, opts.cfg.maxForms)) out.push(await formTest(c, f));
    if (opts.cfg.buttons) out.push(...await buttonTests(c, opts.components, opts.cfg.maxButtons, errors));
  } finally {
    page.off("pageerror", onErr);
  }
  return out.slice(0, 40);
}

async function searchTest(c: Ctx, s: DetectedComponent, query: string, errors: string[]): Promise<FunctionalResult> {
  const t0 = Date.now();
  const base = { kind: "SEARCH" as const, componentKey: s.key, componentType: "SEARCH" as const, target: s.label ?? "search" };
  const back = await backTo(c);
  if (back !== true) return result(c, { ...base, ...notStarted(back), safety: "UNKNOWN" }, t0);
  const f = await factsOf(c, s.selector);
  if (!f) return result(c, { ...base, outcome: "SKIPPED", reason: "ELEMENT_NOT_FOUND", safety: "UNKNOWN" }, t0);
  const cls = classifyAction({ action: "SEARCH", ...f, text: null });
  if (cls.safety !== "SAFE") return result(c, { ...base, outcome: "SKIPPED", reason: cls.reason, safety: cls.safety }, t0);
  const t = left(c);
  if (t === null) return result(c, { ...base, outcome: "SKIPPED", reason: "TIME_BUDGET", safety: "SAFE" }, t0);
  const blockedBefore = c.guard.blocked.length, errsBefore = errors.length;
  const steps: FunctionalResult["steps"] = [];
  try {
    const input = c.page.locator(s.selector).first();
    await input.fill(query, { timeout: t });
    steps.push({ step: "type query", ok: true, ms: Date.now() - t0 });
    const before = c.page.url();
    // (a navigation destroys this context: the rejection is expected and handled)
    const mutated = c.page.evaluate(() => new Promise<boolean>((res) => { const mo = new MutationObserver(() => { mo.disconnect(); res(true); }); mo.observe(document.body, { childList: true, subtree: true }); setTimeout(() => { mo.disconnect(); res(false); }, 4000); })).catch(() => false);
    const nav = c.page.waitForNavigation({ timeout: Math.min(t, 8000), waitUntil: "load" }).then((r) => ({ r }), (e) => ({ e }));
    await input.press("Enter", { timeout: t });
    const n = await nav;
    if (c.guard.blocked.length > blockedBefore) return result(c, { ...base, outcome: "SKIPPED", reason: "SEARCH_SENDS_DATA (blocked by the safety guard)", safety: "UNSAFE", steps }, t0);
    if ("r" in n && n.r) {
      const ro = responseOutcome(n.r);
      steps.push({ step: "results page", ok: ro.outcome === "PASSED", ms: Date.now() - t0, note: ro.reason ?? undefined });
      if (ro.outcome !== "PASSED") return result(c, { ...base, outcome: ro.outcome, reason: ro.reason ? `SEARCH_${ro.reason}` : null, safety: "SAFE", steps }, t0);
      if (errors.length > errsBefore) return result(c, { ...base, outcome: "FAILED", reason: "SEARCH_SCRIPT_ERROR", safety: "SAFE", steps }, t0);
      const hasQuery = decodeURIComponent(c.page.url()).toLowerCase().includes(query.toLowerCase());
      return result(c, { ...base, outcome: "PASSED", reason: hasQuery ? null : "results page loaded (query not in URL)", safety: "SAFE", steps }, t0);
    }
    if ("e" in n && !/Timeout/.test((n.e as Error).message)) {
      const nf = await attribute(c, navFailure(n.e));
      return result(c, { ...base, outcome: nf.outcome, reason: nf.outcome === "INCONCLUSIVE" ? nf.reason : `SEARCH_${nf.reason}`, safety: "SAFE", steps }, t0);
    }
    // no navigation: an in-page (script) search must at least change the page
    const changed = await mutated;
    steps.push({ step: "page reacted", ok: changed, ms: Date.now() - t0 });
    if (errors.length > errsBefore) return result(c, { ...base, outcome: "FAILED", reason: "SEARCH_SCRIPT_ERROR", safety: "SAFE", steps }, t0);
    void before;
    return result(c, { ...base, outcome: changed ? "PASSED" : "FAILED", reason: changed ? null : "SEARCH_NO_RESPONSE", safety: "SAFE", steps }, t0);
  } catch (e) {
    const nf = await attribute(c, navFailure(e));
    return result(c, { ...base, outcome: nf.outcome, reason: nf.outcome === "INCONCLUSIVE" ? nf.reason : `SEARCH_${nf.reason}`, safety: "SAFE", steps }, t0);
  }
}

async function navigationTests(c: Ctx, components: DetectedComponent[], max: number): Promise<FunctionalResult[]> {
  const out: FunctionalResult[] = [];
  const navs = components.filter((x) => x.type === "NAV" && x.visible);
  if (!navs.length || max <= 0) return out;
  if ((await backTo(c)) !== true) return out;
  // candidate links, read live from the visible navigation(s): first-party, distinct paths, not the current page
  const here = new URL(c.url);
  const links = await c.page.evaluate((sels) => {
    const seen = new Set<string>();
    const res: Array<{ href: string; text: string; selector: string }> = [];
    for (const s of sels) {
      const root = document.querySelector(s);
      if (!root) continue;
      for (const a of Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
        const r = a.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || getComputedStyle(a).visibility === "hidden") continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        res.push({ href: a.href, text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60), selector: `${s} a[href="${a.getAttribute("href")!.replace(/"/g, '\\"')}"]` });
        if (res.length >= 30) return res;
      }
    }
    return res;
  }, navs.map((n) => n.selector)).catch(() => [] as Array<{ href: string; text: string; selector: string }>);
  const eligible = links.filter((l) => { try { const u = new URL(l.href); return c.firstParty(l.href) && (u.pathname !== here.pathname || u.search !== here.search) && /^https?:$/.test(u.protocol); } catch { return false; } });
  for (const l of eligible) {
    if (out.filter((r) => r.outcome !== "SKIPPED").length >= max) break;
    const t0 = Date.now();
    const base = { kind: "NAVIGATION" as const, componentKey: navs[0]!.key, componentType: "NAV" as const, target: `${l.text || "link"} → ${new URL(l.href).pathname}` };
    const cls = classifyAction({ action: "NAVIGATE", tag: "A", text: l.text, href: l.href });
    if (cls.safety !== "SAFE") { if (out.length < 20) out.push(result(c, { ...base, outcome: "SKIPPED", reason: cls.reason, safety: cls.safety }, t0)); continue; }
    // Phase 4H: never click towards a destination the customer did not allow (the guard would also refuse it)
    if (!pathAllowed(l.href, c.allowedPaths)) { if (out.length < 20) out.push(result(c, { ...base, outcome: "SKIPPED", reason: "outside the allowed paths", safety: "UNSAFE" }, t0)); continue; }
    const back = await backTo(c);
    if (back !== true) { out.push(result(c, { ...base, ...notStarted(back), safety: "SAFE" }, t0)); break; }
    const t = left(c);
    if (t === null) { out.push(result(c, { ...base, outcome: "SKIPPED", reason: "TIME_BUDGET", safety: "SAFE" }, t0)); break; }
    try {
      const nav = c.page.waitForNavigation({ timeout: t, waitUntil: "load" }).then((r) => ({ r }), (e: unknown) => ({ e }));
      await c.page.locator(l.selector).first().click({ timeout: t, noWaitAfter: true });
      const n = await nav;
      if ("e" in n) throw n.e;
      const res = n.r;
      const ro = responseOutcome(res);
      const blank = ro.outcome === "PASSED" ? await c.page.evaluate(() => (document.body?.innerText ?? "").trim().length === 0 && !document.querySelector("img, svg, video, canvas")).catch(() => false) : false;
      out.push(result(c, { ...base, outcome: blank ? "FAILED" : ro.outcome, reason: blank ? "BLANK_PAGE" : ro.reason ? `NAV_${ro.reason}` : null, safety: "SAFE", steps: [{ step: "click link", ok: true, ms: Date.now() - t0 }, { step: "destination loaded", ok: ro.outcome === "PASSED" && !blank, ms: Date.now() - t0, note: ro.reason ?? undefined }] }, t0));
    } catch (e) {
      const nf = await attribute(c, navFailure(e));
      out.push(result(c, { ...base, outcome: nf.outcome, reason: nf.outcome === "INCONCLUSIVE" ? nf.reason : `NAV_${nf.reason}`, safety: "SAFE" }, t0));
    }
  }
  return out;
}

async function formTest(c: Ctx, form: DetectedComponent): Promise<FunctionalResult> {
  const t0 = Date.now();
  const base = { kind: "FORM" as const, componentKey: form.key, componentType: "FORM" as const, target: form.label ?? `form ${String(form.detail.action ?? "")}` };
  if (form.detail.sensitive) return result(c, { ...base, outcome: "SKIPPED", reason: "form has password, payment or file fields", safety: "UNSAFE" }, t0);
  const cls = classifyAction({ action: "FORM_VALIDATE", tag: "FORM", formMethod: String(form.detail.method ?? "get"), formAction: String(form.detail.action ?? "") });
  if (cls.safety !== "SAFE") return result(c, { ...base, outcome: "SKIPPED", reason: cls.reason, safety: cls.safety }, t0);
  const back = await backTo(c);
  if (back !== true) return result(c, { ...base, ...notStarted(back), safety: "SAFE" }, t0);
  const t = left(c);
  if (t === null) return result(c, { ...base, outcome: "SKIPPED", reason: "TIME_BUDGET", safety: "SAFE" }, t0);
  const blockedBefore = c.guard.blocked.length;
  // Everything happens inside the form element: a capturing submit listener cancels any submission, fields get
  // deliberately invalid values (never password/payment/file), constraint validation is queried, the form is reset.
  const r = await c.page.locator(form.selector).first().evaluate((f) => {
    const form = f as HTMLFormElement;
    const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    form.addEventListener("submit", stop, true);
    const fields = Array.from(form.elements).filter((e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement) as Array<HTMLInputElement>;
    const usable = fields.filter((x) => !["hidden", "submit", "button", "reset", "image", "password", "file"].includes(x.type) && !/^cc-|card|cvv|cvc|iban/i.test(`${x.autocomplete} ${x.name}`));
    const labelOf = (x: HTMLInputElement) => (x.labels?.[0]?.textContent ?? x.getAttribute("aria-label") ?? x.placeholder ?? x.name ?? "").replace(/\s+/g, " ").trim();
    const claimsRequired = (x: HTMLInputElement) => x.required || x.getAttribute("aria-required") === "true" || /\*|\(required\)|required/i.test(labelOf(x));
    const findings: string[] = [];
    let constrained = 0, notUsable = 0;
    for (const x of usable) {
      if (x.disabled || x.readOnly) continue;
      const r = x.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, r.left + r.width / 2), r.top + r.height / 2);
      if (hit && hit !== x && !x.contains(hit) && !(x.labels && Array.from(x.labels).some((l) => l.contains(hit))) && r.top >= 0 && r.top < innerHeight) { notUsable++; findings.push(`field "${labelOf(x).slice(0, 40)}" is covered`); }
      const isEmail = x.type === "email" || /e-?mail/i.test(`${x.name} ${labelOf(x)}`);
      if (x instanceof HTMLSelectElement) continue;
      if (isEmail) { x.value = "not-an-email"; constrained++; if (x.type !== "email" && !x.pattern && x.checkValidity()) findings.push(`email field "${labelOf(x).slice(0, 40)}" accepts an invalid address`); }
      else if (claimsRequired(x)) { x.value = ""; constrained++; if (x.checkValidity()) findings.push(`required field "${labelOf(x).slice(0, 40)}" accepts an empty value`); }
    }
    const formValid = form.checkValidity();
    form.reset();
    form.removeEventListener("submit", stop, true);
    return { constrained, notUsable, findings: findings.slice(0, 10), formValid, fields: usable.length };
  }, undefined, { timeout: t }).catch((e: Error) => ({ error: e.message }));
  if ("error" in r) {
    const nf = navFailure({ message: r.error });
    return result(c, { ...base, outcome: nf.outcome === "FAILED" ? "INCONCLUSIVE" : nf.outcome, reason: nf.outcome === "FAILED" ? "FORM_NOT_INSPECTABLE" : nf.reason, safety: "SAFE" }, t0);
  }
  if (c.guard.blocked.length > blockedBefore) return result(c, { ...base, outcome: "SKIPPED", reason: "form sends data on input (blocked by the safety guard)", safety: "UNSAFE" }, t0);
  const steps = [{ step: "fill invalid values (never submitted)", ok: true, ms: Date.now() - t0, note: `${r.constrained} constrained of ${r.fields} field(s)` }];
  if (r.findings.length) return result(c, { ...base, outcome: "FAILED", reason: r.notUsable ? "FORM_FIELD_NOT_USABLE" : "FORM_ACCEPTS_INVALID_INPUT", safety: "SAFE", steps: [...steps, { step: "validation", ok: false, ms: Date.now() - t0, note: r.findings.join("; ").slice(0, 300) }] }, t0);
  if (!r.constrained) return result(c, { ...base, outcome: "SKIPPED", reason: "no client-side constraints to test", safety: "SAFE", steps }, t0);
  return result(c, { ...base, outcome: "PASSED", reason: null, safety: "SAFE", steps: [...steps, { step: "validation rejects invalid input", ok: !r.formValid, ms: Date.now() - t0 }] }, t0);
}

async function buttonTests(c: Ctx, components: DetectedComponent[], max: number, errors: string[]): Promise<FunctionalResult[]> {
  const out: FunctionalResult[] = [];
  let tested = 0, skipped = 0;
  for (const b of components.filter((x) => (x.type === "BUTTON" || x.type === "ACCORDION" || x.type === "TABS") && x.visible).slice(0, 40)) {
    if (tested >= max) break;
    const t0 = Date.now();
    const base = { kind: "BUTTON" as const, componentKey: b.key, componentType: b.type, target: b.label ?? b.type.toLowerCase() };
    const back = await backTo(c);
    if (back !== true) { out.push(result(c, { ...base, ...notStarted(back), safety: "UNKNOWN" }, t0)); break; }
    const f = await factsOf(c, b.type === "ACCORDION" ? `${b.selector} > summary` : b.selector);
    if (!f) continue;
    const cls = classifyAction({ action: "CLICK", ...f });
    if (cls.safety !== "SAFE") { if (skipped++ < 15) out.push(result(c, { ...base, outcome: "SKIPPED", reason: cls.reason, safety: cls.safety as Safety }, t0)); continue; }
    const t = left(c);
    if (t === null) { out.push(result(c, { ...base, outcome: "SKIPPED", reason: "TIME_BUDGET", safety: "SAFE" }, t0)); break; }
    tested++;
    const sel = b.type === "ACCORDION" ? `${b.selector} > summary` : b.selector;
    const blockedBefore = c.guard.blocked.length, errsBefore = errors.length;
    try {
      const before = await c.page.locator(sel).first().evaluate((el) => {
        const id = el.getAttribute("aria-controls");
        const target = id ? document.getElementById(id) : null;
        (window as unknown as { __wimMut?: number }).__wimMut = 0;
        const mo = new MutationObserver((m) => { (window as unknown as { __wimMut: number }).__wimMut += m.length; });
        mo.observe(document.body, { subtree: true, childList: true, attributes: true });
        (window as unknown as { __wimMo?: MutationObserver }).__wimMo = mo;
        return { expanded: el.getAttribute("aria-expanded"), targetVisible: target ? getComputedStyle(target).display !== "none" && target.getBoundingClientRect().height > 0 : null, url: location.href };
      }, undefined, { timeout: 2000 });
      await c.page.locator(sel).first().click({ timeout: Math.min(t, 4000), noWaitAfter: true });
      await c.page.waitForTimeout(300);
      if (c.guard.blocked.length > blockedBefore) { out.push(result(c, { ...base, outcome: "SKIPPED", reason: "button sends data (blocked by the safety guard)", safety: "UNSAFE" }, t0)); continue; }
      const after = await c.page.evaluate((s) => {
        const el = document.querySelector(s);
        const id = el?.getAttribute("aria-controls");
        const target = id ? document.getElementById(id) : null;
        const w = window as unknown as { __wimMut?: number; __wimMo?: MutationObserver };
        w.__wimMo?.disconnect();
        return { expanded: el?.getAttribute("aria-expanded") ?? null, targetVisible: target ? getComputedStyle(target).display !== "none" && target.getBoundingClientRect().height > 0 : null, mutations: w.__wimMut ?? 0, url: location.href, dialog: Boolean(document.querySelector("dialog[open], [role=dialog]:not([hidden]), [aria-modal=true]")) };
      }, sel).catch(() => null);
      if (errors.length > errsBefore) { out.push(result(c, { ...base, outcome: "FAILED", reason: "BUTTON_SCRIPT_ERROR", safety: "SAFE", steps: [{ step: "click", ok: true, ms: Date.now() - t0, note: errors[errors.length - 1] }] }, t0)); continue; }
      const reacted = after !== null && (after.expanded !== before.expanded || after.targetVisible !== before.targetVisible || after.mutations > 0 || after.url !== before.url || after.dialog);
      out.push(result(c, { ...base, outcome: reacted ? "PASSED" : "INCONCLUSIVE", reason: reacted ? null : "NO_OBSERVABLE_EFFECT", safety: "SAFE", steps: [{ step: "click", ok: true, ms: Date.now() - t0 }, { step: "page reacted", ok: reacted, ms: Date.now() - t0 }] }, t0));
      await c.page.keyboard.press("Escape").catch(() => undefined);
    } catch (e) {
      const m = (e as Error).message ?? "";
      if (/intercepts pointer events|not visible|outside of the viewport/.test(m)) out.push(result(c, { ...base, outcome: "FAILED", reason: "BUTTON_NOT_CLICKABLE", safety: "SAFE" }, t0));
      else { const nf = navFailure(e); out.push(result(c, { ...base, outcome: nf.outcome === "FAILED" ? "INCONCLUSIVE" : nf.outcome, reason: nf.reason, safety: "SAFE" }, t0)); }
    }
  }
  return out;
}
