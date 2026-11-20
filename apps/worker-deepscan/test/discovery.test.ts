import { describe, expect, it } from "vitest";
import { urlIsUnsafe } from "@wim/core";
import { classifyRevealControl, isListingCandidate, looksClientRendered, revealRequestDecision, selectBrowserPages, type RevealControlFacts } from "../src/discovery.js";
import { analyzeHtml } from "../src/html.js";

const U = (p: string) => new URL(p, "https://site.example");
const paths = (us: URL[]) => us.map((u) => `${u.pathname}${u.search}`);

describe("pages rendered before the crawl", () => {
  it("start pages first, then top-level listing pages from the sitemap, then from the rendered start pages", () => {
    const out = selectBrowserPages([U("/")], [U("/about"), U("/blogs"), U("/blogs/post-1"), U("/projects")], [U("/news"), U("/contact"), U("/press-release")], 10);
    expect(paths(out)).toEqual(["/", "/blogs", "/projects", "/news", "/press-release"]);
  });
  it("is capped at the budget, start pages included", () => {
    expect(paths(selectBrowserPages([U("/"), U("/spa")], [U("/blog"), U("/news")], [], 3))).toEqual(["/", "/spa", "/blog"]);
    expect(selectBrowserPages([U("/")], [U("/blog")], [], 0)).toEqual([]);
    expect(paths(selectBrowserPages([U("/"), U("/a"), U("/b")], [U("/blog")], [], 2))).toEqual(["/", "/a"]);
  });
  it("dedupes (a trailing slash is the same page) and keeps the first occurrence", () => {
    expect(paths(selectBrowserPages([U("/")], [U("/blog/"), U("/blog")], [U("/blog"), U("/")], 5))).toEqual(["/", "/blog/"]);
  });
  it("listing candidates: one path segment, listing-like name, no query, not a file", () => {
    for (const p of ["/blogs", "/news/", "/insights", "/articles", "/events", "/press-release", "/our-projects", "/products", "/case-studies", "/resources", "/gallery", "/careers", "/stories", "/updates", "/posts"]) expect(isListingCandidate(U(p)), p).toBe(true);
    for (const p of ["/", "/about", "/contact", "/blogs/post-1", "/blog?page=2", "/news.pdf", "/gallery.jpg", "/a/b/c"]) expect(isListingCandidate(U(p)), p).toBe(false);
  });
});

describe("client-rendered pages found by the crawl", () => {
  const signals = (html: string, contentLinks?: number) => {
    const { facts, out } = analyzeHtml(html);
    return { framework: facts.clientShell.framework, emptyContainers: facts.clientShell.emptyContainers, contentLinks: contentLinks ?? out.links.filter((l) => !l.chrome).length };
  };
  it("detects framework shells", () => {
    expect(signals('<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script>').framework).toBe("next");
    expect(signals('<script>self.__next_f.push([1,"x"])</script>').framework).toBe("next");
    expect(signals('<script src="/_next/static/chunks/main.js"></script>').framework).toBe("next");
    expect(signals('<div id="__nuxt"></div>').framework).toBe("nuxt");
    expect(signals("<script>window.__NUXT__={}</script>").framework).toBe("nuxt");
    expect(signals('<app-root ng-version="17.0.0"></app-root>').framework).toBe("angular");
    expect(signals('<div id="app" data-v-app></div>').framework).toBe("vue");
    expect(signals('<div id="root"></div>').framework).toBe("app-root");
    expect(signals("<main><p>Plain server-rendered page</p></main>").framework).toBeNull();
  });
  it("counts empty list / grid containers (and an empty app root), not filled ones", () => {
    expect(signals('<div id="root"></div>').emptyContainers).toBe(1);
    expect(signals('<ul class="post-list"></ul><div class="card-grid">  </div>').emptyContainers).toBe(2);
    expect(signals('<ul class="post-list"><li><a href="/a">A</a></li></ul><div class="grid"><br></div><div class="results">text</div>').emptyContainers).toBe(0);
  });
  it("links inside nav / header / footer are site chrome, not content", () => {
    const { out } = analyzeHtml('<header><a href="/h">H</a></header><nav><a href="/n">N</a></nav><main><a href="/m">M</a></main><footer><a href="/f">F</a></footer><div role="navigation"><a href="/r">R</a></div>');
    expect(out.links.map((l) => `${l.href}${l.chrome ? "*" : ""}`)).toEqual(["/h*", "/n*", "/m", "/f*", "/r*"]);
  });
  it("renders a framework shell with few content links or empty containers; never a plain page", () => {
    expect(looksClientRendered(signals('<div id="__next"><header><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a></header><main><h1>Archive</h1></main></div>'))).toBe(true);
    expect(looksClientRendered({ framework: "next", contentLinks: 20, emptyContainers: 1 })).toBe(true);
    expect(looksClientRendered({ framework: "next", contentLinks: 20, emptyContainers: 0 })).toBe(false); // server-rendered Next.js page
    expect(looksClientRendered({ framework: null, contentLinks: 0, emptyContainers: 3 })).toBe(false);
    expect(looksClientRendered(signals('<main><h1>Guides</h1><a href="/guides/archive">Archive</a></main>'))).toBe(false);
  });
});

describe("controls clicked to reveal links", () => {
  const base: RevealControlFacts = { tag: "BUTTON", role: null, text: null, ariaLabel: null, title: null, id: null, className: null, href: null, inputType: "button", inForm: false, inChrome: false, ariaExpanded: null, ariaSelected: null, ariaControls: false };
  const kind = (f: Partial<RevealControlFacts>) => classifyRevealControl({ ...base, ...f }).kind;
  it("load-more style labels", () => {
    for (const text of ["Load more", "Show more", "View more", "See more", "View all", "Load more posts", "More articles", "More projects", "Next", "Older posts", "›", "»", "→", "Next »", "Voir plus", "Cargar más", "Mehr laden"]) expect(kind({ text }), text).toBe("LOAD_MORE");
    expect(kind({ text: null, ariaLabel: "Load more results" })).toBe("LOAD_MORE");
    expect(kind({ tag: "A", href: "#", inputType: null, text: "Load more" })).toBe("LOAD_MORE");
    expect(kind({ tag: "A", href: "javascript:void(0)", inputType: null, text: "Show more" })).toBe("LOAD_MORE");
    expect(kind({ tag: "A", href: null, inputType: null, text: "Next" })).toBe("LOAD_MORE");
    expect(kind({ tag: "DIV", role: "button", inputType: null, text: "Load more" })).toBe("LOAD_MORE");
  });
  it("tabs, collapsed sections and aria-controls buttons", () => {
    expect(kind({ tag: "BUTTON", role: "tab", ariaSelected: "false", text: "Projects" })).toBe("TOGGLE");
    expect(kind({ tag: "LI", role: "tab", inputType: null, text: "Residential" })).toBe("TOGGLE");
    expect(kind({ role: "tab", ariaSelected: "true", text: "Overview" })).toBeNull();
    expect(kind({ ariaExpanded: "false", text: "Floor plans" })).toBe("TOGGLE");
    expect(kind({ ariaControls: true, text: "Amenities" })).toBe("TOGGLE");
    expect(kind({ ariaControls: true, ariaExpanded: "true", text: "Amenities" })).toBeNull();
    expect(kind({ ariaExpanded: "false", text: "Menu", inChrome: true })).toBeNull(); // site navigation menus are not page content
    expect(kind({ text: "Click me" })).toBeNull(); // purpose unknown
  });
  it("never: forms, submit buttons, links to pages, non-buttons, deny-listed labels", () => {
    expect(kind({ text: "Load more", inForm: true })).toBeNull();
    expect(kind({ text: "Load more", inputType: "submit" })).toBeNull();
    expect(kind({ tag: "INPUT", inputType: "submit", text: "Show more" })).toBeNull();
    expect(kind({ tag: "INPUT", inputType: "text", text: "Show more" })).toBeNull();
    expect(kind({ tag: "A", inputType: null, href: "/blog?page=2", text: "Next" })).toBeNull(); // a real link: collected, not clicked
    expect(kind({ tag: "A", inputType: null, href: "javascript:doDelete()", text: "Show more" })).toBeNull();
    expect(kind({ tag: "DIV", inputType: null, text: "Load more" })).toBeNull();
    for (const text of ["Subscribe", "Sign up", "Register", "Log in", "Login", "Logout", "Buy now", "Pay", "Checkout", "Add to cart", "Delete", "Remove", "Apply now", "Book a visit", "Enquire now", "Enquiry", "Contact us", "Submit", "Send", "Download brochure"]) expect(kind({ text }), text).toBeNull();
    expect(kind({ text: "Load more", className: "subscribe-btn" })).toBeNull(); // the deny-list wins over the label
    expect(kind({ role: "tab", text: "Download" })).toBeNull();
    expect(kind({ text: "Show more", id: "newsletter-signup" })).toBeNull();
  });
});

describe("request guard while interacting", () => {
  const d = (r: Partial<Parameters<typeof revealRequestDecision>[0]>) => revealRequestDecision({ method: "GET", url: "https://site.example/x", mainFrameNavigation: false, firstParty: true, inBaseline: false, ...r }, urlIsUnsafe);
  it("allows first-party reads (incl. read-only /api/ JSON) and third-party requests the page load already made", () => {
    expect(d({})).toBe("ALLOW");
    expect(d({ url: "https://site.example/api/blogs?page=2" })).toBe("ALLOW");
    expect(d({ method: "HEAD" })).toBe("ALLOW");
    expect(d({ url: "https://cdn.example/lib.js", firstParty: false, inBaseline: true })).toBe("ALLOW");
  });
  it("refuses non-GET, navigation of the page, deny-listed URLs and new third-party calls", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(d({ method }), method).toBe("METHOD");
    expect(d({ mainFrameNavigation: true })).toBe("NAVIGATION");
    expect(d({ mainFrameNavigation: true, url: "https://site.example/" })).toBe("NAVIGATION");
    for (const url of ["https://site.example/logout", "https://site.example/api/logout", "https://site.example/cart/add?id=1", "https://site.example/x?token=abc", "https://site.example/subscribe"]) expect(d({ url }), url).toBe("UNSAFE");
    expect(d({ url: "https://tracker.example/collect", firstParty: false })).toBe("THIRD_PARTY");
  });
});
