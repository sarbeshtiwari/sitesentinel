import { hostname } from "node:os";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { createDb, withSystem } from "@wim/db";
import { createHeartbeat, DbOutageWatch, QUEUES, relayOutbox, runPlatformEvaluation, sanitizeError } from "@wim/queue";
import { EMAIL_QUEUE } from "@wim/contracts";
import { createEmailProvider } from "@wim/email";
import { createLogger } from "@wim/logger";
import { createEmailProcessor, PermanentJobError } from "./processor.js";

export { createEmailProcessor, PermanentJobError } from "./processor.js";

const WorkerEnv = z.object({
  WORKER_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("wim"),
  APP_URL: z.url().default("http://localhost:3000"),
  EMAIL_FROM_DOMAIN: z.string().default("localhost"),
  EMAIL_FROM_LOCAL_PART: z.string().default("no-reply"),
  EMAIL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** Phase 4H */
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  ADMIN_URL: z.url().default("http://localhost:3001"),
  /** comma-separated; used only when PostgreSQL is unavailable (alert recipients normally come from the database) */
  OPS_FALLBACK_ALERT_EMAILS: z.string().default("").transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.email())),
  /** watchdog: this worker also evaluates platform health when the scheduler has not (detects a dead scheduler) */
  OPS_WATCHDOG: z.enum(["on", "off"]).default("on"),
  OPS_WATCHDOG_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

/** Start the email worker. Returns a stop function (used for graceful shutdown and tests). */
export function startEmailWorker(source: NodeJS.ProcessEnv = process.env) {
  const env = WorkerEnv.parse(source);
  const log = createLogger("worker-notify");
  // release readiness: in production, a PostgreSQL outage must still reach a human — refuse to start without recipients
  if (source.NODE_ENV === "production" && env.OPS_WATCHDOG === "on" && !env.OPS_FALLBACK_ALERT_EMAILS.length) {
    throw new Error("OPS_FALLBACK_ALERT_EMAILS is required in production (direct alert recipients while PostgreSQL is unavailable)");
  }
  // Connects as wim_worker: RLS applies; cross-tenant reads only inside withSystem().
  const db = createDb({ url: env.WORKER_DATABASE_URL, max: env.EMAIL_WORKER_CONCURRENCY + 1, omitSecrets: true });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const process = createEmailProcessor({
    db, provider: createEmailProvider(source), log,
    appUrl: env.APP_URL, fromDomain: env.EMAIL_FROM_DOMAIN, fromLocalPart: env.EMAIL_FROM_LOCAL_PART,
    adminUrl: env.ADMIN_URL, fallbackAlertEmails: env.OPS_FALLBACK_ALERT_EMAILS,
  });
  const workerId = env.WORKER_ID ?? `worker-notify-${hostname()}-${globalThis.process.pid}`;
  const stats = { processed: 0, failed: 0, timeouts: 0, lastJobAt: null as Date | null };
  let active = 0;
  const worker = new Worker(
    EMAIL_QUEUE,
    async (job) => {
      active++;
      try {
        const r = await process(job.data, job.id ?? job.name);
        stats.processed++;
        return r;
      } catch (e) {
        stats.failed++;
        if (e instanceof PermanentJobError) throw new UnrecoverableError(e.message);
        throw e;
      } finally {
        active--;
        stats.lastJobAt = new Date();
      }
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: env.EMAIL_WORKER_CONCURRENCY },
  );
  worker.on("completed", (job, result) => log.info({ jobId: job.id, kind: job.name, result }, "email job completed"));
  worker.on("failed", (job, err) => {
    log.warn({ jobId: job?.id, kind: job?.name, attempts: job?.attemptsMade, err: err.message }, "email job failed");
    // Phase 4H: a notification that exhausted its retries is dead-lettered durably (visible in Super Admin), never lost
    const exhausted = job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1));
    if (!exhausted) return;
    void withSystem(db, async (tx) => {
      await tx.jobFailure.create({ data: { queue: EMAIL_QUEUE, jobId: String(job.id ?? job.name), payload: { kind: job.name }, error: sanitizeError(err.message), attempts: job.attemptsMade, jobType: `EMAIL:${job.name}`, failureCategory: err instanceof UnrecoverableError ? "PERMANENT" : "TRANSIENT" } });
      await tx.systemHealthLog.create({ data: { component: "queue", metric: "dead_letter", value: 1, labels: { queue: EMAIL_QUEUE } } });
    }).catch((e) => log.error({ err: sanitizeError((e as Error).message) }, "could not record dead-lettered notification"));
  });

  // Phase 4H: heartbeat (alive, processing, SMTP reachability) and the platform-health watchdog
  const provider = createEmailProvider(source);
  const hb = createHeartbeat({ db, connection, log, workerId, kind: "email", gauges: () => ({ activeJobs: active, capacity: env.EMAIL_WORKER_CONCURRENCY, ...stats }),
    probes: provider.verify ? { smtp: () => provider.verify!() } : undefined });
  void hb.started();
  void hb.beat();
  const beatTimer = setInterval(() => void hb.beat(), 10_000);
  const opsQueues = Object.fromEntries([QUEUES.http, QUEUES.browser, QUEUES.deepscan, EMAIL_QUEUE].map((n) => [n, new Queue(n, { connection, prefix: env.QUEUE_PREFIX })]));
  const emailQueue = opsQueues[EMAIL_QUEUE]!;
  const outage = new DbOutageWatch({ emailQueue, log, evaluatorId: workerId });
  let watchdog: NodeJS.Timeout | undefined;
  if (env.OPS_WATCHDOG === "on") {
    watchdog = setInterval(() => {
      // claims only when nobody (normally the scheduler) evaluated for 2.5 intervals → a dead scheduler is still detected
      void runPlatformEvaluation({ db, connection, queues: opsQueues, evaluatorId: workerId, log, prefix: env.QUEUE_PREFIX }, { graceFactor: 2.5 })
        .then(async (r) => {
          await outage.succeeded(db);
          // the watchdog only evaluates when the scheduler is not doing so — then nobody else relays the outbox:
          // relay platform alerts (and any other pending notices) itself so the alert about the scheduler is delivered
          if (r.ran) await relayOutbox(db, emailQueue);
        })
        .catch((e) => outage.failed(e));
    }, env.OPS_WATCHDOG_MS);
  }

  return {
    worker,
    async stop() {
      clearInterval(beatTimer);
      clearInterval(watchdog);
      await worker.close();
      await Promise.all(Object.values(opsQueues).map((q) => q.close()));
      await hb.remove();
      connection.disconnect();
      await db.$disconnect();
    },
  };
}
