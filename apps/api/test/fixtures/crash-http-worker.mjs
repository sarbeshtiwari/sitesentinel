// Child process for Phase 4C crash tests: the real HTTP engine through the 4B runtime, which
// SIGKILLs itself at a chosen point (CRASH_AT=probe → after the HTTP request, before persistence;
// CRASH_AT=persist → after the result transaction committed, before the queue acknowledgement).
import { Redis } from "ioredis";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";
import { createHttpEngine } from "@wim/worker-http";

const db = createDb({ url: process.env.WORKER_DATABASE_URL, max: 3, omitSecrets: true });
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const log = createLogger("crash-http-worker", { level: "silent" });
const die = (at) => async () => {
  if (process.env.CRASH_AT !== at) return;
  process.stdout.write(`CRASHING ${at}\n`);
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
};
const w = createExecutionWorker({
  db, connection, prefix: process.env.TEST_PREFIX, tier: "HTTP", workerId: "doomed-http-worker", log,
  lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
  handler: createHttpEngine({
    db, redis: connection, prefix: process.env.TEST_PREFIX, log, gatewayUrl: process.env.TEST_GATEWAY_URL, tokenSecret: process.env.TEST_EGRESS_SECRET,
    testCa: process.env.TEST_CA_PEM, hooks: { afterProbe: die("probe"), afterPersist: die("persist") },
  }),
});
await w.start();
process.stdout.write("READY\n");
