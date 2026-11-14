"use client";
import { Alert, Card, cn, MetricCard, PageHeader, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { Archive, BarChart3, Globe, Image as ImageIcon, MonitorSmartphone, ScanSearch } from "lucide-react";
import { Hint, QueryState, Section } from "@/components/monitoring";
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

function Meter({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="mt-3" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={`${used} of ${cap}`}>
      <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
      <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">{pct}% used</p>
    </div>
  );
}

/** Plan-limit tile: used / limit with a meter, or a plain note when the feature isn't in the plan. */
function LimitCard({ label, icon, used, cap, enabled = true }: { label: string; icon: React.ReactNode; used: number; cap: number; enabled?: boolean }) {
  return (
    <Card className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <span aria-hidden className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md [&_svg]:h-4 [&_svg]:w-4", enabled ? "bg-primary-soft text-primary" : "bg-muted text-subtle-foreground")}>{icon}</span>
      </div>
      {enabled ? <>
        <p className="mt-1 text-[26px] font-semibold leading-none tracking-tight tabular-nums">{used}<span className="text-base font-medium text-muted-foreground"> / {cap}</span></p>
        <Meter used={used} cap={cap} />
      </> : <>
        <p className="mt-1 text-[26px] font-semibold leading-none tracking-tight text-subtle-foreground">—</p>
        <p className="mt-3 text-xs text-muted-foreground">Not in your plan</p>
      </>}
    </Card>
  );
}

export default function UsagePage() {
  const { orgId } = useOrg();
  const q = useUsage(orgId);
  const d = q.data;
  return (
    <>
      <PageHeader title="Usage and plan limits" description="Usage counted by the monitoring workers and limits from your plan. Days are UTC." />
      <QueryState q={q} skeleton="h-96">
        {d && (
          <div className="grid gap-5">
            {d.warnings.map((w) => <Alert key={w.key} tone={w.percent >= 100 ? "danger" : "warning"} title={w.percent >= 100 ? "Limit reached" : "Approaching a limit"}>{w.message}</Alert>)}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <LimitCard label="Websites" icon={<Globe />} used={d.websites.total} cap={d.limits.maxWebsites} />
              <MetricCard label="HTTP monitored" value={d.websites.httpMonitored} icon={<BarChart3 />} tone="brand" hint={d.limits.http.enabled ? `every ${Math.round(d.limits.http.minIntervalSec / 60) || 1} min or slower` : "Not available"} />
              <LimitCard label="Browser monitored" icon={<MonitorSmartphone />} enabled={d.limits.browser.enabled} used={d.websites.browserMonitored} cap={d.limits.browser.maxWebsites} />
              <LimitCard label="Deep-scanned" icon={<ScanSearch />} enabled={d.limits.deepScan.enabled} used={d.websites.deepScanned} cap={d.limits.deepScan.maxWebsites} />
            </div>
            {(d.limits.deepScan.enabled || d.limits.browser.enabled) && (
              <div className="grid gap-5 lg:grid-cols-2">
                {d.limits.deepScan.enabled && (
                  <Section title="Deep-scan quota (today)" icon={<ScanSearch />}>
                    <p className="text-sm tabular-nums"><span className="text-lg font-semibold">{(d.usage["deepscan.pages"]?.today ?? 0).toLocaleString("en")}</span><span className="text-muted-foreground"> of {d.limits.deepScan.pagesPerDay.toLocaleString("en")} pages</span></p>
                    <Meter used={d.usage["deepscan.pages"]?.today ?? 0} cap={d.limits.deepScan.pagesPerDay} />
                    <p className="mt-3 text-xs text-muted-foreground">Up to {d.limits.deepScan.maxPages} pages per scan · {d.limits.deepScan.maxConcurrentScans} concurrent scan(s)</p>
                  </Section>
                )}
                {d.limits.browser.enabled && (
                  <Section title="Screenshot storage" icon={<ImageIcon />}>
                    <p className="text-sm tabular-nums"><span className="text-lg font-semibold">{fmtBytes(d.usage["browser.screenshot_bytes"]?.today ?? 0)}</span><span className="text-muted-foreground"> of {fmtBytes(d.limits.browser.screenshotBytesPerDay)} today</span></p>
                    <Meter used={d.usage["browser.screenshot_bytes"]?.today ?? 0} cap={d.limits.browser.screenshotBytesPerDay} />
                    <p className="mt-3 text-xs text-muted-foreground">{fmtBytes(d.storage.screenshotBytes)} in {d.storage.screenshots} stored screenshots · kept {d.limits.browser.artifactRetentionDays} days</p>
                  </Section>
                )}
              </div>
            )}
            <Section title="Usage" icon={<BarChart3 />} flush description={`Today (${d.period.today}) and the last 30 days (from ${d.period.last30DaysFrom}).`}>
              {!Object.keys(d.usage).length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No monitoring usage recorded yet.</p> : (
                <Table>
                  <THead><TR><TH>Measure</TH><TH className="text-right">Today</TH><TH className="text-right">Last 30 days</TH></TR></THead>
                  <TBody>
                    {Object.entries(d.usage).map(([k, v]) => (
                      <TR key={k}><TD>{KEY_LABEL[k] ?? k}</TD><TD className="text-right tabular-nums">{fmtValue(k, v.today)}</TD><TD className="text-right tabular-nums">{fmtValue(k, v.last30Days)}</TD></TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Section>
            <Section title="Retention" icon={<Archive />}>
              <ul className="grid gap-2 text-sm sm:grid-cols-3">
                <li className="rounded-lg border border-border px-3 py-2.5">HTTP check results: {d.limits.resultRetentionDays.http} days</li>
                <li className="rounded-lg border border-border px-3 py-2.5">Browser results: {d.limits.resultRetentionDays.browser} days · screenshots {d.limits.browser.artifactRetentionDays} days</li>
                <li className="rounded-lg border border-border px-3 py-2.5">Deep scans: {d.limits.deepScan.retentionDays} days (open findings are kept until resolved)</li>
              </ul>
            </Section>
            <Hint>Usage counters are written only by the monitoring workers and can't be changed. Plans and billing arrive in a later release; limits shown are your organisation's current entitlements.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
