import { createHash } from "node:crypto";
import {
  FINDING_GROUP_INCIDENTS, FINDINGS, findingSeverity, normalizeUrl, pathTemplate,
  type FindingCategory, type FindingGroup, type Severity,
} from "@wim/core";
import type { Tx } from "@wim/db";
import { openIncident, recordLedger, recordOccurrence, resolveIncident } from "@wim/incidents";
import { addUsage } from "@wim/queue";
import type { ScanSnapshot } from "./engine.js";
import type { HtmlForm } from "./html.js";

interface UrlRow {
  url: string; kind: string; resource_type: string | null; state: string; skip_reason: string | null; depth: number; source: string; in_sitemap: boolean;
  referrers: number; first_referrer: string | null; status_code: number | null; final_url: string | null; redirect_chain: Array<{ url: string; status: number }> | null;
  content_type: string | null; facts: Record<string, any> | null; error: string | null;
}
interface Detected { category: FindingCategory; subject: string; fingerprintKey: string; evidence: Record<string, unknown> }

const disp = (u: string) => {
  try { const x = new URL(u); const q = [...x.searchParams.keys()]; return `${x.protocol}//${x.host}${x.pathname}${q.length ? `?${q.map((k) => `${k}=…`).join("&")}` : ""}`; } catch { return u; }
};
const fp = (cat: string, key: string) => `${cat}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/**
 * Finalise a scan in ONE transaction: ledger row (the single logical result), findings reconciliation, incidents,
 * comparison with the previous COMPLETED scan, page inventory, final status and usage. The ledger insert is the
 * idempotency gate: a replay after a crash finds the ledger and changes nothing.
 */
export async function finalizeScan(tx: Tx, i: {
  executionId: string; orgId: string; websiteId: string; windowStart: Date; attempt: number; stopReason: string | null; requests: number; snap: ScanSnapshot; durationMs: number;
}) {
  const [scan] = await tx.$queryRaw<Array<{ status: string; discovery: any; pages_dropped: number; started_at: Date }>>`
    SELECT status, discovery, pages_dropped, started_at FROM deep_scans WHERE execution_id = ${i.executionId}::uuid FOR UPDATE`;
  if (!scan || scan.status !== "RUNNING") return { status: scan?.status ?? "MISSING", findings: {} };
  const rows = await tx.$queryRaw<UrlRow[]>`
    SELECT url, kind, resource_type, state, skip_reason, depth, source, in_sitemap, referrers, first_referrer, status_code, final_url, redirect_chain,
           content_type, facts, error FROM deep_scan_urls WHERE execution_id = ${i.executionId}::uuid`;
  const pages = rows.filter((r) => r.kind === "PAGE");
  const queuedPages = pages.filter((r) => r.state === "QUEUED").length;
  const checkedPages = pages.filter((r) => r.state === "DONE" || r.state === "FAILED");
  // Pages whose destination the gateway refused or couldn't verify (private / rebinding answers, no address) were
  // NOT observed: unlike policy skips (robots, scope, unsafe routes) they make the scan incomplete, and a scan that
  // couldn't check a single page is never COMPLETED — it must not resolve findings or call pages "removed".
  const unverified = pages.filter((p) => p.state === "SKIPPED" && /^BLOCKED_|^NO_ADDRESSES$/.test(p.skip_reason ?? "")).length;
  const noPageReached = checkedPages.length === 0;
  // COMPLETED: the frontier was processed to its planned end (no early stop). complete: and nothing was dropped or unverified.
  const status = i.stopReason || queuedPages > 0 || noPageReached ? "PARTIAL" : "COMPLETED";
  const complete = status === "COMPLETED" && scan.pages_dropped === 0 && unverified === 0 && !pages.some((p) => p.state === "INCONCLUSIVE");
  const stopReason = i.stopReason ?? (noPageReached ? "NO_PAGE_REACHABLE" : queuedPages ? "INCOMPLETE" : scan.pages_dropped ? "PAGE_LIMIT" : "FRONTIER_EXHAUSTED");

  // ---------------------------------------------------------------- detection
  const found: Detected[] = [];
  const add = (category: FindingCategory, subject: string, key: string, evidence: Record<string, unknown>) => found.push({ category, subject, fingerprintKey: key, evidence });
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  for (const p of checkedPages) {
    const s = disp(p.url);
    const f = p.facts ?? {};
    const referred = { linkedFrom: p.first_referrer, linkCount: p.referrers, inSitemap: p.in_sitemap };
    if (p.source === "SEARCH") {
      // the scanner's own test query through the site's search form: report search health, not page SEO
      if (p.state === "FAILED" || p.error === "REDIRECT_LOOP") add("SEARCH_BROKEN", disp(p.first_referrer ?? p.url), `search:${new URL(p.url).pathname}`, { searchUrl: s, status: p.status_code, error: p.error, formOn: p.first_referrer });
      continue;
    }
    if (p.error === "REDIRECT_LOOP") add("REDIRECT_LOOP", s, p.url, { chain: p.redirect_chain, ...referred });
    else if (p.state === "FAILED") add("BROKEN_PAGE", s, p.url, { status: p.status_code, error: p.error, ...referred });
    if ((p.redirect_chain?.length ?? 0) >= 3) add("REDIRECT_CHAIN", s, p.url, { hops: p.redirect_chain!.length, chain: p.redirect_chain });
    if (f.outOfScopeRedirect) add("REDIRECT_OUT_OF_SCOPE", s, p.url, { target: f.outOfScopeRedirect });
    if (p.state !== "DONE" || !("titleCount" in f)) continue; // HTML checks only for successfully analysed pages
    if (!f.titleCount) add("MISSING_TITLE", s, p.url, {});
    else if (!f.title) add("EMPTY_TITLE", s, p.url, {});
    if (f.description === null) add("MISSING_DESCRIPTION", s, p.url, {});
    else if (!String(f.description).trim()) add("EMPTY_DESCRIPTION", s, p.url, {});
    if (f.canonical === null) add("MISSING_CANONICAL", s, p.url, {});
    else {
      const c = normalizeUrl(String(f.canonical), p.url, i.snap.norm);
      const target = c ? byUrl.get(c.href) : undefined;
      if (!c) add("INVALID_CANONICAL", s, p.url, { canonical: String(f.canonical).slice(0, 200), problem: "malformed" });
      else if (!i.snap.scope.hosts.includes(c.hostname)) add("INVALID_CANONICAL", s, p.url, { canonical: disp(c.href), problem: "points to another site" });
      else if (target && target.state === "FAILED") add("INVALID_CANONICAL", s, p.url, { canonical: disp(c.href), problem: `canonical target returns ${target.status_code ?? target.error}` });
    }
    if (f.h1 === 0) add("MISSING_H1", s, p.url, {});
    if (f.h1 > 1) add("MULTIPLE_H1", s, p.url, { count: f.h1 });
    if (!f.viewport) add("MISSING_VIEWPORT", s, p.url, {});
    if (!f.openGraph) add("MISSING_OPEN_GRAPH", s, p.url, {});
    if (f.jsonLd?.invalid) add("INVALID_JSON_LD", s, p.url, { invalidBlocks: f.jsonLd.invalid, blocks: f.jsonLd.blocks });
    const noindex = /noindex/.test(`${f.robots ?? ""} ${f.xRobots ?? ""}`.toLowerCase());
    if (noindex && p.in_sitemap) add("NOINDEX_IN_SITEMAP", s, p.url, { directive: f.robots ?? f.xRobots });
    if (!f.lang) add("MISSING_LANG", s, p.url, {});
    if (f.imgMissingAlt) add("IMG_MISSING_ALT", s, p.url, { images: f.imgMissingAlt });
    if (f.emptyLinks) add("EMPTY_LINK", s, p.url, { links: f.emptyLinks });
    if (f.emptyButtons) add("EMPTY_BUTTON", s, p.url, { buttons: f.emptyButtons });
    if (f.unlabelledControls) add("UNLABELLED_CONTROL", s, p.url, { controls: f.unlabelledControls });
    if (f.headingSkips) add("HEADING_SKIP", s, p.url, { skips: f.headingSkips });
    if (!f.hasMain) add("MISSING_MAIN_LANDMARK", s, p.url, {});
    if (f.duplicateIds) add("DUPLICATE_ID", s, p.url, { ids: f.duplicateIds });
    const pageHttps = new URL(p.final_url ?? p.url).protocol === "https:";
    for (const [n, fm] of ((f.forms ?? []) as HtmlForm[]).entries()) {
      const key = `${p.url}#form${n}`;
      let action: URL | null = null;
      try { action = new URL(fm.action?.trim() || p.final_url || p.url, p.final_url ?? p.url); } catch { /* malformed action: nothing to judge */ }
      if (pageHttps && action?.protocol === "http:") add("FORM_INSECURE_ACTION", s, key, { action: disp(action.href), method: fm.method });
      if (fm.password && !pageHttps) add("PASSWORD_FIELD_INSECURE", s, key, {});
      if (!fm.submit && !fm.search) add("FORM_NO_SUBMIT", s, key, { method: fm.method });
      if (fm.search && !fm.queryField) add("SEARCH_FIELD_UNNAMED", s, key, {});
    }
  }
  // site-level duplicates (only among pages analysed in this scan)
  const groupBy = (key: (f: Record<string, any>) => string | null) => {
    const m = new Map<string, UrlRow[]>();
    for (const p of checkedPages) {
      if (p.state !== "DONE" || !p.facts || !("titleCount" in p.facts)) continue;
      const k = key(p.facts);
      if (k) m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m].filter(([, v]) => v.length > 1);
  };
  for (const [title, ps] of groupBy((f) => (f.title ? String(f.title).toLowerCase() : null))) add("DUPLICATE_TITLE", "site", `title:${title}`, { title, pages: ps.slice(0, 10).map((p) => disp(p.url)), count: ps.length });
  for (const [desc, ps] of groupBy((f) => (f.description && String(f.description).trim() ? String(f.description).toLowerCase() : null))) add("DUPLICATE_DESCRIPTION", "site", `desc:${desc}`, { description: desc.slice(0, 160), pages: ps.slice(0, 10).map((p) => disp(p.url)), count: ps.length });
  for (const [hash, ps] of groupBy((f) => (f.textLength > 0 ? f.textHash : null))) {
    // the same content under several URLs is fine when they declare one canonical
    const canon = new Set(ps.map((p) => (p.facts!.canonical ? normalizeUrl(String(p.facts!.canonical), p.url, i.snap.norm)?.href : p.url)));
    if (canon.size > 1) add("DUPLICATE_CONTENT", "site", `content:${hash}`, { pages: ps.slice(0, 10).map((p) => disp(p.url)), count: ps.length });
  }
  for (const r of rows.filter((x) => (x.kind === "RESOURCE" || x.kind === "EXTERNAL") && x.state === "FAILED")) {
    add(r.kind === "RESOURCE" ? "BROKEN_RESOURCE" : "BROKEN_EXTERNAL_LINK", disp(r.url), r.url, { type: r.resource_type, status: r.status_code, error: r.error, linkedFrom: r.first_referrer, linkCount: r.referrers });
  }
  for (const issue of (scan.discovery?.issues ?? []) as Array<{ category: FindingCategory; subject: string; evidence: Record<string, unknown> }>) add(issue.category, issue.subject, `${issue.subject}`, issue.evidence);
  for (const spa of (scan.discovery?.spa ?? []) as Array<{ page: string; links: number }>) add("SPA_ROUTE_NOT_IN_HTML", spa.page, spa.page, { renderedOnlyLinks: spa.links });

  // ---------------------------------------------------------------- ledger first (idempotency gate)
  const highOpen = found.some((f) => ["CRITICAL", "HIGH"].includes(findingSeverity(f.category, i.snap.severityOverrides as Record<string, Severity>)));
  // PASSED only when the planned scan ran to its end; a partial scan without a high-severity issue proves nothing.
  const outcome = i.stopReason === "INFRASTRUCTURE" || noPageReached ? "INCONCLUSIVE" : highOpen ? "FAILED" : status === "COMPLETED" ? "PASSED" : "INCONCLUSIVE";
  if (!(await recordLedger(tx, { executionId: i.executionId, orgId: i.orgId, websiteId: i.websiteId, tier: "T3_DEEP", windowStart: i.windowStart, outcome, attempt: i.attempt }))) {
    return { status: "DUPLICATE", findings: {} };
  }

  // ---------------------------------------------------------------- reconcile findings
  const now = new Date();
  const seen = new Set<string>();
  let opened = 0, recurred = 0, reopened = 0, resolved = 0;
  for (const f of found) {
    const spec = FINDINGS[f.category];
    const fingerprint = fp(f.category, f.fingerprintKey);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const severity = findingSeverity(f.category, i.snap.severityOverrides as Record<string, Severity>);
    const [row] = await tx.$queryRaw<Array<{ id: string; prev_status: string | null; inserted: boolean }>>`
      INSERT INTO scan_findings (org_id, website_id, fingerprint, category, group_key, severity, subject, title, evidence, recommendation, detection_method,
                                 first_detected_at, last_detected_at, first_execution_id, last_execution_id)
      VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${fingerprint}, ${f.category}, ${spec.group}, ${severity}, ${f.subject.slice(0, 600)}, ${spec.title},
              ${JSON.stringify({ ...f.evidence, impact: spec.impact })}::jsonb, ${spec.recommendation}, ${spec.method}, ${now}, ${now}, ${i.executionId}::uuid, ${i.executionId}::uuid)
      ON CONFLICT (website_id, fingerprint) DO UPDATE
        SET last_detected_at = ${now}, last_execution_id = ${i.executionId}::uuid, occurrence_count = scan_findings.occurrence_count + 1,
            severity = EXCLUDED.severity, evidence = EXCLUDED.evidence, subject = EXCLUDED.subject,
            status = 'OPEN', resolved_at = NULL, resolved_execution_id = NULL,
            reopen_count = scan_findings.reopen_count + CASE WHEN scan_findings.status = 'RESOLVED' THEN 1 ELSE 0 END
      RETURNING id, (SELECT status FROM scan_findings WHERE website_id = ${i.websiteId}::uuid AND fingerprint = ${fingerprint}) AS prev_status, (xmax = 0) AS inserted`;
    const type = row!.inserted ? "OPENED" : row!.prev_status === "RESOLVED" ? "REOPENED" : "RECURRED";
    if (type === "OPENED") opened++; else if (type === "REOPENED") reopened++; else recurred++;
    await tx.$executeRaw`
      INSERT INTO scan_finding_events (org_id, finding_id, execution_id, type, data) VALUES (${i.orgId}::uuid, ${row!.id}::uuid, ${i.executionId}::uuid, ${type}, ${JSON.stringify({ severity })}::jsonb)
      ON CONFLICT (finding_id, execution_id, type) DO NOTHING`;
  }
  // Resolution: only a COMPLETED scan, and only for subjects it actually checked (pages/resources reached and analysed,
  // sitemaps after full discovery, site-level checks only when the whole site was covered).
  if (status === "COMPLETED") {
    const checked = new Set<string>([
      ...checkedPages.map((p) => disp(p.url)),
      ...rows.filter((r) => (r.kind === "RESOURCE" || r.kind === "EXTERNAL") && (r.state === "DONE" || r.state === "FAILED")).map((r) => disp(r.url)),
      "robots.txt", "sitemap",
      ...((scan.discovery?.issues ?? []) as Array<{ subject: string }>).map((x) => x.subject),
    ]);
    const open = await tx.$queryRaw<Array<{ id: string; fingerprint: string; subject: string; category: string; group_key: string }>>`
      SELECT id, fingerprint, subject, category, group_key FROM scan_findings WHERE website_id = ${i.websiteId}::uuid AND status = 'OPEN' FOR UPDATE`;
    for (const o of open) {
      if (seen.has(o.fingerprint)) continue;
      const siteLevel = o.subject === "site";
      const sitemapLevel = o.group_key === "sitemap";
      const ok = siteLevel ? complete : sitemapLevel ? Boolean(scan.discovery) : checked.has(o.subject);
      if (!ok) continue;
      await tx.$executeRaw`UPDATE scan_findings SET status = 'RESOLVED', resolved_at = ${now}, resolved_execution_id = ${i.executionId}::uuid WHERE id = ${o.id}::uuid AND status = 'OPEN'`;
      await tx.$executeRaw`INSERT INTO scan_finding_events (org_id, finding_id, execution_id, type) VALUES (${i.orgId}::uuid, ${o.id}::uuid, ${i.executionId}::uuid, 'RESOLVED') ON CONFLICT DO NOTHING`;
      resolved++;
    }
  }

  // ---------------------------------------------------------------- incidents: one per finding group per website
  const groupCounts = await tx.$queryRaw<Array<{ group_key: string; n: number; worst: string }>>`
    SELECT group_key, count(*)::int AS n, (array_agg(severity ORDER BY array_position(ARRAY['CRITICAL','HIGH','MEDIUM','LOW','INFO'], severity)))[1] AS worst
      FROM scan_findings WHERE website_id = ${i.websiteId}::uuid AND status = 'OPEN' GROUP BY group_key`;
  const incidentActions: string[] = [];
  for (const g of i.snap.incidentGroups as FindingGroup[]) {
    const spec = FINDING_GROUP_INCIDENTS[g];
    const cnt = groupCounts.find((x) => x.group_key === g);
    const fingerprint = `deepscan.${g}:${i.websiteId}`;
    const [active] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM incidents WHERE org_id = ${i.orgId}::uuid AND fingerprint = ${fingerprint} AND status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED')`;
    const occurrence = { executionId: i.executionId, pageUrl: null, details: { openFindings: cnt?.n ?? 0, worst: cnt?.worst ?? null } };
    if (cnt && cnt.n > 0) {
      const sev = (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(cnt.worst) ? cnt.worst : spec.severity) as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      if (active) {
        await recordOccurrence(tx, active.id, i.orgId, now, occurrence, { openFindings: cnt.n });
        incidentActions.push(`occur:${g}`);
      } else {
        const r = await openIncident(tx, {
          orgId: i.orgId, websiteId: i.websiteId, fingerprint, checkKey: `deepscan.${g}`, category: spec.category, source: "DEEP_SCAN", severity: sev,
          title: spec.title, description: `${cnt.n} open finding${cnt.n === 1 ? "" : "s"} (worst: ${cnt.worst}). See the deep-scan findings for pages and evidence.`,
          scope: "site", diagnostics: { openFindings: cnt.n, worst: cnt.worst, executionId: i.executionId }, firstDetectedAt: now, detectedAt: now, count: 1, occurrence,
        });
        incidentActions.push(`${r.created ? "open" : "reopen"}:${g}`);
      }
    } else if (active && status === "COMPLETED") {
      if (await resolveIncident(tx, active.id, i.orgId, now, { executionId: i.executionId, reason: "deep scan found no open findings in this group" })) incidentActions.push(`resolve:${g}`);
    }
  }

  // ---------------------------------------------------------------- comparison with the previous COMPLETED scan
  const [base] = await tx.$queryRaw<Array<{ execution_id: string; complete: boolean }>>`
    SELECT execution_id, complete FROM deep_scans WHERE website_id = ${i.websiteId}::uuid AND status = 'COMPLETED' AND execution_id <> ${i.executionId}::uuid
     ORDER BY finished_at DESC LIMIT 1`;
  let comparison: Record<string, unknown> | null = null;
  if (base) {
    const prev = await tx.$queryRaw<UrlRow[]>`SELECT url, kind, state, status_code, redirect_chain, facts, skip_reason FROM deep_scan_urls WHERE execution_id = ${base.execution_id}::uuid AND kind = 'PAGE'`;
    const prevBy = new Map(prev.map((p) => [p.url, p]));
    const cap = (a: string[]) => ({ count: a.length, items: a.slice(0, 50) });
    const newPages: string[] = [], removed: string[] = [], notObserved: string[] = [], statusChanged: string[] = [], titleChanged: string[] = [], descChanged: string[] = [],
      canonicalChanged: string[] = [], newRedirects: string[] = [], removedRedirects: string[] = [], newBroken: string[] = [], recovered: string[] = [], contentChanged: string[] = [], structureChanged: string[] = [];
    for (const p of checkedPages) {
      const b = prevBy.get(p.url);
      const s = disp(p.url);
      if (!b || (b.state !== "DONE" && b.state !== "FAILED")) { if (!b) newPages.push(s); continue; }
      if (b.status_code !== p.status_code) statusChanged.push(`${s} (${b.status_code ?? b.state} → ${p.status_code ?? p.state})`);
      if (b.state === "DONE" && p.state === "FAILED") newBroken.push(s);
      if (b.state === "FAILED" && p.state === "DONE") recovered.push(s);
      const bf = b.facts ?? {}, pf = p.facts ?? {};
      if ("titleCount" in bf && "titleCount" in pf) {
        if ((bf.title ?? null) !== (pf.title ?? null)) titleChanged.push(s);
        if ((bf.description ?? null) !== (pf.description ?? null)) descChanged.push(s);
        if ((bf.canonical ?? null) !== (pf.canonical ?? null)) canonicalChanged.push(s);
        if (bf.textHash !== pf.textHash) contentChanged.push(s);
        if (bf.structureHash !== pf.structureHash) structureChanged.push(s);
      }
      const br = (b.redirect_chain?.length ?? 0) > 0, pr = (p.redirect_chain?.length ?? 0) > 0;
      if (!br && pr) newRedirects.push(s);
      if (br && !pr) removedRedirects.push(s);
    }
    const nowUrls = new Set(pages.map((p) => p.url));
    for (const b of prev.filter((x) => x.state === "DONE")) {
      if (nowUrls.has(b.url)) {
        const cur = byUrl.get(b.url)!;
        if (cur.state === "QUEUED" || cur.state === "INCONCLUSIVE") notObserved.push(disp(b.url));
        continue;
      }
      // A page is "removed" only when this scan was complete AND it was no longer discovered at all.
      (complete ? removed : notObserved).push(disp(b.url));
    }
    const a11y = await tx.$queryRaw<Array<{ type: string; n: number }>>`
      SELECT e.type, count(*)::int AS n FROM scan_finding_events e JOIN scan_findings f ON f.id = e.finding_id
       WHERE e.execution_id = ${i.executionId}::uuid AND f.group_key = 'accessibility' GROUP BY e.type`;
    comparison = {
      baselineExecutionId: base.execution_id, baselineComplete: base.complete, currentComplete: complete,
      newPages: cap(newPages), removedPages: cap(removed), notObservedThisScan: cap(notObserved), statusChanged: cap(statusChanged),
      newBrokenPages: cap(newBroken), recoveredPages: cap(recovered), titleChanged: cap(titleChanged), descriptionChanged: cap(descChanged),
      canonicalChanged: cap(canonicalChanged), newRedirects: cap(newRedirects), removedRedirects: cap(removedRedirects),
      contentChanged: cap(contentChanged), structureChanged: cap(structureChanged),
      accessibility: { newlyDetected: a11y.filter((x) => x.type === "OPENED" || x.type === "REOPENED").reduce((a, b) => a + b.n, 0), resolved: a11y.find((x) => x.type === "RESOLVED")?.n ?? 0 },
    };
  }

  // ---------------------------------------------------------------- inventory (discovered_pages), final status, usage
  // Only HTML documents are pages: an <a href> to an image or file (e.g. /brand/logo.svg) is a link, not a page.
  for (const p of checkedPages.filter((x) => x.state === "DONE" && /html/i.test(x.content_type ?? ""))) {
    const s = disp(p.url);
    await tx.$executeRaw`
      INSERT INTO discovered_pages (org_id, website_id, url, url_hash, path_template, source, depth, title, content_hash, last_seen_at)
      VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${s}, ${createHash("sha256").update(p.url).digest("hex")}, ${pathTemplate(new URL(p.url))}, ${p.source}, ${p.depth},
              ${p.facts?.title ? String(p.facts.title).slice(0, 300) : null}, ${p.facts?.textHash ?? null}, ${now})
      ON CONFLICT (website_id, url_hash) DO UPDATE SET last_seen_at = ${now}, title = EXCLUDED.title, content_hash = EXCLUDED.content_hash, status = 'ACTIVE', missed_crawls = 0`;
  }
  if (complete) {
    const hashes = pages.map((p) => createHash("sha256").update(p.url).digest("hex"));
    await tx.$executeRaw`
      UPDATE discovered_pages SET missed_crawls = missed_crawls + 1, status = CASE WHEN missed_crawls + 1 >= 3 THEN 'REMOVED'::"PageStatus" ELSE status END
       WHERE website_id = ${i.websiteId}::uuid AND NOT (url_hash = ANY(${hashes}::text[])) AND status = 'ACTIVE'`;
  }
  await tx.$executeRaw`
    UPDATE deep_scans SET status = ${status}, complete = ${complete}, stop_reason = ${stopReason}, requests = ${i.requests},
           findings_opened = ${opened + reopened}, findings_resolved = ${resolved}, comparison = ${comparison ? JSON.stringify(comparison) : null}::jsonb,
           baseline_execution_id = ${base?.execution_id ?? null}::uuid, finished_at = now(), updated_at = now()
     WHERE execution_id = ${i.executionId}::uuid`;
  await addUsage(tx, i.orgId, { "deepscan.scans": 1, "deepscan.duration_ms": i.durationMs, ...(status === "PARTIAL" ? { "deepscan.partial_scans": 1 } : {}) });
  return { status, complete, stopReason, outcome, pagesChecked: checkedPages.length, findings: { opened, recurred, reopened, resolved, total: seen.size }, incidents: incidentActions };
}
