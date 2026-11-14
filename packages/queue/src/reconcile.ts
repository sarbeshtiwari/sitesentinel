import { withSystem, type Db } from "@wim/db";
import { sanitizeError } from "./util.js";

/**
 * Phase 4H: usage reconciliation (OPERATIONS_RUNBOOK.md §Usage reconciliation). For one UTC day, compares what the
 * usage counters say with what the durable records prove, per organisation:
 *
 *   http.checks              ~ execution ledger rows (T1_HTTP) recorded that day
 *   http.inconclusive        ~ … of them with outcome INCONCLUSIVE
 *   browser.executions       ~ ledger rows (T2_RENDER)
 *   browser.inconclusive     ~ … INCONCLUSIVE
 *   browser.screenshots      ~ screenshot artifacts created that day
 *   browser.screenshot_bytes ~ their bytes
 *   deepscan.scans           ~ deep scans that finished that day
 *   deepscan.pages           ~ pages fetched that day (PAGE rows DONE/FAILED by checked_at; SKIPPED is not usage)
 *   exec.<http|browser|deepscan>.ok ~ executions that SUCCEEDED (finished that day)
 *   exec.<tier>.cancelled    ~ executions CANCELLED while running (finished that day)
 *   results-integrity        ~ ledger rows without their persisted result row (check_results / page_test_results)
 *
 * A difference becomes a `usage_discrepancies` row. Nothing is repaired automatically: an operator adjusts (counter
 * change + reason + audit, `ops.apply_usage_adjustment`) or accepts it with a reason. Manual adjustments made for the day
 * are included in the comparison so a corrected day reconciles cleanly afterwards.
 *
 * Boundary: counters are written in the same transaction as the ledger row, so a day's counts match unless something
 * went wrong — except for results recorded within seconds of midnight (the counter uses its own now()); the reconciler
 * therefore only runs for days that ended at least an hour ago.
 */
export const RECON_CHECKS = [
  "http.checks~ledger", "http.inconclusive~ledger", "browser.executions~ledger", "browser.inconclusive~ledger",
  "browser.screenshots~artifacts", "browser.screenshot_bytes~artifacts", "deepscan.scans~scans",
  "exec.http.ok~executions", "exec.browser.ok~executions", "exec.deepscan.ok~executions",
  "exec.http.cancelled~executions", "exec.browser.cancelled~executions", "exec.deepscan.cancelled~executions",
  "deepscan.pages~urls",
  "results~ledger",
] as const;

export async function reconcileUsageDay(db: Db, day: string, o: { runId?: string; requestedById?: string | null } = {}): Promise<{ runId: string; orgs: number; discrepancies: number; ms: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid day");
  const t0 = Date.now();
  const runId = o.runId ?? (await withSystem(db, (tx) => tx.usageReconciliationRun.create({ data: { day: new Date(`${day}T00:00:00Z`), status: "REQUESTED", requestedById: o.requestedById ?? null } }))).id;
  await withSystem(db, (tx) => tx.usageReconciliationRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } }));
  try {
    const res = await withSystem(db, async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '120s'`;
      // one statement: expected vs recorded per org and check (all aggregates use the day's index ranges)
      const rows = await tx.$queryRaw<Array<{ org_id: string; check: string; key: string | null; recorded: bigint; expected: bigint }>>`
        WITH d AS (SELECT ${day}::date AS day, ${day}::date::timestamptz AS lo, (${day}::date + 1)::timestamptz AS hi),
        usage AS (
          -- counters already include manual adjustments (applied to the counter with their record)
          SELECT u.org_id, u.key, u.value FROM usage_counters u, d WHERE u.period_start = d.day
        ),
        ledger AS (
          SELECT r.org_id, r.tier::text AS tier, count(*) AS n, count(*) FILTER (WHERE r.outcome = 'INCONCLUSIVE') AS inc
            FROM execution_results r, d WHERE r.recorded_at >= d.lo AND r.recorded_at < d.hi AND r.tier IN ('T1_HTTP', 'T2_RENDER') GROUP BY 1, 2
        ),
        shots AS (
          SELECT a.org_id, count(*) AS n, sum(a.bytes) AS bytes FROM artifacts a, d
           WHERE a.created_at >= d.lo AND a.created_at < d.hi AND a.kind = 'SCREENSHOT' GROUP BY 1
        ),
        scans AS (
          SELECT s.org_id, count(*) AS n FROM deep_scans s, d
           WHERE s.finished_at >= d.lo AND s.finished_at < d.hi AND s.status IN ('COMPLETED', 'PARTIAL') GROUP BY 1  -- finalizeScan accounts exactly these
        ),
        pages AS (
          SELECT u.org_id, count(*) AS n FROM deep_scan_urls u, d
           WHERE u.checked_at >= d.lo AND u.checked_at < d.hi AND u.kind = 'PAGE' AND u.state IN ('DONE', 'FAILED') GROUP BY 1
        ),
        execs AS (
          SELECT e.org_id, CASE e.tier WHEN 'T1_HTTP' THEN 'http' WHEN 'T2_RENDER' THEN 'browser' ELSE 'deepscan' END AS tier,
                 count(*) FILTER (WHERE e.status = 'SUCCEEDED') AS ok,
                 count(*) FILTER (WHERE e.status = 'CANCELLED' AND e.started_at IS NOT NULL AND e.error_message = 'cancelled while running') AS cancelled
            FROM monitoring_executions e, d
           WHERE e.queued_at >= d.lo - interval '1 day' AND e.queued_at < d.hi AND e.finished_at >= d.lo AND e.finished_at < d.hi
             AND e.tier IN ('T1_HTTP', 'T2_RENDER', 'T3_DEEP')
           GROUP BY 1, 2
        ),
        missing AS (
          SELECT r.org_id, count(*) AS n FROM execution_results r, d
           WHERE r.recorded_at >= d.lo AND r.recorded_at < d.hi AND (
                 (r.tier = 'T1_HTTP' AND NOT EXISTS (SELECT 1 FROM check_results c WHERE c.execution_id = r.execution_id AND c.checked_at >= d.lo - interval '1 day' AND c.checked_at < d.hi))
              OR (r.tier = 'T2_RENDER' AND NOT EXISTS (SELECT 1 FROM page_test_results p WHERE p.execution_id = r.execution_id AND p.tested_at >= d.lo - interval '1 day' AND p.tested_at < d.hi)))
           GROUP BY 1
        ),
        expected AS (
          SELECT org_id, 'http.checks~ledger' AS chk, 'http.checks' AS key, n AS v FROM ledger WHERE tier = 'T1_HTTP'
          UNION ALL SELECT org_id, 'http.inconclusive~ledger', 'http.inconclusive', inc FROM ledger WHERE tier = 'T1_HTTP'
          UNION ALL SELECT org_id, 'browser.executions~ledger', 'browser.executions', n FROM ledger WHERE tier = 'T2_RENDER'
          UNION ALL SELECT org_id, 'browser.inconclusive~ledger', 'browser.inconclusive', inc FROM ledger WHERE tier = 'T2_RENDER'
          UNION ALL SELECT org_id, 'browser.screenshots~artifacts', 'browser.screenshots', n FROM shots
          UNION ALL SELECT org_id, 'browser.screenshot_bytes~artifacts', 'browser.screenshot_bytes', bytes FROM shots
          UNION ALL SELECT org_id, 'deepscan.scans~scans', 'deepscan.scans', n FROM scans
          UNION ALL SELECT org_id, 'deepscan.pages~urls', 'deepscan.pages', n FROM pages
          UNION ALL SELECT org_id, 'exec.' || tier || '.ok~executions', 'exec.' || tier || '.ok', ok FROM execs
          UNION ALL SELECT org_id, 'exec.' || tier || '.cancelled~executions', 'exec.' || tier || '.cancelled', cancelled FROM execs
        ),
        keys AS (SELECT * FROM (VALUES
          ('http.checks~ledger', 'http.checks'), ('http.inconclusive~ledger', 'http.inconclusive'), ('browser.executions~ledger', 'browser.executions'),
          ('browser.inconclusive~ledger', 'browser.inconclusive'), ('browser.screenshots~artifacts', 'browser.screenshots'),
          ('browser.screenshot_bytes~artifacts', 'browser.screenshot_bytes'), ('deepscan.scans~scans', 'deepscan.scans'), ('deepscan.pages~urls', 'deepscan.pages'),
          ('exec.http.ok~executions', 'exec.http.ok'), ('exec.browser.ok~executions', 'exec.browser.ok'), ('exec.deepscan.ok~executions', 'exec.deepscan.ok'),
          ('exec.http.cancelled~executions', 'exec.http.cancelled'), ('exec.browser.cancelled~executions', 'exec.browser.cancelled'), ('exec.deepscan.cancelled~executions', 'exec.deepscan.cancelled')
        ) k(chk, key)),
        compared AS (
          SELECT coalesce(e.org_id, u.org_id) AS org_id, k.chk, k.key, coalesce(u.value, 0) AS recorded, coalesce(e.v, 0) AS expected
            FROM keys k
            JOIN (SELECT DISTINCT org_id FROM expected UNION SELECT DISTINCT org_id FROM usage) o ON true
            LEFT JOIN expected e ON e.org_id = o.org_id AND e.chk = k.chk
            LEFT JOIN usage u ON u.org_id = o.org_id AND u.key = k.key
           WHERE coalesce(e.org_id, u.org_id) = o.org_id
        )
        SELECT org_id, chk AS "check", key, recorded::bigint, expected::bigint FROM compared WHERE recorded <> expected
        UNION ALL
        SELECT org_id, 'results~ledger', NULL, 0::bigint, n::bigint FROM missing`;
      const [{ orgs }] = await tx.$queryRaw<Array<{ orgs: number }>>`
        SELECT count(DISTINCT org_id)::int AS orgs FROM usage_counters WHERE period_start = ${day}::date`;
      if (rows.length) {
        await tx.usageDiscrepancy.createMany({
          data: rows.map((r) => ({ runId, orgId: r.org_id, day: new Date(`${day}T00:00:00Z`), check: r.check, key: r.key, recorded: r.recorded, expected: r.expected })),
          skipDuplicates: true,
        });
      }
      return { orgs, discrepancies: rows.length };
    });
    await withSystem(db, async (tx) => {
      await tx.usageReconciliationRun.update({ where: { id: runId }, data: { status: "DONE", finishedAt: new Date(), stats: { ...res, ms: Date.now() - t0 } } });
      await tx.systemHealthLog.create({ data: { component: "usage", metric: "reconciliation", value: res.discrepancies, labels: { day, ms: Date.now() - t0 } } });
    });
    return { runId, ...res, ms: Date.now() - t0 };
  } catch (e) {
    await withSystem(db, (tx) => tx.usageReconciliationRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), error: sanitizeError((e as Error).message) } })).catch(() => undefined);
    throw e;
  }
}

/**
 * Scheduler hook: run operator-requested reconciliations, and (once a day, when enabled) yesterday's. One run at a time
 * platform-wide (advisory lock).
 */
export async function runRequestedReconciliations(db: Db, o: { daily: boolean; now?: Date }): Promise<number> {
  const now = o.now ?? new Date();
  const locked = await withSystem(db, async (tx) => {
    const [{ l }] = await tx.$queryRaw<Array<{ l: boolean }>>`SELECT pg_try_advisory_lock(hashtext('wim.usage-reconcile')) AS l`;
    return l;
  });
  if (!locked) return 0;
  try {
    let n = 0;
    const queued = await withSystem(db, (tx) => tx.usageReconciliationRun.findMany({ where: { status: "REQUESTED" }, orderBy: { requestedAt: "asc" }, take: 3 }));
    for (const r of queued) { await reconcileUsageDay(db, r.day.toISOString().slice(0, 10), { runId: r.id }).catch(() => undefined); n++; }
    if (o.daily && now.getUTCHours() >= 1) {
      const y = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      const done = await withSystem(db, (tx) => tx.usageReconciliationRun.count({ where: { day: new Date(`${y}T00:00:00Z`), requestedById: null } }));
      if (!done) { await reconcileUsageDay(db, y).catch(() => undefined); n++; }
    }
    return n;
  } finally {
    await withSystem(db, (tx) => tx.$queryRaw`SELECT pg_advisory_unlock(hashtext('wim.usage-reconcile'))`).catch(() => undefined);
  }
}

/** Daily gauges (registered/verified websites, screenshot storage in use) — written as the day's value, not added. */
export async function recordUsageGauges(db: Db): Promise<number> {
  return withSystem(db, async (tx) => {
    const n = await tx.$executeRaw`
      INSERT INTO usage_counters (org_id, period_start, key, value, updated_at)
      SELECT org_id, (now() AT TIME ZONE 'UTC')::date, key, value, now() FROM (
        SELECT w.org_id, 'websites.registered' AS key, count(*) AS value FROM websites w WHERE w.status <> 'ARCHIVED' GROUP BY 1
        UNION ALL SELECT w.org_id, 'websites.verified', count(*) FROM websites w WHERE w.status <> 'ARCHIVED' AND w.verified_at IS NOT NULL GROUP BY 1
        UNION ALL SELECT a.org_id, 'storage.screenshot_bytes', sum(a.bytes) FROM artifacts a WHERE a.kind = 'SCREENSHOT' AND a.expires_at > now() GROUP BY 1
      ) g
      ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    return n;
  });
}
