"use client";
/**
 * Organisation analytics from existing APIs only: the monitoring overview (uptime, synthetic performance) and each
 * website's HTTP analytics for the chosen range. Real-visitor numbers are not shown: no such API exists yet.
 */
import type { DataEnvelope, HttpAnalyticsDto } from "@wim/contracts";
import { Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { useQueries } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PerfBadge } from "../websites/[websiteId]/performance-tab";
import { tabHref } from "../websites/[websiteId]/website-data";
import { Hint, QueryState, RangePicker } from "@/components/monitoring";
import { StatStrip, type Stat } from "@/components/org-ui";
import { get } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmtMs, fmtPct, fmtTime, mk, presetRange, rangeQs, useOverview } from "@/lib/monitoring";

const fmtSec = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/** One website's average response per bucket: single-hue bars, gaps where nothing was measured. */
function ResponseBars({ a, name }: { a: HttpAnalyticsDto; name: string }) {
  const s = a.series;
  const vals = s.map((x) => x.avgMs).filter((v): v is number => v != null);
  if (!vals.length) return <p className="py-6 text-sm text-muted-foreground">No measured checks in this range.</p>;
  const max = Math.max(...vals);
  return (
    <figure>
      <ol role="img" aria-label={`${name}: average response time per ${a.bucketSec >= 86_400 ? "day" : "bucket"}, ${fmtMs(Math.min(...vals))} to ${fmtMs(max)}`} className="flex h-28 items-end gap-[2px] border-b border-border">
        {s.map((x) => (
          <li key={x.t} title={`${fmtTime(x.t)}: ${x.avgMs == null ? "no data" : fmtMs(x.avgMs)}`} className="flex h-full min-w-0 flex-1 items-end">
            {x.avgMs != null ? <span className="block w-full rounded-t-[3px] bg-primary" style={{ height: `${Math.max(3, (x.avgMs / max) * 100)}%` }} /> : <span className="block h-[3px] w-full bg-muted" />}
          </li>
        ))}
      </ol>
      <figcaption className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground"><span>{fmtTime(s[0]?.t)}</span><span>max {fmtMs(max)}</span></figcaption>
    </figure>
  );
}

export default function AnalyticsPage() {
  const { orgId } = useOrg();
  const [range, setRange] = useState(() => presetRange("7d"));
  const q = useOverview(orgId, range);
  const sites = (q.data?.websites ?? []).filter((w) => w.verification === "VERIFIED");
  const an = useQueries({
    queries: sites.map((w) => ({
      queryKey: mk.analytics(orgId, w.id, range),
      queryFn: ({ signal }: { signal: AbortSignal }) => get<DataEnvelope<HttpAnalyticsDto>>(`/orgs/${orgId}/websites/${w.id}/monitoring/http/analytics?${rangeQs(range)}`, { signal }).then((r) => r.data),
      enabled: Boolean(orgId),
    })),
  });
  const ws = q.data?.websites ?? [];
  const measured = ws.reduce((a, w) => a + w.http.uptime.measuredChecks, 0);
  const up = ws.reduce((a, w) => a + w.http.uptime.upChecks, 0);
  const down = ws.reduce((a, w) => a + w.http.uptime.downChecks, 0);
  const data = an.map((x) => x.data).filter((x): x is HttpAnalyticsDto => Boolean(x));
  const weighted = data.filter((d) => d.responseMs.avg != null && d.checks.passed + d.checks.failed > 0);
  const n = weighted.reduce((a, d) => a + d.checks.passed + d.checks.failed, 0);
  const avg = n ? weighted.reduce((a, d) => a + d.responseMs.avg! * (d.checks.passed + d.checks.failed), 0) / n : null;
  const perf = ws.filter((w) => w.performance?.lcpP75 != null).sort((a, b) => b.performance!.lcpP75! - a.performance!.lcpP75!);
  const slow = perf[0];
  const stats: Stat[] = q.data ? [
    { label: "Availability", value: fmtPct(measured ? (up / measured) * 100 : null, 2), sub: measured ? `${down} failed of ${measured.toLocaleString("en")} checks` : "No checks in this range", tone: measured ? (up / measured >= 0.995 ? "success" : "warning") : undefined },
    { label: "Avg response", value: avg == null ? "—" : fmtMs(avg), sub: "HTTP checks from our servers" },
    ...(slow ? [{ label: "Slowest page (p75)", value: fmtSec(slow.performance!.lcpP75!), sub: `${slow.displayHost} · main content`, tone: slow.performance!.status === "POOR" ? "danger" as const : slow.performance!.status === "NEEDS_IMPROVEMENT" ? "warning" as const : undefined }] : []),
    { label: "Resolved incidents", value: q.data.totals.resolvedIncidentsInRange, sub: "in this range" },
  ] : [];
  const maxLcp = perf.length ? perf[0]!.performance!.lcpP75! : 1;

  return (
    <>
      <PageHeader title="Analytics" description="How your websites performed over time — availability and speed from our monitoring checks." actions={<RangePicker value={range} onChange={setRange} />} />
      <QueryState q={q} skeleton="h-96">
        {q.data && !ws.length ? <EmptyState icon={<BarChart3 />} title="No websites yet" description="Analytics appear once a verified website has been checked." /> : q.data && (
          <div className="grid gap-5">
            <StatStrip items={stats} />
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
              <Card className="px-5 py-4">
                <h2 className="text-[15px] font-semibold tracking-tight">Response time · average per {data[0] && data[0].bucketSec >= 86_400 ? "day" : "period"}</h2>
                <div className="mt-3 grid gap-5">
                  {sites.map((w, i) => (
                    <div key={w.id}>
                      <p className="mb-1.5 flex justify-between gap-2 text-sm"><Link href={tabHref(orgId, w.id, "performance", "availability")} className="font-medium hover:text-primary">{w.name}</Link><span className="text-xs text-muted-foreground">avg {fmtMs(an[i]?.data?.responseMs.avg)} · p95 {fmtMs(an[i]?.data?.responseMs.p95)}</span></p>
                      {an[i]?.isLoading ? <div className="h-28 animate-pulse rounded-md bg-muted" /> : an[i]?.data ? <ResponseBars a={an[i]!.data!} name={w.name} /> : <p className="text-sm text-muted-foreground">Couldn&apos;t load this website&apos;s checks.</p>}
                    </div>
                  ))}
                  {!sites.length && <p className="text-sm text-muted-foreground">No verified websites yet.</p>}
                </div>
              </Card>
              <Card className="px-5 py-4">
                <h2 className="text-[15px] font-semibold tracking-tight">Main content appears (p75)</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Synthetic browser checks, primary viewport.</p>
                {!perf.length ? <p className="mt-4 text-sm text-muted-foreground">No browser performance measurements in this range.</p> : (
                  <ul className="mt-3 grid gap-3.5">
                    {perf.map((w) => (
                      <li key={w.id}>
                        <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{w.name}</span><span className="flex items-center gap-2 tabular-nums">{fmtSec(w.performance!.lcpP75!)} <PerfBadge s={w.performance!.status} /></span></div>
                        <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className={w.performance!.status === "POOR" ? "h-full rounded-full bg-danger" : w.performance!.status === "NEEDS_IMPROVEMENT" ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-success"} style={{ width: `${(w.performance!.lcpP75! / maxLcp) * 100}%` }} /></div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card className="overflow-hidden">
              <h2 className="border-b border-border px-5 py-3.5 text-[15px] font-semibold tracking-tight">By website</h2>
              <Table>
                <THead><TR><TH>Website</TH><TH className="text-right">Uptime</TH><TH className="hidden text-right sm:table-cell">Checks</TH><TH className="text-right">Avg response</TH><TH className="hidden text-right md:table-cell">Downtime</TH></TR></THead>
                <TBody>
                  {ws.map((w) => {
                    const a = an[sites.findIndex((s) => s.id === w.id)]?.data;
                    return (
                      <TR key={w.id}>
                        <TD className="max-w-48 truncate"><Link className="font-medium hover:text-primary" href={`/o/${orgId}/websites/${w.id}`}>{w.name}</Link></TD>
                        <TD className="text-right tabular-nums">{fmtPct(w.http.uptime.uptimePercent)}</TD>
                        <TD className="hidden text-right tabular-nums sm:table-cell">{w.http.uptime.measuredChecks}</TD>
                        <TD className="text-right tabular-nums">{fmtMs(a?.responseMs.avg)}</TD>
                        <TD className="hidden text-right tabular-nums md:table-cell">{a ? (a.downtimeSec ? `${Math.round(a.downtimeSec / 60)} min` : "0") : "—"}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </Card>
            <Hint>Real-visitor analytics from the monitoring script aren&apos;t available here yet. Range: {fmtTime(q.data.range.from)} – {fmtTime(q.data.range.to)}.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
