import { z } from "zod";

/**
 * Phase 4F (approved scope): component detection, safe functional tests and the responsive matrix.
 * Pure policy. The browser engine collects facts in the runner's sandboxed Chromium; these functions decide what
 * they mean. Everything here is SYNTHETIC (one Chromium in our infrastructure, through the egress gateway).
 */

// ---------------------------------------------------------------- taxonomy
export const COMPONENT_TYPES = [
  "HEADER", "NAV", "FOOTER", "SEARCH", "FORM", "BUTTON", "LINK", "IMAGE", "DROPDOWN", "MODAL", "TABS", "ACCORDION",
  "SLIDER", "PAGINATION", "TABLE", "RESPONSIVE_NAV", "CARD_GROUP",
] as const;
export type ComponentKind = (typeof COMPONENT_TYPES)[number];

/** One component as detected in one viewport (produced by the in-page detector, validated here). */
export const DetectedComponent = z.object({
  type: z.enum(COMPONENT_TYPES),
  /** structural identity: landmark path + identifying attributes — no positions, no free text */
  key: z.string().min(1).max(400),
  /** best-effort selector to re-locate the element during this run (never persisted as identity) */
  selector: z.string().max(400),
  label: z.string().max(120).nullable(),
  visible: z.boolean(),
  /** identity-relevant details; a change here is a CHANGE, not a new component */
  detail: z.record(z.string(), z.unknown()),
  count: z.number().int().min(1).max(10_000).default(1),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
}).strict();
export type DetectedComponent = z.infer<typeof DetectedComponent>;

/** Validate and bound what the (untrusted) page returned. Invalid items are dropped, not trusted. */
export function sanitizeDetected(raw: unknown, max = 300): DetectedComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: DetectedComponent[] = [];
  for (const x of raw.slice(0, max * 2)) {
    const r = DetectedComponent.safeParse(x);
    if (r.success) out.push({ ...r.data, detail: boundDetail(r.data.detail) });
    if (out.length >= max) break;
  }
  return out;
}
function boundDetail(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d).slice(0, 20)) {
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 40).map((x) => (typeof x === "string" ? x.slice(0, 120) : typeof x === "number" || typeof x === "boolean" ? x : null));
  }
  return out;
}

/** Merge duplicates (same type + key) within one detection: repeated items count, they are not new components. */
export function dedupeComponents(list: DetectedComponent[]): DetectedComponent[] {
  const m = new Map<string, DetectedComponent>();
  for (const c of list) {
    const k = `${c.type}|${c.key}`;
    const prev = m.get(k);
    if (!prev) m.set(k, { ...c });
    else { prev.count += c.count; prev.visible ||= c.visible; }
  }
  return [...m.values()];
}

/** Stable JSON (sorted keys) for hashing the identity-relevant detail. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// ---------------------------------------------------------------- change detection
export interface StoredComponent { id: string; type: ComponentKind; key: string; detailHash: string; status: "PRESENT" | "REMOVED"; missedRuns: number }
export type ComponentChange =
  | { kind: "ADDED"; component: DetectedComponent; detailHash: string }
  | { kind: "RESTORED"; id: string; component: DetectedComponent; detailHash: string }
  | { kind: "CHANGED"; id: string; component: DetectedComponent; detailHash: string; previousHash: string }
  | { kind: "SEEN"; id: string; component: DetectedComponent; detailHash: string }
  | { kind: "MISSED"; id: string; missedRuns: number }
  | { kind: "REMOVED"; id: string; missedRuns: number };

/**
 * Compare this run's (deduplicated, primary-viewport) detection with the stored inventory.
 * - Detection that is not `complete` (page didn't load, budget hit) never counts anything as missing.
 * - A component is REMOVED only after `removeAfter` consecutive complete runs without it (no flapping on a
 *   lazy-loaded widget or an A/B variant that was briefly absent).
 */
export function diffComponents(stored: StoredComponent[], current: Array<DetectedComponent & { detailHash: string }>, complete: boolean, removeAfter = 2): ComponentChange[] {
  const byKey = new Map(stored.map((s) => [`${s.type}|${s.key}`, s]));
  const seen = new Set<string>();
  const out: ComponentChange[] = [];
  for (const c of current) {
    const k = `${c.type}|${c.key}`;
    seen.add(k);
    const s = byKey.get(k);
    if (!s) out.push({ kind: "ADDED", component: c, detailHash: c.detailHash });
    else if (s.status === "REMOVED") out.push({ kind: "RESTORED", id: s.id, component: c, detailHash: c.detailHash });
    else if (s.detailHash !== c.detailHash) out.push({ kind: "CHANGED", id: s.id, component: c, detailHash: c.detailHash, previousHash: s.detailHash });
    else out.push({ kind: "SEEN", id: s.id, component: c, detailHash: c.detailHash });
  }
  if (complete) {
    for (const s of stored) {
      if (s.status !== "PRESENT" || seen.has(`${s.type}|${s.key}`)) continue;
      const missed = s.missedRuns + 1;
      out.push(missed >= removeAfter ? { kind: "REMOVED", id: s.id, missedRuns: missed } : { kind: "MISSED", id: s.id, missedRuns: missed });
    }
  }
  return out;
}

// ---------------------------------------------------------------- safety classification
export type Safety = "SAFE" | "UNSAFE" | "UNKNOWN";
export interface ActionFacts {
  /** CLICK a button/link/control, NAVIGATE to a link, SEARCH (type + Enter), FORM_VALIDATE (fill + checkValidity, never submit) */
  action: "CLICK" | "NAVIGATE" | "SEARCH" | "FORM_VALIDATE";
  tag: string;
  text?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  id?: string | null;
  name?: string | null;
  className?: string | null;
  href?: string | null;
  inputType?: string | null;
  /** the enclosing (or targeted) form */
  formMethod?: string | null;
  formAction?: string | null;
  /** the control toggles something on the page (aria-expanded / aria-controls / summary / data-toggle) */
  toggles?: boolean;
  /** the form contains password, payment or file fields */
  sensitiveFields?: boolean;
}

/**
 * Words that mark an action as potentially destructive or externally consequential. Matched on the visible label,
 * accessible name, title, id, name, class and URL. Conservative by design: a false positive only skips a test.
 */
const DENY = [
  /\b(buy|purchase|pay(ment)?|checkout|check out|order|place order|add to (cart|bag|basket)|cart|basket|donat(e|ion)|subscri(be|ption)|upgrade|billing|invoice)\b/i,
  /\b(delete|remove|destroy|erase|purge|discard|deactivate|disable|close account|terminate|revoke|unsubscribe|cancel)\b/i,
  /\b(log ?out|log ?off|sign ?out|signout|logoff|end session)\b/i,
  /\b(password|passwd|reset|2fa|mfa|security settings)\b/i,
  /\b(submit|send|post|publish|save|update|confirm|apply|book|reserve|register|sign ?up|join|enrol|enroll|upload|transfer|withdraw|approve|reject|vote|rate|review|comment|report)\b/i,
  /\b(admin|wp-admin|dashboard\/delete|api\/)\b/i,
];
const URL_DENY = /\/(logout|log-out|signout|sign-out|logoff|delete|remove|destroy|cancel|unsubscribe|checkout|cart|basket|order|orders|payment|pay|billing|subscribe|account\/(delete|close|password)|password|admin|wp-admin|wp-login|oauth|auth|api|confirm|verify|activate|approve|accept|reject|decline|vote|like|follow|unfollow|share|download|export|reset|redeem|claim|apply|book|reserve|purchase|buy|add|transfer|withdraw|invite)(\/|$|\?|\.|-)/i;
const QUERY_DENY = /[?&](action|do|op|cmd|task|method)=(delete|remove|logout|signout|destroy|cancel|purchase|buy|pay|unsubscribe|add|confirm|approve|reject|vote|like|subscribe|reset)\b|[?&](token|signature|sig|hmac|confirm|confirmation|verification|verify|otp|code|nonce|add-to-cart|add_to_cart|add|remove|delete|vote)=/i;
const FORM_DESTRUCTIVE = /\/(delete|remove|destroy|close|deactivate|password|logout|signout|payment|pay|checkout|transfer|withdraw)(\/|$|\?|\.|-)|\/account\/(delete|close)/i;
const TOGGLE_HINT = /\b(menu|navigation|nav|toggle|open|close menu|expand|collapse|show more|show less|more|less|details|faq|tab|next|previous|prev|slide|accordion|dropdown|filter|sort|view|language|theme)\b/i;

export function urlIsUnsafe(href: string | null | undefined): boolean {
  if (!href) return false;
  if (/^\s*(javascript|data|vbscript|file|mailto|tel|sms):/i.test(href)) return true;
  return URL_DENY.test(href) || QUERY_DENY.test(href);
}

/**
 * Decide whether an automated action may be performed. Anything not confidently SAFE is skipped (UNKNOWN) and the
 * reason recorded. A network guard additionally aborts every non-GET request during interactions, so even a
 * misclassified control cannot submit data.
 */
export function classifyAction(a: ActionFacts): { safety: Safety; reason: string } {
  const words = [a.text, a.ariaLabel, a.title, a.id, a.name, a.className].filter(Boolean).join(" ").replace(/[_-]+/g, " ").slice(0, 400);
  for (const re of DENY) {
    const m = re.exec(words);
    if (m && !(a.action === "SEARCH" && /^(search|find|go)$/i.test(m[0]))) return { safety: "UNSAFE", reason: `deny-list: "${m[0].toLowerCase()}"` };
  }
  // form validation never sends the form (the guard blocks every request): only a destructive purpose disqualifies it
  if (a.action === "FORM_VALIDATE") {
    if (FORM_DESTRUCTIVE.test(a.formAction ?? "")) return { safety: "UNSAFE", reason: "destructive form" };
  } else if (urlIsUnsafe(a.href) || urlIsUnsafe(a.formAction)) return { safety: "UNSAFE", reason: "unsafe destination" };
  const method = (a.formMethod ?? "get").toLowerCase();
  switch (a.action) {
    case "SEARCH":
      if (method !== "get") return { safety: "UNSAFE", reason: `search form uses ${method.toUpperCase()}` };
      if (a.sensitiveFields) return { safety: "UNSAFE", reason: "search form has sensitive fields" };
      return { safety: "SAFE", reason: "GET search" };
    case "NAVIGATE":
      if (!a.href || /^\s*#/.test(a.href)) return { safety: "UNKNOWN", reason: "no navigable destination" };
      return { safety: "SAFE", reason: "GET navigation" };
    case "FORM_VALIDATE":
      // never submitted: fields are filled and the browser's own validation is queried; sensitive fields are not touched
      return { safety: "SAFE", reason: a.sensitiveFields ? "validation only; sensitive fields left untouched" : "validation only, never submitted" };
    case "CLICK": {
      const type = (a.inputType ?? "").toLowerCase();
      if (type === "submit" || type === "image" || type === "reset" || (a.tag === "BUTTON" && type === "" && a.formMethod)) return { safety: "UNSAFE", reason: "submits or resets a form" };
      if (a.tag === "A" && a.href && !/^\s*#/.test(a.href)) return { safety: "UNKNOWN", reason: "link (covered by navigation tests)" };
      if (a.toggles) return { safety: "SAFE", reason: "toggles page content" };
      if (TOGGLE_HINT.test(words)) return { safety: "SAFE", reason: "labelled as a view control" };
      return { safety: "UNKNOWN", reason: "purpose not recognisable as safe" };
    }
  }
}

// ---------------------------------------------------------------- functional tests
export const FUNCTIONAL_TEST_KINDS = ["SEARCH", "NAVIGATION", "FORM", "BUTTON", "RESPONSIVE_NAV"] as const;
export type FunctionalTestKind = (typeof FUNCTIONAL_TEST_KINDS)[number];
export type TestOutcome = "PASSED" | "FAILED" | "SKIPPED" | "INCONCLUSIVE";
export interface FunctionalResult {
  kind: FunctionalTestKind;
  /** component key the test exercised (links the result to the inventory) */
  componentKey: string | null;
  componentType: ComponentKind;
  target: string;
  viewport: string;
  outcome: TestOutcome;
  /** for FAILED / SKIPPED / INCONCLUSIVE: machine-readable reason */
  reason: string | null;
  safety: Safety;
  steps: Array<{ step: string; ok: boolean; ms: number; note?: string }>;
  durationMs: number;
}

/** Reasons that are about OUR infrastructure — never a website failure. */
export const INFRA_REASONS = new Set(["GATEWAY_UNAVAILABLE", "GATEWAY_ERROR", "EGRESS_RATE_LIMITED", "BROWSER_CRASHED", "BROWSER_UNAVAILABLE", "TIME_BUDGET", "PAGE_RELOAD_FAILED"]);

/** The functional verdict for one run: website failures only; skipped and inconclusive tests never fail it. */
export function evaluateFunctional(results: FunctionalResult[]): { status: "PASSED" | "FAILED" | "NONE"; failed: FunctionalResult[]; counts: Record<TestOutcome, number> } {
  const counts: Record<TestOutcome, number> = { PASSED: 0, FAILED: 0, SKIPPED: 0, INCONCLUSIVE: 0 };
  for (const r of results) counts[r.outcome]++;
  const failed = results.filter((r) => r.outcome === "FAILED" && !INFRA_REASONS.has(r.reason ?? ""));
  return { status: failed.length ? "FAILED" : counts.PASSED ? "PASSED" : "NONE", failed, counts };
}

// ---------------------------------------------------------------- responsive matrix
export interface LayoutFacts {
  overflowPx: number;
  offscreenText: number;
  /** text cut off by its own box (overflow hidden without ellipsis) */
  clippedText: number;
  /** pairs of interactive controls overlapping each other */
  overlaps: number;
  /** interactive controls whose centre is covered by another element or lies outside the viewport horizontally */
  obscuredControls: number;
  offscreenControls: number;
  oversizedImages: number;
  /** VISIBLE | COLLAPSED_OK | BROKEN | MISSING | NONE (no navigation on the page) */
  navState: "VISIBLE" | "COLLAPSED_OK" | "BROKEN" | "MISSING" | "NONE";
  samples: Array<{ issue: string; selector: string }>;
}

/** Objective failures fail the viewport; heuristic findings are recorded and shown, never alerted on alone. */
export function evaluateLayout(l: LayoutFacts): { status: "PASSED" | "FAILED"; objective: string[]; heuristic: string[] } {
  const objective: string[] = [];
  const heuristic: string[] = [];
  if (l.overflowPx > 4) objective.push(`horizontal overflow ${l.overflowPx}px`);
  if (l.navState === "BROKEN") objective.push("navigation menu does not open");
  if (l.navState === "MISSING") objective.push("navigation not reachable at this viewport");
  if (l.obscuredControls > 0) objective.push(`${l.obscuredControls} control(s) covered by other elements`);
  if (l.offscreenControls > 0) objective.push(`${l.offscreenControls} control(s) outside the viewport`);
  if (l.overlaps > 0) heuristic.push(`${l.overlaps} overlapping control pair(s)`);
  if (l.clippedText > 0) heuristic.push(`${l.clippedText} clipped text element(s)`);
  if (l.offscreenText > 0) heuristic.push(`${l.offscreenText} text element(s) extend past the viewport`);
  if (l.oversizedImages > 0) heuristic.push(`${l.oversizedImages} image(s) wider than the viewport`);
  return { status: objective.length ? "FAILED" : "PASSED", objective, heuristic };
}

/**
 * Significant layout differences between viewports of the same run: a component visible at the widest observed
 * viewport but neither visible nor reachable through a working menu at a narrower one.
 */
export function compareViewports(byViewport: Array<{ viewport: string; width: number; components: DetectedComponent[]; navState: LayoutFacts["navState"] }>): Array<{ viewport: string; type: ComponentKind; key: string; label: string | null }> {
  if (byViewport.length < 2) return [];
  const widest = [...byViewport].sort((a, b) => b.width - a.width)[0]!;
  const important = new Set<ComponentKind>(["NAV", "SEARCH", "FORM", "HEADER", "FOOTER"]);
  const ref = widest.components.filter((c) => c.visible && important.has(c.type));
  const out: Array<{ viewport: string; type: ComponentKind; key: string; label: string | null }> = [];
  for (const v of byViewport) {
    if (v === widest) continue;
    const here = new Map(v.components.map((c) => [`${c.type}|${c.key}`, c]));
    for (const c of ref) {
      const h = here.get(`${c.type}|${c.key}`);
      if (h?.visible) continue;
      if (c.type === "NAV" && v.navState === "COLLAPSED_OK") continue; // hidden behind a working menu: fine
      if (c.type === "SEARCH" && v.navState === "COLLAPSED_OK" && h?.detail.inMenu === true) continue; // search inside the collapsed menu
      out.push({ viewport: v.viewport, type: c.type, key: c.key, label: c.label });
    }
  }
  return out.slice(0, 50);
}

// ---------------------------------------------------------------- configuration (part of BrowserCheckConfig)
export const FUNCTIONAL_RISK_VERSION_ = 1;
export const FunctionalConfig = z.object({
  /** interactions with the customer's page are opt-in; detection and the responsive matrix are passive */
  enabled: z.boolean().default(false),
  search: z.boolean().default(true),
  navigation: z.boolean().default(true),
  forms: z.boolean().default(true),
  buttons: z.boolean().default(true),
  searchQuery: z.string().min(1).max(40).regex(/^[\p{L}\p{N} ._-]+$/u, "letters, digits, spaces").default("test"),
  maxNavigationLinks: z.number().int().min(0).max(10).default(3),
  maxButtons: z.number().int().min(0).max(10).default(5),
  maxForms: z.number().int().min(0).max(5).default(2),
  /** total budget for all interactions in one run */
  budgetMs: z.number().int().min(5000).max(120_000).default(30_000),
  /**
   * Destination policy (Phase 4H; mandatory since release readiness, blocker 9). Path prefixes the customer declares
   * safe to open, e.g. ["/search", "/products"]. Semantics (enforced by the worker's request guard, every resource type):
   *  - navigation links whose target is outside these prefixes are NOT clicked (recorded SKIPPED);
   *  - links inside them, the search box and SAFE-classified buttons ARE used;
   *  - while interacting, any first-party request outside these prefixes is refused unless the passive page load
   *    already requested exactly that URL; the monitored page itself is always allowed.
   * Interactions do not run while the list is empty.
   */
  allowedPaths: z.array(z.string().regex(/^\/[A-Za-z0-9._~\-/%]*$/, "a path starting with /").max(200)).max(20).default([]),
  /**
   * Phase 4H: the customer's acknowledgement that interactions run against their production site and that a
   * first-party GET can have side effects the platform cannot detect. Written ONLY by the API (from the signed-in user),
   * never accepted from input; interactions never run without it.
   */
  riskAcknowledgement: z.object({ version: z.literal(FUNCTIONAL_RISK_VERSION_), at: z.iso.datetime(), by: z.uuid() }).strict().nullable().default(null),
}).strict();
export type FunctionalConfig = z.infer<typeof FunctionalConfig>;

/** Bump when the risk statement changes: earlier acknowledgements then no longer count. */
export const FUNCTIONAL_RISK_VERSION = FUNCTIONAL_RISK_VERSION_;
export const FUNCTIONAL_RISK_STATEMENT =
  "Functional tests interact with your live website (search, links, form validation, buttons). We only use GET requests, " +
  "never submit forms, skip anything that looks destructive and block risky or third-party destinations — but a page can " +
  "still change data when it receives a GET request, and we cannot detect that. Enable this only for pages where opening " +
  "links and pressing ordinary buttons is harmless, and restrict destinations if you can.";

/** Why functional tests will NOT run (null = they will). Checked by the worker before any interaction. */
export function functionalBlockedReason(cfg: FunctionalConfig, platformEnabled: boolean): string | null {
  if (!cfg.enabled) return "not enabled for this website";
  if (!platformEnabled) return "functional tests are switched off on this platform";
  if (!cfg.riskAcknowledgement || cfg.riskAcknowledgement.version !== FUNCTIONAL_RISK_VERSION) return "the risk acknowledgement is missing";
  // release readiness (blocker 9): explicit safe destinations are mandatory — there is no "whole site" mode
  if (!cfg.allowedPaths.length) return "no allowed paths are configured";
  return null;
}

/** Phase 4H destination policy: is this first-party URL inside the allowed paths? (empty list = all) */
export function pathAllowed(url: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  let p: string;
  try { p = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return false; }
  // "/" means the home page only — never "the whole site" (explicit destinations are mandatory, blocker 9)
  return allowed.some((a) => { const x = a.toLowerCase().replace(/\/+$/, ""); return x === "" ? p === "/" : p === x || p.startsWith(`${x}/`); });
}
