/*!
 * SiteSentinel browser SDK v__SDK_VERSION__ — privacy-first frontend telemetry.
 * Collects: JS errors, unhandled rejections, failed resource loads, Web Vitals,
 * route changes and (opt-in) failed API calls — with page paths only.
 * Never collects: form fields or values, cookies, storage, request/response bodies
 * or headers, query strings, element text, keystrokes. No cookies are set.
 * The site key is a public identifier, not a secret.
 */
(function () {
  "use strict";
  var VERSION = "__SDK_VERSION__";
  var w = window, d = document;
  if (w.__ssMonitorLoaded) return;
  w.__ssMonitorLoaded = true;

  try {
    var script = d.currentScript || d.querySelector("script[data-site-key]");
    if (!script) return;
    var key = script.getAttribute("data-site-key") || "";
    if (!/^pk_[A-Za-z0-9_-]{32}$/.test(key)) return;
    var base = script.getAttribute("data-endpoint") || new URL(script.src, location.href).origin;
    var needConsent = script.getAttribute("data-consent") === "required";
  } catch (_) {
    return;
  }

  var MAX_EVENTS = 100, BATCH = 20, FLUSH_MS = 5000;
  var queue = [], sent = 0, failures = 0, cfg = null, consented = !needConsent, stopped = false, seq = 0;
  var pageLoad = rand();
  var masks = [];

  function rand() {
    try {
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (_) {
      return String(Math.random()).slice(2) + String(Date.now());
    }
  }

  // ------------------------------------------------------------ data minimization
  var EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  var LONGNUM = /\d{6,}/g;
  var TOKENISH = /[A-Za-z0-9_-]{24,}/g;
  function scrub(s, max) {
    if (typeof s !== "string") s = String(s == null ? "" : s);
    return s.replace(EMAIL, "[email]").replace(UUID, "[id]").replace(LONGNUM, "[n]").replace(TOKENISH, "[t]").slice(0, max || 300);
  }
  function path(u) {
    var p;
    try { p = new URL(u, location.href); } catch (_) { return "/"; }
    var out = p.pathname.split("/").map(function (seg) { return seg ? scrub(decodeURIComponentSafe(seg), 80) : seg; }).join("/");
    for (var i = 0; i < masks.length; i++) { try { if (masks[i].test(out)) out = out.replace(masks[i], "[masked]"); } catch (_) { /* ignore */ } }
    return out.slice(0, 300) || "/";
  }
  function originAndPath(u) {
    try { var p = new URL(u, location.href); return (p.origin === location.origin ? "" : p.origin) + path(p.href); } catch (_) { return ""; }
  }
  function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
  function device() {
    var wd = w.innerWidth || 0;
    return wd < 768 ? "mobile" : wd < 1100 ? "tablet" : "desktop";
  }

  // ------------------------------------------------------------ transport
  function push(type, data, fingerprint) {
    if (stopped || !consented || sent + queue.length >= MAX_EVENTS) return;
    if (cfg && cfg.enabled === false) return;
    queue.push({ type: type, seq: seq++, path: path(location.href), data: data || {}, fingerprint: fingerprint, t: Date.now() });
    if (queue.length >= BATCH) flush();
  }

  function payload(events, heartbeat) {
    return JSON.stringify({
      v: 1, k: key, sv: VERSION, pl: pageLoad, hb: !!heartbeat,
      ctx: { path: path(location.href), vw: w.innerWidth || 0, vh: w.innerHeight || 0, device: device() },
      events: events,
    });
  }

  function send(body, beacon) {
    if (stopped) return;
    var url = base + "/v1/collect";
    try {
      // text/plain keeps the request "simple" (no CORS preflight) — the server parses JSON.
      if (beacon && navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
      fetch(url, { method: "POST", body: body, keepalive: true, credentials: "omit", mode: "cors", headers: { "Content-Type": "text/plain" } })
        .then(function (r) { failures = r.ok || r.status === 204 ? 0 : failures + 1; if (failures >= 3) stopped = true; })
        .catch(function () { if (++failures >= 3) stopped = true; });
    } catch (_) {
      if (++failures >= 3) stopped = true;
    }
  }

  function flush(beacon) {
    if (!queue.length || !consented) return;
    var batch = queue.splice(0, BATCH);
    sent += batch.length;
    send(payload(batch, false), beacon);
  }

  // ------------------------------------------------------------ collectors
  function errorFingerprint(msg, src) { return scrub(String(msg), 120) + "|" + (src || ""); }

  function onError(ev) {
    try {
      var t = ev.target;
      if (t && t !== w && (t.src || t.href)) {
        if (!cfg || cfg.captureResourceErrors !== false) {
          var tag = (t.tagName || "").toLowerCase();
          if (tag === "img" || tag === "script" || tag === "link" || tag === "video" || tag === "audio" || tag === "source") {
            var res = originAndPath(t.src || t.href);
            push("RESOURCE", { tag: tag, url: res }, tag + "|" + res);
          }
        }
        return;
      }
      if (cfg && cfg.captureErrors === false) return;
      if (cfg && Math.random() >= (cfg.errorSampleRate == null ? 1 : cfg.errorSampleRate)) return;
      var src = ev.filename ? originAndPath(ev.filename) : "";
      push("JS_ERROR", {
        message: scrub(ev.message || (ev.error && ev.error.message) || "Error"),
        source: src, line: ev.lineno || 0, col: ev.colno || 0,
        stack: ev.error && ev.error.stack ? scrub(String(ev.error.stack).split("\n").slice(0, 6).join("\n"), 800) : "",
      }, errorFingerprint(ev.message, src));
    } catch (_) { /* never throw into the host page */ }
  }

  function onRejection(ev) {
    try {
      if (cfg && cfg.captureErrors === false) return;
      var r = ev.reason;
      var msg = r && r.message ? r.message : typeof r === "string" ? r : "Unhandled promise rejection";
      push("REJECTION", { message: scrub(msg), stack: r && r.stack ? scrub(String(r.stack).split("\n").slice(0, 6).join("\n"), 800) : "" }, errorFingerprint(msg, ""));
    } catch (_) { /* ignore */ }
  }

  var vitals = {};
  function observeVitals() {
    if (!w.PerformanceObserver || (cfg && cfg.captureVitals === false)) return;
    if (Math.random() >= (cfg && cfg.vitalsSampleRate != null ? cfg.vitalsSampleRate : 0.2)) return;
    function obs(type, cb) { try { new PerformanceObserver(function (l) { l.getEntries().forEach(cb); }).observe({ type: type, buffered: true }); } catch (_) { /* unsupported */ } }
    obs("largest-contentful-paint", function (e) { vitals.lcp = Math.round(e.startTime); });
    obs("paint", function (e) { if (e.name === "first-contentful-paint") vitals.fcp = Math.round(e.startTime); });
    var cls = 0; obs("layout-shift", function (e) { if (!e.hadRecentInput) { cls += e.value; vitals.cls = Math.round(cls * 1000) / 1000; } });
    obs("event", function (e) { if (e.interactionId && (!vitals.inp || e.duration > vitals.inp)) vitals.inp = Math.round(e.duration); });
    try { var nav = performance.getEntriesByType("navigation")[0]; if (nav) vitals.ttfb = Math.round(nav.responseStart); } catch (_) { /* ignore */ }
  }
  function reportVitals() {
    if (vitals.reported) return;
    var keys = ["lcp", "fcp", "cls", "inp", "ttfb"].filter(function (k) { return vitals[k] != null; });
    if (!keys.length) return;
    vitals.reported = true;
    var data = {}; keys.forEach(function (k) { data[k] = vitals[k]; });
    push("VITALS", data);
  }

  function wrapHistory() {
    var last = location.pathname;
    function check() { try { if (location.pathname !== last) { last = location.pathname; push("NAV", { to: path(location.href) }); } } catch (_) { /* ignore */ } }
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function () { var r = orig.apply(this, arguments); check(); return r; };
    });
    w.addEventListener("popstate", check);
  }

  function wrapFetch() {
    if (!cfg || !cfg.captureApiFailures || typeof w.fetch !== "function") return;
    var orig = w.fetch;
    w.fetch = function (input, init) {
      var started = Date.now();
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : input && input.url;
      var p = orig.apply(this, arguments);
      try {
        if (url && url.indexOf(base) !== 0) {
          p.then(function (r) {
            if (r.status >= 500) push("API_FAILURE", { method: String(method).toUpperCase().slice(0, 7), url: originAndPath(url), status: r.status, ms: Date.now() - started });
          }, function () {
            push("API_FAILURE", { method: String(method).toUpperCase().slice(0, 7), url: originAndPath(url), status: 0, ms: Date.now() - started });
          });
        }
      } catch (_) { /* ignore */ }
      return p;
    };
  }

  // ------------------------------------------------------------ lifecycle
  function start() {
    if (stopped) return;
    // Heartbeat: proves this page, on this origin, runs the SDK with this key.
    send(payload([], true), false);
    w.addEventListener("error", onError, true);
    w.addEventListener("unhandledrejection", onRejection);
    observeVitals();
    wrapHistory();
    wrapFetch();
    setInterval(function () { flush(false); }, FLUSH_MS);
    d.addEventListener("visibilitychange", function () { if (d.visibilityState === "hidden") { reportVitals(); flush(true); } });
    w.addEventListener("pagehide", function () { reportVitals(); flush(true); });
  }

  function loadConfig(cb) {
    var cacheKey = "__ss_cfg_" + key;
    try {
      var c = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (c && c.exp > Date.now()) return cb(c.cfg);
    } catch (_) { /* storage unavailable */ }
    fetch(base + "/v1/config/" + encodeURIComponent(key), { credentials: "omit", mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        try { if (c) sessionStorage.setItem(cacheKey, JSON.stringify({ cfg: c, exp: Date.now() + 600000 })); } catch (_) { /* ignore */ }
        cb(c);
      })
      .catch(function () { cb(null); });
  }

  // Public API: window.SiteSentinel("consent", true|false)
  var api = function (cmd, value) {
    try {
      if (cmd === "consent") {
        consented = !!value;
        if (consented && cfg && !stopped && !api.started) { api.started = true; start(); }
        if (!consented) queue.length = 0;
      }
    } catch (_) { /* ignore */ }
  };
  var pending = w.SiteSentinel && w.SiteSentinel.q;
  w.SiteSentinel = api;

  loadConfig(function (c) {
    try {
      if (!c || c.enabled === false && !c.heartbeat) { stopped = true; return; }
      cfg = c;
      if (cfg.requireConsent) consented = false;
      if (cfg.respectGlobalPrivacyControl && navigator.globalPrivacyControl) { stopped = true; return; }
      (cfg.maskPatterns || []).forEach(function (p) { try { masks.push(new RegExp(p, "g")); } catch (_) { /* skip */ } });
      if (pending && pending.length) pending.forEach(function (a) { api.apply(null, a); });
      if (consented) { api.started = true; start(); }
    } catch (_) { /* ignore */ }
  });
})();
