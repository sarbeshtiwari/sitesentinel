import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, userWithOrg, type Harness } from "../helpers/harness.js";
import { addVerifiedSite, ensureTrial } from "../helpers/http-monitoring.js";

/**
 * Customer "Pages" inventory: discovered pages ∪ page URLs of the latest deep scan that no scan fetched yet (stopped at
 * its time limit) / failed / were skipped, offset pagination, filters, sort, the page score and the page detail with
 * its open findings. Data is seeded as the scanner would persist it; reads go through the real API as customers.
 */
let h: Harness;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => { h = await startHarness(); }, 120_000);
afterAll(async () => { await h.stop(); });

async function scan(orgId: string, websiteId: string, o: { status: string; stopReason?: string; startedAgoMin: number }) {
  const { rows: [e] } = await h.owner.query<{ id: string }>(`INSERT INTO monitoring_executions (org_id, website_id, tier, status, queued_at)
    VALUES ($1, $2, 'T3_DEEP', 'SUCCEEDED', date_trunc('milliseconds', now()) - make_interval(mins => $3)) RETURNING id`, [orgId, websiteId, o.startedAgoMin]);
  await h.owner.query(`INSERT INTO deep_scans (execution_id, org_id, website_id, status, complete, stop_reason, config, started_at, finished_at)
    VALUES ($1, $2, $3, $4, false, $5, '{}'::jsonb, now() - make_interval(mins => $6), now() - make_interval(mins => $6 - 10))`,
  [e!.id, orgId, websiteId, o.status, o.stopReason ?? null, o.startedAgoMin]);
  return e!.id;
}
async function url(exec: string, orgId: string, websiteId: string, u: string, o: { state: string; source?: string; status?: number; skip?: string; referrer?: string; inSitemap?: boolean; contentType?: string; title?: string }) {
  await h.owner.query(`INSERT INTO deep_scan_urls (execution_id, org_id, website_id, url_hash, url, kind, state, skip_reason, depth, source, in_sitemap, first_referrer, status_code, content_type, facts, checked_at)
    VALUES ($1, $2, $3, $4, $5, 'PAGE', $6, $7, 1, $8, $9, $10, $11, $12, $13::jsonb, CASE WHEN $6 IN ('DONE','FAILED') THEN now() - interval '5 minutes' END)`,
  [exec, orgId, websiteId, sha(u), u, o.state, o.skip ?? null, o.source ?? "CRAWL", o.inSitemap ?? false, o.referrer ?? null, o.status ?? null, o.contentType ?? (o.state === "DONE" ? "text/html" : null), JSON.stringify(o.title ? { title: o.title } : {})]);
}
async function discovered(orgId: string, websiteId: string, u: string, title: string) {
  const { rows: [d] } = await h.owner.query<{ id: string }>(`INSERT INTO discovered_pages (org_id, website_id, url, url_hash, path_template, source, depth, title)
    VALUES ($1, $2, $3, $4, $5, 'CRAWL', 1, $6) RETURNING id`, [orgId, websiteId, u, sha(u), new URL(u).pathname, title]);
  return d!.id;
}
async function finding(exec: string, orgId: string, websiteId: string, subject: string, category: string, group: string, severity: string, o: { status?: string; evidence?: Record<string, unknown>; resolvedAgoDays?: number } = {}) {
  const { rows: [f] } = await h.owner.query<{ id: string }>(`INSERT INTO scan_findings (org_id, website_id, fingerprint, category, group_key, severity, status, subject, title, evidence, recommendation, detection_method,
      first_detected_at, last_detected_at, resolved_at, first_execution_id, last_execution_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $4, $9::jsonb, 'Fix it.', 'HTML_ANALYSIS', now() - interval '2 days', now() - interval '1 hour',
      CASE WHEN $10::int IS NULL THEN NULL ELSE now() - make_interval(days => $10::int) END, $11, $11) RETURNING id`,
  [orgId, websiteId, `${category}:${subject}:${randomUUID()}`, category, group, severity, o.status ?? "OPEN", subject, JSON.stringify(o.evidence ?? {}), o.resolvedAgoDays ?? null, exec]);
  return f!.id;
}

describe("pages inventory", () => {
  it("lists discovered + not-yet-checked URLs with scores, pagination, filters, sort, detail and tenant isolation", async () => {
    const u = await userWithOrg(h.app, "pagesInv");
    await ensureTrial(h.owner, u.orgId);
    const host = `pages-${randomUUID().slice(0, 6)}.fixture.example`;
    const origin = `https://${host}`;
    const w = await addVerifiedSite(h.owner, u.orgId, origin);
    const api = `/api/v1/orgs/${u.orgId}/websites/${w}/pages`;

    // an older complete scan, then the latest one stopped at the time limit with 30 pages still queued
    const old = await scan(u.orgId, w, { status: "COMPLETED", startedAgoMin: 300 });
    const exec = await scan(u.orgId, w, { status: "PARTIAL", stopReason: "DURATION", startedAgoMin: 30 });
    const home = await discovered(u.orgId, w, `${origin}/`, "Home");
    const about = await discovered(u.orgId, w, `${origin}/about`, "About us");
    const gone = await discovered(u.orgId, w, `${origin}/gone`, "Gone");
    await url(old, u.orgId, w, `${origin}/gone`, { state: "DONE" });
    await url(exec, u.orgId, w, `${origin}/`, { state: "DONE", source: "START" });
    await url(exec, u.orgId, w, `${origin}/about`, { state: "DONE", inSitemap: true });
    await url(exec, u.orgId, w, `${origin}/gone`, { state: "FAILED", status: 404, referrer: `${origin}/` });
    for (let i = 0; i < 30; i++) await url(exec, u.orgId, w, `${origin}/p/${String(i).padStart(2, "0")}`, { state: "QUEUED", source: i % 2 ? "SITEMAP" : "CRAWL", inSitemap: i % 2 === 1, referrer: `${origin}/` });
    await url(exec, u.orgId, w, `${origin}/broken`, { state: "FAILED", status: 500, referrer: `${origin}/about` });
    await url(exec, u.orgId, w, `${origin}/admin`, { state: "SKIPPED", skip: "UNSAFE_ROUTE" });
    await url(exec, u.orgId, w, `${origin}/logo.svg`, { state: "DONE", contentType: "image/svg+xml" }); // a file, not a page
    await url(exec, u.orgId, w, `${origin}/search?q=…`, { state: "DONE", source: "SEARCH" }); // the scanner's own probe
    // findings: /about MEDIUM + LOW + INFO (100 − 8 − 3 = 89), /gone BROKEN_PAGE, a site-level duplicate naming /about
    const a1 = await finding(exec, u.orgId, w, `${origin}/about`, "IMG_MISSING_ALT", "accessibility", "MEDIUM", { evidence: { images: 3, authorization: "Bearer abcdefghijklmnop", note: "see https://x.example/?token=abc" } });
    await finding(exec, u.orgId, w, `${origin}/about`, "MISSING_DESCRIPTION", "seo", "LOW");
    await finding(exec, u.orgId, w, `${origin}/about`, "MISSING_CANONICAL", "seo", "INFO");
    await finding(exec, u.orgId, w, `${origin}/about`, "MISSING_H1", "seo", "MEDIUM", { status: "RESOLVED", resolvedAgoDays: 3 });
    await finding(exec, u.orgId, w, `${origin}/about`, "MISSING_LANG", "accessibility", "MEDIUM", { status: "RESOLVED", resolvedAgoDays: 45 });
    await finding(exec, u.orgId, w, `${origin}/gone`, "BROKEN_PAGE", "broken_pages", "HIGH", { evidence: { status: 404, linkedFrom: `${origin}/` } });
    await finding(exec, u.orgId, w, "site", "DUPLICATE_TITLE", "seo", "LOW", { evidence: { title: "x", pages: [`${origin}/about`, `${origin}/`], count: 2 } });

    // ---- list: union, totals, numbered pages
    const r1 = await u.client.get(`${api}?pageSize=10`);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const b1 = r1.body;
    expect(b1).toMatchObject({ total: 35, page: 1, pageSize: 10, pages: 4 }); // 3 discovered + 30 queued + /broken + /admin
    expect(b1.data).toHaveLength(10);
    expect(b1.summary).toMatchObject({ total: 35, notChecked: 30, failed: 2, skipped: 1, checked: 2, withFindings: 2 });
    expect(b1.latestScan).toMatchObject({ executionId: exec, status: "PARTIAL", stopReason: "DURATION", partial: true, notChecked: 30 });
    expect(b1.scoreFormula).toMatch(/critical 25, high 15, medium 8, low 3/);
    expect(b1.scope).toHaveProperty("browserPath");
    expect(b1.data.map((p: { path: string }) => p.path).slice(0, 4)).toEqual(["/", "/about", "/admin", "/broken"]);
    const last = (await u.client.get(`${api}?pageSize=10&page=4`)).body;
    expect(last.data).toHaveLength(5);
    expect((await u.client.get(`${api}?pageSize=10&page=9`)).body.data).toHaveLength(0);
    expect((await u.client.get(`${api}?pageSize=7`)).status).toBe(400);
    expect((await u.client.get(`${api}?cursor=x`)).status).toBe(400);
    const all = (await u.client.get(`${api}?pageSize=100`)).body.data as Array<Record<string, any>>;
    const byPath = (p: string) => all.find((x) => x.path === p)!;
    expect(all.some((x) => x.path === "/logo.svg" || x.path.startsWith("/search"))).toBe(false);

    // ---- states, provenance and score
    expect(byPath("/")).toMatchObject({ id: home, state: "CHECKED", score: 100, scoreBand: "GOOD", openFindings: 0, discovered: true });
    expect(byPath("/about")).toMatchObject({ id: about, state: "CHECKED", score: 89, scoreBand: "NEEDS_WORK", openFindings: 3, inSitemap: true,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 1, INFO: 1 }, byGroup: { accessibility: 1, seo: 2 } });
    expect(byPath("/gone")).toMatchObject({ id: gone, state: "FAILED", httpStatus: 404, score: 0, scoreBand: "POOR", firstReferrer: `${origin}/` });
    const q0 = byPath("/p/00");
    expect(q0).toMatchObject({ state: "NOT_CHECKED", scanState: "QUEUED", score: null, discovered: false, source: "CRAWL", firstReferrer: `${origin}/`, lastCheckedAt: null });
    expect(q0.id).toBe(`url-${sha(`${origin}/p/00`)}`);
    expect(byPath("/p/01")).toMatchObject({ source: "SITEMAP", inSitemap: true });
    expect(byPath("/broken")).toMatchObject({ state: "FAILED", httpStatus: 500, score: 0 });
    expect(byPath("/admin")).toMatchObject({ state: "SKIPPED", skipReason: "UNSAFE_ROUTE", score: null });

    // ---- filters, search, sort
    const f = async (qs: string) => (await u.client.get(`${api}?pageSize=100&${qs}`)).body;
    expect((await f("filter=not_checked")).total).toBe(30);
    expect((await f("filter=failed")).data.map((p: { path: string }) => p.path)).toEqual(["/broken", "/gone"]);
    expect((await f("filter=with_findings")).data.map((p: { path: string }) => p.path)).toEqual(["/about", "/gone"]);
    expect((await f("filter=skipped")).total).toBe(1);
    expect((await f("search=about%20us")).data.map((p: { path: string }) => p.path)).toEqual(["/about"]); // title search
    expect((await f("search=/p/1")).total).toBe(10);
    const byScore = (await f("sort=score:desc")).data.map((p: { path: string; score: number | null }) => [p.path, p.score]);
    expect(byScore.slice(0, 4)).toEqual([["/", 100], ["/about", 89], ["/broken", 0], ["/gone", 0]]);
    expect(byScore.at(-1)[1]).toBeNull(); // not scored → last
    expect((await f("sort=score:asc")).data.slice(0, 2).map((p: { score: number }) => p.score)).toEqual([0, 0]);
    expect((await f("sort=findings")).data[0].path).toBe("/about"); // desc by default
    expect((await f("sort=path:desc")).data[0].path).toBe("/p/29");

    // ---- detail: discovered page with findings
    const d = await u.client.get(`${api}/${about}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const dd = d.body.data;
    expect(dd).toMatchObject({ id: about, url: `${origin}/about`, title: "About us", state: "CHECKED", score: { value: 89, band: "NEEDS_WORK", basis: "FINDINGS", penalty: 11, penalties: { CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3, INFO: 0 } } });
    expect(dd.findings.map((x: { category: string }) => x.category)).toEqual(["IMG_MISSING_ALT", "MISSING_DESCRIPTION", "MISSING_CANONICAL"]); // by severity
    const alt = dd.findings[0];
    expect(alt).toMatchObject({ id: a1, group: "accessibility", severity: "MEDIUM", status: "OPEN", occurrenceCount: 1 });
    expect(alt.description).toMatch(/Screen-reader users/);
    expect(alt.howToFix).toMatch(/alt text/);
    expect(alt.evidence).toEqual({ images: 3, note: "see https://x.example/?token=…" }); // secrets dropped / redacted
    expect(dd.resolvedFindings.map((x: { category: string }) => x.category)).toEqual(["MISSING_H1"]); // 30-day window
    expect(dd.siteWideFindings.map((x: { category: string }) => x.category)).toEqual(["DUPLICATE_TITLE"]);
    // detail: a URL no scan has fetched yet, and a failed one
    const nq = (await u.client.get(`${api}/${q0.id}`)).body.data;
    expect(nq).toMatchObject({ state: "NOT_CHECKED", score: { value: null, basis: "NOT_CHECKED" }, findings: [], firstReferrer: `${origin}/` });
    const gd = (await u.client.get(`${api}/${gone}`)).body.data;
    expect(gd).toMatchObject({ state: "FAILED", httpStatus: 404, score: { value: 0, basis: "BROKEN" } });
    expect(gd.findings[0]).toMatchObject({ category: "BROKEN_PAGE", evidence: { status: 404 } });
    // unknown / malformed ids
    expect((await u.client.get(`${api}/url-${"0".repeat(64)}`)).status).toBe(404);
    expect((await u.client.get(`${api}/${randomUUID()}`)).status).toBe(404);
    expect((await u.client.get(`${api}/url-../../x`)).status).toBe(400);

    // ---- tenant isolation: another org can't list or open these pages, even with its own org id in the path
    const other = await userWithOrg(h.app, "pagesOther");
    const ow = await addVerifiedSite(h.owner, other.orgId, `https://pages-${randomUUID().slice(0, 6)}.fixture.example`);
    for (const p of ["", `/${about}`, `/${q0.id}`]) {
      expect((await other.client.get(`/api/v1/orgs/${other.orgId}/websites/${w}/pages${p}`)).status, p).toBe(404);
      expect((await other.client.get(`${api}${p}`)).status, p).toBe(404);
    }
    // a page id of website A requested under website B of the same org: 404
    const w2 = await addVerifiedSite(h.owner, u.orgId, `https://pages2-${randomUUID().slice(0, 6)}.fixture.example`);
    expect((await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${w2}/pages/${about}`)).status).toBe(404);
    expect((await u.client.get(`/api/v1/orgs/${u.orgId}/websites/${w2}/pages/${q0.id}`)).status).toBe(404);
    expect((await other.client.get(`/api/v1/orgs/${other.orgId}/websites/${ow}/pages`)).body).toMatchObject({ total: 0, pages: 1, latestScan: null });
  }, 120_000);
});
