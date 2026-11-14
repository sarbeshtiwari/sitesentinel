import { Redis } from "ioredis";
import { z } from "zod";
import { assertDatabaseRole, createDb, loadSettings, withSystem, type Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker, policyFor, QUEUES, recordMaintenance } from "@wim/queue";
import { createS3, type S3 } from "@wim/storage";
import { createBrowserEngine } from "./engine.js";

export { createBrowserEngine } from "./engine.js";
export { chromiumNavError, observeViewport } from "./observe.js";
export { openSession } from "./session.js";
export { artifactKey } from "./artifacts.js";

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  /** release readiness (blocker 3): the least-privilege browser role; WORKER_DATABASE_URL is refused in production */
  BROWSER_DATABASE_URL: z.string().min(1).optional(),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("wim"),
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  /** egress gateway (the runner's Chromium uses it; the worker uses it only to classify tunnel failures) */
  EGRESS_GATEWAY_URL: z.url(),
  EGRESS_TOKEN_SECRET: z.string().min(32),
  /** browser runner control API, reachable only on the browser-control network */
  BROWSER_RUNNER_URL: z.url(),
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET_ARTIFACTS: z.string().default("wim-artifacts"),
});

/** Delete expired screenshots (object first, then the row); one instance at a time. */
export async function cleanupArtifacts(db: Db, s3: S3, limit = 200): Promise<number> {
  const rows = await withSystem(db, async (tx) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.artifact-cleanup')) AS locked`;
    if (!locked) return [];
    return tx.$queryRaw<Array<{ id: string; storage_key: string }>>`SELECT id, storage_key FROM artifacts WHERE expires_at < now() ORDER BY expires_at LIMIT ${limit}`;
  });
  let n = 0;
  for (const r of rows) {
    try {
      await s3.delete(r.storage_key);
      await withSystem(db, (tx) => tx.$executeRaw`DELETE FROM artifacts WHERE id = ${r.id}::uuid`);
      n++;
    } catch { /* storage down: retried next round */ }
  }
  return n;
}

export interface RunningBrowserWorker { stop(): Promise<void> }

export async function startBrowserWorker(source: NodeJS.ProcessEnv = process.env): Promise<RunningBrowserWorker> {
  const env = Env.parse(source);
  const log = createLogger("worker-browser");
  const url = env.BROWSER_DATABASE_URL ?? (env.NODE_ENV === "production" ? undefined : env.WORKER_DATABASE_URL);
  if (!url) throw new Error("BROWSER_DATABASE_URL is required (the broad worker role is not accepted in production)");
  const db = createDb({ url, max: 12, omitSecrets: true });
  await assertDatabaseRole(db, "wim_browser", { production: env.NODE_ENV === "production", log, url });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const s3 = env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
    ? createS3({ endpoint: env.S3_ENDPOINT, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET_ARTIFACTS })
    : null;
  if (s3) await s3.ensureBucket().catch((e) => log.warn({ err: (e as Error).message }, "artifact bucket not ready; screenshots will be skipped until storage is reachable"));
  else log.warn("object storage not configured: screenshots disabled");
  const worker = createExecutionWorker({
    db, connection, prefix: env.QUEUE_PREFIX, tier: "BROWSER", log, workerId: env.WORKER_ID ?? `worker-browser-${process.pid}`,
    probes: { gateway: () => httpHealth(env.EGRESS_GATEWAY_URL), runner: () => httpHealth(env.BROWSER_RUNNER_URL), ...(s3 ? { storage: () => s3.ping() } : {}) },
    meta: async () => {
      const r = (await (await fetch(new URL("/health", env.BROWSER_RUNNER_URL), { signal: AbortSignal.timeout(3000) })).json()) as { sessions?: number; maxSessions?: number; killedByTimeout?: number; sandbox?: boolean };
      return { runnerSessions: r.sessions ?? 0, runnerMaxSessions: r.maxSessions ?? 0, runnerKilledByTimeout: r.killedByTimeout ?? 0, runnerSandbox: r.sandbox ?? false };
    },
    handler: createBrowserEngine({
      db, redis: connection, prefix: env.QUEUE_PREFIX, log, gatewayUrl: env.EGRESS_GATEWAY_URL, tokenSecret: env.EGRESS_TOKEN_SECRET,
      runnerUrl: env.BROWSER_RUNNER_URL, s3, jobTimeoutMs: async () => policyFor(await loadSettings(db), QUEUES.browser).timeoutMs,
    }),
  });
  await worker.start();
  // release readiness: cleanup outcomes are recorded (cleanup.failing rule), not swallowed
  const cleanup = s3 ? setInterval(() => void cleanupArtifacts(db, s3)
    .then(() => recordMaintenance(db, "artifact_cleanup", true))
    .catch(() => recordMaintenance(db, "artifact_cleanup", false)), 10 * 60_000) : undefined;
  return {
    async stop() {
      clearInterval(cleanup);
      await worker.stop();
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
