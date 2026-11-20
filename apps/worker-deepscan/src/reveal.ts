import { SEARCH_PROBE_TERM, urlIsUnsafe } from "@wim/core";
import type { openSession } from "@wim/worker-browser";
import {
  classifyCarouselControl, classifyHoverTrigger, classifyRevealControl, classifySearchButton, classifySearchField, isCarouselRoot, revealRequestDecision,
  type CarouselRootFacts, type HoverTriggerFacts, type RevealControlFacts, type RevealKind, type SearchButtonFacts, type SearchFieldFacts,
} from "./discovery.js";

type Browser = Awaited<ReturnType<typeof openSession>>["browser"];
export type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
export type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;
type RouteHandler = Extract<Parameters<BrowserContext["route"]>[1], (...a: never[]) => unknown>;
type Route = Parameters<RouteHandler>[0];

/** How a rendered link was found: by the page load itself, or only after an interaction. */
export type FoundBy = "render" | "scroll" | "load-more" | "toggle" | "hover" | "carousel" | "search";

/**
 * Per-page caps. `actions` bounds every step together (details, toggles, carousel clicks, load more, scrolls, hovers,
 * the search); each step also has its own cap so one step cannot use up the page.
 */
export const REVEAL_LIMITS = {
  totalMs: 25_000, actions: 25, loadMore: 5, toggles: 10, scrolls: 5,
  hovers: 15, hoverWaitMs: 300, carousels: 3, carouselClicks: 8, searchWaitMs: 4000,
};
/** JavaScript searches per scan (one per page at most) */
export const MAX_JS_SEARCHES_PER_SCAN = 3;

export interface RevealStats {
  actions: number; scroll: number; loadMore: number; toggle: number; details: number;
  hover: number; carousel: number; carousels: number; search: number; searchNavigated: boolean;
  refused: number; navigationRefused: boolean;
}

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
  /** may this page run a JavaScript search (the scan-wide cap is the caller's) */
  searchAllowed?: boolean;
  /** hover triggers already hovered on another page of this scan (site menus repeat on every page) */
  hovered?: Set<string>;
}

const collect = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href).slice(0, 2000)).catch(() => [] as string[]);

/** In the page: mark the controls that could reveal content (bounded) and describe them for the classifier. */
function markControls(scope: string | null): Array<RevealControlFacts & { ctl: string; current: boolean }> {
  const sel = 'button, input[type="button"], [role="button"], [role="tab"], a:not([href]), a[href^="#"], a[href^="javascript:"], [aria-expanded="false"], [aria-controls]'
    + (scope ? ', [class*="next"], [class*="arrow"], [class*="dot"], [class*="bullet"], [class*="indicator"], [class*="pagination__page"]' : "");
  const root: ParentNode = scope ? document.querySelector(`[data-wim-cr="${scope}"]`) ?? document.createElement("div") : document;
  const out: Array<RevealControlFacts & { ctl: string; current: boolean }> = [];
  const w = window as unknown as { __wimRv?: number };
  let n = w.__wimRv ?? 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
    if (out.length >= 150) break;
    if (el.dataset.wimRvDone) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none" || (el as HTMLButtonElement).disabled) continue;
    if (!el.dataset.wimRv) el.dataset.wimRv = String(++n);
    const s = (v: string | null | undefined, max = 80) => (v ? v.replace(/\s+/g, " ").trim().slice(0, max) || null : null);
    const cls = typeof el.className === "string" ? el.className : null;
    out.push({
      ctl: el.dataset.wimRv, tag: el.tagName, role: el.getAttribute("role"), text: s(el.innerText || (el as HTMLInputElement).value), ariaLabel: s(el.getAttribute("aria-label")),
      title: s(el.getAttribute("title")), id: s(el.id), className: s(cls, 120), href: el.getAttribute("href"),
      inputType: el.getAttribute("type"), inForm: Boolean(el.closest("form")), inChrome: Boolean(el.closest("nav, header, [role=navigation]")),
      ariaExpanded: el.getAttribute("aria-expanded"), ariaSelected: el.getAttribute("aria-selected"), ariaControls: el.hasAttribute("aria-controls"),
      inCarousel: Boolean(el.closest("[data-wim-cr]")),
      current: el.getAttribute("aria-current") === "true" || /(^|\s)(active|is-active|current|selected)(\s|$)|bullet-active/.test(cls ?? ""),
    });
  }
  w.__wimRv = n;
  return out;
}

/** In the page: mark carousel candidates (outermost first) and describe them. */
function markCarousels(): Array<CarouselRootFacts & { cr: string; within: string | null }> {
  const sel = '[aria-roledescription], [class*="swiper"], [class*="slick"], [class*="splide"], [class*="glide"], [class*="owl-"], [class*="keen-slider"], [class*="embla"], [class*="flickity"], [class*="carousel"], [class*="slider"], [class*="slideshow"]';
  const cands = new Set<HTMLElement>(Array.from(document.querySelectorAll<HTMLElement>(sel)).slice(0, 200));
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("[aria-label], [title]")).slice(0, 500)) {
    if (!/\bnext\s+(slide|image|item)\b/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`)) continue;
    let p = b.parentElement;
    for (let i = 0; p && i < 5 && !p.querySelector("a[href], img"); i++) p = p.parentElement;
    if (p && p !== document.body) cands.add(p);
  }
  const out: Array<CarouselRootFacts & { cr: string; within: string | null }> = [];
  let n = 0;
  // document order: ancestors before what they contain
  const ordered = Array.from(cands).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const el of ordered) {
    if (out.length >= 30) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    el.dataset.wimCr = el.dataset.wimCr ?? String(++n);
    const within = el.parentElement?.closest<HTMLElement>("[data-wim-cr]")?.dataset.wimCr ?? null;
    const labelled = Array.from(el.querySelectorAll("[aria-label], [title]")).some((b) => /\bnext\b/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`));
    out.push({
      cr: el.dataset.wimCr, within, className: typeof el.className === "string" ? el.className.slice(0, 200) : null, role: el.getAttribute("role"),
      ariaRoledescription: el.getAttribute("aria-roledescription"), hasNextSlideControl: labelled, inForm: Boolean(el.closest("form")),
    });
  }
  return out;
}

/** In the page: anchors of a carousel that are not currently on screen inside it (hidden slides). */
function hiddenSlideLinks(cr: string): string[] {
  const root = document.querySelector<HTMLElement>(`[data-wim-cr="${cr}"]`);
  if (!root) return [];
  const box = root.getBoundingClientRect();
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 300).filter((a) => {
    const r = a.getBoundingClientRect();
    const st = getComputedStyle(a);
    return r.width < 1 || r.height < 1 || st.visibility === "hidden" || r.right <= box.left + 1 || r.left >= box.right - 1 || r.bottom <= box.top + 1 || r.top >= box.bottom - 1;
  }).map((a) => a.href);
}

/** In the page: mark site-navigation items that may open a menu on hover, and describe them. */
function markHoverTriggers(): Array<HoverTriggerFacts & { hv: string; within: string | null; key: string }> {
  const sel = '[aria-haspopup], [aria-expanded], [role="menuitem"], nav li, header li, [role="navigation"] li, [role="menubar"] li, [class*="dropdown"], [class*="mega"], [class*="submenu"], [class*="sub-menu"], [class*="has-children"], [class*="flyout"]';
  const out: Array<HoverTriggerFacts & { hv: string; within: string | null; key: string }> = [];
  const w = window as unknown as { __wimHv?: number };
  let n = w.__wimHv ?? 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
    if (out.length >= 150) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
    el.dataset.wimHv = el.dataset.wimHv ?? String(++n);
    const cls = typeof el.className === "string" ? el.className.slice(0, 200) : null;
    const sub = el.tagName === "LI" || el.getAttribute("role") === "menuitem"
      ? Boolean(el.querySelector(':scope > ul, :scope > ol, :scope > [role="menu"], :scope > div, :scope > section'))
      : false;
    const label = (el.getAttribute("aria-label") ?? (el.innerText || "").split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    out.push({
      hv: el.dataset.wimHv, within: el.parentElement?.closest<HTMLElement>("[data-wim-hv]")?.dataset.wimHv ?? null,
      key: `${el.tagName}|${label}|${el.getAttribute("href") ?? el.querySelector("a")?.getAttribute("href") ?? ""}`,
      tag: el.tagName, role: el.getAttribute("role"), className: cls, inputType: el.getAttribute("type"), inForm: Boolean(el.closest("form")),
      inChrome: Boolean(el.closest('nav, header, [role="navigation"], [role="menubar"]')),
      ariaHaspopup: el.getAttribute("aria-haspopup"), ariaExpanded: el.getAttribute("aria-expanded"), hasSubmenu: sub,
    });
  }
  w.__wimHv = n;
  return out;
}

/** In the page: mark visible text inputs and describe them (with their form's other fields) for the search classifier. */
function markSearchFields(): Array<SearchFieldFacts & { sf: string }> {
  const s = (v: string | null | undefined, max = 80) => (v ? v.replace(/\s+/g, " ").trim().slice(0, max) || null : null);
  const field = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => ({
    tag: el.tagName, inputType: el.getAttribute("type"), name: s(el.getAttribute("name")), id: s(el.id), placeholder: s(el.getAttribute("placeholder")),
    ariaLabel: s(el.getAttribute("aria-label")), autocomplete: s(el.getAttribute("autocomplete")),
    label: s(Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.innerText).join(" ")),
  });
  const out: Array<SearchFieldFacts & { sf: string }> = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>("input")).slice(0, 100)) {
    if (out.length >= 30) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none" || el.disabled || el.readOnly) continue;
    el.dataset.wimSf = String(++n);
    const f = el.form;
    let sameOrigin = true;
    try { sameOrigin = new URL(f?.getAttribute("action") ?? "", location.href).origin === location.origin; } catch { sameOrigin = false; }
    out.push({
      sf: el.dataset.wimSf, ...field(el), role: el.getAttribute("role"), inSearchLandmark: Boolean(el.closest('[role="search"], search')),
      form: f ? {
        method: f.getAttribute("method"), action: f.getAttribute("action"), actionSameOrigin: sameOrigin,
        otherFields: Array.from(f.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")).filter((x) => x !== el).slice(0, 40).map(field),
      } : null,
    });
  }
  return out;
}

/** In the page: mark the buttons that may run the search of field `sf` (its form, else its search container). */
function markSearchButtons(sf: string): Array<SearchButtonFacts & { sb: string }> {
  const el = document.querySelector<HTMLInputElement>(`[data-wim-sf="${sf}"]`);
  if (!el) return [];
  let scope: HTMLElement | null = el.form ?? el.closest<HTMLElement>('[role="search"], search');
  for (let p = el.parentElement, i = 0; !scope && p && i < 3; p = p.parentElement, i++) if (p.querySelector("button, [role=button], input[type=submit], input[type=button], input[type=image]")) scope = p;
  if (!scope) return [];
  const s = (v: string | null | undefined, max = 80) => (v ? v.replace(/\s+/g, " ").trim().slice(0, max) || null : null);
  const out: Array<SearchButtonFacts & { sb: string }> = [];
  let n = 0;
  for (const b of Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"], input[type="image"], a:not([href]), a[href^="#"]')).slice(0, 10)) {
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || (b as HTMLButtonElement).disabled) continue;
    b.dataset.wimSb = String(++n);
    out.push({
      sb: b.dataset.wimSb, tag: b.tagName, role: b.getAttribute("role"), text: s(b.innerText || (b as HTMLInputElement).value), ariaLabel: s(b.getAttribute("aria-label")),
      title: s(b.getAttribute("title")), id: s(b.id), className: s(typeof b.className === "string" ? b.className : null, 120), href: b.getAttribute("href"), inputType: b.getAttribute("type"),
    });
  }
  return out;
}

const okId = (x: unknown): x is string => typeof x === "string" && /^\d+$/.test(x);

/**
 * Reveal links hidden behind interactions on a rendered page — in this order: <details> sections (opened through the
 * DOM, nothing clicked), tabs / collapsed sections, carousels / sliders (links of every slide already in the DOM, then
 * "next" arrows / pagination dots while they add links), "load more" controls (repeated while they add links), infinite
 * scroll (while the page grows), hover menus of the site navigation (hover, focus as fallback — never a click), and last
 * one JavaScript search (a harmless term typed into a recognised search box). Bounded by {@link REVEAL_LIMITS} and `end`.
 *
 * Safety: only controls the classifiers in discovery.ts accept are clicked or hovered (never in a form — except the
 * search box's own button, never submit, never a link to another page, never a deny-listed label), and the scanner types
 * only into a field {@link classifySearchField} accepts. While interacting, a context-wide request guard refuses every
 * request that {@link revealRequestDecision} does not allow — so nothing can send data (non-GET), leave the page
 * (main-frame navigation, popups), hit a deny-listed URL or call a new third party. The one exception: while the search
 * waits for its results, ONE same-origin GET navigation whose query contains the search term. A refused navigation ends
 * the interactions; after the search nothing else is done on the page.
 */
export async function revealLinks(ctx: BrowserContext, page: Page, o: RevealOptions): Promise<RevealStats> {
  const t0 = Date.now();
  const end = Math.min(o.end, t0 + REVEAL_LIMITS.totalMs);
  const st: RevealStats = { actions: 0, scroll: 0, loadMore: 0, toggle: 0, details: 0, hover: 0, carousel: 0, carousels: 0, search: 0, searchNavigated: false, refused: 0, navigationRefused: false };
  let pageOrigin = "";
  try { pageOrigin = new URL(page.url()).origin; } catch { /* about:blank */ }
  /** set only while the search waits for its results; consumed by the first navigation it allows */
  let searchNavigation: { origin: string; term: string } | null = null;
  const guard = (route: Route) => {
    const r = route.request();
    let mainFrameNavigation = false;
    try { mainFrameNavigation = r.isNavigationRequest() && r.frame().parentFrame() === null; } catch { mainFrameNavigation = r.isNavigationRequest(); }
    const decision = revealRequestDecision({ method: r.method(), url: r.url(), mainFrameNavigation, firstParty: o.firstParty(r.url()), inBaseline: o.baseline.has(r.url()) }, urlIsUnsafe, mainFrameNavigation ? searchNavigation : null);
    if (decision === "ALLOW") {
      if (mainFrameNavigation) { searchNavigation = null; st.searchNavigated = true; }
      return route.fallback();
    }
    st.refused++;
    if (decision === "NAVIGATION") st.navigationRefused = true;
    return route.abort("blockedbyclient");
  };
  const closePopup = (p: Page) => { if (p !== page) void p.close().catch(() => undefined); };
  await ctx.route("**/*", guard);
  ctx.on("page", closePopup);
  const timeLeft = (need = 1500) => !st.navigationRefused && !st.searchNavigated && st.actions < REVEAL_LIMITS.actions && Date.now() + need < end && !page.isClosed();
  const record = async (via: FoundBy) => {
    let added = 0;
    for (const h of await collect(page)) if (!o.links.has(h)) { o.links.set(h, via); added++; }
    return added;
  };
  /** wait for what an interaction started, then record the anchors it added */
  const settle = async (via: FoundBy, idleMs = 2000, waitMs = 400) => {
    await page.waitForLoadState("networkidle", { timeout: Math.max(200, Math.min(idleMs, end - Date.now())) }).catch(() => undefined);
    await page.waitForTimeout(Math.max(0, Math.min(waitMs, end - Date.now()))).catch(() => undefined);
    return record(via);
  };
  const click = async (sel: string) => {
    await o.polite();
    st.actions++;
    return page.locator(sel).first().click({ timeout: 1500, noWaitAfter: true }).then(() => true, () => false);
  };
  const rv = (ctl: string) => `[data-wim-rv="${ctl}"]`;
  const done = (ctl: string) => page.evaluate((c) => { const el = document.querySelector<HTMLElement>(`[data-wim-rv="${c}"]`); if (el) el.dataset.wimRvDone = "1"; }, ctl).catch(() => undefined);
  const describe = async (scope: string | null = null) => {
    const raw = await page.evaluate(markControls, scope).catch(() => [] as Array<RevealControlFacts & { ctl: string; current: boolean }>);
    return (Array.isArray(raw) ? raw : []).filter((c) => okId(c?.ctl));
  };
  const controls = async (kind: RevealKind) => (await describe()).filter((c) => classifyRevealControl(c).kind === kind);
  try {
    // 0. carousels are detected first, so their arrows / dots are left to the carousel step (not taken for "load more")
    const roots: string[] = [];
    {
      const raw = await page.evaluate(markCarousels).catch(() => [] as Array<CarouselRootFacts & { cr: string; within: string | null }>);
      const inside = new Set<string>(); // accepted roots and everything nested in them (one carousel, not its slides)
      for (const c of Array.isArray(raw) ? raw : []) {
        if (!okId(c?.cr)) continue;
        if (c.within && inside.has(c.within)) { inside.add(c.cr); continue; }
        if (!isCarouselRoot(c)) continue;
        inside.add(c.cr);
        if (roots.length < REVEAL_LIMITS.carousels) roots.push(c.cr);
      }
      // unmark the rest (nested parts, non-carousels), so their controls stay with the other steps
      await page.evaluate((keep) => { for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-wim-cr]"))) if (!keep.includes(el.dataset.wimCr!)) delete el.dataset.wimCr; }, roots).catch(() => undefined);
    }
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
      if (!(await click(rv(c.ctl)))) continue;
      st.toggle++;
      await settle("toggle");
    }
    // 3. carousels: links of every slide already in the DOM (hidden ones too: visitors reach them), then "next" / dots
    for (const cr of roots) {
      if (!timeLeft()) break;
      st.carousels++;
      for (const h of await page.evaluate(hiddenSlideLinks, cr).catch(() => [] as string[])) if (o.links.get(h) === "render") o.links.set(h, "carousel");
      let idle = 0;
      for (let i = 0; i < REVEAL_LIMITS.carouselClicks && timeLeft(); i++) {
        const cands = (await describe(cr)).map((c) => ({ c, k: classifyCarouselControl(c).kind })).filter((x) => x.k);
        const next = cands.find((x) => x.k === "NEXT") ?? cands.find((x) => x.k === "DOT" && !x.c.current);
        if (!next) break;
        if (next.k === "DOT") await done(next.c.ctl);
        if (!(await click(rv(next.c.ctl)))) { await done(next.c.ctl); continue; }
        st.carousel++;
        const added = await settle("carousel", 1000, 400);
        // no new anchor on two clicks in a row: every slide seen (a looping carousel shows the same ones again)
        idle = added ? 0 : idle + 1;
        if (idle >= 2) break;
      }
    }
    // 4. "load more": the same control again while it adds links
    for (let i = 0; i < REVEAL_LIMITS.loadMore && timeLeft(); i++) {
      const c = (await controls("LOAD_MORE"))[0];
      if (!c) break;
      if (!(await click(rv(c.ctl)))) { await done(c.ctl); continue; }
      st.loadMore++;
      if (!(await settle("load-more"))) await done(c.ctl);
    }
    // 5. infinite scroll: to the bottom while the page grows or new links appear
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
    // 6. hover menus of the site navigation: one trigger at a time, hover (focus as fallback), never a click
    if (timeLeft()) {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
      const raw = await page.evaluate(markHoverTriggers).catch(() => [] as Array<HoverTriggerFacts & { hv: string; within: string | null; key: string }>);
      const inside = new Set<string>(); // accepted triggers and everything nested in them (the item, not its link too)
      const triggers: Array<{ hv: string; key: string }> = [];
      for (const t of Array.isArray(raw) ? raw : []) {
        if (!okId(t?.hv)) continue;
        if (t.within && inside.has(t.within)) { inside.add(t.hv); continue; }
        if (!classifyHoverTrigger(t).ok) continue;
        inside.add(t.hv);
        if (!o.hovered?.has(t.key)) triggers.push({ hv: t.hv, key: String(t.key).slice(0, 200) });
      }
      for (const t of triggers.slice(0, REVEAL_LIMITS.hovers)) {
        if (!timeLeft(800)) break;
        await o.polite();
        st.actions++;
        const loc = page.locator(`[data-wim-hv="${t.hv}"]`).first();
        const ok = await loc.hover({ timeout: 1000 }).then(() => true, () => false) || await loc.focus({ timeout: 500 }).then(() => true, () => false);
        if (!ok) continue;
        st.hover++;
        if (o.hovered && o.hovered.size < 500) o.hovered.add(t.key);
        await settle("hover", 800, REVEAL_LIMITS.hoverWaitMs);
      }
      await page.mouse.move(0, 0).catch(() => undefined);
    }
    // 7. one JavaScript search: harmless term, recognised search box only, GET only (the guard), results collected
    if (o.searchAllowed && pageOrigin && timeLeft(REVEAL_LIMITS.searchWaitMs)) {
      const fields = await page.evaluate(markSearchFields).catch(() => [] as Array<SearchFieldFacts & { sf: string }>);
      const field = (Array.isArray(fields) ? fields : []).find((f) => okId(f?.sf) && classifySearchField(f).ok);
      if (field) {
        const buttons = await page.evaluate(markSearchButtons, field.sf).catch(() => [] as Array<SearchButtonFacts & { sb: string }>);
        const button = (Array.isArray(buttons) ? buttons : []).find((b) => okId(b?.sb) && classifySearchButton(b).ok);
        await o.polite();
        st.actions++;
        const input = page.locator(`[data-wim-sf="${field.sf}"]`).first();
        if (await input.fill(SEARCH_PROBE_TERM, { timeout: 1500 }).then(() => true, () => false)) {
          st.search++;
          searchNavigation = { origin: pageOrigin, term: SEARCH_PROBE_TERM };
          const before = page.url();
          if (button) await page.locator(`[data-wim-sb="${button.sb}"]`).first().click({ timeout: 1500, noWaitAfter: true }).catch(() => undefined);
          else await input.press("Enter", { timeout: 1500, noWaitAfter: true }).catch(() => undefined);
          const until = Math.min(end, Date.now() + REVEAL_LIMITS.searchWaitMs);
          await page.waitForTimeout(Math.max(0, Math.min(500, until - Date.now()))).catch(() => undefined);
          if (st.searchNavigated || page.url() !== before) await page.waitForLoadState("load", { timeout: Math.max(200, until - Date.now()) }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: Math.max(200, until - Date.now()) }).catch(() => undefined);
          searchNavigation = null; // from here every navigation is refused again
          await page.waitForTimeout(Math.max(0, Math.min(300, end - Date.now()))).catch(() => undefined);
          await record("search");
        }
      }
    }
  } catch {
    // the page went away (crash, closed): what was found so far stays
  }
  searchNavigation = null;
  // The guard stays installed until the caller closes the context: a request a click scheduled for later is refused too.
  return st;
}
