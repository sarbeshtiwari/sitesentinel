"use client";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Input, MetricCard, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, FileSearch, History, ListTree, Loader2, Pause, Play, ScanSearch, ShieldAlert, Square, Timer, Unlink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DataEnvelope } from "@wim/contracts";
import { FilterSelect, Hint, QueryState, Section } from "@/components/monitoring";
import { errorMessage, get, post } from "@/lib/api";
import { fmtDuration, fmtTime, mk, SCAN_STATUS, SEVERITY_TONE, useDebounced } from "@/lib/monitoring";

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
  entitled: boolean; enabled: boolean; pausedReason: string | null; resuming?: boolean; nextRunAt: string | null; latestScan: ScanDto | null;
  /** a scan waiting for the scanner (no scan record yet) */
  pending?: { executionId: string; status: string; queuedAt: string } | null;
  openFindings: Array<{ group: string; severity: string; count: number }>; effectiveLimits: { maxPages: number; maxDepth: number; browserPages: number; externalLinks: boolean };
}
export const GROUP_LABEL: Record<string, string> = { broken_pages: "Broken pages", broken_resources: "Broken resources", forms: "Forms & search", sitemap: "Sitemap", seo: "SEO", accessibility: "Accessibility (automated checks)", structure: "Structure" };
const STOP_LABEL: Record<string, string> = {
  FRONTIER_EXHAUSTED: "Every discovered page was checked", PAGE_LIMIT: "Stopped at the page limit", DURATION: "Stopped at the time limit", REQUEST_BUDGET: "Request budget used up",
  DAILY_QUOTA: "Daily page quota reached", INFRASTRUCTURE: "Our infrastructure failed (not your website)", NO_PAGE_REACHABLE: "No page could be reached safely",
  CANCELLED: "Cancelled", ABANDONED: "Stopped without finishing (scanner interrupted)", INCOMPLETE: "Not every page was checked",
};
export const stopLabel = (s: string | null) => (s ? STOP_LABEL[s] ?? s : "—");

export function ScanStatusBadge({ s }: { s: Pick<ScanDto, "status" | "complete" | "stopReason"> }) {
  const st = s.status === "PARTIAL" && s.stopReason === "INFRASTRUCTURE" ? { ...SCAN_STATUS.INCONCLUSIVE!, label: "Infrastructure failure" } : SCAN_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const, help: "" };
  return <span className="inline-flex items-center gap-1.5"><Badge tone={st.tone} title={st.help}>{st.label}</Badge>{s.status === "COMPLETED" && !s.complete && <Badge tone="warning" title="Limits stopped part of the site from being checked">Limited coverage</Badge>}</span>;
}

export function DeepScanTab({ orgId, websiteId, canWrite, entitledReason }: { orgId: string; websiteId: string; canWrite: boolean; entitledReason: string | null }) {
  const qc = useQueryClient();
  const base = `/orgs/${orgId}/websites/${websiteId}/deep-scan`;
  // A requested scan exists only as a queued job until the scanner picks it up: poll quickly until it shows up.
  const [pending, setPending] = useState<{ executionId: string; since: number } | null>(null);
  const sum = useQuery({
    queryKey: mk.deep(orgId, websiteId), queryFn: ({ signal }) => get<DataEnvelope<SummaryDto>>(base, { signal }).then((r) => r.data),
    refetchInterval: (q) => (pending || q.state.data?.pending || q.state.data?.resuming ? 2000 : q.state.data?.latestScan?.status === "RUNNING" ? 3000 : false),
  });
  const scans = useQuery({ queryKey: [...mk.deep(orgId, websiteId), "scans"], queryFn: ({ signal }) => get<DataEnvelope<ScanDto[]>>(`${base}/scans?limit=20`, { signal }).then((r) => r.data) });
  const [f, setF] = useState({ status: "OPEN", group: "", severity: "", url: "" });
  const url = useDebounced(f.url);
  const findings = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "findings", { ...f, url }],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto[]>>(`${base}/findings?${new URLSearchParams({ status: f.status, limit: "200", ...(f.group ? { group: f.group } : {}), ...(f.severity ? { severity: f.severity } : {}), ...(url ? { url } : {}) })}`, { signal }).then((r) => r.data),
  });
  const [confirm, setConfirm] = useState<null | "cancel">(null);
  const [busy, setBusy] = useState<null | "start" | "schedule" | "cancel">(null);
  const act = async <T,>(kind: NonNullable<typeof busy>, fn: () => Promise<T>, ok: string): Promise<T | undefined> => {
    setBusy(kind);
    try { const r = await fn(); toast.success(ok); await qc.invalidateQueries({ queryKey: mk.deep(orgId, websiteId) }); return r; }
    catch (e) { toast.error(errorMessage(e)); return undefined; }
    finally { setBusy(null); }
  };
  const startScan = async () => {
    const r = await act("start", () => post<DataEnvelope<{ executionId: string }>>(`${base}/start`), "Scan requested");
    if (r) setPending({ executionId: r.data.executionId, since: Date.now() });
  };
  const s = sum.data;
  const latest = s?.latestScan;
  const running = latest?.status === "RUNNING";
  // the requested scan is visible (running or already finished): stop the fast polling
  useEffect(() => { if (pending && latest?.executionId === pending.executionId) setPending(null); }, [pending, latest?.executionId]);
  // queued = requested here and not visible yet, or reported by the API (e.g. a scheduled scan, or one from another tab)
  const queued = s?.pending ?? null;
  const waiting = Boolean((pending && latest?.executionId !== pending.executionId) || queued);
  const queuedSince = queued ? new Date(queued.queuedAt).getTime() : pending?.since ?? Date.now();
  const slow = waiting && Date.now() - queuedSince > 60_000;
  const schedulePaused = s?.pausedReason === "DISABLED_BY_CUSTOMER";
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
            <Section title="Deep scans" icon={<ScanSearch />} description={s.enabled ? (s.nextRunAt ? `Next scheduled scan ${fmtTime(s.nextRunAt)}` : "Scheduled") : s.pausedReason === "DISABLED_BY_CUSTOMER" ? "Paused by your organisation" : "Not scheduled yet"}
              actions={canWrite && s.entitled && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* one primary action for the scan itself… */}
                  {running ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirm("cancel")}><Square /> Cancel scan</Button>
                    : waiting ? (queued ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirm("cancel")}><Square /> Cancel queued scan</Button> : <Button size="sm" disabled loading>Starting…</Button>)
                    : s.resuming ? <Button size="sm" disabled loading>Resuming…</Button>
                    : s.enabled && <Button size="sm" loading={busy === "start"} disabled={busy !== null} onClick={startScan}><Play /> Start scan</Button>}
                  {/* …and the automatic schedule, labelled as such (it doesn't stop a scan that is running) */}
                  <Button size="sm" variant="ghost" loading={busy === "schedule"} disabled={busy !== null || Boolean(s.resuming)}
                    title={schedulePaused ? "Turn deep scans back on (scheduled and manual)" : "Stop all deep scans for this website — scheduled and manual — and cancel one in progress"}
                    onClick={() => act("schedule", () => post(`${base}/pause`, { paused: !schedulePaused }), schedulePaused ? "Deep scans resumed" : "Deep scans paused")}>
                    {schedulePaused ? <><Play /> Resume deep scans</> : <><Pause /> Pause deep scans</>}
                  </Button>
                </div>
              )}>
              {waiting && (
                <Alert tone={slow ? "warning" : "info"} className="mb-4" title={slow ? `A scan has been queued since ${fmtTime(new Date(queuedSince).toISOString())}` : "Scan queued — waiting for the scanner to start it"}>
                  {slow ? "The scanner hasn't picked it up. The deep-scan worker may not be running; you can cancel the queued scan and start a new one once it is." : "This usually takes a few seconds; the page updates on its own."}
                </Alert>
              )}
              {!latest ? <EmptyState icon={<ScanSearch />} title="No scan has run yet." description={canWrite && s.enabled ? "Start a scan now, or wait for the next scheduled one." : undefined} /> : (
                <div className="grid gap-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-sunken/50 px-3.5 py-2.5 text-sm">
                    {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />}
                    <span><span className="text-muted-foreground">Latest:</span> <Link className="font-medium hover:text-primary" href={`${pagePath}/scans/${latest.executionId}`}>{fmtTime(latest.startedAt)}</Link></span>
                    <ScanStatusBadge s={latest} /><span className="text-xs text-muted-foreground">{running ? "in progress…" : stopLabel(latest.stopReason)}</span>
                  </div>
                  {latest.status !== "COMPLETED" && !running && <Hint>A {latest.status.toLowerCase()} scan did not check everything: it never marks findings as fixed or pages as removed.</Hint>}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <MetricCard label="Pages discovered" icon={<FileSearch />} tone="brand" value={latest.coverage.pagesDiscovered} hint={`${latest.coverage.pagesChecked} checked · ${latest.coverage.pagesSkippedByPolicy} skipped by policy · ${latest.coverage.pagesNotCrawledLimits} over limits`} />
                    <MetricCard label="Broken pages" icon={<Unlink />} tone={count("broken_pages") ? "danger" : "neutral"} value={count("broken_pages")} hint={`${count("broken_resources")} broken resources`} />
                    <MetricCard label="SEO / structure" icon={<ListTree />} tone={count("seo") + count("structure") + count("sitemap") ? "warning" : "neutral"} value={count("seo") + count("structure") + count("sitemap")} hint={`${count("accessibility")} accessibility (automated)`} />
                    <MetricCard label="Duration" icon={<Timer />} tone="info" value={latest.finishedAt && latest.stopReason !== "ABANDONED" ? fmtDuration(Math.round((new Date(latest.finishedAt).getTime() - new Date(latest.startedAt).getTime()) / 1000)) : "—"} hint={latest.stopReason === "ABANDONED" ? "The scan stopped without finishing" : `${latest.requests} requests · ${latest.coverage.resourcesChecked} resources`} />
                  </div>
                  {completed && <Hint>Last completed scan: <Link className="text-foreground hover:text-primary" href={`${pagePath}/scans/${completed.executionId}`}>{fmtTime(completed.startedAt)}</Link>. Limits: up to {s.effectiveLimits.maxPages} pages, depth {s.effectiveLimits.maxDepth}{s.effectiveLimits.browserPages ? ", browser-assisted discovery" : ""}{s.effectiveLimits.externalLinks ? ", external links" : ""}. <Link className="text-primary hover:underline" href={`/o/${orgId}/usage`}>Usage against quota</Link></Hint>}
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
                          <TD className="hidden text-xs text-muted-foreground lg:table-cell">{x.occurrenceCount}× · last {fmtTime(x.lastDetectedAt)}</TD>
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
                      <THead><TR><TH>Started</TH><TH>Status</TH><TH className="hidden md:table-cell">Pages checked</TH><TH className="hidden md:table-cell">Findings</TH><TH className="hidden lg:table-cell">Trigger</TH></TR></THead>
                      <TBody>
                        {scans.data.map((x) => (
                          <TR key={x.executionId}>
                            <TD className="whitespace-nowrap text-xs"><Link className="font-medium hover:text-primary" href={`${pagePath}/scans/${x.executionId}`}>{fmtTime(x.startedAt)}</Link></TD>
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
      <ConfirmDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title={running ? "Cancel the running scan?" : "Cancel the queued scan?"}
        description="Pages already checked are kept. A cancelled scan never resolves findings." confirmLabel="Cancel scan" destructive
        loading={busy === "cancel"} onConfirm={() => { const id = running ? latest?.executionId : queued?.executionId ?? latest?.executionId; if (id) void act("cancel", () => post(`${base}/scans/${id}/cancel`), "Scan cancelled").then(() => setConfirm(null)); }} />
    </div>
  );
}
