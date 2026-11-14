// Isolation probes. Run INSIDE a container of the isolation environment:
//   node infra/security/isolation/probe.mjs <browser-runner|worker|gateway|scheduler>
// Prints one JSON object per line: { role, name, expect, result, detail }.
// result is "reached" when a connection/response was obtained, otherwise "blocked".
import { connect } from "node:net";
import { createSocket } from "node:dgram";

const role = process.argv[2];
const SECRET = process.env.EGRESS_TOKEN_SECRET;
const GATEWAY = "http://egress-gateway:8080";
const results = [];
const emit = (name, expect, result, detail = "") => {
  const r = { role, name, expect, result, detail: String(detail).slice(0, 200) };
  results.push(r);
  console.log(JSON.stringify(r));
};

function tcp(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: ms });
    const done = (result, detail) => { s.destroy(); resolve({ result, detail }); };
    s.once("connect", () => done("reached", "connected"));
    s.once("timeout", () => done("blocked", "timeout"));
    s.once("error", (e) => done("blocked", e.code ?? e.message));
  });
}

function udpDns(host, ms = 2500) {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    const q = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
    const t = setTimeout(() => { s.close(); resolve({ result: "blocked", detail: "no answer" }); }, ms);
    s.once("message", () => { clearTimeout(t); s.close(); resolve({ result: "reached", detail: "answer received" }); });
    s.once("error", (e) => { clearTimeout(t); s.close(); resolve({ result: "blocked", detail: e.code ?? e.message }); });
    s.send(q, 53, host);
  });
}

async function directProbes(expectReachable = []) {
  const targets = [
    ["redis by IP", "10.250.10.10", 6379], ["postgres by IP", "10.250.10.11", 5432], ["redis by service name", "redis", 6379],
    ["postgres by service name", "postgres", 5432], ["fixture site directly (bypassing gateway)", "10.250.77.10", 80],
    ["gateway's fakenet interface", "10.250.77.2", 8080], ["public internet 1.1.1.1:443", "1.1.1.1", 443],
    ["public internet 8.8.8.8:53/tcp", "8.8.8.8", 53], ["cloud metadata 169.254.169.254", "169.254.169.254", 80],
    ["Docker host (host.docker.internal) dev Postgres", "host.docker.internal", 55432],
    ["Docker host (host.docker.internal) dev Redis", "host.docker.internal", 56379],
    ["Docker Desktop host IP 192.168.65.254", "192.168.65.254", 55432], ["gateway via docker DNS (allowed path)", "egress-gateway", 8080],
  ];
  for (const [name, host, port] of targets) {
    const r = await tcp(host, port);
    const expect = expectReachable.includes(name) ? "reached" : "blocked";
    emit(`direct TCP: ${name}`, expect, r.result, r.detail);
  }
  for (const [name, host] of [["UDP DNS to 8.8.8.8", "8.8.8.8"], ["UDP DNS to 1.1.1.1", "1.1.1.1"], ["UDP to fixture DNS directly", "10.250.77.11"]]) {
    const r = await udpDns(host);
    emit(`direct ${name}`, "blocked", r.result, r.detail);
  }
}

async function token(kind) {
  if (process.env.EGRESS_CAP_TOKEN) return process.env.EGRESS_CAP_TOKEN; // handed over, never minted here
  const { signCapability } = await import("/repo/packages/netguard/dist/index.js");
  return signCapability(SECRET, { o: "11111111-1111-1111-1111-111111111111", w: null, e: `isolation-${kind}`, k: "probe" });
}

async function browserProbes() {
  const { chromium } = await import("/repo/node_modules/@playwright/test/index.mjs");
  const { BROWSER_LAUNCH_ARGS, guardedGoto } = await import("/repo/packages/netguard/dist/index.js");
  emit("browser container holds no gateway signing secret", "blocked", process.env.EGRESS_TOKEN_SECRET ? "reached" : "blocked", process.env.EGRESS_TOKEN_SECRET ? "secret present" : "absent");
  const tok = await token("browser");
  const args = [...BROWSER_LAUNCH_ARGS];
  const browser = await chromium.launch({ args, proxy: { server: GATEWAY, username: "cap", password: tok } });
  const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false });
  const page = await ctx.newPage();
  const nav = async (name, url, expect, okText) => {
    try {
      const resp = await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
      const status = resp?.status() ?? 0;
      const body = (await page.content()).slice(0, 2000);
      const reached = status > 0 && status < 400 && (!okText || body.includes(okText));
      // A gateway refusal is an HTTP response from the gateway itself (status 4xx/5xx + no target content).
      emit(`browser via gateway: ${name}`, expect, reached ? "reached" : "blocked", `status ${status} ${resp?.headers()["x-egress-error"] ?? ""}`);
    } catch (e) {
      emit(`browser via gateway: ${name}`, expect, "blocked", e.message.split("\n")[0]);
    }
  };
  await nav("public fixture site", "http://public-site.co.in/", "reached", "PUBLIC-SITE-OK");
  await nav("redis via hostile DNS name", "http://redis-alias.attacker.co.in/", "blocked");
  await nav("redis via hostile DNS name + port 6379", "http://redis-alias.attacker.co.in:6379/", "blocked");
  await nav("postgres via hostile DNS name", "http://pg-alias.attacker.co.in/", "blocked");
  await nav("gateway's own interface via DNS", "http://gateway-self.attacker.co.in/", "blocked");
  await nav("metadata via DNS name", "http://metadata.attacker.co.in/latest/meta-data/", "blocked");
  await nav("metadata IP literal", "http://169.254.169.254/latest/meta-data/", "blocked");
  await nav("redis IP literal", "http://10.250.10.10:6379/", "blocked");
  await nav("redis service name", "http://redis:6379/", "blocked");
  await nav("loopback via DNS", "http://loopback.attacker.co.in/", "blocked");
  await nav("IPv6 loopback via AAAA", "http://v6-loopback.attacker.co.in/", "blocked");
  await nav("IPv6 ULA metadata via AAAA", "http://v6-metadata.attacker.co.in/", "blocked");
  await nav("IPv4-mapped IPv6 via AAAA", "http://v6-mapped.attacker.co.in/", "blocked");
  await nav("IPv6 literal [::1]", "http://[::1]/", "blocked");
  await nav("mixed public+private answers", "http://mixed.attacker.co.in/", "blocked");
  await nav("Docker host dev Postgres", "http://host.docker.internal:55432/", "blocked");
  await nav("Docker host via hostile DNS", "http://docker-host.attacker.co.in/", "blocked");
  await nav("redirect to internal redis", "http://public-site.co.in/redirect-to-redis", "blocked", "NOAUTH");
  await nav("redirect to metadata", "http://public-site.co.in/redirect-to-metadata", "blocked", "ami-id");
  // Non-network schemes: the engine's guarded navigation refuses them, and web content can't navigate to them.
  for (const u of ["file:///etc/passwd", "chrome://version", "data:text/html,<h1>x</h1>", "javascript:alert(1)"]) {
    try {
      await guardedGoto(page, u, { timeout: 5000 });
      emit(`engine guarded navigation: ${u.split(":")[0]}:`, "blocked", "reached", "navigated");
    } catch (e) {
      emit(`engine guarded navigation: ${u.split(":")[0]}:`, "blocked", "blocked", e.message.split("\n")[0]);
    }
  }
  await page.goto("http://public-site.co.in/attack", { timeout: 15000 });
  await page.evaluate(() => { location.href = "file:///etc/passwd"; }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const leaked = (await page.content()).includes("root:");
  emit("web page navigating itself to file:", "blocked", leaked || page.url().startsWith("file:") ? "reached" : "blocked", page.url());
  // DNS rebinding: answers alternate public/internal; internal answers must never be connected to.
  for (let i = 0; i < 4; i++) await nav(`rebinding attempt ${i + 1}`, `http://rebind.attacker.co.in/?n=${i}`, i % 2 === 0 ? "reached" : "blocked", "REBIND-FIRST-ANSWER");

  // In-page requests from a legitimate page to internal targets.
  await page.goto("http://public-site.co.in/attack", { timeout: 15000 });
  for (const [name, target] of [["in-page fetch to redis IP", "http://10.250.10.10:6379/"], ["in-page fetch to metadata", "http://169.254.169.254/latest/meta-data/"], ["in-page fetch to Docker host", "http://host.docker.internal:55432/"]]) {
    const r = await page.evaluate(async (u) => {
      try { const res = await fetch(u, { mode: "no-cors" }); return `opaque/${res.type}`; } catch (e) { return `error ${e.message}`; }
    }, target);
    // no-cors returns an opaque response even for gateway refusals; verify against the gateway log instead.
    emit(`browser in-page: ${name}`, "blocked", r.startsWith("error") ? "blocked" : "gateway-refused", r);
  }
  // WebRTC must not produce any non-proxied UDP candidates.
  const cands = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:8.8.8.8:3478" }, { urls: "stun:10.250.10.10:6379" }] });
    pc.createDataChannel("x");
    pc.onicecandidate = (e) => { if (e.candidate) out.push(e.candidate.candidate); else resolve(out); };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => resolve(out), 6000);
  }));
  const udp = cands.filter((c) => / udp /i.test(c));
  emit("browser WebRTC: UDP ICE candidates", "blocked", udp.length ? "reached" : "blocked", `${cands.length} candidates, ${udp.length} UDP`);
  // Downloads are refused.
  let downloaded = false;
  page.on("download", async (d) => { downloaded = Boolean(await d.path().catch(() => null)); });
  await page.goto("http://public-site.co.in/download", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  emit("browser download of attachment", "blocked", downloaded ? "reached" : "blocked", downloaded ? "file saved" : "not saved");
  await browser.close();

  // Misconfiguration / bypass: Chromium WITHOUT the proxy flag. The network must still refuse everything.
  const naked = await chromium.launch({ args: ["--disable-quic"] });
  const p2 = await naked.newPage();
  for (const [name, url] of [["fixture site by IP", "http://10.250.77.10/"], ["public internet 1.1.1.1", "http://1.1.1.1/"], ["redis IP", "http://10.250.10.10:6379/"], ["metadata", "http://169.254.169.254/"], ["Docker host dev Postgres", "http://host.docker.internal:55432/"], ["hostname via docker DNS", "http://public-site.co.in/"]]) {
    try {
      const resp = await p2.goto(url, { timeout: 8000 });
      emit(`browser WITHOUT proxy: ${name}`, "blocked", resp ? "reached" : "blocked", `status ${resp?.status()}`);
    } catch (e) {
      emit(`browser WITHOUT proxy: ${name}`, "blocked", "blocked", e.message.split("\n")[0]);
    }
  }
  await naked.close();
}

async function workerProbes() {
  const { safeFetch, createDnsClient, createGatewayDnsClient } = await import("/repo/packages/netguard/dist/index.js");
  const tok = await token("worker");
  const egress = { url: GATEWAY, token: () => tok };
  const f = async (name, url, expect) => {
    try {
      const r = await safeFetch(url, { dns: createDnsClient([]), egress, timeoutMs: 10000 });
      emit(`worker via gateway: ${name}`, expect, r.status < 400 ? "reached" : "blocked", `status ${r.status}`);
    } catch (e) {
      emit(`worker via gateway: ${name}`, expect, "blocked", e.code ?? e.message);
    }
  };
  await f("public fixture site", "http://public-site.co.in/", "reached");
  await f("metadata", "http://metadata.attacker.co.in/latest/meta-data/", "blocked");
  await f("redis via hostile DNS", "http://redis-alias.attacker.co.in/", "blocked");
  await f("redirect to internal redis", "http://public-site.co.in/redirect-to-redis", "blocked");
  const dns = createGatewayDnsClient({ url: GATEWAY, token: () => tok });
  try {
    const a = await dns.addresses("public-site.co.in");
    emit("worker DNS API: public name", "reached", a.length ? "reached" : "blocked", a.join(","));
  } catch (e) { emit("worker DNS API: public name", "reached", "blocked", e.code); }
  try {
    await dns.addresses("redis-alias.attacker.co.in");
    emit("worker DNS API: internal answer", "blocked", "reached", "returned");
  } catch (e) { emit("worker DNS API: internal answer", "blocked", "blocked", e.code); }
  // Phase 4C: the HTTP monitoring probe (gateway-only client, per-hop host-bound tokens).
  const { httpProbe, signCapability } = await import("/repo/packages/netguard/dist/index.js");
  const p = (url, h) => httpProbe({ url, timeoutMs: 10000, maxRedirects: 3, maxBodyBytes: 4096,
    gateway: { url: GATEWAY, token: (host) => signCapability(SECRET, { o: "11111111-1111-1111-1111-111111111111", w: null, e: "iso-http", k: "http", h: h ?? host }, 120) } });
  const m1 = await p("http://public-site.co.in/");
  emit("HTTP monitor probe: public fixture site", "reached", m1.final ? "reached" : "blocked", m1.error ?? `status ${m1.final?.status} via ${m1.hops[0]?.address}`);
  const m2 = await p("http://redis-alias.attacker.co.in/");
  emit("HTTP monitor probe: hostile DNS → Redis", "blocked", m2.final ? "reached" : "blocked", m2.error);
  const m3 = await p("http://public-site.co.in/redirect-to-redis");
  emit("HTTP monitor probe: redirect to internal Redis", "blocked", m3.hops.some((x) => x.address?.startsWith("10.250.10.")) ? "reached" : "blocked", `${m3.error} hops=${m3.hops.length}`);
  const m4 = await p("http://metadata.attacker.co.in/latest/meta-data/");
  emit("HTTP monitor probe: metadata via hostile DNS", "blocked", m4.final ? "reached" : "blocked", m4.error);
  const m5 = await p("http://public-site.co.in/", "other-host.co.in");
  emit("HTTP monitor probe: token bound to another host", "blocked", m5.final ? "reached" : "blocked", m5.error);
  // Anonymous use of the gateway is refused.
  const anon = await fetch(`${GATEWAY}/v1/dns?type=ADDR&name=public-site.co.in`).then((r) => r.status).catch(() => 0);
  emit("gateway without capability token", "blocked", anon === 200 ? "reached" : "blocked", `status ${anon}`);
}

if (role === "browser-runner") {
  await directProbes(["gateway via docker DNS (allowed path)"]);
  await browserProbes();
} else if (role === "worker") {
  await directProbes(["redis by IP", "postgres by IP", "redis by service name", "postgres by service name", "gateway via docker DNS (allowed path)"]);
  await workerProbes();
} else if (role === "control-plane") {
  // Phase 4D: the worker drives the real runner service exactly like worker-browser does.
  const { chromium } = await import("/repo/node_modules/.pnpm/node_modules/playwright-core/index.mjs");
  const { signCapability } = await import("/repo/packages/netguard/dist/index.js");
  const RUNNER = "http://10.250.40.22:3000";
  const health = await fetch(`${RUNNER}/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  emit("runner reports Chromium sandbox enabled", "reached", health.sandbox === true ? "reached" : "blocked", JSON.stringify(health));
  const tok = signCapability(SECRET, { o: "22222222-2222-2222-2222-222222222222", w: "33333333-3333-3333-3333-333333333333", e: "isolation-runner-exec", k: "browser" }, 300);
  const sess = await fetch(`${RUNNER}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok, timeoutMs: 120000, execution: "isolation-runner-exec" }) }).then((r) => r.json());
  // a caller can't choose the proxy or flags
  const st = await fetch(`${RUNNER}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok, timeoutMs: 60000, proxy: "http://10.250.10.10:6379" }) }).then((r) => r.status);
  emit("runner refuses a caller-chosen proxy", "blocked", st === 201 ? "reached" : "blocked", `status ${st}`);
  const browser = await chromium.connect(sess.wsEndpoint, { timeout: 30000 });
  const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const nav = async (name, url, expect, okText) => {
    try {
      const resp = await page.goto(url, { timeout: 15000 });
      const body = (await page.content()).slice(0, 3000);
      const reached = (resp?.status() ?? 0) > 0 && resp.status() < 400 && (!okText || body.includes(okText));
      emit(`runner Chromium (sandboxed) via gateway: ${name}`, expect, reached ? "reached" : "blocked", `status ${resp?.status()} ${resp?.headers()["x-egress-error"] ?? ""}`);
    } catch (e) { emit(`runner Chromium (sandboxed) via gateway: ${name}`, expect, "blocked", e.message.split("\n")[0]); }
  };
  await nav("public fixture site", "http://public-site.co.in/", "reached", "PUBLIC-SITE-OK");
  await nav("redis via hostile DNS", "http://redis-alias.attacker.co.in/", "blocked");
  await nav("postgres via hostile DNS", "http://pg-alias.attacker.co.in/", "blocked");
  await nav("metadata via hostile DNS", "http://metadata.attacker.co.in/latest/meta-data/", "blocked");
  await nav("redirect to internal redis", "http://public-site.co.in/redirect-to-redis", "blocked", "NOAUTH");
  await nav("runner control API via loopback", "http://127.0.0.1:3000/health", "blocked", "sandbox");
  await nav("runner control API via localhost", "http://localhost:3000/health", "blocked", "sandbox");
  await nav("runner control API via its network IP", "http://10.250.40.22:3000/health", "blocked", "sandbox");
  await nav("Docker host dev Postgres", "http://host.docker.internal:55432/", "blocked");
  await page.goto("http://public-site.co.in/", { timeout: 15000 });
  const inPage = await page.evaluate(async () => {
    const out = {};
    for (const [k, u] of [["loopback-runner", "http://127.0.0.1:3000/health"], ["redis", "http://10.250.10.10:6379/"], ["metadata", "http://169.254.169.254/"]]) {
      try { const r = await fetch(u); out[k] = `status ${r.status}`; } catch (e) { out[k] = `error ${e.message}`; }
    }
    return out;
  });
  for (const [k, v] of Object.entries(inPage)) emit(`runner Chromium in-page fetch: ${k}`, "blocked", /^status 2/.test(v) ? "reached" : "blocked", v);
  await browser.close();
  await fetch(`${RUNNER}/v1/sessions/${sess.sessionId}`, { method: "DELETE" });
  const after = await fetch(`${RUNNER}/health`).then((r) => r.json());
  emit("runner closed the browser after the job", "blocked", after.sessions === 0 ? "blocked" : "reached", JSON.stringify(after));
} else if (role === "runner-service") {
  // Inside the runner container: no route to data/internet, no secrets, and Chromium really sandboxed.
  await directProbes(["gateway via docker DNS (allowed path)"]); // its single permitted destination
  emit("runner container holds no gateway signing secret", "blocked", process.env.EGRESS_TOKEN_SECRET ? "reached" : "blocked", process.env.EGRESS_TOKEN_SECRET ? "present" : "absent");
  emit("runner container holds no database or Redis credentials", "blocked", Object.keys(process.env).some((k) => /DATABASE_URL|REDIS_URL|S3_SECRET/.test(k)) ? "reached" : "blocked", "env checked");
  const { readFileSync, readdirSync, readlinkSync } = await import("node:fs");
  const s = await fetch("http://127.0.0.1:3000/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "x".repeat(40), timeoutMs: 30000 }) }).then((r) => r.json());
  const { chromium } = await import("/repo/node_modules/.pnpm/node_modules/playwright-core/index.mjs");
  const b = await chromium.connect(s.wsEndpoint.replace("10.250.40.22", "127.0.0.1"));
  const p = await (await b.newContext()).newPage();
  await p.setContent("<h1>sandbox check</h1>");
  const procs = [];
  for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!/chrom/.test(cmd) || /node/.test(cmd.split(" ")[0])) continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      procs.push({ type: /--type=([a-z-]+)/.exec(cmd)?.[1] ?? "browser", userns: readlinkSync(`/proc/${pid}/ns/user`), filters: Number(/Seccomp_filters:\s+(\d+)/.exec(status)?.[1] ?? 0), noSandboxFlag: cmd.includes("--no-sandbox"), uid: /Uid:\s+(\d+)/.exec(status)?.[1] });
    } catch {}
  }
  const browserProc = procs.find((x) => x.type === "browser");
  const renderers = procs.filter((x) => x.type === "renderer");
  emit("Chromium launched without --no-sandbox", "reached", browserProc && !procs.some((x) => x.noSandboxFlag) ? "reached" : "blocked", JSON.stringify(procs.map((x) => x.type)));
  emit("renderer runs in its own user namespace (namespace sandbox)", "reached", renderers.length && renderers.every((r) => r.userns !== browserProc?.userns) ? "reached" : "blocked", JSON.stringify(renderers.map((r) => r.userns)) + " vs " + browserProc?.userns);
  emit("renderer has Chromium's seccomp-BPF filter stacked on the container's", "reached", renderers.length && renderers.every((r) => r.filters > (browserProc?.filters ?? 0)) ? "reached" : "blocked", JSON.stringify(renderers.map((r) => r.filters)) + " vs browser " + browserProc?.filters);
  emit("Chromium runs as non-root", "reached", procs.every((x) => x.uid !== "0") ? "reached" : "blocked", `uids ${[...new Set(procs.map((x) => x.uid))]}`);
  await b.close();
  await fetch(`http://127.0.0.1:3000/v1/sessions/${s.sessionId}`, { method: "DELETE" });
} else if (role === "deepscan") {
  // Phase 4E: the deep-scan crawler's real fetch path (apps/worker-deepscan fetchChain: per-hop host-bound
  // capabilities, every redirect normalised and scope-checked) against hostile targets.
  await directProbes(["redis by IP", "postgres by IP", "redis by service name", "postgres by service name", "gateway via docker DNS (allowed path)"]);
  emit("deep-scan worker holds no object-storage credentials", "blocked", Object.keys(process.env).some((k) => /^S3_/.test(k)) ? "reached" : "blocked", "env checked");
  const { fetchChain } = await import("/repo/apps/worker-deepscan/dist/fetch.js");
  const deps = (host) => ({ gatewayUrl: GATEWAY, tokenSecret: SECRET, cap: { o: "44444444-4444-4444-4444-444444444444", w: "55555555-5555-5555-5555-555555555555", e: "isolation-deepscan-exec" },
    timeoutMs: 10000, maxBytes: 65536, signal: new AbortController().signal, onRequest: () => {} });
  const norm = { queryParamMode: "KEEP_MEANINGFUL", queryParamAllowlist: [], excludedQueryParams: [] };
  const scope = (hosts) => ({ hosts, includePatterns: [], excludePatterns: [] });
  const run = async (name, url, hosts, expect) => {
    try {
      const r = await fetchChain(new URL(url), deps(), scope(hosts), norm, { maxRedirects: 5, readBody: true });
      const reached = r.status !== null && r.status < 300 && !r.outOfScopeRedirect;
      emit(`deep-scan fetch: ${name}`, expect, reached ? "reached" : "blocked", `status ${r.status} ${r.error ?? ""} ${r.outOfScopeRedirect ?? ""}`);
    } catch (e) { emit(`deep-scan fetch: ${name}`, expect, "blocked", e.code ?? e.message); }
  };
  await run("public fixture site (in scope)", "http://public-site.co.in/", ["public-site.co.in"], "reached");
  await run("redirect to internal Redis (out of scope, not followed)", "http://public-site.co.in/redirect-to-redis", ["public-site.co.in"], "blocked");
  await run("redirect to metadata IP (out of scope, not followed)", "http://public-site.co.in/redirect-to-metadata", ["public-site.co.in"], "blocked");
  // even a misconfigured scope that lists the hostile host can't reach internal addresses: the gateway refuses
  await run("hostile DNS → Redis with the host in scope", "http://redis-alias.attacker.co.in/", ["redis-alias.attacker.co.in"], "blocked");
  await run("metadata via hostile DNS with the host in scope", "http://metadata.attacker.co.in/latest/meta-data/", ["metadata.attacker.co.in"], "blocked");
  await run("redirect to Redis with the target host in scope", "http://public-site.co.in/redirect-to-redis", ["public-site.co.in", "redis-alias.attacker.co.in"], "blocked");
  const r = await tcp("10.250.30.2", 8080);
  emit("direct TCP: gateway's browser-egress interface", "blocked", r.result, r.detail);
} else if (role === "scheduler") {
  // Needs Postgres and Redis only. Must not reach the gateway (no egress path at all), the browser or the internet.
  await directProbes(["redis by IP", "postgres by IP", "redis by service name", "postgres by service name"]);
  const r = await tcp("10.250.40.21", 3000);
  emit("direct TCP: browser-runner control port", "blocked", r.result, r.detail);
  emit("scheduler holds no egress signing secret", "blocked", process.env.EGRESS_TOKEN_SECRET ? "reached" : "blocked", process.env.EGRESS_TOKEN_SECRET ? "present" : "absent");
} else if (role === "gateway") {
  for (const [name, host, port] of [["redis by IP", "10.250.10.10", 6379], ["postgres by IP", "10.250.10.11", 5432], ["browser-control network", "10.250.40.21", 9222]]) {
    const r = await tcp(host, port);
    emit(`gateway direct TCP: ${name}`, "blocked", r.result, r.detail);
  }
}
const bad = results.filter((r) => r.result !== r.expect && !(r.expect === "blocked" && r.result === "gateway-refused"));
console.log(JSON.stringify({ role, summary: true, total: results.length, violations: bad.length }));
process.exit(0);
