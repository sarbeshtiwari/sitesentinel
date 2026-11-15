import { randomBytes } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { EMAIL_QUEUE } from "@wim/contracts";
import { createDb, type Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createHeartbeat, DbOutageWatch, QUEUES, relayOutbox, runPlatformEvaluation, type EvaluationDeps } from "@wim/queue";
import { startEmailWorker } from "@wim/worker-notify";
import { Client, countEmails, createAdmin, startHarness, totpCode, userWithOrg, waitForEmail, type Harness } from "../helpers/harness.js";
import { seedOrg, setSettings, sleep, until } from "../helpers/monitoring.js";

/**
 * Phase 4H: platform health evaluation and self-alerting against the real infrastructure (PostgreSQL, Redis, BullMQ,
 * Mailpit). Each test uses its own queue prefix, so the queues it measures are its own; heartbeats of other test runs are
 * cleared first. Evaluations are driven explicitly (`force`), with the noise-protection settings of each scenario.
 */
let h: Harness;
let c: pg.Client;
let db: Db;
let redis: Redis;
let prefix: string;
let queues: Record<string, Queue>;
const log = createLogger("ops-test", { level: "silent" });
const OPS_EMAIL = `ops-${randomBytes(3).toString("hex")}@ops.example.test`;

const deps = (o: Partial<EvaluationDeps> = {}): EvaluationDeps => ({ db, connection: redis, queues, evaluatorId: "test-evaluator", log, ...o });
const evaluate = (o: Partial<EvaluationDeps> = {}) => runPlatformEvaluation(deps(o), { force: true });
const alerts = async (rule?: string) => (await c.query(`SELECT * FROM platform_alerts ${rule ? "WHERE rule = $1" : ""} ORDER BY opened_at`, rule ? [rule] : [])).rows;
const events = async (id: string) => (await c.query(`SELECT type, details FROM platform_alert_events WHERE alert_id = $1 ORDER BY id`, [id])).rows;
async function beatAs(workerId: string, kind: string, o: { ageSec?: number; deps?: Record<string, { ok: boolean }>; activeJobs?: number; capacity?: number; processed?: number; lastJobAt?: Date | null } = {}) {
  await c.query(`
    INSERT INTO worker_heartbeats (worker_id, kind, region, version, hostname, started_at, last_seen_at, active_jobs, capacity, processed, last_job_at, deps)
    VALUES ($1, $2, 'r1', 'test', 'h', now() - interval '1 hour', now() - make_interval(secs => $3), $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, active_jobs = EXCLUDED.active_jobs, capacity = EXCLUDED.capacity,
      processed = EXCLUDED.processed, last_job_at = EXCLUDED.last_job_at, deps = EXCLUDED.deps`,
  [workerId, kind, o.ageSec ?? 0, o.activeJobs ?? 0, o.capacity ?? 4, o.processed ?? 0, o.lastJobAt === undefined ? new Date() : o.lastJobAt, JSON.stringify(Object.fromEntries(Object.entries(o.deps ?? {}).map(([k, v]) => [k, { ...v, at: new Date().toISOString(), ms: 3 }])))]);
}
/** A healthy platform: a scheduler, one live worker per kind, recent maintenance and rollups. */
async function healthyPlatform() {
  await c.query(`DELETE FROM worker_heartbeats`);
  await beatAs("sched-1", "scheduler");
  for (const k of ["http-monitoring", "browser-monitoring", "deep-scan"]) await beatAs(`${k}-1`, k, { deps: { redis: { ok: true }, gateway: { ok: true }, ...(k === "browser-monitoring" ? { runner: { ok: true }, storage: { ok: true } } : {}) } });
  await beatAs("email-1", "email", { deps: { redis: { ok: true }, smtp: { ok: true } } });
  await c.query(`INSERT INTO system_health_logs (component, metric, value) VALUES ('maintenance', 'partitions_ok', 0)`);
  await c.query(`INSERT INTO rollup_state (name, watermark, last_run_at) VALUES ('performance', now(), now()) ON CONFLICT (name) DO UPDATE SET last_run_at = now()`);
  // API and ingest report liveness through Redis (release readiness)
  for (const k of ["api", "ingest"]) await redis.set(`wim:ops:hb:${k}:fixture`, JSON.stringify({ kind: k, id: "fixture", at: new Date().toISOString(), checks: { postgres: true } }), "EX", 600);
}
async function adminClient(role: string) {
  const a = await createAdmin(role);
  const cl = Client.admin(h.app);
  const res = await cl.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) });
  expect(res.status).toBe(200);
  return { cl, ...a };
}

beforeAll(async () => {
  h = await startHarness();
  c = h.owner;
  db = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 6, omitSecrets: true });
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await c.query(`DELETE FROM platform_alert_events`).catch(() => undefined);
}, 120_000);
afterAll(async () => {
  for (const q of Object.values(queues ?? {})) await q.close();
  await c.query(`DELETE FROM worker_heartbeats`);
  await c.query(`DELETE FROM platform_settings WHERE key LIKE 'ops.%'`);
  redis.disconnect();
  await db.$disconnect();
  await h.stop();
});
beforeEach(async () => {
  for (const q of Object.values(queues ?? {})) await q.close();
  prefix = `wimtest-ops-${randomBytes(3).toString("hex")}`;
  queues = Object.fromEntries([QUEUES.http, QUEUES.browser, QUEUES.deepscan, EMAIL_QUEUE].map((n) => [n, new Queue(n, { connection: redis, prefix })]));
  // clean alert state; append-only events are removed with their alerts (cascade from the owner)
  await c.query(`ALTER TABLE platform_alert_events DISABLE TRIGGER append_only`);
  await c.query(`DELETE FROM platform_alerts; DELETE FROM platform_health`);
  await c.query(`ALTER TABLE platform_alert_events ENABLE TRIGGER append_only`);
  await c.query(`DELETE FROM job_failures WHERE failed_at > now() - interval '2 hours'`);
  await c.query(`DELETE FROM system_health_logs WHERE recorded_at > now() - interval '25 hours' AND component IN ('http-monitoring', 'browser-monitoring', 'deep-scan', 'worker', 'maintenance', 'ops', 'queue')`);
  await c.query(`DELETE FROM notification_delivery_logs WHERE created_at > now() - interval '1 hour' AND status = 'FAILED'`);
  await c.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`);
  await setSettings(c, {
    "ops.alerts.enabled": true, "ops.alerts.openAfterEvaluations": 2, "ops.alerts.recoverAfterEvaluations": 2, "ops.alerts.recipients": [OPS_EMAIL],
    "ops.alerts.maxNotificationsPer10Min": 10, "ops.alerts.cooldownMin": 30, "ops.alerts.renotifyCriticalMin": 120, "ops.alerts.disabledRules": [],
    "ops.health.heartbeatStaleSec": 45, "ops.health.processingStallSec": 600, "monitoring.http.enabled": true, "monitoring.browser.enabled": true, "monitoring.deepscan.enabled": true,
  });
  await healthyPlatform();
});

// =====================================================================================================
describe("health evaluation: alive ≠ processing ≠ dependencies ≠ capacity; missing is never healthy", () => {
  it("a healthy platform evaluates healthy and opens nothing", async () => {
    const r = await evaluate();
    expect(r.ran).toBe(true);
    // CPU / disk of the real worker processes depend on the machine running the suite (a busy CI runner reached 146 %);
    // those rules are covered with controlled values below ("resources" test), so they're excluded here.
    const bad = r.signals.filter((s) => s.state !== "HEALTHY" && s.state !== "UNKNOWN" && !s.rule.startsWith("resources."));
    expect(bad, JSON.stringify(bad)).toEqual([]);
    const snap = (await c.query(`SELECT component, state FROM platform_health WHERE component <> '__evaluator'`)).rows;
    expect(snap.find((x) => x.component === "redis")?.state).toBe("HEALTHY");
    expect(snap.find((x) => x.component === "postgres")?.state).toBe("HEALTHY");
    expect((await alerts()).filter((x: { rule: string }) => !x.rule.startsWith("resources."))).toEqual([]);
  });

  it("an expired heartbeat is UNHEALTHY and opens ONE alert after the noise threshold; recovery after K good evaluations", async () => {
    await beatAs("http-monitoring-1", "http-monitoring", { ageSec: 300, deps: { redis: { ok: true }, gateway: { ok: true } } });
    const r1 = await evaluate();
    expect(r1.signals.find((s) => s.rule === "worker.heartbeat_expired" && s.subject === "http-monitoring")).toMatchObject({ state: "UNHEALTHY" });
    expect(await alerts("worker.heartbeat_expired")).toEqual([]); // 1 of 2 bad evaluations: not yet
    await evaluate();
    await evaluate(); // still bad: same alert, more occurrences — never a duplicate
    const [a] = await alerts("worker.heartbeat_expired");
    expect(a).toMatchObject({ state: "OPEN", severity: "CRITICAL", component: "workers:http-monitoring", occurrences: 2 });
    expect(await alerts("worker.heartbeat_expired")).toHaveLength(1);
    // the worker comes back: one good evaluation is not enough, two are
    await beatAs("http-monitoring-1", "http-monitoring", { deps: { redis: { ok: true }, gateway: { ok: true } } });
    await evaluate();
    expect((await alerts("worker.heartbeat_expired"))[0].state).toBe("OPEN");
    await evaluate();
    expect((await alerts("worker.heartbeat_expired"))[0]).toMatchObject({ state: "RECOVERED" });
    expect((await events(a.id)).map((e) => e.type)).toEqual(expect.arrayContaining(["OPENED", "NOTIFY_QUEUED", "RECOVERED"]));
  });

  it("no worker registered for an enabled tier with work waiting is UNHEALTHY (missing ≠ healthy); a disabled tier is UNKNOWN, not alerting", async () => {
    await c.query(`DELETE FROM worker_heartbeats WHERE kind = 'deep-scan'`);
    await queues[QUEUES.deepscan]!.add("EXECUTE", { v: 1 }, { jobId: "waiting-1" });
    let r = await evaluate();
    expect(r.signals.find((s) => s.rule === "worker.heartbeat_expired" && s.subject === "deep-scan")).toMatchObject({ state: "UNHEALTHY", reason: "no worker registered" });
    expect(r.signals.find((s) => s.rule === "worker.not_processing" && s.subject === "deep-scan")).toMatchObject({ state: "DEGRADED" });
    await queues[QUEUES.deepscan]!.obliterate({ force: true });
    await setSettings(c, { "monitoring.deepscan.enabled": false });
    r = await evaluate();
    expect(r.signals.find((s) => s.rule === "worker.heartbeat_expired" && s.subject === "deep-scan")?.state).toBe("UNKNOWN");
  });

  it("alive but not processing: jobs wait, heartbeats are fresh, nothing finished for longer than the stall window", async () => {
    await setSettings(c, { "ops.health.processingStallSec": 60 });
    await beatAs("http-monitoring-1", "http-monitoring", { lastJobAt: new Date(Date.now() - 3_600_000), deps: { redis: { ok: true }, gateway: { ok: true } } });
    await queues[QUEUES.http]!.add("EXECUTE", { v: 1 }, { jobId: "stuck-1", timestamp: Date.now() - 300_000 });
    const r = await evaluate();
    expect(r.signals.find((s) => s.rule === "worker.heartbeat_expired" && s.subject === "http-monitoring")?.state).toBe("HEALTHY");
    expect(r.signals.find((s) => s.rule === "worker.not_processing" && s.subject === "http-monitoring")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((s) => s.rule === "queue.backlog" && s.subject === QUEUES.http)).toMatchObject({ state: "DEGRADED" }); // oldest 300 s ≥ warn 300
  });

  it("alive but cannot reach a dependency; capacity saturated while work waits", async () => {
    await beatAs("browser-monitoring-1", "browser-monitoring", { activeJobs: 4, capacity: 4, deps: { redis: { ok: true }, gateway: { ok: true }, runner: { ok: false }, storage: { ok: false } } });
    await queues[QUEUES.browser]!.add("EXECUTE", { v: 1 }, { jobId: "w-1" });
    const r = await evaluate();
    expect(r.signals.find((s) => s.rule === "runner.failures")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((s) => s.rule === "storage.unavailable")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((s) => s.rule === "worker.capacity" && s.subject === "browser-monitoring")).toMatchObject({ state: "UNHEALTHY" });
    const comp = (await c.query(`SELECT state, reasons FROM platform_health WHERE component = 'browser-runner'`)).rows[0];
    expect(comp.state).toBe("UNHEALTHY");
  });

  it("dead-letter growth, retention failures, rollup lag and crash loops are detected", async () => {
    for (let i = 0; i < 6; i++) await c.query(`INSERT INTO job_failures (queue, job_id, payload, error, attempts) VALUES ('http-monitoring', $1, '{}', 'x', 3)`, [`dl-${i}`]);
    await c.query(`DELETE FROM system_health_logs WHERE component = 'maintenance'`);
    await c.query(`INSERT INTO system_health_logs (recorded_at, component, metric, value) VALUES (now() - interval '8 hours', 'maintenance', 'partitions_ok', 0), (now(), 'maintenance', 'partitions_failed', 1)`);
    await c.query(`UPDATE rollup_state SET last_run_at = now() - interval '1 hour' WHERE name = 'performance'`);
    for (let i = 0; i < 4; i++) await c.query(`INSERT INTO system_health_logs (component, metric, value, labels) VALUES ('worker', 'start', 1, '{"kind":"deep-scan"}')`);
    const r = await evaluate();
    expect(r.signals.find((s) => s.rule === "dead_letters.growth")).toMatchObject({ state: "DEGRADED" });
    expect(r.signals.find((s) => s.rule === "retention.failing")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((s) => s.rule === "rollups.lagging")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((s) => s.rule === "worker.restarts" && s.subject === "deep-scan")).toMatchObject({ state: "DEGRADED" });
  });

  it("Redis unreachable is detected by the evaluator itself (never treated as healthy)", async () => {
    const dead = new Redis("redis://127.0.0.1:1", { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    const qs = Object.fromEntries(Object.keys(queues).map((n) => [n, new Queue(n, { connection: dead, prefix })]));
    const r = await runPlatformEvaluation({ ...deps(), connection: dead, queues: qs }, { force: true });
    expect(r.signals.find((s) => s.rule === "redis.unavailable")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.filter((s) => s.rule === "queue.backlog")).toEqual([]); // no fake "0 waiting" when the queue can't be read
    for (const q of Object.values(qs)) await q.close().catch(() => undefined);
    dead.disconnect();
  });
});

// =====================================================================================================
describe("release readiness: silent-stop detection and operational coverage", () => {
  it("active schedules that are not being executed make customer monitoring UNHEALTHY although every worker is alive", async () => {
    const o = await seedOrg(c, 2, { tag: "stall" });
    try {
      await c.query(`INSERT INTO monitoring_schedules (org_id, website_id, tier, interval_sec, jitter_sec, status, next_run_at, updated_at)
                     SELECT $1, w, 'T1_HTTP', 60, 0, 'ACTIVE', now() - interval '30 minutes', now() FROM unnest($2::uuid[]) w
                     ON CONFLICT DO NOTHING`, [o.orgId, o.websiteIds]).catch(async () => {
        await c.query(`UPDATE monitoring_schedules SET status = 'ACTIVE', next_run_at = now() - interval '30 minutes', interval_sec = 60 WHERE website_id = ANY($1::uuid[]) AND tier = 'T1_HTTP'`, [o.websiteIds]);
      });
      const r = await evaluate();
      expect(r.signals.find((x) => x.rule === "monitoring.stalled" && x.subject === "T1_HTTP")).toMatchObject({ state: "DEGRADED" });
      expect(r.signals.filter((x) => x.rule === "worker.heartbeat_expired" && x.state === "UNHEALTHY")).toEqual([]); // workers fine
      const { platformVerdict } = await import("@wim/queue");
      const comps = (await c.query(`SELECT component, state FROM platform_health WHERE component <> '__evaluator'`)).rows;
      const v = platformVerdict(comps);
      expect(v.customerMonitoring).toBe("DEGRADED");
      expect(v.state).not.toBe("HEALTHY");
      // the tier switched off: nothing is expected, no signal
      await setSettings(c, { "monitoring.http.enabled": false });
      const r2 = await evaluate();
      expect(r2.signals.find((x) => x.rule === "monitoring.stalled" && x.subject === "T1_HTTP")).toBeUndefined();
    } finally {
      await c.query(`DELETE FROM monitoring_schedules WHERE org_id = $1`, [o.orgId]);
      await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [o.orgId]);
    }
  });

  it("timeout rate, failed cleanups, CPU/disk and missing API/ingest processes are signals", async () => {
    // timeout rate = timeouts / (timeouts + recorded browser results in 15 min): make the share unambiguous whatever
    // other test files recorded just before (each recent browser result is matched by 2 timeouts → ≥ 66 %)
    const [{ n: recent }] = (await c.query(`SELECT count(*)::int AS n FROM execution_results WHERE tier = 'T2_RENDER' AND recorded_at > now() - interval '15 minutes'`)).rows;
    for (let i = 0; i < Math.max(12, recent * 2); i++) await c.query(`INSERT INTO system_health_logs (component, metric, value, labels) VALUES ('queue', 'timeout', 1, '{"queue":"browser-monitoring"}')`);
    await c.query(`INSERT INTO system_health_logs (component, metric, value) VALUES ('maintenance', 'artifact_cleanup_failed', 1), ('maintenance', 'deepscan_retention_failed', 1)`);
    await c.query(`UPDATE worker_heartbeats SET meta = '{"cpuPct": 99, "diskUsedPct": 96}'::jsonb WHERE worker_id = 'deep-scan-1'`);
    let r = await evaluate();
    expect(r.signals.find((x) => x.rule === "executions.timeouts" && x.subject === "browser-monitoring")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((x) => x.rule === "cleanup.failing")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((x) => x.rule === "resources.cpu" && x.subject === "deep-scan-1")).toMatchObject({ state: "UNHEALTHY" });
    expect(r.signals.find((x) => x.rule === "resources.disk" && x.subject === "deep-scan-1")).toMatchObject({ state: "UNHEALTHY" });
    // no API / ingest process has reported → UNHEALTHY (missing is never healthy); one reporting a failing database → DEGRADED/UNHEALTHY
    const pfx = "wim";
    await redis.del("wim:ops:hb:api:fixture");
    r = await evaluate();
    expect(r.signals.find((x) => x.rule === "process.unavailable" && x.subject === "api")?.state).toBe("UNHEALTHY");
    const { createRedisHeartbeat } = await import("@wim/queue");
    const hbA = createRedisHeartbeat({ connection: redis, prefix: pfx, kind: "api", id: "api-test-1", check: async () => ({ postgres: true }) });
    const hbB = createRedisHeartbeat({ connection: redis, prefix: pfx, kind: "api", id: "api-test-2", check: async () => ({ postgres: false }) });
    await sleep(300);
    r = await runPlatformEvaluation(deps({ prefix: pfx }), { force: true });
    expect(r.signals.find((x) => x.rule === "process.unavailable" && x.subject === "api")).toMatchObject({ state: "DEGRADED" });
    await hbA.stop(); await hbB.stop();
    r = await runPlatformEvaluation(deps({ prefix: pfx }), { force: true });
    expect(r.signals.find((x) => x.rule === "process.unavailable" && x.subject === "api")?.state).toBe("UNHEALTHY");
  });

  it("worker-notify refuses to start in production without fallback alert recipients", async () => {
    expect(() => startEmailWorker({ ...process.env, NODE_ENV: "production", OPS_FALLBACK_ALERT_EMAILS: "", QUEUE_PREFIX: prefix, OPS_WATCHDOG: "on" })).toThrow(/OPS_FALLBACK_ALERT_EMAILS/);
  });
});

// =====================================================================================================
describe("alert storms, suppression, cooldowns", () => {
  it("a failing shared dependency sends ONE notification; dependent alerts are recorded, not sent", async () => {
    // the gateway is down for every worker: dependants (runner, deep scan, not processing…) are suppressed
    for (const k of ["http-monitoring", "browser-monitoring", "deep-scan"]) {
      await beatAs(`${k}-1`, k, { deps: { redis: { ok: true }, gateway: { ok: false }, ...(k === "browser-monitoring" ? { runner: { ok: false } } : {}) } });
    }
    for (let i = 0; i < 20; i++) await c.query(`INSERT INTO system_health_logs (component, metric, value, labels) VALUES ('browser-monitoring', 'infra_failure', 1, '{"kind":"GATEWAY_UNAVAILABLE"}')`);
    await evaluate();
    const r = await evaluate();
    const gw = (await alerts("gateway.unavailable"))[0];
    expect(gw).toMatchObject({ state: "OPEN", notify_state: "QUEUED", suppressed_by: null });
    const runner = (await alerts("runner.failures"))[0];
    expect(runner).toMatchObject({ state: "OPEN", suppressed_by: gw.id, notify_state: "SUPPRESSED" });
    expect(r.notified).toEqual([gw.id]);
    const queued = (await c.query(`SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'platform.alert' AND published_at IS NULL`)).rows[0].n;
    expect(queued).toBe(1);
  });

  it("the storm cap holds back notifications beyond the limit and sends ONE summary alert", async () => {
    await setSettings(c, { "ops.alerts.maxNotificationsPer10Min": 2, "ops.alerts.openAfterEvaluations": 1 });
    // many unrelated failures at once (no shared root cause)
    await beatAs("http-monitoring-1", "http-monitoring", { ageSec: 600 });
    await beatAs("browser-monitoring-1", "browser-monitoring", { ageSec: 600 });
    await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
    await beatAs("email-1", "email", { ageSec: 600 });
    await c.query(`UPDATE rollup_state SET last_run_at = now() - interval '2 hours'`);
    const r = await evaluate();
    expect(r.opened.length).toBeGreaterThanOrEqual(5);
    expect(r.suppressed.length).toBeGreaterThanOrEqual(3);
    const storm = (await alerts("alerts.storm"))[0];
    expect(storm).toMatchObject({ state: "OPEN", severity: "CRITICAL" });
    const notifyQueued = (await c.query(`SELECT count(*)::int AS n FROM platform_alert_events WHERE type = 'NOTIFY_QUEUED'`)).rows[0].n;
    expect(notifyQueued).toBe(3); // 2 within the cap + the summary
    // after the storm (more budget), held alerts are sent once — nothing stays silently unsent
    await setSettings(c, { "ops.alerts.maxNotificationsPer10Min": 50 });
    const r2 = await evaluate();
    expect(r2.notified.length).toBe(r.suppressed.length);
    expect((await c.query(`SELECT count(*)::int AS n FROM platform_alerts WHERE state = 'OPEN' AND notify_state = 'SUPPRESSED' AND rule <> 'alerts.storm'`)).rows[0].n).toBe(0);
    // recoveries are never held back by the cap
    await setSettings(c, { "ops.alerts.maxNotificationsPer10Min": 1 });
    await healthyPlatform();
    await evaluate(); // recovery needs 2 good evaluations
    const r3 = await evaluate();
    expect(r3.recovered.length).toBeGreaterThanOrEqual(5);
    expect(r3.notified.length).toBe(r3.recovered.filter((id) => id !== storm.id).length);
  });

  it("an alert suppressed by a root cause is sent once the root cause recovers while it is still failing", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1, "ops.alerts.recoverAfterEvaluations": 1 });
    await beatAs("browser-monitoring-1", "browser-monitoring", { deps: { redis: { ok: true }, gateway: { ok: false }, runner: { ok: false } } });
    await beatAs("http-monitoring-1", "http-monitoring", { deps: { redis: { ok: true }, gateway: { ok: false } } });
    await beatAs("deep-scan-1", "deep-scan", { deps: { redis: { ok: true }, gateway: { ok: false } } });
    await evaluate();
    const runner = (await alerts("runner.failures"))[0];
    expect(runner).toMatchObject({ notify_state: "SUPPRESSED" });
    expect(runner.suppressed_by).not.toBeNull();
    // gateway back, runner still down → the runner alert is now its own problem and is sent
    await beatAs("browser-monitoring-1", "browser-monitoring", { deps: { redis: { ok: true }, gateway: { ok: true }, runner: { ok: false } } });
    await beatAs("http-monitoring-1", "http-monitoring", { deps: { redis: { ok: true }, gateway: { ok: true } } });
    await beatAs("deep-scan-1", "deep-scan", { deps: { redis: { ok: true }, gateway: { ok: true } } });
    const r = await evaluate();
    expect((await alerts("gateway.unavailable"))[0].state).toBe("RECOVERED");
    expect(r.notified).toContain(runner.id);
    expect((await alerts("runner.failures"))[0]).toMatchObject({ state: "OPEN", notify_state: "QUEUED", suppressed_by: null });
  });

  it("flapping inside the cooldown reopens the same alert (no duplicate, no second notification)", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1, "ops.alerts.recoverAfterEvaluations": 1 });
    await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
    await evaluate();
    await beatAs("deep-scan-1", "deep-scan", { deps: { redis: { ok: true }, gateway: { ok: true } } });
    await evaluate();
    await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
    await evaluate();
    const all = await alerts("worker.heartbeat_expired");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ state: "OPEN", reopen_count: 1 });
    const types = (await events(all[0].id)).map((e) => e.type);
    expect(types.filter((t) => t === "NOTIFY_QUEUED")).toHaveLength(2); // opened + the recovery of the first episode; the reopen is not re-sent
    expect(types).toEqual(expect.arrayContaining(["OPENED", "RECOVERED", "REOPENED"]));
  });

  it("disabled rules never open alerts; alerts off evaluates but opens nothing", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1, "ops.alerts.disabledRules": ["rollups.lagging"] });
    await c.query(`UPDATE rollup_state SET last_run_at = now() - interval '2 hours'`);
    await evaluate();
    expect(await alerts("rollups.lagging")).toEqual([]);
    await setSettings(c, { "ops.alerts.enabled": false, "ops.alerts.disabledRules": [] });
    const r = await evaluate();
    expect(r.signals.find((s) => s.rule === "rollups.lagging")?.state).toBe("UNHEALTHY");
    expect(await alerts()).toEqual([]);
  });

  it("concurrent evaluators: only one evaluates per interval (claim), never duplicate alerts", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1 });
    await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
    await c.query(`UPDATE platform_health SET evaluated_at = 'epoch' WHERE component = '__evaluator'`);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => runPlatformEvaluation(deps({ evaluatorId: `ev-${i}` }))));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(await alerts("worker.heartbeat_expired")).toHaveLength(1);
  });
});

// =====================================================================================================
describe("alert delivery: existing outbox → e-mail path, retries, durable failure", () => {
  it("an alert e-mail reaches the operators exactly once (duplicate deliveries of the job are deduplicated), then the recovery", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1, "ops.alerts.recoverAfterEvaluations": 1 });
    const notify = startEmailWorker({ ...process.env, QUEUE_PREFIX: prefix });
    try {
      await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
      await evaluate();
      await relayOutbox(db, queues[EMAIL_QUEUE]!);
      const mail = await waitForEmail(OPS_EMAIL, "worker.heartbeat_expired", { timeoutMs: 20_000 });
      expect(mail.subject).toMatch(/^\[CRITICAL\]/);
      expect(mail.text).not.toMatch(/https?:\/\/(?!localhost)/); // only the console link, no customer URLs
      // duplicate delivery: the same outbox row relayed again + the job re-added → no second e-mail
      const [{ id }] = (await c.query(`SELECT id FROM outbox_events WHERE topic = 'platform.alert' ORDER BY id DESC LIMIT 1`)).rows;
      await c.query(`UPDATE outbox_events SET published_at = NULL WHERE id = $1`, [id]);
      await relayOutbox(db, queues[EMAIL_QUEUE]!);
      await sleep(1500);
      expect(await countEmails(OPS_EMAIL, "worker.heartbeat_expired")).toBe(1);
      const a = (await alerts("worker.heartbeat_expired"))[0];
      await until(async () => (await events(a.id)).some((e) => e.type === "NOTIFY_SENT"), 10_000);
      // recovery notification
      await beatAs("deep-scan-1", "deep-scan", { deps: { redis: { ok: true }, gateway: { ok: true } } });
      await evaluate();
      await relayOutbox(db, queues[EMAIL_QUEUE]!);
      await waitForEmail(OPS_EMAIL, "[RECOVERED]", { timeoutMs: 20_000 });
    } finally {
      await notify.stop();
    }
  }, 60_000);

  it("SMTP outage: delivery is retried with backoff; the failure is recorded durably and becomes visible as a health signal", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1, "ops.alerts.delivery": { attempts: 2, backoffMs: 200 } });
    // a mail relay that accepts the TCP connection and then drops it (transient SMTP failure)
    const socks = new Set<Socket>();
    const bad = createServer((s) => { socks.add(s); s.destroy(); });
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    const notify = startEmailWorker({ ...process.env, QUEUE_PREFIX: prefix, SMTP_PORT: String((bad.address() as { port: number }).port) });
    try {
      await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
      await evaluate();
      await relayOutbox(db, queues[EMAIL_QUEUE]!);
      const a = (await alerts("worker.heartbeat_expired"))[0];
      await until(async () => (await c.query(`SELECT 1 FROM job_failures WHERE queue = 'email' AND job_type = 'EMAIL:PLATFORM_ALERT' AND failed_at > now() - interval '1 minute'`)).rowCount, 30_000, 200);
      const ev = (await events(a.id)).map((e) => e.type);
      expect(ev.filter((t) => t === "NOTIFY_FAILED").length).toBe(2); // both attempts recorded
      expect((await alerts("worker.heartbeat_expired"))[0].notify_state).toBe("FAILED");
      // the next evaluation shows notifications as degraded (delivery failure exposed through operational health)
      const r = await evaluate();
      expect(r.signals.find((s) => s.rule === "notifications.failing")?.state).not.toBe("HEALTHY");
      // retry-safe: the dead-lettered e-mail is not replayable from the console (only monitoring executions are)
      const adm = await adminClient("SUPER_ADMIN");
      const dl = (await adm.cl.get("/api/admin/v1/monitoring/dead-letters?status=OPEN")).body.data.find((x: { queue: string }) => x.queue === "email");
      expect(dl.replayable).toBe(false);
    } finally {
      await notify.stop();
      bad.close();
      for (const s of socks) s.destroy();
    }
  }, 60_000);

  it("PostgreSQL unavailable: a direct alert goes through the e-mail queue, and the outage is recorded once the database is back", async () => {
    const emailQueue = queues[EMAIL_QUEUE]!;
    const watch = new DbOutageWatch({ emailQueue, log, evaluatorId: "outage-test" });
    // a database pool pointed at a closed port behaves like an unreachable PostgreSQL
    const deadDb = createDb({ url: process.env.WORKER_DATABASE_URL!.replace(/:\d+\//, ":1/"), max: 1, omitSecrets: true });
    for (let i = 0; i < 2; i++) await runPlatformEvaluation({ ...deps(), db: deadDb }, { force: true }).catch((e) => watch.failed(e));
    await deadDb.$disconnect().catch(() => undefined);
    const jobs = await emailQueue.getJobs(["wait", "prioritized", "delayed"]);
    expect(jobs.filter((j) => j.name === "PLATFORM_ALERT_DIRECT")).toHaveLength(1);
    const notify = startEmailWorker({ ...process.env, QUEUE_PREFIX: prefix, OPS_FALLBACK_ALERT_EMAILS: OPS_EMAIL });
    try {
      await waitForEmail(OPS_EMAIL, "PostgreSQL unavailable", { timeoutMs: 20_000 });
    } finally {
      await notify.stop();
    }
    await watch.succeeded(db);
    const [a] = await alerts("postgres.unavailable");
    expect(a).toMatchObject({ state: "RECOVERED", severity: "CRITICAL", notify_state: "SENT" });
    expect(new Date(a.opened_at).getTime()).toBeLessThan(new Date(a.recovered_at).getTime());
  }, 60_000);
});

// =====================================================================================================
describe("worker heartbeats from the real runtime", () => {
  it("probes report a dead dependency; a crashed process stops heartbeating and is flagged; a restart is counted", async () => {
    await c.query(`DELETE FROM worker_heartbeats`);
    const sockets = new Set<Socket>();
    const fake = createServer((s) => { sockets.add(s); s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    let gatewayUp = true;
    const hb = createHeartbeat({
      db, connection: redis, log, workerId: "hb-real-1", kind: "deep-scan", probeEveryMs: 0,
      probes: { gateway: async () => { if (!gatewayUp) throw new Error("connect ECONNREFUSED 10.0.0.9:8080 https://customer.example/x"); } },
      gauges: () => ({ activeJobs: 1, capacity: 2, processed: 7, failed: 1, timeouts: 0, lastJobAt: new Date() }),
    });
    await hb.started();
    await hb.beat();
    let row = (await c.query(`SELECT * FROM worker_heartbeats WHERE worker_id = 'hb-real-1'`)).rows[0];
    expect(row).toMatchObject({ kind: "deep-scan", processed: 7, failed: 1, active_jobs: 1, capacity: 2 });
    expect(row.deps.gateway.ok).toBe(true);
    expect(row.deps.redis.ok).toBe(true);
    gatewayUp = false;
    await hb.beat();
    row = (await c.query(`SELECT deps FROM worker_heartbeats WHERE worker_id = 'hb-real-1'`)).rows[0];
    expect(row.deps.gateway).toMatchObject({ ok: false });
    expect(row.deps.gateway.error).not.toMatch(/customer\.example|10\.0\.0\.9/); // sanitised: no URLs or addresses
    // "crash": no more beats; with a short stale window the evaluator flags it
    await setSettings(c, { "ops.health.heartbeatStaleSec": 25 });
    await c.query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '60 seconds' WHERE worker_id = 'hb-real-1'`);
    await beatAs("sched-1", "scheduler");
    const r = await evaluate();
    expect(r.signals.find((s) => s.rule === "worker.heartbeat_expired" && s.subject === "deep-scan")).toMatchObject({ state: "UNHEALTHY" });
    const starts = (await c.query(`SELECT count(*)::int AS n FROM system_health_logs WHERE component = 'worker' AND metric = 'start' AND labels->>'worker' = 'hb-real-1'`)).rows[0].n;
    expect(starts).toBe(1);
    fake.close();
    for (const s of sockets) s.destroy();
  });
});

// =====================================================================================================
describe("Super Admin: permissions, audit, privacy", () => {
  it("health, history and alerts are operational-only; acknowledge needs admin:ops:alerts and is audited; customers are refused", async () => {
    await setSettings(c, { "ops.alerts.openAfterEvaluations": 1 });
    await beatAs("deep-scan-1", "deep-scan", { ageSec: 600 });
    await evaluate();
    const sup = await adminClient("ADMIN_SUPPORT");
    const op = await adminClient("ADMIN_OPERATOR");
    const aud = await adminClient("ADMIN_AUDITOR");
    const health = await sup.cl.get("/api/admin/v1/ops/health");
    expect(health.status).toBe(200);
    expect(health.body.data.workers.find((w: { workerId: string }) => w.workerId === "deep-scan-1")).toMatchObject({ alive: false, state: "UNHEALTHY" });
    expect((await sup.cl.get("/api/admin/v1/ops/history?hours=24")).status).toBe(200);
    expect((await aud.cl.get("/api/admin/v1/ops/health")).status).toBe(403);
    const list = await sup.cl.get("/api/admin/v1/ops/alerts");
    const a = list.body.data.find((x: { rule: string }) => x.rule === "worker.heartbeat_expired");
    expect((await sup.cl.post(`/api/admin/v1/ops/alerts/${a.id}/acknowledge`, { reason: "looking into it" })).status).toBe(403);
    expect((await op.cl.post(`/api/admin/v1/ops/alerts/${a.id}/acknowledge`, { reason: "x" })).status).toBe(400);
    const ack = await op.cl.post(`/api/admin/v1/ops/alerts/${a.id}/acknowledge`, { reason: "investigating OPS-1" });
    expect(ack.status).toBe(200);
    expect(ack.body.data.state).toBe("ACKNOWLEDGED");
    expect((await op.cl.post(`/api/admin/v1/ops/alerts/${a.id}/acknowledge`, { reason: "again please" })).status).toBe(409);
    const audit = (await c.query(`SELECT actor_id, changes, reason FROM audit_logs WHERE action = 'admin.platform_alert_acknowledged' AND target_id = $1`, [a.id])).rows;
    expect(audit).toEqual([expect.objectContaining({ actor_id: op.id, reason: "investigating OPS-1" })]);
    // privacy: nothing customer-shaped anywhere in the operational responses
    const blob = JSON.stringify([health.body, list.body, (await sup.cl.get(`/api/admin/v1/ops/alerts/${a.id}`)).body]);
    expect(blob).not.toMatch(/https?:\/\/(?!localhost)/);
    expect(blob).not.toMatch(/org_id|orgId|websiteId|canonical/);
    // customers never reach admin APIs
    const cust = await userWithOrg(h.app, "opsCust");
    expect((await cust.client.get("/api/admin/v1/ops/health")).status).toBe(401);
  });

  it("the admin database role reads operational tables but cannot forge alerts, edit history or read customer origins", async () => {
    const admin = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    try {
      await expect(admin.$executeRaw`INSERT INTO platform_alerts (fingerprint, rule, component, severity, state, reason) VALUES ('x', 'x', 'x', 'INFO', 'OPEN', 'x')`).rejects.toThrow(/permission denied/);
      await expect(admin.$executeRaw`UPDATE platform_alerts SET reason = 'edited'`).rejects.toThrow(/permission denied/);
      await expect(admin.$executeRaw`DELETE FROM platform_alert_events`).rejects.toThrow(/permission denied/);
      await expect(admin.$executeRaw`UPDATE platform_health SET state = 'HEALTHY'`).rejects.toThrow(/permission denied/);
      await expect(admin.$queryRaw`SELECT canonical_origin FROM websites LIMIT 1`).rejects.toThrow(/permission denied/);
      await expect(admin.$executeRaw`UPDATE usage_counters SET value = 0`).rejects.toThrow(/permission denied/);
      await expect(admin.$executeRaw`INSERT INTO usage_adjustments (org_id, day, key, delta, reason, actor_id) VALUES (gen_random_uuid(), current_date, 'http.checks', 1, 'xxxxxxxxxxxx', gen_random_uuid())`).rejects.toThrow(/permission denied/);
    } finally {
      await admin.$disconnect();
    }
    // the worker role cannot rewrite alert history either (append-only), nor touch adjustments
    await expect(db.$executeRaw`UPDATE platform_alert_events SET type = 'X'`).rejects.toThrow(/append-only|permission denied/);
    await expect(db.$executeRaw`INSERT INTO usage_adjustments (org_id, day, key, delta, reason, actor_id) VALUES (gen_random_uuid(), current_date, 'http.checks', 1, 'xxxxxxxxxxxx', gen_random_uuid())`).rejects.toThrow(/permission denied/);
    // customers: no access at all
    const app = createDb({ url: process.env.DATABASE_URL!, max: 1, omitSecrets: true });
    try {
      await expect(app.$queryRaw`SELECT * FROM platform_alerts`).rejects.toThrow(/permission denied/);
      await expect(app.$queryRaw`SELECT * FROM platform_health`).rejects.toThrow(/permission denied/);
      await expect(app.$queryRaw`SELECT * FROM usage_discrepancies`).rejects.toThrow(/permission denied/);
    } finally {
      await app.$disconnect();
    }
  });
});
