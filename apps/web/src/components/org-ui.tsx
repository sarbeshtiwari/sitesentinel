"use client";
/** Small building blocks shared by the organisation pages (home, websites, issues, notifications, history, usage). */
import type { HttpAnalyticsDto } from "@wim/contracts";
import { cn } from "@wim/ui";
import { ChevronDown } from "lucide-react";

/** One cell per day for the last 30 days of HTTP checks. Grey = no checks that day (never drawn as "up"). */
export function DayStrip({ a, className, label = "Availability per day, last 30 days" }: { a: HttpAnalyticsDto | undefined; className?: string; label?: string }) {
  const days = (a?.series ?? []).slice(-30);
  if (!days.length) return null;
  const failed = days.filter((x) => x.down > 0).length;
  const empty = days.filter((x) => x.up + x.down === 0).length;
  return (
    <ol role="img" aria-label={`${label}: ${failed} day${failed === 1 ? "" : "s"} with failed checks, ${empty} without data`} className={cn("flex h-6 min-w-0 gap-[2px]", className)}>
      {days.map((x) => {
        const tone = x.down > 0 ? (x.up === 0 ? "bg-danger" : "bg-warning") : x.up > 0 ? "bg-success" : x.inconclusive > 0 ? "bg-border-strong" : "bg-muted";
        return <li key={x.t} title={`${x.t.slice(0, 10)}: ${x.up} up, ${x.down} down, ${x.inconclusive} inconclusive`} className={cn("min-w-[2px] flex-1 rounded-[2px]", tone)} />;
      })}
    </ol>
  );
}

export interface Stat { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "success" | "warning" | "danger" }
const STAT_TONE = { success: "text-success-text", warning: "text-warning-text", danger: "text-danger-text" } as const;

/** A row of headline numbers in one card (design: summary strip). `[data-metric]` hooks match MetricCard. */
export function StatStrip({ items, className }: { items: Stat[]; className?: string }) {
  if (!items.length) return null;
  const cols = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[Math.min(items.length, 4) as 1 | 2 | 3 | 4];
  return (
    <div className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border", cols, className)}>
      {items.map((s, i) => (
        <div key={s.label} data-metric={s.label} className={cn("min-w-0 bg-card px-4 py-3.5 sm:px-5 sm:py-4", items.length % 2 === 1 && i === items.length - 1 && "col-span-2 sm:col-span-1")}>
          <p className="truncate text-[13px] text-muted-foreground">{s.label}</p>
          <p data-metric-value className={cn("mt-1 text-[24px] font-medium leading-tight tracking-[-0.02em] tabular-nums sm:text-[26px]", s.tone && STAT_TONE[s.tone])}>{s.value}</p>
          {s.sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/** Filter that looks like a chip but is a native select (keyboard and screen-reader friendly). */
export function ChipSelect({ label, value, onChange, options, className }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>; className?: string }) {
  const on = Boolean(value);
  return (
    <span className={cn("relative inline-flex", className)}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
        className={cn("h-7 max-w-[14rem] cursor-pointer appearance-none truncate rounded-full border pl-3 pr-7 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          on ? "border-ink bg-ink text-ink-foreground" : "border-border bg-card text-foreground hover:border-border-strong")}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <ChevronDown aria-hidden className={cn("pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2", on ? "text-ink-foreground/70" : "text-muted-foreground")} />
    </span>
  );
}

/** Wrapping row of chips; a divider can separate groups. */
export function ChipRow({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  return <div role={label ? "group" : undefined} aria-label={label} className={cn("mb-4 flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}
export const ChipDivider = () => <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:inline-block" />;

/** Usage meter: used / cap with a warning colour from 80 % and danger at 100 %. */
export function Meter({ used, cap, label }: { used: number; cap: number; label: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-success")} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "Today", "Yesterday" or the date, for a local YYYY-MM-DD day. */
export function dayLabel(day: string, now = new Date()) {
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === key(now)) return "Today";
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (day === key(y)) return "Yesterday";
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** Short relative time: "10 min ago", "9 h ago", "Yesterday", "12 Nov". */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
