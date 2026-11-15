"use client";
import { Alert, Badge, Button, Card, Checkbox, cn, Input, Table, TBody, TD, TH, THead, toast } from "@wim/ui";
import { FileText, Gauge, LineChart as LineChartIcon, SlidersHorizontal } from "lucide-react";
import { TR } from "@wim/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DataEnvelope } from "@wim/contracts";
import { FilterSelect, Hint, LineChart, QueryState, RangePicker, Section } from "@/components/monitoring";
import { api, errorMessage, get } from "@/lib/api";
import { fmtMs, fmtTime, mk, presetRange, rangeQs, type Range, type Tone } from "@/lib/monitoring";

type PerfStatus = "GOOD" | "NEEDS_IMPROVEMENT" | "POOR" | "INSUFFICIENT_DATA";
const STATUS: Record<PerfStatus, { label: string; tone: Tone }> = {
  GOOD: { label: "Good", tone: "success" }, NEEDS_IMPROVEMENT: { label: "Needs improvement", tone: "warning" }, POOR: { label: "Poor", tone: "danger" }, INSUFFICIENT_DATA: { label: "Insufficient data", tone: "neutral" },
};
const LABEL: Record<string, string> = { fcp: "FCP", lcp: "LCP", cls: "CLS", tbt: "TBT", ttfb: "TTFB", load: "Load" };
const NAME: Record<string, string> = { fcp: "First Contentful Paint", lcp: "Largest Contentful Paint", cls: "Cumulative Layout Shift", tbt: "Total Blocking Time", ttfb: "Time to First Byte", load: "Page load" };
const fmtV = (m: string, v: number | null | undefined) => (v == null ? "—" : m === "cls" ? v.toFixed(3) : fmtMs(v));
export const PerfBadge = ({ s }: { s: PerfStatus }) => <Badge tone={STATUS[s]?.tone ?? "neutral"}>{STATUS[s]?.label ?? s}</Badge>;

interface Metric { metric: string; status: PerfStatus; alerting: boolean; thresholds: { good: number; poor: number }; samples: number; avg: number | null; p50: number | null; p75: number | null; p95: number | null; sufficient: boolean; latest: number | null; previous: { samples: number; p75: number | null }; change: { change: string; deltaPct: number | null } }
interface Summary { status: PerfStatus; viewport: string; viewports: string[]; range: { from: string; to: string; grain: string }; metrics: Metric[]; quality: { scheduledChecks: number; recordedChecks: number; inconclusiveChecks: number; failedChecks: number }; latestAt: string | null; settings: { customAllowed: boolean }; notes: string[] }

/** Shown at the top of every performance view: these are lab numbers, not field (real-user) data. */
export function SyntheticNote() {
  return (
    <Alert tone="info" title="Synthetic lab measurements — not real-user data">
      Measured by our Chromium runners loading your page from our network on a schedule. Real visitors&apos; devices, networks and caches differ, and field metrics such as INP are not measured here.
    </Alert>
  );
}

export function PerformanceTab({ orgId, websiteId, canWrite }: { orgId: string; websiteId: string; canWrite: boolean }) {
  const [range, setRange] = useState<Range>(() => presetRange("7d"));
  const [viewport, setViewport] = useState("");
  const [metric, setMetric] = useState("lcp");
  const base = `/orgs/${orgId}/websites/${websiteId}/performance`;
  const vq = viewport ? `&viewport=${viewport}` : "";
  const sum = useQuery({ queryKey: [...mk.site(orgId, websiteId), "perf", range, viewport], queryFn: ({ signal }) => get<DataEnvelope<Summary>>(`${base}?${rangeQs(range)}${vq}`, { signal }).then((r) => r.data), placeholderData: (p) => p });
  const series = useQuery({ queryKey: [...mk.site(orgId, websiteId), "perf-series", range, viewport, metric], queryFn: ({ signal }) => get<DataEnvelope<{ grain: string; thresholds: { good: number; poor: number }; points: Array<{ t: string; samples: number; p50: number | null; p75: number | null; p95: number | null }> }>>(`${base}/series?metric=${metric}&${rangeQs(range)}${vq}`, { signal }).then((r) => r.data), placeholderData: (p) => p });
  const pages = useQuery({ queryKey: [...mk.site(orgId, websiteId), "perf-pages", range, viewport], queryFn: ({ signal }) => get<DataEnvelope<{ pages: Array<{ pageId: string; path: string; metrics: Record<string, { samples: number; p75: number | null; status: PerfStatus }> }> }>>(`${base}/pages?${rangeQs(range)}${vq}`, { signal }).then((r) => r.data) });
  const s = sum.data;
  const pts = series.data?.points ?? [];
  return (
    <div className="grid gap-5">
      <SyntheticNote />
      <Card className="flex flex-col gap-3 px-4 py-3 sm:px-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm"><Gauge className="h-4 w-4 text-muted-foreground" aria-hidden /><span className="text-muted-foreground">Performance:</span> {s ? <PerfBadge s={s.status} /> : null}<Badge tone="info">synthetic · {s?.viewport}</Badge></div>
        <div className="flex flex-wrap items-end gap-2">
          <FilterSelect label="Viewport" value={viewport} onChange={setViewport} options={[["", "Primary viewport"], ...(s?.viewports ?? []).map((v) => [v, v] as [string, string])]} />
          <RangePicker value={range} onChange={setRange} />
        </div>
      </Card>
      <QueryState q={sum} skeleton="h-48">
        {s && (
          <div className="grid gap-3">
            {s.quality.recordedChecks === 0 && <Hint>No browser checks in this range — nothing to show. Performance comes from browser monitoring of the configured page.</Hint>}
            {s.quality.inconclusiveChecks > 0 && <Hint>{s.quality.inconclusiveChecks} of {s.quality.recordedChecks} checks were inconclusive (our infrastructure) and contribute no measurements.</Hint>}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {s.metrics.map((m) => (
                <button key={m.metric} type="button" onClick={() => setMetric(m.metric)} aria-pressed={metric === m.metric}
                  className={cn("flex min-w-0 cursor-pointer flex-col rounded-lg border bg-card p-3.5 text-left shadow-xs transition-[border-color,box-shadow] duration-150",
                    metric === m.metric ? "border-primary ring-1 ring-primary" : "border-border hover:border-border-strong hover:shadow-sm")}>
                  <div className="flex items-start justify-between gap-1.5">
                    <span className="text-[13px] font-medium text-muted-foreground" title={NAME[m.metric]}>{LABEL[m.metric]}{m.alerting ? <span title="Can open a performance incident"> ·</span> : ""}</span>
                    <PerfBadge s={m.status} />
                  </div>
                  <p className="mt-1.5 text-[22px] font-semibold leading-tight tracking-tight tabular-nums">{fmtV(m.metric, m.p75)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">p75 · {m.samples} sample{m.samples === 1 ? "" : "s"}{!m.sufficient && m.samples > 0 ? " (too few)" : ""}</p>
                  <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">good ≤ {fmtV(m.metric, m.thresholds.good)} · poor &gt; {fmtV(m.metric, m.thresholds.poor)}</p>
                  {m.change.change === "REGRESSION" && <p className="mt-1 text-xs font-medium text-danger">Regression {m.change.deltaPct !== null ? `+${m.change.deltaPct}%` : ""} vs previous period</p>}
                  {m.change.change === "IMPROVEMENT" && <p className="mt-1 text-xs font-medium text-success">Improved {m.change.deltaPct}% vs previous period</p>}
                  {m.change.change === "INSUFFICIENT_DATA" && <p className="mt-1 text-xs text-muted-foreground">Too little data to compare</p>}
                </button>
              ))}
            </div>
            <Hint>· = can open a performance incident. Data quality: {s.quality.recordedChecks} checks recorded of {s.quality.scheduledChecks} scheduled, {s.quality.failedChecks} failed. Latest measurement {fmtTime(s.latestAt)}. {s.notes.join(" ")}</Hint>
          </div>
        )}
      </QueryState>
      <Section title={`${NAME[metric]} over time`} icon={<LineChartIcon />} description={`Synthetic p50 / p75 / p95 per ${series.data?.grain === "day" ? "day" : "hour"}; empty buckets are gaps (no measurement), never interpolated.`}>
        <QueryState q={series}>
          <LineChart ariaLabel={`${NAME[metric]} percentiles over time`} unit={metric === "cls" ? "" : "ms"} points={pts.map((p) => ({ t: p.t, label: p.t }))}
            series={[{ name: "p50", values: pts.map((p) => p.p50), color: "var(--success)" }, { name: "p75", values: pts.map((p) => p.p75), color: "var(--primary)" }, { name: "p95", values: pts.map((p) => p.p95), color: "var(--warning)" }]} />
          <p className="mt-1 text-xs text-muted-foreground">{pts.filter((p) => p.samples > 0).length} of {pts.length} buckets have measurements · {pts.reduce((a, p) => a + p.samples, 0)} samples</p>
        </QueryState>
      </Section>
      <Section title="Pages" icon={<FileText />} flush description="Synthetic performance per monitored page (p75 over the range; samples in brackets). Only pages checked by browser monitoring appear here.">
        <QueryState q={pages} skeleton="h-32 m-4">
          {!pages.data?.pages.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No monitored pages yet.</p> : (
            <Table>
              <THead><TR><TH>Page</TH>{["lcp", "fcp", "cls", "ttfb"].map((m) => <TH key={m} className="text-right">{LABEL[m]} p75</TH>)}</TR></THead>
              <TBody>{pages.data.pages.map((p) => (
                <TR key={p.pageId}><TD className="max-w-72 break-all font-mono text-xs">{p.path}</TD>{["lcp", "fcp", "cls", "ttfb"].map((m) => (
                  <TD key={m} className="whitespace-nowrap text-right text-xs tabular-nums">{fmtV(m, p.metrics[m]?.p75 ?? null)} <span className="text-muted-foreground">({p.metrics[m]?.samples ?? 0})</span></TD>
                ))}</TR>
              ))}</TBody>
            </Table>
          )}
        </QueryState>
      </Section>
      <ThresholdSettings orgId={orgId} websiteId={websiteId} canWrite={canWrite} />
    </div>
  );
}

function ThresholdSettings({ orgId, websiteId, canWrite }: { orgId: string; websiteId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const url = `/orgs/${orgId}/websites/${websiteId}/performance/thresholds`;
  const q = useQuery({ queryKey: [...mk.site(orgId, websiteId), "perf-thresholds"], queryFn: ({ signal }) => get<DataEnvelope<{ effective: Record<string, { good: number; poor: number }>; platform: Record<string, { good: number; poor: number }>; customAllowed: boolean; alertOn: string[]; consecutiveFailures: number; recoveryPasses: number; history: Array<{ at: string; by: string | null }> }>>(url, { signal }).then((r) => r.data) });
  // initialised from the server once, and again only after a save: background refetches (live updates every 15 s)
  // must never overwrite what the user is typing
  const dirty = useRef(false);
  const [form, setFormRaw] = useState<Record<string, { good: string; poor: string }>>({});
  const [alertOn, setAlertOnRaw] = useState<string[]>([]);
  const [noise, setNoiseRaw] = useState({ f: "", r: "" });
  const setForm = (v: typeof form) => { dirty.current = true; setFormRaw(v); };
  const setAlertOn = (v: string[]) => { dirty.current = true; setAlertOnRaw(v); };
  const setNoise = (v: typeof noise) => { dirty.current = true; setNoiseRaw(v); };
  useEffect(() => {
    if (!q.data || dirty.current) return;
    setFormRaw(Object.fromEntries(Object.entries(q.data.effective).map(([k, v]) => [k, { good: String(v.good), poor: String(v.poor) }])));
    setAlertOnRaw(q.data.alertOn); setNoiseRaw({ f: String(q.data.consecutiveFailures), r: String(q.data.recoveryPasses) });
  }, [q.data]);
  const save = async () => {
    try {
      const body: Record<string, unknown> = { consecutiveFailures: Number(noise.f), recoveryPasses: Number(noise.r) };
      if (q.data?.customAllowed) { body.thresholds = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, { good: Number(v.good), poor: Number(v.poor) }])); body.alertOn = alertOn; }
      await api("PUT", url, body);
      toast.success("Performance thresholds saved");
      dirty.current = false; // the saved values come back from the server
      await qc.invalidateQueries({ queryKey: mk.site(orgId, websiteId) });
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const d = q.data;
  const ro = !canWrite;
  return (
    <Section title="Thresholds" icon={<SlidersHorizontal />} description={d?.customAllowed ? "Your plan allows custom thresholds. Values are validated by the server." : "Platform defaults apply: custom thresholds are not included in your plan. You can still require more consecutive checks before alerting."}>
      <QueryState q={q}>
        {d && (
          <div className="grid gap-5">
            <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <THead><TR><TH>Metric</TH><TH>Good up to</TH><TH>Poor above</TH><TH>Alert</TH></TR></THead>
              <TBody>{Object.keys(d.effective).map((m) => (
                <TR key={m}>
                  <TD className="text-sm">{NAME[m]}<div className="text-xs text-muted-foreground">{LABEL[m]}</div></TD>
                  {(["good", "poor"] as const).map((k) => (
                    <TD key={k}><Input aria-label={`${LABEL[m]} ${k}`} className="h-8 w-24" type="number" step={m === "cls" ? "0.01" : "1"} disabled={ro || !d.customAllowed} value={form[m]?.[k] ?? ""} onChange={(e) => setForm({ ...form, [m]: { ...form[m]!, [k]: e.target.value } })} /></TD>
                  ))}
                  <TD><Checkbox aria-label={`Alert on ${LABEL[m]}`} disabled={ro || !d.customAllowed} checked={alertOn.includes(m)} onChange={(e) => setAlertOn(e.currentTarget.checked ? [...alertOn, m] : alertOn.filter((x) => x !== m))} /></TD>
                </TR>
              ))}</TBody>
            </Table>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">Poor checks in a row before an incident<Input className="h-9 sm:max-w-40" type="number" min={1} max={20} disabled={ro} value={noise.f} onChange={(e) => setNoise({ ...noise, f: e.target.value })} /></label>
              <label className="grid gap-1.5 text-sm font-medium">Good checks before recovery<Input className="h-9 sm:max-w-40" type="number" min={1} max={20} disabled={ro} value={noise.r} onChange={(e) => setNoise({ ...noise, r: e.target.value })} /></label>
            </div>
            {!ro && <div className="flex justify-end border-t border-border pt-4"><Button onClick={save}>Save thresholds</Button></div>}
            {d.history.length > 0 && <p className="text-xs text-muted-foreground">Last changed {fmtTime(d.history[0]!.at)}{d.history[0]!.by ? ` by ${d.history[0]!.by}` : ""} · {d.history.length} change(s) in the audit log.</p>}
            <Hint>Synthetic lab measurements (one Chromium in our infrastructure); real-user metrics such as INP are not measured here. Inconclusive checks never count towards an incident.</Hint>
          </div>
        )}
      </QueryState>
    </Section>
  );
}
