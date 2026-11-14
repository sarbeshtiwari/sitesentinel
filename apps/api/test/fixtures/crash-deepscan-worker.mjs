// Phase 4E crash test: the real deep-scan engine (as wim_scanner) through the 4B runtime; SIGKILLs itself after
// CRASH_AFTER_PAGES pages have been committed, mid-scan.
import { Redis } from "ioredis";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";
import { createDeepScanEngine } from "@wim/worker-deepscan";

const db = createDb({ url: process.env.SCANNER_DATABASE_URL, max: 3, omitSecrets: true });
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const log = createLogger("crash-deepscan-worker", { level: "silent" });
const after = Number(process.env.CRASH_AFTER_PAGES ?? 3);
const w = createExecutionWorker({
  db, connection, prefix: process.env.TEST_PREFIX, tier: "DEEPSCAN", workerId: "doomed-deepscan-worker", log,
  lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
  handler: createDeepScanEngine({
    db, redis: connection, log, gatewayUrl: process.env.TEST_GATEWAY_URL, tokenSecret: process.env.TEST_EGRESS_SECRET, runnerUrl: null,
    jobTimeoutMs: async () => 180_000,
    hooks: { afterPage: async (_e, n) => { if (n >= after) { process.stdout.write(`CRASHING after ${n} pages\n`); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); } } },
  }),
});
await w.start();
process.stdout.write("READY\n");
