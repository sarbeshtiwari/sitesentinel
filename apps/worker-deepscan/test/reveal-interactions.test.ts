import { describe, expect, it } from "vitest";
import { SEARCH_PROBE_TERM, urlIsUnsafe } from "@wim/core";
import {
  classifyCarouselControl, classifyHoverTrigger, classifyRevealControl, classifySearchButton, classifySearchField, isCarouselRoot, isSearchNavigation, revealRequestDecision,
  type CarouselRootFacts, type FieldFacts, type HoverTriggerFacts, type RevealControlFacts, type SearchButtonFacts, type SearchFieldFacts,
} from "../src/discovery.js";

/** Issue #28 — hover menus, carousels / sliders and JavaScript search boxes: which elements may be hovered, clicked or typed into. */

describe("hover menus: which navigation items are hovered", () => {
  const base: HoverTriggerFacts = { tag: "LI", role: null, className: null, inputType: null, inForm: false, inChrome: true, ariaHaspopup: null, ariaExpanded: null, hasSubmenu: false };
  const ok = (f: Partial<HoverTriggerFacts>) => classifyHoverTrigger({ ...base, ...f }).ok;
  it("navigation items with a popup signal", () => {
    expect(ok({ tag: "A", ariaHaspopup: "true" })).toBe(true);
    expect(ok({ tag: "BUTTON", ariaHaspopup: "menu" })).toBe(true);
    expect(ok({ tag: "BUTTON", ariaExpanded: "false" })).toBe(true);
    expect(ok({ hasSubmenu: true })).toBe(true);
    expect(ok({ className: "menu-item menu-item-has-children" })).toBe(true);
    expect(ok({ className: "nav-item dropdown" })).toBe(true);
    expect(ok({ className: "has-mega" })).toBe(true);
    expect(ok({ tag: "DIV", role: "menuitem", inChrome: false, hasSubmenu: true })).toBe(true); // a menubar outside nav
  });
  it("never: plain items, items outside the navigation, form fields, aria-haspopup=false", () => {
    expect(ok({})).toBe(false);
    expect(ok({ className: "nav-item" })).toBe(false);
    expect(ok({ inChrome: false, ariaHaspopup: "true" })).toBe(false);
    expect(ok({ tag: "INPUT", inputType: "text", ariaExpanded: "false" })).toBe(false); // e.g. a combobox in the header
    expect(ok({ tag: "SELECT", ariaHaspopup: "listbox" })).toBe(false);
    expect(ok({ tag: "BUTTON", inForm: true, ariaHaspopup: "true" })).toBe(false);
    expect(ok({ ariaHaspopup: "false" })).toBe(false);
  });
});

describe("carousels / sliders", () => {
  const root: CarouselRootFacts = { className: null, role: null, ariaRoledescription: null, hasNextSlideControl: false, inForm: false };
  it("recognises carousel roots by aria-roledescription, library classes and 'next slide' controls", () => {
    expect(isCarouselRoot({ ...root, role: "region", ariaRoledescription: "carousel" })).toBe(true);
    for (const className of ["swiper", "slick-slider", "splide", "glide", "owl-carousel", "keen-slider", "embla", "hero-carousel", "testimonial-slider", "slideshow"]) expect(isCarouselRoot({ ...root, className }), className).toBe(true);
    expect(isCarouselRoot({ ...root, hasNextSlideControl: true })).toBe(true);
    expect(isCarouselRoot({ ...root, className: "card-grid" })).toBe(false);
    expect(isCarouselRoot({ ...root, className: "slideshow", inForm: true })).toBe(false);
  });
  const ctl: RevealControlFacts = { tag: "BUTTON", role: null, text: null, ariaLabel: null, title: null, id: null, className: null, href: null, inputType: "button", inForm: false, inChrome: false, ariaExpanded: null, ariaSelected: null, ariaControls: false, inCarousel: true };
  const kind = (f: Partial<RevealControlFacts & { current: boolean }>) => classifyCarouselControl({ ...ctl, ...f }).kind;
  it("clicks next arrows and pagination dots", () => {
    for (const text of ["Next", "›", "»", "→", "❯", "Next slide"]) expect(kind({ text }), text).toBe("NEXT");
    expect(kind({ ariaLabel: "Next slide" })).toBe("NEXT");
    expect(kind({ tag: "DIV", inputType: null, className: "swiper-button-next" })).toBe("NEXT");
    expect(kind({ tag: "SPAN", inputType: null, className: "slick-next" })).toBe("NEXT");
    expect(kind({ ariaLabel: "Go to slide 3" })).toBe("DOT");
    expect(kind({ tag: "SPAN", inputType: null, className: "swiper-pagination-bullet" })).toBe("DOT");
    expect(kind({ text: "2" })).toBe("DOT");
    expect(kind({ role: "tab", ariaLabel: "Slide 2" })).toBe("DOT");
  });
  it("never: previous, the current dot, plain elements without a control class, links, forms, deny-listed", () => {
    for (const text of ["Prev", "Previous", "‹", "«", "←"]) expect(kind({ text }), text).toBeNull();
    expect(kind({ ariaLabel: "Previous slide" })).toBeNull();
    expect(kind({ className: "swiper-button-prev" })).toBeNull();
    expect(kind({ ariaLabel: "Go to slide 1", current: true })).toBeNull();
    expect(kind({ role: "tab", ariaLabel: "Slide 1", ariaSelected: "true" })).toBeNull();
    expect(kind({ tag: "DIV", inputType: null, text: "Next" })).toBeNull(); // a div without a control class
    expect(kind({ tag: "A", inputType: null, href: "/projects/next-one", text: "Next" })).toBeNull();
    expect(kind({ text: "Next", inForm: true })).toBeNull();
    expect(kind({ text: "Next", inputType: "submit" })).toBeNull();
    expect(kind({ text: "Buy now" })).toBeNull();
    expect(kind({ text: "Pause" })).toBeNull();
  });
  it("carousel controls are left to the carousel step (not taken as 'load more')", () => {
    expect(classifyRevealControl({ ...ctl, text: "›" }).kind).toBeNull();
    expect(classifyRevealControl({ ...ctl, text: "›", inCarousel: false }).kind).toBe("LOAD_MORE");
  });
});

describe("JavaScript search: which field may be typed into", () => {
  const field = (f: Partial<FieldFacts> = {}): FieldFacts => ({ tag: "INPUT", inputType: "text", name: null, id: null, placeholder: null, ariaLabel: null, autocomplete: null, label: null, ...f });
  const sf = (f: Partial<SearchFieldFacts> = {}): SearchFieldFacts => ({ ...field(), role: null, inSearchLandmark: false, form: null, ...f });
  const form = (otherFields: FieldFacts[] = [], o: Partial<NonNullable<SearchFieldFacts["form"]>> = {}) => ({ method: null, action: null, actionSameOrigin: true, otherFields, ...o });
  const ok = (f: Partial<SearchFieldFacts>) => classifySearchField(sf(f)).ok;
  it("accepts recognisable search boxes", () => {
    expect(ok({ inputType: "search" })).toBe(true);
    expect(ok({ role: "searchbox" })).toBe(true);
    expect(ok({ inSearchLandmark: true })).toBe(true);
    for (const name of ["q", "s", "query", "search", "keyword", "keywords", "search_term"]) expect(ok({ name }), name).toBe(true);
    expect(ok({ placeholder: "Search projects…" })).toBe(true);
    expect(ok({ ariaLabel: "Search the site" })).toBe(true);
    expect(ok({ id: "site-search" })).toBe(true);
    expect(ok({ inputType: null, name: "q", form: form([field({ inputType: "submit" }), field({ inputType: "hidden", name: "post_type" })], { method: "get", action: "/search" }) })).toBe(true);
    expect(ok({ form: form([], { action: "/results" }) })).toBe(true); // a search action
  });
  it("rejects email, password, name, phone, message, address and card fields — whatever else they look like", () => {
    for (const f of [
      { inputType: "email" }, { inputType: "password" }, { inputType: "tel" }, { inputType: "number" }, { inputType: "url" }, { inputType: "checkbox" }, { inputType: "hidden", name: "q" },
      { name: "email" }, { name: "user_email", inSearchLandmark: true }, { name: "password" }, { name: "name" }, { name: "full_name" }, { name: "first-name" }, { name: "lastname" },
      { name: "phone" }, { name: "mobile" }, { name: "message" }, { placeholder: "Your message" }, { name: "address" }, { name: "city" }, { name: "zip" },
      { name: "card-number" }, { name: "cc-number" }, { name: "cvv" }, { name: "company" }, { name: "subject" }, { label: "Your name" }, { placeholder: "Email address" },
      { name: "q", autocomplete: "email" }, { name: "search", autocomplete: "name" }, { inputType: "search", name: "username" }, { name: "comments" },
    ] as Array<Partial<SearchFieldFacts>>) expect(ok(f), JSON.stringify(f)).toBe(false);
    expect(classifySearchField({ ...sf({ name: "q" }), tag: "TEXTAREA" }).ok).toBe(false);
    expect(ok({ name: "foo" })).toBe(false); // not recognisable as a search box
  });
  it("rejects search-like fields in forms that also hold personal-data fields, a text area, other text boxes, POST or another origin", () => {
    expect(ok({ name: "query", form: form([field({ inputType: "email", name: "email" })]) })).toBe(false);
    expect(ok({ name: "query", placeholder: "Your query", form: form([field({ name: "name" }), field({ tag: "TEXTAREA", inputType: null, name: "message" })]) })).toBe(false);
    expect(ok({ inputType: "search", form: form([field({ tag: "TEXTAREA", inputType: null, name: "notes" })]) })).toBe(false);
    expect(ok({ inputType: "search", form: form([field({ name: "other" })]) })).toBe(false); // a second free-text box
    expect(ok({ inputType: "search", form: form([field({ inputType: "hidden", name: "email" })]) })).toBe(false);
    expect(ok({ inputType: "search", form: form([field({ inputType: "password", name: "pw" })]) })).toBe(false);
    expect(ok({ inputType: "search", form: form([], { method: "post" }) })).toBe(false);
    expect(ok({ inputType: "search", form: form([], { method: "POST", action: "/search" }) })).toBe(false);
    expect(ok({ inputType: "search", form: form([], { action: "https://search.other.example/s", actionSameOrigin: false }) })).toBe(false);
    expect(ok({ inputType: "search", form: form([field({ tag: "SELECT", inputType: null, name: "category" }), field({ inputType: "checkbox", name: "in_title" })]) })).toBe(true); // filters are fine
  });
  const btn = (f: Partial<SearchButtonFacts>) => classifySearchButton({ tag: "BUTTON", role: null, text: null, ariaLabel: null, title: null, id: null, className: null, href: null, inputType: "submit", ...f }).ok;
  it("search buttons: labelled search / find / go; never submit / send / a link to a page", () => {
    expect(btn({ text: "Search" })).toBe(true);
    expect(btn({ ariaLabel: "Search", text: "" })).toBe(true);
    expect(btn({ text: "Go" })).toBe(true);
    expect(btn({ tag: "INPUT", inputType: "submit", text: "Find" })).toBe(true);
    expect(btn({ text: "🔍" })).toBe(true);
    expect(btn({ className: "search-submit" })).toBe(false); // the deny-list ("submit") wins
    for (const text of ["Submit", "Send", "Subscribe", "Apply", "OK"]) expect(btn({ text }), text).toBe(false);
    expect(btn({ tag: "A", inputType: null, href: "/search-page", text: "Search" })).toBe(false);
    expect(btn({ tag: "INPUT", inputType: "reset", text: "Search" })).toBe(false);
  });
});

describe("request guard: the search's one results-page navigation", () => {
  const nav = { origin: "https://site.example", term: SEARCH_PROBE_TERM };
  const d = (r: Partial<Parameters<typeof revealRequestDecision>[0]>, allow: typeof nav | null = nav) =>
    revealRequestDecision({ method: "GET", url: "https://site.example/search?q=test", mainFrameNavigation: true, firstParty: true, inBaseline: false, ...r }, urlIsUnsafe, allow);
  it("allows a same-origin GET results page whose query carries the term, only while the search waits", () => {
    expect(d({})).toBe("ALLOW");
    expect(d({ url: "https://site.example/results?keyword=test&page=1" })).toBe("ALLOW");
    expect(d({}, null)).toBe("NAVIGATION");
  });
  it("refuses any other navigation, also during the search", () => {
    expect(d({ url: "https://site.example/search" })).toBe("NAVIGATION"); // no term in the query
    expect(d({ url: "https://site.example/test" })).toBe("NAVIGATION"); // the term in the path only
    expect(d({ url: "https://other.example/search?q=test", firstParty: false })).toBe("NAVIGATION");
    expect(d({ url: "http://site.example/search?q=test" })).toBe("NAVIGATION"); // another origin (scheme)
    expect(d({ method: "POST" })).toBe("NAVIGATION");
    expect(d({ url: "https://site.example/logout?q=test" })).toBe("UNSAFE");
    expect(isSearchNavigation({ method: "GET", url: "not a url" }, nav)).toBe(false);
  });
  it("sub-requests of the search stay under the normal rules", () => {
    expect(d({ mainFrameNavigation: false, url: "https://site.example/api/search?q=test" })).toBe("ALLOW");
    expect(d({ mainFrameNavigation: false, method: "POST", url: "https://site.example/api/search" })).toBe("METHOD");
    expect(d({ mainFrameNavigation: false, url: "https://algolia.example/1/indexes?q=test", firstParty: false })).toBe("THIRD_PARTY");
  });
  it("the term is the scanner's harmless search probe term", () => expect(SEARCH_PROBE_TERM).toBe("test"));
});
