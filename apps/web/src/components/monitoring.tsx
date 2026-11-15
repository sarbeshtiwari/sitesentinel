"use client";
import { Alert, Badge, Button, Card, cn, ErrorState, Select, Skeleton } from "@wim/ui";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, ApiError } from "@/lib/api";
import { health, localZone, presetRange, toLocalInput, type Range, type RangeKey, type Tone } from "@/lib/monitoring";

/** Monitoring state badge with an explanation for assistive tech and on hover. */
export function HealthBadge({ state, className }: { state: string | null | undefined; className?: string }) {
  const h = health(state);
  return <Badge tone={h.tone} className={className} title={h.help}><Dot tone={h.tone} />{h.label}<span className="sr-only">: {h.help}</span></Badge>;
}

export function Dot({ tone }: { tone: Tone }) {
  const c = tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : tone === "brand" ? "bg-primary" : "bg-subtle-foreground";
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${c}`} />;
}

/** Loading / error / permission states, one convention for every monitoring page. */
export function QueryState({ q, skeleton = "h-40", children }: { q: { isLoading: boolean; isError: boolean; error: unknown; refetch?: () => unknown }; skeleton?: string; children: React.ReactNode }) {
  if (q.isLoading) return <div role="status" aria-label="Loading"><Skeleton className={skeleton} /></div>;
  if (q.isError) {
    const e = q.error;
    if (e instanceof ApiError && e.status === 403) return <Alert tone="warning" title="You don't have access to this">Ask an organisation owner or admin for the required permission.</Alert>;
    if (e instanceof ApiError && e.status === 404) return <Alert tone="warning" title="Not found">It may have been removed, or it belongs to another organisation.</Alert>;
    return <ErrorState title="Couldn't load this data" description={errorMessage(e)} onRetry={q.refetch ? () => void q.refetch!() : undefined} />;
  }
  return <>{children}</>;
}

/** Time-range picker: presets plus a custom range entered in the viewer's time zone (max 90 days, validated by the API too). */
export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [custom, setCustom] = useState({ from: toLocalInput(value.from), to: toLocalInput(value.to) });
  const [err, setErr] = useState<string | null>(null);
  const [zone, setZone] = useState(""); // filled after mount: the server doesn't know the viewer's zone
  useEffect(() => setZone(localZone()), []);
  const apply = () => {
    const from = new Date(custom.from), to = new Date(custom.to); // datetime-local values are local time
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return setErr("Choose a start before the end.");
    if (to.getTime() - from.getTime() > 90 * 86_400_000) return setErr("At most 90 days.");
    setErr(null);
    onChange({ key: "custom", from: from.toISOString(), to: to.toISOString() });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Time range" className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border bg-sunken p-0.5">
        {(["24h", "7d", "30d", "custom"] as RangeKey[]).map((k) => (
          <button key={k} type="button" aria-pressed={value.key === k}
            className={`cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${value.key === k ? "bg-card text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => {
              if (k !== "custom") return onChange(presetRange(k));
              // Start the custom fields from the range currently shown, not the one the page opened with.
              setCustom({ from: toLocalInput(value.from), to: toLocalInput(value.to) });
              setErr(null);
              onChange({ ...value, key: "custom" });
            }}>
            {k === "custom" ? "Custom" : k}
          </button>
        ))}
      </div>
      {value.key === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">From <input type="datetime-local" className="h-8 rounded-md border border-input bg-card px-2 text-xs" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label className="flex items-center gap-1">To <input type="datetime-local" className="h-8 rounded-md border border-input bg-card px-2 text-xs" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          <Button size="sm" variant="outline" onClick={apply}>Apply</Button>
          {err && <span role="alert" className="text-danger">{err}</span>}
        </div>
      )}
      <span className="text-xs text-subtle-foreground">{zone}</span>
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
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={height * g} y2={height * g} stroke="var(--border)" strokeDasharray="1 1.5" vectorEffect="non-scaling-stroke" />)}
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
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={height * g} y2={height * g} stroke="var(--border)" strokeDasharray="1 1.5" vectorEffect="non-scaling-stroke" />)}
        {series.map((s) => {
          const segs: string[] = [];
          let cur = "";
          s.values.forEach((v, i) => {
            if (v == null) { if (cur) segs.push(cur); cur = ""; return; }
            cur += `${cur ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
          });
          if (cur) segs.push(cur);
          return <path key={s.name} d={segs.join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
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
          <span className="h-2 rounded-full bg-muted"><span className={`block h-2 rounded-full ${i.tone === "danger" ? "bg-danger" : i.tone === "warning" ? "bg-warning" : i.tone === "success" ? "bg-success" : "bg-primary"}`} style={{ width: `${(i.count / total) * 100}%` }} /></span>
          <span className="text-right tabular-nums text-muted-foreground">{i.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function KeyValue({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v]) => <div key={k}><dt className="text-xs font-medium text-muted-foreground">{k}</dt><dd className="mt-0.5 text-sm">{v}</dd></div>)}
    </dl>
  );
}

export function Section({ title, description, actions, children, className, flush, icon }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean; icon?: React.ReactNode }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className={cn("flex flex-col gap-2 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-5", flush ? "border-b border-border pb-3.5" : "")}>
        <div className="flex min-w-0 items-start gap-2.5">
          {icon && <span aria-hidden className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sunken text-muted-foreground ring-1 ring-border [&_svg]:h-4 [&_svg]:w-4">{icon}</span>}
          <div className="min-w-0"><h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}</div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={flush ? "" : "px-4 pb-4 pt-4 sm:px-5 sm:pb-5"}>{children}</div>
    </Card>
  );
}
