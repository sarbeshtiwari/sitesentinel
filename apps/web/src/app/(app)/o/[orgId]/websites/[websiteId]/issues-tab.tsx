"use client";
import { Button, buttonVariants, Card, cn, FilterChip, Input, Select, SeverityBadge, Skeleton, StatusPill, toast } from "@wim/ui";
import { ArrowRight, CheckCircle2, ChevronRight, Copy, Search, Siren, Wrench } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ErrorState } from "@wim/ui";
import { Hint } from "@/components/monitoring";
import { errorMessage, post } from "@/lib/api";
import { fmtTime, INCIDENT_STATUS, localDay, mk, useDebounced } from "@/lib/monitoring";
import { DeepScanPanel, findingReason, GROUP_LABEL } from "./deepscan-tab";
import { AREA_LABEL, byImpact, byNewest, useWebsiteProblems, type Area, type Problem } from "./website-data";

const pathOf = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };
const unit = (p: Problem) => (p.area === "broken" || p.area === "sitemap" ? ["URL", "URLs"] : ["page", "pages"]) as [string, string];

export function IssuesTab({ orgId, websiteId, canWrite, canAck, section, deepEntitledReason }: {
  orgId: string; websiteId: string; canWrite: boolean; canAck: boolean; section: string | null; deepEntitledReason: string | null;
}) {
  const params = useSearchParams();
  const [status, setStatus] = useState<"OPEN" | "FIXED">("OPEN");
  const [area, setArea] = useState<Area | "">("");
  const [sort, setSort] = useState<"impact" | "newest">("impact");
  const [severity, setSeverity] = useState("");
  const [urlRaw, setUrl] = useState("");
  const url = useDebounced(urlRaw.trim());
  const [open, setOpen] = useState<Set<string>>(() => new Set(params.get("open") ? [params.get("open")!] : []));
  const opts = { url: url || undefined, severity: severity || undefined };
  const openQ = useWebsiteProblems(orgId, websiteId, "OPEN", opts);
  const fixedQ = useWebsiteProblems(orgId, websiteId, "FIXED", opts);
  const q = status === "OPEN" ? openQ : fixedQ;
  const counts = useMemo(() => {
    const c = new Map<Area, number>();
    for (const p of q.list) c.set(p.area, (c.get(p.area) ?? 0) + 1);
    return c;
  }, [q.list]);
  useEffect(() => { if (area && !counts.has(area)) setArea(""); }, [area, counts]);
  const rows = q.list.filter((p) => !area || p.area === area).sort(sort === "impact" ? byImpact : byNewest);
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const deepFirst = section === "deep-scan";

  return (
    <div className="grid gap-5">
      <DeepScanPanel orgId={orgId} websiteId={websiteId} canWrite={canWrite} entitledReason={deepEntitledReason} defaultOpenHistory={deepFirst} />
      <section aria-labelledby="issue-list" className="grid gap-3">
        <h2 id="issue-list" className="sr-only">Issues</h2>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter issues">
            <FilterChip selected={status === "OPEN"} count={openQ.isLoading ? undefined : openQ.list.length} onClick={() => setStatus("OPEN")}>Open</FilterChip>
            <FilterChip selected={status === "FIXED"} count={fixedQ.isLoading ? undefined : fixedQ.list.length} onClick={() => setStatus("FIXED")}>Fixed</FilterChip>
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />
            <FilterChip selected={area === ""} onClick={() => setArea("")}>All areas</FilterChip>
            {(Object.keys(AREA_LABEL) as Area[]).filter((a) => counts.has(a)).map((a) => (
              <FilterChip key={a} selected={area === a} count={counts.get(a)} onClick={() => setArea(area === a ? "" : a)}>{AREA_LABEL[a]}</FilterChip>
            ))}
          </div>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">Sort
            <Select className="h-8 w-auto py-0 text-xs" value={sort} onChange={(e) => setSort(e.target.value as "impact" | "newest")}>
              <option value="impact">Impact</option><option value="newest">Newest</option>
            </Select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">URL contains
            <span className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle-foreground" aria-hidden />
              <Input className="h-8 w-full pl-8 sm:w-52" value={urlRaw} onChange={(e) => setUrl(e.target.value)} placeholder="/blog" /></span>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">Severity
            <Select className="h-8 w-auto py-0 text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All</option>{["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
            </Select>
          </label>
          {url && <p className="pb-1.5 text-xs text-muted-foreground">Incidents have no single URL, so only deep-scan findings are filtered by URL.</p>}
        </div>
        {q.isLoading ? <div role="status" aria-label="Loading"><Skeleton className="h-48" /></div>
          : q.incidents.isError && q.findings.isError ? <ErrorState title="Couldn't load this data" description={errorMessage(q.error)} onRetry={q.refetch} />
          : (
            <Card className="overflow-hidden">
              {(q.incidents.isError || q.findings.isError) && <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-warning-text">{q.incidents.isError ? "Incidents" : "Deep-scan findings"} couldn&apos;t be loaded: {errorMessage(q.incidents.error ?? q.findings.error)}</p>}
              {!rows.length ? (
                <p className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                  {status === "OPEN" ? (url || severity || area ? "No open issues match." : "No open issues: no active incidents and no open deep-scan findings.") : "Nothing fixed matches."}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((p) => <IssueRow key={p.key} p={p} orgId={orgId} websiteId={websiteId} canAck={canAck} expanded={open.has(p.key)} onToggle={() => toggle(p.key)} />)}
                </ul>
              )}
            </Card>
          )}
        <p className="text-xs text-muted-foreground">
          Incidents come from uptime, browser and performance checks; findings from deep scans. <Link className="text-primary hover:underline" href={`/o/${orgId}/incidents?websiteId=${websiteId}&status=ALL`}>All incidents of this website</Link>
        </p>
      </section>
    </div>
  );
}

function IssueRow({ p, orgId, websiteId, canAck, expanded, onToggle }: { p: Problem; orgId: string; websiteId: string; canAck: boolean; expanded: boolean; onToggle: () => void }) {
  const n = p.findings.length;
  const [one, many] = unit(p);
  const id = `issue-${p.key.replace(/[^a-z0-9]/gi, "-")}`;
  const sub = p.kind === "incident" ? p.summary : n === 1 ? (p.summary ?? pathOf(p.findings[0]!.subject)) : p.impact;
  const group = p.findings[0] ? GROUP_LABEL[p.findings[0].group] ?? p.findings[0].group : null;
  return (
    <li className={cn(expanded && "bg-sunken/40")}>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={onToggle}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3.5 text-left hover:bg-sunken/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5">
        <ChevronRight className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} aria-hidden />
        <SeverityBadge severity={p.severity} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium leading-snug">{p.title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground"><span className="font-medium">{AREA_LABEL[p.area]}</span>{sub ? <> · <span className="break-words">{sub}</span></> : null}</span>
        </span>
        <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
          <span className="block">{p.kind === "incident" ? `INC-${p.incident!.number}` : `${n} ${n === 1 ? one : many}`}</span>
          <span className="block">{p.status === "FIXED" && p.resolvedAt ? `fixed ${localDay(p.resolvedAt)}` : `since ${localDay(p.since)}`}</span>
        </span>
      </button>
      {expanded && (
        <div id={id} className="grid gap-4 px-4 pb-5 sm:pl-12 sm:pr-5">
          <p className="text-xs text-muted-foreground sm:hidden">{p.kind === "incident" ? `INC-${p.incident!.number}` : `${n} ${n === 1 ? one : many}`} · {p.status === "FIXED" && p.resolvedAt ? `fixed ${localDay(p.resolvedAt)}` : `since ${localDay(p.since)}`}</p>
          {p.kind === "incident" ? <IncidentBody p={p} orgId={orgId} canAck={canAck} /> : <FindingBody p={p} orgId={orgId} websiteId={websiteId} group={group} />}
        </div>
      )}
    </li>
  );
}

function IncidentBody({ p, orgId, canAck }: { p: Problem; orgId: string; canAck: boolean }) {
  const i = p.incident!;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const st = INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
  const acknowledge = async () => {
    setBusy(true);
    try {
      const r = await post<{ data: { changed: boolean } }>(`/orgs/${orgId}/incidents/${i.id}/acknowledge`);
      toast.success(r.data.changed ? "Incident acknowledged" : "Already acknowledged");
      await qc.invalidateQueries({ queryKey: mk.all(orgId) });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
        <span className="text-xs text-muted-foreground">Detected {fmtTime(i.firstDetectedAt)} · last {fmtTime(i.lastDetectedAt)} · {i.occurrenceCount}× · {i.source ? `${i.source.replace("_", " ").toLowerCase()} check` : ""}{i.acknowledgedAt ? ` · acknowledged ${fmtTime(i.acknowledgedAt)}` : ""}{i.resolvedAt ? ` · resolved ${fmtTime(i.resolvedAt)}` : ""}</span>
      </div>
      {i.description && <p className="text-sm leading-relaxed">{i.description}</p>}
      <div className="flex flex-wrap gap-2">
        <Link href={`/o/${orgId}/incidents/${i.id}`} className={buttonVariants({ size: "sm" })}>View incident <ArrowRight /></Link>
        {canAck && (i.status === "OPEN" || i.status === "REOPENED") && <Button size="sm" variant="secondary" loading={busy} disabled={busy} onClick={acknowledge}><Siren /> {busy ? "Acknowledging…" : "Acknowledge"}</Button>}
      </div>
    </>
  );
}

function FindingBody({ p, orgId, websiteId, group }: { p: Problem; orgId: string; websiteId: string; group: string | null }) {
  const base = `/o/${orgId}/websites/${websiteId}/deep-scan/findings`;
  const hasSuggest = p.findings.some((f) => typeof f.evidence.suggestedUrl === "string");
  const hasStatus = p.findings.some((f) => typeof f.evidence.status === "number" || typeof f.evidence.error === "string");
  const [all, setAll] = useState(false);
  const shown = all ? p.findings : p.findings.slice(0, 25);
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.findings.map((f) => f.subject).join("\n")); toast.success(`${p.findings.length} URL${p.findings.length === 1 ? "" : "s"} copied`); }
    catch { toast.error("Couldn't copy — select the text and copy it manually"); }
  };
  return (
    <>
      {p.impact && <p className="text-sm leading-relaxed">{p.impact}</p>}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-sunken"><tr className="text-left text-[10.5px] uppercase tracking-[0.07em] text-muted-foreground">
              <th scope="col" className="px-3.5 py-2 font-medium">Where</th>
              {hasStatus && <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Returns</th>}
              {hasSuggest && <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Use this page instead</th>}
              <th scope="col" className="hidden px-3.5 py-2 text-right font-medium lg:table-cell">Seen</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {shown.map((f) => {
                const why = findingReason(f.evidence);
                const status = typeof f.evidence.status === "number" ? String(f.evidence.status) : typeof f.evidence.error === "string" ? f.evidence.error.toLowerCase().replace(/_/g, " ") : null;
                return (
                  <tr key={f.id} className="align-top">
                    <td className="max-w-0 px-3.5 py-2.5 sm:w-1/2">
                      <Link href={`${base}/${f.id}`} className="block break-all font-mono text-xs font-medium hover:text-primary">{pathOf(f.subject)}</Link>
                      {why && <span className="mt-0.5 block text-xs text-muted-foreground">{why}</span>}
                    </td>
                    {hasStatus && <td className="hidden px-3 py-2.5 font-mono text-xs text-danger-text sm:table-cell">{status ?? "—"}</td>}
                    {hasSuggest && <td className="hidden break-all px-3 py-2.5 font-mono text-xs text-success-text md:table-cell">{typeof f.evidence.suggestedUrl === "string" ? <>→ {pathOf(f.evidence.suggestedUrl)}</> : "—"}</td>}
                    <td className="hidden whitespace-nowrap px-3.5 py-2.5 text-right text-xs text-muted-foreground lg:table-cell">{f.occurrenceCount}× · last {fmtTime(f.lastDetectedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.findings.length > shown.length && <button type="button" className="w-full border-t border-border px-3.5 py-2 text-left text-xs font-medium text-primary hover:bg-sunken" onClick={() => setAll(true)}>Show all {p.findings.length}</button>}
      </div>
      {p.fix && (
        <div className="rounded-lg bg-success-soft px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-success-text"><Wrench className="h-3.5 w-3.5" aria-hidden />How to fix</p>
          <p className="mt-1 text-sm leading-relaxed">{p.fix}</p>
        </div>
      )}
      {p.findings[0]?.group === "accessibility" && <Hint>Automated accessibility check — useful signal, not a WCAG conformance assessment.</Hint>}
      <div className="flex flex-wrap items-center gap-2">
        {p.findings.length === 1 && <Link href={`${base}/${p.findings[0]!.id}`} className={buttonVariants({ size: "sm" })}>Open finding <ArrowRight /></Link>}
        <Button size="sm" variant="secondary" onClick={copy}><Copy /> Copy {p.findings.length === 1 ? "URL" : "URLs"}</Button>
        <span className="text-xs text-muted-foreground">{group} · fixed automatically when a complete scan no longer finds it</span>
      </div>
    </>
  );
}
