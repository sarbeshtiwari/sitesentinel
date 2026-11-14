// Phase 4B operational check: consumes an execution queue with a SYNTHETIC handler (no network
// calls). Real engines attach in 4C/4D/4E. Refuses to run in production.
//   SYNTHETIC_FAIL=transient|permanent  make every execution fail (dead-letter demonstration)
//   SYNTHETIC_HANG=1                    never finish (crash/shutdown demonstration)
import { Redis } from "ioredis";
import { createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker, PermanentError, TransientError } from "@wim/queue";

if (process.env.NODE_ENV === "production") throw new Error("synthetic worker is not allowed in production");
const log = createLogger("synthetic-worker", { level: process.env.LOG_LEVEL ?? "info" });
const db = createDb({ url: process.env.WORKER_DATABASE_URL, max: 4, omitSecrets: true });
const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const w = createExecutionWorker({
  db, connection, prefix: process.env.QUEUE_PREFIX ?? "wim", tier: process.env.TIER ?? "HTTP",
  workerId: process.env.WORKER_ID ?? `synthetic-${process.pid}`, log,
  lockDurationMs: 10_000, stalledIntervalMs: 5_000,
  handler: async (ctx) => {
    log.info({ execution: ctx.executionId, attempt: ctx.attempt }, "executing (synthetic)");
    if (process.env.SYNTHETIC_HANG) await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (process.env.SYNTHETIC_FAIL === "transient") throw new TransientError("synthetic upstream reset");
    if (process.env.SYNTHETIC_FAIL === "permanent") throw new PermanentError("synthetic invalid configuration");
    await new Promise((r) => setTimeout(r, 50));
    return { summary: { synthetic: true } };
  },
});
await w.start();
log.info("synthetic worker consuming");
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => void w.stop().then(() => { log.info("stopped gracefully"); process.exit(0); }));
