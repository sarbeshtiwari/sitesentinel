import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { BrowserRunner } from "@wim/browser-runner";
import { createExecutionWorker } from "@wim/queue";
import { createS3, type S3 } from "@wim/storage";
import { createBrowserEngine } from "@wim/worker-browser";
import { createLogger } from "@wim/logger";
import { createDb } from "@wim/db";
import { EGRESS_SECRET_4C, PREFIX_4C, startHttpEnv, type HttpEnv } from "./http-monitoring.js";
import { setSettings } from "./monitoring.js";

/**
 * Phase 4D test environment = the 4C environment (Postgres, Redis, gateway, fixture DNS, controlled fault
 * site) + a REAL Chromium driven through the production runner service (in-process here; the container
 * topology is proven by infra/security/run-isolation-tests.sh and the Docker operational run) + real S3.
 */
export const S3_TEST_BUCKET = "wim-artifacts-test";
export const BROWSER_QUEUE_POLICY = { concurrency: 2, globalConcurrency: 20, ratePerSecond: 100, attempts: 2, backoffBaseMs: 200, backoffMaxMs: 1000, timeoutMs: 45_000, keepCompletedHours: 1, keepFailedDays: 1 };

export interface BrowserEnv extends HttpEnv {
  runner: BrowserRunner;
  runnerUrl: string;
  s3: S3;
  startBrowserWorker(opts?: { runnerUrl?: string; s3?: S3 | null; workerId?: string; jobTimeoutMs?: number; hooks?: Parameters<typeof createBrowserEngine>[0]["hooks"] }): Promise<ReturnType<typeof createExecutionWorker>>;
  stopBrowserWorkers(): Promise<void>;
}

export async function startBrowserEnv(): Promise<BrowserEnv> {
  const base = await startHttpEnv();
  const runner = new BrowserRunner({ gatewayUrl: base.gatewayUrl, advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", maxSessions: 4, maxSessionMs: 120_000, sandbox: true });
  const runnerUrl = `http://127.0.0.1:${await runner.listen(0)}`;
  const s3 = createS3({ endpoint: process.env.S3_ENDPOINT!, accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, bucket: S3_TEST_BUCKET });
  await s3.ensureBucket();
  const log = createLogger("4d-test", { level: "silent" });
  // release readiness (blocker 3): browser workers run as the least-privilege wim_browser role, exactly like production
  const browserDb = createDb({ url: process.env.BROWSER_DATABASE_URL!, max: 12, omitSecrets: true });
  let workers: Array<{ stop(): Promise<void> }> = [];
  const env: BrowserEnv = {
    ...base, runner, runnerUrl, s3,
    async startBrowserWorker(opts = {}) {
      const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const w = createExecutionWorker({
        db: browserDb, connection: conn, prefix: PREFIX_4C, tier: "BROWSER", log, workerId: opts.workerId ?? `browser-${randomBytes(3).toString("hex")}`,
        lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
        handler: createBrowserEngine({
          db: browserDb, redis: conn, prefix: PREFIX_4C, log, gatewayUrl: base.gatewayUrl, tokenSecret: EGRESS_SECRET_4C,
          runnerUrl: opts.runnerUrl ?? runnerUrl, s3: opts.s3 === undefined ? s3 : opts.s3, jobTimeoutMs: async () => opts.jobTimeoutMs ?? BROWSER_QUEUE_POLICY.timeoutMs, hooks: opts.hooks,
        }),
      });
      await w.start();
      workers.push({ async stop() { await w.stop(); conn.disconnect(); } });
      return w;
    },
    async stopBrowserWorkers() {
      const all = workers;
      workers = [];
      for (const w of all) await w.stop().catch(() => undefined);
    },
    async close() {
      for (const w of workers) await w.stop().catch(() => undefined);
      await runner.stop();
      await browserDb.$disconnect();
      await base.close();
    },
  };
  return env;
}

export const BROWSER_TEST_SETTINGS = {
  "monitoring.browser.enabled": true,
  "monitoring.browser.failureThreshold": 2,
  "monitoring.browser.recoveryThreshold": 2,
  "monitoring.browser.maxWebsites": 100,
  "monitoring.browser.maxViewportsPerRun": 2,
  "queue.browser-monitoring": BROWSER_QUEUE_POLICY,
  // the fair-share quota (10/org/cycle) would otherwise spread one test tenant's 27 websites over several cycles
  "monitoring.limits.perCycleQuota": 100,
  "monitoring.limits.maxWebsites": 100,
  "monitoring.limits.maxOutstandingJobs": 1000,
  "scheduler.leaseSec": 10,
};

export async function entitleBrowser(env: HttpEnv, orgId: string, entitled = true) {
  await env.owner.query(`DELETE FROM entitlement_overrides WHERE org_id = $1 AND key = 'monitoring.browser.entitled'`, [orgId]);
  await env.owner.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.browser.entitled', $2::jsonb, 'test', gen_random_uuid())`, [orgId, JSON.stringify(entitled)]);
}

export const browserSettings = (env: HttpEnv, extra: Record<string, unknown> = {}) => setSettings(env.owner, { ...BROWSER_TEST_SETTINGS, ...extra });

export async function browserResults(env: HttpEnv, websiteId: string) {
  const { rows } = await env.owner.query(`SELECT * FROM page_test_results WHERE website_id = $1 ORDER BY finished_at, viewport`, [websiteId]);
  return rows as Array<Record<string, any>>;
}

export async function ledger(env: HttpEnv, websiteId: string, tier = "T2_RENDER") {
  const { rows } = await env.owner.query(`SELECT * FROM execution_results WHERE website_id = $1 AND tier = $2 ORDER BY recorded_at`, [websiteId, tier]);
  return rows as Array<Record<string, any>>;
}
