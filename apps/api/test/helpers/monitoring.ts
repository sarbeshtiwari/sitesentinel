import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { defaultSettings, type MonitoringTier } from "@wim/core";
import { createDb, type Db } from "@wim/db";
import { createLogger, type Logger } from "@wim/logger";
import { createExecutionWorker, createScheduler, QUEUES, type ExecutionHandler } from "@wim/queue";

/**
 * Phase 4B fixtures. Tenants and verified websites are inserted directly by the
 * table owner (registration/verification have their own suites); everything the
 * scheduler and workers do runs through their production code paths and roles.
 */
export const PREFIX = "wimtest-4b";

export function owner(): pg.Client {
  return new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
}

export async function setSettings(c: pg.Client, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    await c.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  }
}

/** Restore every monitoring/scheduler/queue setting to its registry default. */
export async function resetMonitoringSettings(c: pg.Client) {
  const d = defaultSettings() as Record<string, unknown>;
  await setSettings(c, Object.fromEntries(Object.entries(d).filter(([k]) => /^(monitoring|scheduler|queue)\./.test(k))));
}

export interface SeededOrg { orgId: string; websiteIds: string[]; tokens: string[]; siteKeys: string[] }

export async function seedOrg(c: pg.Client, n: number, opts: { trial?: "ACTIVE" | "EXPIRED" | "NONE"; tag?: string } = {}): Promise<SeededOrg> {
  const orgId = randomUUID();
  const tag = `${opts.tag ?? "org"}-${randomBytes(4).toString("hex")}`;
  await c.query(`INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())`, [orgId, `Org ${tag}`, tag]);
  const trial = opts.trial ?? "ACTIVE";
  if (trial !== "NONE") {
    await c.query(
      `INSERT INTO trials (org_id, registrable_domain, starts_at, ends_at, status)
       VALUES ($1, $2, now() - interval '40 days', now() + ($3 || ' days')::interval, 'ACTIVE')`,
      [orgId, `${tag}.example`, trial === "ACTIVE" ? "29" : "-1"]);
  }
  const websiteIds: string[] = [];
  const tokens: string[] = [];
  const siteKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const host = `w${i}.${tag}.example`;
    const regId = randomUUID();
    const claimId = randomUUID();
    const token = `wim-verify-${randomBytes(16).toString("hex")}`;
    await c.query(
      `INSERT INTO domain_registry (id, identity_key, host_key, registrable_domain, display_host, is_root)
       VALUES ($1, $2, $2, $3, $2, false)`, [regId, host, `${tag}.example`]);
    await c.query(
      `INSERT INTO domain_claims (id, org_id, domain_registry_id, scope, policy, verification_token, status, verified_at, verified_method, updated_at)
       VALUES ($1, $2, $3, 'HOST', 'SUBDOMAIN_INDEPENDENT', $4, 'VERIFIED', now(), 'DNS_TXT', now())`, [claimId, orgId, regId, token]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO websites (org_id, domain_claim_id, name, canonical_origin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, now()) RETURNING id`,
      [orgId, claimId, `Site ${i}`, `https://${host}`, String(i)]);
    websiteIds.push(rows[0]!.id);
    tokens.push(token);
    const siteKey = `sk_${randomBytes(18).toString("hex")}`;
    siteKeys.push(siteKey);
    await c.query(`INSERT INTO site_installations (org_id, website_id, site_key, updated_at) VALUES ($1, $2, $3, now())`, [orgId, rows[0]!.id, siteKey])
      .catch(() => undefined); // installation shape is Phase 3's; only used for leak checks
  }
  return { orgId, websiteIds, tokens, siteKeys };
}

/** Pino logger whose output is captured for secret-leak assertions. */
export function capturedLogger(name: string): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const log = createLogger(name, { level: "debug" }, stream);
  return { log, lines };
}

export interface Rig {
  db: Db;
  redis: Redis;
  queues: Record<MonitoringTier, Queue>;
  dlq: Queue;
  scheduler(instanceId?: string, hooks?: { afterCommitHook?: (ids: string[]) => void | Promise<void>; db?: Db; redis?: Redis }): ReturnType<typeof createScheduler>;
  worker(tier: MonitoringTier, handler: ExecutionHandler, opts?: { workerId?: string; db?: Db }): ReturnType<typeof createExecutionWorker>;
  stopWorkers(): Promise<void>;
  logs: string[];
  close(): Promise<void>;
}

export function rig(): Rig {
  const db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 12, omitSecrets: true });
  const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const queues = {
    HTTP: new Queue(QUEUES.http, { connection: redis, prefix: PREFIX }),
    BROWSER: new Queue(QUEUES.browser, { connection: redis, prefix: PREFIX }),
    DEEPSCAN: new Queue(QUEUES.deepscan, { connection: redis, prefix: PREFIX }),
  };
  const dlq = new Queue(QUEUES.deadLetter, { connection: redis, prefix: PREFIX });
  const { log, lines } = capturedLogger("4b-test");
  let workers: Array<{ stop(): Promise<void> }> = [];
  const extraQueues: Queue[] = [];
  return {
    db, redis, queues, dlq, logs: lines,
    scheduler(instanceId = `sched-${randomBytes(3).toString("hex")}`, hooks = {}) {
      const r = hooks.redis ?? redis;
      const qs = hooks.redis
        ? (Object.fromEntries((["HTTP", "BROWSER", "DEEPSCAN"] as const).map((t) => {
            const q = new Queue(queues[t].name, { connection: r, prefix: PREFIX });
            extraQueues.push(q);
            return [t, q];
          })) as Record<MonitoringTier, Queue>)
        : queues;
      return createScheduler({ db: hooks.db ?? db, queues: qs, log, instanceId, afterCommitHook: hooks.afterCommitHook });
    },
    worker(tier, handler, opts = {}) {
      const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const w = createExecutionWorker({
        db: opts.db ?? db, connection: conn, prefix: PREFIX, tier, handler, log, workerId: opts.workerId ?? `w-${randomBytes(3).toString("hex")}`,
        lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
      });
      workers.push({ async stop() { await w.stop(); conn.disconnect(); } });
      return w;
    },
    async stopWorkers() {
      const all = workers;
      workers = [];
      for (const w of all) await w.stop().catch(() => undefined);
    },
    async close() {
      for (const w of workers) await w.stop().catch(() => undefined);
      for (const q of [...Object.values(queues), dlq, ...extraQueues]) await q.close();
      redis.disconnect();
      await db.$disconnect();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(everyMs);
  }
}

export async function executions(c: pg.Client, orgIds: string[]) {
  const { rows } = await c.query<{ id: string; org_id: string; website_id: string; schedule_id: string | null; queued_at: Date; status: string; attempt: number; tier: string; trigger: string; failure_category: string | null; error_message: string | null }>(
    `SELECT id, org_id, website_id, schedule_id, queued_at, status::text AS status, attempt, tier::text AS tier, trigger, failure_category, error_message
       FROM monitoring_executions WHERE org_id = ANY($1::uuid[]) ORDER BY queued_at, id`, [orgIds]);
  return rows;
}

export async function schedules(c: pg.Client, orgIds: string[]) {
  const { rows } = await c.query<{ id: string; org_id: string; website_id: string; tier: string; status: string; paused_reason: string | null; interval_sec: number; jitter_sec: number; next_run_at: Date; missed_slots: number }>(
    `SELECT id, org_id, website_id, tier::text AS tier, status::text AS status, paused_reason, interval_sec, jitter_sec, next_run_at, missed_slots
       FROM monitoring_schedules WHERE org_id = ANY($1::uuid[]) ORDER BY website_id, tier`, [orgIds]);
  return rows;
}

/** Make every schedule of these orgs due now (simulates time passing) without touching the execution history. */
export async function makeDue(c: pg.Client, orgIds: string[], agoSec = 1) {
  await c.query(`UPDATE monitoring_schedules SET next_run_at = now() - ($2 || ' seconds')::interval WHERE org_id = ANY($1::uuid[])`, [orgIds, String(agoSec)]);
}

/** Move these orgs' executions one window back so the current window is free again (simulates the next window). */
export async function shiftHistory(c: pg.Client, orgIds: string[]) {
  await c.query(`DELETE FROM monitoring_executions WHERE org_id = ANY($1::uuid[]) AND status NOT IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`, [orgIds]);
}
