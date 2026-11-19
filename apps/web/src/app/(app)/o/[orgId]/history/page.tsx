"use client";
import { Card, EmptyState, FilterChip, PageHeader, SegmentedControl, StatusPill } from "@wim/ui";
import { History, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Hint, LoadMore, QueryState } from "@/components/monitoring";
import { ChipDivider, ChipRow, ChipSelect, dayLabel } from "@/components/org-ui";
import { useOrg } from "@/lib/hooks";
import { fmtTime, localDay, outcome, presetRange, SOURCE_LABEL, useHistory } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";

const TYPE_LABEL: Record<string, string> = { CHECK: "Check", INCIDENT: "Incident", CONFIG: "Configuration", VERIFICATION: "Verification", INTERRUPTION: "Interruption", COMPONENT: "Component", FUNCTIONAL: "Functional test", RESPONSIVE: "Responsive" };

const EVENTS: Array<[string, string]> = [["", "All events"], ["CHECK", "Checks"], ["INCIDENT", "Incidents"], ["CONFIG", "Configuration"], ["VERIFICATION", "Verification"], ["INTERRUPTION", "Interruptions"], ["COMPONENT", "Component changes"], ["FUNCTIONAL", "Functional test failures"], ["RESPONSIVE", "Responsive problems"]];
const localTime = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

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
      <PageHeader title="Monitoring history" description="Every recorded check, incident change, configuration change and interruption, newest first. Use it to answer “what happened last Tuesday?” Times in your time zone." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl label="Period" value={f.since || "all"} onChange={(v) => set("since", v === "all" ? "" : v)}
          items={[{ value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "all", label: "All retained" }]} />
      </div>
      <ChipRow label="Filter events">
        <div role="radiogroup" aria-label="Event" className="flex flex-wrap gap-1.5">
          {EVENTS.map(([v, l]) => <FilterChip key={v || "all"} role="radio" aria-checked={f.type === v} aria-pressed={undefined} selected={f.type === v} onClick={() => set("type", v)}>{l}</FilterChip>)}
        </div>
        <ChipDivider />
        <ChipSelect label="Website" value={f.websiteId} onChange={(v) => set("websiteId", v)} options={[["", "All websites"], ...(sites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        <ChipSelect label="Source" value={f.source} onChange={(v) => set("source", v)} options={[["", "All sources"], ["HTTP", "HTTP"], ["BROWSER", "Browser"], ["DEEP_SCAN", "Deep scan"]]} />
        <ChipSelect label="Result" value={f.result} onChange={(v) => set("result", v)} options={[["", "Any result"], ["PASSED", "Passed"], ["FAILED", "Failed"], ["INCONCLUSIVE", "Inconclusive"]]} />
      </ChipRow>
      <QueryState q={q}>
        {!rows.length ? (Object.values(f).some(Boolean)
          ? <EmptyState icon={<SearchX />} title="No events match" description="Try other filters. Only recorded events are shown — nothing is generated." />
          : <EmptyState icon={<History />} title="Nothing recorded yet" description="Events appear here as monitoring runs. Only recorded events are shown — nothing is generated." />) : (
          <div className="grid gap-5">
            {[...days].map(([day, items]) => (
              <section key={day} aria-label={`${dayLabel(day)}, ${items.length} event${items.length === 1 ? "" : "s"}`}>
                <h2 className="mb-2 text-[13px] font-medium text-muted-foreground">{dayLabel(day)} <span className="font-normal">· {day} · {items.length} event{items.length === 1 ? "" : "s"} loaded</span></h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-border">
                    {items.map((e) => {
                      const o = e.result ? outcome(e.result) : null;
                      const dot = e.type === "INCIDENT" ? "bg-warning" : e.type === "CONFIG" || e.type === "VERIFICATION" ? "bg-primary" : o?.tone === "danger" ? "bg-danger" : o?.tone === "success" ? "bg-success" : "bg-faint";
                      return (
                        <li key={e.id} className="flex items-start gap-3 px-4 py-3 text-sm sm:px-5">
                          <time dateTime={e.at} className="w-11 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{localTime(e.at)}</time>
                          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
                          <div className="min-w-0 flex-1">
                            {e.link ? <Link className="break-words font-medium hover:text-primary" href={`/o/${orgId}${e.link}`}>{e.title}</Link> : <span className="break-words font-medium">{e.title}</span>}
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span>{TYPE_LABEL[e.type]}</span>
                              {[e.websiteName, e.source ? SOURCE_LABEL[e.source] : null].filter(Boolean).map((x) => <span key={x}>· {x}</span>)}
                              {o && e.type === "CHECK" && <StatusPill tone={o.tone} className="py-0">{o.label}</StatusPill>}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              </section>
            ))}
            <LoadMore q={q} />
            <Hint>{fmtTime(rows[rows.length - 1]?.at)} is the oldest event loaded.{q.data?.pages[0]?.retention ? ` Checks are kept ${q.data.pages[0].retention.checksDays} days and browser results ${q.data.pages[0].retention.browserDays} days; older events have expired, not disappeared.` : ""}</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
