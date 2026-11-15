"use client";
import { Badge, EmptyState, FilterBar, PageHeader } from "@wim/ui";
import { History, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Dot, FilterSelect, Hint, LoadMore, QueryState, Section } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import { fmtTime, localDay, outcome, presetRange, SOURCE_LABEL, useHistory } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";

const TYPE_LABEL: Record<string, string> = { CHECK: "Check", INCIDENT: "Incident", CONFIG: "Configuration", VERIFICATION: "Verification", INTERRUPTION: "Interruption", COMPONENT: "Component", FUNCTIONAL: "Functional test", RESPONSIVE: "Responsive" };

export default function HistoryPage() {
  const { orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const f = { websiteId: params.get("websiteId") ?? "", type: params.get("type") ?? "", source: params.get("source") ?? "", result: params.get("result") ?? "", since: params.get("since") ?? "" };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  const sites = useWebsites(orgId);
  const q = useHistory(orgId, { websiteId: f.websiteId || undefined, type: f.type || undefined, source: f.source || undefined, result: f.result || undefined, from: f.since ? presetRange(f.since as "24h").from : undefined });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  // group by day (viewer's time zone) for readability
  const days = new Map<string, typeof rows>();
  for (const r of rows) { const d = localDay(r.at); days.set(d, [...(days.get(d) ?? []), r]); }

  return (
    <>
      <PageHeader title="Monitoring history" description="Every recorded check, incident change, configuration change and interruption, newest first. Times in your time zone." />
      <FilterBar>
        <FilterSelect label="Website" value={f.websiteId} onChange={(v) => set("websiteId", v)} options={[["", "All websites"], ...(sites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        <FilterSelect label="Event" value={f.type} onChange={(v) => set("type", v)} options={[["", "All events"], ["CHECK", "Checks"], ["INCIDENT", "Incidents"], ["CONFIG", "Configuration"], ["VERIFICATION", "Verification"], ["INTERRUPTION", "Interruptions"], ["COMPONENT", "Component changes"], ["FUNCTIONAL", "Functional test failures"], ["RESPONSIVE", "Responsive problems"]]} />
        <FilterSelect label="Source" value={f.source} onChange={(v) => set("source", v)} options={[["", "All"], ["HTTP", "HTTP"], ["BROWSER", "Browser"], ["DEEP_SCAN", "Deep scan"]]} />
        <FilterSelect label="Result" value={f.result} onChange={(v) => set("result", v)} options={[["", "Any"], ["PASSED", "Passed"], ["FAILED", "Failed"], ["INCONCLUSIVE", "Inconclusive"]]} />
        <FilterSelect label="Period" value={f.since} onChange={(v) => set("since", v)} options={[["", "All retained"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
      </FilterBar>
      <QueryState q={q}>
        {!rows.length ? (Object.values(f).some(Boolean)
          ? <EmptyState icon={<SearchX />} title="No events match" description="Try other filters. Only recorded events are shown — nothing is generated." />
          : <EmptyState icon={<History />} title="Nothing recorded yet" description="Events appear here as monitoring runs. Only recorded events are shown — nothing is generated." />) : (
          <div className="grid gap-4">
            {[...days].map(([day, items]) => (
              <Section key={day} title={day} description={`${items.length} event${items.length === 1 ? "" : "s"} loaded`} flush>
                <ul className="divide-y divide-border">
                  {items.map((e) => (
                    <li key={e.id} className="flex items-start gap-3 px-4 py-2.5 text-sm sm:px-5">
                      <span className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{e.at.slice(11, 16)}</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
                        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Badge tone={e.type === "INTERRUPTION" ? "neutral" : e.type === "INCIDENT" ? "warning" : "neutral"}>{TYPE_LABEL[e.type]}</Badge>
                          {e.result && e.type === "CHECK" && <Badge tone={outcome(e.result).tone}><Dot tone={outcome(e.result).tone} />{outcome(e.result).label}</Badge>}
                        </span>
                        {e.link ? <Link className="min-w-0 break-words font-medium hover:text-primary" href={`/o/${orgId}${e.link}`}>{e.title}</Link> : <span className="min-w-0 break-words">{e.title}</span>}
                        <span className="text-xs text-muted-foreground">{[e.websiteName, e.source ? SOURCE_LABEL[e.source] : null].filter(Boolean).join(" · ")}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            ))}
            <LoadMore q={q} />
            <Hint>{fmtTime(rows[rows.length - 1]?.at)} is the oldest event loaded.{q.data?.pages[0]?.retention ? ` Checks are kept ${q.data.pages[0].retention.checksDays} days and browser results ${q.data.pages[0].retention.browserDays} days; older events have expired, not disappeared.` : ""}</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
