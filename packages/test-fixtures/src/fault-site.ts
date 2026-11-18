import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync, gzipSync } from "node:zlib";
import { startTlsSite, type TestPki } from "./tls.js";

/**
 * Controlled fault website for monitoring tests (Phase 4C). The same routes are served over
 * HTTP and HTTPS (certificate chosen per SNI host). Never a public site: tests point fixture
 * DNS names at it through the egress gateway's test allowance.
 *
 *  /healthy /204 /301 /302 /loop-a⇄/loop-b /chain/N /401 /403 /404 /500 /503 /slow?ms=
 *  /hang (headers never sent) /content (marker) /json /large?mb= /gzip /head-unsupported
 *  /toggle (state set by the test) /set-cookie /echo-headers (records what the client sent)
 *  /redirect?to=<absolute URL> (redirect to any destination — internal targets for SSRF tests)
 */
export interface FaultSite {
  httpPort: number;
  httpsPort: number;
  /** per-host toggle state for /toggle: "up" (200) | "down" (500) | "slow" (sleeps 10 s) */
  toggles: Map<string, string>; // "up" | "down" | "slow" | "fixed" | Phase 4F variants and tripwires
  hits: Array<{ host: string; path: string; method: string; headers: Record<string, string | string[] | undefined> }>;
  /** serve a certificate for `host` (defaults: CA-signed, valid 90 days); for a hostname mismatch, map host → a cert for another name with certFor */
  issueCert(host: string, opts?: Parameters<TestPki["leaf"]>[1]): void;
  certFor(host: string, otherName: string): void;
  close(): Promise<void>;
}

/**
 * Noisy PNG of a real size. LCP considers intrinsic size and Chromium ignores low-entropy images
 * (a scaled 1×1 or a solid colour never becomes the LCP element), so the fixture must be "real".
 */
function solidPng(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return c; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([len, td, crc(td)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  let seed = 12345;
  const rows = Array.from({ length: h }, () => {
    const r = Buffer.alloc(1 + w * 3);
    for (let i = 1; i < r.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; r[i] = seed >> 16; }
    return r;
  });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const HERO = solidPng(600, 400);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function startFaultSite(pki: TestPki, host = "127.0.0.1", ports: { http?: number; https?: number } = {}): Promise<FaultSite> {
  const toggles = new Map<string, string>();
  const hits: FaultSite["hits"] = [];
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const h = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const u = new URL(req.url ?? "/", "http://x");
    hits.push({ host: h, path: u.pathname, method: req.method ?? "GET", headers: { ...req.headers } });
    const send = (status: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (h.startsWith("ds-")) return deepScanRoute(req, res, u, h); // deep-scan sites own every path of their host
    const p = u.pathname;
    if (p === "/healthy" || p === "/") return send(200, "<html><body>ok marker:SITE-OK</body></html>", { "cache-control": "no-store", server: "fault-site" });
    if (p === "/204") return send(204);
    if (p === "/301") return send(301, "", { location: "/healthy" });
    if (p === "/302") return send(302, "", { location: "/healthy?session=secret-session-value" });
    if (p === "/loop-a") return send(302, "", { location: "/loop-b" });
    if (p === "/loop-b") return send(302, "", { location: "/loop-a" });
    const chain = /^\/chain\/(\d+)$/.exec(p);
    if (chain) { const n = Number(chain[1]); return send(302, "", { location: n > 0 ? `/chain/${n - 1}` : "/healthy" }); }
    const code = /^\/(401|403|404|500|503)$/.exec(p);
    if (code) return send(Number(code[1]), `status ${code[1]}`, Number(code[1]) === 503 ? { "retry-after": "30" } : {});
    if (p === "/slow") return later(Number(u.searchParams.get("ms") ?? 3000), () => send(200, "slow ok marker:SITE-OK"));
    if (p === "/hang") return; // never responds; the client times out
    if (p === "/content") return send(200, "<html><body>maintenance page without the marker</body></html>");
    if (p === "/json") return send(200, '{"ok":true}', { "content-type": "application/json" });
    if (p === "/large") {
      const mb = Number(u.searchParams.get("mb") ?? 8);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      if (req.method === "HEAD") return res.end();
      const chunk = Buffer.alloc(64 * 1024, 120);
      let left = mb * 16;
      const pump = () => { while (left > 0) { left--; if (!res.write(chunk)) return res.once("drain", pump); } res.end(); };
      res.on("error", () => undefined);
      return pump();
    }
    if (p === "/gzip") {
      const body = gzipSync(Buffer.from("<html>compressed marker:SITE-OK</html>"));
      return send(200, body as unknown as string, { "content-encoding": "gzip" });
    }
    if (p === "/head-unsupported") {
      if (req.method === "HEAD") return send(405, "", { allow: "GET" });
      return send(200, "GET works marker:SITE-OK");
    }
    if (p === "/toggle") {
      const s = toggles.get(h) ?? "up";
      if (s === "down") return send(500, "down");
      if (s === "slow") return later(10_000, () => send(200, "late"));
      return send(200, "toggle ok marker:SITE-OK");
    }
    if (p === "/set-cookie") return send(200, "cookie set marker:SITE-OK", { "set-cookie": "sid=fixture-session-cookie-value; HttpOnly" });
    if (p === "/redirect") return send(302, "", { location: u.searchParams.get("to") ?? "/" });
    if (p.startsWith("/b/")) return browserRoute(req, res, u, h);
    if (p.startsWith("/c/")) return componentRoute(req, res, u, h);
    return send(404, "not found");
  };
  /**
   * Phase 4F component / functional / responsive pages. Destructive endpoints (/c/danger/*, /c/logout,
   * /c/account/delete, any POST) are TRAPS: tests assert they are never reached (see `hits`).
   * Variants via toggles[`${host}#c`]: "nav-changed" | "no-search" | "no-cards" | "broken-search" | "broken-link" | "slow-about" | "blocked-link".
   */
  const componentRoute = (req: IncomingMessage, res: ServerResponse, u: URL, h: string): void => {
    // Phase 4G: toggles[`${host}#perf`] = "slow" delays every /c/ page by 1.2 s (TTFB) — performance regressions on demand
    if (toggles.get(`${h}#perf`) === "slow" && u.pathname !== "/c/perf" && !(req as { __delayed?: boolean }).__delayed) {
      (req as { __delayed?: boolean }).__delayed = true;
      return void later(1200, () => componentRoute(req, res, u, h));
    }
    const variant = toggles.get(`${h}#c`) ?? "";
    const html = (body: string, head = "", status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop</title>${head}</head><body>${body}</body></html>`);
    };
    if (req.method !== "GET" && req.method !== "HEAD") { toggles.set(`${h}#danger-hit`, `${req.method} ${u.pathname}`); return html("<p>stored</p>"); }
    if (/^\/c\/(danger|logout|account\/delete|confirm)/.test(u.pathname)) { toggles.set(`${h}#danger-hit`, `GET ${u.pathname}`); return html("<p>done</p>"); }
    const css = `<style>
      body{margin:0;font-family:sans-serif} header{display:flex;gap:16px;align-items:center;padding:8px 16px;background:#eee}
      #menu{display:flex;gap:12px} #menu a{padding:4px} .menu-toggle{display:none}
      .cards{display:flex;gap:12px;flex-wrap:wrap}.card{width:200px;border:1px solid #ccc;padding:8px}
      @media (max-width:700px){ #menu{display:none} #menu.open{display:flex;flex-direction:column} .menu-toggle{display:inline-block} }
    </style>`;
    const navLinks = `<a href="/c/shop">Home</a><a href="/c/about">About</a><a href="/c/products">Products</a>${variant === "nav-changed" ? `<a href="/c/blog">Blog</a>` : ""}${variant === "blocked-link" ? `<a href="http://blocked.${h}/">Partner</a>` : ""}<a href="/c/logout">Log out</a><a href="/c/account/delete">Delete account</a>`;
    const hideSearchMobile = variant === "hide-search-mobile" ? `<style>@media (max-width:700px){form[role=search]{display:none}}</style>` : "";
    const search = variant === "no-search" ? "" : `${hideSearchMobile}<form role="search" action="/c/search" method="get"><input type="search" name="q" aria-label="Search products"><button type="submit">Search</button></form>`;
    const header = (toggle: string) => `<header><strong>Shop</strong><button class="menu-toggle" aria-controls="menu" aria-expanded="false" aria-label="Open menu" ${toggle}>☰</button><nav id="menu" aria-label="Main">${navLinks}</nav>${search}</header>`;
    const openMenu = `onclick="document.getElementById('menu').classList.toggle('open');this.setAttribute('aria-expanded', String(document.getElementById('menu').classList.contains('open')))"`;
    const main = `<main>
      <h1>Welcome to the shop</h1><p>Products and articles for testing component detection.</p>
      <img alt="Hero banner" src="/b/img/ok.png" width="600" height="200" style="max-width:100%;height:auto">
      ${variant === "no-cards" ? "" : `<div class="cards">${["Alpha", "Beta", "Gamma"].map((x) => `<article class="card"><h3>${x}</h3><a href="/c/products">View</a></article>`).join("")}</div>`}
      <details><summary>Shipping FAQ</summary><p>We ship worldwide.</p></details>
      <button type="button" aria-expanded="false" aria-controls="more" onclick="var m=document.getElementById('more');m.hidden=!m.hidden;this.setAttribute('aria-expanded',String(!m.hidden))">Show more</button><div id="more" hidden><p>More details.</p></div>
      <button type="button" onclick="fetch('/c/danger/buy',{method:'POST'})">Buy now</button>
      <button type="button" onclick="fetch('/c/danger/delete',{method:'POST'})">Delete account</button>
      <button type="button" onclick="location.href='/c/logout'">Log out</button>
      <button type="button" class="x1" onclick="fetch('/c/danger/sneaky',{method:'POST'})">OK</button>
      <form id="contact" action="/c/contact" method="post" aria-label="Contact us"><label>Name <input name="name" required></label><label>Email <input type="email" name="email" required></label><textarea name="message" aria-label="Message"></textarea><button type="submit">Send message</button></form>
      <form id="login" action="/c/login" method="post" aria-label="Sign in"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>
    </main><footer><p>© Shop</p><a href="/c/about">About us</a></footer>`;
    switch (u.pathname) {
      case "/c/shop": return html(header(openMenu) + main, css);
      case "/c/about": if (variant === "slow-about") return later(4000, () => html(`<main><h1>About</h1><p>Slow about page.</p></main>`));
        return html(`${header(openMenu)}<main><h1>About</h1><p>About the shop and its people.</p></main>`, css);
      case "/c/products": return variant === "broken-link" ? html("<h1>Not found</h1>", "", 404) : html(`${header(openMenu)}<main><h1>Products</h1><p>All products in one place.</p></main>`, css);
      case "/c/blog": return html(`${header(openMenu)}<main><h1>Blog</h1><p>Articles.</p></main>`, css);
      case "/c/search": return variant === "broken-search" ? html("<h1>Search is down</h1>", "", 500) : html(`${header(openMenu)}<main><h1>Results for ${String(u.searchParams.get("q") ?? "").replace(/[<>&"]/g, "")}</h1><p>3 results.</p></main>`, css);
      case "/c/bad-form": return html(`<main><h1>Newsletter</h1><form id="news" action="/c/subscribe-form" method="post" aria-label="Newsletter">
          <label>Your name (required) <input name="name"></label><label>Email address <input type="text" name="email"></label><button type="button">Continue</button></form></main>`, css);
      case "/c/mobile-nav-broken": return html(header("") + `<main><h1>Broken mobile menu</h1><p>The toggle does nothing on phones.</p></main>`, css);
      case "/c/js-button": return html(`<main><h1>Details</h1><p>A button whose handler throws.</p><button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');undefinedHandlerCall()">Show details</button></main>`);
      case "/c/overlap": return html(`<main><h1>Overlap</h1><p>Controls covered by a banner.</p>
          <div style="position:relative;height:80px"><a href="/c/about" style="position:absolute;left:10px;top:10px;padding:10px">About</a><a href="/c/products" style="position:absolute;left:20px;top:14px;padding:10px">Products</a></div>
          <button type="button" style="margin:20px">Hidden action</button>
          <div style="position:fixed;left:0;right:0;top:140px;height:80px;background:rgba(0,0,0,.8);color:#fff">Cookie banner covering the page</div></main>`);
      // Phase 4G: a "view" toggle whose handler has GET side effects (image to a delete URL, a one-click confirm link,
      // a third-party call) — none of these may ever be sent
      case "/c/sneaky-get": return html(`<main><h1>Details</h1><p>A toggle with hidden side effects.</p>
          <button type="button" aria-expanded="false" aria-controls="d" onclick="this.setAttribute('aria-expanded','true');document.getElementById('d').hidden=false;
            new Image().src='/c/danger/delete?id=7';fetch('/c/confirm?token=abc123');fetch('http://${toggles.get(`${h}#tracker`) ?? `tracker.${h}`}/collect?e=click').catch(()=>0)">Show details</button>
          <div id="d" hidden><p>Shipping details.</p></div></main>`);
      // Release readiness (blocker 9): a "safe-looking" toggle whose handler causes first-party GETs of every type to
      // innocuous-looking URLs that are NOT deny-listed (the residual-risk vector): image, script, stylesheet, iframe, fetch.
      case "/c/innocent-toggle": return html(`<main><h1>Catalogue</h1><p>Browse.</p>
          <button type="button" aria-expanded="false" aria-controls="m" onclick="this.setAttribute('aria-expanded','true');document.getElementById('m').hidden=false;
            new Image().src='/c/mark-seen?i=1';var s=document.createElement('script');s.src='/c/track.js';document.body.appendChild(s);
            var l=document.createElement('link');l.rel='stylesheet';l.href='/c/theme-switch.css';document.head.appendChild(l);
            var f=document.createElement('iframe');f.src='/c/widget-state';document.body.appendChild(f);fetch('/c/state-toggle').catch(()=>0)">More details</button>
          <div id="m" hidden><p>Details.</p></div><nav><a href="/c/products">Products</a></nav></main>`);
      // Release readiness (blocker 5): every third-party resource type at once. toggles[`${host}#third`] = the third-party host.
      case "/c/third-party": {
        const t = toggles.get(`${h}#third`) ?? `third.${h}`;
        return html(`<main><h1>Third-party resources</h1>
          <script src="http://${t}/tp/script.js"></script>
          <link rel="stylesheet" href="http://${t}/tp/style.css">
          <img alt="pixel" src="http://${t}/tp/pixel.png" width="1" height="1">
          <iframe title="widget" src="http://${t}/tp/frame.html" width="10" height="10"></iframe>
          <script>fetch('http://${t}/tp/fetch').catch(()=>0);try{new WebSocket('ws://${t}/tp/ws')}catch(e){};
            var x=new XMLHttpRequest();x.open('GET','http://${t}/tp/xhr');x.send();</script>
          <img alt="redirect" src="/c/redirect-out" width="1" height="1"></main>`);
      }
      case "/c/redirect-out": { res.writeHead(302, { location: `http://${toggles.get(`${h}#third`) ?? `third.${h}`}/tp/redirected.png` }); return void res.end(); }
      // Phase 4G performance: TTFB switchable with toggles[`${host}#perf`] = "slow" (server waits 1.2 s before answering)
      case "/c/perf": {
        const body = () => html(`<main><h1>Performance page</h1><p>Content for synthetic performance measurement.</p><img alt="hero" src="/b/img/ok.png" width="300" height="100"></main>`);
        return toggles.get(`${h}#perf`) === "slow" ? later(1200, body) : body();
      }
      // Popups on load. Controls sit in the lower half of the viewport, where the popups cover them.
      // Trap endpoints: /c/consent* (a consent record), /c/danger/* and the tracker host must never be reached.
      case "/c/popup-cookie": {
        const tracker = toggles.get(`${h}#tracker`) ?? `tracker.${h}`;
        return html(`<main><h1>Shop with a cookie banner</h1><p>A consent banner covers the lower part of the page.</p><div style="height:48vh"></div>
          <nav aria-label="Main"><a href="/c/about">About</a> <a href="/c/products">Products</a></nav><button type="button" aria-expanded="false" aria-controls="m" onclick="var m=document.getElementById('m');m.hidden=!m.hidden;this.setAttribute('aria-expanded',String(!m.hidden))">Show more</button><div id="m" hidden><p>More.</p></div></main>
          <div id="cookie-consent-banner" role="region" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;height:45vh;background:#222;color:#fff;padding:16px;z-index:50">
            <h2>We value your privacy</h2><p>We use cookies to improve your experience.</p>
            <button type="button" id="accept" onclick="new Image().src='/c/consent-accept';fetch('/c/consent',{method:'POST',body:'all'});document.getElementById('cookie-consent-banner').remove()">Accept all</button>
            <button type="button" id="reject" onclick="fetch('/c/consent',{method:'POST',body:'necessary'}).catch(function(){});fetch('http://${tracker}/consent?c=reject').catch(function(){});new Image().src='/c/consent-reject';document.cookie='consent=necessary;path=/';document.getElementById('cookie-consent-banner').remove()">Reject all</button>
            <a href="/c/privacy">Privacy policy</a>
          </div>`);
      }
      case "/c/popup-modal": {
        const noEsc = u.searchParams.has("noesc");
        return html(`<main><h1>Shop with a newsletter popup</h1><p>A modal newsletter dialog opens on load.</p><div style="height:40vh"></div>
          <nav aria-label="Main"><a href="/c/about">About</a> <a href="/c/products">Products</a></nav><button type="button" aria-expanded="false" aria-controls="m" onclick="var m=document.getElementById('m');m.hidden=!m.hidden;this.setAttribute('aria-expanded',String(!m.hidden))">Show more</button><div id="m" hidden><p>More.</p></div></main>
          <div id="nl-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:90">
            <div role="dialog" aria-modal="true" aria-labelledby="nl-title" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;background:#fff;padding:20px">
              <button type="button" aria-label="Close" style="float:right" onclick="document.getElementById('nl-backdrop').remove()">✕</button>
              <h2 id="nl-title">Get 10% off</h2>
              <form action="/c/subscribe" method="post" onsubmit="return true"><label>Email <input type="email" name="email"></label><button type="submit">Subscribe</button></form>
              <a href="/c/offers">See all offers</a>
            </div></div>
          ${noEsc ? "" : `<script>document.addEventListener('keydown',function(e){if(e.key==='Escape'){var b=document.getElementById('nl-backdrop');if(b)b.remove()}})</script>`}`);
      }
      // A full-screen interstitial with no recognisable close control: only the website's own (configured) close
      // button — an unlabelled icon — closes it. Without a configured selector it blocks visitors.
      case "/c/popup-stuck": return html(`<main><h1>Shop behind an interstitial</h1><p>Content.</p><div style="height:40vh"></div>
          <nav aria-label="Main"><a href="/c/about">About</a> <a href="/c/products">Products</a></nav><button type="button">Show more</button></main>
          <div id="promo" style="position:fixed;inset:0;background:#fff;z-index:99;padding:40px">
            <h2>Members only offer</h2><p>Unlock this page.</p>
            <button type="button" onclick="fetch('/c/danger/subscribe',{method:'POST'})">Subscribe to continue</button>
            <a href="/c/join">Join now</a>
            <span class="nl-x" onclick="document.getElementById('promo').style.display='none'" style="position:absolute;right:12px;top:8px;cursor:pointer">›</span>
          </div>`);
      case "/c/js-alert": return html(`<main><h1>Shop with an alert</h1><p>An alert greets every visitor.</p><button type="button">Show more</button></main>
          <script>alert("Welcome to our shop! Your code is sk_live_abcdefghijklmnopqrstuvwxyz");</script>`);
      case "/c/clipped": return html(`<main><h1>Clipped</h1><p style="width:120px;height:20px;overflow:hidden;white-space:nowrap">This sentence is far too long for its box and gets cut off without an ellipsis.</p></main>`);
      default: return html("<h1>Not found</h1>", "", 404);
    }
  };

  /** Phase 4D browser pages (rendered by Chromium in tests). */
  const browserRoute = (req: IncomingMessage, res: ServerResponse, u: URL, h: string) => {
    const html = (body: string, head = "", status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>${head}</head><body>${body}</body></html>`);
    };
    const okBody = `<main><h1>Welcome</h1><p>Healthy fixture page with enough meaningful text content.</p><img alt="logo" src="/b/img/ok.png" width="120" height="60"></main>`;
    switch (u.pathname) {
      case "/b/healthy": return html(okBody, `<link rel="stylesheet" href="/b/ok.css"><script src="/b/ok.js"></script>`);
      case "/b/ok.css": res.writeHead(200, { "content-type": "text/css" }); return res.end("main{font-family:sans-serif;max-width:100%}");
      case "/b/ok.js": res.writeHead(200, { "content-type": "application/javascript" }); return res.end("window.__ok = 1;");
      case "/b/img/ok.png": res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG);
      case "/b/img/slow.png": return later(Number(u.searchParams.get("ms") ?? 3000), () => { res.writeHead(200, { "content-type": "image/png" }); res.end(u.searchParams.get("big") ? HERO : PNG); });
      case "/b/blank": return html("");
      case "/b/delayed": return html(`<div id="app"></div><script>setTimeout(()=>{document.getElementById("app").innerHTML='<h1 id="ready">Rendered later</h1><p>content after delay</p>'}, Number(${Number(u.searchParams.get("ms") ?? 600)}))</script>`);
      case "/b/js-exception": return html(okBody, `<script>window.addEventListener("load",()=>{ undefinedFunctionCall(${"`"}order-${"$"}{Date.now()}${"`"}) })</script>`);
      case "/b/rejection": return html(okBody, `<script>Promise.reject(new Error("checkout failed for cart 4711"))</script>`);
      case "/b/console-error": return html(okBody, `<script>console.error("analytics key missing 123")</script>`);
      case "/b/broken-image": return html(`${okBody}<img alt="hero" src="/b/img/missing.png" width="300" height="200">`);
      case "/b/failed-css": return html(okBody, `<link rel="stylesheet" href="/b/missing.css">`);
      case "/b/failed-js": return html(okBody, `<script src="/b/missing.js"></script>`);
      case "/b/slow-resource": return html(`${okBody}<img alt="slow" src="/b/img/slow.png?ms=${Number(u.searchParams.get("ms") ?? 2500)}" width="50" height="50">`);
      case "/b/redirect": res.writeHead(302, { location: "/b/healthy" }); return res.end();
      case "/b/large": return html(Array.from({ length: 4000 }, (_, i) => `<section><h2>Section ${i}</h2><p>${"Lorem ipsum dolor sit amet. ".repeat(20)}</p></section>`).join(""));
      case "/b/overflow": return html(`${okBody}<div style="width:2400px;height:20px;background:#ccc">wide banner</div>`);
      case "/b/responsive-broken": return html(`${okBody}<div class="w">wide on phones</div>`, `<style>@media (max-width:500px){.w{width:900px;background:#eee}}</style>`);
      case "/b/hidden-wide": return html(`${okBody}<div style="display:none;width:3000px">hidden</div><div style="overflow:hidden;width:100%"><div style="width:3000px">clipped intentionally</div></div>`);
      case "/b/missing-font": return html(`<p style="font-family:Missing">${"Text with a missing web font. ".repeat(5)}</p>`, `<style>@font-face{font-family:Missing;src:url(/b/missing.woff2) format("woff2")}</style>`);
      case "/b/spa": return html(`<div id="root"></div><script>history.pushState({}, "", "/b/spa/dashboard");document.getElementById("root").innerHTML="<h1>Dashboard</h1><p>rendered client-side after pushState</p>";</script>`);
      case "/b/persistent": return html(okBody, `<script>new EventSource("/b/sse");setInterval(()=>fetch("/b/poll").catch(()=>0),400)</script>`);
      case "/b/sse": res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); res.write("data: hello\n\n"); return; // never ends
      case "/b/poll": return later(300, () => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
      case "/b/third-party-fail": return html(okBody, `<script src="http://cdn.third-party.example/b/missing.js"></script>`);
      case "/b/offsite": res.writeHead(302, { location: "http://elsewhere.other-site.example/b/healthy" }); return res.end();
      case "/b/download": res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=payload.bin" }); return res.end(Buffer.alloc(1024, 1));
      case "/b/cls": return html(`<div id="b"></div>${okBody}<p>${"More text. ".repeat(50)}</p><script>setTimeout(()=>{document.getElementById("b").innerHTML='<div style="height:600px;background:#fc0">late banner</div>'},300);setTimeout(()=>{document.getElementById("b").innerHTML=''},700);setTimeout(()=>{document.getElementById("b").innerHTML='<div style="height:600px;background:#fc0">late banner</div>'},1100)</script>`);
      case "/b/slow-lcp": return html(`<h1>Hero</h1><img alt="hero" src="/b/img/slow.png?big=1&ms=${Number(u.searchParams.get("ms") ?? 4500)}" width="600" height="400">`);
      case "/b/toggle": {
        const st = toggles.get(h) ?? "up";
        return st === "down" ? html("") : html(okBody);
      }
      case "/b/malicious": return html(`<h1>evil</h1><p>tries to reach internal services</p><script>
        window.__attempts = {};
        const t = (k, p) => p.then(() => { window.__attempts[k] = "reached"; }, (e) => { window.__attempts[k] = "blocked:" + String(e && e.message || e).slice(0, 60); });
        t("fetch-127.0.0.1:3000", fetch("http://127.0.0.1:3000/health", { mode: "no-cors" }));
        t("fetch-localhost", fetch("http://localhost:3000/health", { mode: "no-cors" }));
        t("fetch-localhost-80", fetch("http://localhost/", { mode: "no-cors" }));
        t("fetch-metadata", fetch("http://169.254.169.254/latest/meta-data/", { mode: "no-cors" }));
        t("fetch-private", fetch("http://10.0.0.5/", { mode: "no-cors" }));
        t("ws-private", new Promise((ok, ko) => { try { const w = new WebSocket("ws://10.0.0.5:6379/"); w.onopen = ok; w.onerror = () => ko(new Error("ws error")); } catch (e) { ko(e); } }));
        t("ws-internal-name", new Promise((ok, ko) => { try { const w = new WebSocket("ws://internal-" + location.hostname + "/"); w.onopen = ok; w.onerror = () => ko(new Error("ws error")); } catch (e) { ko(e); } }));
        try { window.open("file:///etc/passwd"); } catch (e) {}
        setTimeout(() => { try { location.href = "file:///etc/passwd"; } catch (e) {} }, 1500);
      </script>`);
      default: res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found");
    }
  };
  /**
   * Phase 4E deep-scan websites. The host's first label picks the variant:
   *  ds-site-*   multi-page site (robots, sitemap index, broken/redirect/SEO/a11y pages, traps, SSRF links)
   *  ds-badxml-* invalid sitemap XML   ds-loop-* sitemap index loop   ds-huge-* oversized sitemap
   * toggles: "fixed" repairs the broken page and its link targets (recovery scans).
   */
  const deepScanRoute = (req: IncomingMessage, res: ServerResponse, u: URL, h: string) => {
    const kind = h.split("-")[1];
    const fixed = toggles.get(h) === "fixed";
    const xml = (body: string, status = 200) => { res.writeHead(status, { "content-type": "application/xml" }); res.end(body); };
    const page = (opts: { title?: string | null; desc?: string | null; canonical?: string | null; h1?: number; lang?: boolean; viewport?: boolean; og?: boolean; main?: boolean; body?: string; head?: string; status?: number }) => {
      const o = { title: "Page", desc: "A page description.", canonical: null as string | null, h1: 1, lang: true, viewport: true, og: true, main: true, body: "<p>Content.</p>", head: "", status: 200, ...opts };
      const html = `<!doctype html><html${o.lang ? ' lang="en"' : ""}><head><meta charset="utf-8">${o.title === null ? "" : `<title>${o.title}</title>`}${o.desc === null ? "" : `<meta name="description" content="${o.desc}">`}${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}${o.viewport ? '<meta name="viewport" content="width=device-width,initial-scale=1">' : ""}${o.og ? '<meta property="og:title" content="x">' : ""}${o.head}</head><body>${o.main ? "<main>" : ""}${"<h1>Heading</h1>".repeat(o.h1)}${o.body}${o.main ? "</main>" : ""}</body></html>`;
      res.writeHead(o.status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const origin = `http://${h}`;
    if (kind === "badxml") {
      if (u.pathname === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`Sitemap: ${origin}/sitemap.xml\n`); }
      if (u.pathname === "/sitemap.xml") return xml(`<?xml version="1.0"?><urlset><url><loc>${origin}/a</loc></url><url><loc>`);
      return page({ title: `Bad XML ${u.pathname}`, canonical: `${origin}${u.pathname}` });
    }
    if (kind === "loop") {
      if (u.pathname === "/sitemap.xml") return xml(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sm-a.xml</loc></sitemap></sitemapindex>`);
      if (u.pathname === "/sm-a.xml") return xml(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sm-b.xml</loc></sitemap></sitemapindex>`);
      if (u.pathname === "/sm-b.xml") return xml(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap.xml</loc></sitemap><sitemap><loc>${origin}/sm-a.xml</loc></sitemap></sitemapindex>`);
      return page({ title: `Loop ${u.pathname}`, canonical: `${origin}${u.pathname}` });
    }
    if (kind === "mini") {
      // small site for recovery / partial-scan / crash tests: home → /ok, /broken-link → /missing (fixable), /slow-a…/slow-e
      const slow = Number(u.searchParams.get("ms") ?? 0);
      if (u.pathname === "/") return page({ title: "Mini home", canonical: `${origin}/`, body: '<a href="/ok">OK</a><a href="/broken-link">Broken</a><a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a><a href="/p4">4</a><a href="/p5">5</a>' });
      if (u.pathname === "/ok") return page({ title: "Mini ok", canonical: `${origin}/ok` });
      if (u.pathname === "/broken-link") return page({ title: "Mini broken link", canonical: `${origin}/broken-link`, body: '<a href="/missing">missing</a>' });
      if (u.pathname === "/missing") return fixed ? page({ title: "Mini restored", canonical: `${origin}/missing` }) : page({ title: "Not found", status: 404 });
      const pm = /^\/p(\d)$/.exec(u.pathname);
      if (pm) return later(toggles.get(`${h}#slow`) ? 1500 : slow, () => page({ title: `Mini page ${pm[1]}`, canonical: `${origin}${u.pathname}` }));
      return page({ title: "Not found", status: 404 });
    }
    if (kind === "huge") {
      if (u.pathname === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.write(`<?xml version="1.0"?><urlset>`);
        for (let i = 0; i < 60_000; i++) res.write(`<url><loc>${origin}/p/${i}</loc><lastmod>2026-13-45</lastmod></url>`);
        return res.end(`</urlset>`);
      }
      return page({ title: `Huge ${u.pathname}`, canonical: `${origin}${u.pathname}` });
    }
    // ---- ds-site: the main multi-page website
    switch (u.pathname) {
      case "/robots.txt": res.writeHead(200, { "content-type": "text/plain" }); return res.end(`User-agent: *\nDisallow: /private/\nCrawl-delay: 0\nSitemap: ${origin}/sitemap.xml\nSitemap: http://other-site.example/sitemap.xml\n`);
      case "/sitemap.xml": return xml(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemaps/pages.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/blog.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/gone.xml</loc></sitemap></sitemapindex>`);
      case "/sitemaps/pages.xml": return xml(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc><lastmod>2026-11-01</lastmod></url><url><loc>${origin}/about</loc></url><url><loc>${origin}/noindex</loc></url><url><loc>${origin}/about</loc></url><url><loc>http://elsewhere.example/page</loc></url><url><loc>${origin}/orphan-in-sitemap</loc><lastmod>not-a-date</lastmod></url></urlset>`);
      case "/sitemaps/blog.xml": return xml(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/blog/</loc></url><url><loc>${origin}/blog/post-1</loc></url></urlset>`);
      case "/": return page({ title: "Home", canonical: `${origin}/`, body: `
        <nav><a href="/about">About</a> <a href="/About?utm_source=nav">About again</a> <a href="/%61bout#team">About encoded</a>
        <a href="/products?category=shoes">Shoes</a> <a href="/products?category=hats">Hats</a> <a href="/products?category=shoes&utm_medium=x">Shoes tracked</a>
        <a href="/blog/">Blog</a> <a href="/broken-link">Broken</a> <a href="/old">Old</a> <a href="/loop1">Loop</a> <a href="/private/secret">Private</a>
        <a href="/logout">Log out</a> <a href="/account/delete?confirm=1">Delete account</a> <a href="/cart/add?id=4">Add to cart</a>
        <a href="http://external.example/">External</a> <a href="http://10.0.0.1/admin">Router</a> <a href="http://[::ffff:127.0.0.1]/">Mapped</a>
        <a href="http://169.254.169.254/latest/meta-data/">Metadata</a> <a href="file:///etc/passwd">File</a> <a href="ftp://ftp.example/x">FTP</a>
        <a href="/redir-meta">Redirect to metadata</a> <a href="/redir-internal">Redirect to internal name</a> <a href="/redir-offsite">Off-site redirect</a>
        <a href="javascript:void(0)">JS</a> <a href="">Empty</a> <a href="http://${h}:8080/alt-port">Port</a> <a href="/no-desc">No desc</a>
        <a href="/no-canonical">No canonical</a> <a href="/no-h1">No h1</a> <a href="/img">Images</a> <a href="/a11y">A11y</a> <a href="/jsonld-bad">JSON-LD</a>
        <a href="/slow">Slow</a> <a href="/large">Large</a> <a href="/trap/1">Trap</a> <a href="/calendar?page=1">Calendar</a> <a href="/spa">SPA</a> <a href="/dup-a">Dup A</a> <a href="/dup-b">Dup B</a> <a href="/bad-canonical">Bad canonical</a> <a href="/forms">Forms</a></nav>`,
        head: `<link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/missing.css"><script src="/assets/missing.js"></script><script src="http://cdn.third.example/lib.js"></script>` });
      case "/assets/site.css": res.writeHead(200, { "content-type": "text/css" }); return res.end("body{margin:0}");
      case "/about": return page({ title: "About us", canonical: `${origin}/about` });
      // site search whose results page fails, and a form that would send data over plain HTTP
      case "/forms": return page({ title: "Forms", canonical: `${origin}/forms`, body: '<form role="search" action="/search"><label>Search <input type="search" name="q"></label><button>Search</button></form><form method="post" action="http://insecure.example/subscribe"><label>Email <input name="email"></label><button>Subscribe</button></form>' });
      case "/search": return u.searchParams.has("q") ? page({ title: "Search error", status: 500 }) : page({ title: "Search", canonical: `${origin}/search` });
      case "/products": return page({ title: `Products ${u.searchParams.get("category")}`, canonical: `${origin}/products?category=${u.searchParams.get("category")}`, desc: `Products in ${u.searchParams.get("category")}` });
      case "/blog/": return page({ title: "About us", canonical: `${origin}/blog/`, body: '<a href="/blog/post-1">Post 1</a>' }); // duplicate title with /about
      case "/blog/post-1": return page({ title: "Post 1", canonical: `${origin}/blog/post-1` });
      case "/broken-link": return page({ title: "Has a broken link", canonical: `${origin}/broken-link`, body: '<a href="/missing">Missing page</a>' });
      case "/missing": return fixed ? page({ title: "Restored", canonical: `${origin}/missing` }) : page({ title: "Not found", status: 404 });
      case "/old": res.writeHead(301, { location: "/old2" }); return res.end();
      case "/old2": res.writeHead(302, { location: "/old3" }); return res.end();
      case "/old3": res.writeHead(301, { location: "/about" }); return res.end();
      case "/loop1": res.writeHead(302, { location: "/loop2" }); return res.end();
      case "/loop2": res.writeHead(302, { location: "/loop1" }); return res.end();
      case "/private/secret": return page({ title: "Private", body: "<p>robots-disallowed</p>" });
      case "/logout": case "/account/delete": case "/cart/add": toggles.set(`${h}#unsafe-hit`, "down"); return page({ title: "SHOULD NEVER BE FETCHED" });
      case "/redir-meta": res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end();
      case "/redir-internal": res.writeHead(302, { location: `http://internal-${h}/` }); return res.end();
      case "/redir-offsite": res.writeHead(302, { location: "http://elsewhere.example/" }); return res.end();
      case "/no-desc": return page({ title: "No description", desc: null, canonical: `${origin}/no-desc` });
      case "/no-canonical": return page({ title: "No canonical" });
      case "/no-h1": return page({ title: "No h1", h1: 0, canonical: `${origin}/no-h1` });
      case "/img": return page({ title: "Images", canonical: `${origin}/img`, body: '<img src="/assets/missing.png"><img src="/assets/logo.png" alt="Logo">' });
      case "/assets/logo.png": res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG);
      case "/a11y": return page({ title: "Accessibility issues", canonical: `${origin}/a11y`, lang: false, main: false, body: '<h2>Sub</h2><h4>Skipped</h4><a href="/about"></a><button></button><input type="text" name="q"><label for="e">Email</label><input id="e"><div id="dup"></div><div id="dup"></div>' });
      case "/jsonld-bad": return page({ title: "JSON-LD", canonical: `${origin}/jsonld-bad`, head: '<script type="application/ld+json">{"@context":"https://schema.org", broken</script>' });
      case "/noindex": return page({ title: "Hidden", canonical: `${origin}/noindex`, head: '<meta name="robots" content="noindex,follow">' });
      case "/orphan-in-sitemap": return page({ title: "Orphan", canonical: `${origin}/orphan-in-sitemap` });
      case "/slow": return later(2000, () => page({ title: "Slow page", canonical: `${origin}/slow` }));
      case "/large": return page({ title: "Large page", canonical: `${origin}/large`, body: `<p>${"x".repeat(5 * 1024 * 1024)}</p>` });
      case "/spa": return page({ title: "SPA", canonical: `${origin}/spa`, body: '<div id="app"></div><script>document.getElementById("app").innerHTML=\'<a href="/spa/route-a">A</a><a href="/spa/route-b">B</a>\'</script>' });
      case "/spa/route-a": case "/spa/route-b": return page({ title: `SPA ${u.pathname}`, canonical: `${origin}${u.pathname}` });
      case "/dup-a": case "/dup-b": return page({ title: `Dup ${u.pathname}`, desc: "Same description everywhere.", body: "<p>Identical body text for duplicate detection.</p>" });
      case "/bad-canonical": return page({ title: "Bad canonical", canonical: "http://another-site.example/x" });
      case "/calendar": { const n = Number(u.searchParams.get("page") ?? 1); return page({ title: `Calendar ${n}`, canonical: `${origin}/calendar?page=${n}`, body: `<a href="/calendar?page=${n + 1}">next</a>` }); }
      default: {
        const t = /^\/trap\/(\d+)$/.exec(u.pathname);
        if (t) { const n = Number(t[1]); return page({ title: `Trap ${n}`, canonical: `${origin}/trap/${n}`, body: `<a href="/trap/${n + 1}">deeper</a>` }); }
        return page({ title: "Not found", status: 404 });
      }
    }
  };
  const http: Server = createServer(handler);
  http.on("connection", (s) => s.on("error", () => undefined));
  await new Promise<void>((r) => http.listen(ports.http ?? 0, host, r));
  const certs = new Map<string, { key: string; cert: string }>([["*", pki.leaf(["fallback.invalid"])]]);
  const tls = await startTlsSite(certs, handler, ports.https ?? 0, host);
  return {
    httpPort: (http.address() as AddressInfo).port,
    httpsPort: tls.port,
    toggles, hits,
    issueCert(name, opts) {
      certs.set(name.toLowerCase(), pki.leaf([name], opts));
    },
    certFor(name, otherName) {
      certs.set(name.toLowerCase(), pki.leaf([otherName]));
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      await tls.close();
    },
  };
}
