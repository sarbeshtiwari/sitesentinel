// Phase 4D crash tests: the real browser engine through the 4B runtime, SIGKILLing itself either after the
// browser work and before persistence (CRASH_AT=navigate) or after the result commit, before the queue ack (CRASH_AT=persist).
import { Redis } from "ioredis";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";
import { createS3 } from "@wim/storage";
import { createBrowserEngine } from "@wim/worker-browser";

const db = createDb({ url: process.env.WORKER_DATABASE_URL, max: 3, omitSecrets: true });
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const log = createLogger("crash-browser-worker", { level: "silent" });
const die = (at) => async () => {
  if (process.env.CRASH_AT !== at) return;
  process.stdout.write(`CRASHING ${at}\n`);
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
};
const s3 = createS3({ endpoint: process.env.S3_ENDPOINT, accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY, bucket: process.env.TEST_BUCKET });
const w = createExecutionWorker({
  db, connection, prefix: process.env.TEST_PREFIX, tier: "BROWSER", workerId: "doomed-browser-worker", log,
  lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
  handler: createBrowserEngine({
    db, redis: connection, prefix: process.env.TEST_PREFIX, log, gatewayUrl: process.env.TEST_GATEWAY_URL, tokenSecret: process.env.TEST_EGRESS_SECRET,
    runnerUrl: process.env.TEST_RUNNER_URL, s3, jobTimeoutMs: async () => 45_000, hooks: { afterNavigate: die("navigate"), afterPersist: die("persist") },
  }),
});
await w.start();
process.stdout.write("READY\n");
