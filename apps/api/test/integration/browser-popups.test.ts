import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetMonitoringSettings, seedOrg, until } from "../helpers/monitoring.js";
import { addVerifiedSite } from "../helpers/http-monitoring.js";
import { BROWSER_QUEUE_POLICY, browserSettings, entitleBrowser, ledger, startBrowserEnv, type BrowserEnv } from "../helpers/browser-monitoring.js";

/**
 * Popups on load (cookie banners, newsletter modals, interstitials) and JavaScript dialogs, with REAL Chromium (sandbox
 * on) through the production runner service and the real egress gateway. The fixture popups carry traps: an "Accept
 * all" that records consent, a "Reject all" whose handler POSTs a consent record and calls a third-party tracker, a
 * "Subscribe" form, links to other pages. Closing must use the privacy-preserving control and send nothing.
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
  const o = await seedOrg(c, 0, { tag: "popup" });
  orgs.push(o.orgId);
  await entitleBrowser(env, o.orgId);
  return o.orgId;
}
async function site(orgId: string, path: string, browserCheck: Record<string, unknown> = {}) {
  const host = `pop-${randomBytes(3).toString("hex")}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  const fn = browserCheck.functional as Record<string, unknown> | undefined;
  if (fn?.enabled) { fn.riskAcknowledgement = { version: 1, at: new Date().toISOString(), by: randomUUID() }; fn.allowedPaths ??= ["/c"]; }
  await c.query(`INSERT INTO monitoring_configurations (org_id, website_id, browser_check, updated_at) VALUES ($1, $2, $3::jsonb, now())
                 ON CONFLICT (website_id) DO UPDATE SET browser_check = EXCLUDED.browser_check`, [orgId, id, JSON.stringify({ path, viewports: ["desktop"], extraViewportsPerRun: 0, ...browserCheck })]);
  return { id, host };
}
async function run(w: string) {
  await env.scheduler().runCycle();
  await until(async () => (await ledger(env, w)).length > 0, JOB_MS + 30_000, 250);
  return (await ledger(env, w)).at(-1)!;
}
const results = async (exec: string) => (await c.query(`SELECT viewport, status::text AS status, failure_kind, details FROM page_test_results WHERE execution_id = $1 ORDER BY width DESC`, [exec])).rows as Array<{ viewport: string; status: string; failure_kind: string | null; details: Record<string, any> }>;
const responsive = async (exec: string) => (await c.query(`SELECT viewport, status::text AS status, obscured_controls FROM responsive_test_results WHERE execution_id = $1`, [exec])).rows as Array<Record<string, any>>;
const perf = async (exec: string) => (await c.query(`SELECT viewport, fcp_ms, lcp_ms, cls, ttfb_ms, load_ms FROM performance_metrics WHERE execution_id = $1`, [exec])).rows as Array<Record<string, any>>;
const tests = async (exec: string) => (await c.query(`SELECT test_kind, target, status::text AS status, failure_reason FROM component_test_results WHERE execution_id = $1`, [exec])).rows as Array<Record<string, any>>;
/** nothing but GETs reached the website, none to a trap; nothing reached the tracker */
function assertNothingSent(host: string, tracker?: string) {
  expect(env.site.toggles.get(`${host}#danger-hit`), "a destructive endpoint was reached").toBeUndefined();
  const bad = env.site.hits.filter((h) => h.host === host && (h.method !== "GET" && h.method !== "HEAD" || /^\/c\/(danger|consent|subscribe|join|offers|privacy)/.test(h.path)));
  expect(bad, JSON.stringify(bad.map((b) => `${b.method} ${b.path}`))).toEqual([]);
  if (tracker) expect(env.site.hits.filter((h) => h.host === tracker)).toEqual([]);
}

describe("popups on load", () => {
  it("cookie banner: closed with 'Reject all' (never 'Accept all'), nothing sent, no CONTROLS_OBSCURED, a warning, performance still measured; functional tests reach the covered controls", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/popup-cookie", { functional: { enabled: true, maxNavigationLinks: 1, maxButtons: 3, search: false, forms: false } });
    const tracker = `tracker-${s.host.split(".")[0]}.example`;
    env.site.toggles.set(`${s.host}#tracker`, tracker);
    env.dns.setA(tracker, ["127.0.0.1"]);
    const l = await run(s.id);
    const [r] = await results(l.execution_id);
    expect(r!.details.overlay).toMatchObject({ found: true, kind: "COOKIE_CONSENT", dismissed: true, method: "REJECT", control: "Reject all" });
    expect(r!.details.overlay.items[0].selector).toBe("#cookie-consent-banner");
    expect(r!.details.overlay.blockedRequests).toBeGreaterThanOrEqual(2); // the consent POST, the tracker, the consent pixel: all refused
    expect(r!.details.warnings).toContain(`desktop: A cookie banner covered the page on load; closed with "Reject all"`);
    expect(r!.failure_kind).toBeNull();
    expect(l.outcome).toBe("PASSED");
    expect((await responsive(l.execution_id))[0]).toMatchObject({ status: "PASSED", obscured_controls: 0 });
    const p = (await perf(l.execution_id))[0]!;
    expect(p.fcp_ms).not.toBeNull();
    expect(p.load_ms).not.toBeNull();
    const t = await tests(l.execution_id);
    expect(t.find((x) => x.test_kind === "BUTTON" && /Show more/.test(x.target))).toMatchObject({ status: "PASSED" });
    expect(t.filter((x) => x.failure_reason === "BUTTON_NOT_CLICKABLE")).toEqual([]);
    assertNothingSent(s.host, tracker);
    // no consent of either kind was recorded with the website
    expect(env.site.hits.filter((h) => h.host === s.host && /consent/.test(h.path))).toEqual([]);
  }, 240_000);

  it("newsletter modal: closed with Escape; without Escape support, with its ✕ button — never Subscribe", async () => {
    const org = await newOrg();
    const esc = await site(org, "/c/popup-modal");
    const x = await site(org, "/c/popup-modal?noesc=1");
    const l1 = await run(esc.id);
    const [r1] = await results(l1.execution_id);
    expect(r1!.details.overlay).toMatchObject({ found: true, kind: "MODAL", dismissed: true, method: "ESCAPE" });
    expect(r1!.details.warnings.join(" ")).toMatch(/A popup dialog covered the page on load; closed with the Escape key/);
    expect(l1.outcome).toBe("PASSED");
    const l2 = await run(x.id);
    const [r2] = await results(l2.execution_id);
    expect(r2!.details.overlay).toMatchObject({ found: true, kind: "MODAL", dismissed: true, method: "CLOSE_BUTTON", control: "✕" });
    expect(l2.outcome).toBe("PASSED");
    for (const h of [esc.host, x.host]) assertNothingSent(h);
  }, 240_000);

  it("an interstitial that can't be closed fails with OVERLAY_BLOCKING (not CONTROLS_OBSCURED); the configured close button closes it", async () => {
    const org = await newOrg();
    const stuck = await site(org, "/c/popup-stuck");
    const sel = await site(org, "/c/popup-stuck", { popups: { closeSelector: "#promo .nl-x" } });
    const l1 = await run(stuck.id);
    const [r1] = await results(l1.execution_id);
    expect(l1.outcome).toBe("FAILED");
    expect(r1!.failure_kind).toBe("OVERLAY_BLOCKING_DESKTOP");
    expect(r1!.details.kinds).toEqual(["OVERLAY_BLOCKING_DESKTOP"]);
    expect(r1!.details.overlay).toMatchObject({ found: true, dismissed: false });
    expect(r1!.details.overlay.items[0]).toMatchObject({ kind: "OVERLAY", attempted: true, reason: "NO_SAFE_CONTROL", blocksPage: true });
    expect(r1!.details.overlay.coveredControls).toBeGreaterThan(0);
    expect((await responsive(l1.execution_id))[0]).toMatchObject({ obscured_controls: 0 });
    const l2 = await run(sel.id);
    const [r2] = await results(l2.execution_id);
    expect(r2!.details.overlay).toMatchObject({ found: true, dismissed: true, method: "CLOSE_SELECTOR" });
    expect(l2.outcome).toBe("PASSED");
    for (const h of [stuck.host, sel.host]) assertNothingSent(h);
  }, 240_000);

  it("closing switched off: no attempt, a warning only; covered controls are not reported as CONTROLS_OBSCURED", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/popup-cookie", { popups: { dismiss: false } });
    const l = await run(s.id);
    const [r] = await results(l.execution_id);
    expect(r!.details.overlay).toMatchObject({ found: true, kind: "COOKIE_CONSENT", dismissed: false, blockedRequests: 0 });
    expect(r!.details.overlay.items[0]).toMatchObject({ attempted: false, reason: "DISABLED" });
    expect(r!.details.warnings.join(" ")).toMatch(/closing popups is switched off/);
    expect(r!.failure_kind).toBeNull();
    expect(l.outcome).toBe("PASSED");
    assertNothingSent(s.host);
  }, 240_000);

  it("a JavaScript alert on load is dismissed and recorded as a warning (message scrubbed), never a failure", async () => {
    const org = await newOrg();
    const s = await site(org, "/c/js-alert");
    const l = await run(s.id);
    const [r] = await results(l.execution_id);
    expect(l.outcome).toBe("PASSED");
    expect(r!.details.dialogs).toMatchObject({ count: 1, items: [{ type: "alert" }] });
    expect(r!.details.dialogs.items[0].message).toMatch(/^Welcome to our shop!/);
    expect(JSON.stringify(r!.details)).not.toContain("sk_live_");
    expect(r!.details.warnings.join(" ")).toMatch(/opened 1 JavaScript dialog\(s\) \(alert\) — dismissed/);
    expect(r!.details.overlay).toMatchObject({ found: false });
    expect((await perf(l.execution_id))[0]!.fcp_ms).not.toBeNull();
  }, 240_000);
});
