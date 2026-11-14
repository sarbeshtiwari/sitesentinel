import { readFileSync } from "node:fs";
import { Redis } from "ioredis";
import { z } from "zod";
import { assertDatabaseRole, createDb, loadSettings, withSystem, type Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker, policyFor, QUEUES, recordMaintenance } from "@wim/queue";
import { createDeepScanEngine } from "./engine.js";

export { createDeepScanEngine, SCANNER_AGENT } from "./engine.js";
export { analyzeHtml, parseSitemap } from "./html.js";

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  /** the narrow wim_scanner role (sql/110): never the broad worker role */
  SCANNER_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("wim"),
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  EGRESS_GATEWAY_URL: z.url(),
  EGRESS_TOKEN_SECRET: z.string().min(32),
  /** only for browser-assisted discovery (off unless entitled and enabled) */
  BROWSER_RUNNER_URL: z.url().optional(),
  /** test-only: trust the controlled fixture's private CA (refused unless NODE_ENV=test, like worker-http) */
  DEEPSCAN_TEST_CA_FILE: z.string().optional(),
});

/** Retention: scans (and their frontier) older than the retention period, and long-resolved findings. One instance at a time. */
export async function deepScanRetention(db: Db, retentionDays: number): Promise<{ scans: number; findings: number }> {
  return withSystem(db, async (tx) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('wim.deepscan-retention')) AS locked`;
    if (!locked) return { scans: 0, findings: 0 };
    const scans = await tx.$executeRaw`DELETE FROM deep_scans WHERE status <> 'RUNNING' AND started_at < now() - make_interval(days => ${retentionDays})`;
    const findings = await tx.$executeRaw`DELETE FROM scan_findings WHERE status = 'RESOLVED' AND resolved_at < now() - make_interval(days => ${retentionDays})`;
    await tx.$executeRaw`DELETE FROM scan_finding_events e WHERE NOT EXISTS (SELECT 1 FROM scan_findings f WHERE f.id = e.finding_id)`;
    return { scans, findings };
  });
}

export interface RunningDeepScanWorker { stop(): Promise<void> }

export async function startDeepScanWorker(source: NodeJS.ProcessEnv = process.env): Promise<RunningDeepScanWorker> {
  const env = Env.parse(source);
  if (env.DEEPSCAN_TEST_CA_FILE && env.NODE_ENV !== "test") throw new Error("DEEPSCAN_TEST_CA_FILE is only permitted when NODE_ENV=test");
  const log = createLogger("worker-deepscan");
  const db = createDb({ url: env.SCANNER_DATABASE_URL, max: 8, omitSecrets: true });
  // release readiness (blocker 6): the scanner credentials must be the least-privilege scanner role, never development
  // credentials in production, and TLS to the database in production
  await assertDatabaseRole(db, "wim_scanner", { production: env.NODE_ENV === "production", log, url: env.SCANNER_DATABASE_URL });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = createExecutionWorker({
    db, connection, prefix: env.QUEUE_PREFIX, tier: "DEEPSCAN", log, workerId: env.WORKER_ID ?? `worker-deepscan-${process.pid}`,
    probes: { gateway: () => httpHealth(env.EGRESS_GATEWAY_URL), ...(env.BROWSER_RUNNER_URL ? { runner: () => httpHealth(env.BROWSER_RUNNER_URL!) } : {}) },
    handler: createDeepScanEngine({
      db, redis: connection, log, gatewayUrl: env.EGRESS_GATEWAY_URL, tokenSecret: env.EGRESS_TOKEN_SECRET, runnerUrl: env.BROWSER_RUNNER_URL ?? null,
      testCa: env.DEEPSCAN_TEST_CA_FILE ? readFileSync(env.DEEPSCAN_TEST_CA_FILE, "utf8") : undefined,
      jobTimeoutMs: async () => policyFor(await loadSettings(db), QUEUES.deepscan).timeoutMs,
    }),
  });
  await worker.start();
  const retention = setInterval(() => void loadSettings(db).then((s) => deepScanRetention(db, s["monitoring.deepscan.retentionDays"]))
    .then(() => recordMaintenance(db, "deepscan_retention", true))
    .catch(() => recordMaintenance(db, "deepscan_retention", false)), 3_600_000);
  return {
    async stop() {
      clearInterval(retention);
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
