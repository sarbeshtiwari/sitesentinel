import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetMonitoringSettings, seedOrg } from "../helpers/monitoring.js";
import { deepSettings, deepSite, entitleDeep, findingsOf, scanNow, startDeepEnv, type DeepEnv } from "../helpers/deep-scan.js";

/**
 * Issue #24 — browser-assisted discovery beyond the start page, against the real sandboxed browser runner, the egress
 * gateway and controlled fixture websites:
 *  ds-listing-*   links fetched by JavaScript from a same-site JSON API on a top-level listing page (/articles, in the
 *                 sitemap) and on a client-rendered page at depth 2 (/guides/archive) found during the crawl
 *  ds-interact-*  links behind infinite scroll, "load more" and tabs; decoys that must never be clicked or sent
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

async function newOrg(extra: Record<string, unknown> = {}) {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  const o = await seedOrg(c, 0, { tag: "ds24" });
  orgs.push(o.orgId);
  await entitleDeep(env, o.orgId, extra);
  return o.orgId;
}
const urlsOf = async (exec: string) => (await c.query(`SELECT * FROM deep_scan_urls WHERE execution_id = $1 AND kind = 'PAGE' ORDER BY id`, [exec])).rows as Array<Record<string, any>>;
const path = (u: string) => new URL(u).pathname;
const browserFound = (rows: Array<Record<string, any>>) => rows.filter((p) => p.source === "BROWSER").map((p) => path(p.url)).sort();

describe("JavaScript-rendered links on listing and client-rendered pages", () => {
  it("renders the start page, the sitemap's listing page and a client-rendered page found at depth 2 — not normal pages", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 5 });
    const s = await deepSite(env, org, "listing", { browserDiscovery: true });
    const [scan] = await scanNow(env, [s.id]);
    const pages = await urlsOf(scan!.execution_id);
    expect(browserFound(pages)).toEqual(["/articles/buying-vs-renting", "/articles/home-loans", "/guides/archive/old-1", "/guides/archive/old-2"]);
    const byPath = new Map(pages.map((p) => [path(p.url), p]));
    // crawled like every other page, one level below the page they were rendered on
    for (const p of ["/articles/buying-vs-renting", "/articles/home-loans"]) expect(byPath.get(p)).toMatchObject({ state: "DONE", depth: 1 });
    expect(byPath.get("/guides/archive")).toMatchObject({ depth: 2, state: "DONE" });
    expect(byPath.get("/guides/archive")!.facts.clientRendered).toBe(true);
    for (const p of ["/guides/archive/old-1", "/guides/archive/old-2"]) expect(byPath.get(p)).toMatchObject({ state: "DONE", depth: 3 });
    // the budget went only to the start page, the listing page and the client-rendered page: normal pages are not rendered
    const disc = scan!.discovery as { browserRendered: string[]; spa: Array<{ page: string; links: number }> };
    expect(disc.browserRendered.map(path).sort()).toEqual(["/", "/articles", "/guides/archive"]);
    expect(byPath.get("/guides")!.facts.clientRendered).toBeUndefined();
    const spa = (await findingsOf(env, s.id, "OPEN")).filter((f) => f.category === "SPA_ROUTE_NOT_IN_HTML");
    expect(spa).toHaveLength(2);
    expect(spa.find((f) => String(f.subject).endsWith("/articles"))?.evidence).toMatchObject({ renderedOnlyLinks: 2, foundBy: { render: 2 } });
    expect(spa.find((f) => String(f.subject).endsWith("/guides/archive"))?.evidence).toMatchObject({ renderedOnlyLinks: 2, foundBy: { render: 2 } });
    expect(scan!.browser_ms).toBeGreaterThan(0);
  }, 240_000);

  it("the budget is shared: with browserPages = 2 only the start page and the listing page are rendered", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 2 });
    const s = await deepSite(env, org, "listing", { browserDiscovery: true });
    const [scan] = await scanNow(env, [s.id]);
    expect(browserFound(await urlsOf(scan!.execution_id))).toEqual(["/articles/buying-vs-renting", "/articles/home-loans"]);
    expect((scan!.discovery as { browserRendered: string[] }).browserRendered.map(path).sort()).toEqual(["/", "/articles"]);
  }, 240_000);

  it("off (the website's switch, or no platform budget): the JavaScript-only links are never found", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 5 });
    const off = await deepSite(env, org, "listing", { browserDiscovery: false });
    const [a] = await scanNow(env, [off.id]);
    const org0 = await newOrg(); // (suspends the previous test organisations)
    const noBudget = await deepSite(env, org0, "listing", { browserDiscovery: true });
    const [b] = await scanNow(env, [noBudget.id]);
    for (const scan of [a!, b!]) {
      const pages = await urlsOf(scan.execution_id);
      expect(pages.some((p) => p.source === "BROWSER")).toBe(false);
      expect(pages.some((p) => path(p.url).startsWith("/articles/"))).toBe(false);
      expect(pages.some((p) => path(p.url) === "/guides/archive")).toBe(true); // statically linked: still crawled
      expect(scan.browser_ms).toBe(0);
    }
  }, 240_000);

  it("rendering that uses up its own gateway budget (kind deepscan-browser) never starves the crawl (#35)", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 5 });
    const s = await deepSite(env, org, "listing", { browserDiscovery: true });
    const cfg = env.gateway.cfg as { maxConnectionsPerExecution?: number; maxConnectionsPerExecutionKind?: Record<string, number> };
    const before = { n: cfg.maxConnectionsPerExecution, k: cfg.maxConnectionsPerExecutionKind };
    cfg.maxConnectionsPerExecution = 3; // every kind but the crawl: rendering runs out almost at once
    cfg.maxConnectionsPerExecutionKind = { deepscan: 1000 };
    try {
      const [scan] = await scanNow(env, [s.id]);
      const exec = scan!.execution_id;
      const refused = env.gatewayLog.filter((l) => l.exec === exec && l.outcome === "RATE_LIMITED");
      expect(refused.some((l) => l.kind === "deepscan-browser" && l.detail === "execution-budget")).toBe(true);
      expect(refused.filter((l) => l.kind === "deepscan")).toEqual([]); // the crawl was never refused
      expect(scan).toMatchObject({ status: "COMPLETED" });
      expect(scan!.stop_reason).not.toBe("INFRASTRUCTURE");
      const pages = await urlsOf(exec);
      for (const p of ["/", "/articles", "/guides", "/guides/archive"]) expect(pages.find((x) => path(x.url) === p)).toMatchObject({ state: "DONE" });
      const l = (await c.query(`SELECT outcome, attempt FROM execution_results WHERE execution_id = $1`, [exec])).rows[0];
      expect(l.attempt).toBe(1);
      expect(l.outcome).not.toBe("INCONCLUSIVE");
    } finally {
      cfg.maxConnectionsPerExecution = before.n;
      cfg.maxConnectionsPerExecutionKind = before.k;
    }
  }, 240_000);
});

describe("links behind interactions (scroll, load more, tabs), behind the request guard", () => {
  it("finds links revealed by infinite scroll, 'load more' and tabs; never clicks decoys, never sends a POST, never navigates", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 5 });
    const s = await deepSite(env, org, "interact", { browserDiscovery: true, startPaths: ["/feed", "/more", "/tabs", "/decoy", "/posty"] });
    const [scan] = await scanNow(env, [s.id]);
    expect(scan!.status).toBe("COMPLETED");
    const found = browserFound(await urlsOf(scan!.execution_id));
    // (1) infinite scroll: two pages of the feed
    expect(found.filter((p) => p.startsWith("/feed/"))).toEqual(["/feed/item-1", "/feed/item-2", "/feed/item-3", "/feed/item-4"]);
    // (2) load more (same-origin GET JSON), clicked while it adds links (P1 is in the HTML)
    expect(found.filter((p) => p.startsWith("/more/"))).toEqual(["/more/p-2", "/more/p-3", "/more/p-4", "/more/p-5"]);
    // (3) a tab and a collapsed section
    expect(found.filter((p) => p.startsWith("/tabs/"))).toEqual(["/tabs/plan-1", "/tabs/project-x", "/tabs/project-y"]);
    // (4) decoys: Subscribe / Sign up never clicked, the form's submit never pressed, a navigating button refused
    expect(env.site.toggles.get(`${s.host}#decoy-hit`)).toBeUndefined();
    // (5) a "load more" that POSTs: refused by the guard; nothing but GET/HEAD ever reached the website
    expect(found.some((p) => p.startsWith("/posty/"))).toBe(false);
    expect(env.site.toggles.get(`${s.host}#non-get`)).toBeUndefined();
    const ix = (scan!.discovery as { browserInteraction: Record<string, number> }).browserInteraction;
    expect(ix.pages).toBeGreaterThanOrEqual(3);
    expect(ix.scroll).toBeGreaterThanOrEqual(2);
    expect(ix.loadMore).toBeGreaterThanOrEqual(2);
    expect(ix.toggle).toBeGreaterThanOrEqual(2);
    expect(ix.refused).toBeGreaterThanOrEqual(2); // the POST and the navigation
    expect(ix.navigationsRefused).toBeGreaterThanOrEqual(1);
    const spa = (await findingsOf(env, s.id, "OPEN")).filter((f) => f.category === "SPA_ROUTE_NOT_IN_HTML");
    const by = (p: string) => spa.find((f) => String(f.subject).endsWith(p))?.evidence;
    expect(by("/feed")).toMatchObject({ renderedOnlyLinks: 4, foundBy: { scroll: 4 } });
    expect(by("/more")).toMatchObject({ renderedOnlyLinks: 4, foundBy: { "load-more": 4 } });
    expect(by("/tabs")).toMatchObject({ renderedOnlyLinks: 3, foundBy: { toggle: 3 } });
  }, 240_000);
});

describe("links in hover menus, carousels and JavaScript search results (#28)", () => {
  it("hovers the nav mega menu, pages through the carousel, runs the search boxes; never types into the contact form, never POSTs", async () => {
    const org = await newOrg({ "monitoring.deepscan.browserPages": 5 });
    const s = await deepSite(env, org, "reveal", { browserDiscovery: true, startPaths: ["/menu", "/slider", "/find", "/lookup"] });
    const hitsBefore = env.site.hits.length;
    const [scan] = await scanNow(env, [s.id]);
    expect(scan!.status).toBe("COMPLETED");
    const pages = await urlsOf(scan!.execution_id);
    const found = browserFound(pages);
    // (1) hover: the mega menu's links exist only after mouseenter
    expect(found.filter((p) => p.startsWith("/services/"))).toEqual(["/services/build", "/services/design"]);
    // (2) carousel: slide 1 visible, slide 2 hidden in the DOM, slides 3-5 injected by "next"
    expect(found.filter((p) => p.startsWith("/slides/"))).toEqual(["/slides/s-1", "/slides/s-2", "/slides/s-3", "/slides/s-4", "/slides/s-5"]);
    // (3) search: results fetched with GET /api/search?q=test, and a results page reached by a same-origin GET navigation
    expect(found.filter((p) => p.startsWith("/search-results/"))).toEqual(["/search-results/r-1", "/search-results/r-2"]);
    expect(found.filter((p) => p.startsWith("/found/"))).toEqual(["/found/f-1", "/found/f-2"]);
    expect(env.site.toggles.get(`${s.host}#search-q`)).toBe("test");
    expect(env.site.toggles.get(`${s.host}#results-q`)).toBe("test");
    const byPath = new Map(pages.map((p) => [path(p.url), p]));
    for (const p of ["/services/design", "/slides/s-5", "/search-results/r-1", "/found/f-1"]) expect(byPath.get(p), p).toMatchObject({ state: "DONE", source: "BROWSER", depth: 1 });
    // (4) decoys: the contact form never typed into or sent, "previous" never clicked, nothing but GET / HEAD reached the site
    expect(env.site.toggles.get(`${s.host}#decoy-hit`)).toBeUndefined();
    expect(env.site.toggles.get(`${s.host}#non-get`)).toBeUndefined();
    const mine = env.site.hits.slice(hitsBefore).filter((x) => x.host === s.host);
    expect(mine.some((x) => x.path.startsWith("/api/contact"))).toBe(false);
    expect(mine.every((x) => x.method === "GET" || x.method === "HEAD")).toBe(true);
    const ix = (scan!.discovery as { browserInteraction: Record<string, number> }).browserInteraction;
    expect(ix.hover).toBeGreaterThanOrEqual(1);
    expect(ix.carousels).toBe(1);
    expect(ix.carousel).toBeGreaterThanOrEqual(3);
    expect(ix.carousel).toBeLessThanOrEqual(8);
    expect(ix.search).toBe(2);
    expect(ix.searchNavigations).toBe(1);
    const spa = (await findingsOf(env, s.id, "OPEN")).filter((f) => f.category === "SPA_ROUTE_NOT_IN_HTML");
    const by = (p: string) => spa.find((f) => String(f.subject).endsWith(p))?.evidence;
    expect(by("/menu")).toMatchObject({ renderedOnlyLinks: 2, foundBy: { hover: 2 } });
    expect(by("/slider")).toMatchObject({ renderedOnlyLinks: 5, foundBy: { render: 1, carousel: 4 } });
    expect(by("/find")).toMatchObject({ renderedOnlyLinks: 2, foundBy: { search: 2 } });
    expect(by("/lookup")).toMatchObject({ renderedOnlyLinks: 2, foundBy: { search: 2 } });
  }, 240_000);
});
