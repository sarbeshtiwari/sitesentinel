"use client";
import { Alert, buttonVariants, Card, cn, PageHeader, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { CreditCard } from "lucide-react";
import Link from "next/link";
import { Hint, QueryState } from "@/components/monitoring";
import { Meter } from "@/components/org-ui";
import { useOrg } from "@/lib/hooks";
import { fmtBytes, fmtDuration, useUsage } from "@/lib/monitoring";

const KEY_LABEL: Record<string, string> = {
  "http.checks": "HTTP checks", "http.executions": "HTTP checks", "http.retries": "HTTP retries",
  "browser.executions": "Browser executions", "browser.ms": "Browser time", "browser.viewports": "Browser viewports", "browser.screenshots": "Screenshots",
  "browser.screenshot_bytes": "Screenshot bytes", "browser.inconclusive": "Inconclusive browser checks", "browser.retry_ms": "Browser retry overhead", "browser.infra_failures": "Browser infrastructure failures",
  "deepscan.scans": "Deep scans", "deepscan.partial_scans": "Partial deep scans", "deepscan.pages": "Pages scanned", "deepscan.requests": "Deep-scan requests",
  "deepscan.bytes": "Deep-scan bytes", "deepscan.resources": "Resources checked", "deepscan.duration_ms": "Deep-scan time", "deepscan.browser_ms": "Deep-scan browser time",
  "deepscan.external_links_seen": "External links seen", "deepscan.failed_attempts": "Failed scan attempts (not billed)", "deepscan.overhead_requests": "Overhead requests (not billed)",
};
const fmtValue = (k: string, v: number) => (k.endsWith("bytes") ? fmtBytes(v) : k.endsWith("_ms") || k === "browser.ms" ? fmtDuration(Math.round(v / 1000)) : v.toLocaleString("en"));

/** One plan limit: label, "used of cap" and a meter that turns amber from 80 % and red at 100 %. */
function LimitCard({ label, used, cap, fmt = (n: number) => n.toLocaleString("en"), enabled = true, note, warn }: {
  label: string; used: number; cap: number; fmt?: (n: number) => string; enabled?: boolean; note?: React.ReactNode; warn?: string;
}) {
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  const tone = pct >= 100 ? "text-danger-text" : pct >= 80 ? "text-warning-text" : "text-muted-foreground";
  return (
    <Card data-metric={label} className="grid gap-2.5 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium">{label}</p>
        {enabled ? <p data-metric-value className={cn("text-[13px] tabular-nums", pct >= 80 && "font-medium", tone)}>{fmt(used)} of {fmt(cap)}</p> : <p className="text-[13px] text-muted-foreground">Not in your plan</p>}
      </div>
      {enabled && <Meter used={used} cap={cap} label={`${label}: ${fmt(used)} of ${fmt(cap)}`} />}
      {enabled && pct >= 80 && <p className={cn("text-xs", tone)}>{pct}% used{warn ? ` — ${warn}` : ""}</p>}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Card>
  );
}

export default function UsagePage() {
  const { orgId, can } = useOrg();
  const q = useUsage(orgId);
  const d = q.data;
  return (
    <>
      <PageHeader title="Usage and plan limits" description="What your plan includes and how much you've used. Usage is counted by the monitoring workers; days are UTC."
        actions={can("billing:read") ? <Link href={`/o/${orgId}/settings/billing`} className={buttonVariants({ variant: "brand", size: "sm" })}><CreditCard /> Plan and billing</Link> : undefined} />
      <QueryState q={q} skeleton="h-96">
        {d && (
          <div className="grid gap-5">
            {d.warnings.map((w) => <Alert key={w.key} tone={w.percent >= 100 ? "danger" : "warning"} title={w.percent >= 100 ? "Limit reached" : "Approaching a limit"}>{w.message}</Alert>)}
            <div className="grid items-start gap-3 md:grid-cols-2">
              <LimitCard label="Websites" used={d.websites.total} cap={d.limits.maxWebsites} warn="new websites can't be added at the limit"
                note={<>HTTP monitored: {d.websites.httpMonitored}{d.limits.http.enabled ? ` · every ${Math.round(d.limits.http.minIntervalSec / 60) || 1} min or slower` : " · not available"}</>} />
              <LimitCard label="Browser monitored" enabled={d.limits.browser.enabled} used={d.websites.browserMonitored} cap={d.limits.browser.maxWebsites} />
              <LimitCard label="Deep-scanned" enabled={d.limits.deepScan.enabled} used={d.websites.deepScanned} cap={d.limits.deepScan.maxWebsites} />
              {d.limits.deepScan.enabled && (
                <LimitCard label="Deep-scan pages today" used={d.usage["deepscan.pages"]?.today ?? 0} cap={d.limits.deepScan.pagesPerDay} warn="scans stop at the daily limit"
                  note={`Up to ${d.limits.deepScan.maxPages} pages per scan · ${d.limits.deepScan.maxConcurrentScans} concurrent scan(s)`} />
              )}
              {d.limits.browser.enabled && (
                <LimitCard label="Screenshot storage today" used={d.usage["browser.screenshot_bytes"]?.today ?? 0} cap={d.limits.browser.screenshotBytesPerDay} fmt={fmtBytes}
                  note={`${fmtBytes(d.storage.screenshotBytes)} in ${d.storage.screenshots} stored screenshots · kept ${d.limits.browser.artifactRetentionDays} days`} />
              )}
              <Card className="grid gap-2 px-5 py-4">
                <p className="text-sm font-medium">Data kept</p>
                <ul className="grid gap-1 text-[13px] text-muted-foreground">
                  <li>HTTP check results: {d.limits.resultRetentionDays.http} days</li>
                  <li>Browser results: {d.limits.resultRetentionDays.browser} days · screenshots {d.limits.browser.artifactRetentionDays} days</li>
                  <li>Deep scans: {d.limits.deepScan.retentionDays} days (open findings are kept until resolved)</li>
                </ul>
              </Card>
            </div>
            <section aria-labelledby="usage-table" className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-5 py-3.5">
                <h2 id="usage-table" className="text-[15px] font-semibold tracking-tight">Usage</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Today ({d.period.today}) and the last 30 days (from {d.period.last30DaysFrom}).</p>
              </div>
              {!Object.keys(d.usage).length ? <p className="px-5 py-6 text-sm text-muted-foreground">No monitoring usage recorded yet.</p> : (
                <Table>
                  <THead><TR><TH>Measure</TH><TH className="text-right">Today</TH><TH className="text-right">Last 30 days</TH></TR></THead>
                  <TBody>
                    {Object.entries(d.usage).map(([k, v]) => (
                      <TR key={k}><TD>{KEY_LABEL[k] ?? k}</TD><TD className="text-right tabular-nums">{fmtValue(k, v.today)}</TD><TD className="text-right tabular-nums">{fmtValue(k, v.last30Days)}</TD></TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
            <Hint>Usage counters are written only by the monitoring workers and can't be changed. Limits shown are your organisation's current entitlements.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
