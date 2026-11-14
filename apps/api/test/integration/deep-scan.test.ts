import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createLogger } from "@wim/logger";
import { createDeepScanEngine, deepScanRetention } from "@wim/worker-deepscan";
import { reconcileUsageDay } from "@wim/queue";
import { resetMonitoringSettings, seedOrg, setSettings, sleep, until } from "../helpers/monitoring.js";
import { EGRESS_SECRET_4C, PREFIX_4C, incidentsOf } from "../helpers/http-monitoring.js";
import { DEEPSCAN_QUEUE_POLICY, deepSettings, nextDeepWindow, deepSite, entitleDeep, findingsOf, scanNow, scansOf, startDeepEnv, type DeepEnv } from "../helpers/deep-scan.js";

/**
 * Phase 4E — deep scanning against real PostgreSQL (worker as the narrow wim_scanner role), Redis, the egress
 * gateway (every decision captured) and the controlled deep-scan websites.
 */
let env: DeepEnv;
let c: pg.Client;
let parked: string[] = [];
const orgs: string[] = [];

beforeAll(async () => {
  env = await startDeepEnv();
  c = env.owner;
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE deep_scans SET status = 'CANCELLED' WHERE status = 'RUNNING'`);
  await resetMonitoringSettings(c);
  await deepSettings(env);
  await env.startDeepWorker();
}, 120_000);
afterEach(async () => {
  await deepSettings(env);
});
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  for (const q of Object.values(env.queues)) await q.obliterate({ force: true });
  await env.close();
});

async function newOrg(entitled = true, extra: Record<string, unknown> = {}) {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  const o = await seedOrg(c, 0, { tag: "ds4e" });
  orgs.push(o.orgId);
  if (entitled) await entitleDeep(env, o.orgId, extra);
  return o.orgId;
}
const deepDecisions = (exec: string) => env.gatewayLog.filter((l) => l.exec === exec);
const urlsOf = async (exec: string, kind = "PAGE") => (await c.query(`SELECT * FROM deep_scan_urls WHERE execution_id = $1 AND kind = $2 ORDER BY id`, [exec, kind])).rows as Array<Record<string, any>>;

// =====================================================================================================
describe("entitlement and scheduling", () => {
  it("only an entitled organisation with the platform switch on gets scans; paused websites don't; HTTP/browser stay off", async () => {
    await setSettings(c, { "monitoring.deepscan.enabled": false });
    const no = await newOrg(false);
    const x = await deepSite(env, no, "mini");
    const { orgId: yes } = await seedOrg(c, 0, { tag: "ds4e-yes" });
    orgs.push(yes);
    await entitleDeep(env, yes);
    const a = await deepSite(env, yes, "mini");
    const b = await deepSite(env, yes, "mini", { paused: true });
    await env.scheduler().runCycle();
    const st = async (id: string) => (await c.query(`SELECT status::text, paused_reason FROM monitoring_schedules WHERE website_id = $1 AND tier = 'T3_DEEP'`, [id])).rows[0];
    expect(await st(a.id)).toEqual({ status: "PAUSED", paused_reason: "TIER_DISABLED" });
    await setSettings(c, { "monitoring.deepscan.enabled": true });
    await env.scheduler().runCycle();
    expect(await st(a.id)).toEqual({ status: "ACTIVE", paused_reason: null });
    expect(await st(b.id)).toEqual({ status: "PAUSED", paused_reason: "DISABLED_BY_CUSTOMER" });
    expect(await st(x.id)).toEqual({ status: "PAUSED", paused_reason: "TIER_DISABLED" });
    for (const tier of ["T1_HTTP", "T2_RENDER"]) {
      const n = (await c.query(`SELECT count(*)::int AS n FROM monitoring_schedules WHERE org_id = ANY($1::uuid[]) AND tier = $2::"CheckTier" AND status = 'ACTIVE'`, [[yes, no], tier])).rows[0].n;
      expect(n, tier).toBe(0);
    }
    const [scan] = await scanNow(env, [a.id]);
    expect(scan!.status).toBe("COMPLETED");
    expect(await scansOf(env, x.id)).toHaveLength(0);
  }, 120_000);
});

// =====================================================================================================
describe("full scan of the controlled multi-page website", () => {
  it("discovers via robots + nested sitemaps, crawls only in scope, and records grouped findings", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "site");
    const [scan] = await scanNow(env, [s.id]);
    const exec = scan!.execution_id;
    const pages = await urlsOf(exec);
    const path = (x: Record<string, any>) => { const u = new URL(x.url); return `${u.pathname}${u.search}`; };
    const byPath = (p: string) => pages.find((x) => path(x) === p);
    const open = await findingsOf(env, s.id, "OPEN");
    const subjects = (cat: string) => open.filter((f) => f.category === cat).map((f) => f.subject.replace(s.origin, ""));
    expect(scan!.status).toBe("COMPLETED");
    expect(scan!.discovery.sitemaps).toMatchObject({ fetched: 4, outOfScope: 1 }); // index + 2 nested + gone; another site's entry ignored
    // discovery sources and dedupe: sitemap + crawl; duplicates collapse; tracking params and fragments removed
    expect(byPath("/about")).toMatchObject({ source: "SITEMAP", in_sitemap: true, state: "DONE" });
    expect(byPath("/orphan-in-sitemap")!.source).toBe("SITEMAP");
    expect(pages.filter((x) => path(x) === "/about")).toHaveLength(1); // "/%61bout#team" normalised to /about
    expect(byPath("/products?category=shoes")).toBeTruthy(); // query-based routes are kept…
    expect(byPath("/products?category=hats")).toBeTruthy();
    expect(pages.some((x) => /utm_/.test(x.url))).toBe(false); // …tracking parameters are not
    expect(byPath("/About")!.state).toBe("FAILED"); // paths are case-sensitive: a distinct, broken URL
    // policy: robots-disallowed, unsafe and out-of-scope URLs are never fetched
    expect(byPath("/private/secret")).toMatchObject({ state: "SKIPPED", skip_reason: "ROBOTS_DISALLOWED" });
    for (const p of ["/logout", "/account/delete?confirm=1", "/cart/add?id=4"]) expect(byPath(p), p).toBeUndefined();
    expect(env.site.toggles.get(`${s.host}#unsafe-hit`)).toBeUndefined();
    const hits = env.site.hits.filter((h) => h.host === s.host).map((h) => h.path);
    for (const p of ["/logout", "/account/delete", "/cart/add", "/private/secret"]) expect(hits, p).not.toContain(p);
    // every request: through the gateway, bound to this execution and to a host of the scope; nothing else attempted
    const decisions = deepDecisions(exec);
    expect(decisions.length).toBeGreaterThanOrEqual(scan!.requests - 2);
    for (const dcs of decisions) {
      expect(dcs).toMatchObject({ org, website: s.id, kind: "deepscan" });
      expect(dcs.host).toBe(s.host);
    }
    for (const h of ["external.example", "10.0.0.1", "169.254.169.254", "cdn.third.example", "other-site.example", "elsewhere.example", `internal-${s.host}`, "ftp.example", "another-site.example"]) {
      expect(env.gatewayLog.some((l) => l.exec === exec && l.host === h), h).toBe(false);
    }
    // findings
    expect(subjects("BROKEN_PAGE").sort()).toEqual(["/About", "/missing"]);
    expect(open.find((f) => f.category === "BROKEN_PAGE" && f.subject.endsWith("/missing"))!.evidence).toMatchObject({ status: 404, linkedFrom: `${s.origin}/broken-link` });
    expect(subjects("REDIRECT_LOOP")).toEqual(["/loop1"]);
    expect(subjects("REDIRECT_CHAIN")).toEqual(["/old"]);
    expect(subjects("REDIRECT_OUT_OF_SCOPE").sort()).toEqual(["/redir-internal", "/redir-meta", "/redir-offsite"]);
    expect(subjects("BROKEN_RESOURCE").sort()).toEqual(["/assets/missing.css", "/assets/missing.js", "/assets/missing.png"]);
    expect(subjects("MISSING_DESCRIPTION")).toEqual(["/no-desc"]);
    expect(subjects("MISSING_H1")).toEqual(["/no-h1"]);
    expect(subjects("MISSING_CANONICAL").sort()).toEqual(["/dup-a", "/dup-b", "/no-canonical"]);
    expect(subjects("INVALID_CANONICAL")).toEqual(["/bad-canonical"]);
    expect(subjects("INVALID_JSON_LD")).toEqual(["/jsonld-bad"]);
    expect(subjects("NOINDEX_IN_SITEMAP")).toEqual(["/noindex"]);
    expect(subjects("IMG_MISSING_ALT")).toEqual(["/img"]);
    for (const c of ["MISSING_LANG", "MISSING_MAIN_LANDMARK", "EMPTY_LINK", "EMPTY_BUTTON", "UNLABELLED_CONTROL", "HEADING_SKIP", "DUPLICATE_ID"]) expect(subjects(c), c).toEqual(["/a11y"]);
    expect(open.find((f) => f.category === "DUPLICATE_TITLE")!.evidence.pages.map((p: string) => p.replace(s.origin, "")).sort()).toEqual(["/about", "/blog/"]);
    const dupContent = open.filter((f) => f.category === "DUPLICATE_CONTENT").map((f) => f.evidence.pages.map((p: string) => p.replace(s.origin, "")).sort());
    expect(dupContent).toContainEqual(["/dup-a", "/dup-b"]); // (the trap pages are near-identical too, and reported as such)
    expect(subjects("SITEMAP_UNREACHABLE")).toEqual(["/sitemaps/gone.xml"]);
    expect(subjects("SITEMAP_URL_OUT_OF_SCOPE").sort()).toEqual(["robots.txt", "sitemap"]);
    expect(subjects("SITEMAP_BAD_LASTMOD")).toEqual(["sitemap"]);
    // every finding has evidence, impact, recommendation, detection method, severity
    for (const f of open) {
      expect(f.recommendation.length, f.category).toBeGreaterThan(10);
      expect(f.evidence.impact, f.category).toBeTruthy();
      expect(["HTTP", "HTML_ANALYSIS", "SITEMAP", "ROBOTS", "BROWSER"]).toContain(f.detection_method);
    }
    // bounded: infinite /trap and /calendar stop at the depth limit; large page truncated, not failed
    expect(pages.filter((x) => x.url.includes("/trap/")).length).toBeLessThanOrEqual(6);
    expect(scan!.pages_dropped).toBeGreaterThan(0);
    expect(scan!.complete).toBe(false);
    expect(byPath("/slow")).toMatchObject({ state: "DONE", status_code: 200 }); // a slow (but in-budget) page is checked, not failed
    expect(byPath("/slow")!.duration_ms).toBeGreaterThanOrEqual(1000);
    expect(byPath("/large")).toMatchObject({ state: "DONE" });
    expect(byPath("/large")!.facts.truncated).toBe(true);
    expect(byPath("/large")!.bytes).toBeLessThanOrEqual(4 * 2_097_152 + 65_536);
    // grouped incidents: one per group, not per finding
    const inc = await incidentsOf(c, s.id);
    expect(inc.map((i) => i.check_key).sort()).toEqual(["deepscan.broken_pages", "deepscan.broken_resources"]);
    expect(inc.every((i) => i.source === "DEEP_SCAN")).toBe(true);
    // the ledger holds exactly one result; usage counts each page once
    const l = (await c.query(`SELECT * FROM execution_results WHERE execution_id = $1`, [exec])).rows;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tier: "T3_DEEP", outcome: "FAILED" });
    const usage = Object.fromEntries((await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1`, [org])).rows.map((r) => [r.key, r.value]));
    expect(usage["deepscan.pages"]).toBe(scan!.pages_completed + scan!.pages_failed);
    expect(usage["deepscan.scans"]).toBe(1);
    // release readiness: the reconciliation's pages check agrees with what the real scan recorded (no discrepancy)
    const run = await reconcileUsageDay(env.db, new Date().toISOString().slice(0, 10));
    const disc = (await c.query(`SELECT "check", recorded, expected FROM usage_discrepancies WHERE run_id = $1 AND org_id = $2 AND "check" IN ('deepscan.pages~urls', 'deepscan.scans~scans')`, [run.runId, org])).rows;
    expect(disc).toEqual([]);
    // and catches a counter that does not match: one page too many
    await c.query(`UPDATE usage_counters SET value = value + 1 WHERE org_id = $1 AND key = 'deepscan.pages' AND period_start = (now() AT TIME ZONE 'UTC')::date`, [org]);
    const run2 = await reconcileUsageDay(env.db, new Date().toISOString().slice(0, 10));
    const d2 = (await c.query(`SELECT recorded, expected FROM usage_discrepancies WHERE run_id = $1 AND org_id = $2 AND "check" = 'deepscan.pages~urls'`, [run2.runId, org])).rows;
    expect(d2).toEqual([{ recorded: String(usage["deepscan.pages"] + 1), expected: String(usage["deepscan.pages"]) }]);
    await c.query(`UPDATE usage_counters SET value = value - 1 WHERE org_id = $1 AND key = 'deepscan.pages' AND period_start = (now() AT TIME ZONE 'UTC')::date`, [org]);
    // stored data: no sensitive query values, no page bodies
    const stored = JSON.stringify((await c.query(`SELECT url, facts, final_url FROM deep_scan_urls WHERE execution_id = $1`, [exec])).rows);
    expect(stored).not.toContain("Identical body text");
    expect(stored).not.toContain("xxxxxxxxxx");
  }, 240_000);

  it("SPA routes rendered by JavaScript are found only with (entitled) browser-assisted discovery", async () => {
    const org = await newOrg(true, { "monitoring.deepscan.browserPages": 2 });
    const s = await deepSite(env, org, "site", { browserDiscovery: true, startPaths: ["/spa"], respectRobots: true });
    const [scan] = await scanNow(env, [s.id]);
    const pages = await urlsOf(scan!.execution_id);
    expect(pages.filter((p) => p.source === "BROWSER").map((p) => new URL(p.url).pathname).sort()).toEqual(["/spa/route-a", "/spa/route-b"]);
    expect(pages.find((p) => p.url.endsWith("/spa/route-a"))!.state).toBe("DONE");
    expect(scan!.browser_ms).toBeGreaterThan(0);
    const spa = await findingsOf(env, s.id, "OPEN");
    expect(spa.find((f) => f.category === "SPA_ROUTE_NOT_IN_HTML")!.evidence.renderedOnlyLinks).toBe(2);
    // the rendered page's requests went through the gateway with this execution's (deepscan-browser) capability
    expect(env.gatewayLog.some((l) => l.exec === scan!.execution_id && l.kind === "deepscan-browser" && l.outcome === "ALLOWED")).toBe(true);
    // without the entitlement, browser discovery is off even if the customer enables it
    const org2 = await newOrg(true);
    const s2 = await deepSite(env, org2, "site", { browserDiscovery: true, startPaths: ["/spa"] });
    const [scan2] = await scanNow(env, [s2.id]);
    expect((await urlsOf(scan2!.execution_id)).some((p) => p.source === "BROWSER")).toBe(false);
    expect(scan2!.browser_ms).toBe(0);
  }, 240_000);

  it("sitemap problems: invalid XML, index loops, oversized sitemaps (bounded), reported separately from availability", async () => {
    const org = await newOrg();
    const bad = await deepSite(env, org, "badxml");
    const loop = await deepSite(env, org, "loop");
    const huge = await deepSite(env, org, "huge");
    const [a, b, h] = await scanNow(env, [bad.id, loop.id, huge.id]);
    const cats = async (id: string) => (await findingsOf(env, id, "OPEN")).map((f) => f.category);
    expect(await cats(bad.id)).toContain("SITEMAP_INVALID");
    expect(await cats(loop.id)).toContain("SITEMAP_LOOP");
    expect(await cats(huge.id)).toEqual(expect.arrayContaining(["SITEMAP_TOO_LARGE", "SITEMAP_BAD_LASTMOD"]));
    expect((await urlsOf(h!.execution_id)).length).toBeLessThanOrEqual(100); // never more pages than the limit
    expect(h!.pages_dropped).toBeGreaterThan(0);
    for (const x of [a, b, h]) expect(x!.status).toBe("COMPLETED");
    // sitemap findings don't open incidents by default (findings only)
    expect((await incidentsOf(c, bad.id)).filter((i) => i.check_key === "deepscan.sitemap")).toHaveLength(0);
  }, 240_000);
});

// =====================================================================================================
describe("recovery, comparison and incomplete scans", () => {
  it("fixing a broken link resolves its finding and incident after a complete scan; the comparison shows the recovery", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    const [first] = await scanNow(env, [s.id]);
    expect(first!.complete).toBe(true);
    let broken = (await findingsOf(env, s.id, "OPEN")).filter((f) => f.category === "BROKEN_PAGE");
    expect(broken.map((f) => f.subject)).toEqual([`${s.origin}/missing`]);
    expect((await incidentsOf(c, s.id)).map((i) => [i.check_key, i.status])).toEqual([["deepscan.broken_pages", "OPEN"]]);
    // second scan with the problem still there: grouped, not duplicated
    await scanNow(env, [s.id]);
    broken = (await findingsOf(env, s.id)).filter((f) => f.category === "BROKEN_PAGE");
    expect(broken).toHaveLength(1);
    expect(broken[0]!.occurrence_count).toBe(2);
    expect(await incidentsOf(c, s.id)).toHaveLength(1);
    env.site.toggles.set(s.host, "fixed");
    const [third] = await scanNow(env, [s.id]);
    const f = (await findingsOf(env, s.id)).find((x) => x.category === "BROKEN_PAGE")!;
    expect(f).toMatchObject({ status: "RESOLVED", resolved_execution_id: third!.execution_id });
    expect((await incidentsOf(c, s.id))[0]).toMatchObject({ status: "RESOLVED", auto_resolved: true });
    const events = (await c.query(`SELECT type FROM scan_finding_events WHERE finding_id = $1 ORDER BY id`, [f.id])).rows.map((r) => r.type);
    expect(events).toEqual(["OPENED", "RECURRED", "RESOLVED"]);
    expect(third!.comparison).toMatchObject({ baselineExecutionId: expect.any(String), recoveredPages: { count: 1 }, newBrokenPages: { count: 0 }, removedPages: { count: 0 } });
    expect(third!.comparison.recoveredPages.items[0]).toBe(`${s.origin}/missing`);
    expect(third!.comparison.statusChanged.items).toContain(`${s.origin}/missing (404 → 200)`);
    // outbox: one opened + one resolved event for the group (notifications are per incident transition, not per scan)
    const ob = (await c.query(`SELECT topic FROM outbox_events WHERE org_id = $1 ORDER BY id`, [org])).rows.map((r) => r.topic);
    expect(ob).toEqual(["incident.opened", "incident.resolved"]);
  }, 240_000);

  it("a PARTIAL scan (daily quota) never resolves findings or removes pages; a later complete scan does", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    await scanNow(env, [s.id]);
    expect((await findingsOf(env, s.id, "OPEN")).some((f) => f.category === "BROKEN_PAGE")).toBe(true);
    env.site.toggles.set(s.host, "fixed");
    // quota allows 2 more pages today: the scan stops early
    const used = (await c.query(`SELECT value::int FROM usage_counters WHERE org_id = $1 AND key = 'deepscan.pages'`, [org])).rows[0].value;
    await entitleDeep(env, org, { "monitoring.deepscan.pagesPerDay": used + 2 });
    const [partial] = await scanNow(env, [s.id]);
    expect(partial).toMatchObject({ status: "PARTIAL", stop_reason: "DAILY_QUOTA", complete: false });
    // the unchecked pages are unknown: the ledger must not claim the site passed
    expect((await c.query(`SELECT outcome FROM execution_results WHERE execution_id = $1`, [partial!.execution_id])).rows[0].outcome).toBe("INCONCLUSIVE");
    expect((await findingsOf(env, s.id, "OPEN")).some((f) => f.category === "BROKEN_PAGE")).toBe(true); // not resolved by a partial scan
    expect((await incidentsOf(c, s.id))[0]!.status).toBe("OPEN");
    expect(partial!.comparison?.removedPages.count ?? 0).toBe(0); // unseen pages are "not observed", never "removed"
    await entitleDeep(env, org); // quota restored
    await c.query(`DELETE FROM usage_counters WHERE org_id = $1 AND key = 'deepscan.pages'`, [org]);
    const [full] = await scanNow(env, [s.id]);
    expect(full!.status).toBe("COMPLETED");
    expect((await findingsOf(env, s.id)).find((f) => f.category === "BROKEN_PAGE")!.status).toBe("RESOLVED");
  }, 240_000);
});

// =====================================================================================================
describe("security of the scanner", () => {
  it("DNS rebinding and private answers: pages are skipped, never fetched from a private address", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    let n = 0;
    env.dns.setA(s.host, () => (n++ % 3 === 2 ? ["10.20.30.40"] : ["127.0.0.1"]));
    const [scan] = await scanNow(env, [s.id]);
    const decisions = deepDecisions(scan!.execution_id);
    expect(decisions.some((d) => d.outcome === "BLOCKED_ADDRESS")).toBe(true);
    for (const d of decisions.filter((x) => x.outcome === "ALLOWED")) expect(d.address).toBe("127.0.0.1");
    const pages = await urlsOf(scan!.execution_id);
    expect(pages.some((p) => p.state === "SKIPPED" && p.skip_reason === "BLOCKED_ADDRESS")).toBe(true);
    env.dns.setA(s.host, ["127.0.0.1"]);
  }, 180_000);

  it("IPv4-mapped IPv6 and private AAAA answers are refused; the scan fails safely without findings", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    env.dns.setA(s.host, []);
    env.dns.zone.a.delete(s.host);
    env.dns.zone.aaaa.set(s.host, ["::ffff:10.0.0.5"]);
    try {
      const [scan] = await scanNow(env, [s.id]);
      const decisions = deepDecisions(scan!.execution_id);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.every((d) => d.outcome !== "ALLOWED")).toBe(true);
      expect(env.site.hits.some((h) => h.host === s.host)).toBe(false);
      expect(scan).toMatchObject({ status: "PARTIAL", stop_reason: "NO_PAGE_REACHABLE", complete: false });
      const l = (await c.query(`SELECT outcome FROM execution_results WHERE execution_id = $1`, [scan!.execution_id])).rows[0];
      expect(l.outcome).toBe("INCONCLUSIVE");
      expect(await findingsOf(env, s.id, "OPEN")).toHaveLength(0); // an unreachable destination is not a "broken site"
    } finally {
      env.dns.zone.aaaa.delete(s.host);
      env.dns.setA(s.host, ["127.0.0.1"]);
    }
  }, 180_000);

  it("external links (entitled + enabled): status-checked through the gateway, never crawled; IP-literal links never requested", async () => {
    const org = await newOrg(true, { "monitoring.deepscan.externalLinks": true });
    const s = await deepSite(env, org, "site", { checkExternalLinks: true });
    env.dns.setA("external.example", ["127.0.0.1"]);
    const [scan] = await scanNow(env, [s.id]);
    const ext = await urlsOf(scan!.execution_id, "EXTERNAL");
    expect(ext.map((x) => new URL(x.url).hostname)).toEqual(["external.example"]);
    expect(ext[0]!.state).not.toBe("QUEUED");
    const dec = env.gatewayLog.filter((l) => l.exec === scan!.execution_id && l.host === "external.example");
    expect(dec.length).toBeGreaterThan(0);
    expect(dec.every((d) => d.kind === "deepscan")).toBe(true);
    for (const h of ["10.0.0.1", "169.254.169.254", "[::ffff:127.0.0.1]", "::ffff:127.0.0.1"]) {
      expect(env.gatewayLog.some((l) => l.exec === scan!.execution_id && l.host === h), h).toBe(false);
    }
    // only HEAD-style status checks: the external page itself was never parsed for links
    expect(env.site.hits.filter((h) => h.host === "external.example").every((h) => h.method === "HEAD" || h.method === "GET")).toBe(true);
    expect((await urlsOf(scan!.execution_id)).some((x) => x.kind === "PAGE" && new URL(x.url).hostname === "external.example")).toBe(false);
  }, 240_000);

  it("retention (as wim_scanner): old scans and their frontier, and long-resolved findings, are deleted; open findings stay", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    const [old] = await scanNow(env, [s.id]);
    env.site.toggles.set(s.host, "fixed");
    await scanNow(env, [s.id]); // resolves BROKEN_PAGE
    env.site.toggles.delete(s.host);
    const [cur] = await scanNow(env, [s.id]); // broken again → REOPENED (open finding)
    const dup = (await findingsOf(env, s.id)).find((f) => f.category === "DUPLICATE_DESCRIPTION");
    await c.query(`UPDATE deep_scans SET started_at = now() - interval '100 days' WHERE execution_id = $1`, [old!.execution_id]);
    // a long-resolved finding (separate from the open one)
    if (dup) await c.query(`UPDATE scan_findings SET status = 'RESOLVED', resolved_at = now() - interval '100 days' WHERE id = $1`, [dup.id]);
    const r = await deepScanRetention(env.scannerDb, 90);
    expect(r.scans).toBeGreaterThanOrEqual(1);
    expect((await c.query(`SELECT count(*)::int AS n FROM deep_scans WHERE execution_id = $1`, [old!.execution_id])).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM deep_scan_urls WHERE execution_id = $1`, [old!.execution_id])).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM deep_scans WHERE execution_id = $1`, [cur!.execution_id])).rows[0].n).toBe(1);
    const broken = (await findingsOf(env, s.id)).find((f) => f.category === "BROKEN_PAGE")!;
    expect(broken.status).toBe("OPEN"); // open findings are never deleted, even if first seen in a deleted scan
    if (dup) {
      expect((await c.query(`SELECT count(*)::int AS n FROM scan_findings WHERE id = $1`, [dup.id])).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM scan_finding_events WHERE finding_id = $1`, [dup.id])).rows[0].n).toBe(0);
    }
    const ev = (await c.query(`SELECT type FROM scan_finding_events WHERE finding_id = $1 ORDER BY id`, [broken.id])).rows.map((x) => x.type);
    expect(ev).toEqual(["OPENED", "RESOLVED", "REOPENED"]);
  }, 240_000);

  it("the scanner's database role can't read other tables, and can't attach a scan to another organisation's website", async () => {
    const org = await newOrg();
    const other = await newOrg();
    const s = await deepSite(env, other, "mini");
    const db = env.scannerDb;
    for (const t of ["users", "user_sessions", "api_credentials", "payments", "audit_logs", "artifacts", "notification_channels", "sdk_events"]) {
      await expect(db.$queryRawUnsafe(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    }
    // a scan row must match a T3 execution of the same org and website (trigger), whatever the caller claims
    const { rows: [e] } = await c.query(`INSERT INTO monitoring_executions (org_id, website_id, tier, status, queued_at) VALUES ($1, $2, 'T3_DEEP', 'QUEUED', date_trunc('milliseconds', now())) RETURNING id`, [other, s.id]);
    await expect(c.query(`INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ($1, $2, $3, '{}')`, [e.id, org, s.id])).rejects.toThrow(/does not match/);
    await expect(c.query(`INSERT INTO scan_findings (org_id, website_id, fingerprint, category, group_key, severity, subject, title, evidence, recommendation, detection_method, first_detected_at, last_detected_at, first_execution_id, last_execution_id)
                          VALUES ($1, $2, 'x', 'BROKEN_PAGE', 'broken_pages', 'HIGH', 's', 't', '{}', 'r', 'HTTP', now(), now(), $3, $3)`, [org, s.id, e.id])).rejects.toThrow(/does not match/);
    // one RUNNING scan per website; a final status needs the ledger
    await c.query(`INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ($1, $2, $3, '{}')`, [e.id, other, s.id]);
    const { rows: [e2] } = await c.query(`INSERT INTO monitoring_executions (org_id, website_id, tier, status, queued_at) VALUES ($1, $2, 'T3_DEEP', 'QUEUED', date_trunc('milliseconds', now()) + interval '1 ms') RETURNING id`, [other, s.id]);
    await expect(c.query(`INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ($1, $2, $3, '{}')`, [e2.id, other, s.id])).rejects.toThrow(/deep_scans_one_running_per_website/);
    await expect(c.query(`UPDATE deep_scans SET status = 'COMPLETED' WHERE execution_id = $1`, [e.id])).rejects.toThrow(/finalised together with its execution result/);
    await c.query(`UPDATE deep_scans SET status = 'CANCELLED' WHERE execution_id = $1`, [e.id]);
  }, 60_000);
});

// =====================================================================================================
describe("idempotency, crashes, cancellation and infrastructure", () => {
  it("the same execution processed again changes nothing", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    const [scan] = await scanNow(env, [s.id]);
    const { rows: [ex] } = await c.query(`SELECT id, queued_at FROM monitoring_executions WHERE id = $1`, [scan!.execution_id]);
    const snapshot = async () => ({
      findings: (await findingsOf(env, s.id)).map((f) => [f.id, f.occurrence_count, f.status]),
      events: (await c.query(`SELECT count(*)::int AS n FROM scan_finding_events WHERE org_id = $1`, [org])).rows[0].n,
      usage: (await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1 ORDER BY key`, [org])).rows,
      incidents: (await incidentsOf(c, s.id)).map((i) => [i.id, i.occurrence_count]),
      ledger: (await c.query(`SELECT count(*)::int AS n FROM execution_results WHERE execution_id = $1`, [scan!.execution_id])).rows[0].n,
    });
    const before = await snapshot();
    const engine = createDeepScanEngine({ db: env.scannerDb, redis: env.redis, log: createLogger("x", { level: "silent" }), gatewayUrl: env.gatewayUrl, tokenSecret: EGRESS_SECRET_4C, runnerUrl: null, jobTimeoutMs: async () => 120_000 });
    const hitsBefore = env.site.hits.length;
    for (let i = 0; i < 2; i++) {
      const out = await engine({ executionId: ex.id, orgId: org, websiteId: s.id, tier: "DEEPSCAN", attempt: 2 + i, maxAttempts: 3, windowStart: ex.queued_at, signal: new AbortController().signal });
      expect(out.summary).toMatchObject({ duplicate: true });
    }
    expect(env.site.hits.length).toBe(hitsBefore); // no request at all
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it("worker SIGKILLed mid-scan: resumes from the frontier; completed pages are neither re-fetched nor counted twice", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    await env.stopDeepWorkers();
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "fixtures", "crash-deepscan-worker.mjs")], {
      env: { ...process.env, TEST_PREFIX: PREFIX_4C, TEST_GATEWAY_URL: env.gatewayUrl, TEST_EGRESS_SECRET: EGRESS_SECRET_4C, CRASH_AFTER_PAGES: "3" }, stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    let exec = "";
    try {
      await until(async () => out.includes("READY"), 30_000);
      await c.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second' WHERE website_id = $1 AND tier = 'T3_DEEP'`, [s.id]);
      await env.scheduler().runCycle();
      await new Promise((res) => child.once("exit", res));
      expect(out).toMatch(/CRASHING after 3 pages/);
      const [running] = await scansOf(env, s.id);
      exec = running!.execution_id;
      expect(running).toMatchObject({ status: "RUNNING", pages_completed: 3 });
    } finally {
      child.kill("SIGKILL");
      await env.startDeepWorker({ workerId: "rescuer" });
    }
    const hitsBefore = new Map<string, number>();
    for (const h of env.site.hits.filter((x) => x.host === s.host)) hitsBefore.set(h.path, (hitsBefore.get(h.path) ?? 0) + 1);
    const done = await until(async () => (await scansOf(env, s.id)).find((x) => x.execution_id === exec && x.status !== "RUNNING"), 120_000, 300);
    expect(done.status).toBe("COMPLETED");
    const pages = await urlsOf(exec);
    const checked = pages.filter((p) => p.state === "DONE" || p.state === "FAILED").length;
    const usage = (await c.query(`SELECT value::int FROM usage_counters WHERE org_id = $1 AND key = 'deepscan.pages'`, [org])).rows[0].value;
    expect(usage).toBe(checked); // each page counted once despite the crash
    expect(done.pages_completed + done.pages_failed).toBe(checked);
    const hitsAfter = new Map<string, number>();
    for (const h of env.site.hits.filter((x) => x.host === s.host)) hitsAfter.set(h.path, (hitsAfter.get(h.path) ?? 0) + 1);
    expect(hitsAfter.get("/")).toBe(hitsBefore.get("/")); // the home page (completed before the crash) wasn't fetched again
    expect((await c.query(`SELECT count(*)::int AS n FROM execution_results WHERE execution_id = $1`, [exec])).rows[0].n).toBe(1);
    expect((await findingsOf(env, s.id)).filter((f) => f.category === "BROKEN_PAGE")).toHaveLength(1);
    const ex = (await c.query(`SELECT attempt, status::text FROM monitoring_executions WHERE id = $1`, [exec])).rows[0];
    expect(ex).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
  }, 240_000);

  it("cancellation during a scan keeps partial data, resolves nothing, and frees the website for the next scan", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    await scanNow(env, [s.id]); // baseline with the broken page open
    env.site.toggles.set(s.host, "fixed");
    env.site.toggles.set(`${s.host}#slow`, "down"); // each /pN takes 1.5 s
    await nextDeepWindow(env, s.id);
    await env.scheduler().runCycle();
    const running = await until(async () => (await scansOf(env, s.id)).find((x) => x.status === "RUNNING" && x.pages_completed >= 2), 60_000, 200);
    await c.query(`UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = $1`, [running.execution_id]);
    const cancelled = await until(async () => (await scansOf(env, s.id)).find((x) => x.execution_id === running.execution_id && x.status === "CANCELLED"), 30_000, 200);
    expect(cancelled.pages_completed).toBeGreaterThanOrEqual(2);
    expect((await c.query(`SELECT count(*)::int AS n FROM execution_results WHERE execution_id = $1`, [running.execution_id])).rows[0].n).toBe(0);
    expect((await findingsOf(env, s.id, "OPEN")).some((f) => f.category === "BROKEN_PAGE")).toBe(true); // not resolved
    env.site.toggles.delete(`${s.host}#slow`);
    const [next] = await scanNow(env, [s.id]);
    expect(next!.status).toBe("COMPLETED");
  }, 240_000);

  it("gateway outage: retried on the same execution, then INCONCLUSIVE; nothing resolved, no findings invented", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    await scanNow(env, [s.id]);
    env.site.toggles.set(s.host, "fixed");
    await env.stopDeepWorkers();
    try {
      await env.startDeepWorker({ gatewayUrl: "http://127.0.0.1:9" });
      const [scan] = await scanNow(env, [s.id]);
      expect(scan).toMatchObject({ status: "PARTIAL", stop_reason: "INFRASTRUCTURE" });
      const l = (await c.query(`SELECT outcome, attempt FROM execution_results WHERE execution_id = $1`, [scan!.execution_id])).rows[0];
      expect(l).toMatchObject({ outcome: "INCONCLUSIVE", attempt: 2 });
      // failed-attempt overhead is tracked separately from billable usage: both attempts failed on our side
      const ov = Object.fromEntries((await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1 AND key IN ('deepscan.failed_attempts', 'deepscan.overhead_requests')`, [org])).rows.map((r) => [r.key, r.value]));
      expect(ov["deepscan.failed_attempts"]).toBe(2);
      expect(ov["deepscan.overhead_requests"]).toBeGreaterThanOrEqual(2);
      expect((await findingsOf(env, s.id, "OPEN")).some((f) => f.category === "BROKEN_PAGE")).toBe(true);
      expect((await incidentsOf(c, s.id))[0]!.status).toBe("OPEN");
    } finally {
      await env.stopDeepWorkers();
      await env.startDeepWorker();
    }
  }, 240_000);

  it("gateway dying MID-REQUEST (timeouts / resets, not 'unavailable') never becomes the customer's broken pages", async () => {
    // Found in the Phase 4E Docker run: stopping the gateway container during slow requests surfaced as
    // CONNECT_TIMEOUT / PROTOCOL_ERROR and healthy pages were recorded as broken. A killable proxy in front of the
    // real gateway reproduces it.
    const org = await newOrg();
    const s = await deepSite(env, org, "mini");
    const gw = new URL(env.gatewayUrl);
    const socks = new Set<import("node:net").Socket>();
    const proxy = createServer((cl) => {
      const up = connect(Number(gw.port), gw.hostname);
      socks.add(cl); socks.add(up);
      cl.pipe(up).pipe(cl);
      cl.on("error", () => up.destroy()); up.on("error", () => cl.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    await env.stopDeepWorkers();
    try {
      await env.startDeepWorker({ gatewayUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` });
      env.site.toggles.set(`${s.host}#slow`, "down");
      await nextDeepWindow(env, s.id);
      await env.scheduler().runCycle();
      await until(async () => (await scansOf(env, s.id)).find((x) => x.status === "RUNNING" && x.pages_completed >= 3), 60_000, 100);
      await sleep(300); // a slow /pN request is in flight
      proxy.close();
      for (const x of socks) x.destroy(); // the gateway "dies" mid-request
      const done = await until(async () => (await scansOf(env, s.id)).find((x) => x.status !== "RUNNING"), 150_000, 300);
      expect(done).toMatchObject({ status: "PARTIAL", stop_reason: "INFRASTRUCTURE", complete: false });
      const failed = (await urlsOf(done.execution_id)).filter((p) => p.state === "FAILED").map((p) => new URL(p.url).pathname);
      expect(failed.filter((p) => /^\/p\d$/.test(p))).toEqual([]); // healthy-but-slow pages are not "broken"
      expect((await findingsOf(env, s.id)).filter((f) => f.category === "BROKEN_PAGE" && /\/p\d$/.test(f.subject))).toHaveLength(0);
      const l = (await c.query(`SELECT outcome FROM execution_results WHERE execution_id = $1`, [done.execution_id])).rows[0];
      expect(l.outcome).toBe("INCONCLUSIVE");
    } finally {
      env.site.toggles.delete(`${s.host}#slow`);
      proxy.close();
      await env.stopDeepWorkers();
      await env.startDeepWorker();
    }
  }, 240_000);

  it("concurrent scans: one RUNNING scan per website; per-organisation scan concurrency leaves room for other tenants", async () => {
    const big = await newOrg(true, { "monitoring.deepscan.maxConcurrentScans": 1 });
    const sites = [await deepSite(env, big, "mini"), await deepSite(env, big, "mini")];
    for (const x of sites) env.site.toggles.set(`${x.host}#slow`, "down");
    const { orgId: small } = await seedOrg(c, 0, { tag: "ds4e-small" });
    orgs.push(small);
    await entitleDeep(env, small);
    const smallSite = await deepSite(env, small, "mini");
    let peakBig = 0, smallRanAlongside = false;
    const timer = setInterval(async () => {
      const r = (await c.query(`SELECT org_id, count(*)::int AS n FROM deep_scans WHERE status = 'RUNNING' AND org_id = ANY($1::uuid[]) GROUP BY 1`, [[big, small]])).rows;
      const b = r.find((x) => x.org_id === big)?.n ?? 0;
      peakBig = Math.max(peakBig, b);
      if (b && r.find((x) => x.org_id === small)) smallRanAlongside = true;
    }, 150);
    try {
      await scanNow(env, [...sites.map((x) => x.id), smallSite.id], 200_000);
    } finally {
      clearInterval(timer);
      for (const x of sites) env.site.toggles.delete(`${x.host}#slow`);
    }
    expect(peakBig).toBe(1);
    expect(smallRanAlongside).toBe(true);
  }, 240_000);
});

void sleep; void DEEPSCAN_QUEUE_POLICY;
