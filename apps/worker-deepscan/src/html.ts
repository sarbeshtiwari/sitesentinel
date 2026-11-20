import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";

/**
 * Static HTML analysis (no script execution): metadata, links, resources and automated structural /
 * accessibility checks. Bounded: at most `maxLinks` links and `maxResources` resources are returned.
 */
export interface HtmlFacts {
  title: string | null;
  titleCount: number;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  viewport: boolean;
  openGraph: boolean;
  h1: number;
  headingSkips: number;
  hasMain: boolean;
  imgMissingAlt: number;
  emptyLinks: number;
  emptyButtons: number;
  unlabelledControls: number;
  duplicateIds: number;
  jsonLd: { blocks: number; invalid: number };
  /** Forms on the page (static view, max 20): never submitted except GET search forms (see engine search probe). */
  forms: HtmlForm[];
  textHash: string;
  structureHash: string;
  textLength: number;
  /** signals that the page is built in the browser (see discovery.looksClientRendered) */
  clientShell: { framework: string | null; emptyContainers: number };
}
export interface HtmlForm {
  method: string;
  action: string | null;
  /** role="search", a type="search" field or a conventional query field name */
  search: boolean;
  /** name of the field that carries the search query (null: the query isn't submitted without JavaScript) */
  queryField: string | null;
  submit: boolean;
  password: boolean;
}
const QUERY_NAMES = new Set(["q", "query", "s", "search", "keyword", "keywords", "term", "k", "search_query"]);
/** an app root, or a container that usually holds a list of entries (post-list, card-grid, news-feed…) */
const APP_ROOT_IDS: Record<string, string> = { __next: "next", __nuxt: "nuxt", ___gatsby: "gatsby", root: "app-root", app: "app-root" };
const LIST_CONTAINER = /(^|[\s_-])(list|grid|posts?|cards|items|results|articles?|blogs?|feed|listing|entries)([\s_-]|$)/i;
const CONTAINER_TAGS = new Set(["div", "ul", "ol", "section", "main"]);
const CHROME_TAGS = new Set(["nav", "header", "footer"]);
/** Links carry `chrome: true` inside nav / header / footer (site navigation, not the page's own content). */
export interface HtmlLinks { links: Array<{ href: string; chrome?: boolean }>; resources: Array<{ href: string; type: "image" | "stylesheet" | "script" | "font" | "other" }>; malformedLinks: number }

export function analyzeHtml(html: string, maxLinks = 2000, maxResources = 500): { facts: HtmlFacts; out: HtmlLinks } {
  const f: HtmlFacts = {
    title: null, titleCount: 0, description: null, canonical: null, robots: null, lang: null, viewport: false, openGraph: false,
    h1: 0, headingSkips: 0, hasMain: false, imgMissingAlt: 0, emptyLinks: 0, emptyButtons: 0, unlabelledControls: 0, duplicateIds: 0,
    jsonLd: { blocks: 0, invalid: 0 }, forms: [], textHash: "", structureHash: "", textLength: 0,
    clientShell: { framework: null, emptyContainers: 0 },
  };
  // element depth (htmlparser2 also closes void and implied elements) for empty-container and nav/header/footer tracking
  let depth = 0;
  const containers: Array<{ depth: number; empty: boolean }> = [];
  const chrome: number[] = [];
  const framework = (name: string) => { if (!f.clientShell.framework || f.clientShell.framework === "app-root") f.clientShell.framework = name; };
  const out: HtmlLinks = { links: [], resources: [], malformedLinks: 0 };
  const ids = new Map<string, number>();
  const labelsFor = new Set<string>();
  const controls: Array<{ id: string | null; labelled: boolean; inLabel: boolean }> = [];
  const textHash = createHash("sha256");
  const structure: string[] = [];
  let lastHeading = 0;
  let inTitle = false, inScript: "json" | "other" | null = null, inStyle = false, labelDepth = 0;
  let scriptBuf = "";
  let title = "";
  // accessible-name tracking for <a> and <button>
  const stack: Array<{ tag: string; name: boolean }> = [];
  const formStack: Array<HtmlForm | null> = []; // null: form beyond the cap (still tracked for nesting)

  const parser = new Parser({
    onopentag(tag, a) {
      if (a.id) ids.set(a.id, (ids.get(a.id) ?? 0) + 1);
      for (const c of containers) c.empty = false;
      depth++;
      const root = a.id ? APP_ROOT_IDS[a.id] : undefined;
      if (root && (root !== "app-root" || tag === "div")) framework(root);
      if ("ng-version" in a || "ng-app" in a || tag === "app-root") framework("angular");
      if ("data-v-app" in a || "data-server-rendered" in a) framework("vue");
      if (tag === "script" && a.id === "__NEXT_DATA__") framework("next");
      if (tag === "script" && a.src) { if (/\/_next\//.test(a.src)) framework("next"); else if (/\/_nuxt\//.test(a.src)) framework("nuxt"); }
      if (CONTAINER_TAGS.has(tag) && containers.length < 200 && (root || LIST_CONTAINER.test(a.class ?? "") || LIST_CONTAINER.test(a.id ?? ""))) containers.push({ depth, empty: true });
      if (CHROME_TAGS.has(tag) || a.role === "navigation") chrome.push(depth);
      const named = Boolean(a["aria-label"]?.trim() || a["aria-labelledby"]?.trim() || a.title?.trim());
      switch (tag) {
        case "html": f.lang = a.lang?.trim() || null; break;
        case "title": inTitle = true; f.titleCount++; break;
        case "meta": {
          const name = (a.name ?? a.property ?? "").toLowerCase();
          if (name === "description") f.description = a.content ?? "";
          else if (name === "robots") f.robots = (a.content ?? "").toLowerCase();
          else if (name === "viewport") f.viewport = true;
          else if (name.startsWith("og:")) f.openGraph = true;
          break;
        }
        case "link": {
          const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("canonical")) f.canonical = a.href ?? "";
          else if (rel.includes("stylesheet") && a.href) out.resources.length < maxResources && out.resources.push({ href: a.href, type: "stylesheet" });
          else if ((rel.includes("preload") && a.as === "font") && a.href) out.resources.length < maxResources && out.resources.push({ href: a.href, type: "font" });
          break;
        }
        case "script":
          if ((a.type ?? "").toLowerCase() === "application/ld+json") { inScript = "json"; scriptBuf = ""; f.jsonLd.blocks++; }
          else { inScript = "other"; if (a.src) out.resources.length < maxResources && out.resources.push({ href: a.src, type: "script" }); }
          break;
        case "style": inStyle = true; break;
        case "img":
          if (a.alt === undefined) f.imgMissingAlt++;
          if (a.src) out.resources.length < maxResources && out.resources.push({ href: a.src, type: "image" });
          break;
        case "a":
          if (a.href !== undefined) {
            if (!a.href.trim() || /^javascript:/i.test(a.href.trim())) out.malformedLinks++;
            else if (out.links.length < maxLinks) out.links.push(chrome.length ? { href: a.href, chrome: true } : { href: a.href });
          }
          stack.push({ tag: "a", name: named });
          break;
        case "button": stack.push({ tag: "button", name: named }); break;
        case "label": labelDepth++; if (a.for) labelsFor.add(a.for); for (const s of stack) s.name = true; break;
        case "input": case "select": case "textarea": {
          const type = (a.type ?? "").toLowerCase();
          if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) break;
          controls.push({ id: a.id ?? null, labelled: named, inLabel: labelDepth > 0 }); // a placeholder is not a label
          break;
        }
        case "main": f.hasMain = true; break;
        default:
          if (a.role === "main") f.hasMain = true;
      }
      if (tag === "form") {
        const fm: HtmlForm | null = f.forms.length < 20
          ? { method: (a.method ?? "get").trim().toUpperCase() || "GET", action: a.action ?? null, search: a.role === "search", queryField: null, submit: false, password: false }
          : null;
        if (fm) f.forms.push(fm);
        formStack.push(fm);
      }
      const form = formStack.length ? formStack[formStack.length - 1] : null;
      if (form) {
        const type = (a.type ?? "").toLowerCase();
        if (tag === "input") {
          if (type === "password") form.password = true;
          if (type === "submit" || type === "image") form.submit = true;
          const name = a.name?.trim() ?? "";
          if (type === "search" || ((type === "" || type === "text") && QUERY_NAMES.has(name.toLowerCase()))) {
            form.search = true;
            if (name && !form.queryField) form.queryField = name;
          }
        }
        if (tag === "button" && (type === "" || type === "submit")) form.submit = true; // <button> submits by default
      }
      if (tag === "img" && (a.alt?.trim() || named)) for (const s of stack) s.name = true; // an image with alt names its link/button
      const h = /^h([1-6])$/.exec(tag);
      if (h) {
        const lvl = Number(h[1]);
        if (lvl === 1) f.h1++;
        if (lastHeading && lvl > lastHeading + 1) f.headingSkips++;
        lastHeading = lvl;
        structure.push(tag);
      } else if (["main", "nav", "header", "footer", "section", "article", "form", "table", "ul", "ol"].includes(tag)) structure.push(tag);
    },
    ontext(t) {
      if (inTitle) { title += t; return; } // the title is compared separately; content hash = body text only
      if (inScript === "json") { scriptBuf += t; return; }
      if (inScript) { if (t.includes("self.__next_f")) framework("next"); else if (t.includes("__NUXT__")) framework("nuxt"); return; }
      if (inStyle) return;
      const s = t.trim();
      if (s) {
        for (const c of containers) c.empty = false;
        f.textLength += s.length;
        textHash.update(s.replace(/\s+/g, " "));
        for (const e of stack) e.name = true;
      }
    },
    onclosetag(tag) {
      const top = containers[containers.length - 1];
      if (top && top.depth === depth) { containers.pop(); if (top.empty) f.clientShell.emptyContainers++; }
      if (chrome[chrome.length - 1] === depth) chrome.pop();
      depth = Math.max(0, depth - 1);
      if (tag === "title") { inTitle = false; f.title = title.replace(/\s+/g, " ").trim(); }
      if (tag === "script") {
        if (inScript === "json") { try { JSON.parse(scriptBuf); } catch { f.jsonLd.invalid++; } }
        inScript = null;
      }
      if (tag === "style") inStyle = false;
      if (tag === "label") labelDepth = Math.max(0, labelDepth - 1);
      if (tag === "form") formStack.pop();
      if (tag === "a" || tag === "button") {
        const idx = stack.map((s) => s.tag).lastIndexOf(tag);
        if (idx >= 0) {
          const [e] = stack.splice(idx, 1);
          if (!e!.name) { if (tag === "a") f.emptyLinks++; else f.emptyButtons++; }
        }
      }
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  f.unlabelledControls = controls.filter((c) => !c.labelled && !c.inLabel && !(c.id && labelsFor.has(c.id))).length;
  f.duplicateIds = [...ids.values()].filter((n) => n > 1).length;
  f.textHash = textHash.digest("hex").slice(0, 32);
  f.structureHash = createHash("sha256").update(structure.join(",")).digest("hex").slice(0, 16);
  return { facts: f, out };
}

/** Sitemap XML (urlset / sitemapindex), parsed without entity expansion beyond the standard five. */
export function parseSitemap(xml: string, maxEntries: number, cutAtLimit = false): { kind: "urlset" | "index" | "invalid"; locs: string[]; badLastmod: number; truncated: boolean } {
  let kind: "urlset" | "index" | "invalid" = "invalid";
  const locs: string[] = [];
  let inLoc = false, inLastmod = false, buf = "", badLastmod = 0, truncated = false, depthErr = false;
  if (/<!ENTITY/i.test(xml.slice(0, 4096))) return { kind: "invalid", locs: [], badLastmod: 0, truncated: false }; // no DTD entities (billion laughs)
  const p = new Parser({
    onopentag(tag) {
      const t = tag.replace(/^.*:/, "");
      if (t === "urlset") kind = "urlset";
      else if (t === "sitemapindex") kind = "index";
      else if (t === "loc") { inLoc = true; buf = ""; }
      else if (t === "lastmod") { inLastmod = true; buf = ""; }
    },
    ontext(t) { if (inLoc || inLastmod) buf += t; },
    onclosetag(tag, isImplied) {
      const t = tag.replace(/^.*:/, "");
      if (t === "loc" && inLoc) {
        inLoc = false;
        if (isImplied) return; // a <loc> cut off at the size limit is incomplete: never used
        if (locs.length < maxEntries) locs.push(buf.trim()); else truncated = true;
      }
      if (t === "lastmod" && inLastmod) {
        inLastmod = false;
        const v = buf.trim();
        if (!/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.test(v) || Number.isNaN(Date.parse(v))) badLastmod++;
      }
    },
    onerror() { depthErr = true; },
  }, { xmlMode: true, decodeEntities: true });
  p.write(xml);
  p.end();
  if (cutAtLimit && kind !== "invalid") return { kind, locs, badLastmod, truncated: true };
  if (depthErr || (kind !== "invalid" && !/<\/(\w+:)?(urlset|sitemapindex)>\s*$/.test(xml.trim()) && !truncated)) return { kind: "invalid", locs, badLastmod, truncated };
  return { kind, locs, badLastmod, truncated };
}
