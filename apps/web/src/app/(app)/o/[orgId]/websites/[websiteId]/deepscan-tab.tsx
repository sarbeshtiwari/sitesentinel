"use client";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Input, MetricCard, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, FileSearch, History, ListTree, Loader2, Pause, Play, ScanSearch, ShieldAlert, Square, Timer, Unlink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { DataEnvelope } from "@wim/contracts";
import { FilterSelect, Hint, QueryState, Section } from "@/components/monitoring";
import { errorMessage, get, post } from "@/lib/api";
import { fmtDuration, fmtUtc, mk, SCAN_STATUS, SEVERITY_TONE, useDebounced } from "@/lib/monitoring";

export interface ScanDto {
  executionId: string; trigger: string; status: string; complete: boolean; stopReason: string | null;
  coverage: { pagesDiscovered: number; pagesChecked: number; pagesFailed: number; pagesSkippedByPolicy: number; pagesNotCrawledLimits: number; pagesInconclusive: number; resourcesChecked: number };
  requests: number; bytes: number; findingsOpened: number; findingsResolved: number; startedAt: string; finishedAt: string | null; baselineExecutionId: string | null;
}
export interface FindingDto {
  id: string; category: string; group: string; severity: string; status: string; subject: string; title: string; evidence: Record<string, unknown>;
  impact: string | null; recommendation: string; detectionMethod: string; automated: boolean; occurrenceCount: number; firstDetectedAt: string; lastDetectedAt: string; resolvedAt: string | null;
}
interface SummaryDto {
  entitled: boolean; enabled: boolean; pausedReason: string | null; nextRunAt: string | null; latestScan: ScanDto | null;
  openFindings: Array<{ group: string; severity: string; count: number }>; effectiveLimits: { maxPages: number; maxDepth: number; browserPages: number; externalLinks: boolean };
}
export const GROUP_LABEL: Record<string, string> = { broken_pages: "Broken pages", broken_resources: "Broken resources", forms: "Forms & search", sitemap: "Sitemap", seo: "SEO", accessibility: "Accessibility (automated checks)", structure: "Structure" };
const STOP_LABEL: Record<string, string> = {
  FRONTIER_EXHAUSTED: "Every discovered page was checked", PAGE_LIMIT: "Stopped at the page limit", DURATION: "Stopped at the time limit", REQUEST_BUDGET: "Request budget used up",
  DAILY_QUOTA: "Daily page quota reached", INFRASTRUCTURE: "Our infrastructure failed (not your website)", NO_PAGE_REACHABLE: "No page could be reached safely",
  CANCELLED: "Cancelled", ABANDONED: "Abandoned", INCOMPLETE: "Not every page was checked",
};
export const stopLabel = (s: string | null) => (s ? STOP_LABEL[s] ?? s : "—");

export function ScanStatusBadge({ s }: { s: Pick<ScanDto, "status" | "complete" | "stopReason"> }) {
  const st = s.status === "PARTIAL" && s.stopReason === "INFRASTRUCTURE" ? { ...SCAN_STATUS.INCONCLUSIVE!, label: "Infrastructure failure" } : SCAN_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const, help: "" };
  return <span className="inline-flex items-center gap-1.5"><Badge tone={st.tone} title={st.help}>{st.label}</Badge>{s.status === "COMPLETED" && !s.complete && <Badge tone="warning" title="Limits stopped part of the site from being checked">Limited coverage</Badge>}</span>;
}

export function DeepScanTab({ orgId, websiteId, canWrite, entitledReason }: { orgId: string; websiteId: string; canWrite: boolean; entitledReason: string | null }) {
  const qc = useQueryClient();
  const base = `/orgs/${orgId}/websites/${websiteId}/deep-scan`;
  const sum = useQuery({ queryKey: mk.deep(orgId, websiteId), queryFn: ({ signal }) => get<DataEnvelope<SummaryDto>>(base, { signal }).then((r) => r.data), refetchInterval: (q) => (q.state.data?.latestScan?.status === "RUNNING" ? 5000 : false) });
  const scans = useQuery({ queryKey: [...mk.deep(orgId, websiteId), "scans"], queryFn: ({ signal }) => get<DataEnvelope<ScanDto[]>>(`${base}/scans?limit=20`, { signal }).then((r) => r.data) });
  const [f, setF] = useState({ status: "OPEN", group: "", severity: "", url: "" });
  const url = useDebounced(f.url);
  const findings = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "findings", { ...f, url }],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto[]>>(`${base}/findings?${new URLSearchParams({ status: f.status, limit: "200", ...(f.group ? { group: f.group } : {}), ...(f.severity ? { severity: f.severity } : {}), ...(url ? { url } : {}) })}`, { signal }).then((r) => r.data),
  });
  const [confirm, setConfirm] = useState<null | "cancel">(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await qc.invalidateQueries({ queryKey: mk.deep(orgId, websiteId) }); } catch (e) { toast.error(errorMessage(e)); }
  };
  const s = sum.data;
  const latest = s?.latestScan;
  const running = latest?.status === "RUNNING";
  const completed = scans.data?.find((x) => x.status === "COMPLETED");
  const count = (g: string) => s?.openFindings.filter((x) => x.group === g).reduce((a, b) => a + b.count, 0) ?? 0;
  const pagePath = `/o/${orgId}/websites/${websiteId}/deep-scan`;

  return (
    <div className="grid gap-5">
      <QueryState q={sum}>
        {s && !s.entitled && !scans.data?.length ? (
          <Section title="Deep scans" icon={<ScanSearch />}>
            <EmptyState icon={<ScanSearch />} title={`Deep scans are unavailable: ${entitledReason ?? "not included in your plan"}.`}
              description="A deep scan crawls your verified website (only its own pages, respecting robots.txt) and reports broken pages and resources, SEO, structure and automated accessibility issues." />
          </Section>
        ) : s && (
          <>
            {!s.entitled && (
              // Past scans and findings stay readable when new scans aren't available (plan or platform switch).
              <Alert tone="warning" title={`New deep scans are unavailable: ${entitledReason ?? "not included in your plan"}.`}>Earlier scans and their findings are shown below.</Alert>
            )}
            <Section title="Deep scans" icon={<ScanSearch />} description={s.enabled ? (s.nextRunAt ? `Next scheduled scan ${fmtUtc(s.nextRunAt)}` : "Scheduled") : s.pausedReason === "DISABLED_BY_CUSTOMER" ? "Paused by your organisation" : "Not scheduled yet"}
              actions={canWrite && s.entitled && (
                <div className="flex flex-wrap gap-2">
                  {!running && s.enabled && <Button size="sm" onClick={() => act(() => post(`${base}/start`), "Scan requested")}><Play /> Start scan</Button>}
                  {running && <Button size="sm" variant="outline" onClick={() => setConfirm("cancel")}><Square /> Cancel scan</Button>}
                  <Button size="sm" variant="outline" onClick={() => act(() => post(`${base}/pause`, { paused: s.pausedReason !== "DISABLED_BY_CUSTOMER" }), s.pausedReason === "DISABLED_BY_CUSTOMER" ? "Deep scans resumed" : "Deep scans paused")}>
                    {s.pausedReason === "DISABLED_BY_CUSTOMER" ? <><Play /> Resume</> : <><Pause /> Pause</>}
                  </Button>
                </div>
              )}>
              {!latest ? <EmptyState icon={<ScanSearch />} title="No scan has run yet." description={canWrite && s.enabled ? "Start a scan now, or wait for the next scheduled one." : undefined} /> : (
                <div className="grid gap-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-sunken/50 px-3.5 py-2.5 text-sm">
                    {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />}
                    <span><span className="text-muted-foreground">Latest:</span> <Link className="font-medium hover:text-primary" href={`${pagePath}/scans/${latest.executionId}`}>{fmtUtc(latest.startedAt)}</Link></span>
                    <ScanStatusBadge s={latest} /><span className="text-xs text-muted-foreground">{running ? "in progress…" : stopLabel(latest.stopReason)}</span>
                  </div>
                  {latest.status !== "COMPLETED" && !running && <Hint>A {latest.status.toLowerCase()} scan did not check everything: it never marks findings as fixed or pages as removed.</Hint>}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <MetricCard label="Pages discovered" icon={<FileSearch />} tone="brand" value={latest.coverage.pagesDiscovered} hint={`${latest.coverage.pagesChecked} checked · ${latest.coverage.pagesSkippedByPolicy} skipped by policy · ${latest.coverage.pagesNotCrawledLimits} over limits`} />
                    <MetricCard label="Broken pages" icon={<Unlink />} tone={count("broken_pages") ? "danger" : "neutral"} value={count("broken_pages")} hint={`${count("broken_resources")} broken resources`} />
                    <MetricCard label="SEO / structure" icon={<ListTree />} tone={count("seo") + count("structure") + count("sitemap") ? "warning" : "neutral"} value={count("seo") + count("structure") + count("sitemap")} hint={`${count("accessibility")} accessibility (automated)`} />
                    <MetricCard label="Duration" icon={<Timer />} tone="info" value={latest.finishedAt ? fmtDuration(Math.round((new Date(latest.finishedAt).getTime() - new Date(latest.startedAt).getTime()) / 1000)) : "—"} hint={`${latest.requests} requests · ${latest.coverage.resourcesChecked} resources`} />
                  </div>
                  {completed && <Hint>Last completed scan: <Link className="text-foreground hover:text-primary" href={`${pagePath}/scans/${completed.executionId}`}>{fmtUtc(completed.startedAt)}</Link>. Limits: up to {s.effectiveLimits.maxPages} pages, depth {s.effectiveLimits.maxDepth}{s.effectiveLimits.browserPages ? ", browser-assisted discovery" : ""}{s.effectiveLimits.externalLinks ? ", external links" : ""}. <Link className="text-primary hover:underline" href={`/o/${orgId}/usage`}>Usage against quota</Link></Hint>}
                </div>
              )}
            </Section>
            <Section title="Findings" icon={<ShieldAlert />} flush>
              <div className="border-b border-border px-4 py-3 sm:px-5">
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end [&_select]:min-w-0 sm:[&_select]:min-w-36">
                <FilterSelect label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[["OPEN", "Open"], ["RESOLVED", "Resolved"], ["ALL", "All"]]} />
                <FilterSelect label="Category" value={f.group} onChange={(v) => setF({ ...f, group: v })} options={[["", "All"], ...Object.entries(GROUP_LABEL)]} />
                <FilterSelect label="Severity" value={f.severity} onChange={(v) => setF({ ...f, severity: v })} options={[["", "All"], ["CRITICAL", "Critical"], ["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"], ["INFO", "Info"]]} />
                <label className="grid gap-1 text-xs font-medium text-muted-foreground">URL contains<Input className="h-9 sm:w-44" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="/blog" /></label>
              </div>
              </div>
              <QueryState q={findings} skeleton="h-40 m-4">
                {!findings.data?.length ? <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-5"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />No findings match.</p> : (
                  <Table>
                    <THead><TR><TH>Finding</TH><TH>Severity</TH><TH className="hidden md:table-cell">Where</TH><TH className="hidden lg:table-cell">Seen</TH><TH>Status</TH></TR></THead>
                    <TBody>
                      {findings.data.map((x) => (
                        <TR key={x.id}>
                          <TD className="max-w-96"><Link className="font-medium hover:text-primary" href={`${pagePath}/findings/${x.id}`}>{x.title}</Link><div className="text-xs text-muted-foreground">{GROUP_LABEL[x.group] ?? x.group}</div></TD>
                          <TD><Badge tone={SEVERITY_TONE[x.severity]}>{x.severity}</Badge></TD>
                          <TD className="hidden max-w-72 truncate font-mono text-xs md:table-cell">{x.subject}</TD>
                          <TD className="hidden text-xs text-muted-foreground lg:table-cell">{x.occurrenceCount}× · last {fmtUtc(x.lastDetectedAt)}</TD>
                          <TD><Badge tone={x.status === "OPEN" ? "warning" : "success"}>{x.status === "OPEN" ? "Open" : "Resolved"}</Badge></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </QueryState>
            </Section>
            <Section title="Scan history" icon={<History />} flush>
              <QueryState q={scans} skeleton="h-32 m-4">
                {!scans.data?.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No scans yet.</p> : (
                  <>
                    <Table>
                      <THead><TR><TH>Started (UTC)</TH><TH>Status</TH><TH className="hidden md:table-cell">Pages checked</TH><TH className="hidden md:table-cell">Findings</TH><TH className="hidden lg:table-cell">Trigger</TH></TR></THead>
                      <TBody>
                        {scans.data.map((x) => (
                          <TR key={x.executionId}>
                            <TD className="whitespace-nowrap text-xs"><Link className="font-medium hover:text-primary" href={`${pagePath}/scans/${x.executionId}`}>{fmtUtc(x.startedAt)}</Link></TD>
                            <TD><ScanStatusBadge s={x} /></TD>
                            <TD className="hidden tabular-nums md:table-cell">{x.coverage.pagesChecked} / {x.coverage.pagesDiscovered}</TD>
                            <TD className="hidden text-xs tabular-nums md:table-cell"><span className="text-danger">+{x.findingsOpened}</span> <span className="text-muted-foreground">·</span> <span className="text-success">−{x.findingsResolved}</span></TD>
                            <TD className="hidden text-xs lg:table-cell">{x.trigger === "MANUAL" ? "Manual" : "Scheduled"}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </>
                )}
              </QueryState>
            </Section>
          </>
        )}
      </QueryState>
      <ConfirmDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel the running scan?"
        description="Pages already checked are kept. A cancelled scan never resolves findings." confirmLabel="Cancel scan" destructive
        onConfirm={() => latest && act(() => post(`${base}/scans/${latest.executionId}/cancel`), "Scan cancelled").then(() => setConfirm(null))} />
    </div>
  );
}
