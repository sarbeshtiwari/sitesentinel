import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { BrowserRunner } from "@wim/browser-runner";
import { createDb, type Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";
import { createDeepScanEngine } from "@wim/worker-deepscan";
import { EGRESS_SECRET_4C, PREFIX_4C, addVerifiedSite, startHttpEnv, type HttpEnv } from "./http-monitoring.js";
import { setSettings, until } from "./monitoring.js";

/**
 * Phase 4E test environment = 4C environment (real Postgres, Redis, egress gateway with captured decisions,
 * fixture DNS, controlled fault website incl. the ds-* deep-scan sites) + the deep-scan worker running as the
 * narrow wim_scanner role + (optionally) a real Chromium runner for browser-assisted discovery.
 */
export const DEEPSCAN_QUEUE_POLICY = { concurrency: 3, globalConcurrency: 20, ratePerSecond: 100, attempts: 2, backoffBaseMs: 200, backoffMaxMs: 1000, timeoutMs: 180_000, keepCompletedHours: 1, keepFailedDays: 1 };
export const DEEPSCAN_TEST_SETTINGS = {
  "monitoring.deepscan.enabled": true,
  "monitoring.deepscan.minRequestDelayMs": 0, // tests: politeness delay off (the fixture is ours); default 1000 ms
  "monitoring.deepscan.maxPages": 100,
  "monitoring.deepscan.maxWebsites": 50,
  "monitoring.deepscan.pagesPerDay": 100_000,
  "monitoring.deepscan.maxConcurrentScans": 3,
  "monitoring.deepscan.manualCooldownSec": 0,
  "queue.deep-scan": DEEPSCAN_QUEUE_POLICY,
  "monitoring.limits.perCycleQuota": 100,
  "monitoring.limits.maxOutstandingJobs": 1000,
  "monitoring.limits.maxWebsites": 100,
  "monitoring.limits.maxConcurrentJobs": 50,
  "scheduler.leaseSec": 10,
  "scheduler.reconcileAfterSec": 5,
};

export interface DeepEnv extends HttpEnv {
  scannerDb: Db;
  runner: BrowserRunner;
  runnerUrl: string;
  startDeepWorker(opts?: { gatewayUrl?: string; workerId?: string; prefix?: string; hooks?: Parameters<typeof createDeepScanEngine>[0]["hooks"] }): Promise<ReturnType<typeof createExecutionWorker>>;
  stopDeepWorkers(): Promise<void>;
}

export async function startDeepEnv(): Promise<DeepEnv> {
  const base = await startHttpEnv();
  const scannerDb = createDb({ url: process.env.SCANNER_DATABASE_URL!, max: 12, omitSecrets: true });
  const runner = new BrowserRunner({ gatewayUrl: base.gatewayUrl, advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", maxSessions: 2, maxSessionMs: 120_000, sandbox: true });
  const runnerUrl = `http://127.0.0.1:${await runner.listen(0)}`;
  const log = createLogger("4e-test", { level: "silent" });
  let workers: Array<{ stop(): Promise<void> }> = [];
  return {
    ...base, scannerDb, runner, runnerUrl,
    async startDeepWorker(opts = {}) {
      const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const w = createExecutionWorker({
        db: scannerDb, connection: conn, prefix: opts.prefix ?? PREFIX_4C, tier: "DEEPSCAN", log, workerId: opts.workerId ?? `deep-${randomBytes(3).toString("hex")}`,
        lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
        handler: createDeepScanEngine({
          db: scannerDb, redis: conn, log, gatewayUrl: opts.gatewayUrl ?? base.gatewayUrl, tokenSecret: EGRESS_SECRET_4C, runnerUrl,
          jobTimeoutMs: async () => DEEPSCAN_QUEUE_POLICY.timeoutMs, hooks: opts.hooks,
        }),
      });
      await w.start();
      workers.push({ async stop() { await w.stop(); conn.disconnect(); } });
      return w;
    },
    async stopDeepWorkers() {
      const all = workers;
      workers = [];
      for (const w of all) await w.stop().catch(() => undefined);
    },
    async close() {
      for (const w of workers) await w.stop().catch(() => undefined);
      await runner.stop();
      await scannerDb.$disconnect();
      await base.close();
    },
  };
}

export const deepSettings = (env: HttpEnv, extra: Record<string, unknown> = {}) => setSettings(env.owner, { ...DEEPSCAN_TEST_SETTINGS, ...extra });

export async function entitleDeep(env: HttpEnv, orgId: string, extra: Record<string, unknown> = {}) {
  await env.owner.query(`DELETE FROM entitlement_overrides WHERE org_id = $1 AND key LIKE 'monitoring.deepscan.%'`, [orgId]);
  for (const [k, v] of Object.entries({ "monitoring.deepscan.entitled": true, ...extra })) {
    await env.owner.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, $2, $3::jsonb, 'test', gen_random_uuid())`, [orgId, k, JSON.stringify(v)]);
  }
}

/** A verified website on a ds-* fixture host. */
export async function deepSite(env: HttpEnv, orgId: string, variant: string, deepScan: Record<string, unknown> = {}) {
  const host = `ds-${variant}-${randomBytes(3).toString("hex")}.fixture.example`;
  env.dns.setA(host, ["127.0.0.1"]);
  const id = await addVerifiedSite(env.owner, orgId, `http://${host}`);
  await env.owner.query(`INSERT INTO monitoring_configurations (org_id, website_id, deep_scan, updated_at) VALUES ($1, $2, $3::jsonb, now())
                         ON CONFLICT (website_id) DO UPDATE SET deep_scan = EXCLUDED.deep_scan`, [orgId, id, JSON.stringify(deepScan)]);
  return { id, host, origin: `http://${host}` };
}

export async function scansOf(env: HttpEnv, websiteId: string) {
  const { rows } = await env.owner.query(`SELECT * FROM deep_scans WHERE website_id = $1 ORDER BY started_at`, [websiteId]);
  return rows as Array<Record<string, any>>;
}

export async function findingsOf(env: HttpEnv, websiteId: string, status: string | null = null) {
  const { rows } = await env.owner.query(`SELECT * FROM scan_findings WHERE website_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY category, subject`, [websiteId, status]);
  return rows as Array<Record<string, any>>;
}

/** Make the website's deep-scan schedule due now and wait for the next FINAL scan (one more than before). */
export async function scanNow(env: HttpEnv, websiteIds: string[], timeoutMs = 150_000) {
  const before = new Map<string, number>();
  for (const w of websiteIds) before.set(w, (await scansOf(env, w)).filter((x) => x.status !== "RUNNING").length);
  for (const w of websiteIds) await nextDeepWindow(env, w);
  await env.scheduler().runCycle();
  await until(async () => {
    for (const w of websiteIds) if ((await scansOf(env, w)).filter((x) => x.status !== "RUNNING").length <= before.get(w)!) return false;
    return true;
  }, timeoutMs, 300);
  return Promise.all(websiteIds.map(async (w) => (await scansOf(env, w)).filter((x) => x.status !== "RUNNING").at(-1)!));
}

/**
 * Open the next scan window now without waiting a day: shifting the schedule's jitter moves the window start
 * (always within the last interval, so its partition exists), giving a new (schedule, window) identity.
 */
export async function nextDeepWindow(env: HttpEnv, websiteId: string) {
  await env.owner.query(`UPDATE monitoring_schedules SET jitter_sec = (jitter_sec + 61) % interval_sec, next_run_at = now() - interval '1 second', state_window_at = NULL
                          WHERE website_id = $1 AND tier = 'T3_DEEP'`, [websiteId]);
}

export { randomUUID };
