import { z } from "zod";

/**
 * Phase 4G: synthetic performance intelligence. Metrics come only from the browser check (one Chromium in our
 * infrastructure, through the egress gateway) — never real-user data; INP is not produced here.
 */
export const PERF_METRICS = ["fcp", "lcp", "cls", "tbt", "ttfb", "load"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];
/** column in performance_metrics, unit, label */
export const PERF_METRIC_INFO: Record<PerfMetric, { column: string; unit: "ms" | "score"; label: string }> = {
  fcp: { column: "fcp_ms", unit: "ms", label: "First Contentful Paint" },
  lcp: { column: "lcp_ms", unit: "ms", label: "Largest Contentful Paint" },
  cls: { column: "cls", unit: "score", label: "Cumulative Layout Shift" },
  tbt: { column: "tbt_ms", unit: "ms", label: "Total Blocking Time" },
  ttfb: { column: "ttfb_ms", unit: "ms", label: "Time to First Byte" },
  load: { column: "load_ms", unit: "ms", label: "Page load" },
};

const Bound = z.object({ good: z.number().min(0), poor: z.number().min(0) }).strict()
  .refine((b) => b.good < b.poor, { message: "`good` must be below `poor`" });
/** Upper bounds that keep thresholds meaningful (a 10-minute LCP "threshold" is a typo). */
export const PERF_THRESHOLD_MAX: Record<PerfMetric, number> = { fcp: 60_000, lcp: 60_000, cls: 5, tbt: 60_000, ttfb: 60_000, load: 120_000 };

export const PerfThresholdMap = z.object({
  fcp: Bound.optional(), lcp: Bound.optional(), cls: Bound.optional(), tbt: Bound.optional(), ttfb: Bound.optional(), load: Bound.optional(),
}).strict().superRefine((m, ctx) => {
  for (const k of PERF_METRICS) {
    const b = m[k];
    if (b && b.poor > PERF_THRESHOLD_MAX[k]) ctx.addIssue({ code: "custom", path: [k, "poor"], message: `at most ${PERF_THRESHOLD_MAX[k]}` });
  }
});
export type PerfThresholdMap = z.infer<typeof PerfThresholdMap>;
export type PerfThresholdSet = Record<PerfMetric, { good: number; poor: number }>;

/** Platform defaults (lab conditions). LCP / CLS / FCP / TBT / TTFB follow the commonly used good / poor bounds. */
export const DEFAULT_PERF_THRESHOLDS: PerfThresholdSet = {
  fcp: { good: 1800, poor: 3000 }, lcp: { good: 2500, poor: 4000 }, cls: { good: 0.1, poor: 0.25 },
  tbt: { good: 200, poor: 600 }, ttfb: { good: 800, poor: 1800 }, load: { good: 4000, poor: 8000 },
};

/** Per-website performance settings (inside `browser_check.performance`). Legacy 4D keys stay accepted. */
export const PerformanceConfig = z.object({
  lcpWarnMs: z.number().int().min(100).max(60_000).optional(),
  lcpCritMs: z.number().int().min(100).max(60_000).optional(),
  clsWarn: z.number().min(0).max(5).optional(),
  clsCrit: z.number().min(0).max(5).optional(),
  /** Phase 4G: per-metric good / poor bounds (customer override; needs the entitlement) */
  thresholds: PerfThresholdMap.optional(),
  /** metrics whose POOR result fails the check and may open the performance incident */
  alertOn: z.array(z.enum(PERF_METRICS)).max(6).optional(),
  /** consecutive failing checks before a performance incident opens, passing checks before it recovers */
  consecutiveFailures: z.number().int().min(1).max(20).optional(),
  recoveryPasses: z.number().int().min(1).max(20).optional(),
}).strict();
export type PerformanceConfig = z.infer<typeof PerformanceConfig>;

export const DEFAULT_ALERT_ON: PerfMetric[] = ["lcp", "cls"];

/**
 * Effective thresholds: platform defaults, the legacy 4D LCP / CLS keys, then the website's own per-metric bounds — the
 * customer's values only when `customAllowed` (plan entitlement). Never lets warn ≥ crit through.
 */
export function effectivePerfThresholds(platform: PerfThresholdSet, cfg: PerformanceConfig | undefined, customAllowed: boolean): PerfThresholdSet {
  const out: PerfThresholdSet = structuredClone(platform);
  if (!customAllowed || !cfg) return out;
  if (cfg.lcpWarnMs !== undefined || cfg.lcpCritMs !== undefined) {
    const good = cfg.lcpWarnMs ?? out.lcp.good, poor = cfg.lcpCritMs ?? out.lcp.poor;
    if (good < poor) out.lcp = { good, poor };
  }
  if (cfg.clsWarn !== undefined || cfg.clsCrit !== undefined) {
    const good = cfg.clsWarn ?? out.cls.good, poor = cfg.clsCrit ?? out.cls.poor;
    if (good < poor) out.cls = { good, poor };
  }
  for (const k of PERF_METRICS) { const b = cfg.thresholds?.[k]; if (b) out[k] = b; }
  return out;
}

export type PerfStatus = "GOOD" | "NEEDS_IMPROVEMENT" | "POOR" | "INSUFFICIENT_DATA";
export function classifyPerf(value: number | null | undefined, b: { good: number; poor: number }): PerfStatus {
  if (value === null || value === undefined || !Number.isFinite(value)) return "INSUFFICIENT_DATA";
  return value <= b.good ? "GOOD" : value <= b.poor ? "NEEDS_IMPROVEMENT" : "POOR";
}
const RANK: Record<PerfStatus, number> = { INSUFFICIENT_DATA: -1, GOOD: 0, NEEDS_IMPROVEMENT: 1, POOR: 2 };
/** Worst status among metrics that have data; INSUFFICIENT_DATA only when none has. */
export function worstPerfStatus(list: PerfStatus[]): PerfStatus {
  return list.reduce<PerfStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "INSUFFICIENT_DATA");
}

/** Minimum samples for a percentile or a comparison to be reported as meaningful. */
export const MIN_SAMPLES = 3;

/**
 * Compare a current window with a baseline (both p75 with sample counts). A REGRESSION needs enough samples on both
 * sides and either a worse status or a relative worsening ≥ `relative` with an absolute change above the noise floor.
 */
export function compareWindows(
  metric: PerfMetric, current: { p75: number | null; n: number }, baseline: { p75: number | null; n: number }, b: { good: number; poor: number }, relative = 0.2,
): { change: "REGRESSION" | "IMPROVEMENT" | "STABLE" | "INSUFFICIENT_DATA"; deltaPct: number | null } {
  if (current.n < MIN_SAMPLES || baseline.n < MIN_SAMPLES || current.p75 === null || baseline.p75 === null) return { change: "INSUFFICIENT_DATA", deltaPct: null };
  const floor = metric === "cls" ? 0.02 : 50;
  const delta = current.p75 - baseline.p75;
  const deltaPct = baseline.p75 > 0 ? Math.round((delta / baseline.p75) * 1000) / 10 : null;
  const sc = RANK[classifyPerf(current.p75, b)], sb = RANK[classifyPerf(baseline.p75, b)];
  if (sc > sb || (Math.abs(delta) >= floor && delta > 0 && baseline.p75 > 0 && delta / baseline.p75 >= relative)) return { change: "REGRESSION", deltaPct };
  if (sc < sb || (Math.abs(delta) >= floor && delta < 0 && baseline.p75 > 0 && -delta / baseline.p75 >= relative)) return { change: "IMPROVEMENT", deltaPct };
  return { change: "STABLE", deltaPct };
}

/** Rollup metric key in metrics_hourly / metrics_daily: `perf.<metric>.<viewport>`. */
export const perfRollupKey = (metric: PerfMetric, viewport: string) => `perf.${metric}.${viewport}`;

// ---------------------------------------------------------------- mergeable histograms (rollups)
/**
 * Log-spaced buckets (factor 1.1, ≈ ±5 % resolution) so rollup rows can be merged across hours / days / pages and
 * percentiles of any range computed without re-reading raw history. Millisecond metrics use the value; CLS is scaled
 * ×10 000 first. Bucket 0 holds exact zeros.
 */
const FACTOR = 1.1;
const scaleOf = (m: PerfMetric) => (m === "cls" ? 10_000 : 1);
export function histBucket(metric: PerfMetric, value: number): number {
  const v = value * scaleOf(metric);
  if (!(v > 0)) return 0;
  return Math.max(1, Math.floor(Math.log(Math.max(1, v)) / Math.log(FACTOR)) + 1);
}
/** Representative value of a bucket (geometric middle), in the metric's unit. */
export function histValue(metric: PerfMetric, bucket: number): number {
  if (bucket <= 0) return 0;
  const lo = FACTOR ** (bucket - 1), hi = FACTOR ** bucket;
  return Math.sqrt(lo * hi) / scaleOf(metric);
}
export type Histogram = Record<string, number>;
export function histogramOf(metric: PerfMetric, values: number[]): Histogram {
  const h: Histogram = {};
  for (const v of values) { const b = String(histBucket(metric, v)); h[b] = (h[b] ?? 0) + 1; }
  return h;
}
export function mergeHistograms(list: Array<Histogram | null | undefined>): Histogram {
  const out: Histogram = {};
  for (const h of list) if (h) for (const [k, n] of Object.entries(h)) out[k] = (out[k] ?? 0) + Number(n);
  return out;
}
/** Approximate percentile (q in 0..1) from a histogram; null when empty. Clamped to the exact min / max when given. */
export function histPercentile(metric: PerfMetric, h: Histogram, q: number, bounds?: { min: number | null; max: number | null }): number | null {
  const entries = Object.entries(h).map(([k, n]) => [Number(k), Number(n)] as const).filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const [b, n] of entries) {
    seen += n;
    if (seen >= rank) {
      let v = histValue(metric, b);
      if (bounds?.min != null) v = Math.max(v, bounds.min);
      if (bounds?.max != null) v = Math.min(v, bounds.max);
      return metric === "cls" ? Math.round(v * 10_000) / 10_000 : Math.round(v);
    }
  }
  return null;
}
