// Child process for the worker-crash test: consumes http-monitoring with a handler that
// never finishes, so the parent can SIGKILL it mid-execution.
import { Redis } from "ioredis";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";

const db = createDb({ url: process.env.WORKER_DATABASE_URL, max: 3, omitSecrets: true });
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const w = createExecutionWorker({
  db, connection, prefix: process.env.TEST_PREFIX, tier: "HTTP", workerId: process.env.TEST_WORKER_ID,
  log: createLogger("crash-worker", { level: "silent" }),
  lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
  handler: async () => { process.stdout.write("RUNNING\n"); await new Promise(() => {}); },
});
await w.start();
process.stdout.write("READY\n");
