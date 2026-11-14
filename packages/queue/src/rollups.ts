import { histogramOf, PERF_METRIC_INFO, PERF_METRICS, perfRollupKey, type PerfMetric } from "@wim/core";
import type { Db, Tx } from "@wim/db";

/** System context with a longer budget than withSystem's 30 s (backfills touch many buckets). */
function system<T>(db: Db, fn: (tx: Tx) => Promise<T>, timeoutMs: number): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.system', 'on', true)`;
    return fn(tx);
  }, { timeout: timeoutMs, maxWait: 10_000 });
}

/**
 * Phase 4G performance rollups (`metrics_hourly`, `metrics_daily`).
 *
 * Correctness model: a rollup bucket is ALWAYS recomputed in full from the raw synthetic results of that bucket
 * (`performance_metrics` joined to the execution ledger), never incremented. Recomputing the same bucket twice gives the
 * same rows (upsert on the primary key), so retries, overlapping runs and backfills are idempotent and duplicates are
 * impossible. Which buckets to recompute: those touched by ledger rows recorded since the watermark (minus an overlap
 * for transactions that committed late). INCONCLUSIVE executions never contribute (they record no metrics, and the join
 * excludes them explicitly); viewports whose navigation failed record no metrics either.
 *
 * Row per (bucket, subject, metric): count, sum (→ exact mean), min, max, exact p50 / p75 / p95 for the bucket, and a
 * mergeable log-histogram so percentiles of any range can be computed from rollups (≈ ±5 %).
 * Subjects: WEBSITE (subject_id = website id) and PAGE (monitored page). Metric key: `perf.<metric>.<viewport>`.
 */
const OVERLAP_MIN = 15;
const LOCK = 7_391_004; // advisory lock key: one rollup run at a time across all scheduler instances

interface Bucket { websiteId: string; hour: Date }

export async function runPerformanceRollups(db: Db, opts: { maxBuckets?: number; now?: Date } = {}): Promise<{ ran: boolean; hours: number; days: number; rows: number }> {
  return system(db, async (tx) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${LOCK}) AS locked`;
    if (!locked) return { ran: false, hours: 0, days: 0, rows: 0 };
    const [st] = await tx.$queryRaw<Array<{ watermark: Date }>>`SELECT watermark FROM rollup_state WHERE name = 'performance' FOR UPDATE`;
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT coalesce(${opts.now ?? null}::timestamptz, now()) AS now`;
    const since = st ? new Date(st.watermark.getTime() - OVERLAP_MIN * 60_000) : new Date(0);
    const max = opts.maxBuckets ?? 500;
    // dirty (website, hour) pairs from ledger rows recorded since the watermark — bounded per run (the rest next run)
    const dirty = await tx.$queryRaw<Array<{ website_id: string; hour: Date; recorded: Date }>>`
      SELECT website_id, date_trunc('hour', window_start) AS hour, max(recorded_at) AS recorded
        FROM execution_results WHERE tier = 'T2_RENDER' AND recorded_at > ${since} AND recorded_at <= ${now}
       GROUP BY 1, 2 ORDER BY max(recorded_at) LIMIT ${max}`;
    const stats = await recompute(tx, dirty.map((d) => ({ websiteId: d.website_id, hour: d.hour })));
    // advance only to what was processed: if the run was truncated, the remaining buckets come next time
    const watermark = dirty.length === max ? dirty[dirty.length - 1]!.recorded : now;
    await tx.$executeRaw`
      INSERT INTO rollup_state (name, watermark, last_run_at, last_stats) VALUES ('performance', ${watermark}, now(), ${JSON.stringify(stats)}::jsonb)
      ON CONFLICT (name) DO UPDATE SET watermark = EXCLUDED.watermark, last_run_at = now(), last_stats = EXCLUDED.last_stats`;
    return { ran: true, ...stats };
  }, 120_000);
}

/**
 * Backfill / repair: recompute every bucket of these websites (or all) in [from, to). Safe to repeat. One short
 * transaction per website (never one long transaction holding the rollup lock over the whole platform).
 */
export async function backfillPerformanceRollups(db: Db, from: Date, to: Date, websiteIds?: string[]): Promise<{ hours: number; days: number; rows: number; websites: number }> {
  const ids = websiteIds ?? (await system(db, async (tx) => (await tx.$queryRaw<Array<{ website_id: string }>>`
    SELECT DISTINCT website_id FROM execution_results WHERE tier = 'T2_RENDER' AND window_start >= ${from} AND window_start < ${to}`).map((r) => r.website_id), 60_000));
  const total = { hours: 0, days: 0, rows: 0, websites: 0 };
  for (const w of ids) {
    const r = await system(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK})`;
      const hours = await tx.$queryRaw<Array<{ hour: Date }>>`
        SELECT DISTINCT date_trunc('hour', window_start) AS hour FROM execution_results
         WHERE tier = 'T2_RENDER' AND website_id = ${w}::uuid AND window_start >= ${from} AND window_start < ${to}`;
      // buckets that no longer have results (e.g. retention) are cleared too
      await tx.$executeRaw`DELETE FROM metrics_hourly WHERE website_id = ${w}::uuid AND metric LIKE 'perf.%' AND bucket >= ${from} AND bucket < ${to}`;
      return recompute(tx, hours.map((h) => ({ websiteId: w, hour: h.hour })));
    }, 300_000);
    total.hours += r.hours; total.days += r.days; total.rows += r.rows; total.websites++;
  }
  return total;
}

async function recompute(tx: Tx, buckets: Bucket[]): Promise<{ hours: number; days: number; rows: number }> {
  let rows = 0;
  const days = new Map<string, { websiteId: string; day: string }>();
  for (const b of buckets) {
    const end = new Date(b.hour.getTime() + 3_600_000);
    rows += await rebuild(tx, "metrics_hourly", b.websiteId, b.hour, end, b.hour);
    const day = b.hour.toISOString().slice(0, 10);
    days.set(`${b.websiteId}|${day}`, { websiteId: b.websiteId, day });
  }
  for (const d of days.values()) {
    const start = new Date(`${d.day}T00:00:00Z`);
    rows += await rebuild(tx, "metrics_daily", d.websiteId, start, new Date(start.getTime() + 86_400_000), d.day);
  }
  return { hours: buckets.length, days: days.size, rows };
}

/** Replace all perf rows of one website and bucket with a fresh computation from raw. */
async function rebuild(tx: Tx, table: "metrics_hourly" | "metrics_daily", websiteId: string, from: Date, to: Date, bucket: Date | string): Promise<number> {
  const raw = await tx.$queryRaw<Array<Record<string, any>>>`
    SELECT p.org_id, p.monitored_page_id, p.viewport, p.fcp_ms, p.lcp_ms, p.cls, p.tbt_ms, p.ttfb_ms, p.load_ms
      FROM performance_metrics p JOIN execution_results r ON r.execution_id = p.execution_id
     WHERE p.website_id = ${websiteId}::uuid AND p.source = 'SYNTHETIC' AND p.measured_at >= ${from} AND p.measured_at < ${to}
       AND r.tier = 'T2_RENDER' AND r.outcome <> 'INCONCLUSIVE'`;
  if (table === "metrics_hourly") await tx.$executeRaw`DELETE FROM metrics_hourly WHERE website_id = ${websiteId}::uuid AND bucket = ${bucket as Date} AND metric LIKE 'perf.%'`;
  else await tx.$executeRaw`DELETE FROM metrics_daily WHERE website_id = ${websiteId}::uuid AND bucket = ${bucket as string}::date AND metric LIKE 'perf.%'`;
  if (!raw.length) return 0;
  const orgId = raw[0]!.org_id as string;
  const groups = new Map<string, { subjectType: string; subjectId: string; metric: PerfMetric; viewport: string; values: number[] }>();
  for (const r of raw) {
    for (const m of PERF_METRICS) {
      const v = r[PERF_METRIC_INFO[m].column];
      if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
      const subjects: Array<[string, string]> = [["WEBSITE", websiteId]];
      if (r.monitored_page_id) subjects.push(["PAGE", r.monitored_page_id]);
      for (const [t, id] of subjects) {
        const k = `${t}|${id}|${m}|${r.viewport}`;
        const g = groups.get(k) ?? { subjectType: t, subjectId: id, metric: m, viewport: String(r.viewport), values: [] as number[] };
        g.values.push(Number(v));
        groups.set(k, g);
      }
    }
  }
  for (const g of groups.values()) {
    const s = [...g.values].sort((a, b) => a - b);
    const pct = (q: number) => s[Math.max(0, Math.ceil(q * s.length) - 1)]!;
    const sum = s.reduce((a, b) => a + b, 0);
    const key = perfRollupKey(g.metric, g.viewport);
    const hist = JSON.stringify(histogramOf(g.metric, s));
    if (table === "metrics_hourly") {
      await tx.$executeRaw`
        INSERT INTO metrics_hourly (bucket, org_id, website_id, subject_type, subject_id, metric, count, ok_count, sum, min, max, p50, p75, p95, histogram)
        VALUES (${bucket as Date}, ${orgId}::uuid, ${websiteId}::uuid, ${g.subjectType}, ${g.subjectId}::uuid, ${key}, ${s.length}, ${s.length}, ${sum}, ${s[0]}, ${s[s.length - 1]},
                ${pct(0.5)}, ${pct(0.75)}, ${pct(0.95)}, ${hist}::jsonb)
        ON CONFLICT (bucket, org_id, subject_type, subject_id, metric) DO UPDATE SET count = EXCLUDED.count, ok_count = EXCLUDED.ok_count, sum = EXCLUDED.sum,
          min = EXCLUDED.min, max = EXCLUDED.max, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p95 = EXCLUDED.p95, histogram = EXCLUDED.histogram`;
    } else {
      await tx.$executeRaw`
        INSERT INTO metrics_daily (bucket, org_id, website_id, subject_type, subject_id, metric, count, ok_count, sum, min, max, p50, p75, p95, histogram)
        VALUES (${bucket as string}::date, ${orgId}::uuid, ${websiteId}::uuid, ${g.subjectType}, ${g.subjectId}::uuid, ${key}, ${s.length}, ${s.length}, ${sum}, ${s[0]}, ${s[s.length - 1]},
                ${pct(0.5)}, ${pct(0.75)}, ${pct(0.95)}, ${hist}::jsonb)
        ON CONFLICT (bucket, org_id, subject_type, subject_id, metric) DO UPDATE SET count = EXCLUDED.count, ok_count = EXCLUDED.ok_count, sum = EXCLUDED.sum,
          min = EXCLUDED.min, max = EXCLUDED.max, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p95 = EXCLUDED.p95, histogram = EXCLUDED.histogram`;
    }
  }
  return groups.size;
}
