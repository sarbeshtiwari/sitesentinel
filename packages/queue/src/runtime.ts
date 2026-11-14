import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { TIER_DB, type MonitoringTier, type QueuePolicy, type SettingsSnapshot } from "@wim/core";
import { loadSettings, withSystem, type Db } from "@wim/db";
import type { Logger } from "@wim/logger";
import { categorize, JobError, SecurityError, type FailureCategory } from "./errors.js";
import { evaluate, loadOrgContexts, loadWebsiteFacts } from "./facts.js";
import { backoffStrategy, ExecutionJob, policyFor, QUEUES, TIER_QUEUE_NAME } from "./registry.js";
import { deadLetter } from "./scheduler.js";
import { addUsage, healthMetric, sanitizeError } from "./util.js";
import { createHeartbeat } from "./heartbeat.js";

/** What an engine handler receives: trusted facts only (re-read from the database). */
export interface ExecutionContext {
  executionId: string;
  orgId: string;
  websiteId: string;
  tier: MonitoringTier;
  attempt: number;
  /** attempts allowed by the queue policy; handlers may record a final outcome instead of throwing on the last one */
  maxAttempts: number;
  windowStart: Date;
  /** Aborted on cancellation, timeout or shutdown; handlers must stop promptly. */
  signal: AbortSignal;
}
export interface ExecutionResult {
  summary?: Record<string, unknown>;
  /** extra usage to account, e.g. { "deepscan.pages": 40 } */
  usage?: Record<string, number>;
}
export type ExecutionHandler = (ctx: ExecutionContext) => Promise<ExecutionResult | void>;

export interface ExecutionWorkerOptions {
  db: Db;
  connection: Redis;
  prefix: string;
  tier: MonitoringTier;
  handler: ExecutionHandler;
  log: Logger;
  workerId: string;
  version?: string;
  /** BullMQ lock/stall tuning (tests shorten these). */
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  heartbeatEveryMs?: number;
  settingsTtlMs?: number;
  /** Phase 4H: dependency probes reported with the heartbeat (gateway, runner, storage …); Redis is always probed */
  probes?: Record<string, () => Promise<void>>;
  /** Phase 4H: extra aggregate gauges reported with the heartbeat (e.g. runner sessions) */
  meta?: () => Promise<Record<string, number | boolean | string>>;
}

class Abort extends Error {
  constructor(readonly reason: "CANCELLED" | "TIMEOUT" | "SHUTDOWN") { super(reason); }
}

// Acquire one slot in each semaphore atomically (sorted sets of member → expiry).
const ACQUIRE = `
local now = tonumber(ARGV[1])
for i = 1, #KEYS do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now) end
for i = 1, #KEYS do
  if redis.call('ZSCORE', KEYS[i], ARGV[2]) == false and redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[3 + i]) then return i end
end
for i = 1, #KEYS do redis.call('ZADD', KEYS[i], tonumber(ARGV[3]), ARGV[2]) end
return 0`;

/**
 * Consumer for one execution queue. Lifecycle (PHASE4_PLAN §5.4):
 *   SCHEDULED/QUEUED/RETRYING ─claim→ RUNNING ─→ SUCCEEDED | RETRYING | DEAD_LETTERED | CANCELLED
 *   (ineligible at start → SKIPPED; terminal or leased by another worker → duplicate delivery, no work)
 */
export function createExecutionWorker(o: ExecutionWorkerOptions) {
  const { db, connection, tier, log } = o;
  const queueName = TIER_QUEUE_NAME[tier];
  const dbTier = TIER_DB[tier];
  const dlq = new Queue(QUEUES.deadLetter, { connection, prefix: o.prefix });
  const active = new Map<string, AbortController>();
  /** Phase 4H: work actually done (heartbeat: alive ≠ processing) */
  const stats = { processed: 0, failed: 0, timeouts: 0, lastJobAt: null as Date | null };
  let closing = false;
  let cached: { at: number; s: SettingsSnapshot } | null = null;
  const settings = async () => {
    if (!cached || Date.now() - cached.at > (o.settingsTtlMs ?? 10_000)) cached = { at: Date.now(), s: await loadSettings(db) };
    return cached.s;
  };
  const semKeys = (orgId: string) => [`${o.prefix}:sem:org:${orgId}`, `${o.prefix}:sem:global:${queueName}`, `${o.prefix}:sem:org-tier:${orgId}:${tier}`];

  async function securityFailure(job: Job, why: string, ids?: { executionId?: string; orgId?: string; websiteId?: string }) {
    log.warn({ queue: queueName, jobId: job.id, why }, "rejected job (security)");
    await withSystem(db, async (tx) => {
      await tx.jobFailure.create({
        data: {
          queue: queueName, jobId: String(job.id ?? "").slice(0, 80), executionId: ids?.executionId, orgId: ids?.orgId, websiteId: ids?.websiteId,
          jobType: String(job.name).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40), failureCategory: "SECURITY", attempts: job.attemptsMade + 1,
          error: why, payload: {}, // the untrusted payload is never stored
        },
      });
      await healthMetric(tx, "queue", "security_rejected", 1, { queue: queueName });
    });
    throw new UnrecoverableError(`SECURITY: ${why}`);
  }

  async function process(job: Job, token?: string) {
    const s = await settings();
    const policy: QueuePolicy = policyFor(s, queueName);
    // 1. Validate type and payload. Extra keys (orgId, url, ...) are rejected, not ignored.
    if (job.name !== "EXECUTE") return securityFailure(job, "unknown job type");
    const parsed = ExecutionJob.safeParse(job.data);
    if (!parsed.success) return securityFailure(job, "malformed payload");
    if (job.id !== parsed.data.executionId) return securityFailure(job, "job id does not match execution");
    const windowStart = new Date(parsed.data.windowStart);

    // 2. Trusted execution row: tenant, website and tier come from here only.
    const [exec] = await withSystem(db, (tx) => tx.$queryRaw<Array<{ org_id: string; website_id: string; tier: string; status: string; queued_at: Date; enqueued_at: Date | null; lease_expires_at: Date | null; worker_id: string | null }>>`
      SELECT org_id, website_id, tier::text AS tier, status::text AS status, queued_at, enqueued_at, lease_expires_at, worker_id
        FROM monitoring_executions WHERE id = ${parsed.data.executionId}::uuid AND queued_at = ${windowStart}`);
    if (!exec) return securityFailure(job, "unknown execution");
    if (exec.tier !== dbTier) return securityFailure(job, "execution belongs to another queue", { executionId: parsed.data.executionId, orgId: exec.org_id, websiteId: exec.website_id });
    const key = { id: parsed.data.executionId, queuedAt: exec.queued_at };

    // 3. Duplicate or concurrent delivery: terminal → acknowledge; live lease elsewhere → wait for it.
    if (["SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED", "DEAD_LETTERED", "TIMED_OUT"].includes(exec.status)) return { duplicate: true, status: exec.status };
    if (exec.status === "RUNNING" && exec.lease_expires_at && exec.lease_expires_at.getTime() > Date.now()) {
      await job.moveToDelayed(exec.lease_expires_at.getTime() + 1000, token);
      throw new DelayedError();
    }

    // 4. Eligibility NOW (pause, deletion, ownership lapse, org suspension, entitlement, tier switch).
    const reason = await withSystem(db, async (tx) => {
      const [w] = await loadWebsiteFacts(tx, [exec.website_id]);
      if (!w) return "WEBSITE_INACTIVE";
      if (w.orgId !== exec.org_id) return "SECURITY";
      const org = (await loadOrgContexts(tx, [w.orgId], s)).get(w.orgId)!;
      return evaluate(w, org, tier).reason;
    });
    if (reason === "SECURITY") return securityFailure(job, "execution tenant does not own the website", { executionId: key.id, orgId: exec.org_id, websiteId: exec.website_id });
    if (reason) {
      await withSystem(db, async (tx) => {
        await tx.$executeRaw`
          UPDATE monitoring_executions SET status = 'SKIPPED', failure_category = 'INELIGIBLE', error_message = ${reason}, finished_at = now()
           WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND status IN ('SCHEDULED', 'QUEUED', 'RETRYING', 'RUNNING')`;
        await addUsage(tx, exec.org_id, { [`exec.${tier.toLowerCase()}.skipped`]: 1 });
      });
      return { skipped: reason };
    }

    // 5. Tenant fairness: per-org and global concurrency (Redis semaphores with expiry = lease).
    const orgLimits = await withSystem(db, async (tx) => (await loadOrgContexts(tx, [exec.org_id], s)).get(exec.org_id)!.limits);
    const orgLimit = orgLimits.maxConcurrentJobs;
    // per-org limit for this tier (deep scans are long: one org must not hold every scanner)
    const tierLimit = tier === "DEEPSCAN" ? orgLimits.deepscan.maxConcurrentScans : 1_000_000;
    const leaseMs = s["scheduler.leaseSec"] * 1000;
    const full = Number(await connection.eval(ACQUIRE, 3, ...semKeys(exec.org_id), Date.now(), key.id, Date.now() + leaseMs, orgLimit, policy.globalConcurrency, tierLimit));
    if (full) {
      // Back off without consuming an attempt; other tenants' jobs proceed meanwhile.
      await withSystem(db, (tx) => healthMetric(tx, "queue", full === 1 ? "org_concurrency_wait" : full === 2 ? "global_concurrency_wait" : "org_tier_concurrency_wait", 1, { queue: queueName }));
      await job.moveToDelayed(Date.now() + 500 + Math.floor(Math.random() * 1500), token);
      throw new DelayedError();
    }
    const release = () => Promise.all(semKeys(exec.org_id).map((k) => connection.zrem(k, key.id))).catch(() => undefined);

    // 6. Claim (attempt counter increases on re-runs). Fails if cancelled or claimed meanwhile.
    const [claimed] = await withSystem(db, (tx) => tx.$queryRaw<Array<{ attempt: number; started_at: Date; enqueued_at: Date | null }>>`
      UPDATE monitoring_executions
         SET status = 'RUNNING', worker_id = ${o.workerId}, started_at = now(), finished_at = NULL,
             lease_expires_at = now() + make_interval(secs => ${s["scheduler.leaseSec"]}),
             attempt = CASE WHEN status IN ('RETRYING', 'RUNNING') THEN attempt + 1 ELSE attempt END
       WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND cancel_requested_at IS NULL
         AND (status IN ('SCHEDULED', 'QUEUED', 'RETRYING') OR (status = 'RUNNING' AND lease_expires_at < now()))
      RETURNING attempt, started_at, enqueued_at`);
    if (!claimed) { await release(); return { duplicate: true }; }

    const ac = new AbortController();
    active.set(key.id, ac);
    const timeout = setTimeout(() => ac.abort(new Abort("TIMEOUT")), policy.timeoutMs);
    // Lease renewal doubles as the cancellation poll.
    const renew = setInterval(async () => {
      try {
        const [r] = await withSystem(db, (tx) => tx.$queryRaw<Array<{ cancel: boolean }>>`
          UPDATE monitoring_executions SET lease_expires_at = now() + make_interval(secs => ${s["scheduler.leaseSec"]})
           WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND status = 'RUNNING' AND worker_id = ${o.workerId}
          RETURNING cancel_requested_at IS NOT NULL AS cancel`);
        await connection.eval(ACQUIRE, 3, ...semKeys(exec.org_id), Date.now(), key.id, Date.now() + leaseMs, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        if (!r || r.cancel) ac.abort(new Abort("CANCELLED"));
      } catch { /* transient: the next renewal retries; the lease covers the gap */ }
    }, Math.max(1000, Math.min(5000, Math.floor(leaseMs / 3)))); // cancellation latency ≤ 5 s whatever the lease

    const started = Date.now();
    const waitMs = claimed.enqueued_at ? Math.max(0, claimed.started_at.getTime() - claimed.enqueued_at.getTime()) : 0;
    const usageKey = `exec.${tier.toLowerCase()}`;
    try {
      const abortable = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true }));
      const result = (await Promise.race([
        o.handler({ executionId: key.id, orgId: exec.org_id, websiteId: exec.website_id, tier, attempt: claimed.attempt, maxAttempts: job.opts.attempts ?? policy.attempts, windowStart: key.queuedAt, signal: ac.signal }),
        abortable,
      ])) as ExecutionResult | void;
      const duration = Date.now() - started;
      await withSystem(db, async (tx) => {
        const n = await tx.$executeRaw`
          UPDATE monitoring_executions SET status = 'SUCCEEDED', finished_at = now(), duration_ms = ${duration}, lease_expires_at = NULL,
                 summary = ${JSON.stringify(result?.summary ?? {})}::jsonb, failure_category = NULL, error_message = NULL
           WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND worker_id = ${o.workerId}`;
        // Phase 4H: account only if THIS worker still owned the execution (a lost lease means another worker took it
        // over and will account it) — otherwise a slow worker and its successor would both count the same execution.
        if (n === 1) await addUsage(tx, exec.org_id, { [`${usageKey}.ok`]: 1, [`${usageKey}.ms`]: duration, [`${usageKey}.wait_ms`]: waitMs, ...(result?.usage ?? {}) });
        else await healthMetric(tx, "queue", "lease_lost_on_success", 1, { queue: queueName });
      });
      stats.processed++; stats.lastJobAt = new Date();
      return { ok: true };
    } catch (e) {
      const duration = Date.now() - started;
      const err = e instanceof Abort ? e : (ac.signal.reason instanceof Abort ? ac.signal.reason : e);
      if (err instanceof Abort && err.reason === "SHUTDOWN") {
        // Hand the job back without consuming an attempt; another worker resumes it.
        await withSystem(db, (tx) => tx.$executeRaw`
          UPDATE monitoring_executions SET status = 'QUEUED', lease_expires_at = NULL, worker_id = NULL, error_message = 'worker shutdown'
           WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND worker_id = ${o.workerId}`);
        await job.moveToDelayed(Date.now() + 1000, token);
        throw new DelayedError();
      }
      if (err instanceof Abort && err.reason === "CANCELLED") {
        await withSystem(db, async (tx) => {
          const n = await tx.$executeRaw`
            UPDATE monitoring_executions SET status = 'CANCELLED', failure_category = 'CANCELLED', finished_at = now(), duration_ms = ${duration},
                   lease_expires_at = NULL, error_message = 'cancelled while running'
             WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND status <> 'CANCELLED'`;
          if (n === 1) await addUsage(tx, exec.org_id, { [`${usageKey}.cancelled`]: 1, [`${usageKey}.ms`]: duration });
        });
        stats.lastJobAt = new Date();
        return { cancelled: true };
      }
      const category: FailureCategory = err instanceof Abort ? "TIMEOUT" : categorize(err);
      const message = sanitizeError(err instanceof Error ? err.message : err);
      stats.failed++; stats.lastJobAt = new Date();
      if (category === "TIMEOUT") stats.timeouts++;
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const retry = (category === "TRANSIENT" || category === "TIMEOUT") && !finalAttempt;
      await withSystem(db, async (tx) => {
        await addUsage(tx, exec.org_id, { [`${usageKey}.ms`]: duration, [`${usageKey}.failed`]: 1, ...(retry ? { [`${usageKey}.retries`]: 1 } : {}) });
        // release readiness: timeout rate per queue (executions.timeouts rule)
        if (category === "TIMEOUT") await healthMetric(tx, "queue", "timeout", 1, { queue: queueName });
      });
      if (retry) {
        await withSystem(db, (tx) => tx.$executeRaw`
          UPDATE monitoring_executions SET status = 'RETRYING', failure_category = ${category}, error_message = ${message}, duration_ms = ${duration}, lease_expires_at = NULL
           WHERE id = ${key.id}::uuid AND queued_at = ${key.queuedAt} AND worker_id = ${o.workerId}`);
        // Redis only ever sees the category; the (sanitised) detail stays in PostgreSQL.
        throw new Error(category); // BullMQ retries with full-jitter backoff
      }
      await deadLetter(db, {
        executionId: key.id, queuedAt: key.queuedAt, orgId: exec.org_id, websiteId: exec.website_id, tier, queue: queueName,
        attempts: claimed.attempt, category, error: message,
      }, dlq);
      throw new UnrecoverableError(category);
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      active.delete(key.id);
      await release();
    }
  }

  let worker: Worker | null = null;
  function build(policy: QueuePolicy) {
    const w = new Worker(queueName, process, {
      connection, prefix: o.prefix, autorun: false, concurrency: policy.concurrency,
      // Per-queue rate limit shared by all workers of this queue (BullMQ global limiter).
      limiter: { max: policy.ratePerSecond, duration: 1000 },
      lockDuration: o.lockDurationMs ?? 30_000, stalledInterval: o.stalledIntervalMs ?? 30_000, maxStalledCount: 2,
      settings: { backoffStrategy: backoffStrategy(policy) },
    });
    w.on("failed", (job, err) => {
      if (err instanceof JobError) return;
      log.debug({ queue: queueName, jobId: job?.id, err: sanitizeError(err.message) }, "job failed");
    });
    w.on("error", (err) => log.warn({ queue: queueName, err: sanitizeError(err.message) }, "worker error"));
    return w;
  }

  const startedAt = new Date();
  const hb = createHeartbeat({ db, connection, log, workerId: o.workerId, kind: queueName, version: o.version, startedAt, probes: o.probes, meta: o.meta,
    gauges: () => ({ activeJobs: active.size, capacity: worker?.concurrency ?? 0, ...stats }) });
  const beat = hb.beat;
  let beatTimer: NodeJS.Timeout | undefined;

  return {
    get worker() { return worker; },
    activeCount: () => active.size,
    async start() {
      worker = build(policyFor(await settings(), queueName));
      await hb.started();
      await beat();
      beatTimer = setInterval(beat, o.heartbeatEveryMs ?? 10_000);
      void worker.run();
      await worker.waitUntilReady();
    },
    /** Graceful shutdown: stop taking jobs, hand in-flight work back (no attempt consumed), close. */
    async stop() {
      if (closing) return;
      closing = true;
      clearInterval(beatTimer);
      const closed = worker?.close() ?? Promise.resolve();
      for (const ac of active.values()) ac.abort(new Abort("SHUTDOWN"));
      await closed;
      await dlq.close();
      await withSystem(db, (tx) => tx.workerHeartbeat.deleteMany({ where: { workerId: o.workerId } })).catch(() => undefined);
    },
  };
}
