import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import type { MonitoringTier } from "@wim/core";
import { createDb, loadSettings, withSystem } from "@wim/db";
import { createLogger } from "@wim/logger";
import { EMAIL_QUEUE } from "@wim/contracts";
import {
  createHeartbeat, createScheduler, DbOutageWatch, DeadLetterJob, partitionMaintenance, QUEUES, recordUsageGauges, relayOutbox,
  runPerformanceRollups, runPlatformEvaluation, runRequestedReconciliations, type CycleReport,
} from "@wim/queue";

const Env = z.object({
  WORKER_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("wim"),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(200).max(60_000).default(5_000),
  SCHEDULER_INSTANCE_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
});

/**
 * Monitoring scheduler process. Leaderless: run as many replicas as needed for
 * availability; PostgreSQL guarantees one execution per schedule window.
 * Network: `data` only (Postgres + Redis). No egress, no browser networks.
 */
export function startScheduler(source: NodeJS.ProcessEnv = process.env) {
  const env = Env.parse(source);
  const log = createLogger("scheduler");
  const instanceId = env.SCHEDULER_INSTANCE_ID ?? `scheduler-${hostname()}-${randomUUID().slice(0, 8)}`;
  const db = createDb({ url: env.WORKER_DATABASE_URL, max: 6, omitSecrets: true });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queues: Record<MonitoringTier, Queue> = {
    HTTP: new Queue(QUEUES.http, { connection, prefix: env.QUEUE_PREFIX }),
    BROWSER: new Queue(QUEUES.browser, { connection, prefix: env.QUEUE_PREFIX }),
    DEEPSCAN: new Queue(QUEUES.deepscan, { connection, prefix: env.QUEUE_PREFIX }),
  };
  const scheduler = createScheduler({ db, queues, log, instanceId });
  const emailQueue = new Queue(EMAIL_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  // Phase 4H: heartbeat with Redis probe and cycle counts; platform health evaluation; usage reconciliation + gauges
  let cycles = 0, cycleFailures = 0, lastCycleAt: Date | null = null;
  const hb = createHeartbeat({ db, connection, log, workerId: instanceId, kind: "scheduler", startedAt: new Date(),
    gauges: () => ({ activeJobs: 0, capacity: 1, processed: cycles, failed: cycleFailures, lastJobAt: lastCycleAt }) });
  const opsQueues = { [QUEUES.http]: queues.HTTP, [QUEUES.browser]: queues.BROWSER, [QUEUES.deepscan]: queues.DEEPSCAN, [EMAIL_QUEUE]: emailQueue };
  const outage = new DbOutageWatch({ emailQueue, log, evaluatorId: instanceId });
  let lastOps = 0, lastRecon = 0, lastGauges = 0;
  void hb.started();

  // Dead letters: count and alert (aggregate only). Replays are requested by admins and run in the cycle.
  const deadLetters = new Worker(QUEUES.deadLetter, async (job) => {
    if (!DeadLetterJob.safeParse(job.data).success) return;
    await withSystem(db, (tx) => tx.systemHealthLog.create({ data: { component: "queue", metric: "dead_letter", value: 1 } }));
  }, { connection, prefix: env.QUEUE_PREFIX, concurrency: 1 });
  deadLetters.on("error", (e) => log.warn({ err: e.message }, "dead-letter consumer error"));

  let stopping = false;
  let current: Promise<unknown> = Promise.resolve();
  let last: CycleReport | null = null;
  let lastRollup = 0;
  const tick = async () => {
    if (stopping) return;
    current = (async () => {
      try {
        last = await scheduler.runCycle();
        cycles++; lastCycleAt = new Date();
      } catch (e) {
        cycleFailures++;
        log.error({ err: (e as Error).message }, "scheduling cycle failed");
      }
      try {
        await relayOutbox(db, emailQueue);
      } catch (e) {
        log.warn({ err: (e as Error).message }, "outbox relay failed; will retry next cycle");
      }
      // Phase 4G: performance rollups at most once a minute (idempotent; one instance at a time via an advisory lock)
      if (Date.now() - lastRollup > 60_000) {
        lastRollup = Date.now();
        try {
          const settings = await loadSettings(db);
          if (settings["monitoring.rollups.enabled"]) {
            const r = await runPerformanceRollups(db);
            if (r.ran && r.rows) log.info({ hours: r.hours, days: r.days, rows: r.rows }, "performance rollups");
          }
        } catch (e) {
          log.warn({ err: (e as Error).message }, "performance rollups failed; retried next cycle");
        }
      }
      try {
        const m = await partitionMaintenance(db);
        if (m.ran) log.info({ dropped: m.dropped }, "partition maintenance");
      } catch (e) {
        log.warn({ err: (e as Error).message }, "partition maintenance failed");
      }
      // Phase 4H: platform health + self-alerts (one evaluator platform-wide; cadence from settings)
      if (Date.now() - lastOps >= 5_000) {
        lastOps = Date.now();
        try {
          const r = await runPlatformEvaluation({ db, connection, queues: opsQueues, evaluatorId: instanceId, log, prefix: env.QUEUE_PREFIX });
          if (r.ran && (r.opened.length || r.recovered.length)) log.warn({ opened: r.opened.length, recovered: r.recovered.length, suppressed: r.suppressed.length }, "platform alerts changed");
          await outage.succeeded(db);
        } catch (e) {
          await outage.failed(e);
        }
      }
      if (Date.now() - lastRecon >= 60_000) {
        lastRecon = Date.now();
        try {
          const settings = await loadSettings(db);
          await runRequestedReconciliations(db, { daily: settings["ops.usage.reconcileDaily"] });
          if (Date.now() - lastGauges >= 3_600_000) { await recordUsageGauges(db); lastGauges = Date.now(); }
        } catch (e) {
          log.warn({ err: (e as Error).message }, "usage reconciliation failed; retried next minute");
        }
      }
      await hb.beat();
    })();
    await current;
    if (!stopping) timer = setTimeout(tick, env.SCHEDULER_TICK_MS);
  };
  let timer = setTimeout(tick, 0);
  log.info({ instanceId, tickMs: env.SCHEDULER_TICK_MS }, "scheduler started");

  return {
    instanceId,
    lastReport: () => last,
    /** Finish the current cycle (never abandon a half-dispatched batch), then close. */
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await current;
      await deadLetters.close();
      await Promise.all([...Object.values(queues), emailQueue].map((q) => q.close()));
      await hb.remove();
      connection.disconnect();
      await db.$disconnect();
      log.info({ instanceId }, "scheduler stopped");
    },
  };
}
