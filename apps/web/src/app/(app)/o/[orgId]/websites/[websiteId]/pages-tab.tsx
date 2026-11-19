"use client";
import { Alert, Badge, Card, EmptyState, FilterChip, Input, Pagination, Select, Table, TBody, TD, TH, THead, TR, Tooltip, type BadgeTone } from "@wim/ui";
import { ArrowDown, ArrowUp, ArrowUpDown, FileText, ScanSearch, Search } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { cn } from "@wim/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { QueryState } from "@/components/monitoring";
import { get } from "@/lib/api";
import { fmtMs, fmtTime, mk, useDebounced } from "@/lib/monitoring";
import { PerfBadge } from "./performance-tab";

// ----------------------------------------------------------------------------------------------- shared with page detail
export type PageState = "CHECKED" | "NOT_CHECKED" | "FAILED" | "SKIPPED";
export type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export interface PageFacts {
  id: string; url: string; path: string; title: string | null; discovered: boolean; inventoryStatus: string | null;
  state: PageState; scanState: string | null; httpStatus: number | null; skipReason: string | null; error: string | null;
  source: string; inSitemap: boolean; firstReferrer: string | null; depth: number;
  firstSeenAt: string | null; lastSeenAt: string | null; lastCheckedAt: string | null; lastExecutionId: string | null;
  score: number | null; scoreBand: "GOOD" | "NEEDS_WORK" | "POOR" | null; scoreBasis: "NOT_CHECKED" | "BROKEN" | "FINDINGS";
  openFindings: number; bySeverity: Record<Sev, number>; byGroup: Record<string, number>;
}
export const SCORE_FORMULA_TEXT = "Score = 100 − for each open finding on this page: critical 25, high 15, medium 8, low 3, info 0 (never below 0). A page that doesn't load scores 0; pages not checked yet have no score. 90+ good · 50–89 needs work · below 50 poor.";
const BAND: Record<string, { tone: BadgeTone; label: string }> = { GOOD: { tone: "success", label: "Good" }, NEEDS_WORK: { tone: "warning", label: "Needs work" }, POOR: { tone: "danger", label: "Poor" } };
export const SEV_ORDER: Sev[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const SEV_CHIP: Record<Sev, { tone: BadgeTone; short: string }> = { CRITICAL: { tone: "danger", short: "Crit" }, HIGH: { tone: "danger", short: "High" }, MEDIUM: { tone: "warning", short: "Med" }, LOW: { tone: "neutral", short: "Low" }, INFO: { tone: "info", short: "Info" } };
export const SKIP_REASON: Record<string, string> = {
  ROBOTS: "blocked by robots.txt", ROBOTS_DISALLOWED: "blocked by robots.txt", UNSAFE_ROUTE: "looks like an action (logout, delete, checkout…) — never fetched", OUT_OF_SCOPE: "outside the scan scope",
  EXCLUDED: "excluded by your scan settings", NOT_INCLUDED: "not in the include patterns", NO_ADDRESSES: "the host has no address", MAX_DEPTH: "deeper than the depth limit",
};
export const skipText = (r: string | null) => (r ? (SKIP_REASON[r] ?? (/^BLOCKED_/.test(r) ? "destination refused by our safety gateway" : r.toLowerCase().replace(/_/g, " "))) : "skipped");
export const SOURCE: Record<string, string> = { SITEMAP: "sitemap", CRAWL: "link", START: "start page", BROWSER: "browser monitoring", SDK: "SDK", MANUAL: "added manually", ROBOTS: "robots.txt" };

/** Coloured score badge with the formula as tooltip. */
export function ScoreBadge({ score, band, basis }: { score: number | null; band: string | null; basis?: string }) {
  const tip = basis === "BROKEN" ? `The page doesn't load, so it scores 0. ${SCORE_FORMULA_TEXT}` : SCORE_FORMULA_TEXT;
  return (
    <Tooltip content={tip}>
      <span tabIndex={0} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {score === null ? <Badge>Not checked yet</Badge> : <Badge tone={BAND[band ?? ""]?.tone ?? "neutral"} className="min-w-10 justify-center whitespace-nowrap" aria-label={`Score ${score} of 100, ${BAND[band ?? ""]?.label ?? ""}`}><span className="tabular-nums font-semibold">{score}</span><span className="sr-only">· {BAND[band ?? ""]?.label}</span></Badge>}
      </span>
    </Tooltip>
  );
}

export function SeverityChips({ counts }: { counts: Record<Sev, number> }) {
  return <span className="inline-flex flex-wrap gap-1">{SEV_ORDER.filter((s) => counts[s] > 0).map((s) => <Badge key={s} tone={SEV_CHIP[s].tone} title={`${counts[s]} ${s.toLowerCase()}`}>{counts[s]} {SEV_CHIP[s].short}</Badge>)}</span>;
}

/** Check status: HTTP code / not checked / failed / skipped. */
export function PageStatusBadge({ p }: { p: Pick<PageFacts, "state" | "httpStatus" | "skipReason" | "scanState" | "error"> }) {
  switch (p.state) {
    case "CHECKED": return <Badge tone="success">{p.httpStatus ?? "Checked"}</Badge>;
    case "FAILED": return <Badge tone="danger">{p.httpStatus ? `HTTP ${p.httpStatus}` : (p.error ? p.error.toLowerCase().replace(/_/g, " ") : "Failed")}</Badge>;
    case "SKIPPED": return <Tooltip content={`Skipped: ${skipText(p.skipReason)}`}><span tabIndex={0}><Badge>Skipped</Badge></span></Tooltip>;
    default: return <Badge tone="info">{p.scanState === "INCONCLUSIVE" ? "Inconclusive" : "Not checked yet"}</Badge>;
  }
}

/** "found via sitemap / link from …" */
export function provenance(p: Pick<PageFacts, "source" | "inSitemap" | "firstReferrer">) {
  const parts: string[] = [];
  if (p.inSitemap || p.source === "SITEMAP") parts.push("sitemap");
  if (p.firstReferrer) parts.push(`link from ${pathOnly(p.firstReferrer)}`);
  if (!parts.length) parts.push(SOURCE[p.source] ?? p.source.toLowerCase());
  return `Found via ${parts.join(" · ")}`;
}
export const pathOnly = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };

// ----------------------------------------------------------------------------------------------- list
interface PageRow extends PageFacts {
  monitoring: { browser: boolean; deepScan: boolean; monitoredPageId: string | null };
  browser: { lastResultAt: string | null; lcpP75_24h: number | null; lcpSamples_24h: number; lcpStatus: "GOOD" | "NEEDS_IMPROVEMENT" | "POOR" | "INSUFFICIENT_DATA" } | null;
  components: { present: number; changes7d: number } | null; responsive: { failedViewports: number; viewports: number } | null;
}
interface PagesResp {
  data: PageRow[]; total: number; page: number; pageSize: number; pages: number;
  summary: { total: number; checked: number; notChecked: number; failed: number; skipped: number; withFindings: number };
  latestScan: { executionId: string; status: string; stopReason: string | null; partial: boolean; notChecked: number; finishedAt: string | null } | null;
  runningScan: { executionId: string; startedAt: string | null } | null;
  scope: { browserPath: string; browserMonitoring: boolean; note: string };
}
type SortKey = "path" | "score" | "findings";
const FILTERS: Array<[string, string, keyof PagesResp["summary"]]> = [["all", "All", "total"], ["with_findings", "With issues", "withFindings"], ["failed", "Broken", "failed"], ["not_checked", "Not checked yet", "notChecked"], ["skipped", "Skipped", "skipped"]];
const STOP: Record<string, string> = { DURATION: "stopped at the time limit", PAGE_LIMIT: "stopped at the page limit", REQUEST_BUDGET: "used up its request budget", DAILY_QUOTA: "hit the daily page quota", CANCELLED: "was cancelled", INFRASTRUCTURE: "was interrupted by our infrastructure" };

function SortTH({ k, sort, onSort, children, className }: { k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (k: SortKey) => void; children: React.ReactNode; className?: string }) {
  return (
    <TH className={className} aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 uppercase tracking-[0.07em] hover:text-foreground" onClick={() => onSort(k)}>
        {children}{sort.key === k ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />) : <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />}
      </button>
    </TH>
  );
}

export function PagesTab({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "path", dir: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("25");
  const s = useDebounced(search);
  useEffect(() => setPage(1), [s, filter, sort, pageSize]);
  const qs = new URLSearchParams({ page: String(page), pageSize, sort: `${sort.key}:${sort.dir}`, filter, ...(s ? { search: s } : {}) });
  const q = useQuery({
    queryKey: [...mk.site(orgId, websiteId), "pages", qs.toString()],
    queryFn: ({ signal }) => get<PagesResp>(`/orgs/${orgId}/websites/${websiteId}/pages?${qs}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const rows = d?.data ?? [];
  const base = `/o/${orgId}/websites/${websiteId}/pages`;
  const toggle = (key: SortKey) => setSort((x) => (x.key === key ? { key, dir: x.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "findings" ? "desc" : "asc" }));
  const ls = d?.latestScan;
  return (
    <div className="grid gap-4">
      {ls?.partial && ls.notChecked > 0 && (
        <Alert tone="info" title={`The last scan ${STOP[ls.stopReason ?? ""] ?? "didn't finish"}`}>
          {ls.notChecked} page{ls.notChecked === 1 ? " is" : "s are"} listed as <strong>Not checked yet</strong> and will be checked by the next scans.
          {d?.runningScan ? " A scan is running now." : ""}
        </Alert>
      )}
      {d && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground"><ScanSearch className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Every page we know of: pages checked by deep scans, pages found in your sitemap or through links that haven&apos;t been checked yet, and the browser-monitored page (<code className="font-mono">{d.scope.browserPath}</code>{d.scope.browserMonitoring ? "" : ", browser monitoring not active"}).
            {ls?.finishedAt ? ` Last scan ${fmtTime(ls.finishedAt)}.` : ""}{d.runningScan ? " A scan is running now." : ""}</span></p>
      )}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="relative block">
            <span className="sr-only">Search URL or title</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle-foreground" aria-hidden />
            <Input className="h-9 pl-8 sm:w-64" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search URL or title" />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {FILTERS.map(([v, label, key]) => <FilterChip key={v} selected={filter === v} count={d ? d.summary[key] : undefined} onClick={() => setFilter(v)}>{label}</FilterChip>)}
          </div>
        </div>
        {d && <p className="text-sm text-muted-foreground"><span className="font-semibold tabular-nums text-foreground">{d.total}</span> page{d.total === 1 ? "" : "s"}{d.total !== d.summary.total ? ` of ${d.summary.total}` : ""}{d.summary.notChecked ? ` · ${d.summary.notChecked} not checked yet` : ""}</p>}
      </div>
      <Card className="overflow-hidden">
        <QueryState q={q} skeleton="h-40 m-4">
          {!rows.length ? (
            d && d.summary.total === 0
              ? <EmptyState icon={<FileText />} title="No pages discovered yet" description="Pages appear after the first deep scan and from the browser-monitored page." />
              : <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No pages match.</p>
          ) : (
            <>
              <Table aria-busy={q.isFetching}>
                <THead><TR>
                  <SortTH k="score" sort={sort} onSort={toggle}>Score</SortTH>
                  <SortTH k="path" sort={sort} onSort={toggle}>Page</SortTH>
                  <SortTH k="findings" sort={sort} onSort={toggle} className="hidden sm:table-cell">Open findings</SortTH>
                  <TH className="hidden md:table-cell">Status</TH>
                  <TH className="hidden md:table-cell">Monitoring</TH>
                  <TH className="hidden lg:table-cell">LCP p75 (24 h)</TH><TH className="hidden xl:table-cell">Components</TH><TH className="hidden xl:table-cell">Responsive</TH>
                </TR></THead>
                <TBody>{rows.map((p) => (
                  <TR key={p.id}>
                    <TD><ScoreBadge score={p.score} band={p.scoreBand} basis={p.scoreBasis} /></TD>
                    <TD className="max-w-80">
                      <Link href={`${base}/${p.id}`} className="break-all font-mono text-[13px] font-medium hover:text-primary">{p.path}</Link>
                      {p.title && <div className="truncate text-xs text-muted-foreground">{p.title}</div>}
                      <div className={cn("truncate text-xs", p.source === "CRAWL" && !p.inSitemap ? "text-warning-text" : "text-subtle-foreground")}>{provenance(p)}</div>
                      <div className="mt-1 md:hidden"><PageStatusBadge p={p} /></div>
                    </TD>
                    <TD className="hidden text-xs sm:table-cell">
                      {p.openFindings > 0
                        ? <Link href={`${base}/${p.id}`} className="grid gap-1 hover:text-primary"><span className="font-medium">{p.openFindings} open finding{p.openFindings === 1 ? "" : "s"}</span><SeverityChips counts={p.bySeverity} /></Link>
                        : <span className="text-muted-foreground">{p.state === "CHECKED" ? "None" : "—"}</span>}
                    </TD>
                    <TD className="hidden text-xs md:table-cell"><PageStatusBadge p={p} /><div className="mt-0.5 text-muted-foreground">{p.lastCheckedAt ? fmtTime(p.lastCheckedAt) : p.state === "NOT_CHECKED" ? "queued" : ""}</div></TD>
                    <TD className="hidden text-xs md:table-cell">{p.monitoring.browser ? <Badge tone="brand">Browser</Badge> : null} {p.monitoring.deepScan ? <Badge>Deep scan</Badge> : null}{!p.monitoring.browser && !p.monitoring.deepScan ? <span className="text-muted-foreground">Discovered only</span> : null}</TD>
                    <TD className="hidden text-xs lg:table-cell">{p.browser ? <>{fmtMs(p.browser.lcpP75_24h)} <PerfBadge s={p.browser.lcpStatus} /> <span className="text-muted-foreground">({p.browser.lcpSamples_24h})</span></> : "—"}</TD>
                    <TD className="hidden text-xs xl:table-cell">{p.components ? `${p.components.present}${p.components.changes7d ? ` · ${p.components.changes7d} change(s) in 7 d` : ""}` : "—"}</TD>
                    <TD className="hidden text-xs xl:table-cell">{p.responsive ? (p.responsive.failedViewports ? <Badge tone="danger">{p.responsive.failedViewports}/{p.responsive.viewports} viewports fail</Badge> : <Badge tone="success">{p.responsive.viewports} viewports OK</Badge>) : "—"}</TD>
                  </TR>
                ))}</TBody>
              </Table>
              {d && (
                <Pagination className="border-t border-border px-4 pb-3 sm:px-5" page={d.page} pages={d.pages} onPage={setPage}
                  label={`${(d.page - 1) * d.pageSize + 1}–${Math.min(d.page * d.pageSize, d.total)} of ${d.total}`}
                  trailing={<label className="flex items-center gap-1.5 text-xs text-muted-foreground">Per page
                    <Select className="h-8 w-auto min-w-0 py-0 text-xs" value={pageSize} onChange={(e) => setPageSize(e.target.value)}>
                      {["10", "25", "50", "100"].map((v) => <option key={v} value={v}>{v}</option>)}
                    </Select></label>} />
              )}
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
