import { Queue, UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { createDb } from "@wim/db";
import { EMAIL_QUEUE, REVALIDATE_QUEUE, RevalidateJob, VERIFY_QUEUE, VerifyJob, type EmailJob } from "@wim/contracts";
import { createLogger } from "@wim/logger";
import { createDnsClient, createGatewayDnsClient, signCapability } from "@wim/netguard";
import type { CheckContext } from "./checks.js";
import { createVerifyProcessor } from "./processor.js";
import { createRevalidationProcessor } from "./revalidation.js";
import { readFileSync } from "node:fs";
import { createExecutionWorker } from "@wim/queue";
import { createHttpEngine } from "./monitor/engine.js";

export { createVerifyProcessor } from "./processor.js";
export { createRevalidationProcessor, policyFrom } from "./revalidation.js";
export * from "./checks.js";
export { createHttpEngine } from "./monitor/engine.js";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const Env = z.object({
  NODE_ENV: z.string().default("development"),
  WORKER_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("wim"),
  SDK_URL: z.url().default("http://localhost:4200/sdk"),
  /** Resolvers used for every outbound lookup (comma-separated host[:port]). */
  DNS_RESOLVERS: z.string().default("1.1.1.1,8.8.8.8"),
  VERIFY_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  REVALIDATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** Max revalidation checks started per second across ALL workers (BullMQ global limiter). */
  REVALIDATION_RATE_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(5),
  REVALIDATION_SWEEP_EVERY_MS: z.coerce.number().int().min(1000).default(60_000),
  /** TEST ONLY. Refused unless NODE_ENV=test. */
  NETGUARD_ALLOW_LOOPBACK_FOR_TESTS: bool.default(false),
  NETGUARD_LOOPBACK_PORT_FOR_TESTS: z.coerce.number().int().optional(),
  /** Egress gateway (apps/egress-gateway). Mandatory in production: the worker has no internet route. */
  EGRESS_GATEWAY_URL: z.url().optional(),
  EGRESS_TOKEN_SECRET: z.string().min(32).optional(),
  /** Phase 4C: consume http-monitoring (requires the gateway; there is no direct mode). */
  HTTP_MONITORING_CONSUMER: bool.default(true),
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  /** TEST ONLY: CA of the fixture PKI. Refused unless NODE_ENV=test. */
  HTTP_MONITOR_TEST_CA_FILE: z.string().optional(),
});

export function startVerifyWorker(source: NodeJS.ProcessEnv = process.env) {
  const env = Env.parse(source);
  if (env.NETGUARD_ALLOW_LOOPBACK_FOR_TESTS && env.NODE_ENV !== "test") {
    throw new Error("NETGUARD_ALLOW_LOOPBACK_FOR_TESTS is only permitted when NODE_ENV=test");
  }
  if (env.NODE_ENV === "production" && /^https?:\/\/(localhost|127\.)/.test(env.SDK_URL)) {
    throw new Error("SDK_URL must be the public script address in production (the installation check looks for that tag)");
  }
  if (env.NODE_ENV === "production" && (!env.EGRESS_GATEWAY_URL || !env.EGRESS_TOKEN_SECRET)) {
    throw new Error("EGRESS_GATEWAY_URL and EGRESS_TOKEN_SECRET are mandatory in production (fail closed)");
  }
  if (env.EGRESS_GATEWAY_URL && env.NETGUARD_ALLOW_LOOPBACK_FOR_TESTS) {
    throw new Error("Loopback allowance is meaningless with the egress gateway; configure test allowances on the gateway");
  }
  if (env.HTTP_MONITOR_TEST_CA_FILE && env.NODE_ENV !== "test") throw new Error("HTTP_MONITOR_TEST_CA_FILE is only permitted when NODE_ENV=test");
  const log = createLogger("worker-http");
  const db = createDb({ url: env.WORKER_DATABASE_URL, max: env.VERIFY_WORKER_CONCURRENCY + env.REVALIDATION_CONCURRENCY + 24, omitSecrets: true });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const emailQueue = new Queue<EmailJob>(EMAIL_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  const verifyQueue = new Queue(VERIFY_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  const directCtx: CheckContext = {
    dns: createDnsClient(env.DNS_RESOLVERS.split(",").map((s) => s.trim()).filter(Boolean)),
    policy: { allowLoopbackForTests: env.NETGUARD_ALLOW_LOOPBACK_FOR_TESTS, loopbackPortForTests: env.NETGUARD_LOOPBACK_PORT_FOR_TESTS },
    normalize: {},
  };
  // With the gateway, every lookup and connection carries a capability token bound to the job.
  const ctxFor = env.EGRESS_GATEWAY_URL && env.EGRESS_TOKEN_SECRET
    ? (cap: { o: string | null; w: string | null; e: string; k: string }): CheckContext => {
        const token = () => signCapability(env.EGRESS_TOKEN_SECRET!, cap, 300);
        return { ...directCtx, dns: createGatewayDnsClient({ url: env.EGRESS_GATEWAY_URL!, token }), egress: { url: env.EGRESS_GATEWAY_URL!, token } };
      }
    : undefined;
  if (!ctxFor) log.warn("egress gateway not configured: outbound checks connect directly (development only)");
  const process = createVerifyProcessor({
    db, log, sdkUrl: env.SDK_URL, ctxFor,
    ctx: ctxFor ? ctxFor({ o: null, w: null, e: "worker", k: "verify" }) : directCtx,
    enqueueEmail: async (job, id) => {
      await emailQueue.add(job.kind, job, { jobId: id.replaceAll(":", "."), attempts: 6, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: { age: 86_400 } });
    },
  });
  const worker = new Worker(
    VERIFY_QUEUE,
    async (job) => {
      const parsed = VerifyJob.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError("invalid job payload");
      return process(parsed.data);
    },
    // Verification is user-visible; one attempt per job (the user retries), except infrastructure errors.
    { connection, prefix: env.QUEUE_PREFIX, concurrency: env.VERIFY_WORKER_CONCURRENCY },
  );
  worker.on("failed", (job, err) => log.warn({ jobId: job?.id, kind: job?.name, err: err.message }, "verify job failed"));

  // ---- ownership revalidation: its own queue, global rate limit, periodic sweep
  const revalidateQueue = new Queue(REVALIDATE_QUEUE, { connection, prefix: env.QUEUE_PREFIX });
  const fallbackCtx = ctxFor ?? (() => directCtx);
  const revalidate = createRevalidationProcessor({
    db, redis: connection, log, ctxFor: fallbackCtx,
    enqueue: async (job, jobId) => { await revalidateQueue.add(job.kind, job, { jobId, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 7 * 86_400 }, attempts: 2, backoff: { type: "exponential", delay: 60_000 } }); },
    enqueueEmail: async (job, id) => { await emailQueue.add(job.kind, job, { jobId: id.replaceAll(":", "."), attempts: 6, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: { age: 86_400 } }); },
  });
  const revalidationWorker = new Worker(
    REVALIDATE_QUEUE,
    async (job) => {
      const parsed = RevalidateJob.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError("invalid job payload");
      return revalidate(parsed.data);
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: env.REVALIDATION_CONCURRENCY, limiter: { max: env.REVALIDATION_RATE_PER_SECOND, duration: 1000 } },
  );
  revalidationWorker.on("failed", (job, err) => log.warn({ jobId: job?.id, err: err.message }, "revalidation job failed"));
  void revalidateQueue.upsertJobScheduler("sweep-revalidation", { every: env.REVALIDATION_SWEEP_EVERY_MS }, { name: "SWEEP_REVALIDATION", data: { kind: "SWEEP_REVALIDATION" } });
  // Expire stale unverified claims every 10 minutes (system job; claims also expire lazily on access).
  void verifyQueue.upsertJobScheduler("sweep-claims", { every: 600_000 }, { name: "SWEEP_CLAIMS", data: { kind: "SWEEP_CLAIMS" } });

  // ---- Phase 4C: HTTP availability monitoring (consumes only through the 4B runtime, egresses only through the gateway)
  let monitor: ReturnType<typeof createExecutionWorker> | null = null;
  if (env.HTTP_MONITORING_CONSUMER && env.EGRESS_GATEWAY_URL && env.EGRESS_TOKEN_SECRET) {
    const monitorConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    monitor = createExecutionWorker({
      db, connection: monitorConn, prefix: env.QUEUE_PREFIX, tier: "HTTP", log, workerId: env.WORKER_ID ?? `worker-http-${globalThis.process.pid}`,
      probes: { gateway: () => httpHealth(env.EGRESS_GATEWAY_URL!) },
      handler: createHttpEngine({
        db, redis: monitorConn, prefix: env.QUEUE_PREFIX, log, gatewayUrl: env.EGRESS_GATEWAY_URL, tokenSecret: env.EGRESS_TOKEN_SECRET,
        testCa: env.HTTP_MONITOR_TEST_CA_FILE ? readFileSync(env.HTTP_MONITOR_TEST_CA_FILE, "utf8") : undefined,
      }),
    });
    void monitor.start().catch((e) => log.error({ err: (e as Error).message }, "http monitoring consumer failed to start"));
    const stopMonitor = monitor.stop.bind(monitor);
    monitor.stop = async () => { await stopMonitor(); monitorConn.disconnect(); };
  } else if (env.HTTP_MONITORING_CONSUMER) {
    log.warn("http monitoring consumer not started: the egress gateway is not configured (no direct mode exists)");
  }

  return {
    worker,
    revalidationWorker,
    monitor,
    async stop() {
      await monitor?.stop();
      await revalidationWorker.close();
      await revalidateQueue.close();
      await worker.close();
      await emailQueue.close();
      await verifyQueue.close();
      connection.disconnect();
      await db.$disconnect();
    },
  };
}

/** Phase 4H: GET <base>/health within 3 s (gateway / runner liveness; no credentials sent, no customer data). */
async function httpHealth(base: string) {
  const r = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`health ${r.status}`);
  await r.arrayBuffer();
}
