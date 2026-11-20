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
  /** inside a carousel / slider: its controls are clicked only by the carousel step ({@link classifyCarouselControl}) */
  inCarousel?: boolean;
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

const controlWords = (f: Pick<RevealControlFacts, "text" | "ariaLabel" | "title" | "id" | "className">) =>
  [f.text, f.ariaLabel, f.title, f.id, f.className].filter(Boolean).join(" ").replace(/[_-]+/g, " ").slice(0, 400);
const controlName = (f: Pick<RevealControlFacts, "text" | "ariaLabel" | "title">) => (f.text?.trim() || f.ariaLabel?.trim() || f.title?.trim() || "").replace(/\s+/g, " ").slice(0, 80);

/**
 * The refusals every click shares (load more, tabs, carousel controls): never in a form, never submit / reset, never a
 * link to another page, never a non-button (unless `allowPlain`: a DIV / SPAN / LI the caller recognised by its class),
 * never a deny-listed label. Null: may be considered further.
 */
function clickRefusal(f: RevealControlFacts, allowPlain = false): string | null {
  const tag = f.tag.toUpperCase();
  const role = (f.role ?? "").toLowerCase();
  const type = (f.inputType ?? "").toLowerCase();
  if (f.inForm) return "inside a form";
  if (type === "submit" || type === "image" || type === "reset") return "submits or resets a form";
  if (tag === "A") {
    if (f.href !== null && !SAME_PAGE_HREF.test(f.href)) return "link to a page (collected, not clicked)";
  } else if (tag === "INPUT") {
    if (type !== "button") return "not a button";
  } else if (tag !== "BUTTON" && role !== "button" && role !== "tab" && !(allowPlain && ["DIV", "SPAN", "LI"].includes(tag))) return "not a button";
  const deny = REVEAL_DENY.exec(controlWords(f));
  if (deny) return `deny-list: "${deny[0].toLowerCase()}"`;
  return null;
}

/** May this control be clicked to reveal links, and as what? `kind` null = never clicked (with the reason). */
export function classifyRevealControl(f: RevealControlFacts): { kind: RevealKind | null; reason: string } {
  const role = (f.role ?? "").toLowerCase();
  const tag = f.tag.toUpperCase();
  const refused = clickRefusal(f);
  if (refused) return { kind: null, reason: refused };
  if (f.inCarousel) return { kind: null, reason: "carousel control (the carousel step handles it)" };
  const name = controlName(f);
  if (name && name.length <= 40 && LOAD_MORE_NAME.test(name)) return { kind: "LOAD_MORE", reason: "load-more control" };
  if (f.inChrome) return { kind: null, reason: "site navigation" };
  if (role === "tab") return f.ariaSelected === "true" ? { kind: null, reason: "tab already selected" } : { kind: "TOGGLE", reason: "tab" };
  if (f.ariaExpanded === "false") return { kind: "TOGGLE", reason: "collapsed section" };
  if (f.ariaControls && f.ariaExpanded !== "true" && (tag === "BUTTON" || role === "button")) return { kind: "TOGGLE", reason: "controls a section" };
  return { kind: null, reason: "purpose not recognisable as revealing content" };
}

// ---------------------------------------------------------------- hover menus
/** What a candidate hover trigger (a site-navigation item) looks like, described in the page. */
export interface HoverTriggerFacts {
  tag: string;
  role: string | null;
  className: string | null;
  inputType: string | null;
  inForm: boolean;
  /** inside nav / header / [role=navigation] / [role=menubar] */
  inChrome: boolean;
  ariaHaspopup: string | null;
  ariaExpanded: string | null;
  /** an LI (or menu item) with a nested list / submenu container */
  hasSubmenu: boolean;
}
const MENU_CLASS = /(^|[\s_-])(dropdown|mega|megamenu|submenu|has-children|menu-item-has-children|has-submenu|has-dropdown|flyout)([\s_-]|$)/i;

/**
 * May the mouse rest on this element to open a hover menu? Only site-navigation items (or role=menuitem) with a
 * recognisable popup signal: aria-haspopup, aria-expanded, a nested submenu, a dropdown / mega-menu class. Hover never
 * clicks; form fields and anything inside a form are left alone.
 */
export function classifyHoverTrigger(f: HoverTriggerFacts): { ok: boolean; reason: string } {
  const tag = f.tag.toUpperCase();
  const role = (f.role ?? "").toLowerCase();
  if (f.inForm || ["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(tag)) return { ok: false, reason: "form field / inside a form" };
  if (!f.inChrome && role !== "menuitem") return { ok: false, reason: "not site navigation" };
  const popup = (f.ariaHaspopup ?? "").toLowerCase();
  if (popup && popup !== "false") return { ok: true, reason: "aria-haspopup" };
  if (f.ariaExpanded !== null) return { ok: true, reason: "aria-expanded" };
  if (f.hasSubmenu) return { ok: true, reason: role === "menuitem" ? "menu item with a submenu" : "item with a nested list" };
  if (f.className && MENU_CLASS.test(f.className)) return { ok: true, reason: "menu class" };
  return { ok: false, reason: "no submenu signal" };
}

// ---------------------------------------------------------------- carousels / sliders
/** Class names of carousel / slider roots: the libraries' own markers, or the words carousel / slider / slideshow. */
export const CAROUSEL_CLASS = /(^|[\s_-])(swiper|slick|splide|glide|owl|keen|embla|flickity|carousel|slider|slideshow)([\s_-]|$)/i;
const PREV_NAME = /^(prev(ious)?( slide| item| page)?|back|‹|«|←|<|❮|⟨|〈|◀)$/iu;
const NEXT_NAME = /^(next( slide| item| page)?|forward|›|»|→|>|❯|⟩|〉|▶|▸)$/iu;
const NEXT_CLASS = /(swiper-button-next|slick-next|splide__arrow--next|glide__arrow--right|owl-next|embla__(button--)?next|carousel-control-next|(^|[\s_-])(next|arrow-next|arrow-right|btn-next|slider-next|carousel-next|slide-next)([\s_-]|$))/i;
const PREV_CLASS = /(swiper-button-prev|slick-prev|splide__arrow--prev|glide__arrow--left|owl-prev|embla__(button--)?prev|carousel-control-prev|(^|[\s_-])(prev|previous|arrow-prev|arrow-left|btn-prev|slider-prev|carousel-prev|slide-prev)([\s_-]|$))/i;
const DOT_CLASS = /(swiper-pagination-bullet|splide__pagination__page|glide__bullet|owl-dot|embla__dot|flickity-page-dot|carousel-indicator|(^|[\s_-])(dot|bullet|slider-dot|carousel-dot|indicator)([\s_-]|$))/i;
const DOT_NAME = /^((go to |show )?slide\s*\d+( of \d+)?|\d{1,2})$/i;
export type CarouselControlKind = "NEXT" | "DOT";

/** A candidate carousel root, described in the page. */
export interface CarouselRootFacts {
  className: string | null;
  role: string | null;
  ariaRoledescription: string | null;
  /** holds a control labelled "next slide" / "next" (aria-label or title) */
  hasNextSlideControl: boolean;
  inForm: boolean;
}
/** Is this element a carousel / slider? aria-roledescription="carousel", a slider library's class, or a "next slide" control. */
export function isCarouselRoot(f: CarouselRootFacts): boolean {
  if (f.inForm) return false;
  const rd = (f.ariaRoledescription ?? "").toLowerCase();
  if (/carousel|slider|slideshow/.test(rd)) return true;
  if (f.className && CAROUSEL_CLASS.test(f.className)) return true;
  return f.hasNextSlideControl;
}

/**
 * May this control inside a carousel be clicked, and as what? Only "next" arrows and pagination dots; never "previous"
 * (it shows nothing new), never in a form / submit / a link to a page / a deny-listed label. A DIV / SPAN / LI counts
 * only when its class is a carousel control class; a dot already showing its slide is skipped.
 */
export function classifyCarouselControl(f: RevealControlFacts & { current?: boolean }): { kind: CarouselControlKind | null; reason: string } {
  const cls = f.className ?? "";
  const refused = clickRefusal(f, NEXT_CLASS.test(cls) || DOT_CLASS.test(cls));
  if (refused) return { kind: null, reason: refused };
  const name = controlName(f);
  const aria = (f.ariaLabel ?? f.title ?? "").trim();
  if (PREV_NAME.test(name) || /\bprev(ious)?\b/i.test(aria) || PREV_CLASS.test(cls)) return { kind: null, reason: "previous control" };
  if (NEXT_NAME.test(name) || /\bnext\b/i.test(aria) || NEXT_CLASS.test(cls)) return { kind: "NEXT", reason: "next control" };
  if (DOT_NAME.test(name) || DOT_NAME.test(aria) || DOT_CLASS.test(cls) || (f.role ?? "").toLowerCase() === "tab") {
    if (f.current || f.ariaSelected === "true") return { kind: null, reason: "dot already current" };
    return { kind: "DOT", reason: "pagination dot" };
  }
  return { kind: null, reason: "not a carousel control" };
}

// ---------------------------------------------------------------- JavaScript search boxes
/** A form field described in the page (the candidate search field, or another field of its form). */
export interface FieldFacts {
  tag: string;
  inputType: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  /** text of the field's <label> */
  label: string | null;
}
export interface SearchFieldFacts extends FieldFacts {
  role: string | null;
  /** inside [role=search] or a <search> element */
  inSearchLandmark: boolean;
  form: null | {
    method: string | null;
    /** the raw action attribute */
    action: string | null;
    /** the action resolves to the page's own origin (an empty action does) */
    actionSameOrigin: boolean;
    /** every other input / textarea / select of the form */
    otherFields: FieldFacts[];
  };
}

/** Field words that mean personal data or a message: never typed into, and a form holding such a field is never used. */
export const PERSONAL_FIELD = /(e-?mail|pass(word|wd)?|pwd|user(name)?|login|\bname\b|[a-z]name\b|name[_-]|first|last|surname|phone|\btel\b|mobile|whatsapp|message|comment|subject|feedback|enquiry|inquiry|address|street|city|\bzip|postal|post.?code|pincode|card|\bcc|cvv|cvc|iban|account|company|\botp\b|one.?time|\bcode\b|coupon|promo|voucher|birth|\bdob\b|ssn|passport|amount|budget|salary)/i;
const SEARCH_WORD = /(search|query|keyword|suche|buscar|busca|recherche|cerca|zoek|pesquis|検索|搜索|^q$|^s$|^k$|^kw$|^term$)/i;
const SEARCH_ACTION = /(\/(search|find|query|results?|suche|buscar|recherche)(\/|\?|$|\.)|[?&](q|s|query|search)=)/i;
const TEXT_TYPES = new Set(["", "text", "search"]);
/** fields a search form may hold besides the query (filters, buttons); anything else (a second text box, a text area…) disqualifies the form */
const HARMLESS_OTHER = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio"]);

const fieldWords = (f: FieldFacts) => [f.name, f.id, f.placeholder, f.ariaLabel, f.label].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 400);

/**
 * May the scanner type its harmless term into this field? Only a recognisable search box (type=search, role=searchbox,
 * a search landmark, a search-like name / id / placeholder / label, or a form whose action is a search URL) that is a
 * plain text input, carries no personal-data hint (email, password, name, phone, message, address, card…; any
 * autocomplete token), and — when in a form — whose form is GET, sends to the page's own origin and holds no other
 * text-entry field and no personal-data field.
 */
export function classifySearchField(f: SearchFieldFacts): { ok: boolean; reason: string } {
  if (f.tag.toUpperCase() !== "INPUT") return { ok: false, reason: "not an input" };
  const type = (f.inputType ?? "").toLowerCase();
  if (!TEXT_TYPES.has(type)) return { ok: false, reason: `input type ${type}` };
  const auto = (f.autocomplete ?? "").trim().toLowerCase();
  if (auto && auto !== "off" && auto !== "on") return { ok: false, reason: `autocomplete ${auto}` };
  const personal = PERSONAL_FIELD.exec(fieldWords(f).replace(/search|query|keyword/gi, " "));
  if (personal) return { ok: false, reason: `personal-data field: "${personal[0].toLowerCase()}"` };
  if (f.form) {
    const m = (f.form.method ?? "").trim().toLowerCase() || "get";
    if (m !== "get") return { ok: false, reason: `form method ${m}` };
    const action = (f.form.action ?? "").trim();
    if (action && !/^(#|javascript:)/i.test(action) && !f.form.actionSameOrigin) return { ok: false, reason: "form sends to another origin" };
    for (const o of f.form.otherFields) {
      const ot = (o.inputType ?? "").toLowerCase();
      const tag = o.tag.toUpperCase();
      if (tag === "TEXTAREA") return { ok: false, reason: "form has a text area" };
      if (tag === "INPUT" && !HARMLESS_OTHER.has(ot)) return { ok: false, reason: `form has another ${ot || "text"} field` };
      const ow = ot === "submit" || ot === "button" ? null : PERSONAL_FIELD.exec(fieldWords(o));
      if (ow) return { ok: false, reason: `form has a personal-data field: "${ow[0].toLowerCase()}"` };
    }
  }
  if (type === "search") return { ok: true, reason: "type=search" };
  if ((f.role ?? "").toLowerCase() === "searchbox") return { ok: true, reason: "role=searchbox" };
  if (f.inSearchLandmark) return { ok: true, reason: "search landmark" };
  if ([f.name, f.id, f.placeholder, f.ariaLabel, f.label].some((w) => w && SEARCH_WORD.test(w.trim()))) return { ok: true, reason: "search-like name" };
  if (f.form?.action && SEARCH_ACTION.test(f.form.action)) return { ok: true, reason: "search form action" };
  return { ok: false, reason: "not recognisable as a search box" };
}

const SEARCH_BUTTON = /(search|find|\bgo\b|look ?up|🔍|🔎|magnif|loupe|suche|buscar|recherche|cerca|zoek|pesquis)/iu;
export type SearchButtonFacts = Pick<RevealControlFacts, "tag" | "role" | "text" | "ariaLabel" | "title" | "id" | "className" | "href" | "inputType">;
/**
 * May this button (in an accepted search field's form or search container) be clicked to run the search? Only a button
 * whose label / class says search (or "go"); the deny-list wins (a "Submit" / "Send" button never). Submitting is
 * acceptable here only because the field's form passed {@link classifySearchField}.
 */
export function classifySearchButton(f: SearchButtonFacts): { ok: boolean; reason: string } {
  const tag = f.tag.toUpperCase();
  const type = (f.inputType ?? "").toLowerCase();
  if (tag === "A" && f.href !== null && !SAME_PAGE_HREF.test(f.href)) return { ok: false, reason: "link to a page" };
  if (tag === "INPUT" && !["submit", "button", "image"].includes(type)) return { ok: false, reason: "not a button" };
  if (!["BUTTON", "INPUT", "A"].includes(tag) && (f.role ?? "").toLowerCase() !== "button") return { ok: false, reason: "not a button" };
  if (type === "reset") return { ok: false, reason: "reset" };
  const words = controlWords(f);
  const deny = REVEAL_DENY.exec(words);
  if (deny) return { ok: false, reason: `deny-list: "${deny[0].toLowerCase()}"` };
  if (SEARCH_BUTTON.test(words)) return { ok: true, reason: "search button" };
  return { ok: false, reason: "not recognisable as a search button" };
}

/**
 * The one main-frame navigation a JavaScript search may make: GET, to the page's own origin, with the search term in
 * the query string (a results page). Every other navigation stays refused.
 */
export function isSearchNavigation(r: { method: string; url: string }, allow: { origin: string; term: string }): boolean {
  if (r.method.toUpperCase() !== "GET") return false;
  let u: URL;
  try { u = new URL(r.url); } catch { return false; }
  if (u.origin !== allow.origin) return false;
  const term = allow.term.toLowerCase();
  return [...u.searchParams.values()].some((v) => v.toLowerCase().includes(term));
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
  /** only while the search step waits for its results: the one navigation it may make ({@link isSearchNavigation}) */
  searchNavigation: { origin: string; term: string } | null = null,
): RevealRequestDecision {
  // the search's results page: still subject to every rule below (GET, not deny-listed, first party)
  if (r.mainFrameNavigation && !(searchNavigation && isSearchNavigation(r, searchNavigation))) return "NAVIGATION";
  const m = r.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return "METHOD";
  if (unsafe(r.url.replace(/\/api(?=[/?#]|$)/gi, ""))) return "UNSAFE";
  if (!r.firstParty && !r.inBaseline) return "THIRD_PARTY";
  return "ALLOW";
}
