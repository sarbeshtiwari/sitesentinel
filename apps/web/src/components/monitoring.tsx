"use client";
import { Alert, Badge, Button, Card, Select, Skeleton } from "@wim/ui";
import { Info } from "lucide-react";
import { useState } from "react";
import { errorMessage, ApiError } from "@/lib/api";
import { health, presetRange, type Range, type RangeKey, type Tone } from "@/lib/monitoring";

/** Monitoring state badge with an explanation for assistive tech and on hover. */
export function HealthBadge({ state, className }: { state: string | null | undefined; className?: string }) {
  const h = health(state);
  return <Badge tone={h.tone} className={className} title={h.help}><Dot tone={h.tone} />{h.label}<span className="sr-only">: {h.help}</span></Badge>;
}

export function Dot({ tone }: { tone: Tone }) {
  const c = tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : tone === "brand" ? "bg-primary" : "bg-muted-foreground/50";
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${c}`} />;
}

/** Loading / error / permission states, one convention for every monitoring page. */
export function QueryState({ q, skeleton = "h-40", children }: { q: { isLoading: boolean; isError: boolean; error: unknown }; skeleton?: string; children: React.ReactNode }) {
  if (q.isLoading) return <Skeleton className={skeleton} />;
  if (q.isError) {
    const e = q.error;
    if (e instanceof ApiError && e.status === 403) return <Alert tone="warning" title="You don't have access to this">Ask an organisation owner or admin for the required permission.</Alert>;
    if (e instanceof ApiError && e.status === 404) return <Alert tone="warning" title="Not found">It may have been removed, or it belongs to another organisation.</Alert>;
    return <Alert tone="danger" title="Couldn't load this data">{errorMessage(e)}</Alert>;
  }
  return <>{children}</>;
}

/** Time-range picker: presets plus a custom UTC range (max 90 days, validated by the API too). */
export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [custom, setCustom] = useState({ from: value.from.slice(0, 16), to: value.to.slice(0, 16) });
  const [err, setErr] = useState<string | null>(null);
  const apply = () => {
    const from = new Date(`${custom.from}:00Z`), to = new Date(`${custom.to}:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return setErr("Choose a start before the end.");
    if (to.getTime() - from.getTime() > 90 * 86_400_000) return setErr("At most 90 days.");
    setErr(null);
    onChange({ key: "custom", from: from.toISOString(), to: to.toISOString() });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Time range" className="inline-flex rounded-md border border-border p-0.5">
        {(["24h", "7d", "30d", "custom"] as RangeKey[]).map((k) => (
          <button key={k} type="button" aria-pressed={value.key === k}
            className={`rounded px-2.5 py-1 text-xs font-medium ${value.key === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => (k === "custom" ? onChange({ ...value, key: "custom" }) : onChange(presetRange(k)))}>
            {k === "custom" ? "Custom" : `Last ${k.replace("h", " hours").replace("d", " days")}`}
          </button>
        ))}
      </div>
      {value.key === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">From <input type="datetime-local" className="rounded border border-border bg-background px-1.5 py-1" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label className="flex items-center gap-1">To <input type="datetime-local" className="rounded border border-border bg-background px-1.5 py-1" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          <Button size="sm" variant="outline" onClick={apply}>Apply</Button>
          {err && <span role="alert" className="text-danger">{err}</span>}
        </div>
      )}
      <span className="text-xs text-muted-foreground">Times in UTC</span>
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 min-w-36 text-sm">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </label>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</p>;
}

export function LoadMore({ q }: { q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!q.hasNextPage) return null;
  return <div className="flex justify-center p-3"><Button variant="outline" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>;
}

// ------------------------------------------------------------------ charts (dependency-free SVG; data aggregated by the API)
interface Bar { t: string; values: Array<{ v: number; tone: "success" | "danger" | "neutral" | "muted" }>; label: string }

/** Stacked bars per time bucket. Buckets without any data are drawn as gaps (hatched), never as "up". */
export function StackedBars({ bars, height = 120, ariaLabel }: { bars: Bar[]; height?: number; ariaLabel: string }) {
  const max = Math.max(1, ...bars.map((b) => b.values.reduce((a, x) => a + x.v, 0)));
  const w = 100 / Math.max(1, bars.length);
  const fill = { success: "var(--success)", danger: "var(--danger)", neutral: "var(--muted-foreground)", muted: "var(--border)" };
  return (
    <figure>
      <svg role="img" aria-label={ariaLabel} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-32 w-full">
        <defs><pattern id="gap" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1" height="2" fill="var(--border)" /></pattern></defs>
        {bars.map((b, i) => {
          const total = b.values.reduce((a, x) => a + x.v, 0);
          if (!total) return <rect key={b.t} x={i * w + w * 0.1} y={height - 6} width={w * 0.8} height={6} fill="url(#gap)"><title>{b.label}: no data</title></rect>;
          let y = height;
          return (
            <g key={b.t}>
              <title>{b.label}</title>
              {b.values.filter((x) => x.v > 0).map((x, j) => {
                const h = (x.v / max) * (height - 4);
                y -= h;
                return <rect key={j} x={i * w + w * 0.1} y={y} width={w * 0.8} height={h} fill={fill[x.tone]} />;
              })}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Line(s) over buckets; null points break the line (gaps stay visible). */
export function LineChart({ points, series, height = 120, ariaLabel, unit = "ms" }: { points: Array<{ t: string; label: string }>; series: Array<{ name: string; values: Array<number | null>; color: string }>; height?: number; ariaLabel: string; unit?: string }) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (!all.length) return <p className="py-8 text-center text-sm text-muted-foreground">No measurements in this range.</p>;
  const max = Math.max(...all) * 1.1 || 1;
  const x = (i: number) => (points.length <= 1 ? 50 : (i / (points.length - 1)) * 100);
  const y = (v: number) => height - (v / max) * (height - 6) - 3;
  return (
    <figure>
      <svg role="img" aria-label={ariaLabel} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="h-32 w-full">
        {series.map((s) => {
          const segs: string[] = [];
          let cur = "";
          s.values.forEach((v, i) => {
            if (v == null) { if (cur) segs.push(cur); cur = ""; return; }
            cur += `${cur ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
          });
          if (cur) segs.push(cur);
          return <path key={s.name} d={segs.join(" ")} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {series.map((s) => <span key={s.name} className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-0.5 w-3" style={{ background: s.color }} />{s.name}</span>)}
        <span>max {Math.round(Math.max(...all))} {unit}</span>
      </figcaption>
    </figure>
  );
}

/** Horizontal distribution bars with counts (status codes, categories). */
export function Distribution({ items, ariaLabel }: { items: Array<{ label: string; count: number; tone?: Tone }>; ariaLabel: string }) {
  const total = items.reduce((a, b) => a + b.count, 0);
  if (!total) return <p className="text-sm text-muted-foreground">No data in this range.</p>;
  return (
    <ul aria-label={ariaLabel} className="grid gap-2">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-sm">
          <span className="truncate">{i.label}</span>
          <span className="h-2 rounded bg-muted"><span className={`block h-2 rounded ${i.tone === "danger" ? "bg-danger" : i.tone === "warning" ? "bg-warning" : i.tone === "success" ? "bg-success" : "bg-primary"}`} style={{ width: `${(i.count / total) * 100}%` }} /></span>
          <span className="text-right tabular-nums text-muted-foreground">{i.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v]) => <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="mt-0.5 text-sm">{v}</dd></div>)}
    </dl>
  );
}

export function Section({ title, description, actions, children }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}</div>
        {actions}
      </div>
      {children}
    </Card>
  );
}
