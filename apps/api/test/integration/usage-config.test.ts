import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { defaultSettings } from "@wim/core";
import { createDb, type Db } from "@wim/db";
import { reconcileUsageDay, recordUsageGauges, TransientError } from "@wim/queue";
import { Client, createAdmin, startHarness, totpCode, type Harness } from "../helpers/harness.js";
import { executions, resetMonitoringSettings, rig, seedOrg, setSettings, until, type Rig } from "../helpers/monitoring.js";

/**
 * Phase 4H: usage accounting rules (idempotency, retries, cancellation, lost leases), reconciliation against the
 * execution ledger, audited adjustments, entitlement of the admin APIs, and the operational configuration pages
 * (permissions, protected policies, combination checks, retention floors, audit before/after).
 */
let h: Harness;
let c: pg.Client;
let r: Rig;
let worker: Db;
let parked: string[] = [];
const seeded: string[] = [];
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const usage = async (orgId: string, day?: string) => Object.fromEntries((await c.query<{ key: string; value: string }>(
  `SELECT key, value::text FROM usage_counters WHERE org_id = $1 ${day ? "AND period_start = $2::date" : ""}`, day ? [orgId, day] : [orgId])).rows.map((x) => [x.key, Number(x.value)]));
const FAST = { concurrency: 10, globalConcurrency: 100, ratePerSecond: 1000, attempts: 3, backoffBaseMs: 100, backoffMaxMs: 1000, timeoutMs: 5000, keepCompletedHours: 1, keepFailedDays: 1 };
async function admin(role: string) {
  const a = await createAdmin(role);
  const cl = Client.admin(h.app);
  expect((await cl.post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: await totpCode(a.secret) })).status).toBe(200);
  return { cl, ...a };
}

beforeAll(async () => {
  h = await startHarness();
  c = h.owner;
  r = rig();
  worker = createDb({ url: process.env.WORKER_DATABASE_URL!, max: 4, omitSecrets: true });
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await setSettings(c, { "monitoring.http.enabled": true, "queue.http-monitoring": FAST });
}, 120_000);
afterAll(async () => {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [seeded]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  await c.query(`DELETE FROM platform_settings WHERE key LIKE 'ops.%'`);
  await r.stopWorkers();
  await r.close();
  await worker.$disconnect();
  await h.stop();
});
const seed = async (n: number) => { const o = await seedOrg(c, n, { tag: "usage4h" }); seeded.push(o.orgId); return o; };

// =====================================================================================================
describe("accounting rules in the execution runtime", () => {
  it("retries never double-count work; a failed attempt is overhead; a duplicate delivery after success counts nothing", async () => {
    const o = await seed(1);
    await r.scheduler().runCycle();
    let n = 0;
    const w = r.worker("HTTP", async () => { if (n++ === 0) throw new TransientError("upstream reset"); return { usage: { "http.checks": 1 } }; });
    await w.start();
    await until(async () => (await executions(c, [o.orgId])).every((e) => e.status === "SUCCEEDED"), 20_000);
    const [e] = await executions(c, [o.orgId]);
    // duplicate delivery of the same job after success: acknowledged without work or usage
    await r.queues.HTTP.add("EXECUTE", { v: 1, executionId: e!.id, windowStart: e!.queued_at.toISOString() }, { jobId: `${e!.id}` }).catch(() => undefined);
    await r.queues.HTTP.add("EXECUTE", { v: 1, executionId: e!.id, windowStart: e!.queued_at.toISOString() }, { jobId: e!.id });
    await new Promise((res) => setTimeout(res, 1500));
    const u = await usage(o.orgId);
    expect(u["exec.http.ok"]).toBe(1);
    expect(u["http.checks"]).toBe(1);
    expect(u["exec.http.failed"]).toBe(1);
    expect(u["exec.http.retries"]).toBe(1);
    await r.stopWorkers();
  });

  it("a worker that lost its lease (another worker took the execution over) does not account the result", async () => {
    const o = await seed(1);
    await r.scheduler().runCycle();
    const w = r.worker("HTTP", async (ctx) => {
      // simulate the takeover: reconcile handed the execution to another worker while this one was slow
      await c.query(`UPDATE monitoring_executions SET worker_id = 'the-successor' WHERE id = $1`, [ctx.executionId]);
      return { usage: { "http.checks": 1 } };
    });
    await w.start();
    await until(async () => (await c.query(`SELECT 1 FROM system_health_logs WHERE metric = 'lease_lost_on_success' AND recorded_at > now() - interval '1 minute'`)).rowCount, 20_000);
    const u = await usage(o.orgId);
    expect(u["exec.http.ok"] ?? 0).toBe(0);
    expect(u["http.checks"] ?? 0).toBe(0);
    await r.stopWorkers();
    await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [o.orgId]);
    await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE org_id = $1`, [o.orgId]);
  });

  it("cancellation while running is overhead (exec.*.cancelled), recorded once, never billable work", async () => {
    // the cancellation poll rides on lease renewal (≤ 5 s): give the job more time than that
    await setSettings(c, { "queue.http-monitoring": { ...FAST, timeoutMs: 30_000 } });
    const o = await seed(1);
    await r.scheduler().runCycle();
    const w = r.worker("HTTP", async (ctx) => { await new Promise((_, rej) => ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason))); });
    await w.start();
    const [e] = await until(async () => { const x = await executions(c, [o.orgId]); return x[0]?.status === "RUNNING" ? x : null; }, 15_000);
    await c.query(`UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = $1`, [e!.id]);
    await until(async () => (await executions(c, [o.orgId]))[0]?.status === "CANCELLED", 20_000);
    await new Promise((res) => setTimeout(res, 500));
    const u = await usage(o.orgId);
    expect(u["exec.http.ok"] ?? 0).toBe(0);
    expect(u["http.checks"] ?? 0).toBe(0);
    expect(u["exec.http.cancelled"]).toBe(1);
    await r.stopWorkers();
    await setSettings(c, { "queue.http-monitoring": FAST });
  });
});

// =====================================================================================================
describe("reconciliation and audited adjustments", () => {
  it("finds every mismatch against the ledger, repairs nothing by itself; an adjustment fixes it with reason + audit; a re-run is clean", async () => {
    const o = await seed(1);
    const other = await seed(1);
    const day = yesterday();
    const w = o.websiteIds[0]!;
    // ledger: 10 HTTP results recorded yesterday (3 inconclusive); counters claim 12 checks and 3 inconclusive
    await c.query(`
      INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt, recorded_at)
      SELECT gen_random_uuid(), $1, $2, 'T1_HTTP', $3::date + make_interval(mins => g), CASE WHEN g <= 3 THEN 'INCONCLUSIVE' ELSE 'PASSED' END, 1, $3::date + make_interval(mins => g, secs => 5)
        FROM generate_series(1, 10) g`, [o.orgId, w, day]);
    await c.query(`INSERT INTO usage_counters (org_id, period_start, key, value, updated_at) VALUES ($1, $2, 'http.checks', 12, now()), ($1, $2, 'http.inconclusive', 3, now())`, [o.orgId, day]);
    // the other tenant matches exactly
    await c.query(`
      INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt, recorded_at)
      SELECT gen_random_uuid(), $1, $2, 'T1_HTTP', $3::date + make_interval(mins => g), 'PASSED', 1, $3::date + make_interval(mins => g, secs => 5) FROM generate_series(1, 4) g`, [other.orgId, other.websiteIds[0], day]);
    await c.query(`INSERT INTO usage_counters (org_id, period_start, key, value, updated_at) VALUES ($1, $2, 'http.checks', 4, now())`, [other.orgId, day]);

    const run = await reconcileUsageDay(worker, day);
    const disc = (await c.query(`SELECT * FROM usage_discrepancies WHERE run_id = $1 AND org_id = ANY($2::uuid[]) ORDER BY "check"`, [run.runId, [o.orgId, other.orgId]])).rows;
    const mine = disc.filter((d) => d.org_id === o.orgId);
    expect(mine.find((d) => d.check === "http.checks~ledger")).toMatchObject({ recorded: "12", expected: "10", status: "OPEN" });
    expect(mine.find((d) => d.check === "http.inconclusive~ledger")).toBeUndefined(); // matches
    expect(mine.find((d) => d.check === "results~ledger")).toMatchObject({ expected: "10" }); // ledger rows without persisted results (fixture)
    expect(disc.filter((d) => d.org_id === other.orgId && d.check !== "results~ledger")).toEqual([]);
    expect((await usage(o.orgId, day))["http.checks"]).toBe(12); // nothing repaired silently

    const op = await admin("ADMIN_OPERATOR");
    const billing = await admin("ADMIN_BILLING");
    const sup = await admin("ADMIN_SUPPORT");
    const superA = await admin("SUPER_ADMIN");
    const d = mine.find((x) => x.check === "http.checks~ledger")!;
    // permissions: support cannot read usage; operator and billing can read but not adjust
    expect((await sup.cl.get(`/api/admin/v1/ops/usage/reconciliations/${run.runId}`)).status).toBe(403);
    expect((await billing.cl.get(`/api/admin/v1/ops/usage/reconciliations/${run.runId}`)).status).toBe(200);
    const body = { orgId: o.orgId, day, key: "http.checks", delta: -2, reason: "Double-counted after the 4H lease fix (OPS-7)", discrepancyId: d.id };
    expect((await op.cl.post("/api/admin/v1/ops/usage/adjustments", body)).status).toBe(403);
    // validation: too short a reason, unknown key, a delta that would go negative, a future day, another org's discrepancy
    expect((await superA.cl.post("/api/admin/v1/ops/usage/adjustments", { ...body, reason: "short" })).status).toBe(400);
    expect((await superA.cl.post("/api/admin/v1/ops/usage/adjustments", { ...body, key: "made.up" })).status).toBe(400);
    expect((await superA.cl.post("/api/admin/v1/ops/usage/adjustments", { ...body, delta: -100, discrepancyId: undefined })).status).toBe(400);
    expect((await superA.cl.post("/api/admin/v1/ops/usage/adjustments", { ...body, day: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) })).status).toBe(400);
    expect((await superA.cl.post("/api/admin/v1/ops/usage/adjustments", { ...body, orgId: other.orgId })).status).toBe(409);
    expect((await usage(o.orgId, day))["http.checks"]).toBe(12); // failed attempts changed nothing (atomic)
    const ok = await superA.cl.post("/api/admin/v1/ops/usage/adjustments", body);
    expect(ok.status).toBe(201);
    expect((await usage(o.orgId, day))["http.checks"]).toBe(10);
    expect((await c.query(`SELECT status, resolution FROM usage_discrepancies WHERE id = $1`, [d.id])).rows[0]).toMatchObject({ status: "ADJUSTED" });
    const adj = (await c.query(`SELECT * FROM usage_adjustments WHERE id = $1`, [ok.body.data.id])).rows[0];
    expect(adj).toMatchObject({ org_id: o.orgId, key: "http.checks", delta: "-2", actor_id: superA.id });
    const audit = (await c.query(`SELECT changes, reason FROM audit_logs WHERE action = 'admin.usage_adjusted' AND target_id = $1`, [o.orgId])).rows;
    expect(audit).toEqual([expect.objectContaining({ reason: body.reason, changes: expect.objectContaining({ delta: -2, key: "http.checks", adjustmentId: adj.id }) })]);
    // adjustments are history: not editable by anyone through the database roles used by the application
    await expect(c.query(`UPDATE usage_adjustments SET delta = 5 WHERE id = $1`, [adj.id])).rejects.toThrow(/append-only/);
    // accept the integrity discrepancy with a reason
    const integrity = mine.find((x) => x.check === "results~ledger")!;
    expect((await superA.cl.post(`/api/admin/v1/ops/usage/discrepancies/${integrity.id}/accept`, { reason: "fixture rows without results" })).status).toBe(200);
    expect((await superA.cl.post(`/api/admin/v1/ops/usage/discrepancies/${integrity.id}/accept`, { reason: "fixture rows without results" })).status).toBe(409);
    // re-run: the corrected counter now matches
    const again = await reconcileUsageDay(worker, day);
    const left = (await c.query(`SELECT "check" FROM usage_discrepancies WHERE run_id = $1 AND org_id = $2`, [again.runId, o.orgId])).rows.map((x) => x.check);
    expect(left).not.toContain("http.checks~ledger");
    // operator-requested runs: only finished days, audited
    expect((await op.cl.post("/api/admin/v1/ops/usage/reconciliations", { day: new Date().toISOString().slice(0, 10), reason: "today please" })).status).toBe(400);
    const req = await op.cl.post("/api/admin/v1/ops/usage/reconciliations", { day, reason: "verify after adjustment" });
    expect(req.status).toBe(202);
    expect((await c.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.usage_reconciliation_requested' AND target_id = $1`, [req.body.data.id])).rowCount).toBe(1);
  });

  it("billable usage excludes inconclusive results, cancellations, failures and retries; gauges are levels, not sums", async () => {
    const o = await seed(2);
    const day = yesterday();
    await c.query(`INSERT INTO usage_counters (org_id, period_start, key, value, updated_at) VALUES
      ($1, $2, 'http.checks', 100, now()), ($1, $2, 'http.inconclusive', 7, now()), ($1, $2, 'exec.http.failed', 9, now()),
      ($1, $2, 'exec.http.retries', 4, now()), ($1, $2, 'exec.http.cancelled', 2, now()), ($1, $2, 'browser.executions', 5, now())`, [o.orgId, day]);
    const billing = await admin("ADMIN_BILLING");
    const res = await billing.cl.get(`/api/admin/v1/ops/usage?from=${day}&to=${day}&orgId=${o.orgId}`);
    expect(res.status).toBe(200);
    const org = res.body.data.organisations.find((x: { orgId: string }) => x.orgId === o.orgId);
    expect(org.billable).toMatchObject({ "http.checks": 93, "browser.executions": 5 });
    expect(res.body.data.totals.find((x: { key: string }) => x.key === "exec.http.retries")).toMatchObject({ kind: "overhead" });
    // privacy: counts and organisation names only
    expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\/|canonical|w0\./);
    // range validation
    expect((await billing.cl.get(`/api/admin/v1/ops/usage?from=2026-01-01&to=2026-12-31`)).status).toBe(400);
    // gauges: recorded twice in a day → still the level, not doubled
    await recordUsageGauges(worker);
    await recordUsageGauges(worker);
    const today = new Date().toISOString().slice(0, 10);
    expect((await usage(o.orgId, today))["websites.registered"]).toBe(2);
  });
});

// =====================================================================================================
describe("operations configuration", () => {
  it("permissions, protected policies, combination checks, restart markers and audit with before/after", async () => {
    const superA = await admin("SUPER_ADMIN");
    const op = await admin("ADMIN_OPERATOR");
    const aud = await admin("ADMIN_AUDITOR");
    const cfg = await op.cl.get("/api/admin/v1/ops/config");
    expect(cfg.status).toBe(200);
    const all = cfg.body.data.sections.flatMap((s: { settings: unknown[] }) => s.settings) as Array<{ key: string; protected: boolean; apply: string; scope: string }>;
    expect(all.find((s) => s.key === "queue.browser-monitoring")).toMatchObject({ apply: "restart", protected: false, scope: "global" });
    expect(all.find((s) => s.key === "monitoring.functional.enabled")).toMatchObject({ protected: true });
    expect(all.find((s) => s.key === "auth.password.minLength")).toMatchObject({ protected: true });
    expect(all.some((s) => /secret|password$|token/i.test(s.key) && !s.protected)).toBe(false);
    expect((await aud.cl.get("/api/admin/v1/ops/config")).status).toBe(403);
    // operators read but cannot write
    expect((await op.cl.patch("/api/admin/v1/settings", { changes: [{ key: "ops.alerts.cooldownMin", value: 45 }], reason: "tuning noise" })).status).toBe(403);
    // protected: explicit confirmation required
    const prot = { changes: [{ key: "monitoring.functional.enabled", value: true }], reason: "enable for review" };
    const noConfirm = await superA.cl.patch("/api/admin/v1/settings", prot);
    expect(noConfirm.status).toBe(400);
    expect(JSON.stringify(noConfirm.body)).toMatch(/confirmProtected/);
    expect((await superA.cl.patch("/api/admin/v1/settings", { ...prot, confirmProtected: true })).status).toBe(200);
    const a1 = (await c.query(`SELECT changes FROM audit_logs WHERE action = 'admin.setting_changed' AND target_id = 'monitoring.functional.enabled' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a1.changes).toMatchObject({ from: false, to: true, protected: true, apply: "live" });
    await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "monitoring.functional.enabled", value: false }], reason: "restore default", confirmProtected: true });
    // dangerous combinations, each individually valid
    const p = defaultSettings()["queue.http-monitoring"];
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "queue.http-monitoring", value: { ...p, backoffBaseMs: 120_000, backoffMaxMs: 60_000 } }], reason: "bad backoff" })).status).toBe(400);
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "queue.http-monitoring", value: { ...p, concurrency: 400, globalConcurrency: 100 } }], reason: "bad concurrency" })).status).toBe(400);
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "ops.alerts.disabledRules", value: ["alerts.storm"] }], reason: "silence storms", confirmProtected: true })).status).toBe(400);
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "ops.health.heartbeatStaleSec", value: 600 }], reason: "very lax" })).status).toBe(400);
    // invalid single values
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "ops.alerts.thresholds", value: { ...defaultSettings()["ops.alerts.thresholds"], queueWaiting: { warn: 100, crit: 50 } } }], reason: "inverted" })).status).toBe(400);
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "ops.alerts.recipients", value: ["not-an-email"] }], reason: "bad recipient", confirmProtected: true })).status).toBe(400);
    // a valid restart-required change is accepted and audited as such
    expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key: "queue.http-monitoring", value: { ...FAST, concurrency: 8 } }], reason: "more throughput" })).status).toBe(200);
    const a2 = (await c.query(`SELECT changes FROM audit_logs WHERE action = 'admin.setting_changed' AND target_id = 'queue.http-monitoring' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a2.changes).toMatchObject({ apply: "restart", to: expect.objectContaining({ concurrency: 8 }) });
    // no arbitrary keys: secrets and environment are not settings
    for (const key of ["EGRESS_TOKEN_SECRET", "database.url", "ops.alerts.webhookSecret"]) {
      expect((await superA.cl.patch("/api/admin/v1/settings", { changes: [{ key, value: "x" }], reason: "attempt" })).status).toBe(400);
    }
  });

  it("retention: floors protect audit, security and reconciliation history; changes are audited; unknown tables are refused", async () => {
    const superA = await admin("SUPER_ADMIN");
    const op = await admin("ADMIN_OPERATOR");
    const before = (await c.query(`SELECT extract(day FROM retain)::int AS d FROM partitions.config WHERE parent = 'security_events'`)).rows[0].d;
    expect((await op.cl.put("/api/admin/v1/ops/config/retention/security_events", { days: 400, reason: "keep longer" })).status).toBe(403);
    expect((await superA.cl.put("/api/admin/v1/ops/config/retention/security_events", { days: 30, reason: "save space" })).status).toBe(400);
    expect((await superA.cl.put("/api/admin/v1/ops/config/retention/users", { days: 30, reason: "drop users?" })).status).toBe(404);
    expect((await superA.cl.put("/api/admin/v1/ops/config/retention/x;drop", { days: 30, reason: "injection" })).status).toBe(404);
    expect((await superA.cl.put("/api/admin/v1/ops/config/retention/security_events", { days: before + 5, reason: "compliance review" })).status).toBe(200);
    const a = (await c.query(`SELECT changes, reason FROM audit_logs WHERE action = 'admin.retention_changed' AND target_id = 'security_events' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(a).toMatchObject({ reason: "compliance review", changes: { from: before, to: before + 5 } });
    await superA.cl.put("/api/admin/v1/ops/config/retention/security_events", { days: before, reason: "restore" });
    // the admin role cannot change retention except through the validated function
    const adminDb = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
    try {
      await expect(adminDb.$executeRaw`UPDATE partitions.config SET retain = interval '1 day'`).rejects.toThrow(/permission denied/);
    } finally {
      await adminDb.$disconnect();
    }
  });
});

void randomUUID;
