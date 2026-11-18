import { displayUrl, emptySeverityCounts, FINDINGS, pageScore, sanitizeEvidence, type FindingCategory, type PageCheckState, type PageScore, type Severity } from "@wim/core";
import type { Tx } from "@wim/db";

/**
 * The website's page inventory for the customer "Pages" list and page detail: every page we know of, not only the
 * pages a deep scan has fetched successfully.
 *
 *   discovered_pages (not REMOVED)                       — fetched as HTML by a deep scan, or the browser-monitored page
 *   ∪ deep_scan_urls (kind PAGE) of the latest scan(s)   — URLs found via sitemap / links that a scan queued, failed or
 *                                                          skipped (e.g. it stopped at its time limit)
 *
 * deduplicated by url_hash (sha256 of the normalised URL; both tables use the same key). "Latest scan(s)" = the newest
 * finished scan plus a newer one still running, the running scan's row winning. Everything is read inside the caller's
 * member transaction (RLS) and filtered by website id.
 */
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface InventoryScan { executionId: string; status: string; stopReason: string | null; complete: boolean; startedAt: string | null; finishedAt: string | null }
export interface InventoryRow {
  /** discovered page id, or `url-<sha256>` for a URL no scan has fetched as a page yet */
  id: string;
  urlHash: string;
  /** display form (query values redacted) — also the findings' subject */
  url: string;
  title: string | null;
  discovered: boolean;
  inventoryStatus: string | null; // ACTIVE | STALE | EXCLUDED (discovered pages only)
  state: PageCheckState;
  /** raw deep-scan state of the latest scan row (QUEUED / DONE / FAILED / SKIPPED / INCONCLUSIVE) */
  scanState: string | null;
  httpStatus: number | null;
  skipReason: string | null;
  error: string | null;
  source: string;
  inSitemap: boolean;
  firstReferrer: string | null;
  depth: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastCheckedAt: string | null;
  lastExecutionId: string | null;
  monitoredId: string | null;
  monitoredLastResultAt: string | null;
  findings: Array<{ severity: string; category: string; group: string }>;
  score: PageScore;
  byGroup: Record<string, number>;
}

export async function loadPageInventory(tx: Tx, websiteId: string) {
  const scanRows = await tx.$queryRaw<Array<{ execution_id: string; status: string; stop_reason: string | null; complete: boolean; started_at: Date; finished_at: Date | null }>>`
    SELECT execution_id, status, stop_reason, complete, started_at, finished_at FROM deep_scans
     WHERE website_id = ${websiteId}::uuid ORDER BY started_at DESC LIMIT 10`;
  const latestFinished = scanRows.find((x) => x.status !== "RUNNING") ?? null;
  const running = scanRows[0]?.status === "RUNNING" ? scanRows[0] : null;
  const scanIds = [running?.execution_id, latestFinished?.execution_id].filter(Boolean) as string[];

  const discovered = await tx.$queryRaw<Array<Record<string, any>>>`
    SELECT d.id, d.url, d.url_hash, d.status::text AS status, d.title, d.source, d.depth, d.first_seen_at, d.last_seen_at, m.id AS monitored_id, m.last_result_at
      FROM discovered_pages d LEFT JOIN monitored_pages m ON m.discovered_page_id = d.id
     WHERE d.website_id = ${websiteId}::uuid AND d.status <> 'REMOVED'`;
  // the latest scan(s)' page rows; the running scan (first in scanIds) wins. The scanner's own search probes are not pages,
  // and a "page" a scan fetched that wasn't HTML (an <a href> to an image or PDF) isn't one either.
  const latest = scanIds.length ? await tx.$queryRaw<Array<Record<string, any>>>`
    SELECT DISTINCT ON (u.url_hash) u.url_hash, u.url, u.state, u.skip_reason, u.status_code, u.source, u.depth, u.in_sitemap, u.first_referrer,
           u.checked_at, u.execution_id, u.content_type, u.error, u.facts ->> 'title' AS title
      FROM deep_scan_urls u
     WHERE u.execution_id = ANY(${scanIds}::uuid[]) AND u.website_id = ${websiteId}::uuid AND u.kind = 'PAGE' AND u.source <> 'SEARCH'
     ORDER BY u.url_hash, array_position(${scanIds}::uuid[], u.execution_id)` : [];
  // most recent actual check (DONE / FAILED) of each page in the last 10 scans — "last checked" (index on execution_id)
  const recentIds = scanRows.map((x) => x.execution_id);
  const checked = await tx.$queryRaw<Array<{ url_hash: string; state: string; status_code: number | null; checked_at: Date; execution_id: string; first_referrer: string | null; in_sitemap: boolean }>>`
    SELECT DISTINCT ON (u.url_hash) u.url_hash, u.state, u.status_code, u.checked_at, u.execution_id, u.first_referrer, u.in_sitemap
      FROM deep_scan_urls u
     WHERE u.execution_id = ANY(${recentIds}::uuid[]) AND u.website_id = ${websiteId}::uuid AND u.kind = 'PAGE' AND u.source <> 'SEARCH'
       AND u.state IN ('DONE', 'FAILED') AND u.checked_at IS NOT NULL
     ORDER BY u.url_hash, u.checked_at DESC`;
  // OPEN findings on single pages (site-level and sitemap findings don't belong to one page)
  const findings = await tx.$queryRaw<Array<{ subject: string; severity: string; category: string; group_key: string }>>`
    SELECT subject, severity, category, group_key FROM scan_findings WHERE website_id = ${websiteId}::uuid AND status = 'OPEN' AND subject <> 'site'`;

  const fBy = new Map<string, InventoryRow["findings"]>();
  for (const f of findings) fBy.set(f.subject, [...(fBy.get(f.subject) ?? []), { severity: f.severity, category: f.category, group: f.group_key }]);
  const latestBy = new Map(latest.map((x) => [x.url_hash as string, x]));
  const checkedBy = new Map(checked.map((x) => [x.url_hash, x]));

  const finish = (r: Omit<InventoryRow, "findings" | "score" | "byGroup">): InventoryRow => {
    const fs = fBy.get(r.url) ?? [];
    const byGroup: Record<string, number> = {};
    for (const f of fs) byGroup[f.group] = (byGroup[f.group] ?? 0) + 1;
    return { ...r, findings: fs, score: pageScore({ state: r.state, findings: fs }), byGroup };
  };

  const rows: InventoryRow[] = [];
  const seen = new Set<string>();
  for (const d of discovered) {
    seen.add(d.url_hash);
    const sc = latestBy.get(d.url_hash);
    // the latest scan's own check wins; otherwise the most recent check in an earlier scan
    const lc = sc && (sc.state === "DONE" || sc.state === "FAILED") && sc.checked_at ? sc : checkedBy.get(d.url_hash);
    // a page in the inventory was fetched successfully at least once; its latest actual check decides FAILED
    const state: PageCheckState = lc?.state === "FAILED" ? "FAILED" : "CHECKED";
    rows.push(finish({
      id: d.id, urlHash: d.url_hash, url: displayUrl(d.url), title: d.title ?? null, discovered: true, inventoryStatus: d.status,
      state, scanState: sc?.state ?? null, httpStatus: lc?.status_code ?? sc?.status_code ?? null, skipReason: null, error: lc?.state === "FAILED" ? (sc?.error ?? null) : null,
      source: d.source, inSitemap: Boolean(sc?.in_sitemap ?? lc?.in_sitemap), firstReferrer: sc?.first_referrer ?? lc?.first_referrer ?? null, depth: d.depth,
      firstSeenAt: iso(d.first_seen_at), lastSeenAt: iso(d.last_seen_at),
      lastCheckedAt: iso(lc?.checked_at) ?? (d.source === "BROWSER" ? iso(d.last_result_at ?? d.last_seen_at) : iso(d.last_seen_at)),
      lastExecutionId: lc?.execution_id ?? sc?.execution_id ?? null, monitoredId: d.monitored_id ?? null, monitoredLastResultAt: iso(d.last_result_at),
    }));
  }
  for (const u of latest) {
    if (seen.has(u.url_hash)) continue;
    if (u.state === "DONE" && u.content_type && !/html/i.test(u.content_type)) continue; // a file, not a page
    const lc = checkedBy.get(u.url_hash);
    const state: PageCheckState = u.state === "FAILED" ? "FAILED" : u.state === "SKIPPED" ? "SKIPPED" : u.state === "DONE" ? "CHECKED" : "NOT_CHECKED";
    rows.push(finish({
      id: `url-${u.url_hash}`, urlHash: u.url_hash, url: displayUrl(u.url), title: u.title ? String(u.title).slice(0, 300) : null, discovered: false, inventoryStatus: null,
      state, scanState: u.state, httpStatus: u.status_code ?? null, skipReason: u.skip_reason ?? null, error: u.error ?? null,
      source: u.source, inSitemap: Boolean(u.in_sitemap), firstReferrer: u.first_referrer ?? null, depth: u.depth ?? 0,
      firstSeenAt: null, lastSeenAt: null, lastCheckedAt: iso(u.checked_at) ?? iso(lc?.checked_at),
      lastExecutionId: u.execution_id, monitoredId: null, monitoredLastResultAt: null,
    }));
  }
  const dto = (x: (typeof scanRows)[number] | null): InventoryScan | null => x && ({ executionId: x.execution_id, status: x.status, stopReason: x.stop_reason, complete: x.complete, startedAt: iso(x.started_at), finishedAt: iso(x.finished_at) });
  return { rows, latestScan: dto(latestFinished), runningScan: dto(running) };
}

export type PageFilter = "all" | "with_findings" | "not_checked" | "failed" | "skipped";
export type PageSort = "path" | "score" | "findings";

export function pathOf(url: string) { try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return url; } }

/** Filter, search, sort (stable; ties by path) and slice one page. Scores without a value sort last in both directions. */
export function queryInventory(rows: InventoryRow[], q: { filter: PageFilter; search?: string; sort: PageSort; dir: "asc" | "desc"; page: number; pageSize: number }) {
  const s = q.search?.toLowerCase();
  const matches = rows.filter((r) => {
    if (s && !r.url.toLowerCase().includes(s) && !(r.title ?? "").toLowerCase().includes(s)) return false;
    switch (q.filter) {
      case "with_findings": return r.findings.length > 0;
      case "not_checked": return r.state === "NOT_CHECKED";
      case "failed": return r.state === "FAILED";
      case "skipped": return r.state === "SKIPPED";
      default: return true;
    }
  });
  const sign = q.dir === "asc" ? 1 : -1;
  const byPath = (a: InventoryRow, b: InventoryRow) => (pathOf(a.url) < pathOf(b.url) ? -1 : pathOf(a.url) > pathOf(b.url) ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  matches.sort((a, b) => {
    if (q.sort === "score") {
      const x = a.score.score, y = b.score.score;
      if (x === null || y === null) return x === y ? byPath(a, b) : x === null ? 1 : -1;
      return x !== y ? (x - y) * sign : byPath(a, b);
    }
    if (q.sort === "findings") return a.findings.length !== b.findings.length ? (a.findings.length - b.findings.length) * sign : byPath(a, b);
    return byPath(a, b) * sign;
  });
  const total = matches.length;
  const pages = Math.max(1, Math.ceil(total / q.pageSize));
  return { total, pages, slice: matches.slice((q.page - 1) * q.pageSize, q.page * q.pageSize) };
}

export function inventorySummary(rows: InventoryRow[]) {
  const c = { total: rows.length, checked: 0, notChecked: 0, failed: 0, skipped: 0, withFindings: 0 };
  for (const r of rows) {
    if (r.state === "CHECKED") c.checked++;
    else if (r.state === "NOT_CHECKED") c.notChecked++;
    else if (r.state === "FAILED") c.failed++;
    else c.skipped++;
    if (r.findings.length) c.withFindings++;
  }
  return c;
}

/** The common page facts of a list row / detail. */
export function pageFacts(r: InventoryRow) {
  return {
    id: r.id, url: r.url, path: pathOf(r.url), title: r.title, discovered: r.discovered, inventoryStatus: r.inventoryStatus,
    state: r.state, scanState: r.scanState, httpStatus: r.httpStatus, skipReason: r.skipReason, error: r.error,
    source: r.source, inSitemap: r.inSitemap, firstReferrer: r.firstReferrer, depth: r.depth,
    firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, lastCheckedAt: r.lastCheckedAt, lastExecutionId: r.lastExecutionId,
    score: r.score.score, scoreBand: r.score.band, scoreBasis: r.score.basis,
    openFindings: r.findings.length, bySeverity: r.score.bySeverity, byGroup: r.byGroup,
  };
}

/** One finding for the page detail: catalogue text (impact, how to fix), sanitised evidence, history counters. */
export function pageFindingDto(f: { id: string; category: string; groupKey: string; severity: string; status: string; subject: string; title: string; evidence: unknown; recommendation: string; detectionMethod: string; occurrenceCount: number; reopenCount: number; firstDetectedAt: Date; lastDetectedAt: Date; resolvedAt: Date | null }) {
  const spec = (FINDINGS as Record<string, { impact: string; recommendation: string }>)[f.category as FindingCategory];
  return {
    id: f.id, category: f.category, group: f.groupKey, severity: f.severity, status: f.status, subject: f.subject, title: f.title,
    description: spec?.impact ?? null, howToFix: spec?.recommendation ?? f.recommendation, evidence: sanitizeEvidence(f.evidence ?? {}),
    detectionMethod: f.detectionMethod, occurrenceCount: f.occurrenceCount, reopenCount: f.reopenCount,
    firstDetectedAt: f.firstDetectedAt.toISOString(), lastDetectedAt: f.lastDetectedAt.toISOString(), resolvedAt: iso(f.resolvedAt),
  };
}

export const severityCounts = (fs: Array<{ severity: string }>) => {
  const c = emptySeverityCounts();
  for (const f of fs) if (f.severity in c) c[f.severity as Severity]++;
  return c;
};
