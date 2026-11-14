"use client";
import { Badge, Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { Siren } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { FilterSelect, LoadMore, QueryState } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import { fmtDuration, fmtUtc, INCIDENT_STATUS, presetRange, SEVERITY_TONE, SOURCE_LABEL, useIncidents } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";

const STATUSES: Array<[string, string]> = [["ACTIVE", "Active (open, acknowledged, reopened)"], ["OPEN", "Open"], ["ACKNOWLEDGED", "Acknowledged"], ["REOPENED", "Reopened"], ["RESOLVED", "Resolved"], ["ALL", "All"]];

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
      <PageHeader title="Incidents" description="Problems detected by HTTP, browser and deep-scan monitoring, grouped into incidents. Times in UTC." />
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect label="Status" value={f.status} onChange={(v) => set("status", v)} options={STATUSES} />
        <FilterSelect label="Severity" value={f.severity} onChange={(v) => set("severity", v)} options={[["", "All"], ["CRITICAL", "Critical"], ["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"], ["INFO", "Info"]]} />
        <FilterSelect label="Source" value={f.source} onChange={(v) => set("source", v)} options={[["", "All"], ["HTTP", "HTTP availability"], ["BROWSER", "Browser"], ["DEEP_SCAN", "Deep scan"]]} />
        <FilterSelect label="Website" value={f.websiteId} onChange={(v) => set("websiteId", v)} options={[["", "All websites"], ...(sites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        <FilterSelect label="Active during" value={f.since} onChange={(v) => set("since", v)} options={[["", "Any time"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
      </div>
      <QueryState q={q}>
        {!rows.length ? (
          <EmptyState icon={<Siren />} title={f.status === "ACTIVE" ? "No active incidents" : "No incidents match"}
            description={f.status === "ACTIVE" ? "Nothing is failing right now. Incidents open automatically when monitoring confirms a problem, and recover automatically." : "Try other filters."} />
        ) : (
          <Card className="overflow-hidden">
            <Table>
              <THead><TR>
                <TH>Incident</TH><TH>Status</TH><TH>Severity</TH><TH className="hidden md:table-cell">Source</TH>
                <TH className="hidden lg:table-cell">First detected</TH><TH className="hidden lg:table-cell">Last detected</TH><TH className="hidden md:table-cell">Occurrences</TH><TH className="hidden xl:table-cell">Duration</TH>
              </TR></THead>
              <TBody>
                {rows.map((i) => {
                  const st = INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
                  const active = i.status !== "RESOLVED" && i.status !== "IGNORED";
                  return (
                    <TR key={i.id} className={active ? "" : "text-muted-foreground"}>
                      <TD>
                        <Link href={`/o/${orgId}/incidents/${i.id}`} className={`font-medium hover:underline ${active ? "" : "font-normal"}`}>INC-{i.number} · {i.title}</Link>
                        <div className="text-xs text-muted-foreground">{i.websiteName}</div>
                      </TD>
                      <TD><Badge tone={st.tone}>{st.label}</Badge></TD>
                      <TD><Badge tone={active ? SEVERITY_TONE[i.severity] : "neutral"}>{i.severity}</Badge></TD>
                      <TD className="hidden text-xs md:table-cell">{SOURCE_LABEL[i.source ?? ""] ?? i.source}</TD>
                      <TD className="hidden text-xs lg:table-cell">{fmtUtc(i.firstDetectedAt)}</TD>
                      <TD className="hidden text-xs lg:table-cell">{fmtUtc(i.lastDetectedAt)}</TD>
                      <TD className="hidden tabular-nums md:table-cell">{i.occurrenceCount}</TD>
                      <TD className="hidden text-xs xl:table-cell">{fmtDuration((i as { durationSec?: number }).durationSec)}{active ? " (ongoing)" : ""}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <LoadMore q={q} />
          </Card>
        )}
      </QueryState>
    </>
  );
}
