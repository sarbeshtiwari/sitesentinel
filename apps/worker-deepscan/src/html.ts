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
  textHash: string;
  structureHash: string;
  textLength: number;
}
export interface HtmlLinks { links: Array<{ href: string }>; resources: Array<{ href: string; type: "image" | "stylesheet" | "script" | "font" | "other" }>; malformedLinks: number }

export function analyzeHtml(html: string, maxLinks = 2000, maxResources = 500): { facts: HtmlFacts; out: HtmlLinks } {
  const f: HtmlFacts = {
    title: null, titleCount: 0, description: null, canonical: null, robots: null, lang: null, viewport: false, openGraph: false,
    h1: 0, headingSkips: 0, hasMain: false, imgMissingAlt: 0, emptyLinks: 0, emptyButtons: 0, unlabelledControls: 0, duplicateIds: 0,
    jsonLd: { blocks: 0, invalid: 0 }, textHash: "", structureHash: "", textLength: 0,
  };
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

  const parser = new Parser({
    onopentag(tag, a) {
      if (a.id) ids.set(a.id, (ids.get(a.id) ?? 0) + 1);
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
            else if (out.links.length < maxLinks) out.links.push({ href: a.href });
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
      if (inScript || inStyle) return;
      const s = t.trim();
      if (s) {
        f.textLength += s.length;
        textHash.update(s.replace(/\s+/g, " "));
        for (const e of stack) e.name = true;
      }
    },
    onclosetag(tag) {
      if (tag === "title") { inTitle = false; f.title = title.replace(/\s+/g, " ").trim(); }
      if (tag === "script") {
        if (inScript === "json") { try { JSON.parse(scriptBuf); } catch { f.jsonLd.invalid++; } }
        inScript = null;
      }
      if (tag === "style") inStyle = false;
      if (tag === "label") labelDepth = Math.max(0, labelDepth - 1);
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
