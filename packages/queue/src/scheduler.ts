import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import {
  fairOrder, jitterFor, MONITORING_TIERS, TIER_DB, TIER_FROM_DB, windowStart,
  type MonitoringTier, type SettingsSnapshot,
} from "@wim/core";
import { loadSettings, withSystem, type Db, type Tx } from "@wim/db";
import type { Logger } from "@wim/logger";
import { evaluate, loadOrgContexts, loadWebsiteFacts, type OrgContext } from "./facts.js";
import { jobOptions, policyFor, TIER_QUEUE_NAME, QUEUES, type ExecutionJob } from "./registry.js";
import { healthMetric } from "./util.js";

/**
 * Leaderless monitoring scheduler (PHASE4_PLAN §5.3). Any number of instances may run
 * the same cycle at the same time; correctness never depends on a leader:
 *  - a schedule row is claimed with FOR UPDATE SKIP LOCKED and re-checked (next_run_at <= now)
 *  - the execution for (schedule, window) is inserted ON CONFLICT DO NOTHING against the
 *    unique (schedule_id, slot, queued_at) index — PostgreSQL, not Redis, is the idempotency key
 *  - per-org work is serialised by a transaction-scoped advisory lock, so outstanding-job
 *    limits hold across instances
 *  - BullMQ jobId = execution id, so re-enqueueing is a no-op
 *  - anything committed but not confirmed in Redis is re-enqueued by reconcile()
 */

export const OUTSTANDING = ["SCHEDULED", "QUEUED", "RUNNING", "RETRYING"] as const;

export interface SchedulerDeps {
  db: Db;
  queues: Record<MonitoringTier, Queue>;
  log: Logger;
  instanceId: string;
  /** Test hook: fail after the DB commit and before Redis (crash simulation). */
  afterCommitHook?: (executionIds: string[]) => Promise<void> | void;
}

export interface CycleReport {
  synced: { activated: number; paused: number; created: number; cancelled: number };
  dispatched: Record<MonitoringTier, number>;
  duplicatesPrevented: number;
  missedWindows: number;
  backpressure: MonitoringTier[];
  reconciled: { reenqueued: number; recovered: number; deadLettered: number };
  replays: { replayed: number; refused: number };
  enqueueErrors: number;
}

interface Due { id: string; orgId: string; websiteId: string; intervalSec: number; jitterSec: number; priority: number; nextRunAt: Date }

export function createScheduler(deps: SchedulerDeps) {
  const { db, queues, log } = deps;

  // ------------------------------------------------------------------ sync
  async function sync(s: SettingsSnapshot, report: CycleReport): Promise<Map<string, OrgContext>> {
    return withSystem(db, async (tx) => {
      const facts = await loadWebsiteFacts(tx);
      const orgs = await loadOrgContexts(tx, [...new Set(facts.map((f) => f.orgId))], s);
      // One instance writes schedule state per cycle; the others only need the org contexts.
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.scheduler.sync')) AS locked`;
      if (!locked) return orgs;
      const existing = await tx.monitoringSchedule.findMany({
        where: { apiEndpointId: null, tier: { in: MONITORING_TIERS.map((t) => TIER_DB[t]) } },
        select: { id: true, websiteId: true, tier: true, status: true, intervalSec: true, pausedReason: true, nextRunAt: true },
      });
      const byKey = new Map(existing.map((e) => [`${e.websiteId}:${e.tier}`, e]));
      const now = new Date();
      for (const w of facts) {
        const org = orgs.get(w.orgId)!;
        const everMonitored = ["ACTIVE", "PAUSED", "LAPSED"].includes(w.websiteStatus) && !w.archived;
        for (const tier of MONITORING_TIERS) {
          const { reason, intervalSec } = evaluate(w, org, tier);
          const cur = byKey.get(`${w.websiteId}:${TIER_DB[tier]}`);
          if (!cur) {
            if (!everMonitored) continue;
            const id = randomUUID();
            const { count } = await tx.monitoringSchedule.createMany({
              data: [{
                id, orgId: w.orgId, websiteId: w.websiteId, tier: TIER_DB[tier], intervalSec, jitterSec: jitterFor(id, intervalSec),
                status: reason ? "PAUSED" : "ACTIVE", pausedReason: reason, nextRunAt: now,
              }],
              skipDuplicates: true,
            });
            report.synced.created += count;
            continue;
          }
          if (!reason) {
            if (cur.status !== "ACTIVE" || cur.intervalSec !== intervalSec) {
              const resumed = cur.status !== "ACTIVE";
              await tx.$executeRaw`
                UPDATE monitoring_schedules
                   SET status = 'ACTIVE', paused_reason = NULL, interval_sec = ${intervalSec}, jitter_sec = ${jitterFor(cur.id, intervalSec)},
                       next_run_at = CASE WHEN ${resumed} THEN now() ELSE LEAST(next_run_at, now() + make_interval(secs => ${intervalSec})) END,
                       updated_at = now()
                 WHERE id = ${cur.id}::uuid`;
              if (resumed) report.synced.activated++;
            }
          } else if (cur.status !== "PAUSED" || cur.pausedReason !== reason) {
            await tx.monitoringSchedule.update({ where: { id: cur.id }, data: { status: "PAUSED", pausedReason: reason } });
            report.synced.cancelled += await cancelOutstanding(tx, w.websiteId, TIER_DB[tier], `not eligible: ${reason}`);
            report.synced.paused++;
          }
        }
      }
      // Schedules of websites that no longer exist in an eligible form (hard-deleted rows cascade).
      return orgs;
    });
  }

  // ------------------------------------------------------------------ dispatch
  async function dispatch(tier: MonitoringTier, s: SettingsSnapshot, orgs: Map<string, OrgContext>, report: CycleReport) {
    const dbTier = TIER_DB[tier];
    const [{ total }] = await withSystem(db, (tx) => tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM monitoring_executions
       WHERE tier = ${dbTier}::"CheckTier" AND status::text = ANY(${[...OUTSTANDING]}::text[]) AND queued_at > now() - interval '8 days'`);
    const globalRoom = s["monitoring.global.maxOutstandingJobs"] - Number(total);
    if (globalRoom <= 0) {
      report.backpressure.push(tier);
      await withSystem(db, (tx) => healthMetric(tx, "scheduler", "backpressure", Number(total), { tier }));
      return;
    }
    const maxQuota = Math.max(1, ...[...orgs.values()].map((o) => o.limits.perCycleQuota));
    // rn = position within the org: ORDER BY rn interleaves organisations (round-robin) before the LIMIT.
    const due = await withSystem(db, (tx) => tx.$queryRaw<Array<{ id: string; org_id: string; website_id: string; interval_sec: number; jitter_sec: number; priority: number; next_run_at: Date }>>`
      SELECT id, org_id, website_id, interval_sec, jitter_sec, priority, next_run_at FROM (
        SELECT s.*, row_number() OVER (PARTITION BY s.org_id ORDER BY s.next_run_at, s.id) AS rn
          FROM monitoring_schedules s
         WHERE s.status = 'ACTIVE' AND s.tier = ${dbTier}::"CheckTier" AND s.api_endpoint_id IS NULL AND s.next_run_at <= now()
      ) d WHERE rn <= ${maxQuota} ORDER BY rn, next_run_at LIMIT ${s["scheduler.batchSize"]}`);
    if (!due.length) return;
    const rows: Due[] = due.map((r) => ({ id: r.id, orgId: r.org_id, websiteId: r.website_id, intervalSec: r.interval_sec, jitterSec: r.jitter_sec, priority: r.priority, nextRunAt: r.next_run_at }));
    const chosen = fairOrder(
      rows,
      (o) => orgs.get(o)?.limits.perCycleQuota ?? 0,
      (o) => orgs.get(o)?.limits.weight ?? 1,
      Math.min(globalRoom, s["scheduler.batchSize"]),
    );
    const perOrg = new Map<string, Due[]>();
    for (const r of chosen) perOrg.set(r.orgId, [...(perOrg.get(r.orgId) ?? []), r]);

    const created = new Map<string, Array<{ id: string; windowStart: Date; priority: number }>>();
    for (const [orgId, list] of perOrg) {
      const limits = orgs.get(orgId)?.limits;
      if (!limits) continue;
      const out = await withSystem(db, async (tx) => {
        // Serialise one org's dispatch across scheduler instances (outstanding limit is exact).
        const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.scheduler.org'), hashtext(${orgId})) AS locked`;
        if (!locked) return [];
        const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM monitoring_executions
           WHERE org_id = ${orgId}::uuid AND status::text = ANY(${[...OUTSTANDING]}::text[]) AND queued_at > now() - interval '8 days'`;
        let room = limits.maxOutstandingJobs - Number(n);
        const made: Array<{ id: string; windowStart: Date; priority: number }> = [];
        for (const sched of list) {
          if (room <= 0) break;
          const [row] = await tx.$queryRaw<Array<{ interval_sec: number; jitter_sec: number; next_run_at: Date; now: Date }>>`
            SELECT interval_sec, jitter_sec, next_run_at, now() AS now FROM monitoring_schedules
             WHERE id = ${sched.id}::uuid AND status = 'ACTIVE' AND next_run_at <= now()
             FOR UPDATE SKIP LOCKED`;
          if (!row) continue; // another instance holds or already advanced it
          const ws = windowStart(row.now.getTime(), row.interval_sec, row.jitter_sec);
          const missed = Math.max(0, Math.floor((ws - row.next_run_at.getTime()) / (row.interval_sec * 1000)));
          const id = randomUUID();
          const inserted = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO monitoring_executions (id, queued_at, org_id, website_id, schedule_id, slot, tier, trigger, status, enqueued_at)
            VALUES (${id}::uuid, ${new Date(ws)}, ${orgId}::uuid, ${sched.websiteId}::uuid, ${sched.id}::uuid, ${Math.floor(ws / 1000)},
                    ${dbTier}::"CheckTier", 'SCHEDULE', 'SCHEDULED', now())
            ON CONFLICT (schedule_id, slot, queued_at) DO NOTHING RETURNING id`;
          // Missed windows after downtime are not back-filled: the next run is the next window.
          await tx.$executeRaw`
            UPDATE monitoring_schedules SET next_run_at = ${new Date(ws + row.interval_sec * 1000)}, last_enqueued_at = now(),
                   missed_slots = missed_slots + ${missed}, updated_at = now()
             WHERE id = ${sched.id}::uuid`;
          report.missedWindows += missed;
          if (inserted.length) {
            made.push({ id, windowStart: new Date(ws), priority: sched.priority });
            room--;
          } else {
            report.duplicatesPrevented++;
          }
        }
        return made;
      });
      if (out.length) created.set(orgId, out);
    }
    // Enqueue interleaved by organisation so FIFO consumers alternate tenants.
    const interleaved = fairOrder(
      [...created].flatMap(([orgId, list]) => list.map((e) => ({ orgId, ...e }))),
      () => Number.MAX_SAFE_INTEGER, () => 1, Number.MAX_SAFE_INTEGER,
    );
    if (!interleaved.length) return;
    await deps.afterCommitHook?.(interleaved.map((e) => e.id));
    await enqueue(tier, interleaved, s);
    report.dispatched[tier] += interleaved.length;
  }

  async function enqueue(tier: MonitoringTier, items: Array<{ id: string; windowStart: Date; priority?: number }>, s: SettingsSnapshot) {
    const policy = policyFor(s, TIER_QUEUE_NAME[tier]);
    await queues[tier].addBulk(items.map((e) => ({
      name: "EXECUTE",
      data: { v: 1, executionId: e.id, windowStart: e.windowStart.toISOString() } satisfies ExecutionJob,
      opts: jobOptions(e.id, policy, e.priority ?? 5),
    })));
    await withSystem(db, (tx) => tx.$executeRaw`
      UPDATE monitoring_executions SET status = 'QUEUED', enqueued_at = now()
       WHERE id = ANY(${items.map((e) => e.id)}::uuid[]) AND status = 'SCHEDULED' AND queued_at > now() - interval '8 days'`);
  }

  // ------------------------------------------------------------------ reconcile
  async function reconcile(s: SettingsSnapshot, report: CycleReport) {
    const after = s["scheduler.reconcileAfterSec"];
    const rows = await withSystem(db, (tx) => tx.$queryRaw<Array<{ id: string; queued_at: Date; tier: string; status: string; attempt: number; org_id: string; website_id: string; lease_expired: boolean }>>`
      SELECT id, queued_at, tier::text AS tier, status::text AS status, attempt, org_id, website_id,
             (status = 'RUNNING' AND lease_expires_at < now()) AS lease_expired
        FROM monitoring_executions
       WHERE queued_at > now() - interval '8 days'
         AND tier::text = ANY(${MONITORING_TIERS.map((t) => TIER_DB[t])}::text[])
         AND ( (status IN ('SCHEDULED', 'QUEUED', 'RETRYING') AND coalesce(enqueued_at, queued_at) < now() - make_interval(secs => ${after}))
            OR (status = 'RUNNING' AND lease_expires_at < now()) )
       ORDER BY coalesce(enqueued_at, queued_at)
       LIMIT 200`);
    for (const r of rows) {
      const tier = TIER_FROM_DB[r.tier]!;
      const policy = policyFor(s, TIER_QUEUE_NAME[tier]);
      const queue = queues[tier];
      const job = await queue.getJob(r.id);
      const state = job ? await job.getState() : "missing";
      if (["waiting", "delayed", "prioritized", "active", "waiting-children"].includes(state)) {
        if (r.status === "SCHEDULED") {
          await withSystem(db, (tx) => tx.$executeRaw`UPDATE monitoring_executions SET status = 'QUEUED', enqueued_at = now() WHERE id = ${r.id}::uuid AND queued_at = ${r.queued_at} AND status = 'SCHEDULED'`);
          report.reconciled.reenqueued++;
        }
        continue; // BullMQ owns it (stalled active jobs are redelivered by BullMQ itself)
      }
      // Job missing from Redis (never enqueued, Redis data loss) or finished in Redis while the DB says otherwise.
      if (r.attempt >= policy.attempts && (r.lease_expired || state === "failed")) {
        await deadLetter(db, {
          executionId: r.id, queuedAt: r.queued_at, orgId: r.org_id, websiteId: r.website_id, tier, queue: TIER_QUEUE_NAME[tier],
          attempts: r.attempt, category: "TRANSIENT", error: r.lease_expired ? "worker lost (lease expired)" : "job failed outside the processor",
        });
        report.reconciled.deadLettered++;
        continue;
      }
      if (job) await job.remove().catch(() => undefined);
      await withSystem(db, (tx) => tx.$executeRaw`
        UPDATE monitoring_executions
           SET status = CASE WHEN status = 'RUNNING' THEN 'RETRYING'::"ExecutionStatus" ELSE status END,
               lease_expires_at = CASE WHEN status = 'RUNNING' THEN now() - interval '1 second' ELSE lease_expires_at END,
               enqueued_at = now()
         WHERE id = ${r.id}::uuid AND queued_at = ${r.queued_at}`);
      await enqueue(tier, [{ id: r.id, windowStart: r.queued_at }], s);
      if (r.lease_expired) report.reconciled.recovered++;
      else report.reconciled.reenqueued++;
    }
    // Deep scans left RUNNING by an execution that already ended (dead-lettered, killed worker) are closed, so the
    // dashboard stops showing "Running" and the website can be scanned again.
    await withSystem(db, (tx) => tx.$queryRaw`SELECT public.close_abandoned_deep_scans(NULL)`).catch(() => undefined);
  }

  // ------------------------------------------------------------------ replay
  async function replays(s: SettingsSnapshot, report: CycleReport) {
    const pending = await withSystem(db, (tx) => tx.jobFailure.findMany({
      where: { replayRequestedAt: { not: null }, resolution: null }, take: 50, orderBy: { replayRequestedAt: "asc" },
    }));
    for (const f of pending) {
      const outcome = await withSystem(db, async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM job_failures WHERE id = ${f.id}::uuid AND resolution IS NULL FOR UPDATE SKIP LOCKED`;
        if (!locked) return null;
        const refuse = async (why: string) => {
          await tx.jobFailure.update({ where: { id: f.id }, data: { resolution: "REPLAY_REFUSED", resolvedAt: new Date(), replayReason: `${f.replayReason ?? ""} | refused: ${why}`.slice(0, 500) } });
          return { refused: why } as const;
        };
        const tier = (MONITORING_TIERS as readonly string[]).includes(f.jobType ?? "") ? (f.jobType as MonitoringTier) : null;
        if (f.failureCategory === "SECURITY") return refuse("security failures are never replayed");
        if (!tier || !f.websiteId || !f.orgId) return refuse("not a monitoring execution");
        // Current authorisation, ownership and entitlement — never the state at the time of failure.
        const [w] = await loadWebsiteFacts(tx, [f.websiteId]);
        if (!w || w.orgId !== f.orgId) return refuse("website no longer belongs to the organisation");
        const org = (await loadOrgContexts(tx, [w.orgId], s)).get(w.orgId)!;
        const { reason } = evaluate(w, org, tier);
        if (reason) return refuse(`not eligible: ${reason}`);
        const sched = await tx.monitoringSchedule.findFirst({ where: { websiteId: w.websiteId, tier: TIER_DB[tier], apiEndpointId: null }, select: { id: true } });
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO monitoring_executions (id, queued_at, org_id, website_id, schedule_id, tier, trigger, status, enqueued_at)
          VALUES (${id}::uuid, date_trunc('milliseconds', now()), ${w.orgId}::uuid, ${w.websiteId}::uuid, ${sched?.id ?? null}::uuid, ${TIER_DB[tier]}::"CheckTier", 'REPLAY', 'SCHEDULED', now())`;
        const [{ queued_at }] = await tx.$queryRaw<Array<{ queued_at: Date }>>`SELECT queued_at FROM monitoring_executions WHERE id = ${id}::uuid`;
        await tx.jobFailure.update({ where: { id: f.id }, data: { resolution: "REPLAYED", resolvedAt: new Date(), replayExecutionId: id } });
        return { tier, id, windowStart: queued_at } as const;
      });
      if (!outcome) continue;
      if ("refused" in outcome) { report.replays.refused++; continue; }
      await enqueue(outcome.tier, [{ id: outcome.id, windowStart: outcome.windowStart }], s).catch(() => undefined); // reconcile retries
      report.replays.replayed++;
    }
  }

  // ------------------------------------------------------------------ cycle
  async function runCycle(): Promise<CycleReport> {
    const started = Date.now();
    const report: CycleReport = {
      synced: { activated: 0, paused: 0, created: 0, cancelled: 0 },
      dispatched: { HTTP: 0, BROWSER: 0, DEEPSCAN: 0 }, duplicatesPrevented: 0, missedWindows: 0, backpressure: [],
      reconciled: { reenqueued: 0, recovered: 0, deadLettered: 0 }, replays: { replayed: 0, refused: 0 }, enqueueErrors: 0,
    };
    const s = await loadSettings(db, (key) => log.warn({ key }, "invalid platform setting; using default"));
    const orgs = await sync(s, report);
    for (const tier of MONITORING_TIERS) {
      try {
        await dispatch(tier, s, orgs, report);
      } catch (e) {
        // Committed executions stay SCHEDULED and are re-enqueued by reconcile once Redis is back.
        report.enqueueErrors++;
        log.warn({ tier, err: (e as Error).message }, "dispatch failed; will reconcile");
      }
    }
    try { await reconcile(s, report); } catch (e) { report.enqueueErrors++; log.warn({ err: (e as Error).message }, "reconcile failed"); }
    try { await replays(s, report); } catch (e) { log.warn({ err: (e as Error).message }, "replay failed"); }
    // Workers that died without deregistering (SIGKILL, OOM) stay visible as unavailable for an hour, then are pruned.
    await withSystem(db, (tx) => tx.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - 3_600_000) } } })).catch(() => undefined);
    await withSystem(db, async (tx) => {
      await healthMetric(tx, "scheduler", "cycle_ms", Date.now() - started, { instance: deps.instanceId, errors: report.enqueueErrors });
      if (report.enqueueErrors === 0) await healthMetric(tx, "scheduler", "cycle_ok", 1, { instance: deps.instanceId });
      const n = Object.values(report.dispatched).reduce((a, b) => a + b, 0);
      if (n) await healthMetric(tx, "scheduler", "dispatched", n);
      if (report.duplicatesPrevented) await healthMetric(tx, "scheduler", "duplicates_prevented", report.duplicatesPrevented);
      if (report.missedWindows) await healthMetric(tx, "scheduler", "missed_windows", report.missedWindows);
    });
    return report;
  }

  return { runCycle, sync: (s: SettingsSnapshot) => sync(s, emptyReport()), enqueue };
}

function emptyReport(): CycleReport {
  return {
    synced: { activated: 0, paused: 0, created: 0, cancelled: 0 }, dispatched: { HTTP: 0, BROWSER: 0, DEEPSCAN: 0 }, duplicatesPrevented: 0,
    missedWindows: 0, backpressure: [], reconciled: { reenqueued: 0, recovered: 0, deadLettered: 0 }, replays: { replayed: 0, refused: 0 }, enqueueErrors: 0,
  };
}

/** Cancel pending executions of a website/tier and ask running ones to stop. */
export async function cancelOutstanding(tx: Tx, websiteId: string, dbTier: string, why: string): Promise<number> {
  const n = await tx.$executeRaw`
    UPDATE monitoring_executions SET status = 'CANCELLED', failure_category = 'CANCELLED', finished_at = now(), error_message = ${why}
     WHERE website_id = ${websiteId}::uuid AND tier = ${dbTier}::"CheckTier" AND status IN ('SCHEDULED', 'QUEUED', 'RETRYING')
       AND queued_at > now() - interval '8 days'`;
  await tx.$executeRaw`
    UPDATE monitoring_executions SET cancel_requested_at = now()
     WHERE website_id = ${websiteId}::uuid AND tier = ${dbTier}::"CheckTier" AND status = 'RUNNING' AND queued_at > now() - interval '8 days'`;
  return n;
}

export interface DeadLetterInput {
  executionId: string; queuedAt: Date; orgId: string; websiteId: string; tier: MonitoringTier; queue: string;
  attempts: number; category: string; error: string;
}

/** Record an exhausted/permanent/security failure. Payload: identifiers only. */
export async function deadLetter(db: Db, d: DeadLetterInput, deadLetterQueue?: Queue): Promise<string> {
  const id = await withSystem(db, async (tx) => {
    await tx.$executeRaw`
      UPDATE monitoring_executions SET status = 'DEAD_LETTERED', failure_category = ${d.category}, finished_at = now(),
             error_message = ${d.error}, lease_expires_at = NULL
       WHERE id = ${d.executionId}::uuid AND queued_at = ${d.queuedAt}`;
    const f = await tx.jobFailure.create({
      data: {
        queue: d.queue, jobId: d.executionId, executionId: d.executionId, orgId: d.orgId, websiteId: d.websiteId, jobType: d.tier,
        failureCategory: d.category, attempts: d.attempts, error: d.error,
        payload: { executionId: d.executionId, windowStart: d.queuedAt.toISOString() },
      },
      select: { id: true },
    });
    return f.id;
  });
  await deadLetterQueue?.add("DEAD_LETTER", { v: 1, jobFailureId: id }, { jobId: id, removeOnComplete: { age: 7 * 86_400 } }).catch(() => undefined);
  return id;
}

export { QUEUES };
