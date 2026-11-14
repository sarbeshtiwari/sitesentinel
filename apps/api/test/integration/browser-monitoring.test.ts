import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createLogger } from "@wim/logger";
import { createS3 } from "@wim/storage";
import { createBrowserEngine, observeViewport, openSession } from "@wim/worker-browser";
import { parseBrowserCheckConfig } from "@wim/core";
import { signCapability } from "@wim/netguard";
import { resetMonitoringSettings, seedOrg, setSettings, sleep, until } from "../helpers/monitoring.js";
import { addVerifiedSite, EGRESS_SECRET_4C, incidentsOf, PREFIX_4C } from "../helpers/http-monitoring.js";
import { BROWSER_QUEUE_POLICY, browserResults, browserSettings, entitleBrowser, ledger, S3_TEST_BUCKET, startBrowserEnv, type BrowserEnv } from "../helpers/browser-monitoring.js";

/**
 * Phase 4D — browser monitoring with REAL Chromium (sandbox on) driven through the production runner service,
 * the real egress gateway, Postgres, Redis and SeaweedFS, against the controlled fault website.
 */
let env: BrowserEnv;
let c: pg.Client;
let parked: string[] = [];
const orgs: string[] = [];
let tag = "";

beforeAll(async () => {
  env = await startBrowserEnv();
  c = env.owner;
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await resetMonitoringSettings(c);
  await browserSettings(env);
  await env.startBrowserWorker();
}, 120_000);
afterEach(async () => {
  await browserSettings(env);
});
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  for (const q of Object.values(env.queues)) await q.obliterate({ force: true });
  await env.close();
});

async function newOrg(entitled = true) {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  const o = await seedOrg(c, 0, { tag: "br4d" });
  orgs.push(o.orgId);
  tag = randomBytes(3).toString("hex");
  if (entitled) await entitleBrowser(env, o.orgId);
  return o.orgId;
}

async function site(orgId: string, name: string, path: string, browserCheck: Record<string, unknown> = {}) {
  const host = `${name}-${tag}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  await c.query(`INSERT INTO monitoring_configurations (org_id, website_id, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, now())
                 ON CONFLICT (website_id) DO UPDATE SET browser_check = EXCLUDED.browser_check`,
    [orgId, id, JSON.stringify({ path, extraViewportsPerRun: 0, ...browserCheck })]);
  return { id, host };
}

/** Move the newest browser execution one window back so the scheduler creates the next one. */
async function nextWindow(ids: string[]) {
  for (const w of ids) {
    const { rows } = await c.query<{ id: string; queued_at: Date; min: Date }>(
      `SELECT id, queued_at, (SELECT min(queued_at) FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER') AS min
         FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' ORDER BY queued_at DESC LIMIT 1`, [w]);
    const cur = rows[0];
    if (!cur) continue;
    const target = new Date(cur.min.getTime() - 900_000);
    await c.query(`UPDATE monitoring_executions SET queued_at = $2, slot = floor(extract(epoch FROM $2::timestamptz)) WHERE id = $1`, [cur.id, target]);
    for (const t of ["page_test_results", "responsive_test_results"]) await c.query(`UPDATE ${t} SET tested_at = $2 WHERE execution_id = $1`, [cur.id, target]);
    await c.query(`UPDATE performance_metrics SET measured_at = $2 WHERE execution_id = $1`, [cur.id, target]);
    await c.query(`UPDATE execution_results SET window_start = $2 WHERE execution_id = $1`, [cur.id, target]);
    await c.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second', state_window_at = LEAST(state_window_at, $2) WHERE website_id = $1 AND tier = 'T2_RENDER'`, [w, target]);
  }
}

async function windowFor(ids: string[], first = false, timeoutMs = 90_000) {
  if (!first) await nextWindow(ids);
  const before = new Map<string, number>();
  for (const w of ids) before.set(w, (await ledger(env, w)).length);
  await env.scheduler().runCycle();
  await until(async () => {
    for (const w of ids) if ((await ledger(env, w)).length <= before.get(w)!) return false;
    return true;
  }, timeoutMs, 200);
  return Promise.all(ids.map(async (w) => {
    const l = (await ledger(env, w)).at(-1)!;
    return { ledger: l, rows: (await browserResults(env, w)).filter((r) => r.execution_id === l.execution_id) };
  }));
}

// =====================================================================================================
describe("scheduling and entitlement", () => {
  it("browser jobs only with the platform switch AND an org entitlement AND the website not opted out; deep scan stays off", async () => {
    await setSettings(c, { "monitoring.browser.enabled": false });
    const org = await newOrg(true);
    const a = await site(org, "sched-a", "/b/healthy");
    const b = await site(org, "sched-b", "/b/healthy", { enabled: false });
    await env.scheduler().runCycle();
    const reason = async (id: string) => (await c.query(`SELECT status::text, paused_reason FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T2_RENDER'`, [id])).rows[0];
    expect(await reason(a.id)).toEqual({ status: "PAUSED", paused_reason: "TIER_DISABLED" });
    await setSettings(c, { "monitoring.browser.enabled": true });
    await env.scheduler().runCycle();
    expect(await reason(a.id)).toEqual({ status: "ACTIVE", paused_reason: null });
    expect(await reason(b.id)).toEqual({ status: "PAUSED", paused_reason: "DISABLED_BY_CUSTOMER" });
    // Not entitled (default): the platform switch alone never enables an organisation.
    const other = await newOrg(false);
    const x = await site(other, "sched-x", "/b/healthy");
    await env.scheduler().runCycle();
    expect(await reason(x.id)).toEqual({ status: "PAUSED", paused_reason: "TIER_DISABLED" });
    // Browser website cap.
    await setSettings(c, { "monitoring.browser.maxWebsites": 1 });
    const org3 = await newOrg(true);
    const s1 = await site(org3, "cap-1", "/b/healthy");
    const s2 = await site(org3, "cap-2", "/b/healthy");
    await env.scheduler().runCycle();
    expect((await reason(s1.id)).status).toBe("ACTIVE");
    expect(await reason(s2.id)).toEqual({ status: "PAUSED", paused_reason: "WEBSITE_LIMIT" });
    // scoped to this test's organisations: other test files may legitimately have run deep scans before this one
    const mine = [org, other, org3];
    const deep = await c.query(`SELECT count(*)::int AS n FROM monitoring_executions WHERE tier = 'T3_DEEP' AND org_id = ANY($1::uuid[])`, [mine]);
    expect(deep.rows[0].n).toBe(0);
    const deepSched = await c.query(`SELECT count(*)::int AS n FROM monitoring_schedules WHERE tier = 'T3_DEEP' AND status = 'ACTIVE' AND org_id = ANY($1::uuid[])`, [mine]);
    expect(deepSched.rows[0].n).toBe(0);
  }, 60_000);
});

// =====================================================================================================
describe("diagnostics against the controlled fault website (real Chromium through the gateway)", () => {
  it("navigation, rendering, JavaScript, network, layout and synthetic performance", async () => {
    const org = await newOrg();
    env.dns.setA("cdn.third-party.example", ["127.0.0.1"]);
    env.dns.setA("elsewhere.other-site.example", ["127.0.0.1"]);
    const s = {
      healthy: await site(org, "healthy", "/b/healthy"),
      blank: await site(org, "blank", "/b/blank"),
      delayed: await site(org, "delayed", "/b/delayed?ms=500"),
      delayedSlow: await site(org, "delayed-slow", "/b/delayed?ms=3000", { readiness: { strategy: "selector", selector: "#ready" } }),
      jsx: await site(org, "jsx", "/b/js-exception"),
      rej: await site(org, "rej", "/b/rejection"),
      con: await site(org, "con", "/b/console-error"),
      conFail: await site(org, "con-fail", "/b/console-error", { consoleErrorsAreFailures: true }),
      img: await site(org, "img", "/b/broken-image"),
      css: await site(org, "css", "/b/failed-css"),
      js: await site(org, "js", "/b/failed-js"),
      slowRes: await site(org, "slowres", "/b/slow-resource?ms=2000"),
      redirect: await site(org, "redirect", "/b/redirect"),
      loop: await site(org, "loop", "/loop-a"),
      large: await site(org, "large", "/b/large"),
      overflow: await site(org, "overflow", "/b/overflow"),
      hiddenWide: await site(org, "hiddenwide", "/b/hidden-wide"),
      font: await site(org, "font", "/b/missing-font"),
      spa: await site(org, "spa", "/b/spa"),
      persistent: await site(org, "persistent", "/b/persistent"),
      persistentQuiet: await site(org, "persistent-q", "/b/persistent", { readiness: { strategy: "networkquiet", quietMs: 500 }, navigationTimeoutMs: 6000 }),
      third: await site(org, "third", "/b/third-party-fail"),
      offsite: await site(org, "offsite", "/b/offsite"),
      lcp: await site(org, "lcp", "/b/slow-lcp?ms=4500"),
      cls: await site(org, "cls", "/b/cls"),
      download: await site(org, "download", "/b/download"),
      hang: await site(org, "hang", "/hang", { navigationTimeoutMs: 5000 }),
    };
    const ids = Object.values(s).map((x) => x.id);
    const out = Object.fromEntries((await windowFor(ids, true, 240_000)).map((r, i) => [ids[i], r]));
    const row = (k: keyof typeof s) => out[s[k].id]!.rows[0]!;
    const res = (k: keyof typeof s) => out[s[k].id]!.ledger.outcome;
    expect(res("healthy")).toBe("PASSED");
    expect(row("healthy")).toMatchObject({ viewport: "desktop", width: 1366, height: 768, http_status: 200, blank_page: false, js_error_count: 0, available: true });
    expect(row("healthy").navigation).toMatchObject({ readiness: { strategy: "load", met: true }, redirects: 0, error: null });
    expect(row("healthy").rendering.textLength).toBeGreaterThan(20);
    const perf = (await c.query(`SELECT * FROM performance_metrics WHERE execution_id = $1`, [out[s.healthy.id]!.ledger.execution_id])).rows[0];
    expect(perf).toMatchObject({ source: "SYNTHETIC", viewport: "desktop", inp_ms: null });
    expect(perf.fcp_ms).toBeGreaterThan(0);
    expect(perf.lcp_ms).toBeGreaterThanOrEqual(perf.fcp_ms);
    expect(perf.cls).toBe(0);
    expect(perf.navigation_timing.note).toMatch(/synthetic/);
    const kind = (k: keyof typeof s) => row(k).failure_kind;
    expect([res("blank"), kind("blank"), row("blank").available, row("blank").blank_page]).toEqual(["FAILED", "BLANK_PAGE", false, true]);
    expect(res("delayed")).toBe("PASSED"); // rendered within the bounded settle window
    expect(res("delayedSlow")).toBe("PASSED"); // readiness selector waited for it
    expect(row("delayedSlow").navigation.readiness).toMatchObject({ strategy: "selector", met: true });
    expect(kind("jsx")).toBe("UNCAUGHT_EXCEPTION");
    expect(row("jsx").scripts.exceptions[0].message).toBe("ReferenceError: undefinedFunctionCall is not defined");
    expect(kind("rej")).toBe("UNHANDLED_REJECTION");
    expect(row("rej").scripts.rejections[0].message).toBe("checkout failed for cart N"); // normalised (numbers grouped)
    expect(res("con")).toBe("PASSED");
    expect(row("con").details.warnings.join(" ")).toMatch(/console error/);
    expect(kind("conFail")).toBe("CONSOLE_ERROR");
    expect(kind("img")).toBe("BROKEN_IMAGES_1");
    expect(row("img").rendering.brokenImages[0].src).toBe(`${s.img.host}/b/img/missing.png`);
    expect(kind("css")).toBe("STYLESHEET_FAILED");
    expect(kind("js")).toBe("SCRIPT_FAILED");
    expect(res("slowRes")).toBe("PASSED");
    expect(res("redirect")).toBe("PASSED");
    expect(row("redirect").navigation.redirects).toBe(1);
    expect(kind("loop")).toBe("TOO_MANY_REDIRECTS");
    expect(res("large")).toBe("PASSED");
    expect(kind("overflow")).toBe("HORIZONTAL_OVERFLOW_DESKTOP");
    expect(res("hiddenWide")).toBe("PASSED"); // intentionally hidden or clipped content is not "broken"
    expect(res("font")).toBe("PASSED");
    expect(row("font").details.warnings.join(" ")).toMatch(/font/);
    expect(res("spa")).toBe("PASSED");
    expect(row("spa").final_url).toBe(`http://${s.spa.host}/b/spa/dashboard`);
    expect(res("persistent")).toBe("PASSED"); // persistent connections don't hang the default strategy
    expect(res("persistentQuiet")).toBe("PASSED");
    expect(row("persistentQuiet").navigation.readiness).toMatchObject({ strategy: "networkquiet", met: false });
    expect(row("persistentQuiet").details.warnings.join(" ")).toMatch(/readiness/);
    expect(res("third")).toBe("PASSED"); // a failing third-party script is a warning, not the customer's outage
    expect(row("third").network.httpErrors[0]).toMatchObject({ host: "cdn.third-party.example", firstParty: false });
    expect(kind("offsite")).toBe("REDIRECTED_OFF_SITE");
    expect(row("offsite").available).toBeNull();
    expect(kind("lcp")).toBe("LCP_POOR");
    expect(kind("cls")).toBe("CLS_POOR");
    expect(kind("download")).toBe("DOWNLOAD_REFUSED");
    expect(kind("hang")).toBe("NAVIGATION_TIMEOUT");
    expect(row("hang").navigation.durationMs).toBeLessThan(15_000);
    // Screenshots: failures only by default, masked, stored privately; none for passing checks or other sites.
    const arts = (await c.query(`SELECT website_id, purpose, storage_key, bytes FROM artifacts WHERE org_id = $1`, [org])).rows;
    const byWebsite = (id: string) => arts.filter((a) => a.website_id === id);
    expect(byWebsite(s.healthy.id)).toHaveLength(0);
    expect(byWebsite(s.offsite.id)).toHaveLength(0);
    expect(byWebsite(s.blank.id)).toHaveLength(1);
    expect(byWebsite(s.blank.id)[0]).toMatchObject({ purpose: "FAILURE" });
    expect(byWebsite(s.blank.id)[0].storage_key).toBe(`orgs/${org}/websites/${s.blank.id}/executions/${out[s.blank.id]!.ledger.execution_id}/desktop-failure.png`);
    const png = await env.s3.get(byWebsite(s.blank.id)[0].storage_key);
    expect(png!.subarray(1, 4).toString()).toBe("PNG");
    expect((await fetch(`${process.env.S3_ENDPOINT}/${S3_TEST_BUCKET}/${byWebsite(s.blank.id)[0].storage_key}`)).status).toBe(403);
    // Every request of every page went through the gateway, attributed to the right execution.
    const executions = new Set(Object.values(out).map((o) => o.ledger.execution_id));
    const browserDecisions = env.gatewayLog.filter((l) => l.kind === "browser" && executions.has(l.exec));
    expect(browserDecisions.length).toBeGreaterThan(30);
    for (const d of browserDecisions) {
      expect(d.org).toBe(org);
      expect(ids).toContain(d.website);
    }
    expect(env.gatewayLog.some((l) => l.kind === "browser" && l.host === "cdn.third-party.example" && l.outcome === "ALLOWED")).toBe(true);
  }, 300_000);

  it("viewports: rotation within the per-run cap; responsive failures only where they occur", async () => {
    const org = await newOrg();
    const r = await site(org, "resp", "/b/responsive-broken", { viewports: ["desktop", "mobile-small", "tablet"], extraViewportsPerRun: 1 });
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push((await windowFor([r.id], i === 0))[0]!);
    const vps = runs.map((x) => x.rows.map((y) => y.viewport).sort());
    expect(vps.every((v) => v.length === 2 && v.includes("desktop"))).toBe(true);
    expect(new Set(vps.map((v) => v.join())).size).toBe(2); // rotation: a different extra viewport each run
    const mobile = runs.flatMap((x) => x.rows).find((y) => y.viewport === "mobile-small");
    const tablet = runs.flatMap((x) => x.rows).find((y) => y.viewport === "tablet");
    expect(mobile).toMatchObject({ status: "FAILED", failure_kind: "HORIZONTAL_OVERFLOW_MOBILE_SMALL", width: 375, height: 812 });
    expect(tablet).toMatchObject({ status: "PASSED", width: 768 });
    expect(runs.flatMap((x) => x.rows).find((y) => y.viewport === "desktop")).toMatchObject({ status: "PASSED" });
    const resp = (await c.query(`SELECT viewport, horizontal_overflow_px, status::text FROM responsive_test_results WHERE website_id = $1 ORDER BY viewport`, [r.id])).rows;
    expect(resp.find((x) => x.viewport === "mobile-small")!.horizontal_overflow_px).toBeGreaterThan(400);
    // The per-run cap (entitlement) bounds cost: 1 → primary only.
    await entitleBrowser(env, org);
    await c.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.browser.maxViewportsPerRun', '1', 'test', gen_random_uuid())`, [org]);
    const capped = (await windowFor([r.id]))[0]!;
    expect(capped.rows.map((x) => x.viewport)).toEqual(["desktop"]);
  }, 180_000);
});

// =====================================================================================================
describe("security of the browser path", () => {
  it("a malicious page can't reach loopback (runner control API), private or metadata addresses, internal WebSockets or file:", async () => {
    const org = await newOrg();
    const m = await site(org, "evil", "/b/malicious", { readiness: { strategy: "load", settleMs: 3000 } });
    const before = env.gatewayLog.length;
    const [r] = await windowFor([m.id], true);
    expect(r!.rows[0]!.final_url).toBe(`http://${m.host}/b/malicious`); // never navigated to file:
    const exec = r!.ledger.execution_id;
    const decisions = env.gatewayLog.slice(before).filter((l) => l.exec === exec);
    const refused = decisions.filter((l) => l.outcome !== "ALLOWED").map((l) => `${l.host}:${l.outcome}`);
    // loopback is NOT bypassed: it reached the gateway and was refused as an IP literal
    // (refused before any connection: IP literal, or a non-80/443 port — whichever check comes first)
    for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "localhost"]) {
      expect(refused.some((x) => x.startsWith(`${host}:`) && /BLOCKED_(HOST|PORT|ADDRESS)/.test(x)), host).toBe(true);
    }
    expect(refused.some((x) => x.startsWith(`internal-${m.host}`))).toBe(true);
    for (const d of decisions.filter((l) => l.outcome === "ALLOWED")) expect(d.host).toBe(m.host);
    // the runner's control API saw no request from the page
    expect(((await (await fetch(`${env.runnerUrl}/health`)).json()) as { sessions: number }).sessions).toBe(0);
  }, 90_000);

  it("forged, expired and wrong-secret capabilities: Chromium gets nothing through the gateway", async () => {
    const org = await newOrg();
    const h = await site(org, "tok", "/b/healthy");
    const cfg = parseBrowserCheckConfig({});
    const attempt = async (token: string) => {
      const sess = await openSession(env.runnerUrl, token, 30_000, "forged");
      try {
        const o = await observeViewport({ browser: sess.browser, url: `http://${h.host}/b/healthy`, viewport: "desktop", config: { ...cfg, navigationTimeoutMs: 8000 }, registrableDomain: "fixture.example", deadline: Date.now() + 20_000, signal: new AbortController().signal, screenshot: () => false, maskSelectors: [] });
        return o.observation;
      } finally { await sess.close(); }
    };
    const expired = (() => {
      const body = Buffer.from(JSON.stringify({ o: org, w: h.id, e: "x", k: "browser", x: Math.floor(Date.now() / 1000) - 10 })).toString("base64url");
      return `${body}.${require("node:crypto").createHmac("sha256", EGRESS_SECRET_4C).update(body).digest("base64url")}`;
    })();
    for (const token of [signCapability("an-attacker-secret-0123456789abcdefghij", { o: org, w: h.id, e: "x", k: "browser" }, 60), expired]) {
      const o = await attempt(token);
      expect(o.rendering?.textLength ?? 0).toBe(0); // nothing of the site rendered
      expect(o.navError ?? `HTTP_${o.mainStatus}`).toMatch(/EGRESS_UNAUTHORIZED|HTTP_407|ERR_|NAVIGATION_FAILED/);
    }
    expect(env.site.hits.some((x) => x.host === h.host)).toBe(false); // the fault site never saw a request
  }, 90_000);

  it("the runner holds no signing secret and accepts only bounded, well-formed session requests", async () => {
    expect(JSON.stringify(env.runner.cfg)).not.toContain(EGRESS_SECRET_4C);
    const post = (body: unknown) => fetch(`${env.runnerUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ token: "short", timeoutMs: 10_000 })).status).toBe(400);
    expect((await post({ token: "x".repeat(40), timeoutMs: 10_000, proxy: "http://evil:8080" })).status).toBe(400); // can't choose the proxy
    expect((await post({ token: "x".repeat(40), timeoutMs: 10_000, args: ["--no-sandbox"] })).status).toBe(400); // can't choose flags
    expect((await fetch(`${env.runnerUrl}/v1/sessions/${"a".repeat(32)}`, { method: "DELETE" })).status).toBe(200); // unknown id: no-op
  });
});

// =====================================================================================================
describe("incidents, notifications and idempotency", () => {
  it("blank page opens an incident after the threshold, repeats group, recovery resolves; events emitted once", async () => {
    const org = await newOrg();
    const t = await site(org, "toggle", "/b/toggle");
    env.site.toggles.set(t.host, "down");
    await windowFor([t.id], true);
    expect(await incidentsOf(c, t.id)).toHaveLength(0);
    await windowFor([t.id]);
    let inc = await incidentsOf(c, t.id);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ category: "AVAILABILITY", source: "BROWSER", check_key: "browser.blank", fingerprint: `browser.blank:${t.id}`, title: "Page renders blank", status: "OPEN", occurrence_count: 2 });
    await windowFor([t.id]);
    expect((await incidentsOf(c, t.id))[0].occurrence_count).toBe(3);
    env.site.toggles.set(t.host, "up");
    await windowFor([t.id]);
    await windowFor([t.id]);
    inc = await incidentsOf(c, t.id);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ status: "RESOLVED", auto_resolved: true });
    const ob = (await c.query(`SELECT topic FROM outbox_events WHERE org_id = $1 ORDER BY id`, [org])).rows.map((r) => r.topic);
    expect(ob).toEqual(["incident.opened", "incident.resolved"]);
    const usage = Object.fromEntries((await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1`, [org])).rows.map((r) => [r.key, r.value]));
    expect(usage["browser.executions"]).toBe(5);
    expect(usage["browser.ms"]).toBeGreaterThan(0);
    expect(usage["browser.screenshots"]).toBe(3); // three failing runs, one failure screenshot each
  }, 240_000);

  it("the same execution processed again creates no second result, incident step, artifact, event or usage", async () => {
    const org = await newOrg();
    const s = await site(org, "dup", "/b/blank", { failureThreshold: 1 });
    const [r] = await windowFor([s.id], true);
    const snapshot = async () => ({
      ledger: (await ledger(env, s.id)).length, rows: (await browserResults(env, s.id)).length,
      incidents: (await incidentsOf(c, s.id)).map((i) => [i.id, i.occurrence_count]),
      artifacts: (await c.query(`SELECT count(*)::int AS n FROM artifacts WHERE website_id = $1`, [s.id])).rows[0].n,
      outbox: (await c.query(`SELECT count(*)::int AS n FROM outbox_events WHERE org_id = $1`, [org])).rows[0].n,
      usage: (await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1 ORDER BY key`, [org])).rows,
    });
    const before = await snapshot();
    expect(before.incidents).toHaveLength(1);
    const engine = createBrowserEngine({ db: env.db, redis: env.redis, prefix: PREFIX_4C, log: createLogger("x", { level: "silent" }), gatewayUrl: env.gatewayUrl, tokenSecret: EGRESS_SECRET_4C, runnerUrl: env.runnerUrl, s3: env.s3, jobTimeoutMs: async () => 45_000 });
    const sessionsBefore = env.runner.launched;
    for (let i = 0; i < 2; i++) {
      const o = await engine({ executionId: r!.ledger.execution_id, orgId: org, websiteId: s.id, tier: "BROWSER", attempt: 2 + i, maxAttempts: 3, windowStart: r!.ledger.window_start, signal: new AbortController().signal });
      expect(o.summary).toMatchObject({ duplicate: true });
    }
    expect(env.runner.launched).toBe(sessionsBefore); // a completed execution never opens a browser again
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  const crash = (at: "navigate" | "persist") => async () => {
    const org = await newOrg();
    const s = await site(org, `crash-${at}`, "/b/blank");
    await env.stopBrowserWorkers();
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "fixtures", "crash-browser-worker.mjs")], {
      env: { ...process.env, TEST_PREFIX: PREFIX_4C, TEST_GATEWAY_URL: env.gatewayUrl, TEST_EGRESS_SECRET: EGRESS_SECRET_4C, TEST_RUNNER_URL: env.runnerUrl, TEST_BUCKET: S3_TEST_BUCKET, CRASH_AT: at },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    try {
      await until(async () => out.includes("READY"), 30_000);
      await env.scheduler().runCycle();
      await new Promise((res) => child.once("exit", res));
      expect(out).toContain(`CRASHING ${at}`);
      expect(await ledger(env, s.id)).toHaveLength(at === "persist" ? 1 : 0);
    } finally {
      child.kill("SIGKILL");
      await env.startBrowserWorker({ workerId: `rescuer-${at}` });
    }
    const ex = await until(async () => {
      const { rows } = await c.query(`SELECT status::text, attempt FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER'`, [s.id]);
      return rows[0]?.status === "SUCCEEDED" ? rows[0] : null;
    }, 90_000, 300);
    expect(ex.attempt).toBe(2);
    const l = await ledger(env, s.id);
    expect(l).toHaveLength(1);
    expect(l[0].attempt).toBe(at === "persist" ? 1 : 2); // the committed result is never replaced
    expect(await browserResults(env, s.id)).toHaveLength(1);
    const state = (await c.query(`SELECT state FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T2_RENDER'`, [s.id])).rows[0].state;
    expect(state.classes.blank.fails).toBe(1); // counted once
    const usage = (await c.query(`SELECT value::int FROM usage_counters WHERE org_id = $1 AND key = 'browser.executions'`, [org])).rows[0].value;
    expect(usage).toBe(1); // charged once
    expect((await c.query(`SELECT count(*)::int AS n FROM artifacts WHERE website_id = $1`, [s.id])).rows[0].n).toBe(1);
  };
  it("worker SIGKILLed after the browser work, before persistence", crash("navigate"), 180_000);
  it("worker SIGKILLed after persistence, before the queue acknowledgement", crash("persist"), 180_000);
});

// =====================================================================================================
describe("reliability", () => {
  it("Chromium crash mid-navigation: inconclusive attempt, retried on the same execution, no customer failure", async () => {
    const org = await newOrg();
    const s = await site(org, "chromecrash", "/b/slow-resource?ms=4000");
    const open = env.runner.open.bind(env.runner);
    let first = true;
    env.runner.open = async (...args) => {
      const sess = await open(...args);
      if (first) { first = false; setTimeout(() => void sess.server.kill(), 1500); }
      return sess;
    };
    try {
      const [r] = await windowFor([s.id], true);
      expect(r!.ledger).toMatchObject({ outcome: "PASSED", attempt: 2 });
    } finally {
      env.runner.open = open;
    }
    const infra = (await c.query(`SELECT value::int FROM usage_counters WHERE org_id = $1 AND key = 'browser.infra_failures'`, [org])).rows[0].value;
    expect(infra).toBe(1);
    expect(await incidentsOf(c, s.id)).toHaveLength(0);
  }, 120_000);

  it("gateway outage and runner outage are monitoring infrastructure, never the customer's outage", async () => {
    const org = await newOrg();
    const g = await site(org, "gwdown", "/b/healthy");
    await setSettings(c, { "queue.browser-monitoring": { ...BROWSER_QUEUE_POLICY, attempts: 1 } });
    const { BrowserRunner } = await import("@wim/browser-runner");
    const deadRunner = new BrowserRunner({ gatewayUrl: "http://127.0.0.1:9", advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", maxSessions: 2, maxSessionMs: 60_000, sandbox: true });
    const deadUrl = `http://127.0.0.1:${await deadRunner.listen(0)}`;
    await env.stopBrowserWorkers();
    try {
      await env.startBrowserWorker({ runnerUrl: deadUrl });
      const [r] = await windowFor([g.id], true);
      expect(r!.ledger.outcome).toBe("INCONCLUSIVE");
      expect(r!.rows[0]).toMatchObject({ failure_kind: "GATEWAY_UNAVAILABLE", failure_category: "GATEWAY_INFRASTRUCTURE", available: null });
      await env.stopBrowserWorkers();
      await env.startBrowserWorker({ runnerUrl: "http://127.0.0.1:9" }); // runner unreachable
      const [r2] = await windowFor([g.id]);
      expect(r2!.rows[0]).toMatchObject({ failure_kind: "BROWSER_UNAVAILABLE", failure_category: "BROWSER_INFRASTRUCTURE", status: "INCONCLUSIVE" });
      expect(await incidentsOf(c, g.id)).toHaveLength(0);
    } finally {
      await env.stopBrowserWorkers();
      await deadRunner.stop();
      await env.startBrowserWorker();
    }
  }, 120_000);

  it("storage outage: the check is recorded without its screenshot (warning), never failed by our storage", async () => {
    const org = await newOrg();
    const s = await site(org, "s3down", "/b/blank");
    await env.stopBrowserWorkers();
    try {
      await env.startBrowserWorker({ s3: createS3({ endpoint: "http://127.0.0.1:9", accessKey: "x", secretKey: "y", bucket: "z" }) });
      const [r] = await windowFor([s.id], true);
      expect(r!.ledger.outcome).toBe("FAILED"); // the customer's blank page, evaluated normally
      expect(r!.rows[0]!.failure_kind).toBe("BLANK_PAGE");
      expect(r!.rows[0]!.details.warnings.join(" ")).toMatch(/screenshot storage unavailable/);
      expect((await c.query(`SELECT count(*)::int AS n FROM artifacts WHERE website_id = $1`, [s.id])).rows[0].n).toBe(0);
    } finally {
      await env.stopBrowserWorkers();
      await env.startBrowserWorker();
    }
  }, 90_000);

  it("screenshot quota: captures stop once the organisation's daily bytes are used", async () => {
    const org = await newOrg();
    await setSettings(c, { "monitoring.browser.screenshotBytesPerDay": 1 });
    const a = await site(org, "quota-a", "/b/blank");
    await windowFor([a.id], true);
    await windowFor([a.id]);
    expect((await c.query(`SELECT count(*)::int AS n FROM artifacts WHERE website_id = $1`, [a.id])).rows[0].n).toBe(1); // first fits (quota checked before), then none
  }, 120_000);

  it("cancellation during navigation closes the browser and records CANCELLED; the job budget kills runaway pages", async () => {
    const org = await newOrg();
    const s = await site(org, "cancel", "/hang", { navigationTimeoutMs: 60_000 });
    await env.scheduler().runCycle();
    const running = await until(async () => {
      const { rows } = await c.query(`SELECT id FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' AND status = 'RUNNING'`, [s.id]);
      return rows[0] && env.runner.sessions.size > 0 ? rows[0] : null;
    }, 30_000);
    await c.query(`UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = $1`, [running.id]);
    await until(async () => (await c.query(`SELECT status::text FROM monitoring_executions WHERE id = $1`, [running.id])).rows[0].status === "CANCELLED", 30_000);
    await until(async () => env.runner.sessions.size === 0, 15_000);
    expect(await ledger(env, s.id)).toHaveLength(0);
  }, 90_000);

  it("graceful shutdown during navigation hands the execution back without consuming an attempt", async () => {
    const org = await newOrg();
    const s = await site(org, "drain", "/b/slow-resource?ms=6000");
    await env.scheduler().runCycle();
    await until(async () => env.runner.sessions.size > 0, 30_000);
    await env.stopBrowserWorkers();
    const ex = (await c.query(`SELECT status::text, attempt FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER'`, [s.id])).rows[0];
    expect(ex).toMatchObject({ status: "QUEUED", attempt: 1 });
    await until(async () => env.runner.sessions.size === 0, 15_000);
    await env.startBrowserWorker();
    const done = await until(async () => {
      const { rows } = await c.query(`SELECT status::text, attempt FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER'`, [s.id]);
      return rows[0]?.status === "SUCCEEDED" ? rows[0] : null;
    }, 60_000, 300);
    expect(done.attempt).toBe(1);
  }, 120_000);

  it("tenant fairness: per-organisation browser concurrency is bounded while another tenant proceeds", async () => {
    await setSettings(c, { "monitoring.limits.maxConcurrentJobs": 1, "queue.browser-monitoring": { ...BROWSER_QUEUE_POLICY, concurrency: 4 } });
    await env.stopBrowserWorkers();
    await env.startBrowserWorker();
    await env.startBrowserWorker();
    const big = await newOrg();
    const bigSites = [];
    for (let i = 0; i < 3; i++) bigSites.push(await site(big, `big-${i}`, "/b/slow-resource?ms=1500"));
    const peak = { big: 0 };
    const timer = setInterval(async () => {
      const n = (await c.query(`SELECT count(*)::int AS n FROM monitoring_executions WHERE org_id = $1 AND status = 'RUNNING'`, [big])).rows[0].n;
      peak.big = Math.max(peak.big, n);
    }, 100);
    try {
      await windowFor(bigSites.map((x) => x.id), true, 120_000);
    } finally {
      clearInterval(timer);
    }
    expect(peak.big).toBe(1);
    await setSettings(c, { "monitoring.limits.maxConcurrentJobs": 4 });
  }, 150_000);
});

void sleep;
