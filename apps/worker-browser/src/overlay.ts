import type { Frame, Page, Request, Route } from "playwright-core";
import { classifyDismissControl, overlayFacts, urlIsUnsafe, type DismissControlFacts, type DismissMethod, type OverlayFacts, type OverlayItem, type OverlayKind, type PopupConfig } from "@wim/core";
import { detectOverlays, markConfiguredClose, overlayGone } from "./page-scripts.js";

/**
 * Popups on load: detect a cookie banner / modal / covering layer after the page loaded (performance has already been
 * measured on the untouched load), and close it with a bounded, side-effect-free sequence:
 *   (a) the website's configured close button, (b) Escape, (c) cookie banners: a reject / necessary-only control,
 *   (d) a close / dismiss control.
 * After each step we re-check whether the overlay is gone.
 *
 * Safety: only controls `classifyDismissControl` accepts are clicked (never accept / sign up / subscribe / buy / log in,
 * never a form submit, never a link to another page). While closing, a page-level guard refuses every request that is
 * not a GET, goes to a deny-listed URL, is a main-frame navigation, or was not already made by the passive page load —
 * so a click can't send consent records, subscribe, or leave the page. Nothing is ever navigated back: a click that
 * tries to leave the page is recorded (NAVIGATED) and closing stops.
 */

const STEP_WAIT_MS = 1500;
const ESCAPE_WAIT_MS = 800;
const TOTAL_MS = 5000;
const MAX_CLICKS = 3;

interface Detected { ov: string; kind: OverlayKind; selector: string; label: string | null; blocksPage: boolean; hasFrame: boolean; controls: Array<DismissControlFacts & { ctl: string }> }

function sanitize(raw: unknown): Detected[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);
  return raw.slice(0, 4).flatMap((x: Record<string, unknown>) => {
    const kind = x?.kind;
    if (kind !== "COOKIE_CONSENT" && kind !== "MODAL" && kind !== "OVERLAY") return [];
    const ov = str(x.ov, 12);
    if (!ov || !/^\d+$/.test(ov)) return [];
    const controls = (Array.isArray(x.controls) ? x.controls : []).slice(0, 25).flatMap((c: Record<string, unknown>) => {
      const ctl = str(c?.ctl, 12);
      if (!ctl || !/^\d+$/.test(ctl)) return [];
      return [{ ctl, tag: str(c.tag, 20) ?? "", text: str(c.text, 80), ariaLabel: str(c.ariaLabel, 80), title: str(c.title, 80), className: str(c.className, 120), id: str(c.id, 80), href: str(c.href, 300), inputType: str(c.inputType, 20), inForm: Boolean(c.inForm) }];
    });
    return [{ ov, kind, selector: str(x.selector, 200) ?? "", label: str(x.label, 80), blocksPage: Boolean(x.blocksPage), hasFrame: Boolean(x.hasFrame), controls }];
  });
}

export interface OverlayRun {
  facts: OverlayFacts;
  /** call after the start page was reloaded (functional tests): closes the popup again, silently */
  redismiss: () => Promise<void>;
}

export interface OverlayOptions {
  config: PopupConfig;
  firstParty: (u: string) => boolean;
  /** URLs the passive page load requested: the only requests allowed while closing */
  baseline: ReadonlySet<string>;
  deadline: number;
  /** requests refused while closing are expected: they must not count as the page's failed resources */
  onBlocked: (r: Request) => void;
}

export async function handleOverlays(page: Page, o: OverlayOptions): Promise<OverlayRun> {
  const t0 = Date.now();
  const blocked = { n: 0 };
  const items = await run(page, o, blocked, Math.min(t0 + TOTAL_MS, o.deadline - 2000));
  return {
    facts: overlayFacts(items, blocked.n, Date.now() - t0),
    redismiss: async () => { if (o.config.dismiss && items.some((i) => i.dismissed)) await run(page, o, { n: 0 }, Math.min(Date.now() + 3000, o.deadline - 2000)); },
  };
}

async function run(page: Page, o: OverlayOptions, blocked: { n: number }, end: number): Promise<OverlayItem[]> {
  const items: OverlayItem[] = [];
  const seen = new Set<string>();
  let clicks = 0;
  let navigated = false;
  for (let round = 0; round < 3 && !navigated; round++) {
    const found = sanitize(await page.evaluate(detectOverlays).catch(() => null)).filter((d) => !seen.has(d.ov));
    const d = found[0];
    if (!d) break;
    seen.add(d.ov);
    const item: OverlayItem = { kind: d.kind, selector: d.selector, label: d.label, dismissed: false, method: null, control: null, attempted: false, reason: null, blocksPage: d.blocksPage };
    items.push(item);
    if (!o.config.dismiss) { item.reason = "DISABLED"; continue; }
    if (Date.now() > end - 300) { item.reason = "TIME_BUDGET"; continue; }
    item.attempted = true;

    // the steps, in order; each one is checked before the next is tried
    type Step = { method: DismissMethod; ctl: string | null; label: string | null };
    const steps: Step[] = [];
    if (o.config.closeSelector && round === 0) {
      const cfg = await page.evaluate(markConfiguredClose, o.config.closeSelector).catch(() => null) as (DismissControlFacts & { ctl: string }) | null;
      if (cfg && classifyDismissControl(cfg, { configured: true }).role) steps.push({ method: "CLOSE_SELECTOR", ctl: "cfg", label: cfg.text || cfg.ariaLabel || null });
    }
    steps.push({ method: "ESCAPE", ctl: null, label: null });
    const classified = d.controls.map((c) => ({ c, role: classifyDismissControl(c).role }));
    const rejects = classified.filter((x) => x.role === "REJECT").map((x): Step => ({ method: "REJECT", ctl: x.c.ctl, label: x.c.text || x.c.ariaLabel || x.c.title || null }));
    const closes = classified.filter((x) => x.role === "CLOSE").map((x): Step => ({ method: "CLOSE_BUTTON", ctl: x.c.ctl, label: x.c.text || x.c.ariaLabel || x.c.title || null }));
    steps.push(...(d.kind === "COOKIE_CONSENT" ? [...rejects, ...closes] : [...closes, ...rejects]));

    for (const st of steps) {
      if (st.ctl && clicks >= MAX_CLICKS) break;
      if (Date.now() > end - 300) { item.reason = "TIME_BUDGET"; break; }
      const r = await step(page, o, blocked, st, Math.min(st.method === "ESCAPE" ? ESCAPE_WAIT_MS : STEP_WAIT_MS, end - Date.now()), d.ov);
      if (st.ctl) clicks++;
      if (r === "NAVIGATED") { item.reason = "NAVIGATED"; navigated = true; break; }
      if (r === "GONE") { item.dismissed = true; item.method = st.method; item.control = st.label ? st.label.slice(0, 60) : null; item.reason = null; break; }
    }
    if (!item.dismissed && !item.reason) item.reason = d.hasFrame && !closes.length && !rejects.length ? "IN_FRAME" : "NO_SAFE_CONTROL";
  }
  return items;
}

/** One dismissal step behind the request guard. */
async function step(page: Page, o: OverlayOptions, blocked: { n: number }, st: { method: DismissMethod; ctl: string | null }, waitMs: number, ov: string): Promise<"GONE" | "STILL" | "NAVIGATED"> {
  const startUrl = page.url().split("#")[0];
  let navigated = false;
  const guard = (route: Route) => {
    const r = route.request();
    const m = r.method().toUpperCase();
    const u = r.url();
    const refuse = () => { blocked.n++; o.onBlocked(r); return route.abort("blockedbyclient"); };
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) { navigated = true; return refuse(); }
    if (m !== "GET" && m !== "HEAD") return refuse();
    if (urlIsUnsafe(u)) return refuse();
    if (!o.baseline.has(u)) return refuse(); // consent records, newsletter calls, trackers: nothing new leaves the browser
    return route.fallback();
  };
  const onNav = (f: Frame) => { if (f === page.mainFrame() && f.url().split("#")[0] !== startUrl) navigated = true; };
  await page.route("**/*", guard);
  page.on("framenavigated", onNav);
  try {
    if (st.method === "ESCAPE") await page.keyboard.press("Escape");
    else await page.locator(`[data-wim-ctl="${st.ctl}"]`).first().click({ timeout: Math.max(300, Math.min(1000, waitMs)), noWaitAfter: true });
  } catch {
    // not clickable (covered, detached, moved): the next step is tried
  }
  let gone = false;
  const until = Date.now() + Math.max(0, waitMs);
  do {
    if (navigated) break;
    gone = await page.evaluate(overlayGone, ov).catch(() => false);
    if (gone) break;
    await page.waitForTimeout(100).catch(() => undefined);
  } while (Date.now() < until);
  await page.unroute("**/*", guard).catch(() => undefined);
  page.off("framenavigated", onNav);
  return navigated ? "NAVIGATED" : gone ? "GONE" : "STILL";
}
