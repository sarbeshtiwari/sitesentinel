"use client";
import { Badge, Card, EmptyState, PageHeader } from "@wim/ui";
import { History } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FilterSelect, LoadMore, QueryState } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import { fmtUtc, outcome, presetRange, SOURCE_LABEL, useHistory } from "@/lib/monitoring";
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
  // group by UTC day for readability
  const days = new Map<string, typeof rows>();
  for (const r of rows) { const d = r.at.slice(0, 10); days.set(d, [...(days.get(d) ?? []), r]); }

  return (
    <>
      <PageHeader title="Monitoring history" description="Every recorded check, incident change, configuration change and interruption, newest first. Times in UTC." />
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect label="Website" value={f.websiteId} onChange={(v) => set("websiteId", v)} options={[["", "All websites"], ...(sites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        <FilterSelect label="Event" value={f.type} onChange={(v) => set("type", v)} options={[["", "All events"], ["CHECK", "Checks"], ["INCIDENT", "Incidents"], ["CONFIG", "Configuration"], ["VERIFICATION", "Verification"], ["INTERRUPTION", "Interruptions"], ["COMPONENT", "Component changes"], ["FUNCTIONAL", "Functional test failures"], ["RESPONSIVE", "Responsive problems"]]} />
        <FilterSelect label="Source" value={f.source} onChange={(v) => set("source", v)} options={[["", "All"], ["HTTP", "HTTP"], ["BROWSER", "Browser"], ["DEEP_SCAN", "Deep scan"]]} />
        <FilterSelect label="Result" value={f.result} onChange={(v) => set("result", v)} options={[["", "Any"], ["PASSED", "Passed"], ["FAILED", "Failed"], ["INCONCLUSIVE", "Inconclusive"]]} />
        <FilterSelect label="Period" value={f.since} onChange={(v) => set("since", v)} options={[["", "All retained"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
      </div>
      <QueryState q={q}>
        {!rows.length ? <EmptyState icon={<History />} title="Nothing recorded yet" description="Events appear here as monitoring runs. Only recorded events are shown — nothing is generated." /> : (
          <div className="grid gap-4">
            {[...days].map(([day, items]) => (
              <Card key={day} className="p-4">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{day}</h2>
                <ul className="divide-y divide-border">
                  {items.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{e.at.slice(11, 16)}</span>
                      <Badge tone={e.type === "INTERRUPTION" ? "neutral" : e.type === "INCIDENT" ? "warning" : "neutral"}>{TYPE_LABEL[e.type]}</Badge>
                      {e.result && e.type === "CHECK" && <Badge tone={outcome(e.result).tone}>{outcome(e.result).label}</Badge>}
                      {e.link ? <Link className="hover:underline" href={`/o/${orgId}${e.link}`}>{e.title}</Link> : <span>{e.title}</span>}
                      <span className="text-xs text-muted-foreground">{[e.websiteName, e.source ? SOURCE_LABEL[e.source] : null].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            <LoadMore q={q} />
            <p className="text-xs text-muted-foreground">{fmtUtc(rows[rows.length - 1]?.at)} is the oldest event loaded.{q.data?.pages[0]?.retention ? ` Checks are kept ${q.data.pages[0].retention.checksDays} days and browser results ${q.data.pages[0].retention.browserDays} days; older events have expired, not disappeared.` : ""}</p>
          </div>
        )}
      </QueryState>
    </>
  );
}
