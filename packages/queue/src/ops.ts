import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  ALERT_DEPENDENCIES, alertSeverity, classifyWorker, level, queueProcessing, rateLevel, worstHealth,
  type AlertRule, type HealthState, type SettingsSnapshot, type WorkerFacts,
} from "@wim/core";
import { loadSettings, withSystem, type Db, type Tx } from "@wim/db";
import type { Logger } from "@wim/logger";
import { sanitizeError } from "./util.js";

/**
 * Phase 4H: platform health evaluation and self-alerting (ARCHITECTURE.md D-91…D-96, OPERATIONS_RUNBOOK.md).
 *
 *  facts (Postgres, Redis, BullMQ counts, heartbeats, aggregate metrics) → signals (rule + subject + state + reason)
 *  → component snapshot (`platform_health`) + alerts (`platform_alerts`, events, outbox → e-mail).
 *
 * One evaluator at a time platform-wide (claim on the `__evaluator` row); the scheduler runs it and the notification
 * worker runs it as a watchdog, so losing the scheduler is itself detected. Everything here is aggregate: no tenant
 * identifiers, URLs or customer content are read into a signal.
 */
export interface Signal {
  rule: AlertRule;
  subject: string;
  component: string;
  state: HealthState;
  reason: string;
  metrics?: Record<string, number | string | boolean | null>;
}
export interface EvaluationDeps {
  db: Db;
  connection: Redis;
  /** queue name → BullMQ queue (same prefix as the workers) */
  queues: Record<string, Queue>;
  /** queue prefix (Redis keys of the API/ingest heartbeats) */
  prefix?: string;
  evaluatorId: string;
  log: Logger;
  now?: () => Date;
}
export interface EvaluationReport { ran: boolean; signals: Signal[]; opened: string[]; recovered: string[]; notified: string[]; suppressed: string[]; ms: number }

const EXPECTED_KINDS = ["scheduler", "http-monitoring", "browser-monitoring", "deep-scan", "email"] as const;
const KIND_TIER: Record<string, "monitoring.http.enabled" | "monitoring.browser.enabled" | "monitoring.deepscan.enabled" | undefined> = {
  "http-monitoring": "monitoring.http.enabled", "browser-monitoring": "monitoring.browser.enabled", "deep-scan": "monitoring.deepscan.enabled",
};
const QUEUE_LEDGER_TIER: Record<string, string> = { "browser-monitoring": "T2_RENDER", "deep-scan": "T3_DEEP" };

// ===================================================================================================== facts → signals
export async function collectSignals(d: EvaluationDeps, s: SettingsSnapshot, now: Date): Promise<Signal[]> {
  const t = s["ops.alerts.thresholds"];
  const out: Signal[] = [];
  const push = (x: Signal) => out.push(x);

  // ---- PostgreSQL (reachability is proven by the queries below; connections against max_connections)
  const pgStart = Date.now();
  const [pg] = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ used: number; max: number }>>`
    SELECT (SELECT count(*) FROM pg_stat_activity)::int AS used, current_setting('max_connections')::int AS max`);
  const pgMs = Date.now() - pgStart;
  push({ rule: "postgres.unavailable", subject: "primary", component: "postgres", state: "HEALTHY", reason: "reachable", metrics: { latencyMs: pgMs } });
  const connPct = Math.round((pg!.used / pg!.max) * 100);
  push({ rule: "resources.utilization", subject: "db-connections", component: "postgres", state: level(connPct, t.dbConnectionsPct), reason: `${pg!.used} of ${pg!.max} connections (${connPct}%)`, metrics: { connections: pg!.used, maxConnections: pg!.max } });

  // ---- Redis
  let redisOk = true;
  try {
    const r0 = Date.now();
    await withTimeout(d.connection.ping(), 3000);
    const info = await withTimeout(d.connection.info("memory"), 3000);
    const used = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? NaN);
    const max = Number(/maxmemory:(\d+)/.exec(info)?.[1] ?? 0);
    push({ rule: "redis.unavailable", subject: "primary", component: "redis", state: "HEALTHY", reason: "reachable", metrics: { latencyMs: Date.now() - r0, usedMb: Math.round(used / 1048576) } });
    const pct = max > 0 ? Math.round((used / max) * 100) : null;
    push({ rule: "resources.utilization", subject: "redis-memory", component: "redis", state: pct === null ? "HEALTHY" : level(pct, t.redisMemoryPct), reason: pct === null ? "no maxmemory configured" : `memory ${pct}% of maxmemory`, metrics: { memoryPct: pct } });
  } catch (e) {
    redisOk = false;
    push({ rule: "redis.unavailable", subject: "primary", component: "redis", state: "UNHEALTHY", reason: `Redis unreachable: ${sanitizeError((e as Error).message).slice(0, 120)}` });
  }

  // ---- queues (BullMQ counts and the age of the oldest waiting job)
  const queueStats: Record<string, { waiting: number; active: number; delayed: number; failed: number; oldestSec: number | null }> = {};
  if (redisOk) {
    for (const [name, q] of Object.entries(d.queues)) {
      try {
        const c = await withTimeout(q.getJobCounts("waiting", "prioritized", "active", "delayed", "failed"), 3000);
        const oldest = (await withTimeout(q.getJobs(["wait", "prioritized"], 0, 0, true), 3000))[0];
        const oldestSec = oldest?.timestamp ? Math.max(0, Math.round((now.getTime() - oldest.timestamp) / 1000)) : null;
        const waiting = (c.waiting ?? 0) + (c.prioritized ?? 0);
        queueStats[name] = { waiting, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, oldestSec };
        const st = worstHealth([level(oldestSec ?? 0, t.queueOldestSec), level(waiting, t.queueWaiting)]);
        push({ rule: "queue.backlog", subject: name, component: `queue:${name}`, state: st, reason: `${waiting} waiting, oldest ${oldestSec ?? 0} s, ${c.active ?? 0} active`, metrics: { waiting, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, oldestSec } });
      } catch (e) {
        push({ rule: "queue.backlog", subject: name, component: `queue:${name}`, state: "UNKNOWN", reason: `queue unreadable: ${sanitizeError((e as Error).message).slice(0, 80)}` });
      }
    }
  }

  // ---- everything else from Postgres in one round trip per table
  const f = await withSystem(d.db, async (tx) => {
    const hbs = await tx.workerHeartbeat.findMany();
    const [m] = await tx.$queryRaw<Array<Record<string, number | Date | null>>>`
      SELECT
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '15 minutes' AND component = 'browser-monitoring' AND metric = 'infra_failure')::int AS browser_infra,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '15 minutes' AND component = 'deep-scan' AND metric = 'infra_failure')::int AS deepscan_infra,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '15 minutes' AND metric = 'infra_failure' AND labels->>'kind' ILIKE '%gateway%')::int AS gateway_infra,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '15 minutes' AND component = 'browser-monitoring' AND metric = 'storage_failure')::int AS storage_failures,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '2 hours' AND component = 'maintenance' AND metric = 'partitions_failed')::int AS maintenance_failed,
        (SELECT max(recorded_at) FROM system_health_logs WHERE recorded_at > now() - interval '7 days' AND component = 'maintenance' AND metric = 'partitions_ok') AS maintenance_ok_at,
        (SELECT count(*) FROM execution_results WHERE recorded_at > now() - interval '15 minutes' AND tier = 'T2_RENDER')::int AS t2_results,
        (SELECT count(*) FROM execution_results WHERE recorded_at > now() - interval '15 minutes' AND tier = 'T3_DEEP')::int AS t3_results,
        (SELECT count(*) FROM job_failures WHERE failed_at > now() - interval '1 hour')::int AS dlq_1h,
        (SELECT count(*) FROM job_failures WHERE resolution IS NULL)::int AS dlq_open,
        (SELECT count(*) FILTER (WHERE status = 'SENT') FROM notification_delivery_logs WHERE created_at > now() - interval '15 minutes')::int AS notify_sent,
        (SELECT count(*) FILTER (WHERE status = 'FAILED') FROM notification_delivery_logs WHERE created_at > now() - interval '15 minutes')::int AS notify_failed,
        (SELECT min(created_at) FROM outbox_events WHERE published_at IS NULL) AS outbox_oldest,
        (SELECT count(*) FROM platform_alert_events WHERE type = 'NOTIFY_FAILED' AND at > now() - interval '15 minutes')::int AS alert_delivery_failed,
        (SELECT last_run_at FROM rollup_state WHERE name = 'performance') AS rollup_at,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '3 hours' AND component = 'maintenance' AND metric IN ('artifact_cleanup_failed', 'deepscan_retention_failed'))::int AS cleanup_failed,
        (SELECT count(*) FROM system_health_logs WHERE recorded_at > now() - interval '3 hours' AND component = 'maintenance' AND metric IN ('artifact_cleanup_ok', 'deepscan_retention_ok'))::int AS cleanup_ok`;
    // release readiness: has customer monitoring silently stopped? ACTIVE schedules (ineligible ones are PAUSED by the
    // scheduler) whose run is overdue by more than an interval and a grace period; results recorded and timeouts per tier
    const stalled = await tx.$queryRaw<Array<{ tier: string; overdue: number; oldest_sec: number | null; active: number }>>`
      SELECT tier::text AS tier,
             count(*) FILTER (WHERE next_run_at < now() - make_interval(secs => interval_sec) - interval '5 minutes')::int AS overdue,
             extract(epoch FROM now() - min(next_run_at) FILTER (WHERE next_run_at < now() - make_interval(secs => interval_sec) - interval '5 minutes'))::int AS oldest_sec,
             count(*)::int AS active
        FROM monitoring_schedules WHERE status = 'ACTIVE' AND tier IN ('T1_HTTP', 'T2_RENDER', 'T3_DEEP') GROUP BY 1`;
    const timeouts = await tx.$queryRaw<Array<{ queue: string; n: number }>>`
      SELECT labels->>'queue' AS queue, count(*)::int AS n FROM system_health_logs
       WHERE component = 'queue' AND metric = 'timeout' AND recorded_at > now() - interval '15 minutes' GROUP BY 1`;
    const results = await tx.$queryRaw<Array<{ tier: string; n: number }>>`
      SELECT tier::text AS tier, count(*)::int AS n FROM execution_results WHERE recorded_at > now() - interval '15 minutes' GROUP BY 1`;
    const starts = await tx.$queryRaw<Array<{ kind: string; n: number }>>`
      SELECT labels->>'kind' AS kind, count(*)::int AS n FROM system_health_logs
       WHERE component = 'worker' AND metric = 'start' AND recorded_at > now() - interval '1 hour' GROUP BY 1`;
    const seen24h = await tx.$queryRaw<Array<{ kind: string }>>`
      SELECT DISTINCT labels->>'kind' AS kind FROM system_health_logs
       WHERE component = 'worker' AND metric IN ('start', 'sample') AND recorded_at > now() - interval '24 hours'`;
    return { hbs, m: m!, starts: new Map(starts.map((x) => [x.kind, x.n])), seen: new Set(seen24h.map((x) => x.kind)), stalled, timeouts, results };
  });
  const m = f.m as Record<string, number> & { maintenance_ok_at: Date | null; outbox_oldest: Date | null; rollup_at: Date | null };

  // ---- workers per kind
  const cls = { staleSec: s["ops.health.heartbeatStaleSec"], memoryMb: s["ops.health.workerMemoryMb"], utilization: t.utilizationPct };
  const byKind = new Map<string, WorkerFacts[]>();
  for (const h of f.hbs) {
    const w: WorkerFacts = { workerId: h.workerId, kind: h.kind, lastSeenAt: h.lastSeenAt, startedAt: h.startedAt, activeJobs: h.activeJobs, capacity: h.capacity, processed: h.processed, failed: h.failed, timeouts: h.timeouts, lastJobAt: h.lastJobAt, rssMb: h.rssMb, deps: h.deps as WorkerFacts["deps"] };
    byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), w]);
  }
  const depFailures: Record<string, { probed: number; failing: number }> = {};
  for (const kind of new Set([...EXPECTED_KINDS, ...byKind.keys()])) {
    const ws = byKind.get(kind) ?? [];
    const healths = ws.map((w) => ({ w, h: classifyWorker(w, now, cls) }));
    const alive = healths.filter((x) => x.h.alive);
    const comp = kind === "scheduler" ? "scheduler" : `workers:${kind}`;
    const tierKey = KIND_TIER[kind];
    const expected = kind === "scheduler" || kind === "email" || (tierKey ? Boolean(s[tierKey]) : false) || f.seen.has(kind);
    const metrics = { alive: alive.length, registered: ws.length, active: alive.reduce((a, x) => a + x.w.activeJobs, 0), capacity: alive.reduce((a, x) => a + x.w.capacity, 0), processed: ws.reduce((a, x) => a + x.processed, 0), failed: ws.reduce((a, x) => a + x.failed, 0), timeouts: ws.reduce((a, x) => a + x.timeouts, 0), restarts1h: f.starts.get(kind) ?? 0 };

    if (kind === "scheduler") {
      const newest = ws.reduce<number | null>((a, w) => Math.max(a ?? 0, w.lastSeenAt.getTime()), null);
      const age = newest === null ? null : Math.round((now.getTime() - newest) / 1000);
      push({ rule: "scheduler.unavailable", subject: "scheduler", component: comp, state: age === null ? "UNHEALTHY" : level(age, t.schedulerStaleSec), reason: age === null ? "no scheduler instance registered" : `newest scheduler heartbeat ${age} s ago (${alive.length} of ${ws.length} instances alive)`, metrics: { ...metrics, heartbeatAgeSec: age } });
      continue;
    }
    // alive
    if (!ws.length) push({ rule: "worker.heartbeat_expired", subject: kind, component: comp, state: expected && (kind === "email" || (queueStats[kind]?.waiting ?? 0) > 0 || f.seen.has(kind)) ? "UNHEALTHY" : "UNKNOWN", reason: expected ? "no worker registered" : "no worker registered (feature off — not expected)", metrics });
    else if (!alive.length) push({ rule: "worker.heartbeat_expired", subject: kind, component: comp, state: "UNHEALTHY", reason: `all ${ws.length} workers stopped heartbeating`, metrics });
    else push({ rule: "worker.heartbeat_expired", subject: kind, component: comp, state: alive.length < ws.length ? "DEGRADED" : "HEALTHY", reason: alive.length < ws.length ? `${ws.length - alive.length} of ${ws.length} workers stopped heartbeating` : `${alive.length} alive`, metrics });
    // processing
    const qs = queueStats[kind];
    if (qs) {
      const lastJob = ws.reduce<Date | null>((a, w) => (w.lastJobAt && (!a || w.lastJobAt > a) ? w.lastJobAt : a), null);
      const p = queueProcessing({ waiting: qs.waiting, aliveWorkers: alive.length, busyWorkers: alive.filter((x) => x.w.activeJobs > 0).length, lastJobAt: lastJob, now, stallSec: s["ops.health.processingStallSec"], oldestWaitingSec: qs.oldestSec });
      push({ rule: "worker.not_processing", subject: kind, component: comp, state: p.processing === false ? (alive.length ? "UNHEALTHY" : "DEGRADED") : "HEALTHY", reason: p.reason ?? (p.processing ? "processing" : "idle (nothing waiting)"), metrics: { lastJobAt: lastJob?.toISOString() ?? null } });
      // capacity: saturated while work is waiting
      const util = metrics.capacity ? Math.round((metrics.active / metrics.capacity) * 100) : 0;
      push({ rule: "worker.capacity", subject: kind, component: comp, state: qs.waiting > 0 ? level(util, t.utilizationPct) : "HEALTHY", reason: `${metrics.active} of ${metrics.capacity} slots busy, ${qs.waiting} waiting`, metrics: { utilizationPct: util, available: Math.max(0, metrics.capacity - metrics.active) } });
    }
    // restarts (crash loop)
    push({ rule: "worker.restarts", subject: kind, component: comp, state: level(metrics.restarts1h, t.workerRestartsPerHour), reason: `${metrics.restarts1h} starts in the last hour`, metrics: {} });
    // memory
    const mem = Math.max(0, ...alive.map((x) => x.h.memoryPct ?? 0));
    push({ rule: "resources.utilization", subject: `memory:${kind}`, component: comp, state: alive.length ? level(mem, t.utilizationPct) : "HEALTHY", reason: `highest worker memory ${mem}% of budget`, metrics: { memoryPct: mem } });
    // dependencies seen by live workers
    for (const x of alive) for (const [dep, probe] of Object.entries(x.w.deps ?? {})) {
      const k = `${kind}|${dep}`;
      depFailures[k] ??= { probed: 0, failing: 0 };
      depFailures[k]!.probed++;
      if (!probe.ok) depFailures[k]!.failing++;
    }
  }
  const depState = (dep: string, kinds?: string[]) => {
    const rows = Object.entries(depFailures).filter(([k]) => k.endsWith(`|${dep}`) && (!kinds || kinds.includes(k.split("|")[0]!)));
    const probed = rows.reduce((a, [, v]) => a + v.probed, 0);
    const failing = rows.reduce((a, [, v]) => a + v.failing, 0);
    return { probed, failing, state: (!probed ? "UNKNOWN" : failing === probed ? "UNHEALTHY" : failing ? "DEGRADED" : "HEALTHY") as HealthState };
  };
  // other worker-side dependencies (Redis as seen by workers, SMTP …) — gateway/runner/storage have their own rules
  for (const [k, v] of Object.entries(depFailures)) {
    const [kind, dep] = k.split("|") as [string, string];
    if (["gateway", "runner", "storage", "smtp"].includes(dep)) continue;
    push({ rule: "worker.dependency_unreachable", subject: `${kind}:${dep}`, component: `workers:${kind}`, state: v.failing === v.probed ? "UNHEALTHY" : v.failing ? "DEGRADED" : "HEALTHY", reason: `${v.failing} of ${v.probed} workers cannot reach ${dep}`, metrics: {} });
  }

  // ---- egress gateway: probes from every worker that uses it + gateway-attributed failures
  const gw = depState("gateway");
  const gwState = worstHealth([gw.state === "UNKNOWN" ? "HEALTHY" : gw.state, m.gateway_infra >= t.minSamples ? "DEGRADED" : "HEALTHY"]);
  push({ rule: "gateway.unavailable", subject: "egress", component: "gateway", state: gw.state === "UNKNOWN" && !m.gateway_infra ? "UNKNOWN" : gwState, reason: gw.probed ? `${gw.failing} of ${gw.probed} workers cannot reach the gateway; ${m.gateway_infra} gateway failures in 15 min` : "no worker reports a gateway probe", metrics: { probed: gw.probed, failing: gw.failing, failures15m: m.gateway_infra } });

  // ---- browser runner
  const rn = depState("runner", ["browser-monitoring", "deep-scan"]);
  const rr = rateLevel(m.browser_infra, m.browser_infra + m.t2_results, t.infraFailurePct, t.minSamples);
  push({ rule: "runner.failures", subject: "browser-runner", component: "browser-runner", state: rn.state === "UNKNOWN" && rr.pct === null ? "UNKNOWN" : worstHealth([rn.state === "UNKNOWN" ? "HEALTHY" : rn.state, rr.state]), reason: `${rn.failing} of ${rn.probed} workers cannot reach a runner; browser infrastructure failures ${rr.pct ?? 0}% (${m.browser_infra} in 15 min)`, metrics: { failurePct: rr.pct, failures15m: m.browser_infra, results15m: m.t2_results } });

  // ---- deep scan
  const dr = rateLevel(m.deepscan_infra, m.deepscan_infra + m.t3_results, t.infraFailurePct, t.minSamples);
  push({ rule: "deepscan.failures", subject: "deep-scan", component: "workers:deep-scan", state: dr.state, reason: `deep-scan infrastructure failures ${dr.pct ?? 0}% (${m.deepscan_infra} in 15 min)`, metrics: { failurePct: dr.pct } });

  // ---- object storage
  const st = depState("storage");
  push({ rule: "storage.unavailable", subject: "artifacts", component: "storage", state: st.state === "UNKNOWN" && !m.storage_failures ? "UNKNOWN" : worstHealth([st.state === "UNKNOWN" ? "HEALTHY" : st.state, m.storage_failures ? "DEGRADED" : "HEALTHY"]), reason: st.probed ? `${st.failing} of ${st.probed} workers cannot reach object storage; ${m.storage_failures} write failures in 15 min` : "no worker reports a storage probe", metrics: { failures15m: m.storage_failures } });

  // ---- dead letters
  push({ rule: "dead_letters.growth", subject: "all", component: "dead-letters", state: level(m.dlq_1h, t.deadLettersPerHour), reason: `${m.dlq_1h} dead-lettered in the last hour, ${m.dlq_open} unresolved`, metrics: { lastHour: m.dlq_1h, open: m.dlq_open } });

  // ---- notifications: delivery failure rate, outbox backlog, platform-alert delivery failures
  const nr = rateLevel(m.notify_failed, m.notify_sent + m.notify_failed, t.notifyFailurePct, Math.min(t.minSamples, 5));
  const smtp = depState("smtp", ["email"]); // the notification workers' own provider probe
  const outboxAge = m.outbox_oldest ? Math.round((now.getTime() - m.outbox_oldest.getTime()) / 1000) : 0;
  const ns = worstHealth([nr.state, outboxAge > 900 ? "UNHEALTHY" : outboxAge > 300 ? "DEGRADED" : "HEALTHY", m.alert_delivery_failed ? "DEGRADED" : "HEALTHY", smtp.state === "UNKNOWN" ? "HEALTHY" : smtp.state]);
  push({ rule: "notifications.failing", subject: "email", component: "notifications", state: ns, reason: `${smtp.probed ? `${smtp.failing} of ${smtp.probed} notification workers cannot reach the mail provider; ` : ""}delivery failures ${nr.pct ?? 0}% (${m.notify_failed} of ${m.notify_sent + m.notify_failed} in 15 min); oldest unrelayed event ${outboxAge} s; ${m.alert_delivery_failed} platform-alert deliveries failed in 15 min`, metrics: { failurePct: nr.pct, outboxOldestSec: outboxAge, alertDeliveryFailed1h: m.alert_delivery_failed, smtpFailing: smtp.failing } });

  // ---- rollups and retention
  if (s["monitoring.rollups.enabled"]) {
    const lag = m.rollup_at ? Math.round((now.getTime() - m.rollup_at.getTime()) / 1000) : null;
    push({ rule: "rollups.lagging", subject: "performance", component: "rollups", state: lag === null ? "UNKNOWN" : level(lag, t.rollupLagSec), reason: lag === null ? "rollups have never run" : `last rollup run ${lag} s ago`, metrics: { lagSec: lag } });
  }
  const retAge = m.maintenance_ok_at ? (now.getTime() - m.maintenance_ok_at.getTime()) / 3_600_000 : null;
  push({ rule: "retention.failing", subject: "partitions", component: "retention", state: worstHealth([retAge === null ? "UNKNOWN" : level(retAge, t.retentionAgeHours), m.maintenance_failed ? "DEGRADED" : "HEALTHY"]), reason: `${retAge === null ? "partition maintenance has not run in 7 days" : `last successful partition maintenance ${retAge.toFixed(1)} h ago`}; ${m.maintenance_failed} failures in 2 h`, metrics: { ageHours: retAge === null ? null : Math.round(retAge * 10) / 10, failures2h: m.maintenance_failed } });
  // ---- release readiness: customer monitoring stalled (the platform's purpose), per tier
  const TIER_KEY: Record<string, "monitoring.http.enabled" | "monitoring.browser.enabled" | "monitoring.deepscan.enabled"> = { T1_HTTP: "monitoring.http.enabled", T2_RENDER: "monitoring.browser.enabled", T3_DEEP: "monitoring.deepscan.enabled" };
  for (const x of f.stalled) {
    if (!s[TIER_KEY[x.tier]!]) continue; // tier switched off: nothing is expected to run
    push({ rule: "monitoring.stalled", subject: x.tier, component: "customer-monitoring", state: level(x.overdue, t.stalledSchedules), reason: x.overdue ? `${x.overdue} of ${x.active} active ${x.tier} schedules are overdue (oldest by ${x.oldest_sec} s) — customer websites are not being checked` : `${x.active} active ${x.tier} schedules on time`, metrics: { [`${x.tier}.overdue`]: x.overdue, [`${x.tier}.active`]: x.active } });
  }
  // ---- timeout rate per execution queue
  const resultsBy = new Map(f.results.map((r) => [r.tier, r.n]));
  const QUEUE_TIER: Record<string, string> = { "http-monitoring": "T1_HTTP", "browser-monitoring": "T2_RENDER", "deep-scan": "T3_DEEP" };
  for (const [queue, tier] of Object.entries(QUEUE_TIER)) {
    const n = f.timeouts.find((x) => x.queue === queue)?.n ?? 0;
    const r = rateLevel(n, n + (resultsBy.get(tier) ?? 0), t.timeoutPct, t.minSamples);
    push({ rule: "executions.timeouts", subject: queue, component: `queue:${queue}`, state: r.state, reason: `${n} timeouts in 15 min (${r.pct ?? 0}%)`, metrics: { timeouts15m: n } });
  }
  // ---- maintenance tasks that used to fail silently: screenshot cleanup, deep-scan retention
  const cl = m.cleanup_failed > 0 && m.cleanup_ok === 0 ? "UNHEALTHY" : m.cleanup_failed > 0 ? "DEGRADED" : "HEALTHY";
  push({ rule: "cleanup.failing", subject: "artifacts-and-scans", component: "retention", state: cl, reason: `${m.cleanup_failed} failed and ${m.cleanup_ok} successful cleanup runs in 3 h (screenshots, deep-scan history)`, metrics: { cleanupFailed3h: m.cleanup_failed } });
  // ---- CPU and filesystem of every live process that reports them
  for (const h of f.hbs) {
    if ((now.getTime() - h.lastSeenAt.getTime()) / 1000 > s["ops.health.heartbeatStaleSec"]) continue;
    const meta = (h.meta ?? {}) as { cpuPct?: number; diskUsedPct?: number | null };
    if (typeof meta.cpuPct === "number") push({ rule: "resources.cpu", subject: h.workerId, component: h.kind === "scheduler" ? "scheduler" : `workers:${h.kind}`, state: level(meta.cpuPct, t.cpuPct), reason: `${h.workerId} CPU ${meta.cpuPct}% of one core`, metrics: {} });
    if (typeof meta.diskUsedPct === "number") push({ rule: "resources.disk", subject: h.workerId, component: h.kind === "scheduler" ? "scheduler" : `workers:${h.kind}`, state: level(meta.diskUsedPct, t.diskUsedPct), reason: `${h.workerId} filesystem ${meta.diskUsedPct}% used`, metrics: {} });
  }
  // ---- API and ingest processes (Redis heartbeat: they cannot write operational tables)
  if (redisOk) {
    for (const kind of ["api", "ingest"] as const) {
      const keys = await scanKeys(d.connection, `${d.prefix ?? "wim"}:ops:hb:${kind}:*`);
      const vals = keys.length ? (await d.connection.mget(...keys)).filter(Boolean).map((v) => JSON.parse(v!) as { id: string; checks: Record<string, boolean>; cpuPct: number }) : [];
      const failing = vals.filter((v) => Object.values(v.checks ?? {}).some((ok) => !ok));
      const st: HealthState = !vals.length ? "UNHEALTHY" : failing.length === vals.length ? "UNHEALTHY" : failing.length ? "DEGRADED" : "HEALTHY";
      push({ rule: "process.unavailable", subject: kind, component: `process:${kind}`, state: st, reason: !vals.length ? `no ${kind} process has reported for 30 s` : `${vals.length} ${kind} process(es) alive${failing.length ? `, ${failing.length} failing readiness (${failing.map((v) => Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k).join("+")).join(", ")})` : ""}`, metrics: { processes: vals.length } });
    }
  }
  return out;
}

async function scanKeys(r: Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await withTimeout(r.scan(cursor, "MATCH", pattern, "COUNT", 200), 3000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== "0" && out.length < 500);
  return out;
}

/**
 * Release readiness: the platform verdict, distinct from any single worker. "Is SiteSentinel doing its job?" — customer
 * monitoring on schedule, the pipeline (scheduler, queues, workers, gateway, runner) and the dependencies. A platform
 * can be UNHEALTHY with every worker individually alive (e.g. schedules overdue), and HEALTHY with one worker down.
 */
export function platformVerdict(components: Array<{ component: string; state: HealthState }>): { state: HealthState; customerMonitoring: HealthState; pipeline: HealthState; dependencies: HealthState } {
  const pick = (re: RegExp) => worstHealth(components.filter((c) => re.test(c.component)).map((c) => c.state));
  const customerMonitoring = pick(/^customer-monitoring$/);
  const pipeline = pick(/^(scheduler|queue:|workers:|gateway|browser-runner|process:)/);
  const dependencies = pick(/^(postgres|redis|storage|notifications)$/);
  const known = [customerMonitoring, pipeline, dependencies].filter((x) => x !== "UNKNOWN");
  return { state: known.length ? worstHealth(known) : "UNKNOWN", customerMonitoring, pipeline, dependencies };
}

// ===================================================================================================== evaluation
interface EvaluatorMemo { streaks: Record<string, number> }

/**
 * One evaluation: claim → collect → snapshot + alerts in one transaction. Returns ran=false when another evaluator
 * evaluated recently. Never throws for a Redis problem (that is a signal); throws when PostgreSQL is unusable — the
 * caller handles that with `DbOutageWatch`.
 */
export async function runPlatformEvaluation(d: EvaluationDeps, o: { force?: boolean; /** watchdogs: only claim when the last evaluation is this many intervals old */ graceFactor?: number } = {}): Promise<EvaluationReport> {
  const t0 = Date.now();
  const now = d.now?.() ?? new Date();
  const s = await loadSettings(d.db);
  const every = Math.round(s["ops.health.evaluateEverySec"] * (o.graceFactor ?? 1));
  const claimed = await withSystem(d.db, async (tx) => {
    await tx.$executeRaw`INSERT INTO platform_health (component, state, reasons, metrics, since, evaluated_at, evaluated_by)
      VALUES ('__evaluator', 'UNKNOWN', '[]', '{"streaks":{}}', now(), 'epoch', ${d.evaluatorId}) ON CONFLICT (component) DO NOTHING`;
    const r = await tx.$queryRaw<Array<{ ok: boolean }>>`
      UPDATE platform_health SET evaluated_at = ${now}, evaluated_by = ${d.evaluatorId}
       WHERE component = '__evaluator' AND (${o.force ?? false} OR evaluated_at <= ${now}::timestamptz - make_interval(secs => ${every - 1}))
      RETURNING true AS ok`;
    return r.length > 0;
  });
  if (!claimed) return { ran: false, signals: [], opened: [], recovered: [], notified: [], suppressed: [], ms: Date.now() - t0 };

  const signals = await collectSignals(d, s, now);
  const report = await withSystem(d.db, (tx) => applyEvaluation(tx, signals, s, now, d.evaluatorId));
  return { ran: true, signals, ...report, ms: Date.now() - t0 };
}

async function applyEvaluation(tx: Tx, signals: Signal[], s: SettingsSnapshot, now: Date, evaluatorId: string) {
  // ---- component snapshot (state + since), state changes into history
  const comps = new Map<string, Signal[]>();
  for (const x of signals) comps.set(x.component, [...(comps.get(x.component) ?? []), x]);
  const prev = new Map((await tx.platformHealth.findMany()).map((r) => [r.component, r]));
  for (const [component, xs] of comps) {
    const state = worstHealth(xs.map((x) => x.state));
    const reasons = xs.filter((x) => x.state !== "HEALTHY").map((x) => x.reason);
    const metrics = Object.assign({}, ...xs.map((x) => x.metrics ?? {}));
    const before = prev.get(component);
    const since = before && before.state === state ? before.since : now;
    await tx.platformHealth.upsert({
      where: { component },
      create: { component, state, reasons, metrics, since, evaluatedAt: now, evaluatedBy: evaluatorId },
      update: { state, reasons, metrics, since, evaluatedAt: now, evaluatedBy: evaluatorId },
    });
    if (!before || before.state !== state) await tx.systemHealthLog.create({ data: { component: "ops", metric: "state", value: ["HEALTHY", "UNKNOWN", "DEGRADED", "UNHEALTHY"].indexOf(state), labels: { component, from: before?.state ?? "NONE", to: state } } });
  }
  // components that no longer produce signals (e.g. a worker kind that is gone) are removed from the snapshot
  const gone = [...prev.keys()].filter((c) => c !== "__evaluator" && !comps.has(c));
  if (gone.length) await tx.platformHealth.deleteMany({ where: { component: { in: gone } } });

  const memoRow = prev.get("__evaluator");
  const memo: EvaluatorMemo = { streaks: ((memoRow?.metrics as unknown as EvaluatorMemo | undefined)?.streaks) ?? {} };
  const result = s["ops.alerts.enabled"] ? await processAlerts(tx, signals, s, now, memo) : { opened: [], recovered: [], notified: [], suppressed: [] };
  await tx.platformHealth.update({ where: { component: "__evaluator" }, data: { state: "HEALTHY", metrics: memo as object, reasons: [] } });
  return result;
}

// ===================================================================================================== alerts
const BAD = (st: HealthState) => st === "DEGRADED" || st === "UNHEALTHY";
const SEV_RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const;

async function processAlerts(tx: Tx, signals: Signal[], s: SettingsSnapshot, now: Date, memo: EvaluatorMemo) {
  const disabled = new Set(s["ops.alerts.disabledRules"]);
  const openAfter = s["ops.alerts.openAfterEvaluations"];
  const recoverAfter = s["ops.alerts.recoverAfterEvaluations"];
  const cooldownMs = s["ops.alerts.cooldownMin"] * 60_000;
  const res = { opened: [] as string[], recovered: [] as string[], notified: [] as string[], suppressed: [] as string[] };

  const open = await tx.platformAlert.findMany({ where: { state: { not: "RECOVERED" } } });
  const openByFp = new Map(open.map((a) => [a.fingerprint, a]));
  const sigByFp = new Map(signals.map((x) => [`${x.rule}:${x.subject}`, x]));

  // root causes failing now (for suppression): rule → open alert id
  const rootOpen = new Map<AlertRule, string>();
  for (const a of open) if (ALERT_DEPENDENCIES[a.rule as AlertRule] && BAD(sigByFp.get(a.fingerprint)?.state ?? "HEALTHY")) rootOpen.set(a.rule as AlertRule, a.id);
  const suppressor = (rule: AlertRule) => {
    for (const [root, id] of rootOpen) if (root !== rule && ALERT_DEPENDENCIES[root]!.includes(rule)) return id;
    return null;
  };

  // notification budget (alert-storm cap)
  const [{ n: sent10 }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM platform_alert_events WHERE type = 'NOTIFY_QUEUED' AND at > ${now}::timestamptz - interval '10 minutes'`;
  let budget = s["ops.alerts.maxNotificationsPer10Min"] - sent10;
  let stormSuppressed = 0;
  const notify = async (alertId: string, event: "OPENED" | "REOPENED" | "ESCALATED" | "RECOVERED" | "RENOTIFY", force = false) => {
    // recoveries are never held back: whoever was told about a problem must learn that it is over
    if (event === "RECOVERED") force = true;
    if (!force && budget <= 0) {
      stormSuppressed++;
      await tx.platformAlertEvent.create({ data: { alertId, at: now, type: "NOTIFY_SUPPRESSED", details: { reason: "alert-storm cap reached", event } } });
      if (event !== "RECOVERED") await tx.platformAlert.update({ where: { id: alertId }, data: { notifyState: "SUPPRESSED" } });
      res.suppressed.push(alertId);
      return;
    }
    budget--;
    const seq = (await tx.platformAlertEvent.count({ where: { alertId, type: "NOTIFY_QUEUED" } })) + 1;
    await tx.$executeRaw`INSERT INTO outbox_events (org_id, topic, payload, dedupe_key)
      VALUES (NULL, 'platform.alert', ${JSON.stringify({ alertId, event })}::jsonb, ${`palert:${alertId}:${event}:${seq}`}) ON CONFLICT (dedupe_key) DO NOTHING`;
    await tx.platformAlertEvent.create({ data: { alertId, at: now, type: "NOTIFY_QUEUED", details: { event } } });
    await tx.platformAlert.update({ where: { id: alertId }, data: { lastNotifiedAt: now, notifyState: "QUEUED" } });
    res.notified.push(alertId);
  };

  for (const x of signals) {
    const fp = `${x.rule}:${x.subject}`;
    if (disabled.has(x.rule)) { delete memo.streaks[fp]; continue; }
    const cur = openByFp.get(fp);
    const streak = memo.streaks[fp] ?? 0;
    if (x.state === "UNKNOWN") continue; // neither proves failure nor recovery
    if (BAD(x.state)) {
      memo.streaks[fp] = streak > 0 ? streak + 1 : 1;
      const severity = alertSeverity(x.rule, x.state, s["ops.alerts.severity"]);
      const details = { state: x.state, metrics: x.metrics ?? {} };
      if (cur) {
        const escalated = SEV_RANK[severity] > SEV_RANK[cur.severity as keyof typeof SEV_RANK];
        await tx.platformAlert.update({ where: { id: cur.id }, data: { lastSeenAt: now, occurrences: { increment: 1 }, reason: x.reason, details, ...(escalated ? { severity } : {}) } });
        if (escalated) {
          await tx.platformAlertEvent.create({ data: { alertId: cur.id, at: now, type: "ESCALATED", details: { from: cur.severity, to: severity, reason: x.reason } } });
          if (!suppressor(x.rule) && cur.state === "OPEN") await notify(cur.id, "ESCALATED");
        }
        continue;
      }
      if (memo.streaks[fp]! < openAfter) continue;
      const sup = suppressor(x.rule);
      // flapping: a recent recovery of the same fingerprint is reopened, not duplicated
      const recent = await tx.platformAlert.findFirst({ where: { fingerprint: fp, state: "RECOVERED", recoveredAt: { gt: new Date(now.getTime() - cooldownMs) } }, orderBy: { recoveredAt: "desc" } });
      let id: string;
      if (recent) {
        await tx.platformAlert.update({ where: { id: recent.id }, data: { state: "OPEN", recoveredAt: null, acknowledgedAt: null, acknowledgedById: null, lastSeenAt: now, occurrences: { increment: 1 }, reopenCount: { increment: 1 }, severity, reason: x.reason, details, suppressedBy: sup } });
        await tx.platformAlertEvent.create({ data: { alertId: recent.id, at: now, type: "REOPENED", details: { reason: x.reason, severity } } });
        id = recent.id;
        if (sup) await suppressedEvent(id, sup);
        else if (!recent.lastNotifiedAt || now.getTime() - recent.lastNotifiedAt.getTime() > cooldownMs) await notify(id, "REOPENED");
      } else {
        const a = await tx.platformAlert.create({ data: { fingerprint: fp, rule: x.rule, component: x.component, severity, state: "OPEN", reason: x.reason, details, openedAt: now, lastSeenAt: now, suppressedBy: sup, notifyState: sup ? "SUPPRESSED" : "PENDING" } });
        await tx.platformAlertEvent.create({ data: { alertId: a.id, at: now, type: "OPENED", details: { reason: x.reason, severity, state: x.state } } });
        id = a.id;
        if (sup) await suppressedEvent(id, sup);
        else await notify(id, "OPENED");
      }
      if (ALERT_DEPENDENCIES[x.rule]) rootOpen.set(x.rule, id);
      openByFp.set(fp, { id } as never);
      res.opened.push(id);
    } else {
      memo.streaks[fp] = streak < 0 ? streak - 1 : -1;
      if (cur && -memo.streaks[fp]! >= recoverAfter) await recover(cur, x.reason);
      if (!cur && streak <= 0) delete memo.streaks[fp]; // keep memo small: only failing or recovering fingerprints
    }
  }
  // open alerts whose subject no longer exists (e.g. a worker kind removed) recover as well
  for (const a of open) {
    if (sigByFp.has(a.fingerprint) || a.rule === "alerts.storm") continue;
    memo.streaks[a.fingerprint] = Math.min(-1, (memo.streaks[a.fingerprint] ?? 0) - 1);
    if (-memo.streaks[a.fingerprint]! >= recoverAfter) await recover(a, "signal no longer reported");
  }
  // catch-up: alerts still open that were never sent — held by the storm cap, or suppressed by a root cause that has
  // since recovered — are sent now (within the budget), oldest first
  const held = await tx.platformAlert.findMany({ where: { state: "OPEN", notifyState: "SUPPRESSED", rule: { not: "alerts.storm" } }, orderBy: { openedAt: "asc" }, take: 20 });
  for (const a of held) {
    if (a.suppressedBy) {
      const root = await tx.platformAlert.findUnique({ where: { id: a.suppressedBy }, select: { state: true } });
      if (root && root.state !== "RECOVERED") continue; // still explained by a failing dependency
      await tx.platformAlert.update({ where: { id: a.id }, data: { suppressedBy: null } });
    }
    if (budget <= 0) break;
    await notify(a.id, "OPENED");
  }
  // renotify unacknowledged critical alerts
  const every = s["ops.alerts.renotifyCriticalMin"];
  if (every > 0) {
    const due = await tx.platformAlert.findMany({ where: { state: "OPEN", severity: "CRITICAL", suppressedBy: null, lastNotifiedAt: { lt: new Date(now.getTime() - every * 60_000) } } });
    for (const a of due) await notify(a.id, "RENOTIFY");
  }
  // storm summary: one alert, always sent, recovers when the storm is over
  const stormFp = "alerts.storm:platform";
  const storm = await tx.platformAlert.findFirst({ where: { fingerprint: stormFp, state: { not: "RECOVERED" } } });
  if (stormSuppressed && !storm) {
    const a = await tx.platformAlert.create({ data: { fingerprint: stormFp, rule: "alerts.storm", component: "alerts", severity: "CRITICAL", state: "OPEN", reason: `${stormSuppressed} alert notifications held back by the storm cap — see the alerts page`, details: { held: stormSuppressed }, openedAt: now, lastSeenAt: now } });
    await tx.platformAlertEvent.create({ data: { alertId: a.id, at: now, type: "OPENED", details: { held: stormSuppressed } } });
    await notify(a.id, "OPENED", true);
  } else if (storm && stormSuppressed) {
    await tx.platformAlert.update({ where: { id: storm.id }, data: { lastSeenAt: now, occurrences: { increment: 1 }, details: { held: ((storm.details as { held?: number }).held ?? 0) + stormSuppressed } } });
  } else if (storm && now.getTime() - storm.lastSeenAt.getTime() > 10 * 60_000) {
    await recover(storm, "no notifications held back for 10 minutes");
  }
  return res;

  async function suppressedEvent(alertId: string, by: string) {
    await tx.platformAlertEvent.create({ data: { alertId, at: now, type: "SUPPRESSED", details: { suppressedBy: by, reason: "a shared dependency is failing; this alert is recorded, not sent" } } });
    res.suppressed.push(alertId);
  }
  async function recover(a: { id: string; fingerprint: string; notifyState: string }, reason: string) {
    await tx.platformAlert.update({ where: { id: a.id }, data: { state: "RECOVERED", recoveredAt: now, reason } });
    await tx.platformAlertEvent.create({ data: { alertId: a.id, at: now, type: "RECOVERED", details: { reason } } });
    delete memo.streaks[a.fingerprint];
    res.recovered.push(a.id);
    // tell people about the recovery only if they were told about the problem
    if (["QUEUED", "SENT", "FAILED"].includes(a.notifyState)) await notify(a.id, "RECOVERED", true);
  }
}

// ===================================================================================================== PostgreSQL outage
/**
 * When PostgreSQL itself is unusable nothing can be recorded there. The evaluating process keeps the outage in memory,
 * sends a direct alert through the existing e-mail queue (Redis; recipients from OPS_FALLBACK_ALERT_EMAILS because the
 * database is unreachable), logs it, and — once the database is back — records the outage as an alert with its real
 * start time and notifies the recovery through the normal outbox path.
 */
export class DbOutageWatch {
  private since: Date | null = null;
  private failures = 0;
  private sent = false;
  constructor(private readonly o: { emailQueue: Queue; log: Logger; evaluatorId: string; openAfter?: number }) {}
  async failed(err: unknown) {
    this.failures++;
    this.since ??= new Date();
    const msg = sanitizeError((err as Error)?.message ?? err).slice(0, 160);
    this.o.log.error({ alert: "postgres.unavailable", since: this.since.toISOString(), failures: this.failures, err: msg }, "PLATFORM ALERT: PostgreSQL unavailable");
    if (!this.sent && this.failures >= (this.o.openAfter ?? 2)) {
      const hour = Math.floor(this.since.getTime() / 3_600_000);
      await this.o.emailQueue.add("PLATFORM_ALERT_DIRECT", { kind: "PLATFORM_ALERT_DIRECT", rule: "postgres.unavailable", since: this.since.toISOString(), reason: msg, evaluator: this.o.evaluatorId },
        { jobId: `ops-direct.postgres.${hour}`, attempts: 10, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 7 * 86_400 } })
        .then(() => { this.sent = true; })
        .catch((e) => this.o.log.error({ err: sanitizeError((e as Error).message) }, "PLATFORM ALERT: direct alert could not be queued (Redis unavailable too) — see logs"));
    }
  }
  /** call after a successful evaluation: records a past outage durably and notifies its recovery */
  async succeeded(db: Db) {
    if (!this.since) return;
    const since = this.since, failures = this.failures, notified = this.sent;
    this.since = null; this.failures = 0; this.sent = false;
    if (failures < (this.o.openAfter ?? 2)) return;
    await withSystem(db, async (tx) => {
      const now = new Date();
      // several evaluating processes (scheduler, watchdog) see the same outage: record it once
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wim.ops.postgres-outage'))`;
      const seen = await tx.platformAlert.findFirst({ where: { rule: "postgres.unavailable", recoveredAt: { gte: new Date(since.getTime() - 120_000) } } });
      if (seen) {
        await tx.platformAlertEvent.create({ data: { alertId: seen.id, at: now, type: "RECOVERED", details: { alsoDetectedBy: this.o.evaluatorId, since: since.toISOString() } } });
        return;
      }
      const a = await tx.platformAlert.create({ data: { fingerprint: "postgres.unavailable:primary", rule: "postgres.unavailable", component: "postgres", severity: "CRITICAL", state: "RECOVERED", reason: `PostgreSQL was unavailable for ${Math.round((now.getTime() - since.getTime()) / 1000)} s (detected by ${this.o.evaluatorId})`, details: { failures, directAlertQueued: notified }, openedAt: since, lastSeenAt: now, recoveredAt: now, notifyState: notified ? "SENT" : "NONE", occurrences: failures } });
      await tx.platformAlertEvent.createMany({ data: [
        { alertId: a.id, at: since, type: "OPENED", details: { recordedAfterRecovery: true } },
        ...(notified ? [{ alertId: a.id, at: since, type: "NOTIFY_QUEUED", details: { via: "direct e-mail (database unavailable)" } }] : []),
        { alertId: a.id, at: now, type: "RECOVERED", details: {} },
      ] });
      if (notified) await tx.$executeRaw`INSERT INTO outbox_events (org_id, topic, payload, dedupe_key)
        VALUES (NULL, 'platform.alert', ${JSON.stringify({ alertId: a.id, event: "RECOVERED" })}::jsonb, ${`palert:${a.id}:RECOVERED:1`}) ON CONFLICT DO NOTHING`;
    });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms).unref())]);
}
