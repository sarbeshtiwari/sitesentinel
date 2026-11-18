/**
 * Code evaluated INSIDE the monitored page. Kept dependency-free and defensive: the page is
 * untrusted and can tamper with anything it can reach, which only ever affects its own result.
 */

/** Installed before any page script runs: synthetic paint/LCP/CLS/long-task observers and rejection capture. */
export const INIT_SCRIPT = `(() => {
  const store = { fcp: null, lcp: null, cls: 0, clsSession: 0, clsLast: 0, clsFirst: 0, longTasks: [], rejections: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") store.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => { const es = l.getEntries(); if (es.length) store.lcp = es[es.length - 1].startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    // CLS per the web-vitals definition: largest session window (gap < 1 s, window < 5 s), ignoring shifts after input.
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        if (store.clsSession && e.startTime - store.clsLast < 1000 && e.startTime - store.clsFirst < 5000) store.clsSession += e.value;
        else { store.clsSession = e.value; store.clsFirst = e.startTime; }
        store.clsLast = e.startTime;
        store.cls = Math.max(store.cls, store.clsSession);
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (store.longTasks.length < 500) store.longTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  } catch (_) {}
  addEventListener("unhandledrejection", (ev) => {
    if (store.rejections.length >= 50) return;
    const r = ev.reason;
    store.rejections.push(String(r && r.message ? r.message : r).slice(0, 500));
  });
  Object.defineProperty(window, "__wimSynthetic", { value: store, writable: false, enumerable: false, configurable: false });
})();`;

/** Collected after readiness: navigation timing, synthetic vitals, rendering and layout facts. */
export function collectInPage(): unknown {
  const w = window as unknown as { __wimSynthetic?: { fcp: number | null; lcp: number | null; cls: number; longTasks: Array<[number, number]>; rejections: string[] } };
  const s = w.__wimSynthetic;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const fcp = s?.fcp ?? null;
  // TBT (synthetic): blocking part (> 50 ms) of long tasks after FCP, until the end of observation.
  const tbt = s && fcp !== null ? s.longTasks.filter(([st]) => st >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0) : null;
  const vw = innerWidth, vh = innerHeight;
  let text = 0, meaningful = 0, covered = 0, offscreenText = 0;
  const broken: string[] = [];
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const clipped = (el: Element) => { // inside a container that deliberately clips or scrolls horizontally
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") return true;
    }
    return false;
  };
  const all = document.body ? Array.from(document.body.querySelectorAll("*")).slice(0, 4000) : [];
  for (const el of all) {
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
    if (tag === "IMG") {
      const img = el as HTMLImageElement;
      const r = visible(img);
      if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src) && getComputedStyle(img).display !== "none") {
        try { const u = new URL(img.currentSrc || img.src); broken.push(u.protocol === "data:" ? "data:" : u.host + u.pathname); } catch { broken.push("[invalid]"); }
      } else if (r && img.naturalWidth > 0) { meaningful++; covered += area(r); }
      continue;
    }
    if (tag === "SVG" || tag === "CANVAS" || tag === "VIDEO" || tag === "INPUT" || tag === "BUTTON" || tag === "IFRAME") {
      const r = visible(el);
      if (r) { meaningful++; covered += area(r); }
      continue;
    }
    // own text only (direct text nodes)
    let own = "";
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent ?? "";
    own = own.trim();
    if (own) {
      const r = visible(el);
      if (r) {
        text += own.length;
        covered += area(r);
        if (r.right > vw + 4 && r.left < vw && !clipped(el)) offscreenText++;
      }
    }
  }
  function area(r: DOMRect) {
    const x = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const y = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return x * y;
  }
  const doc = document.documentElement;
  return {
    timing: nav ? {
      ttfbMs: Math.round(nav.responseStart - nav.startTime), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      loadMs: nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd - nav.startTime) : null,
      // through the egress proxy these are the browser→proxy leg (the gateway resolves the target): reported, labelled, not as target DNS
      proxyConnectMs: Math.round(nav.connectEnd - nav.connectStart), tlsMs: nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : null,
      transferBytes: nav.transferSize, protocol: nav.nextHopProtocol,
    } : null,
    fcpMs: fcp !== null ? Math.round(fcp) : null,
    lcpMs: s?.lcp != null ? Math.round(s.lcp) : null,
    cls: s ? Math.round(s.cls * 10000) / 10000 : null,
    tbtMs: tbt !== null ? Math.round(tbt) : null,
    longTasks: s ? s.longTasks.length : null,
    rejections: s ? s.rejections.slice(0, 50) : [],
    rendering: { textLength: text, meaningfulElements: meaningful, contentCoverage: Math.min(1, covered / Math.max(1, vw * vh)), brokenImages: broken.slice(0, 20), fontsFailed: Array.from(document.fonts ?? []).filter((f) => f.status === "error").length },
    layout: { overflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth), offscreenText, firstViewportVisible: covered > 0 },
  };
}

/**
 * Phase 4F: read-only component detection. Returns candidates with a STRUCTURAL key (landmark path + identifying
 * attributes — never positions or free text, so content edits and reordering don't create "new" components) and the
 * identity-relevant detail used for change detection. Bounded; the result is validated by the worker
 * (`sanitizeDetected`): the page can lie about itself, which only affects its own result.
 */
export function detectComponents(maxItems: number): unknown {
  const out: Array<Record<string, unknown>> = [];
  const vw = innerWidth, vh = innerHeight;
  const norm = (s: string | null | undefined, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const lc = (s: string) => s.toLowerCase();
  const isVisible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const randomish = (id: string) => /\d{3,}|[a-f0-9]{8,}|^(ember|react|radix|headlessui|mui|:r|__|ng-|id-)/i.test(id) || id.length > 40;
  const stableId = (el: Element) => (el.id && !randomish(el.id) ? el.id : null);
  const path = (u: string | null) => { if (!u) return ""; try { const x = new URL(u, location.href); return x.host === location.host ? x.pathname : `//${x.host}${x.pathname}`; } catch { return ""; } };
  const landmark = (el: Element) => {
    const parts: string[] = [];
    for (let p = el.parentElement; p && p !== document.body && parts.length < 4; p = p.parentElement) {
      const role = p.getAttribute("role");
      const t = p.tagName.toLowerCase();
      if (["header", "nav", "main", "footer", "aside", "form", "dialog"].includes(t) || (role && ["banner", "navigation", "main", "contentinfo", "search", "dialog", "complementary"].includes(role))) {
        parts.unshift(`${role ?? t}${stableId(p) ? `#${stableId(p)}` : ""}`);
      }
    }
    return parts.join(">");
  };
  const name = (el: Element) => {
    const a = el.getAttribute("aria-label");
    if (a) return norm(a);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" "); if (norm(t)) return norm(t); }
    if (el instanceof HTMLInputElement && el.labels?.length) return norm(el.labels[0]!.textContent);
    return norm((el as HTMLElement).innerText ?? el.textContent) || norm(el.getAttribute("title")) || norm(el.getAttribute("alt")) || norm(el.getAttribute("placeholder")) || norm(el.getAttribute("name")) || norm(el.getAttribute("value"));
  };
  const selector = (el: Element) => {
    const sid = stableId(el);
    if (sid) return `#${CSS.escape(sid)}`;
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && segs.length < 6) {
      const id = stableId(cur);
      if (id) { segs.unshift(`#${CSS.escape(id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const t = cur.tagName.toLowerCase();
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
      segs.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(cur) + 1})` : t);
      cur = parent;
    }
    return segs.join(" > ");
  };
  const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const add = (type: string, el: Element, key: string, detail: Record<string, unknown>, label: string | null = name(el) || null) => {
    if (out.length >= maxItems) return;
    out.push({ type, key: key.slice(0, 400), selector: selector(el).slice(0, 400), label: label ? label.slice(0, 120) : null, visible: isVisible(el), detail, count: 1, rect: rect(el) });
  };
  const q = (s: string) => Array.from(document.querySelectorAll(s));
  const linkPaths = (root: Element, n = 30) => Array.from(root.querySelectorAll("a[href]")).map((a) => path(a.getAttribute("href"))).filter(Boolean).slice(0, n);

  // landmarks
  for (const el of q("header, [role=banner]").filter((e) => !e.closest("article, section header ~ *")).slice(0, 3)) add("HEADER", el, `header:${landmark(el)}:${stableId(el) ?? ""}`, {});
  for (const el of q("footer, [role=contentinfo]").filter((e) => !e.closest("article")).slice(0, 3)) add("FOOTER", el, `footer:${landmark(el)}:${stableId(el) ?? ""}`, {});
  const navs = q("nav, [role=navigation]").slice(0, 8);
  for (const el of navs) {
    const label = norm(el.getAttribute("aria-label")) || stableId(el) || "";
    const pag = /pag(e|ination)/i.test(label) || /pagination/i.test(el.className.toString());
    add(pag ? "PAGINATION" : "NAV", el, `${pag ? "pagination" : "nav"}:${landmark(el)}:${lc(label)}`, { links: linkPaths(el).sort() }, label || null);
  }
  // mobile menu toggles: controls a navigation, or a menu-labelled toggle
  for (const el of q("button[aria-controls], [aria-expanded][aria-controls], button[aria-label*=menu i], button[class*=menu i], button[class*=hamburger i], button[class*=toggle i]").slice(0, 6)) {
    const ctl = el.getAttribute("aria-controls");
    const target = ctl ? document.getElementById(ctl) : null;
    const controlsNav = target ? target.matches("nav, [role=navigation]") || Boolean(target.querySelector("nav, [role=navigation], a[href]")) : /menu|hamburger|nav/i.test(`${el.getAttribute("aria-label")} ${el.className}`);
    if (controlsNav) add("RESPONSIVE_NAV", el, `menu-toggle:${landmark(el)}:${ctl ?? lc(name(el))}`, { controls: ctl ?? null });
  }
  // inside a navigation, or inside a container some control toggles (aria-controls): hidden there on small screens = by design
  const controlled = new Set(q("[aria-controls]").map((c) => c.getAttribute("aria-controls")).filter(Boolean) as string[]);
  const inToggledMenu = (el: Element) => Boolean(el.closest("nav, [role=navigation]")) || (() => { for (let p = el.parentElement; p; p = p.parentElement) if (p.id && controlled.has(p.id)) return true; return false; })();
  // search
  const searchInputs = q("input[type=search], [role=search] input, form input[name=q], form input[name=query], form input[name=search], form input[name=s], form input[name=keyword], input[aria-label*=search i], input[placeholder*=search i]")
    .filter((i) => (i as HTMLInputElement).type !== "hidden").slice(0, 3);
  const searchForms = new Set<Element>();
  for (const el of searchInputs) {
    const f = (el as HTMLInputElement).form;
    if (f) searchForms.add(f);
    add("SEARCH", el, `search:${landmark(el)}:${path(f?.getAttribute("action") ?? location.pathname)}:${(el as HTMLInputElement).name || "input"}`,
      { method: lc(f?.getAttribute("method") ?? "get"), action: path(f?.getAttribute("action") ?? location.pathname), input: (el as HTMLInputElement).name || null, inForm: Boolean(f), inMenu: inToggledMenu(el) }, norm(el.getAttribute("aria-label")) || norm(el.getAttribute("placeholder")) || "Search");
  }
  // forms (other than search)
  for (const f of (q("form") as HTMLFormElement[]).filter((f) => !searchForms.has(f)).slice(0, 10)) {
    const fields = Array.from(f.elements).filter((e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement) as Array<HTMLInputElement>;
    const named = fields.filter((x) => x.type !== "hidden" && x.type !== "submit" && x.type !== "button");
    const sensitive = named.some((x) => x.type === "password" || x.type === "file" || /^cc-|card|cvv|cvc|iban/i.test(`${x.autocomplete} ${x.name}`));
    add("FORM", f, `form:${landmark(f)}:${lc(f.getAttribute("method") ?? "get")}:${path(f.getAttribute("action") ?? location.pathname)}:${stableId(f) ?? named.map((x) => x.name).filter(Boolean).sort().join(",")}`,
      { method: lc(f.getAttribute("method") ?? "get"), action: path(f.getAttribute("action") ?? location.pathname), fields: named.map((x) => `${x.name || x.id || x.type}:${x.type}${x.required ? "*" : ""}`).sort(), sensitive },
      norm(f.getAttribute("aria-label")) || stableId(f) || null);
  }
  // buttons and button-like calls to action
  for (const el of q("button, [role=button], input[type=button], input[type=submit], summary").filter(isVisible).slice(0, 60)) {
    const label = name(el);
    add("BUTTON", el, `button:${landmark(el)}:${stableId(el) ?? lc(label).slice(0, 40)}`, { label, type: lc(el.getAttribute("type") ?? (el.tagName === "BUTTON" ? "submit" : "")) });
  }
  for (const el of q("a[href][class*=btn i], a[href][class*=button i], a[href][class*=cta i], a[role=button]").filter(isVisible).slice(0, 20)) {
    add("LINK", el, `cta:${landmark(el)}:${path(el.getAttribute("href"))}`, { href: path(el.getAttribute("href")), label: name(el) });
  }
  // significant media
  for (const el of (q("img, video, picture") as HTMLElement[]).filter((m) => { const r = m.getBoundingClientRect(); return r.width * r.height >= 40_000; }).slice(0, 10)) {
    const src = el instanceof HTMLImageElement ? (el.currentSrc || el.src) : el.getAttribute("poster") ?? "";
    add("IMAGE", el, `media:${landmark(el)}:${path(src)}`, { alt: el.getAttribute("alt") ?? null, src: path(src) }, norm(el.getAttribute("alt")) || null);
  }
  // widgets
  for (const el of q("select, [aria-haspopup=listbox], [aria-haspopup=menu]").slice(0, 10)) add("DROPDOWN", el, `dropdown:${landmark(el)}:${stableId(el) ?? (el.getAttribute("name") ?? lc(name(el)).slice(0, 30))}`, {});
  for (const el of q("dialog, [role=dialog], [aria-modal=true]").slice(0, 5)) add("MODAL", el, `modal:${stableId(el) ?? lc(name(el)).slice(0, 30)}`, {});
  for (const el of q("[role=tablist]").slice(0, 5)) add("TABS", el, `tabs:${landmark(el)}:${stableId(el) ?? ""}`, { tabs: Array.from(el.querySelectorAll("[role=tab]")).map((t) => norm(t.textContent, 30)).slice(0, 12) });
  for (const el of q("details").slice(0, 10)) add("ACCORDION", el, `accordion:${landmark(el)}:${lc(norm(el.querySelector("summary")?.textContent, 40))}`, {});
  for (const el of q("[role=slider], [class*=carousel i], [class*=slider i]").slice(0, 5)) add("SLIDER", el, `slider:${landmark(el)}:${stableId(el) ?? ""}`, {});
  for (const el of q("table").filter((t) => t.querySelector("th")).slice(0, 5)) add("TABLE", el, `table:${landmark(el)}:${stableId(el) ?? Array.from(el.querySelectorAll("th")).map((h) => lc(norm(h.textContent, 20))).slice(0, 8).join("|")}`, {});
  // repeated content: >= 3 siblings with the same tag + class signature that each hold a heading or link
  const seenGroups = new Set<Element>();
  for (const parent of q("main *, body > div *").slice(0, 3000)) {
    if (seenGroups.has(parent) || parent.children.length < 3 || out.length >= maxItems) continue;
    const kids = Array.from(parent.children);
    const sig = (e: Element) => `${e.tagName}.${Array.from(e.classList).sort().join(".")}`;
    const counts = new Map<string, number>();
    for (const k of kids) counts.set(sig(k), (counts.get(sig(k)) ?? 0) + 1);
    const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (n >= 3 && best.includes(".") && kids.filter((k) => sig(k) === best && k.querySelector("h1,h2,h3,h4,a[href],img")).length >= 3) {
      seenGroups.add(parent);
      add("CARD_GROUP", parent, `cards:${landmark(parent)}:${stableId(parent) ?? best.toLowerCase()}`, { item: best.toLowerCase(), items: n }, null);
    }
  }
  void vw; void vh;
  return out;
}

/**
 * Phase 4F responsive inspection (read-only, after readiness): clipped content, overlapping and covered or off-screen
 * controls, oversized images, and the navigation's state at this viewport.
 */
export function inspectLayout(): unknown {
  const vw = innerWidth;
  const doc = document.documentElement;
  const samples: Array<{ issue: string; selector: string }> = [];
  const sel = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : ""}`.slice(0, 120);
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? r : null;
  };
  const clippedByAncestor = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "hidden" || o === "auto" || o === "scroll" || o === "clip") return true;
    }
    return false;
  };
  let clippedText = 0, overlaps = 0, obscured = 0, offscreen = 0, oversized = 0, coveredByOverlay = 0;
  // clipped text: own box cuts its content (no ellipsis, not a scroll container)
  for (const el of Array.from(document.body?.querySelectorAll("p, h1, h2, h3, h4, li, a, button, label, span, td") ?? []).slice(0, 2500)) {
    if (!visible(el) || !(el.textContent ?? "").trim()) continue;
    const cs = getComputedStyle(el);
    const hidden = cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden";
    if (hidden && cs.textOverflow !== "ellipsis" && cs.webkitLineClamp === "none" && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) && el.clientHeight > 0) {
      clippedText++;
      if (samples.length < 20) samples.push({ issue: "clipped text", selector: sel(el) });
    }
  }
  // controls: covered (centre hit-test lands elsewhere), outside the viewport horizontally, overlapping each other
  const controls = Array.from(document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]"))
    .map((el) => ({ el, r: visible(el) })).filter((x) => x.r !== null).slice(0, 300) as Array<{ el: Element; r: DOMRect }>;
  for (const { el, r } of controls) {
    if (r.right > vw + 2 && r.left < vw + 2 && !clippedByAncestor(el)) { offscreen++; if (samples.length < 20) samples.push({ issue: "control outside the viewport", selector: sel(el) }); continue; }
    if (r.right <= 0 || r.left >= vw) continue; // deliberately off-canvas (e.g. a closed drawer)
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = r.top + r.height / 2;
    if (cy < 0 || cy > innerHeight) continue; // only what's on screen can be hit-tested
    const hit = document.elementFromPoint(cx, cy);
    // form fields are skipped: floating labels legitimately sit on top of them
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !field) {
      const hs = getComputedStyle(hit);
      // covered by a detected popup that stayed open: explained by the popup finding, not a layout fault of its own
      if (hs.pointerEvents !== "none" && hit.closest("[data-wim-ov]") && !el.closest("[data-wim-ov]")) coveredByOverlay++;
      else if (hs.pointerEvents !== "none") { obscured++; if (samples.length < 20) samples.push({ issue: "control covered by another element", selector: sel(el) }); }
    }
  }
  for (let i = 0; i < controls.length && i < 150; i++) {
    for (let j = i + 1; j < controls.length && j < 150; j++) {
      const a = controls[i]!, b = controls[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
      const y = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
      if (x * y > 0.3 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) { overlaps++; if (samples.length < 20) samples.push({ issue: "overlapping controls", selector: `${sel(a.el)} / ${sel(b.el)}` }); }
    }
  }
  for (const img of Array.from(document.images).slice(0, 300)) {
    const r = visible(img);
    if (r && r.width > vw + 2 && !clippedByAncestor(img)) oversized++;
  }
  // navigation state: visible links in a nav, or a toggle that controls the nav
  const navs = Array.from(document.querySelectorAll("nav, [role=navigation]")).filter((n) => !/pag(e|ination)/i.test(`${n.getAttribute("aria-label")} ${n.className}`));
  let navState = "NONE";
  if (navs.length) {
    const linkVisible = navs.some((n) => Array.from(n.querySelectorAll("a[href]")).some((a) => { const r = visible(a); return r && r.right > 0 && r.left < vw; }));
    const toggle = document.querySelector("button[aria-controls], [aria-expanded][aria-controls], button[aria-label*=menu i], button[class*=menu i], button[class*=hamburger i], button[class*=toggle i]");
    navState = linkVisible ? "VISIBLE" : toggle && visible(toggle) ? "TOGGLE" : "MISSING";
  }
  return {
    overflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth), clippedText, overlaps, obscuredControls: obscured, offscreenControls: offscreen,
    oversizedImages: oversized, navState, samples, coveredByOverlay,
  };
}

/**
 * Popups on load (read-only apart from marker attributes): visible dialogs (`<dialog open>`, role=dialog/alertdialog,
 * aria-modal), cookie-consent containers (common CMP ids/classes) and fixed/sticky layers in front of the page centre
 * or covering a large share of the viewport. Each overlay and its candidate controls get a `data-wim-ov` /
 * `data-wim-ctl` marker so the worker can address them; the worker decides what may be clicked (classifyDismissControl).
 */
export function detectOverlays(): unknown {
  const vw = innerWidth, vh = innerHeight, va = Math.max(1, vw * vh);
  const norm = (s: string | null | undefined, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const CONSENT = /cookie|consent|gdpr|(^|[\s_-])cmp([\s_-]|$)|cmpbox|qc-cmp|onetrust|cookiebot|cybot|usercentrics|didomi|truste|cookielaw|cc-window|cc-banner|privacy-banner/i;
  const attrs = (el: Element) => `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
  const shown = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return null;
    return r;
  };
  const visArea = (r: DOMRect) => Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const pinned = (el: Element) => { for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === "fixed" || pos === "sticky") return true; } return false; };
  const covers = (el: Element, x: number, y: number) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (el === hit || el.contains(hit))); };
  const inFront = (el: Element, r: DOMRect) => covers(el, Math.min(vw - 1, Math.max(0, (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2)), Math.min(vh - 1, Math.max(0, (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2)));
  const holdsPage = (el: Element) => Boolean(el.querySelector("main, [role=main]")) || el.querySelectorAll("nav, [role=navigation], header, footer, article").length >= 2
    || ((document.body?.innerText ?? "").length > 800 && ((el as HTMLElement).innerText ?? "").length > 0.6 * (document.body?.innerText ?? "").length);
  const selector = (el: Element) => {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && segs.length < 5) {
      if (cur.id && cur.id.length <= 60 && !/\s/.test(cur.id)) { segs.unshift(`#${CSS.escape(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const t = cur.tagName.toLowerCase();
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
      segs.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(cur) + 1})` : t);
      cur = parent;
    }
    return segs.join(" > ").slice(0, 200);
  };
  const labelOf = (el: Element) => {
    const a = el.getAttribute("aria-label");
    if (a) return norm(a);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = norm(lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ")); if (t) return t; }
    const h = el.querySelector("h1, h2, h3, h4, [role=heading], strong");
    if (h && norm(h.textContent)) return norm(h.textContent);
    return norm((el as HTMLElement).innerText ?? el.textContent) || null;
  };
  type Cand = { el: Element; kind: string; r: DOMRect };
  const cands: Cand[] = [];
  const add = (el: Element, kind: string) => {
    if (el === document.body || el === document.documentElement || cands.some((c) => c.el === el)) return;
    const r = shown(el);
    if (r) cands.push({ el, kind, r });
  };
  // 1. dialogs
  for (const el of Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")).slice(0, 30)) {
    const r = shown(el);
    if (!r || visArea(r) < 0.02 * va) continue;
    const consent = CONSENT.test(attrs(el)) || /cookie/i.test(norm((el as HTMLElement).innerText, 400));
    add(el, consent ? "COOKIE_CONSENT" : "MODAL");
  }
  // 2. cookie-consent containers (pinned to the screen; a cookie-policy link in the footer is not one)
  for (const el of Array.from(document.querySelectorAll("#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #usercentrics-root, #didomi-host, #cmpbox, .qc-cmp2-container, #truste-consent-track, #cookie-law-info-bar, .cc-window, [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [id*=gdpr i], [class*=gdpr i], [id*=cmp i], [class*=cmp i]")).slice(0, 200)) {
    if (!CONSENT.test(attrs(el))) continue;
    const r = shown(el);
    if (!r || !pinned(el) || holdsPage(el)) continue;
    if (visArea(r) < 0.02 * va && r.width < 0.4 * vw) continue; // a floating "cookie settings" icon
    add(el, "COOKIE_CONSENT");
  }
  // 3. any fixed / sticky layer in front of the page that covers a large share of it or its centre
  for (const el of Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 4000)) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (cs.pointerEvents === "none") continue;
    const r = shown(el);
    if (!r || holdsPage(el)) continue;
    const big = visArea(r) >= 0.3 * va;
    const centre = r.width >= 0.4 * vw && covers(el, vw / 2, vh / 2);
    if (!(big || centre) || !inFront(el, r)) continue;
    const consent = CONSENT.test(attrs(el)) || /\bcookies?\b/i.test(norm((el as HTMLElement).innerText, 400));
    add(el, consent ? "COOKIE_CONSENT" : el.querySelector("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]") ? "MODAL" : "OVERLAY");
  }
  // outermost only
  const top = cands.filter((c) => !cands.some((o) => o !== c && o.el.contains(c.el)));
  const order = { COOKIE_CONSENT: 0, MODAL: 1, OVERLAY: 2 } as Record<string, number>;
  top.sort((a, b) => order[a.kind]! - order[b.kind]!);
  let n = Number(document.documentElement.getAttribute("data-wim-ovn") ?? 0) || 0;
  for (const el of Array.from(document.querySelectorAll("[data-wim-ctl]"))) el.removeAttribute("data-wim-ctl");
  let ctl = 0;
  const out = top.slice(0, 4).map((c) => {
    let id = c.el.getAttribute("data-wim-ov");
    if (!id) { id = String(++n); c.el.setAttribute("data-wim-ov", id); }
    const blocksPage = c.el.getAttribute("aria-modal") === "true" || (() => { try { return c.el.matches(":modal"); } catch { return false; } })()
      || visArea(c.r) >= 0.3 * va || covers(c.el, vw / 2, vh / 2);
    const controls = Array.from(c.el.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit]")).filter((x) => shown(x)).slice(0, 25).map((x) => {
      const k = String(++ctl);
      x.setAttribute("data-wim-ctl", k);
      const form = (x as HTMLButtonElement).form ?? x.closest("form");
      return {
        ctl: k, tag: x.tagName, text: norm((x as HTMLElement).innerText ?? x.textContent), ariaLabel: x.getAttribute("aria-label"), title: x.getAttribute("title"),
        className: typeof x.className === "string" ? x.className.slice(0, 120) : null, id: x.id || null, href: x.getAttribute("href"), inputType: x.getAttribute("type"), inForm: Boolean(form),
      };
    });
    return { ov: id, kind: c.kind, selector: selector(c.el), label: labelOf(c.el), blocksPage, hasFrame: Boolean(c.el.querySelector("iframe")) || c.el.tagName === "IFRAME", controls };
  });
  document.documentElement.setAttribute("data-wim-ovn", String(n));
  return out;
}

/** Is the marked overlay gone (removed, hidden, faded out or moved off screen)? */
export function overlayGone(id: string): boolean {
  const el = document.querySelector(`[data-wim-ov="${CSS.escape(id)}"]`);
  if (!el || !el.isConnected) return true;
  for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return true;
  }
  const r = el.getBoundingClientRect();
  return r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
}

/** The customer's close button: located with document.querySelector only (an invalid selector finds nothing). */
export function markConfiguredClose(sel: string): unknown {
  let el: Element | null = null;
  try { el = document.querySelector(sel); } catch { return null; }
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (cs.display === "none" || cs.visibility === "hidden" || r.width < 1 || r.height < 1) return null;
  el.setAttribute("data-wim-ctl", "cfg");
  const form = (el as HTMLButtonElement).form ?? el.closest("form");
  return {
    ctl: "cfg", tag: el.tagName, text: ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80), ariaLabel: el.getAttribute("aria-label"), title: el.getAttribute("title"),
    className: typeof el.className === "string" ? el.className.slice(0, 120) : null, id: el.id || null, href: el.getAttribute("href"), inputType: el.getAttribute("type"), inForm: Boolean(form),
  };
}
