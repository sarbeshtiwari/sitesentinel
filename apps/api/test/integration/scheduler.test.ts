import { spawn } from "node:child_process";
import { createServer, Socket, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type pg from "pg";
import { createDb } from "@wim/db";
import { PermanentError, TransientError, type ExecutionContext } from "@wim/queue";
import {
  executions, makeDue, owner, PREFIX, resetMonitoringSettings, rig, schedules, seedOrg, setSettings, sleep, until, type Rig, type SeededOrg,
} from "../helpers/monitoring.js";

/**
 * Phase 4B — scheduler and queue infrastructure against real PostgreSQL (wim_test) and Redis.
 * Monitoring engines don't exist yet: handlers here are synthetic and make no network calls.
 */
let c: pg.Client;
let r: Rig;
const seeded: string[] = [];
const seed = async (n: number, opts?: Parameters<typeof seedOrg>[2]): Promise<SeededOrg> => {
  const o = await seedOrg(c, n, opts);
  seeded.push(o.orgId);
  return o;
};
const HTTP_ON = { "monitoring.http.enabled": true };
const FAST_QUEUE = { concurrency: 10, globalConcurrency: 100, ratePerSecond: 1000, attempts: 3, backoffBaseMs: 100, backoffMaxMs: 1000, timeoutMs: 5000, keepCompletedHours: 1, keepFailedDays: 1 };

// The scheduler is platform-wide: tenants left active by other suites would be scheduled too.
// Park them for the duration of this file and restore them afterwards.
let parked: string[] = [];
beforeAll(async () => {
  c = owner();
  await c.connect();
  r = rig();
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
});
beforeEach(async () => {
  await resetMonitoringSettings(c);
  await setSettings(c, { "scheduler.reconcileAfterSec": 5, "scheduler.leaseSec": 10, "queue.http-monitoring": FAST_QUEUE });
});
afterEach(async () => {
  await r.stopWorkers();
  // Retire this test's tenants and drain the queues so tests don't share work.
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [seeded]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE monitoring_schedules SET status = 'PAUSED', paused_reason = 'ORG_SUSPENDED' WHERE org_id = ANY($1::uuid[])`, [seeded]);
  for (const q of [...Object.values(r.queues), r.dlq]) await q.obliterate({ force: true });
  const keys = await r.redis.keys(`${PREFIX}:sem:*`);
  if (keys.length) await r.redis.del(...keys);
});
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  await r.close();
  await c.end();
});

const jobsOf = async (q: Queue) => q.getJobs(["waiting", "prioritized", "delayed", "active", "completed", "failed"]);

// =====================================================================================================
describe("scheduler: intervals, entitlements, eligibility", () => {
  it("creates one schedule per website and tier with the default intervals; disabled tiers schedule nothing", async () => {
    const o = await seed(2);
    const rep = await r.scheduler().runCycle();
    const sch = await schedules(c, [o.orgId]);
    expect(sch).toHaveLength(6);
    const byTier = Object.fromEntries(sch.filter((x) => x.website_id === o.websiteIds[0]).map((x) => [x.tier, x]));
    expect(byTier.T1_HTTP).toMatchObject({ interval_sec: 60, status: "PAUSED", paused_reason: "TIER_DISABLED" });
    expect(byTier.T2_RENDER).toMatchObject({ interval_sec: 900, status: "PAUSED", paused_reason: "TIER_DISABLED" });
    expect(byTier.T3_DEEP).toMatchObject({ interval_sec: 86_400, status: "PAUSED", paused_reason: "TIER_DISABLED" });
    for (const s of sch) expect(s.jitter_sec).toBeLessThan(s.interval_sec);
    expect(rep.dispatched).toEqual({ HTTP: 0, BROWSER: 0, DEEPSCAN: 0 });
    expect(await executions(c, [o.orgId])).toHaveLength(0);
  });

  it("dispatches one execution per website per window, with an id-only payload, and advances the schedule", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(3);
    const s = r.scheduler();
    await s.runCycle();
    const ex = await executions(c, [o.orgId]);
    expect(ex).toHaveLength(3);
    expect(new Set(ex.map((e) => e.website_id))).toEqual(new Set(o.websiteIds));
    expect(ex.every((e) => e.status === "QUEUED" && e.tier === "T1_HTTP" && e.trigger === "SCHEDULE")).toBe(true);
    const sch = (await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP");
    for (const sc of sch) {
      const e = ex.find((x) => x.schedule_id === sc.id)!;
      // window start is aligned to interval + jitter, next run is the next window
      expect((e.queued_at.getTime() / 1000 - sc.jitter_sec) % 60).toBe(0);
      expect(sc.next_run_at.getTime()).toBe(e.queued_at.getTime() + 60_000);
    }
    const jobs = await jobsOf(r.queues.HTTP);
    expect(jobs).toHaveLength(3);
    for (const j of jobs) {
      expect(Object.keys(j.data).sort()).toEqual(["executionId", "v", "windowStart"]);
      expect(j.id).toBe(j.data.executionId);
    }
    // the same window again: nothing new
    await s.runCycle();
    expect(await executions(c, [o.orgId])).toHaveLength(3);
    // browser and deep scan remain disabled
    expect((await r.queues.BROWSER.getJobCounts()).waiting ?? 0).toBe(0);
    expect((await r.queues.DEEPSCAN.getJobCounts()).waiting ?? 0).toBe(0);
  });

  it("applies admin interval changes, plan entitlements and org overrides (customers can only slow down)", async () => {
    await setSettings(c, { ...HTTP_ON, "monitoring.http.intervalSec": 120 });
    const o = await seed(3);
    await r.scheduler().runCycle();
    expect((await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP").map((x) => x.interval_sec)).toEqual([120, 120, 120]);

    const { rows: [plan] } = await c.query<{ id: string }>(`INSERT INTO subscription_plans (key, name, description, updated_at) VALUES ($1, 'P', 'P', now()) RETURNING id`, [`p4b-${o.orgId.slice(0, 8)}`]);
    await c.query(`INSERT INTO plan_entitlements (plan_id, key, value) VALUES ($1, 'monitoring.http.minIntervalSec', '300'), ($1, 'monitoring.maxWebsites', '2')`, [plan!.id]);
    await c.query(`INSERT INTO subscriptions (org_id, plan_id, status, current_period_end, updated_at) VALUES ($1, $2, 'ACTIVE', now() + interval '30 days', now())`, [o.orgId, plan!.id]);
    await r.scheduler().runCycle();
    let sch = (await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP");
    expect(sch.filter((x) => x.status === "ACTIVE").map((x) => x.interval_sec)).toEqual([300, 300]);
    expect(sch.find((x) => x.website_id === o.websiteIds[2])).toMatchObject({ status: "PAUSED", paused_reason: "WEBSITE_LIMIT" });

    // An admin override beats the plan.
    const admin = await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
    await c.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.maxWebsites', '3', 'test', $2)`, [o.orgId, admin.rows[0]!.id]);
    // The customer asks for 600 s on one website: slower is allowed.
    await c.query(`INSERT INTO monitoring_configurations (org_id, website_id, t1_interval_sec, updated_at) VALUES ($1, $2, 600, now())`, [o.orgId, o.websiteIds[0]]);
    await r.scheduler().runCycle();
    sch = (await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP");
    expect(sch.every((x) => x.status === "ACTIVE")).toBe(true);
    expect(sch.find((x) => x.website_id === o.websiteIds[0])!.interval_sec).toBe(600);
    // ...but faster than the entitled minimum is not.
    await c.query(`UPDATE monitoring_configurations SET t1_interval_sec = 30 WHERE website_id = $1`, [o.websiteIds[0]]);
    await r.scheduler().runCycle();
    expect((await schedules(c, [o.orgId])).find((x) => x.website_id === o.websiteIds[0] && x.tier === "T1_HTTP")!.interval_sec).toBe(300);

    await c.query(`INSERT INTO entitlement_overrides (org_id, key, value, reason, created_by_id) VALUES ($1, 'monitoring.entitled', 'false', 'test', $2)`, [o.orgId, admin.rows[0]!.id]);
    await r.scheduler().runCycle();
    expect((await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP").every((x) => x.paused_reason === "NOT_ENTITLED")).toBe(true);
  });

  it("expired trials, paused/archived/lapsed websites and suspended organisations get no executions", async () => {
    await setSettings(c, HTTP_ON);
    const expired = await seed(1, { trial: "EXPIRED" });
    const noPlan = await seed(1, { trial: "NONE" });
    const o = await seed(4);
    await c.query(`UPDATE websites SET status = 'PAUSED' WHERE id = $1`, [o.websiteIds[0]]);
    await c.query(`UPDATE websites SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [o.websiteIds[1]]);
    await c.query(`UPDATE websites SET status = 'LAPSED' WHERE id = $1`, [o.websiteIds[2]]);
    await c.query(`UPDATE domain_claims SET status = 'LAPSED' WHERE id = (SELECT domain_claim_id FROM websites WHERE id = $1)`, [o.websiteIds[2]]);
    const suspended = await seed(1);
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [suspended.orgId]);
    await r.scheduler().runCycle();
    const reason = async (org: string, w: string) => (await schedules(c, [org])).find((x) => x.website_id === w && x.tier === "T1_HTTP")?.paused_reason ?? null;
    expect(await reason(expired.orgId, expired.websiteIds[0]!)).toBe("NOT_ENTITLED");
    expect(await reason(noPlan.orgId, noPlan.websiteIds[0]!)).toBe("NOT_ENTITLED");
    expect(await reason(o.orgId, o.websiteIds[0]!)).toBe("WEBSITE_PAUSED");
    expect(await reason(o.orgId, o.websiteIds[1]!)).toBeNull(); // archived before it was ever scheduled: no schedule at all
    expect(await reason(o.orgId, o.websiteIds[2]!)).toBe("OWNERSHIP_LAPSED");
    expect(await reason(suspended.orgId, suspended.websiteIds[0]!)).toBe("ORG_SUSPENDED");
    const ex = await executions(c, [expired.orgId, noPlan.orgId, o.orgId, suspended.orgId]);
    expect(ex.map((e) => e.website_id)).toEqual([o.websiteIds[3]]);

    // Revalidation restores the lapsed website → scheduling resumes; suspension of the org pauses everything.
    await c.query(`UPDATE websites SET status = 'ACTIVE' WHERE id = $1`, [o.websiteIds[2]]);
    await c.query(`UPDATE domain_claims SET status = 'VERIFIED' WHERE id = (SELECT domain_claim_id FROM websites WHERE id = $1)`, [o.websiteIds[2]]);
    await r.scheduler().runCycle();
    expect(await reason(o.orgId, o.websiteIds[2]!)).toBeNull();
    expect((await executions(c, [o.orgId])).map((e) => e.website_id).sort()).toEqual([o.websiteIds[2], o.websiteIds[3]].sort());
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [o.orgId]);
    await r.scheduler().runCycle();
    expect((await executions(c, [o.orgId])).every((e) => e.status === "CANCELLED")).toBe(true);
  });

  it("after downtime, missed windows are counted, not back-filled; a restarted scheduler continues without duplicates", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(2);
    await r.scheduler("before-crash").runCycle();
    await c.query(`UPDATE monitoring_executions SET status = 'SUCCEEDED', queued_at = queued_at - interval '600 seconds', slot = slot - 600 WHERE org_id = $1`, [o.orgId]);
    // 10 windows pass while no scheduler is running
    await makeDue(c, [o.orgId], 600);
    const restarted = r.scheduler("after-restart");
    const rep = await restarted.runCycle();
    expect(rep.missedWindows).toBeGreaterThanOrEqual(2 * 9);
    const ex = await executions(c, [o.orgId]);
    expect(ex).toHaveLength(4); // one per website before, one per website now — no catch-up burst
    const sch = (await schedules(c, [o.orgId])).filter((x) => x.tier === "T1_HTTP");
    expect(sch.every((x) => x.missed_slots >= 9 && x.next_run_at.getTime() > Date.now())).toBe(true);
    await restarted.runCycle();
    expect(await executions(c, [o.orgId])).toHaveLength(4);
  });
});

// =====================================================================================================
describe("idempotency and concurrency", () => {
  it("five scheduler instances with separate connections running simultaneously never duplicate a window", async () => {
    await setSettings(c, { ...HTTP_ON, "monitoring.limits.perCycleQuota": 100, "monitoring.limits.maxOutstandingJobs": 1000 });
    const orgs = [await seed(12), await seed(12), await seed(6)];
    const ids = orgs.map((o) => o.orgId);
    const dbs = Array.from({ length: 5 }, () => createDb({ url: process.env.WORKER_DATABASE_URL!, max: 4, omitSecrets: true }));
    const instances = dbs.map((db, i) => r.scheduler(`concurrent-${i}`, { db }));
    for (let round = 0; round < 3; round++) {
      await Promise.all(instances.flatMap((s) => [s.runCycle(), s.runCycle()]));
    }
    const ex = await executions(c, ids);
    // The property under test: no (schedule, window) is ever dispatched twice, and every website got its window.
    // (If the rounds straddle a schedule boundary, a website can legitimately get its NEXT window as well — CI saw
    // 31 once; that is a distinct window, not a duplicate. A duplicate would make keys < executions.)
    const keys = ex.map((e) => `${e.schedule_id}|${e.queued_at.toISOString()}`);
    expect(new Set(keys).size).toBe(ex.length);
    expect(new Set(ex.map((e) => e.schedule_id)).size).toBe(30);
    expect(ex.length).toBeLessThanOrEqual(60);
    expect(await r.queues.HTTP.count()).toBe(ex.length);
    // New window: everyone races again; exactly one more execution per website.
    await c.query(`UPDATE monitoring_executions SET status = 'SUCCEEDED' WHERE org_id = ANY($1::uuid[])`, [ids]);
    await c.query(`UPDATE monitoring_executions SET queued_at = queued_at - interval '60 seconds', slot = slot - 60 WHERE org_id = ANY($1::uuid[])`, [ids]);
    await makeDue(c, ids, 1);
    await Promise.all(instances.flatMap((s) => [s.runCycle(), s.runCycle()]));
    const ex2 = await executions(c, ids);
    // Every website got its new window, nothing was duplicated. As above, a boundary crossing can add a website's
    // following window too (CI saw +31 once) — a distinct window, so the count is bounded, not exact.
    expect(new Set(ex2.map((e) => `${e.schedule_id}|${e.queued_at.toISOString()}`)).size).toBe(ex2.length);
    const before = new Set(ex.map((e) => e.id));
    expect(new Set(ex2.filter((e) => !before.has(e.id)).map((e) => e.schedule_id)).size).toBe(30);
    expect(ex2.length - ex.length).toBeLessThanOrEqual(60);
    for (const db of dbs) await db.$disconnect();
  });

  it("the database rejects a second execution for the same schedule window even if a scheduler bug tried", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(1);
    await r.scheduler().runCycle();
    const [e] = await executions(c, [o.orgId]);
    await expect(c.query(
      `INSERT INTO monitoring_executions (org_id, website_id, schedule_id, slot, queued_at, tier) SELECT org_id, website_id, schedule_id, slot, queued_at, tier FROM monitoring_executions WHERE id = $1`,
      [e!.id])).rejects.toThrow(/duplicate key/);
  });

  it("crash after commit, before enqueue: the execution is re-enqueued exactly once by reconcile", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(3);
    const crashing = r.scheduler("crashing", { afterCommitHook: () => { throw new Error("simulated crash"); } });
    const rep = await crashing.runCycle();
    expect(rep.enqueueErrors).toBe(1);
    let ex = await executions(c, [o.orgId]);
    expect(ex.map((e) => e.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED"]);
    expect(await r.queues.HTTP.count()).toBe(0);
    // A healthy instance doesn't create new executions for the window, and reconciles once the grace period passed.
    const healthy = r.scheduler("healthy");
    await healthy.runCycle();
    expect(await executions(c, [o.orgId])).toHaveLength(3);
    await c.query(`UPDATE monitoring_executions SET enqueued_at = now() - interval '10 seconds' WHERE org_id = $1`, [o.orgId]);
    const rep2 = await healthy.runCycle();
    expect(rep2.reconciled.reenqueued).toBe(3);
    ex = await executions(c, [o.orgId]);
    expect(ex.map((e) => e.status)).toEqual(["QUEUED", "QUEUED", "QUEUED"]);
    expect(await r.queues.HTTP.count()).toBe(3);
    await healthy.runCycle();
    expect(await r.queues.HTTP.count()).toBe(3);
  });

  it("Redis interruption: scheduling state survives in PostgreSQL and is re-enqueued after recovery; lost queue data is rebuilt", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(2);
    const url = new URL(process.env.REDIS_URL!);
    // A cuttable TCP path between the scheduler and Redis.
    const sockets = new Set<Socket>();
    let open = true;
    const proxy: Server = createServer((client) => {
      if (!open) return client.destroy();
      const upstream = new Socket().connect(Number(url.port), url.hostname);
      sockets.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      const done = () => { client.destroy(); upstream.destroy(); };
      client.on("error", done).on("close", done);
      upstream.on("error", done).on("close", done);
    });
    await new Promise<void>((res) => proxy.listen(0, "127.0.0.1", res));
    const port = (proxy.address() as { port: number }).port;
    const viaProxy = new Redis({
      host: "127.0.0.1", port, db: Number(url.pathname.slice(1) || 0), username: url.username || undefined, password: decodeURIComponent(url.password) || undefined,
      maxRetriesPerRequest: 1, retryStrategy: () => 200,
    });
    const s = r.scheduler("redis-flaky", { redis: viaProxy });
    await viaProxy.ping();
    open = false;
    for (const k of sockets) k.destroy();
    const rep = await s.runCycle();
    expect(rep.enqueueErrors).toBeGreaterThan(0);
    expect((await executions(c, [o.orgId])).map((e) => e.status)).toEqual(["SCHEDULED", "SCHEDULED"]);
    open = true;
    await until(async () => (await viaProxy.ping().catch(() => null)) === "PONG");
    await c.query(`UPDATE monitoring_executions SET enqueued_at = now() - interval '10 seconds' WHERE org_id = $1`, [o.orgId]);
    await s.runCycle();
    expect((await executions(c, [o.orgId])).map((e) => e.status)).toEqual(["QUEUED", "QUEUED"]);
    expect(await r.queues.HTTP.count()).toBe(2);

    // Redis loses the queue entirely (restart without persistence): reconcile rebuilds it from PostgreSQL.
    const keys = await r.redis.keys(`${PREFIX}:http-monitoring:*`);
    await r.redis.del(...keys);
    expect(await r.queues.HTTP.count()).toBe(0);
    await c.query(`UPDATE monitoring_executions SET enqueued_at = now() - interval '10 seconds' WHERE org_id = $1`, [o.orgId]);
    const rep3 = await s.runCycle();
    expect(rep3.reconciled.reenqueued).toBe(2);
    expect(await r.queues.HTTP.count()).toBe(2);
    expect(await executions(c, [o.orgId])).toHaveLength(2);
    viaProxy.disconnect();
    proxy.close();
  });

  it("worker killed mid-execution (SIGKILL): the job is recovered by another worker after the lease expires", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(1);
    await r.scheduler().runCycle();
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "fixtures", "crash-worker.mjs")], {
      env: { ...process.env, TEST_PREFIX: PREFIX, TEST_WORKER_ID: "doomed-worker" }, stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    await until(async () => out.includes("RUNNING"), 20_000);
    const [running] = await executions(c, [o.orgId]);
    expect(running).toMatchObject({ status: "RUNNING", attempt: 1 });
    child.kill("SIGKILL");
    await new Promise((res) => child.once("exit", res));

    const seen: ExecutionContext[] = [];
    const w = r.worker("HTTP", async (ctx) => { seen.push(ctx); return { summary: { synthetic: true } }; }, { workerId: "rescuer" });
    await w.start();
    const done = await until(async () => {
      const [e] = await executions(c, [o.orgId]);
      return e?.status === "SUCCEEDED" ? e : null;
    }, 45_000, 250);
    expect(done.attempt).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: o.orgId, websiteId: o.websiteIds[0], attempt: 2 });
    expect(await executions(c, [o.orgId])).toHaveLength(1);
    await w.stop();
  }, 90_000);
});

// =====================================================================================================
describe("tenant fairness and resource limits", () => {
  it("a tenant with 40 websites cannot starve small tenants: per-cycle quota and interleaved queue order", async () => {
    await setSettings(c, { ...HTTP_ON, "monitoring.limits.perCycleQuota": 5, "monitoring.limits.maxOutstandingJobs": 100 });
    const big = await seed(40, { tag: "big" });
    const small = [await seed(2, { tag: "s1" }), await seed(2, { tag: "s2" }), await seed(2, { tag: "s3" })];
    const s = r.scheduler();
    await s.runCycle();
    const ex = await executions(c, [big.orgId, ...small.map((x) => x.orgId)]);
    expect(ex.filter((e) => e.org_id === big.orgId)).toHaveLength(5);
    for (const sm of small) expect(ex.filter((e) => e.org_id === sm.orgId)).toHaveLength(2);
    // Queue order alternates tenants: the first 8 jobs include every small tenant's work.
    const ordered = (await r.queues.HTTP.getJobs(["waiting", "prioritized"], 0, -1, true)).map((j) => ex.find((e) => e.id === j.id)!.org_id);
    const firstEight = ordered.slice(0, 8);
    for (const sm of small) expect(firstEight.filter((x) => x === sm.orgId).length).toBe(2);

    // Processing order: small tenants finish within the first round of starts.
    const order: string[] = [];
    const w = r.worker("HTTP", async (ctx) => { order.push(ctx.orgId); await sleep(20); });
    await w.start();
    await until(async () => order.length >= 11);
    const smallIdx = order.map((x, i) => (x === big.orgId ? -1 : i)).filter((i) => i >= 0);
    expect(Math.max(...smallIdx)).toBeLessThan(11);
    await w.stop();
  });

  it("per-organisation concurrency: the large tenant never exceeds its limit while others proceed", async () => {
    await setSettings(c, { ...HTTP_ON, "monitoring.limits.maxConcurrentJobs": 2, "monitoring.limits.perCycleQuota": 20, "monitoring.limits.maxOutstandingJobs": 100 });
    const big = await seed(12, { tag: "big" });
    const small = await seed(4, { tag: "small" });
    await r.scheduler().runCycle();
    const running = new Map<string, number>();
    const peak = new Map<string, number>();
    let overallPeak = 0;
    let now = 0;
    const handler = async (ctx: ExecutionContext) => {
      running.set(ctx.orgId, (running.get(ctx.orgId) ?? 0) + 1);
      now++;
      peak.set(ctx.orgId, Math.max(peak.get(ctx.orgId) ?? 0, running.get(ctx.orgId)!));
      overallPeak = Math.max(overallPeak, now);
      await sleep(250);
      running.set(ctx.orgId, running.get(ctx.orgId)! - 1);
      now--;
    };
    const w1 = r.worker("HTTP", handler);
    const w2 = r.worker("HTTP", handler);
    await w1.start();
    await w2.start();
    await until(async () => (await executions(c, [big.orgId, small.orgId])).every((e) => e.status === "SUCCEEDED"), 40_000, 250);
    expect(peak.get(big.orgId)).toBeLessThanOrEqual(2);
    expect(peak.get(small.orgId)).toBeLessThanOrEqual(2);
    expect(overallPeak).toBeGreaterThanOrEqual(3); // small tenant ran alongside the large one
    await w1.stop();
    await w2.stop();
  }, 60_000);

  it("global concurrency limit holds across worker processes", async () => {
    await setSettings(c, { ...HTTP_ON, "queue.http-monitoring": { ...FAST_QUEUE, globalConcurrency: 3 }, "monitoring.limits.maxConcurrentJobs": 50, "monitoring.limits.perCycleQuota": 50 });
    const orgs = [await seed(5), await seed(5)];
    await r.scheduler().runCycle();
    let now = 0;
    let peak = 0;
    const handler = async () => { now++; peak = Math.max(peak, now); await sleep(200); now--; };
    const ws = [r.worker("HTTP", handler), r.worker("HTTP", handler)];
    for (const w of ws) await w.start();
    await until(async () => (await executions(c, orgs.map((o) => o.orgId))).every((e) => e.status === "SUCCEEDED"), 40_000, 250);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2);
    for (const w of ws) await w.stop();
  }, 60_000);

  it("backpressure: outstanding jobs are capped per organisation and platform-wide when workers fall behind", async () => {
    await setSettings(c, { ...HTTP_ON, "monitoring.limits.perCycleQuota": 50, "monitoring.limits.maxOutstandingJobs": 4 });
    const big = await seed(20, { tag: "flood" });
    const s = r.scheduler();
    for (let i = 0; i < 3; i++) {
      await s.runCycle();
      await makeDue(c, [big.orgId]);
    }
    const outstanding = (await executions(c, [big.orgId])).filter((e) => ["SCHEDULED", "QUEUED", "RUNNING", "RETRYING"].includes(e.status));
    expect(outstanding).toHaveLength(4);

    // Platform-wide: a fresh flood with the global cap at 10 outstanding HTTP jobs.
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [big.orgId]);
    await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE org_id = $1`, [big.orgId]);
    await setSettings(c, { "monitoring.limits.maxOutstandingJobs": 1000, "monitoring.global.maxOutstandingJobs": 10 });
    const flood = await seed(20, { tag: "flood2" });
    const rep = await s.runCycle();
    const outstandingHttp = async () => Number((await c.query(`SELECT count(*) FROM monitoring_executions WHERE tier = 'T1_HTTP' AND status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`)).rows[0].count);
    expect(await outstandingHttp()).toBe(10);
    expect(rep.dispatched.HTTP).toBe(10);
    await makeDue(c, [flood.orgId, big.orgId]);
    const rep2 = await s.runCycle();
    expect(rep2.backpressure).toContain("HTTP");
    expect(rep2.dispatched.HTTP).toBe(0);
    expect(await outstandingHttp()).toBe(10);
  });

  it("usage is accounted per organisation and monitoring type", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(2);
    await r.scheduler().runCycle();
    let n = 0;
    const w = r.worker("HTTP", async () => {
      if (n++ === 0) throw new TransientError("upstream reset");
      return { usage: { "deepscan.pages": 0, "probe.bytes": 1234 } };
    });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => e.status === "SUCCEEDED"));
    const { rows } = await c.query<{ key: string; value: string }>(`SELECT key, value::text FROM usage_counters WHERE org_id = $1 ORDER BY key`, [o.orgId]);
    const u = Object.fromEntries(rows.map((x) => [x.key, Number(x.value)]));
    expect(u["exec.http.ok"]).toBe(2);
    expect(u["exec.http.failed"]).toBe(1);
    expect(u["exec.http.retries"]).toBe(1);
    expect(u["exec.http.ms"] ?? 0).toBeGreaterThanOrEqual(0); // zero-valued counters are not written
    expect(u["probe.bytes"]).toBe(2468);
    await w.stop();
  });
});

// =====================================================================================================
describe("security of queue consumption", () => {
  it("rejects forged, malformed, mistyped and cross-queue jobs without running them or retrying", async () => {
    await setSettings(c, HTTP_ON);
    const a = await seed(1);
    const b = await seed(1);
    await r.scheduler().runCycle();
    const [ea] = await executions(c, [a.orgId]);
    // An execution of another tier placed in the HTTP queue.
    const { rows: [browserExec] } = await c.query<{ id: string; queued_at: Date }>(
      `INSERT INTO monitoring_executions (org_id, website_id, tier, status, queued_at) VALUES ($1, $2, 'T2_RENDER', 'QUEUED', date_trunc('milliseconds', now())) RETURNING id, queued_at`, [a.orgId, a.websiteIds[0]]);
    // A row claiming org A for org B's website (cannot be produced by the scheduler).
    const { rows: [crossTenant] } = await c.query<{ id: string; queued_at: Date }>(
      `INSERT INTO monitoring_executions (org_id, website_id, tier, status, queued_at) VALUES ($1, $2, 'T1_HTTP', 'QUEUED', date_trunc('milliseconds', now())) RETURNING id, queued_at`, [a.orgId, b.websiteIds[0]]);
    const ran: ExecutionContext[] = [];
    const w = r.worker("HTTP", async (ctx) => { ran.push(ctx); });
    const q = r.queues.HTTP;
    await q.obliterate({ force: true });
    const forged = [
      { name: "EXECUTE", data: { v: 1, executionId: ea!.id, windowStart: ea!.queued_at.toISOString(), orgId: b.orgId }, id: "f-extra-org" },
      { name: "EXECUTE", data: { v: 1, executionId: ea!.id, windowStart: ea!.queued_at.toISOString(), url: "http://169.254.169.254/" }, id: "f-url" },
      { name: "SHELL", data: { v: 1, executionId: ea!.id, windowStart: ea!.queued_at.toISOString() }, id: ea!.id },
      { name: "EXECUTE", data: { v: 1, executionId: "6f0c0d5e-0000-4000-8000-000000000000", windowStart: new Date().toISOString() }, id: "6f0c0d5e-0000-4000-8000-000000000000" },
      { name: "EXECUTE", data: "rm -rf /", id: "f-string" },
      { name: "EXECUTE", data: { v: 1, executionId: ea!.id, windowStart: ea!.queued_at.toISOString() }, id: "not-the-execution-id" },
      { name: "EXECUTE", data: { v: 1, executionId: browserExec!.id, windowStart: browserExec!.queued_at.toISOString() }, id: browserExec!.id },
      { name: "EXECUTE", data: { v: 1, executionId: crossTenant!.id, windowStart: crossTenant!.queued_at.toISOString() }, id: crossTenant!.id },
    ];
    for (const f of forged) await q.add(f.name, f.data as never, { jobId: f.id, attempts: 5, backoff: { type: "fixed", delay: 100 } });
    await w.start();
    await until(async () => (await q.getFailedCount()) === forged.length);
    expect(ran).toHaveLength(0);
    const failed = await q.getFailed();
    for (const j of failed) {
      expect(j.attemptsMade).toBe(1); // never retried
      expect(j.failedReason).toMatch(/^SECURITY: [a-z ]+$/); // reason only, never payload content
    }
    const { rows } = await c.query<{ failure_category: string; payload: unknown; error: string }>(
      `SELECT failure_category, payload, error FROM job_failures WHERE queue = 'http-monitoring' AND failed_at > now() - interval '1 minute' AND failure_category = 'SECURITY'`);
    expect(rows.length).toBeGreaterThanOrEqual(forged.length);
    for (const row of rows) expect(row.payload).toEqual({}); // untrusted payloads are never stored
    const reasons = rows.map((x) => x.error);
    expect(reasons).toEqual(expect.arrayContaining(["malformed payload", "unknown job type", "unknown execution", "job id does not match execution", "execution belongs to another queue", "execution tenant does not own the website"]));
    // The legitimate execution is untouched and still runnable.
    expect((await executions(c, [a.orgId])).find((e) => e.id === ea!.id)!.status).toBe("QUEUED");
    await w.stop();
  });

  it("eligibility is re-checked at execution time: suspended org, deleted and paused websites are skipped", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(3);
    const suspended = await seed(1);
    await r.scheduler().runCycle();
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [suspended.orgId]);
    await c.query(`UPDATE websites SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [o.websiteIds[0]]);
    await c.query(`UPDATE websites SET status = 'PAUSED' WHERE id = $1`, [o.websiteIds[1]]);
    const ran: string[] = [];
    const w = r.worker("HTTP", async (ctx) => { ran.push(ctx.websiteId); });
    await w.start();
    await until(async () => (await executions(c, [o.orgId, suspended.orgId])).every((e) => !["QUEUED", "RUNNING"].includes(e.status)));
    const ex = await executions(c, [o.orgId, suspended.orgId]);
    const by = (wid: string) => ex.find((e) => e.website_id === wid)!;
    expect(by(o.websiteIds[0]!)).toMatchObject({ status: "SKIPPED", failure_category: "INELIGIBLE", error_message: "WEBSITE_INACTIVE" });
    expect(by(o.websiteIds[1]!)).toMatchObject({ status: "SKIPPED", error_message: "WEBSITE_PAUSED" });
    expect(by(suspended.websiteIds[0]!)).toMatchObject({ status: "SKIPPED", error_message: "ORG_SUSPENDED" });
    expect(by(o.websiteIds[2]!).status).toBe("SUCCEEDED");
    expect(ran).toEqual([o.websiteIds[2]]);
    await w.stop();
  });

  it("no secrets in queue payloads, failure records, error messages or logs", async () => {
    await setSettings(c, { ...HTTP_ON, "queue.http-monitoring": { ...FAST_QUEUE, attempts: 1 } });
    const o = await seed(2);
    await r.scheduler().runCycle();
    const w = r.worker("HTTP", async (ctx) => {
      if (ctx.websiteId === o.websiteIds[0]) throw new PermanentError(`GET https://w0.example/login?token=${o.tokens[0]}&x=1 failed with key ${o.siteKeys[0]}`);
    });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => ["SUCCEEDED", "DEAD_LETTERED"].includes(e.status)));
    const secrets = [...o.tokens, ...o.siteKeys];
    const redisDump = JSON.stringify(await Promise.all((await r.redis.keys(`${PREFIX}:*`)).map(async (k) => {
      const t = await r.redis.type(k);
      return t === "hash" ? r.redis.hgetall(k) : t === "list" ? r.redis.lrange(k, 0, -1) : t === "zset" ? r.redis.zrange(k, "0", "-1") : t === "string" ? r.redis.get(k) : null;
    })));
    const failures = JSON.stringify((await c.query(`SELECT * FROM job_failures WHERE org_id = $1`, [o.orgId])).rows);
    const execs = JSON.stringify(await executions(c, [o.orgId]));
    for (const secret of secrets) {
      expect(redisDump).not.toContain(secret);
      expect(failures).not.toContain(secret);
      expect(execs).not.toContain(secret);
      expect(r.logs.join("")).not.toContain(secret);
    }
    expect(failures).toContain("[redacted]");
    expect(failures).toContain("[url]");
    expect(failures).not.toContain("w0.example"); // customer domains never reach failure records
    expect(redisDump).not.toContain("w0.");
    await w.stop();
  });

  it("the customer API role cannot write schedules, executions or dead letters", async () => {
    const app = createDb({ url: process.env.DATABASE_URL!, max: 1, omitSecrets: true });
    await expect(app.$executeRaw`UPDATE monitoring_schedules SET status = 'ACTIVE'`).rejects.toThrow(/permission denied/);
    await expect(app.$executeRaw`INSERT INTO monitoring_executions (org_id, website_id, tier) VALUES (gen_random_uuid(), gen_random_uuid(), 'T1_HTTP')`).rejects.toThrow(/permission denied/);
    await expect(app.$executeRaw`UPDATE job_failures SET replay_requested_at = now()`).rejects.toThrow(/permission denied/);
    await app.$disconnect();
  });
});

// =====================================================================================================
describe("lifecycle: cancellation, shutdown, retries, dead letters, replay", () => {
  it("cancel while processing aborts the handler and records CANCELLED", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(1);
    await r.scheduler().runCycle();
    let aborted = false;
    const w = r.worker("HTTP", (ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }));
    await w.start();
    const [e] = await until(async () => { const x = await executions(c, [o.orgId]); return x[0]?.status === "RUNNING" ? x : null; });
    await c.query(`UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = $1`, [e!.id]);
    const done = await until(async () => { const [x] = await executions(c, [o.orgId]); return x?.status === "CANCELLED" ? x : null; }, 15_000);
    expect(done.failure_category).toBe("CANCELLED");
    expect(aborted).toBe(true);
    await w.stop();
  });

  it("graceful shutdown hands in-flight work back without consuming an attempt; another worker completes it", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(1);
    await r.scheduler().runCycle();
    const w1 = r.worker("HTTP", (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("stop")))), { workerId: "draining" });
    await w1.start();
    await until(async () => (await executions(c, [o.orgId]))[0]?.status === "RUNNING");
    await w1.stop();
    let [e] = await executions(c, [o.orgId]);
    expect(e).toMatchObject({ status: "QUEUED", attempt: 1 });
    expect((await c.query(`SELECT count(*) FROM worker_heartbeats WHERE worker_id = 'draining'`)).rows[0].count).toBe("0");
    const w2 = r.worker("HTTP", async () => ({ summary: { ok: true } }));
    await w2.start();
    e = await until(async () => { const [x] = await executions(c, [o.orgId]); return x?.status === "SUCCEEDED" ? x : null; });
    expect(e.attempt).toBe(1);
    await w2.stop();
  });

  it("transient failures retry with backoff then dead-letter; permanent failures and timeouts are categorised", async () => {
    await setSettings(c, { ...HTTP_ON, "queue.http-monitoring": { ...FAST_QUEUE, attempts: 3, timeoutMs: 1000 } });
    const o = await seed(3);
    await r.scheduler().runCycle();
    const calls = new Map<string, number>();
    const w = r.worker("HTTP", async (ctx) => {
      calls.set(ctx.websiteId, (calls.get(ctx.websiteId) ?? 0) + 1);
      if (ctx.websiteId === o.websiteIds[0]) throw new TransientError("connection reset");
      if (ctx.websiteId === o.websiteIds[1]) throw new PermanentError("invalid monitoring configuration");
      await new Promise((res) => ctx.signal.addEventListener("abort", res)); // hangs → timeout
      throw new Error("aborted");
    });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => e.status === "DEAD_LETTERED"), 30_000, 200);
    const ex = await executions(c, [o.orgId]);
    const by = (wid: string) => ex.find((e) => e.website_id === wid)!;
    expect(by(o.websiteIds[0]!)).toMatchObject({ attempt: 3, failure_category: "TRANSIENT" });
    expect(calls.get(o.websiteIds[0]!)).toBe(3);
    expect(by(o.websiteIds[1]!)).toMatchObject({ attempt: 1, failure_category: "PERMANENT" });
    expect(calls.get(o.websiteIds[1]!)).toBe(1);
    expect(by(o.websiteIds[2]!)).toMatchObject({ attempt: 3, failure_category: "TIMEOUT" });
    const { rows } = await c.query<{ job_type: string; failure_category: string; attempts: number; execution_id: string; website_id: string; org_id: string }>(
      `SELECT job_type, failure_category, attempts, execution_id, website_id, org_id FROM job_failures WHERE org_id = $1 ORDER BY failure_category`, [o.orgId]);
    expect(rows.map((x) => [x.job_type, x.failure_category, x.attempts])).toEqual([["HTTP", "PERMANENT", 1], ["HTTP", "TIMEOUT", 3], ["HTTP", "TRANSIENT", 3]]);
    expect(rows.every((x) => ex.some((e) => e.id === x.execution_id && e.website_id === x.website_id))).toBe(true);
    expect(await r.dlq.count()).toBe(3);
    await w.stop();
  }, 60_000);

  it("dead-letter replay re-checks current eligibility and never replays security failures", async () => {
    await setSettings(c, { ...HTTP_ON, "queue.http-monitoring": { ...FAST_QUEUE, attempts: 1 } });
    const o = await seed(2);
    await r.scheduler().runCycle();
    let fail = true;
    const ran: string[] = [];
    const w = r.worker("HTTP", async (ctx) => { ran.push(ctx.websiteId); if (fail) throw new TransientError("gateway unavailable"); });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => e.status === "DEAD_LETTERED"));
    fail = false;
    const { rows: failures } = await c.query<{ id: string; website_id: string }>(`SELECT id, website_id FROM job_failures WHERE org_id = $1`, [o.orgId]);
    // Admins request the replay (wim_admin can only set the replay columns); website 1 is paused meanwhile.
    const admin = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    await admin.$executeRaw`UPDATE job_failures SET replay_requested_at = now(), replay_reason = 'gateway fixed' WHERE org_id = ${o.orgId}::uuid`;
    await expect(admin.$executeRaw`UPDATE job_failures SET org_id = gen_random_uuid() WHERE org_id = ${o.orgId}::uuid`).rejects.toThrow(/permission denied/);
    await admin.$disconnect();
    await c.query(`UPDATE websites SET status = 'PAUSED' WHERE id = $1`, [o.websiteIds[1]]);
    // A forged security failure for the same website must not be replayable.
    await c.query(`INSERT INTO job_failures (queue, job_id, org_id, website_id, job_type, failure_category, attempts, error, payload, replay_requested_at)
                   VALUES ('http-monitoring', 'x', $1, $2, 'HTTP', 'SECURITY', 1, 'forged', '{}', now())`, [o.orgId, o.websiteIds[0]]);
    const rep = await r.scheduler().runCycle();
    expect(rep.replays).toEqual({ replayed: 1, refused: 2 });
    const { rows: after } = await c.query<{ website_id: string; resolution: string; replay_execution_id: string | null; replay_reason: string; failure_category: string }>(
      `SELECT website_id, resolution, replay_execution_id, replay_reason, failure_category FROM job_failures WHERE org_id = $1`, [o.orgId]);
    const replayed = after.find((x) => x.resolution === "REPLAYED")!;
    expect(replayed.website_id).toBe(o.websiteIds[0]);
    expect(after.find((x) => x.website_id === o.websiteIds[1])!).toMatchObject({ resolution: "REPLAY_REFUSED" });
    expect(after.find((x) => x.website_id === o.websiteIds[1])!.replay_reason).toMatch(/WEBSITE_PAUSED/);
    expect(after.find((x) => x.failure_category === "SECURITY")!).toMatchObject({ resolution: "REPLAY_REFUSED" });
    await until(async () => (await executions(c, [o.orgId])).some((e) => e.id === replayed.replay_execution_id && e.status === "SUCCEEDED"));
    expect((await executions(c, [o.orgId])).find((e) => e.id === replayed.replay_execution_id)!.trigger).toBe("REPLAY");
    // Replaying twice does nothing.
    const rep2 = await r.scheduler().runCycle();
    expect(rep2.replays).toEqual({ replayed: 0, refused: 0 });
    expect(failures).toHaveLength(2);
    await w.stop();
  });

  it("worker health: heartbeats, aggregate admin views without tenant identifiers", async () => {
    await setSettings(c, HTTP_ON);
    const o = await seed(2);
    await r.scheduler("observable").runCycle();
    const w = r.worker("HTTP", async () => { await sleep(50); }, { workerId: "observed-worker" });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => e.status === "SUCCEEDED"));
    const admin = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    const hb = await admin.workerHeartbeat.findUnique({ where: { workerId: "observed-worker" } });
    expect(hb).toMatchObject({ kind: "http-monitoring", capacity: FAST_QUEUE.concurrency });
    const health = await admin.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_execution_health WHERE tier = 'T1_HTTP'`;
    expect(Number(health[0]!.succeeded_1h)).toBeGreaterThanOrEqual(2);
    expect(Object.keys(health[0]!)).not.toEqual(expect.arrayContaining(["org_id", "website_id"]));
    const sched = await admin.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_schedule_health`;
    expect(sched.length).toBeGreaterThan(0);
    // The admin role cannot read raw executions or schedules.
    await expect(admin.$queryRaw`SELECT * FROM monitoring_executions LIMIT 1`).rejects.toThrow(/permission denied/);
    const cycles = await admin.systemHealthLog.count({ where: { component: "scheduler", metric: "cycle_ok" } });
    expect(cycles).toBeGreaterThan(0);
    await admin.$disconnect();
    await w.stop();
  });
});
