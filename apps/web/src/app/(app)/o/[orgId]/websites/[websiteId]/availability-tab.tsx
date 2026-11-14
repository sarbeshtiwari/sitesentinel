"use client";
import { Alert, Badge, Button, Card, Dialog, MetricCard, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { Activity, AlertTriangle, BarChart3, CheckCircle2, History, ListChecks, Lock, Network, Radar, Siren, Timer, TrendingDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { HttpCheckResultDto } from "@wim/contracts";
import { Distribution, FilterSelect, HealthBadge, Hint, KeyValue, LineChart, LoadMore, QueryState, RangePicker, Section, StackedBars } from "@/components/monitoring";
import { fmtDuration, fmtMs, fmtPct, fmtUtc, outcome, presetRange, SEVERITY_TONE, useAnalytics, useHttpResults, useHttpSummary } from "@/lib/monitoring";

const CATEGORY_LABEL: Record<string, string> = {
  TARGET_PERMANENT: "Website error", TARGET_TEMPORARY: "Website unreachable / timeout", INVALID_CONFIGURATION: "Configuration",
  GATEWAY_INFRASTRUCTURE: "Our infrastructure (not your website)", SECURITY_REJECTION: "Refused by security policy",
};

export function AvailabilityTab({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const [range, setRange] = useState(() => presetRange("24h"));
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<HttpCheckResultDto | null>(null);
  const sum = useHttpSummary(orgId, websiteId);
  const a = useAnalytics(orgId, websiteId, range);
  const res = useHttpResults(orgId, websiteId, { outcome: filter || undefined, from: range.from });
  const d = a.data;
  const bucketLabel = (t: string) => (d && d.bucketSec >= 86_400 ? t.slice(0, 10) : `${t.slice(0, 13).replace("T", " ")}:00`);

  return (
    <div className="grid gap-5">
      <Card className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Current state:</span> <HealthBadge state={sum.data?.state} />
          {sum.data?.ssl?.daysRemaining != null && <Badge tone={sum.data.ssl.daysRemaining < 14 ? "warning" : "neutral"}><Lock className="h-3 w-3" aria-hidden />Certificate: {sum.data.ssl.daysRemaining} days left</Badge>}
        </div>
        <RangePicker value={range} onChange={setRange} />
      </Card>
      <QueryState q={a} skeleton="h-64">
        {d && (
          <div className="grid gap-5">
            {d.checks.total === 0 ? (
              <Hint>No HTTP checks in this range. {sum.data?.state === "NOT_MONITORED" || sum.data?.state === "PAUSED" ? "HTTP monitoring is not active for this website." : "Results appear after the first scheduled check."}</Hint>
            ) : d.uptime.coveragePercent != null && d.uptime.coveragePercent < 80 && (
              <Alert tone="warning" title={`Coverage is ${fmtPct(d.uptime.coveragePercent, 1)}`}>Only part of the scheduled checks produced a result, so the uptime figure rests on limited data.</Alert>
            )}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard label="Uptime" value={fmtPct(d.uptime.uptimePercent, 3)} icon={<Activity />} tone="success" hint={`${d.uptime.upChecks} up · ${d.uptime.downChecks} down (measured)`} />
              <MetricCard label="Coverage" value={fmtPct(d.uptime.coveragePercent, 1)} icon={<Radar />} tone="info" hint={`${d.uptime.measuredChecks} of ${d.checks.scheduled} scheduled checks measured`} />
              <MetricCard label="Downtime" value={fmtDuration(d.downtimeSec)} icon={<TrendingDown />} tone={d.downtimeSec ? "danger" : "neutral"} hint="Time covered by availability incidents" />
              <MetricCard label="Response time" value={fmtMs(d.responseMs.avg)} icon={<Timer />} tone="brand" hint={`p95 ${fmtMs(d.responseMs.p95)} · slowest ${fmtMs(d.responseMs.max)}`} />
            </div>
            <Card className="grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-5">
              {([["Total", d.checks.total, ""], ["Passed", d.checks.passed, "bg-success"], ["Failed", d.checks.failed, "bg-danger"], ["Inconclusive", d.checks.inconclusive, "bg-subtle-foreground"], ["Missing / skipped", d.checks.skippedOrMissing, "bg-border-strong"]] as const).map(([k, v, dot]) => (
                <div key={k} className="bg-card px-4 py-3 first:col-span-2 sm:first:col-span-1">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{dot && <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />}{k}</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums">{v}</p>
                </div>
              ))}
            </Card>
            <Section title="Availability over time" icon={<BarChart3 />} description={`Checks per ${d.bucketSec >= 86_400 ? "day" : d.bucketSec >= 21_600 ? "6 hours" : "hour"}; green up, red down, grey inconclusive; hatched = no data (a gap, not uptime).`}>
              <StackedBars ariaLabel="Up, down and inconclusive checks over time" bars={d.series.map((s) => ({
                t: s.t, label: `${bucketLabel(s.t)} UTC: ${s.up} up, ${s.down} down, ${s.inconclusive} inconclusive of ${s.scheduled} scheduled`,
                values: [{ v: s.up, tone: "success" }, { v: s.down, tone: "danger" }, { v: s.inconclusive, tone: "neutral" }],
              }))} />
              <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{fmtUtc(d.range.from)}</span><span>{fmtUtc(d.range.to)}</span></div>
            </Section>
            <div className="grid gap-5 lg:grid-cols-2">
              <Section title="Response time" icon={<Timer />} description="Successful checks only, through our egress gateway (synthetic).">
                <LineChart ariaLabel="Average and p95 response time over time" points={d.series.map((s) => ({ t: s.t, label: bucketLabel(s.t) }))}
                  series={[{ name: "Average", values: d.series.map((s) => s.avgMs), color: "var(--primary)" }, { name: "p95", values: d.series.map((s) => s.p95Ms), color: "var(--warning)" }]} />
              </Section>
              <Section title="Connection timings (average)" icon={<Network />} description="DNS, TCP connect, TLS handshake and time to first byte where measured.">
                <KeyValue items={[["DNS", fmtMs(d.timings.dnsMs)], ["TCP connect", fmtMs(d.timings.connectMs)], ["TLS", fmtMs(d.timings.tlsMs)], ["TTFB", fmtMs(d.timings.ttfbMs)], ["Total", fmtMs(d.timings.totalMs)]]} />
              </Section>
              <Section title="HTTP status distribution" icon={<ListChecks />}>
                <Distribution ariaLabel="HTTP status classes" items={d.statusDistribution.map((x) => ({ label: x.status, count: x.count, tone: x.status === "2xx" ? "success" : x.status === "5xx" || x.status === "No response" ? "danger" : "warning" }))} />
              </Section>
              <Section title="Failure categories" icon={<AlertTriangle />}>
                <Distribution ariaLabel="Failure categories" items={d.failureCategories.map((x) => ({ label: CATEGORY_LABEL[x.category] ?? x.category, count: x.count, tone: x.category === "GATEWAY_INFRASTRUCTURE" ? undefined : "danger" }))} />
              </Section>
            </div>
            <Section title="Availability incidents in this range" icon={<Siren />} flush>
              {d.incidents.length ? (
                <ul className="divide-y divide-border">
                  {d.incidents.map((i) => (
                    <li key={i.id}>
                      <Link className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-sunken/70 sm:px-5" href={`/o/${orgId}/incidents/${i.id}`}>
                        <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                        <span className="min-w-0 flex-1 text-sm font-medium">INC-{i.number} {i.title}</span>
                        <span className="text-xs text-muted-foreground">{fmtUtc(i.from)} – {i.to ? fmtUtc(i.to) : "ongoing"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-5"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />No availability incidents in this range.</p>}
            </Section>
          </div>
        )}
      </QueryState>
      <Section title="Check history" icon={<History />} flush description="Newest first, within the selected range. Times in UTC." actions={
        <FilterSelect label="Result" value={filter} onChange={setFilter} options={[["", "All"], ["PASSED", "Passed"], ["FAILED", "Failed"], ["INCONCLUSIVE", "Inconclusive"]]} />
      }>
        <QueryState q={res} skeleton="h-40 m-4">
          {!res.data?.pages[0]?.data.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No checks match.</p> : (
            <>
              <Table>
                <THead><TR><TH>Time (UTC)</TH><TH>Result</TH><TH>Status</TH><TH>Duration</TH><TH className="hidden md:table-cell">TTFB</TH><TH className="hidden md:table-cell">TLS</TH><TH className="hidden lg:table-cell">Failure</TH><TH><span className="sr-only">Details</span></TH></TR></THead>
                <TBody>
                  {res.data.pages.flatMap((p) => p.data).map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-xs">{fmtUtc(r.windowStart)}</TD>
                      <TD><Badge tone={outcome(r.outcome).tone}>{outcome(r.outcome).label}</Badge></TD>
                      <TD className="tabular-nums">{r.httpStatus ?? "—"}</TD>
                      <TD className="tabular-nums">{fmtMs(r.timings.totalMs)}</TD>
                      <TD className="hidden tabular-nums md:table-cell">{fmtMs(r.timings.ttfbMs)}</TD>
                      <TD className="hidden md:table-cell">{r.tls ? (r.tls.valid ? "Valid" : "Invalid") : "—"}</TD>
                      <TD className="hidden max-w-64 truncate text-xs text-muted-foreground lg:table-cell">{r.failureDescription ?? "—"}{r.failureCategory === "GATEWAY_INFRASTRUCTURE" ? " (our infrastructure)" : ""}</TD>
                      <TD><Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <LoadMore q={res} />
            </>
          )}
        </QueryState>
      </Section>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)} title={`Check at ${fmtUtc(open.windowStart)}`}>
          <div className="grid gap-4 text-sm">
            <KeyValue items={[
              ["Result", outcome(open.outcome).label], ["HTTP status", open.httpStatus ?? "—"], ["Method", open.method ?? "—"],
              ["Final URL", <span key="u" className="break-all">{open.finalUrl ?? open.url}</span>], ["Redirects", open.redirects.length],
              ["Failure", open.failureDescription ?? "—"], ["Category", open.failureCategory ? CATEGORY_LABEL[open.failureCategory] ?? open.failureCategory : "—"],
              ["DNS", fmtMs(open.timings.dnsMs)], ["Connect", fmtMs(open.timings.connectMs)], ["TLS", fmtMs(open.timings.tlsMs)], ["TTFB", fmtMs(open.timings.ttfbMs)], ["Total", fmtMs(open.timings.totalMs)],
              ["Certificate", open.tls ? `${open.tls.valid ? "Valid" : "Invalid"}${open.tls.daysRemaining != null ? ` · ${open.tls.daysRemaining} days left` : ""}${open.tls.issuer ? ` · ${open.tls.issuer}` : ""}` : "—"],
              ["Content type", open.contentType ?? "—"], ["Attempt", open.attempt ?? "—"],
            ]} />
            {Object.keys(open.headers).length > 0 && (
              <div><p className="mb-1 text-xs font-medium text-muted-foreground">Response headers (safe subset)</p>
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-sunken p-2.5 font-mono text-xs">{Object.entries(open.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}</pre></div>
            )}
            <Hint>Request credentials, cookies and resolved addresses are never stored or shown.</Hint>
          </div>
        </Dialog>
      )}
    </div>
  );
}
