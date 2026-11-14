import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { BrowserRunner } from "@wim/browser-runner";
import { createLogger } from "@wim/logger";
import { createBrowserEngine } from "@wim/worker-browser";
import { resetMonitoringSettings, seedOrg, setSettings, until } from "../helpers/monitoring.js";
import { addVerifiedSite, EGRESS_SECRET_4C, incidentsOf, PREFIX_4C } from "../helpers/http-monitoring.js";
import { BROWSER_QUEUE_POLICY, browserSettings, entitleBrowser, ledger, startBrowserEnv, type BrowserEnv } from "../helpers/browser-monitoring.js";

/**
 * Phase 4F (approved scope): component detection, safe functional tests and the responsive matrix with REAL Chromium
 * (sandbox on) through the production runner service and the real egress gateway, against controlled fixture pages
 * that contain traps (buy / delete / logout / an unlabelled button that POSTs). Every test asserts the traps were
 * never reached.
 */
let env: BrowserEnv;
let c: pg.Client;
let parked: string[] = [];
const orgs: string[] = [];
const JOB_MS = 120_000;
const POLICY = { ...BROWSER_QUEUE_POLICY, timeoutMs: JOB_MS };

beforeAll(async () => {
  env = await startBrowserEnv();
  c = env.owner;
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await resetMonitoringSettings(c);
  await browserSettings(env, { "queue.browser-monitoring": POLICY, "monitoring.browser.maxViewportsPerRun": 6, "monitoring.functional.enabled": true });
  await env.startBrowserWorker({ jobTimeoutMs: JOB_MS });
}, 120_000);
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  for (const q of Object.values(env.queues)) await q.obliterate({ force: true });
  await env.close();
});

async function newOrg() {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  const o = await seedOrg(c, 0, { tag: "cmp4f" });
  orgs.push(o.orgId);
  await entitleBrowser(env, o.orgId);
  return o.orgId;
}
async function site(orgId: string, path: string, browserCheck: Record<string, unknown> = {}, o: { acknowledge?: boolean } = {}) {
  const host = `cmp-${randomBytes(3).toString("hex")}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  // Phase 4H: interactions need the customer's risk acknowledgement (normally recorded by the API from the signed-in user)
  const fn = browserCheck.functional as Record<string, unknown> | undefined;
  if (fn?.enabled && o.acknowledge !== false) fn.riskAcknowledgement = { version: 1, at: new Date().toISOString(), by: randomUUID() };
  // release readiness (blocker 9): explicit safe destinations are mandatory; these fixture pages all live under /c
  if (fn?.enabled && !fn.allowedPaths) fn.allowedPaths = ["/c"];
  await c.query(`INSERT INTO monitoring_configurations (org_id, website_id, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, now())
                 ON CONFLICT (website_id) DO UPDATE SET browser_check = EXCLUDED.browser_check`, [orgId, id, JSON.stringify({ path, extraViewportsPerRun: 0, ...browserCheck })]);
  return { id, host };
}
async function nextWindow(w: string) {
  const { rows } = await c.query<{ id: string; min: Date }>(`SELECT id, (SELECT min(queued_at) FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER') AS min
    FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' ORDER BY queued_at DESC LIMIT 1`, [w]);
  const cur = rows[0];
  if (!cur) return;
  const t = new Date(cur.min.getTime() - 900_000);
  await c.query(`UPDATE monitoring_executions SET queued_at = $2, slot = floor(extract(epoch FROM $2::timestamptz)) WHERE id = $1`, [cur.id, t]);
  for (const tb of ["page_test_results", "responsive_test_results", "component_test_results"]) await c.query(`UPDATE ${tb} SET tested_at = $2 WHERE execution_id = $1`, [cur.id, t]);
  await c.query(`UPDATE performance_metrics SET measured_at = $2 WHERE execution_id = $1`, [cur.id, t]);
  await c.query(`UPDATE execution_results SET window_start = $2 WHERE execution_id = $1`, [cur.id, t]);
  await c.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second', state_window_at = LEAST(state_window_at, $2) WHERE website_id = $1 AND tier = 'T2_RENDER'`, [w, t]);
}
async function run(w: string, first = false) {
  if (!first) await nextWindow(w);
  const n = first ? 0 : (await ledger(env, w)).length; // first: an earlier cycle may already have run it
  await env.scheduler().runCycle();
  await until(async () => (await ledger(env, w)).length > n, JOB_MS + 30_000, 250);
  return (await ledger(env, w)).at(-1)!;
}
const components = async (w: string, status = "PRESENT") => (await c.query(`SELECT type::text AS type, evidence->>'key' AS key, label, status, viewports, detail, missed_runs FROM page_components WHERE website_id = $1 AND ($2 = 'ALL' OR status = $2) ORDER BY type, key`, [w, status])).rows as Array<Record<string, any>>;
const events = async (w: string) => (await c.query(`SELECT e.type, c.type::text AS component FROM component_events e JOIN page_components c ON c.id = e.page_component_id WHERE e.website_id = $1 ORDER BY e.id`, [w])).rows as Array<{ type: string; component: string }>;
const tests = async (exec: string) => (await c.query(`SELECT test_kind, component_type::text AS component_type, target, viewport, status::text AS status, coverage_note, failure_reason, safety FROM component_test_results WHERE execution_id = $1 ORDER BY test_kind, target`, [exec])).rows as Array<Record<string, any>>;
const responsive = async (exec: string) => (await c.query(`SELECT viewport, status::text AS status, nav_state, horizontal_overflow_px, "overlaps", clipped_text, obscured_controls, offscreen_controls, findings FROM responsive_test_results WHERE execution_id = $1 ORDER BY width DESC`, [exec])).rows as Array<Record<string, any>>;
/** The tripwires: destructive endpoints and any non-GET request reaching the fixture website. */
function assertNoDangerousRequests(host: string) {
  expect(env.site.toggles.get(`${host}#danger-hit`), "a destructive endpoint was reached").toBeUndefined();
  const bad = env.site.hits.filter((h) => h.host === host && (h.method !== "GET" && h.method !== "HEAD" || /^\/c\/(danger|logout|account\/delete)/.test(h.path)));
  expect(bad, JSON.stringify(bad)).toEqual([]);
}

// =====================================================================================================
describe("component detection (passive)", () => {
  it("detects the page's components with stable identity; a second run adds nothing; no interaction when functional tests are off", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop");
    const l1 = await run(s.id, true);
    expect(l1.outcome).toBe("PASSED");
    const inv = await components(s.id);
    const types = new Set(inv.map((x) => x.type));
    for (const t of ["HEADER", "NAV", "FOOTER", "SEARCH", "FORM", "BUTTON", "ACCORDION", "CARD_GROUP", "IMAGE", "RESPONSIVE_NAV"]) expect(types.has(t), t).toBe(true);
    expect(inv.filter((x) => x.type === "FORM")).toHaveLength(2); // contact + sign-in (search form is the SEARCH component)
    const nav = inv.find((x) => x.type === "NAV")!;
    expect(nav.detail.links).toEqual(expect.arrayContaining(["/c/shop", "/c/about", "/c/products"]));
    const contact = inv.find((x) => x.type === "FORM" && x.label === "Contact us")!;
    expect(contact.detail).toMatchObject({ method: "post", action: "/c/contact", sensitive: false });
    expect(inv.find((x) => x.type === "FORM" && x.label === "Sign in")!.detail.sensitive).toBe(true);
    expect(await events(s.id)).toEqual([]); // the first run is the baseline
    // second run: identical inventory, no events, no duplicates
    await run(s.id);
    expect((await components(s.id)).map((x) => `${x.type}|${x.key}`)).toEqual(inv.map((x) => `${x.type}|${x.key}`));
    expect(await events(s.id)).toEqual([]);
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM page_components WHERE website_id = $1`, [s.id]);
    expect(n).toBe(inv.length);
    // passive mode: no functional rows at desktop (the mobile-menu probe only runs where the menu is collapsed)
    expect((await tests(l1.execution_id)).filter((t) => t.test_kind !== "RESPONSIVE_NAV")).toEqual([]);
    assertNoDangerousRequests(s.host);
  }, 300_000);

  it("changes, removals (after two complete runs only) and restorations are recorded; a failed load never removes anything", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop");
    await run(s.id, true);
    env.site.toggles.set(`${s.host}#c`, "nav-changed");
    await run(s.id);
    expect(await events(s.id)).toEqual([{ type: "CHANGED", component: "NAV" }]);
    // search disappears: one run = missed (no event), second run = REMOVED
    env.site.toggles.set(`${s.host}#c`, "no-search");
    await run(s.id);
    expect((await events(s.id)).map((e) => e.type)).toEqual(["CHANGED", "CHANGED"]); // nav reverted to its original links; the missing search is only "missed"
    expect((await components(s.id, "ALL")).find((x) => x.type === "SEARCH")).toMatchObject({ status: "PRESENT", missed_runs: 1 });
    // an incomplete run (page down) does not advance removal
    env.site.toggles.set(s.host, "down");
    await c.query(`UPDATE monitoring_configurations SET browser_check = browser_check || '{"path":"/toggle"}' WHERE website_id = $1`, [s.id]);
    await run(s.id);
    await c.query(`UPDATE monitoring_configurations SET browser_check = browser_check || '{"path":"/c/shop"}' WHERE website_id = $1`, [s.id]);
    env.site.toggles.delete(s.host);
    expect((await components(s.id, "ALL")).find((x) => x.type === "SEARCH")).toMatchObject({ status: "PRESENT", missed_runs: 1 });
    await run(s.id);
    expect((await components(s.id, "ALL")).find((x) => x.type === "SEARCH")).toMatchObject({ status: "REMOVED", missed_runs: 2 });
    // the search form's own "Search" button went with it: both are removed in the same run
    expect((await events(s.id)).filter((e) => e.type === "REMOVED").map((e) => e.component).sort()).toEqual(["BUTTON", "SEARCH"]);
    env.site.toggles.delete(`${s.host}#c`);
    await run(s.id);
    expect((await events(s.id)).filter((e) => e.component === "SEARCH").map((e) => e.type)).toEqual(["REMOVED", "RESTORED"]);
    expect((await components(s.id)).find((x) => x.type === "SEARCH")!.status).toBe("PRESENT");
    assertNoDangerousRequests(s.host);
  }, 420_000);
});

// =====================================================================================================
describe("safe functional tests", () => {
  it("search, navigation, forms (never submitted) and safe buttons pass; every destructive control is skipped and never reached", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop", { functional: { enabled: true, maxNavigationLinks: 3, maxButtons: 5 } });
    const l = await run(s.id, true);
    const t = await tests(l.execution_id);
    const by = (kind: string, target: RegExp) => t.find((x) => x.test_kind === kind && target.test(x.target));
    expect(by("SEARCH", /Search/)).toMatchObject({ status: "PASSED", safety: "SAFE" });
    expect(by("NAVIGATION", /About → \/c\/about/)).toMatchObject({ status: "PASSED" });
    expect(by("NAVIGATION", /Products/)).toMatchObject({ status: "PASSED" });
    expect(by("NAVIGATION", /Log out/)).toMatchObject({ status: "SKIPPED", safety: "UNSAFE" });
    expect(by("NAVIGATION", /Delete account/)).toMatchObject({ status: "SKIPPED", safety: "UNSAFE" });
    expect(by("FORM", /Contact us/)).toMatchObject({ status: "PASSED" });
    expect(by("FORM", /Sign in/)).toMatchObject({ status: "SKIPPED", coverage_note: "form has password, payment or file fields" });
    expect(by("BUTTON", /Show more/)).toMatchObject({ status: "PASSED" });
    expect(by("BUTTON", /Shipping FAQ/)).toMatchObject({ status: "PASSED" });
    for (const label of [/Buy now/, /Delete account/, /Log out/, /Send message/, /Sign in/]) expect(by("BUTTON", label), String(label)).toMatchObject({ status: "SKIPPED", safety: "UNSAFE" });
    expect(by("BUTTON", /^OK$/)).toMatchObject({ status: "SKIPPED", safety: "UNKNOWN" });
    expect(t.filter((x) => x.status === "FAILED")).toEqual([]);
    expect(l.outcome).toBe("PASSED");
    // typed values are never stored; the search query appears only as the request the browser made
    expect(JSON.stringify(t)).not.toContain("not-an-email");
    assertNoDangerousRequests(s.host);
    expect(env.site.hits.some((h) => h.host === s.host && h.path === "/c/search")).toBe(true);
    expect(env.site.hits.filter((h) => h.host === s.host && h.path === "/c/contact")).toEqual([]); // the form was never submitted
  }, 300_000);

  it("broken search, a broken navigation link, a form that accepts invalid input and a button that throws all FAIL — and open a functional incident", async () => {
    const org = await newOrg();
    const search = await site(org, "/c/shop", { functional: { enabled: true, navigation: false, forms: false, buttons: false } });
    env.site.toggles.set(`${search.host}#c`, "broken-search");
    const nav = await site(org, "/c/shop", { functional: { enabled: true, search: false, forms: false, buttons: false } });
    env.site.toggles.set(`${nav.host}#c`, "broken-link");
    const form = await site(org, "/c/bad-form", { functional: { enabled: true } });
    const button = await site(org, "/c/js-button", { functional: { enabled: true } });
    const l1 = await run(search.id, true), l2 = await run(nav.id, true), l3 = await run(form.id, true), l4 = await run(button.id, true);
    expect((await tests(l1.execution_id)).find((x) => x.test_kind === "SEARCH")).toMatchObject({ status: "FAILED", failure_reason: "SEARCH_HTTP_500" });
    expect((await tests(l2.execution_id)).find((x) => x.test_kind === "NAVIGATION" && /Products/.test(x.target))).toMatchObject({ status: "FAILED", failure_reason: "NAV_HTTP_404" });
    expect((await tests(l3.execution_id)).find((x) => x.test_kind === "FORM")).toMatchObject({ status: "FAILED", failure_reason: "FORM_ACCEPTS_INVALID_INPUT" });
    expect((await tests(l4.execution_id)).find((x) => x.test_kind === "BUTTON")).toMatchObject({ status: "FAILED", failure_reason: "BUTTON_SCRIPT_ERROR" });
    for (const l of [l1, l2, l3, l4]) expect(l.outcome).toBe("FAILED");
    // two consecutive failures → one functional incident (normal thresholds)
    await run(search.id);
    const inc = await incidentsOf(c, search.id);
    expect(inc.map((i) => [i.check_key, i.category, i.status])).toEqual([["browser.functional", "FUNCTIONAL", "OPEN"]]);
    for (const h of [search.host, nav.host, form.host, button.host]) assertNoDangerousRequests(h);
  }, 420_000);

  it("Phase 4G: a safe-looking toggle whose handler fires side-effecting GETs is caught by the guard and skipped — nothing is sent", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/sneaky-get", { functional: { enabled: true } });
    env.site.toggles.set(`${s.host}#tracker`, `tracker-${s.host.split(".")[0]}.example`);
    const tracker = `tracker-${s.host.split(".")[0]}.example`; // a different registrable domain: genuinely third-party
    env.dns.setA(tracker, ["127.0.0.1"]);
    const l = await run(s.id, true);
    const t = (await tests(l.execution_id)).find((x) => x.test_kind === "BUTTON" && /Show details/.test(x.target));
    expect(t).toMatchObject({ status: "SKIPPED", safety: "UNSAFE" });
    expect(t!.coverage_note).toMatch(/blocked by the safety guard/);
    expect(l.outcome).toBe("PASSED");
    assertNoDangerousRequests(s.host);
    expect(env.site.hits.filter((h) => h.host === s.host && /^\/c\/(danger|confirm)/.test(h.path))).toEqual([]);
    expect(env.site.hits.filter((h) => h.host === tracker)).toEqual([]);
  }, 180_000);

  it("release readiness (blocker 5): the gateway enforces the website's third-party policy for every resource type, frames and redirects", async () => {
    const org = await newOrg();
    const run3p = async (thirdParty: Record<string, unknown>) => {
      const s = await site(org, "/c/third-party", { thirdParty, viewports: ["desktop"], extraViewportsPerRun: 0 });
      const third = `third-${s.host.split(".")[0]}.example`; // a different registrable domain
      env.dns.setA(third, ["127.0.0.1"]);
      env.site.toggles.set(`${s.host}#third`, third);
      const l = await run(s.id, true);
      return { s, third, l, hits: env.site.hits.filter((h) => h.host === third).map((h) => h.path).sort() };
    };
    // none: not one request reaches the third party — script, stylesheet, image, iframe, fetch, XHR, WebSocket, redirect target
    const none = await run3p({ mode: "none" });
    expect(none.hits).toEqual([]);
    // it is the GATEWAY that refused (not page logic): its own decision log names the third-party policy
    const refusals = env.gatewayLog.filter((l) => l.host === none.third && l.outcome === "BLOCKED_HOST" && l.detail === "third-party-disallowed");
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(env.gatewayLog.filter((l) => l.host === none.third && l.outcome === "ALLOWED")).toEqual([]);
    expect(env.site.hits.some((h) => h.host === none.s.host && h.path === "/c/redirect-out")).toBe(true); // the first-party hop happened
    // all (default): the same page loads its third-party resources through the gateway
    const all = await run3p({ mode: "all" });
    expect(all.hits).toEqual(expect.arrayContaining(["/tp/script.js", "/tp/pixel.png", "/tp/frame.html", "/tp/redirected.png", "/tp/fetch", "/tp/xhr", "/tp/ws"]));
    // allowlist that does not include the third party: blocked like none
    const listed = await run3p({ mode: "allowlist", allowedDomains: ["cdn.unrelated.example"] });
    expect(listed.hits).toEqual([]);
    // budget 0 with mode all: no distinct third-party host admitted
    const budget = await run3p({ mode: "all", maxHosts: 0 });
    expect(budget.hits).toEqual([]);
    for (const x of [none, all, listed, budget]) assertNoDangerousRequests(x.s.host);
  }, 420_000);

  it("release readiness (blocker 9): while interacting, no first-party request of ANY type leaves for a path outside the declared ones unless the page load already made it", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/innocent-toggle", { functional: { enabled: true, navigation: true, search: false, forms: false, buttons: true, allowedPaths: ["/c/products"] } });
    const l = await run(s.id, true);
    const t = await tests(l.execution_id);
    expect(t.find((x) => x.test_kind === "BUTTON" && /More details/.test(x.target))?.status).toBeDefined(); // the button WAS clicked
    expect(t.find((x) => x.test_kind === "NAVIGATION" && /Products/.test(x.target))).toMatchObject({ status: "PASSED" }); // allowed path used
    const sideEffects = env.site.hits.filter((h) => h.host === s.host && /^\/c\/(mark-seen|track\.js|theme-switch\.css|widget-state|state-toggle)/.test(h.path));
    expect(sideEffects, JSON.stringify(sideEffects.map((h) => h.path))).toEqual([]);
    // without a declared path, interactions do not run at all
    const none = await site(org, "/c/innocent-toggle", { functional: { enabled: true, allowedPaths: [] } });
    const l2 = await run(none.id, true);
    expect((await tests(l2.execution_id)).filter((x) => x.test_kind !== "RESPONSIVE_NAV")).toEqual([]);
    expect(env.site.hits.filter((h) => h.host === none.host && h.path !== "/c/innocent-toggle" && /^\/c\//.test(h.path) && !/\.(css|js|png|svg|ico)$/.test(h.path))).toEqual([]);
    assertNoDangerousRequests(s.host);
  }, 420_000);

  it("Phase 4H: no interaction without the platform switch AND the customer's risk acknowledgement; allowed paths confine destinations", async () => {
    const org = await newOrg();
    const cfg = { functional: { enabled: true, search: false, forms: false, buttons: false, maxNavigationLinks: 3 } };
    // 1. enabled but never acknowledged → nothing is clicked (only the passive mobile-menu probe may run)
    const noAck = await site(org, "/c/shop", structuredClone(cfg), { acknowledge: false });
    const l1 = await run(noAck.id, true);
    const t1 = await tests(l1.execution_id);
    expect(t1.filter((x) => x.test_kind !== "RESPONSIVE_NAV"), JSON.stringify(t1)).toEqual([]);
    expect(env.site.hits.filter((h) => h.host === noAck.host && h.path === "/c/about")).toEqual([]);
    // 2. acknowledged, but the platform switch is off → nothing is clicked
    await setSettings(c, { "monitoring.functional.enabled": false });
    await new Promise((res) => setTimeout(res, 11_000)); // the kill switch applies within the engine's 10 s settings cache
    try {
      const off = await site(org, "/c/shop", structuredClone(cfg));
      const l2 = await run(off.id, true);
      expect((await tests(l2.execution_id)).filter((x) => x.test_kind !== "RESPONSIVE_NAV")).toEqual([]);
      expect(env.site.hits.filter((h) => h.host === off.host && h.path === "/c/about")).toEqual([]);
    } finally {
      await setSettings(c, { "monitoring.functional.enabled": true });
      await new Promise((res) => setTimeout(res, 11_000));
    }
    // 3. destination policy: only /c/products may be opened — About is refused by the guard, Products is tested
    const confined = await site(org, "/c/shop", { functional: { ...cfg.functional, allowedPaths: ["/c/products"] } });
    const l3 = await run(confined.id, true);
    const t3 = await tests(l3.execution_id);
    expect(t3.find((x) => /Products/.test(x.target))).toMatchObject({ status: "PASSED" });
    expect(t3.find((x) => /About/.test(x.target))?.status).not.toBe("PASSED");
    expect(t3.filter((x) => x.status === "FAILED")).toEqual([]);
    expect(env.site.hits.filter((h) => h.host === confined.host && h.path === "/c/about")).toEqual([]);
    expect(l3.outcome).toBe("PASSED");
    assertNoDangerousRequests(confined.host);
  }, 420_000);

  it("gateway refusals and time budgets are SKIPPED / INCONCLUSIVE, never website failures", async () => {
    const org = await newOrg();
    // a navigation link whose host resolves to a private address: the gateway refuses it
    // the partner link's destination ("/" on a subdomain) must be a declared destination, or it is not clicked at all
    const s = await site(org, "/c/shop", { functional: { enabled: true, search: false, forms: false, buttons: false, maxNavigationLinks: 5, allowedPaths: ["/c", "/"] } });
    env.site.toggles.set(`${s.host}#c`, "blocked-link");
    env.dns.setA(`blocked.${s.host}`, ["10.0.0.1"]);
    const l = await run(s.id, true);
    const partner = (await tests(l.execution_id)).find((x) => /Partner/.test(x.target))!;
    expect(partner.status).toBe("INCONCLUSIVE");
    expect(partner.coverage_note).toMatch(/BLOCKED/);
    expect(l.outcome).toBe("PASSED");
    // partial execution: a 5 s budget with a 4 s page → later tests are skipped for TIME_BUDGET
    const slow = await site(org, "/c/shop", { functional: { enabled: true, budgetMs: 5000, maxNavigationLinks: 3, maxButtons: 3 } });
    env.site.toggles.set(`${slow.host}#c`, "slow-about");
    const l2 = await run(slow.id, true);
    const t2 = await tests(l2.execution_id);
    expect(t2.some((x) => x.status === "SKIPPED" && x.coverage_note === "TIME_BUDGET")).toBe(true);
    expect(t2.filter((x) => x.status === "FAILED")).toEqual([]);
    expect(l2.outcome).toBe("PASSED");
    assertNoDangerousRequests(s.host);
    assertNoDangerousRequests(slow.host);
  }, 300_000);

  it("the gateway dying during interactions makes tests INCONCLUSIVE (our infrastructure), not failures", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop", { functional: { enabled: true, search: false, forms: false, buttons: false, maxNavigationLinks: 3 } });
    env.site.toggles.set(`${s.host}#c`, "slow-about");
    // a dedicated runner whose gateway is a killable proxy in front of the real gateway
    const gw = new URL(env.gatewayUrl);
    const socks = new Set<Socket>();
    const proxy = createServer((cl) => { const up = connect(Number(gw.port), gw.hostname); socks.add(cl); socks.add(up); cl.pipe(up).pipe(cl); cl.on("error", () => up.destroy()); up.on("error", () => cl.destroy()); });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const runner = new BrowserRunner({ gatewayUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", maxSessions: 2, maxSessionMs: 120_000, sandbox: true });
    const runnerUrl = `http://127.0.0.1:${await runner.listen(0)}`;
    await env.stopBrowserWorkers();
    try {
      await env.startBrowserWorker({ runnerUrl, jobTimeoutMs: JOB_MS });
      const n = (await ledger(env, s.id)).length;
      await env.scheduler().runCycle();
      await until(async () => env.site.hits.some((h) => h.host === s.host && h.path === "/c/about"), 60_000, 100);
      proxy.close();
      for (const x of socks) x.destroy();
      await until(async () => (await ledger(env, s.id)).length > n, JOB_MS + 30_000, 250);
      const l = (await ledger(env, s.id)).at(-1)!;
      const t = await tests(l.execution_id);
      expect(t.find((x) => /About/.test(x.target))).toMatchObject({ status: "INCONCLUSIVE" });
      expect(t.filter((x) => x.status === "FAILED")).toEqual([]);
      expect(l.outcome).not.toBe("FAILED");
    } finally {
      proxy.close();
      await env.stopBrowserWorkers();
      await runner.stop();
      await env.startBrowserWorker({ jobTimeoutMs: JOB_MS });
    }
  }, 300_000);
});

// =====================================================================================================
describe("responsive matrix", () => {
  it("covers all six viewports; a working mobile menu passes, a broken one fails; covered controls fail; clipped text is a heuristic", async () => {
    const org = await newOrg();
    const all = ["desktop", "desktop-large", "tablet", "mobile-landscape", "mobile-large", "mobile-small"];
    const cfg = { viewports: all, extraViewportsPerRun: 5 };
    const ok = await site(org, "/c/shop", cfg);
    const broken = await site(org, "/c/mobile-nav-broken", cfg);
    const overlap = await site(org, "/c/overlap", { viewports: ["desktop"] });
    const clipped = await site(org, "/c/clipped", { viewports: ["desktop"] });
    const l1 = await run(ok.id, true);
    const r1 = await responsive(l1.execution_id);
    expect(r1.map((r) => r.viewport).sort()).toEqual([...all].sort());
    expect(r1.find((r) => r.viewport === "desktop")).toMatchObject({ status: "PASSED", nav_state: "VISIBLE" });
    for (const v of ["mobile-small", "mobile-large"]) expect(r1.find((r) => r.viewport === v), v).toMatchObject({ status: "PASSED", nav_state: "COLLAPSED_OK" });
    expect((await tests(l1.execution_id)).filter((t) => t.test_kind === "RESPONSIVE_NAV" && t.status === "PASSED").length).toBeGreaterThanOrEqual(2);
    expect(l1.outcome).toBe("PASSED");
    const l2 = await run(broken.id, true);
    const r2 = await responsive(l2.execution_id);
    expect(r2.find((r) => r.viewport === "mobile-small")).toMatchObject({ status: "FAILED", nav_state: "BROKEN" });
    expect(r2.find((r) => r.viewport === "desktop")).toMatchObject({ status: "PASSED", nav_state: "VISIBLE" });
    expect(r2.find((r) => r.viewport === "mobile-small")!.findings.heuristic.join(" ")).toMatch(/nav .* visible on wider screens but not here/);
    expect(l2.outcome).toBe("FAILED");
    const kinds = (await c.query(`SELECT DISTINCT failure_kind FROM page_test_results WHERE execution_id = $1 AND failure_kind IS NOT NULL`, [l2.execution_id])).rows.map((x) => x.failure_kind);
    expect(kinds.some((k: string) => /^NAV_BROKEN_MOBILE/.test(k))).toBe(true);
    const l3 = await run(overlap.id, true);
    const r3 = (await responsive(l3.execution_id))[0]!;
    expect(r3.obscured_controls).toBeGreaterThan(0);
    expect(r3.overlaps).toBeGreaterThan(0);
    expect(r3.status).toBe("FAILED");
    const l4 = await run(clipped.id, true);
    const r4 = (await responsive(l4.execution_id))[0]!;
    expect(r4.clipped_text).toBeGreaterThan(0);
    expect(r4.status).toBe("PASSED"); // heuristic only
    for (const h of [ok.host, broken.host, overlap.host, clipped.host]) assertNoDangerousRequests(h);
  }, 420_000);
});

// =====================================================================================================
describe("idempotency, retries and cancellation", () => {
  it("an execution processed again writes nothing; a crash after the interactions retries the whole run and records it once", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop", { functional: { enabled: true, maxNavigationLinks: 1, maxButtons: 1 } });
    // first attempt dies after navigation and interactions, before persisting (a simulated worker crash)
    let crashes = 0;
    await env.stopBrowserWorkers();
    await env.startBrowserWorker({ jobTimeoutMs: JOB_MS, hooks: { afterNavigate: () => { if (crashes++ === 0) throw new Error("simulated crash before persistence"); } } });
    try {
      const l = await run(s.id, true);
      expect(l.attempt).toBe(2);
      const t = await tests(l.execution_id);
      const perKind = (k: string) => t.filter((x) => x.test_kind === k).length;
      expect(perKind("SEARCH")).toBe(1); // not duplicated by the retry
      const snapshot = async () => ({
        comps: (await c.query(`SELECT count(*)::int AS n FROM page_components WHERE website_id = $1`, [s.id])).rows[0].n,
        ev: (await c.query(`SELECT count(*)::int AS n FROM component_events WHERE website_id = $1`, [s.id])).rows[0].n,
        tests: (await c.query(`SELECT count(*)::int AS n FROM component_test_results WHERE website_id = $1`, [s.id])).rows[0].n,
        ledger: (await ledger(env, s.id)).length,
      });
      const before = await snapshot();
      const { rows: [ex] } = await c.query(`SELECT queued_at FROM monitoring_executions WHERE id = $1`, [l.execution_id]);
      const engine = createBrowserEngine({ db: env.db, redis: env.redis, prefix: PREFIX_4C, log: createLogger("x", { level: "silent" }), gatewayUrl: env.gatewayUrl, tokenSecret: EGRESS_SECRET_4C, runnerUrl: env.runnerUrl, s3: null, jobTimeoutMs: async () => JOB_MS });
      const hitsBefore = env.site.hits.length;
      const out = await engine({ executionId: l.execution_id, orgId: org, websiteId: s.id, tier: "BROWSER", attempt: 3, maxAttempts: 3, windowStart: ex.queued_at, signal: new AbortController().signal });
      expect(out.summary).toMatchObject({ duplicate: true });
      expect(env.site.hits.length).toBe(hitsBefore); // no navigation, no interaction
      expect(await snapshot()).toEqual(before);
    } finally {
      await env.stopBrowserWorkers();
      await env.startBrowserWorker({ jobTimeoutMs: JOB_MS });
    }
    assertNoDangerousRequests(s.host);
  }, 300_000);

  it("cancellation during the functional tests: no result, no components, no test rows", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/shop", { functional: { enabled: true, search: false, forms: false, buttons: false, maxNavigationLinks: 3 } });
    env.site.toggles.set(`${s.host}#c`, "slow-about");
    await env.scheduler().runCycle();
    await until(async () => env.site.hits.some((h) => h.host === s.host && h.path === "/c/about"), 60_000, 100);
    const { rows: [ex] } = await c.query(`SELECT id FROM monitoring_executions WHERE website_id = $1 AND tier = 'T2_RENDER' ORDER BY queued_at DESC LIMIT 1`, [s.id]);
    await c.query(`UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = $1`, [ex.id]);
    await until(async () => (await c.query(`SELECT status::text FROM monitoring_executions WHERE id = $1`, [ex.id])).rows[0].status === "CANCELLED", 30_000, 200);
    expect((await ledger(env, s.id))).toHaveLength(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM component_test_results WHERE execution_id = $1`, [ex.id])).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int AS n FROM page_components WHERE website_id = $1`, [s.id])).rows[0].n).toBe(0);
    assertNoDangerousRequests(s.host);
  }, 180_000);
});

// =====================================================================================================
describe("database rules", () => {
  it("functional rows need the execution's ledger row; component rows can't cross tenants; the customer role can only read", async () => {
    const a = await newOrg();
    const sa = await site(a, "/c/shop");
    const l = await run(sa.id, true);
    const { rows: [mp] } = await c.query(`SELECT id FROM monitored_pages WHERE website_id = $1`, [sa.id]);
    const b = await newOrg();
    const sb = await site(b, "/c/shop");
    await expect(c.query(`INSERT INTO component_test_results (tested_at, org_id, website_id, monitored_page_id, execution_id, component_type, viewport, status, confidence)
      VALUES (now(), $1, $2, $3, gen_random_uuid(), 'SEARCH', 'desktop', 'PASSED', 1)`, [a, sa.id, mp.id])).rejects.toThrow(/ledger/);
    await expect(c.query(`INSERT INTO page_components (org_id, website_id, monitored_page_id, type, selector, dom_path_hash, confidence, evidence)
      VALUES ($1, $2, $3, 'NAV', 'x', 'forged', 1, '{}')`, [b, sb.id, mp.id])).rejects.toThrow(/does not match/);
    const g = (await c.query(`SELECT has_table_privilege('wim_app','page_components','INSERT') AS a, has_table_privilege('wim_app','component_test_results','UPDATE') AS b,
      has_table_privilege('wim_app','component_events','INSERT') AS c2, has_table_privilege('wim_app','page_components','SELECT') AS r, has_table_privilege('wim_admin','page_components','SELECT') AS adm`)).rows[0];
    expect(g).toEqual({ a: false, b: false, c2: false, r: true, adm: false });
    void l;
  }, 180_000);
});
