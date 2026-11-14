"use client";
import { Alert, Card, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
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
    <div className="mt-2" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={`${used} of ${cap}`}>
      <div className="h-1.5 rounded bg-muted"><div className={`h-1.5 rounded ${pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${pct}%` }} /></div>
    </div>
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
          <div className="grid gap-6">
            {d.warnings.map((w) => <Alert key={w.key} tone={w.percent >= 100 ? "danger" : "warning"} title={w.percent >= 100 ? "Limit reached" : "Approaching a limit"}>{w.message}</Alert>)}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="px-4 py-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Websites</p><p className="mt-1 text-2xl font-semibold tabular-nums">{d.websites.total} / {d.limits.maxWebsites}</p><Meter used={d.websites.total} cap={d.limits.maxWebsites} /></Card>
              <StatCard label="HTTP monitored" value={d.websites.httpMonitored} hint={d.limits.http.enabled ? `every ${Math.round(d.limits.http.minIntervalSec / 60) || 1} min or slower` : "Not available"} />
              <Card className="px-4 py-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Browser monitored</p><p className="mt-1 text-2xl font-semibold tabular-nums">{d.limits.browser.enabled ? `${d.websites.browserMonitored} / ${d.limits.browser.maxWebsites}` : "—"}</p>{d.limits.browser.enabled ? <Meter used={d.websites.browserMonitored} cap={d.limits.browser.maxWebsites} /> : <p className="text-xs text-muted-foreground">Not in your plan</p>}</Card>
              <Card className="px-4 py-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deep-scanned</p><p className="mt-1 text-2xl font-semibold tabular-nums">{d.limits.deepScan.enabled ? `${d.websites.deepScanned} / ${d.limits.deepScan.maxWebsites}` : "—"}</p>{d.limits.deepScan.enabled ? <Meter used={d.websites.deepScanned} cap={d.limits.deepScan.maxWebsites} /> : <p className="text-xs text-muted-foreground">Not in your plan</p>}</Card>
            </div>
            {d.limits.deepScan.enabled && (
              <Section title="Deep-scan quota (today)">
                <p className="text-sm tabular-nums">{(d.usage["deepscan.pages"]?.today ?? 0).toLocaleString("en")} of {d.limits.deepScan.pagesPerDay.toLocaleString("en")} pages · up to {d.limits.deepScan.maxPages} pages per scan · {d.limits.deepScan.maxConcurrentScans} concurrent scan(s)</p>
                <Meter used={d.usage["deepscan.pages"]?.today ?? 0} cap={d.limits.deepScan.pagesPerDay} />
              </Section>
            )}
            {d.limits.browser.enabled && (
              <Section title="Screenshot storage">
                <p className="text-sm">{fmtBytes(d.storage.screenshotBytes)} in {d.storage.screenshots} stored screenshots · today {fmtBytes(d.usage["browser.screenshot_bytes"]?.today ?? 0)} of {fmtBytes(d.limits.browser.screenshotBytesPerDay)} · kept {d.limits.browser.artifactRetentionDays} days</p>
                <Meter used={d.usage["browser.screenshot_bytes"]?.today ?? 0} cap={d.limits.browser.screenshotBytesPerDay} />
              </Section>
            )}
            <Section title="Usage" description={`Today (${d.period.today}) and the last 30 days (from ${d.period.last30DaysFrom}).`}>
              {!Object.keys(d.usage).length ? <p className="text-sm text-muted-foreground">No monitoring usage recorded yet.</p> : (
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
            <Section title="Retention">
              <ul className="grid gap-1 text-sm">
                <li>HTTP check results: {d.limits.resultRetentionDays.http} days</li>
                <li>Browser results: {d.limits.resultRetentionDays.browser} days · screenshots {d.limits.browser.artifactRetentionDays} days</li>
                <li>Deep scans: {d.limits.deepScan.retentionDays} days (open findings are kept until resolved)</li>
              </ul>
            </Section>
            <Hint>Usage counters are written only by the monitoring workers and can't be changed. Plans and billing arrive in a later release; limits shown are your organisation's current entitlements.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
