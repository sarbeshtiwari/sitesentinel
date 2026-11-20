import { urlIsUnsafe } from "@wim/core";
import type { openSession } from "@wim/worker-browser";
import { classifyRevealControl, revealRequestDecision, type RevealControlFacts, type RevealKind } from "./discovery.js";

type Browser = Awaited<ReturnType<typeof openSession>>["browser"];
export type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
export type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;
type RouteHandler = Extract<Parameters<BrowserContext["route"]>[1], (...a: never[]) => unknown>;
type Route = Parameters<RouteHandler>[0];

/** How a rendered link was found: by the page load itself, or only after an interaction. */
export type FoundBy = "render" | "scroll" | "load-more" | "toggle";

export const REVEAL_LIMITS = { totalMs: 20_000, actions: 15, loadMore: 5, toggles: 10, scrolls: 5 };

export interface RevealStats { actions: number; scroll: number; loadMore: number; toggle: number; details: number; refused: number; navigationRefused: boolean }

export interface RevealOptions {
  firstParty: (u: string) => boolean;
  /** every URL the passive page load requested: the only third-party requests allowed while interacting */
  baseline: ReadonlySet<string>;
  /** absolute end for this page's interactions (the caller folds in the scan's deadline) */
  end: number;
  /** politeness: called before every interaction (each may make requests to the website) */
  polite: () => Promise<void>;
  /** every anchor seen so far (href → how it was found); new ones are added with the step that revealed them */
  links: Map<string, FoundBy>;
}

const collect = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href).slice(0, 2000)).catch(() => [] as string[]);

/** In the page: mark the controls that could reveal content (bounded) and describe them for the classifier. */
function markControls(): Array<RevealControlFacts & { ctl: string }> {
  const sel = 'button, input[type="button"], [role="button"], [role="tab"], a:not([href]), a[href^="#"], a[href^="javascript:"], [aria-expanded="false"], [aria-controls]';
  const out: Array<RevealControlFacts & { ctl: string }> = [];
  const w = window as unknown as { __wimRv?: number };
  let n = w.__wimRv ?? 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
    if (out.length >= 150) break;
    if (el.dataset.wimRvDone) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none" || (el as HTMLButtonElement).disabled) continue;
    if (!el.dataset.wimRv) el.dataset.wimRv = String(++n);
    const s = (v: string | null | undefined, max = 80) => (v ? v.replace(/\s+/g, " ").trim().slice(0, max) || null : null);
    out.push({
      ctl: el.dataset.wimRv, tag: el.tagName, role: el.getAttribute("role"), text: s(el.innerText || (el as HTMLInputElement).value), ariaLabel: s(el.getAttribute("aria-label")),
      title: s(el.getAttribute("title")), id: s(el.id), className: s(typeof el.className === "string" ? el.className : null, 120), href: el.getAttribute("href"),
      inputType: el.getAttribute("type"), inForm: Boolean(el.closest("form")), inChrome: Boolean(el.closest("nav, header, [role=navigation]")),
      ariaExpanded: el.getAttribute("aria-expanded"), ariaSelected: el.getAttribute("aria-selected"), ariaControls: el.hasAttribute("aria-controls"),
    });
  }
  w.__wimRv = n;
  return out;
}

/**
 * Reveal links hidden behind interactions on a rendered page — in this order: <details> sections (opened through the
 * DOM, nothing clicked), tabs / collapsed sections, "load more" controls (repeated while they add links), infinite
 * scroll (while the page grows). Bounded by {@link REVEAL_LIMITS} and `end`.
 *
 * Safety: only controls {@link classifyRevealControl} accepts are clicked (never in a form, never submit, never a link to
 * another page, never a deny-listed label). While interacting, a context-wide request guard refuses every request that
 * {@link revealRequestDecision} does not allow — so no click can send data (non-GET), leave the page (main-frame
 * navigation, popups), hit a deny-listed URL or call a new third party. A refused navigation ends the interactions.
 */
export async function revealLinks(ctx: BrowserContext, page: Page, o: RevealOptions): Promise<RevealStats> {
  const t0 = Date.now();
  const end = Math.min(o.end, t0 + REVEAL_LIMITS.totalMs);
  const st: RevealStats = { actions: 0, scroll: 0, loadMore: 0, toggle: 0, details: 0, refused: 0, navigationRefused: false };
  const guard = (route: Route) => {
    const r = route.request();
    let mainFrameNavigation = false;
    try { mainFrameNavigation = r.isNavigationRequest() && r.frame().parentFrame() === null; } catch { mainFrameNavigation = r.isNavigationRequest(); }
    const decision = revealRequestDecision({ method: r.method(), url: r.url(), mainFrameNavigation, firstParty: o.firstParty(r.url()), inBaseline: o.baseline.has(r.url()) }, urlIsUnsafe);
    if (decision === "ALLOW") return route.fallback();
    st.refused++;
    if (decision === "NAVIGATION") st.navigationRefused = true;
    return route.abort("blockedbyclient");
  };
  const closePopup = (p: Page) => { if (p !== page) void p.close().catch(() => undefined); };
  await ctx.route("**/*", guard);
  ctx.on("page", closePopup);
  const timeLeft = (need = 1500) => !st.navigationRefused && st.actions < REVEAL_LIMITS.actions && Date.now() + need < end && !page.isClosed();
  /** wait for what an interaction started, then record the anchors it added */
  const settle = async (via: FoundBy) => {
    await page.waitForLoadState("networkidle", { timeout: Math.max(200, Math.min(2000, end - Date.now())) }).catch(() => undefined);
    await page.waitForTimeout(Math.max(0, Math.min(400, end - Date.now()))).catch(() => undefined);
    let added = 0;
    for (const h of await collect(page)) if (!o.links.has(h)) { o.links.set(h, via); added++; }
    return added;
  };
  const click = async (ctl: string) => {
    await o.polite();
    st.actions++;
    return page.locator(`[data-wim-rv="${ctl}"]`).first().click({ timeout: 1500, noWaitAfter: true }).then(() => true, () => false);
  };
  const done = (ctl: string) => page.evaluate((c) => { const el = document.querySelector<HTMLElement>(`[data-wim-rv="${c}"]`); if (el) el.dataset.wimRvDone = "1"; }, ctl).catch(() => undefined);
  const controls = async (kind: RevealKind) => {
    const raw = await page.evaluate(markControls).catch(() => [] as Array<RevealControlFacts & { ctl: string }>);
    return (Array.isArray(raw) ? raw : []).filter((c) => typeof c?.ctl === "string" && /^\d+$/.test(c.ctl) && classifyRevealControl(c).kind === kind);
  };
  try {
    // 1. <details>: opened through the DOM (no click, no event handler of ours)
    if (timeLeft()) {
      const opened = await page.evaluate(() => { const d = Array.from(document.querySelectorAll("details:not([open])")).slice(0, 10); for (const x of d) (x as HTMLDetailsElement).open = true; return d.length; }).catch(() => 0);
      if (opened) { st.details = opened; st.actions++; await settle("toggle"); }
    }
    // 2. tabs and collapsed sections, each at most once
    for (let i = 0; i < REVEAL_LIMITS.toggles && timeLeft(); i++) {
      const c = (await controls("TOGGLE"))[0];
      if (!c) break;
      await done(c.ctl);
      if (!(await click(c.ctl))) continue;
      st.toggle++;
      await settle("toggle");
    }
    // 3. "load more": the same control again while it adds links
    for (let i = 0; i < REVEAL_LIMITS.loadMore && timeLeft(); i++) {
      const c = (await controls("LOAD_MORE"))[0];
      if (!c) break;
      if (!(await click(c.ctl))) { await done(c.ctl); continue; }
      st.loadMore++;
      if (!(await settle("load-more"))) await done(c.ctl);
    }
    // 4. infinite scroll: to the bottom while the page grows or new links appear
    let height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    for (let i = 0; i < REVEAL_LIMITS.scrolls && timeLeft(); i++) {
      await o.polite();
      st.actions++;
      st.scroll++;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => undefined);
      await page.mouse.wheel(0, 400).catch(() => undefined);
      const added = await settle("scroll");
      const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => height);
      if (!added && h <= height) break;
      height = h;
    }
  } catch {
    // the page went away (crash, closed): what was found so far stays
  }
  // The guard stays installed until the caller closes the context: a request a click scheduled for later is refused too.
  return st;
}
