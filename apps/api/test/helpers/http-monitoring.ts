import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { MonitoringTier } from "@wim/core";
import { createDb, type Db } from "@wim/db";
import { EMAIL_QUEUE } from "@wim/contracts";
import { Gateway } from "@wim/egress-gateway";
import { createLogger } from "@wim/logger";
import { createExecutionWorker, createScheduler, QUEUES, relayOutbox } from "@wim/queue";
import { createHttpEngine } from "@wim/worker-http";
import { createTestPki, startDnsServer, startFaultSite, type FaultSite, type FixtureDns, type TestPki } from "@wim/test-fixtures";
import { capturedLogger, setSettings } from "./monitoring.js";

/**
 * Phase 4C test environment: real Postgres, Redis, egress gateway, fixture DNS and the controlled
 * fault website (HTTP + HTTPS with a test CA). The HTTP engine runs in-process through the
 * production 4B runtime; the scheduler creates the executions.
 */
export const PREFIX_4C = "wimtest-4c";
export const EGRESS_SECRET_4C = "phase4c-egress-secret-0123456789abcdefghij";

export interface HttpEnv {
  db: Db;
  redis: Redis;
  owner: pg.Client;
  dns: FixtureDns;
  site: FaultSite;
  pki: TestPki;
  gateway: Gateway;
  gatewayUrl: string;
  queues: Record<MonitoringTier, Queue>;
  emailQueue: Queue;
  logs: string[];
  /** every gateway decision (outcome, org, website, exec, kind, host, address, …) */
  gatewayLog: Array<Record<string, any>>;
  scheduler(): ReturnType<typeof createScheduler>;
  startWorker(opts?: { gatewayUrl?: string; workerId?: string; hooks?: Parameters<typeof createHttpEngine>[0]["hooks"] }): Promise<ReturnType<typeof createExecutionWorker>>;
  stopWorkers(): Promise<void>;
  /** relay committed outbox events to the real email queue (what the scheduler does each cycle) */
  relay(): Promise<number>;
  close(): Promise<void>;
}

export async function startHttpEnv(): Promise<HttpEnv> {
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  const db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 20, omitSecrets: true });
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const gatewayLog: Array<Record<string, any>> = [];
  const gwLogger = createLogger("egress-gateway", { level: "info" }, new Writable({ write(chunk, _e, cb) { try { gatewayLog.push(JSON.parse(String(chunk))); } catch { /* ignore */ } cb(); } }));
  const dns = await startDnsServer();
  const pki = createTestPki();
  const site = await startFaultSite(pki);
  const gateway = new Gateway({
    resolvers: [dns.server], tokenSecret: EGRESS_SECRET_4C, allowedPorts: [80, 443], maxConnectionsPerOrg: 50, maxConnectionsTotal: 500,
    maxTunnelBytes: 64 * 1024 * 1024, tunnelMaxMs: 30_000, idleMs: 10_000, connectTimeoutMs: 3000,
    testAllowCidrs: ["127.0.0.0/8"], testPortMap: { 80: site.httpPort, 443: site.httpsPort },
  }, { logger: gwLogger });
  await gateway.listen(0, "127.0.0.1");
  const gatewayUrl = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const queues = {
    HTTP: new Queue(QUEUES.http, { connection: redis, prefix: PREFIX_4C }),
    BROWSER: new Queue(QUEUES.browser, { connection: redis, prefix: PREFIX_4C }),
    DEEPSCAN: new Queue(QUEUES.deepscan, { connection: redis, prefix: PREFIX_4C }),
  };
  const emailQueue = new Queue(EMAIL_QUEUE, { connection: redis, prefix: process.env.QUEUE_PREFIX });
  const { log, lines } = capturedLogger("4c-test");
  let workers: Array<{ stop(): Promise<void> }> = [];
  return {
    db, redis, owner, dns, site, pki, gateway, gatewayUrl, queues, emailQueue, logs: lines, gatewayLog,
    scheduler: () => createScheduler({ db, queues, log, instanceId: `sched-4c-${randomBytes(2).toString("hex")}` }),
    async startWorker(opts = {}) {
      const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const w = createExecutionWorker({
        db, connection: conn, prefix: PREFIX_4C, tier: "HTTP", log, workerId: opts.workerId ?? `http-${randomBytes(3).toString("hex")}`,
        lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
        handler: createHttpEngine({
          db, redis: conn, prefix: PREFIX_4C, log, gatewayUrl: opts.gatewayUrl ?? gatewayUrl, tokenSecret: EGRESS_SECRET_4C, testCa: pki.caPem, hooks: opts.hooks,
        }),
      });
      await w.start();
      workers.push({ async stop() { await w.stop(); conn.disconnect(); } });
      return w;
    },
    async stopWorkers() {
      const all = workers;
      workers = [];
      for (const w of all) await w.stop().catch(() => undefined);
    },
    relay: () => relayOutbox(db, emailQueue),
    async close() {
      for (const w of workers) await w.stop().catch(() => undefined);
      for (const q of [...Object.values(queues), emailQueue]) await q.close();
      await gateway.close?.();
      await site.close();
      await dns.close();
      redis.disconnect();
      await db.$disconnect();
      await owner.end();
    },
  };
}

export const HTTP_TEST_SETTINGS = {
  "monitoring.http.enabled": true,
  "scheduler.reconcileAfterSec": 5,
  "scheduler.leaseSec": 10,
  "monitoring.http.failureThreshold": 2,
  "monitoring.http.recoveryThreshold": 2,
  "monitoring.limits.perCycleQuota": 100,
  "monitoring.limits.maxOutstandingJobs": 1000,
  "monitoring.limits.maxConcurrentJobs": 50,
  "queue.http-monitoring": { concurrency: 20, globalConcurrency: 200, ratePerSecond: 1000, attempts: 3, backoffBaseMs: 200, backoffMaxMs: 1000, timeoutMs: 20_000, keepCompletedHours: 1, keepFailedDays: 1 },
};

/** A verified website for `host` in an existing org (registration/verification have their own suites). */
export async function addVerifiedSite(c: pg.Client, orgId: string, origin: string, httpCheck?: Record<string, unknown>): Promise<string> {
  const host = new URL(origin).hostname;
  const regId = randomUUID();
  const claimId = randomUUID();
  await c.query(`INSERT INTO domain_registry (id, identity_key, host_key, registrable_domain, display_host, is_root) VALUES ($1, $2, $2, $3, $2, false)`,
    [regId, host, host.split(".").slice(-2).join(".")]);
  await c.query(
    `INSERT INTO domain_claims (id, org_id, domain_registry_id, scope, policy, verification_token, status, verified_at, verified_method, updated_at)
     VALUES ($1, $2, $3, 'HOST', 'SUBDOMAIN_INDEPENDENT', $4, 'VERIFIED', now(), 'DNS_TXT', now())`, [claimId, orgId, regId, `wim-verify-${randomBytes(16).toString("hex")}`]);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO websites (org_id, domain_claim_id, name, canonical_origin, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`, [orgId, claimId, `Site ${host}`, origin]);
  if (httpCheck) {
    await c.query(`INSERT INTO monitoring_configurations (org_id, website_id, http_check, updated_at) VALUES ($1, $2, $3::jsonb, now())`, [orgId, rows[0]!.id, JSON.stringify(httpCheck)]);
  }
  return rows[0]!.id;
}

export async function ensureTrial(c: pg.Client, orgId: string) {
  await c.query(`INSERT INTO trials (org_id, registrable_domain, starts_at, ends_at, status) VALUES ($1, $2, now() - interval '1 day', now() + interval '29 days', 'ACTIVE') ON CONFLICT (org_id) DO NOTHING`,
    [orgId, `trial-${orgId.slice(0, 8)}.example`]);
}

/**
 * Advance to the "next window" for these websites without waiting a real interval: the execution
 * (and result) of the current window is moved to a free slot before the oldest one, the schedule's
 * applied-window marker moves with it, and the schedule becomes due — so the scheduler creates a
 * genuine new execution for the current window. Result order is by finished_at.
 */
export async function nextWindow(c: pg.Client, websiteIds: string[]) {
  for (const w of websiteIds) {
    const { rows } = await c.query<{ id: string; queued_at: Date; min: Date }>(
      `SELECT id, queued_at, (SELECT min(queued_at) FROM monitoring_executions WHERE website_id = $1 AND tier = 'T1_HTTP') AS min
         FROM monitoring_executions WHERE website_id = $1 AND tier = 'T1_HTTP' ORDER BY queued_at DESC LIMIT 1`, [w]);
    const cur = rows[0];
    if (!cur) continue;
    const target = new Date(cur.min.getTime() - 60_000);
    await c.query(`UPDATE monitoring_executions SET queued_at = $2, slot = floor(extract(epoch FROM $2::timestamptz)) WHERE id = $1`, [cur.id, target]);
    await c.query(`UPDATE check_results SET checked_at = $2 WHERE execution_id = $1`, [cur.id, target]);
    await c.query(`UPDATE execution_results SET window_start = $2 WHERE execution_id = $1`, [cur.id, target]);
    await c.query(`UPDATE monitoring_schedules SET next_run_at = now() - interval '1 second', state_window_at = LEAST(state_window_at, $2) WHERE website_id = $1 AND tier = 'T1_HTTP'`, [w, target]);
  }
}

export async function results(c: pg.Client, websiteId: string) {
  const { rows } = await c.query(`SELECT * FROM check_results WHERE website_id = $1 ORDER BY finished_at, checked_at`, [websiteId]);
  return rows as Array<Record<string, any>>;
}

export async function incidentsOf(c: pg.Client, websiteId: string) {
  const { rows } = await c.query(`SELECT * FROM incidents WHERE website_id = $1 ORDER BY created_at`, [websiteId]);
  return rows as Array<Record<string, any>>;
}

export const settle = (env: HttpEnv, s: Record<string, unknown> = {}) => setSettings(env.owner, { ...HTTP_TEST_SETTINGS, ...s });

