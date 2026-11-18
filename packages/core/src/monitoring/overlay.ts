import { z } from "zod";

/**
 * Popups and overlays on page load (cookie banners, newsletter modals, interstitials) and JavaScript dialogs.
 *
 * The browser engine detects a blocking overlay after the page loaded (and after performance was measured), tries to
 * close it with a bounded, privacy-preserving and side-effect-free sequence of actions, and records what happened.
 * These pure helpers decide which controls may be clicked and how the outcome is evaluated.
 */

// ---------------------------------------------------------------- configuration
/**
 * A plausible CSS selector the customer gives for their popup's close button. It is only ever evaluated with
 * `document.querySelector` inside the monitored page (never a Playwright selector engine), and markup, script URLs
 * and declaration blocks are refused outright. By policy `<` and `>` are refused anywhere, so the child combinator
 * is not available: use a descendant selector (`.modal .close`) instead.
 */
export const PopupCloseSelector = z.string().trim().min(1).max(200)
  .refine((s) => !/javascript:|[<{};\\]|url\(|expression\(|@import/i.test(s) && !/[\u0000-\u001f\u007f]/.test(s), "must be a CSS selector such as #newsletter .close")
  .refine((s) => balanced(s), "brackets, parentheses or quotes are not balanced");

function balanced(s: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (ch === "[" || ch === "(") stack.push(ch);
    else if (ch === "]" || ch === ")") { if (stack.pop() !== (ch === "]" ? "[" : "(")) return false; }
  }
  return !quote && stack.length === 0;
}

export const PopupConfig = z.object({
  /** close cookie banners / popups before the layout checks and functional tests (performance is measured before) */
  dismiss: z.boolean().default(true),
  /** the website's own close button, tried first (still subject to every safety rule) */
  closeSelector: PopupCloseSelector.nullable().default(null),
}).strict();
export type PopupConfig = z.infer<typeof PopupConfig>;

// ---------------------------------------------------------------- facts (collected by the engine)
export const OVERLAY_KINDS = ["COOKIE_CONSENT", "MODAL", "OVERLAY"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export type DismissMethod = "CLOSE_SELECTOR" | "ESCAPE" | "REJECT" | "CLOSE_BUTTON";
/**
 * Why an overlay is still there: DISABLED (customer turned closing off), NO_SAFE_CONTROL (nothing we may click closed
 * it), IN_FRAME (its controls live in an embedded frame we don't operate), NAVIGATED (a click tried to leave the page:
 * refused), TIME_BUDGET.
 */
export type OverlayReason = "DISABLED" | "NO_SAFE_CONTROL" | "IN_FRAME" | "NAVIGATED" | "TIME_BUDGET";

export interface OverlayItem {
  kind: OverlayKind;
  /** a CSS path to the overlay element (structural, bounded) */
  selector: string;
  /** visible label / heading, truncated */
  label: string | null;
  dismissed: boolean;
  method: DismissMethod | null;
  /** the text of the control that closed it (e.g. "Reject all") */
  control: string | null;
  /** a dismissal was attempted (false when closing is switched off) */
  attempted: boolean;
  reason: OverlayReason | null;
  /** modal, or covers the centre / a large share of the viewport (a small corner banner does not block the page) */
  blocksPage: boolean;
}
export interface OverlayFacts {
  found: boolean;
  kind: OverlayKind | null;
  dismissed: boolean;
  method: DismissMethod | null;
  label: string | null;
  control: string | null;
  items: OverlayItem[];
  /** requests the safety guard refused while closing (never sent) */
  blockedRequests: number;
  /** controls covered by the overlay while it stayed open (not counted as CONTROLS_OBSCURED) */
  coveredControls?: number;
  ms: number;
}
export interface DialogFacts {
  count: number;
  items: Array<{ type: string; message: string }>;
}

export function overlayFacts(items: OverlayItem[], blockedRequests: number, ms: number): OverlayFacts {
  const first = items[0] ?? null;
  return {
    found: items.length > 0, kind: first?.kind ?? null, dismissed: items.length > 0 && items.every((i) => i.dismissed),
    method: first?.method ?? null, label: first?.label ?? null, control: first?.control ?? null, items: items.slice(0, 3), blockedRequests, ms,
  };
}

// ---------------------------------------------------------------- which controls may be clicked
export interface DismissControlFacts {
  tag: string;
  text?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  className?: string | null;
  id?: string | null;
  href?: string | null;
  inputType?: string | null;
  /** the control belongs to a form (its own form attribute or an enclosing <form>) */
  inForm?: boolean;
}

/** Privacy-preserving choice on cookie banners: necessary cookies only. Never "accept". */
const REJECT = /^(reject|reject all|reject all cookies|reject cookies|reject optional cookies|reject non-essential( cookies)?|decline|decline all|decline cookies|decline optional cookies|deny|deny all|refuse|refuse all|necessary only|only necessary|necessary cookies only|only necessary cookies|use necessary cookies only|allow necessary cookies only|accept necessary only|essential only|only essential|essential cookies only|strictly necessary only|continue without accepting|ablehnen|alle ablehnen|nur notwendige|refuser|tout refuser|continuer sans accepter|rechazar|rechazar todo|rifiuta|rifiuta tutto|weigeren|alles weigeren)$/i;
const CLOSE = /^(close|close dialog|close modal|close popup|close banner|close this|close window|dismiss|dismiss banner|no thanks|no,? thanks|not now|maybe later|later|skip|continue without accepting|continue without|✕|×|x|✖|✗|╳|schließen|fermer|cerrar|chiudi|sluiten)$/i;
const CLOSE_HINT = /(^|[\s_-])(close|dismiss)([\s_-]|$)/i;
/** never clicked, whatever else the control says */
const NEVER = /\b(accept|agree|allow all|allow cookies|i consent|consent to all|got it|sign ?up|subscribe|join|register|log ?in|sign ?in|buy|pay|purchase|checkout|check out|order|donate|download|install|upgrade|start (free )?trial|get started|claim|redeem|book|reserve|submit|send|confirm|continue to|yes)\b/i;

const words = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Classify a control inside an overlay. REJECT = a "necessary only" / decline control (cookie banners), CLOSE = a close
 * / dismiss control. Anything that submits a form, could sign up / buy / log in / accept, or links to another page is
 * never clicked (null).
 */
export function classifyDismissControl(c: DismissControlFacts, o: { configured?: boolean } = {}): { role: "REJECT" | "CLOSE" | null; reason: string } {
  const tag = c.tag.toUpperCase();
  const type = (c.inputType ?? "").toLowerCase();
  if (c.inForm && (type === "submit" || type === "image" || type === "reset")) return { role: null, reason: "submits or resets a form" };
  if (tag === "BUTTON" && c.inForm && type !== "button") return { role: null, reason: "submits a form" };
  if (tag === "INPUT" && !["button", "submit", "reset", "image"].includes(type)) return { role: null, reason: "a form field" };
  if (tag === "A" && c.href != null) {
    const h = c.href.trim();
    if (h && !h.startsWith("#") && !/^javascript:\s*(void\(0\)|;)?\s*;?$/i.test(h)) return { role: null, reason: "link to another page" };
  }
  const text = words(c.text).slice(0, 80);
  const label = words(c.ariaLabel || c.title).slice(0, 80);
  const all = `${text} ${label}`;
  if (NEVER.test(all) && !REJECT.test(text) && !REJECT.test(label)) return { role: null, reason: "could accept, sign up, buy or log in" };
  // the website's own configured close button: its purpose is declared, the hard rules above still apply
  if (o.configured) return { role: "CLOSE", reason: "configured close button" };
  if (REJECT.test(text) || REJECT.test(label)) return { role: "REJECT", reason: "necessary-only / decline" };
  if (CLOSE.test(text) || CLOSE.test(label) || ((!text || text.length <= 2) && CLOSE_HINT.test(`${label} ${c.className ?? ""} ${c.id ?? ""}`))) return { role: "CLOSE", reason: "close control" };
  return { role: null, reason: "not recognisably a close control" };
}

// ---------------------------------------------------------------- JavaScript dialogs
/** Bounded, secret-scrubbed dialog message for storage (≤ 200 chars). */
export function scrubDialogMessage(m: string): string {
  return m
    .replace(/\bhttps?:\/\/[^\s'"<>]+/gi, (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return "[url]"; } })
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[token]")
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, "[redacted]")
    .replace(/\b\d{12,19}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// ---------------------------------------------------------------- human wording
const KIND_TEXT: Record<OverlayKind, string> = { COOKIE_CONSENT: "A cookie banner", MODAL: "A popup dialog", OVERLAY: "An overlay" };
export function describeOverlayItem(i: OverlayItem): string {
  const what = KIND_TEXT[i.kind];
  if (i.dismissed) {
    const how = i.method === "ESCAPE" ? "closed with the Escape key" : i.method === "CLOSE_SELECTOR" ? `closed with your configured close button${i.control ? ` ("${i.control}")` : ""}` : `closed with "${i.control ?? (i.method === "REJECT" ? "Reject" : "Close")}"`;
    return `${what} covered the page on load; ${how}`;
  }
  switch (i.reason) {
    case "DISABLED": return `${what} covers the page on load (closing popups is switched off; checks ran with it open)`;
    case "IN_FRAME": return `${what} covers the page on load; its buttons are inside an embedded frame we don't operate, so it was left open and controls under it were not checked`;
    case "NAVIGATED": return `${what} covers the page on load; its close control tried to open another page (refused), so it stayed open`;
    case "TIME_BUDGET": return `${what} covers the page on load; there was no time left to close it`;
    default: return i.blocksPage
      ? `${what} covers the page on load and could not be closed (no safe close or reject control worked) — visitors are blocked too`
      : `${what} is shown on load and could not be closed without accepting or signing up; it covers part of the page (checks ran with it open)`;
  }
}

/** The overlay that fails the viewport: one we tried and could not close, where visitors would be blocked too. */
export function blockingOverlay(o: OverlayFacts | null | undefined): OverlayItem | null {
  return o?.items.find((i) => !i.dismissed && i.attempted && i.blocksPage && (i.reason === "NO_SAFE_CONTROL" || i.reason === "NAVIGATED")) ?? null;
}
