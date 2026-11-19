"use client";
import { Card, cn, EmptyState, FilterChip, PageHeader, SeverityBadge, StatusPill, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { CheckCircle2, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { LoadMore, QueryState } from "@/components/monitoring";
import { ChipDivider, ChipRow, ChipSelect } from "@/components/org-ui";
import { useOrg } from "@/lib/hooks";
import { fmtDuration, fmtTime, INCIDENT_STATUS, presetRange, SOURCE_LABEL, useIncidents } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";
import { AREA_LABEL, incidentArea } from "../websites/[websiteId]/website-data";

const STATUSES: Array<[string, string]> = [["ACTIVE", "Active"], ["OPEN", "Open"], ["ACKNOWLEDGED", "Acknowledged"], ["REOPENED", "Reopened"], ["RESOLVED", "Resolved"], ["ALL", "All"]];
const STATUS_HELP = "Active = open, acknowledged or reopened";

export default function IncidentsPage() {
  const { orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Filters live in the URL: shareable, survive reloads, back button works.
  const f = { status: params.get("status") ?? "ACTIVE", severity: params.get("severity") ?? "", source: params.get("source") ?? "", websiteId: params.get("websiteId") ?? "", since: params.get("since") ?? "" };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  // Links in notifications (including emails already sent) use ?incident=<id>.
  const legacy = params.get("incident");
  useEffect(() => { if (legacy && /^[0-9a-f-]{36}$/.test(legacy)) router.replace(`/o/${orgId}/incidents/${legacy}`); }, [legacy, orgId, router]);
  const sites = useWebsites(orgId);
  const q = useIncidents(orgId, { status: f.status, severity: f.severity || undefined, source: f.source || undefined, websiteId: f.websiteId || undefined, from: f.since ? presetRange(f.since as "24h").from : undefined });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader title="Issues" description="Problems detected by HTTP, browser and deep-scan monitoring, grouped into incidents across your websites. Deep-scan findings of each page are on the website's Issues tab. Times in your time zone." />
      <ChipRow label="Filter issues">
        <div role="radiogroup" aria-label="Status" title={STATUS_HELP} className="flex flex-wrap gap-1.5">
          {STATUSES.map(([v, l]) => <FilterChip key={v} role="radio" aria-checked={f.status === v} aria-pressed={undefined} selected={f.status === v} onClick={() => set("status", v === "ACTIVE" ? "" : v)}>{l}</FilterChip>)}
        </div>
        <ChipDivider />
        <ChipSelect label="Website" value={f.websiteId} onChange={(v) => set("websiteId", v)} options={[["", "All websites"], ...(sites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        <ChipSelect label="Area (detected by)" value={f.source} onChange={(v) => set("source", v)} options={[["", "All areas"], ["HTTP", "Availability (HTTP)"], ["BROWSER", "Browser checks"], ["DEEP_SCAN", "Deep scan"]]} />
        <ChipSelect label="Severity" value={f.severity} onChange={(v) => set("severity", v)} options={[["", "Any severity"], ["CRITICAL", "Critical"], ["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"], ["INFO", "Info"]]} />
        <ChipSelect label="Active during" value={f.since} onChange={(v) => set("since", v)} options={[["", "Any time"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
      </ChipRow>
      <QueryState q={q}>
        {!rows.length ? (
          // "Nothing is failing" is only true when no other filter narrows the active list.
          f.status === "ACTIVE" && !f.severity && !f.source && !f.websiteId && !f.since
            ? <EmptyState icon={<CheckCircle2 />} title="No active incidents" description="Nothing is failing right now. Incidents open automatically when monitoring confirms a problem, and recover automatically." />
            : <EmptyState icon={<SearchX />} title="No incidents match" description="Try other filters." />
        ) : (
          <>
            {/* Cards on small screens */}
            <ul className="grid gap-2.5 md:hidden">
              {rows.map((i) => {
                const st = INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
                const active = i.status !== "RESOLVED" && i.status !== "IGNORED";
                return (
                  <li key={i.id}>
                    <Card className="relative px-4 py-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <SeverityBadge severity={i.severity} />
                        <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(i.durationSec)}{active ? " so far" : ""}</span>
                      </div>
                      <Link href={`/o/${orgId}/incidents/${i.id}`} className={cn("mt-1.5 block font-semibold after:absolute after:inset-0", !active && "font-medium text-muted-foreground")}><span className="sr-only">INC-{i.number} · </span>{i.title}</Link>
                      <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{i.websiteName} · {AREA_LABEL[incidentArea(i)]}</p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><StatusPill tone={st.tone}>{st.label}</StatusPill><span>INC-{i.number} · {i.occurrenceCount} occurrences</span></p>
                    </Card>
                  </li>
                );
              })}
            </ul>
            {/* Table from md up */}
            <Card className="hidden overflow-hidden md:block">
              <Table>
                <THead><TR>
                  <TH>Issue</TH><TH>Severity</TH><TH className="hidden lg:table-cell">Website</TH><TH>Started</TH><TH className="hidden xl:table-cell">Last detected</TH>
                  <TH className="hidden text-right xl:table-cell">Occurrences</TH><TH>Duration</TH><TH>Status</TH>
                </TR></THead>
                <TBody>
                  {rows.map((i) => {
                    const st = INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
                    const active = i.status !== "RESOLVED" && i.status !== "IGNORED";
                    return (
                      <TR key={i.id} className={active ? "" : "text-muted-foreground"}>
                        <TD className="max-w-md">
                          <Link href={`/o/${orgId}/incidents/${i.id}`} className={cn("hover:text-primary", active ? "font-medium text-foreground" : "font-normal")}><span className="sr-only">INC-{i.number} · </span>{i.title}</Link>
                          <div className="truncate text-xs text-muted-foreground">{AREA_LABEL[incidentArea(i)]} · {SOURCE_LABEL[i.source ?? ""] ?? i.source} · INC-{i.number}<span className="lg:hidden"> · {i.websiteName}</span></div>
                        </TD>
                        <TD><SeverityBadge severity={i.severity} /></TD>
                        <TD className="hidden max-w-48 truncate lg:table-cell">{i.websiteName}</TD>
                        <TD className="whitespace-nowrap text-xs tabular-nums">{fmtTime(i.firstDetectedAt)}</TD>
                        <TD className="hidden whitespace-nowrap text-xs tabular-nums xl:table-cell">{fmtTime(i.lastDetectedAt)}</TD>
                        <TD className="hidden text-right tabular-nums xl:table-cell">{i.occurrenceCount}</TD>
                        <TD className="whitespace-nowrap text-xs">{fmtDuration(i.durationSec)}{active ? " (ongoing)" : ""}</TD>
                        <TD><StatusPill tone={st.tone}>{st.label}</StatusPill></TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </Card>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{rows.length} incident{rows.length === 1 ? "" : "s"} loaded{q.hasNextPage ? " · more available" : ""}</span>
            </div>
            <LoadMore q={q} />
          </>
        )}
      </QueryState>
    </>
  );
}
