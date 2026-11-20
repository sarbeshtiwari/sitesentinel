import { linkedFileType } from "./frontier.js";

/**
 * Browser-assisted discovery: which pages are rendered in the browser. Listing pages (a blog index, news, projects…)
 * and client-rendered pages often fetch their entries with JavaScript, so their links never appear in the HTML.
 * Two pure decisions, sharing ONE scan-wide budget (`browserPages`) in the engine:
 *  - before the crawl, {@link selectBrowserPages}: the start pages, then top-level listing pages;
 *  - during the crawl, {@link looksClientRendered}: a fetched page whose HTML is a framework shell with (almost) no
 *    content links of its own, or with empty list / grid containers.
 */
export const LISTING_NAME = /(blog|news|article|insight|post|stor(y|ies)|event|press|update|project|product|case-stud|resource|gallery|career)/i;

const pageKey = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
const firstSegment = (u: URL) => u.pathname.split("/").filter(Boolean)[0] ?? "";

/** A top-level page (exactly one path segment, no query, not a file) whose name looks like a listing. */
export function isListingCandidate(u: URL): boolean {
  if (u.search || linkedFileType(u)) return false;
  if (u.pathname.split("/").filter(Boolean).length !== 1) return false;
  return LISTING_NAME.test(firstSegment(u));
}

/**
 * Pages to render before the crawl: the start pages first, then listing candidates — from the sitemap, then from the
 * start pages' rendered links — each group in input order; deduped (a trailing slash is the same page), capped at
 * `limit`. Other pages are rendered only when the crawl finds they look client-rendered. The caller passes only URLs
 * that are in scope (and allowed by robots).
 */
export function selectBrowserPages(starts: URL[], sitemap: URL[], rendered: URL[], limit: number): URL[] {
  const out: URL[] = [];
  const seen = new Set<string>();
  const take = (u: URL) => {
    const k = pageKey(u);
    if (seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push(u);
  };
  for (const u of starts) take(u);
  for (const u of [...sitemap, ...rendered]) if (isListingCandidate(u)) take(u);
  return out;
}

/** What the static analysis saw (see analyzeHtml's `facts.clientShell`) plus the page's in-scope content links. */
export interface ClientShellSignals {
  /** framework / app-shell marker (next, nuxt, angular, vue, gatsby, app-root), or null */
  framework: string | null;
  /** in-scope links outside nav / header / footer */
  contentLinks: number;
  /** list / grid / feed containers (or an app root) with no child element and no text */
  emptyContainers: number;
}
export const CLIENT_RENDERED_MAX_CONTENT_LINKS = 3;

/** A page worth rendering: built by a client framework AND (almost) without content links, or with empty containers. */
export function looksClientRendered(s: ClientShellSignals): boolean {
  if (!s.framework) return false;
  return s.contentLinks <= CLIENT_RENDERED_MAX_CONTENT_LINKS || s.emptyContainers > 0;
}

// ---------------------------------------------------------------- revealing links behind interactions
/**
 * On a rendered page, links can also sit behind "Load more" buttons, tabs / accordions, or infinite scroll. The engine
 * reveals them with a bounded sequence of interactions, each behind a request guard ({@link revealRequestDecision}).
 * Which controls may be clicked is decided here, conservatively: anything not recognisably a "show more content"
 * control is left alone, and the deny-list wins over everything.
 */
export interface RevealControlFacts {
  tag: string;
  role: string | null;
  text: string | null;
  ariaLabel: string | null;
  title: string | null;
  id: string | null;
  className: string | null;
  /** the raw href attribute (null: none) */
  href: string | null;
  inputType: string | null;
  inForm: boolean;
  /** inside nav / header (site navigation: its menus are not page content) */
  inChrome: boolean;
  ariaExpanded: string | null;
  ariaSelected: string | null;
  ariaControls: boolean;
}
export type RevealKind = "LOAD_MORE" | "TOGGLE";

/** Labels of controls that load more entries in place (English first, a few common translations). */
const LOAD_MORE_NAME = new RegExp([
  String.raw`^(load|show|view|see|read|display)\s+(more|all)\b`,
  String.raw`^more\s+(posts|articles|projects|properties|stories|news|items|results|blogs?|events|products|updates)\b`,
  String.raw`^(next|next page|older posts|older entries|older|newer posts|newer entries)(\s*[›»→>]+)?$`,
  String.raw`^[›»→>]{1,3}$`,
  String.raw`^(mehr (laden|anzeigen)|weitere laden|ver más|cargar más|mostrar más|voir plus|charger plus|afficher plus|carica altri|mostra (di più|altro)|meer (laden|tonen)|carregar mais|ver mais|और देखें|もっと見る|加载更多|显示更多)`,
].join("|"), "iu");

/** Words that disqualify a control whatever else it looks like (matched on label, accessible name, title, id, class). */
export const REVEAL_DENY = /\b(buy|pay|payment|checkout|check ?out|cart|basket|order|purchase|donate|subscri(be|ption)|newsletter|sign ?up|signup|register|log ?in|login|sign ?in|signin|log ?out|logout|sign ?out|delete|remove|cancel|unsubscribe|apply|book|booking|reserve|enquir(e|y)|inquir(e|y)|contact|call|whatsapp|submit|send|download|share|like|follow|vote|rate|review|comment|report|upload|accept|agree|confirm)\b/i;

const SAME_PAGE_HREF = /^\s*(#.*|javascript:\s*(void\s*\(?\s*0?\s*\)?\s*;?|;)?\s*)$/i;

/** May this control be clicked to reveal links, and as what? `kind` null = never clicked (with the reason). */
export function classifyRevealControl(f: RevealControlFacts): { kind: RevealKind | null; reason: string } {
  const tag = f.tag.toUpperCase();
  const role = (f.role ?? "").toLowerCase();
  const type = (f.inputType ?? "").toLowerCase();
  if (f.inForm) return { kind: null, reason: "inside a form" };
  if (type === "submit" || type === "image" || type === "reset") return { kind: null, reason: "submits or resets a form" };
  if (tag === "A") {
    if (f.href !== null && !SAME_PAGE_HREF.test(f.href)) return { kind: null, reason: "link to a page (collected, not clicked)" };
  } else if (tag === "INPUT") {
    if (type !== "button") return { kind: null, reason: "not a button" };
  } else if (tag !== "BUTTON" && role !== "button" && role !== "tab") return { kind: null, reason: "not a button" };
  const words = [f.text, f.ariaLabel, f.title, f.id, f.className].filter(Boolean).join(" ").replace(/[_-]+/g, " ").slice(0, 400);
  const deny = REVEAL_DENY.exec(words);
  if (deny) return { kind: null, reason: `deny-list: "${deny[0].toLowerCase()}"` };
  const name = (f.text?.trim() || f.ariaLabel?.trim() || f.title?.trim() || "").replace(/\s+/g, " ").slice(0, 80);
  if (name && name.length <= 40 && LOAD_MORE_NAME.test(name)) return { kind: "LOAD_MORE", reason: "load-more control" };
  if (f.inChrome) return { kind: null, reason: "site navigation" };
  if (role === "tab") return f.ariaSelected === "true" ? { kind: null, reason: "tab already selected" } : { kind: "TOGGLE", reason: "tab" };
  if (f.ariaExpanded === "false") return { kind: "TOGGLE", reason: "collapsed section" };
  if (f.ariaControls && f.ariaExpanded !== "true" && (tag === "BUTTON" || role === "button")) return { kind: "TOGGLE", reason: "controls a section" };
  return { kind: null, reason: "purpose not recognisable as revealing content" };
}

export type RevealRequestDecision = "ALLOW" | "NAVIGATION" | "METHOD" | "UNSAFE" | "THIRD_PARTY";

/**
 * The request guard while interacting (the rules of worker-browser's popup / functional-test guards): only GET/HEAD,
 * no main-frame navigation (nothing leaves the page), no deny-listed destination, and nothing new to a third party
 * (only requests the passive load already made). First-party GETs are allowed (that is how "load more" fetches its
 * entries); a read-only `/api/…` path is not unsafe by itself, but `/api/logout`, one-click tokens etc. still are.
 */
export function revealRequestDecision(
  r: { method: string; url: string; mainFrameNavigation: boolean; firstParty: boolean; inBaseline: boolean },
  unsafe: (u: string) => boolean,
): RevealRequestDecision {
  if (r.mainFrameNavigation) return "NAVIGATION";
  const m = r.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return "METHOD";
  if (unsafe(r.url.replace(/\/api(?=[/?#]|$)/gi, ""))) return "UNSAFE";
  if (!r.firstParty && !r.inBaseline) return "THIRD_PARTY";
  return "ALLOW";
}
