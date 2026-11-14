"use client";
import { Badge, buttonVariants, Card, EmptyState, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { PerfBadge } from "../websites/[websiteId]/performance-tab";
import { Globe, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { HealthBadge, Hint, QueryState, RangePicker, Section } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import { fmtPct, fmtUtc, presetRange, SCAN_STATUS, useOverview, useUsage } from "@/lib/monitoring";

export default function OverviewPage() {
  const { data: org, orgId, can } = useOrg();
  const [range, setRange] = useState(() => presetRange("24h"));
  const q = useOverview(orgId, range);
  const usage = useUsage(orgId);
  const d = q.data;
  const base = `/o/${orgId}`;

  return (
    <>
      <PageHeader title={org?.name ?? "Overview"} description={org ? <>Monitoring overview · your role: {org.myRole.name}</> : undefined} actions={<RangePicker value={range} onChange={setRange} />} />
      <QueryState q={q} skeleton="h-72">
        {d && !d.websites.length ? (
          <EmptyState icon={<Globe />} title="No websites yet"
            description="Add a website and verify that you own it. HTTP availability monitoring starts automatically once it is verified."
            action={can("website:write") ? <Link href={`${base}/websites/new`} className={buttonVariants()}><Plus className="h-4 w-4" /> Add website</Link> : undefined} />
        ) : d && (
          <div className="grid gap-6">
            {d.totals.monitored === 0 && (
              <Hint>None of your websites is being monitored yet. Verify ownership of a website to start HTTP availability checks; browser monitoring and deep scans depend on your plan.</Hint>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard label="Websites" value={d.totals.websites} hint={`${d.totals.monitored} monitored`} />
              <StatCard label="Active incidents" value={d.totals.activeIncidents} hint={<Link className="hover:underline" href={`${base}/incidents`}>View incidents</Link>} />
              <StatCard label="Resolved in range" value={d.totals.resolvedIncidentsInRange} />
              <StatCard label="HTTP check success" value={fmtPct(d.totals.httpChecks.successRatePercent, 1)}
                hint={`${d.totals.httpChecks.passed} passed · ${d.totals.httpChecks.failed} failed · ${d.totals.httpChecks.inconclusive} inconclusive`} />
              <StatCard label="Plan usage" value={usage.data ? `${usage.data.websites.total} / ${usage.data.limits.maxWebsites}` : "—"} hint={<Link className="hover:underline" href={`${base}/usage`}>Websites · usage & limits</Link>} />
            </div>
            <Card className="overflow-hidden">
              <Table>
                <THead><TR>
                  <TH>Website</TH><TH>Status</TH><TH>Uptime</TH><TH className="hidden md:table-cell">Coverage</TH>
                  <TH className="hidden lg:table-cell">Browser</TH><TH className="hidden lg:table-cell">Performance</TH><TH className="hidden lg:table-cell">Deep scan</TH><TH>Incidents</TH><TH className="hidden xl:table-cell">Last check</TH>
                </TR></THead>
                <TBody>
                  {d.websites.map((w) => (
                    <TR key={w.id}>
                      <TD>
                        <Link href={`${base}/websites/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                        <div className="text-xs text-muted-foreground">{w.displayHost}</div>
                        {w.reasons.length > 0 && <ul className="mt-1 text-xs text-muted-foreground">{w.reasons.slice(0, 2).map((r) => <li key={r}>{r}</li>)}</ul>}
                      </TD>
                      <TD><HealthBadge state={w.health} /></TD>
                      <TD className="tabular-nums">{fmtPct(w.http.uptime.uptimePercent)}<div className="text-xs text-muted-foreground">{w.http.uptime.measuredChecks} checks</div></TD>
                      <TD className="hidden tabular-nums md:table-cell">{fmtPct(w.http.uptime.coveragePercent, 1)}</TD>
                      <TD className="hidden lg:table-cell"><HealthBadge state={w.browser.state} /></TD>
                      <TD className="hidden lg:table-cell">{w.performance ? <Link href={`${base}/websites/${w.id}?tab=performance`}><PerfBadge s={w.performance.status} /></Link> : <span className="text-xs text-muted-foreground">—</span>}{w.performance?.regressions.length ? <div className="text-xs text-danger">{w.performance.regressions.length} regression(s)</div> : null}</TD>
                      <TD className="hidden lg:table-cell">
                        {w.deepScan.lastStatus ? <span className="text-xs">{SCAN_STATUS[w.deepScan.lastStatus]?.label ?? w.deepScan.lastStatus}{w.deepScan.openFindings ? ` · ${w.deepScan.openFindings} findings` : ""}</span> : <HealthBadge state={w.deepScan.state} />}
                      </TD>
                      <TD className="tabular-nums">{w.activeIncidents ? <Link className="font-medium text-danger hover:underline" href={`${base}/incidents?websiteId=${w.id}`}>{w.activeIncidents} open</Link> : <span className="text-muted-foreground">0</span>}</TD>
                      <TD className="hidden text-xs text-muted-foreground xl:table-cell">{fmtUtc(w.http.lastCheckAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
            <Section title="Recent changes and regressions" description="Component changes on monitored pages and synthetic performance regressions against the previous period of the same length.">
              {!d.recentChanges.length ? <p className="text-sm text-muted-foreground">Nothing changed in this range.</p> : (
                <ul className="grid gap-1 text-sm">{d.recentChanges.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{fmtUtc(c.at)}</span><Badge tone={c.kind === "PERFORMANCE_REGRESSION" ? "danger" : "warning"}>{c.kind === "PERFORMANCE_REGRESSION" ? "Regression" : "Component"}</Badge>
                    <Link className="hover:underline" href={`${base}${c.link}`}>{c.websiteName}: {c.title}</Link></li>
                ))}</ul>
              )}
            </Section>
            <Section title="What's included in your plan" description="Monitoring types are enabled by the platform and your plan; you can only lower limits.">
              <ul className="grid gap-2 text-sm sm:grid-cols-3">
                {([["HTTP availability", d.entitlements.HTTP], ["Browser monitoring", d.entitlements.BROWSER], ["Deep scans", d.entitlements.DEEPSCAN]] as const).map(([name, e]) => (
                  <li key={name} className="rounded-md border border-border p-3">
                    <p className="font-medium">{name}</p>
                    <p className="text-xs text-muted-foreground">{e.available ? `Available · checks every ${Math.round(e.minIntervalSec / 60) || 1} min or slower` : e.reason}</p>
                  </li>
                ))}
              </ul>
            </Section>
            <Hint>Statuses distinguish outages (your website), inconclusive checks (our monitoring infrastructure), disabled monitoring and insufficient coverage. Uptime is computed from measured checks only; coverage shows how many scheduled checks produced a result. Range: {fmtUtc(d.range.from)} – {fmtUtc(d.range.to)}.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
