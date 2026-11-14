import { z } from "zod";

/**
 * Phase 4H: platform health vocabulary (ARCHITECTURE.md D-91…). Pure functions; the evaluator in @wim/queue gathers the
 * facts, these decide. A missing or unknown signal is never treated as healthy.
 */
export const HEALTH_STATES = ["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
const RANK: Record<HealthState, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, UNHEALTHY: 3 };
export const worstHealth = (states: HealthState[]): HealthState =>
  states.reduce<HealthState>((a, b) => (RANK[b] > RANK[a] ? b : a), states.length ? "HEALTHY" : "UNKNOWN");

/** Alert rules. One fingerprint per rule + subject (e.g. `queue.backlog:deep-scan`). */
export const ALERT_RULES = [
  "scheduler.unavailable",
  "worker.heartbeat_expired",
  "worker.not_processing",
  "worker.dependency_unreachable",
  "worker.restarts",
  "worker.capacity",
  "queue.backlog",
  "dead_letters.growth",
  "redis.unavailable",
  "postgres.unavailable",
  "gateway.unavailable",
  "runner.failures",
  "deepscan.failures",
  "storage.unavailable",
  "notifications.failing",
  "rollups.lagging",
  "retention.failing",
  "resources.utilization",
  "alerts.storm",
  // release readiness (operational coverage)
  "monitoring.stalled",
  "executions.timeouts",
  "process.unavailable",
  "resources.cpu",
  "resources.disk",
  "cleanup.failing",
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

/**
 * Shared dependencies: while one of these is failing, alerts of the rules listed for it are recorded but not sent
 * (alert-storm protection — one root cause, one notification).
 */
export const ALERT_DEPENDENCIES: Partial<Record<AlertRule, readonly AlertRule[]>> = {
  "postgres.unavailable": ["monitoring.stalled", "process.unavailable", "cleanup.failing", "scheduler.unavailable", "worker.heartbeat_expired", "worker.not_processing", "worker.dependency_unreachable", "queue.backlog", "rollups.lagging", "retention.failing", "notifications.failing", "dead_letters.growth", "runner.failures", "deepscan.failures"],
  "redis.unavailable": ["monitoring.stalled", "process.unavailable", "scheduler.unavailable", "worker.heartbeat_expired", "worker.not_processing", "worker.dependency_unreachable", "queue.backlog", "notifications.failing", "dead_letters.growth", "runner.failures", "deepscan.failures"],
  "gateway.unavailable": ["worker.dependency_unreachable", "runner.failures", "deepscan.failures", "queue.backlog", "worker.not_processing", "dead_letters.growth"],
  "scheduler.unavailable": ["rollups.lagging", "retention.failing", "queue.backlog", "monitoring.stalled"],
  "storage.unavailable": ["worker.dependency_unreachable"],
};

const Pair = (max = Number.MAX_SAFE_INTEGER) => z.object({ warn: z.number().min(0).max(max), crit: z.number().min(0).max(max) }).strict()
  .refine((p) => p.warn < p.crit, { message: "warning must be below critical" });
export const AlertThresholds = z.object({
  schedulerStaleSec: Pair(3600),
  queueOldestSec: Pair(86_400),
  queueWaiting: Pair(10_000_000),
  deadLettersPerHour: Pair(1_000_000),
  infraFailurePct: Pair(100),
  notifyFailurePct: Pair(100),
  rollupLagSec: Pair(86_400),
  retentionAgeHours: Pair(720),
  utilizationPct: Pair(100),
  dbConnectionsPct: Pair(100),
  redisMemoryPct: Pair(100),
  workerRestartsPerHour: Pair(1000),
  /** release readiness — optional keys with defaults so stored values from 4H stay valid */
  timeoutPct: Pair(100).default({ warn: 10, crit: 30 }),
  cpuPct: Pair(100).default({ warn: 85, crit: 97 }),
  diskUsedPct: Pair(100).default({ warn: 85, crit: 95 }),
  stalledSchedules: Pair(10_000_000).default({ warn: 1, crit: 50 }),
  /** failure percentages are only judged with at least this many attempts in the window */
  minSamples: z.number().int().min(1).max(10_000),
}).strict();
export type AlertThresholds = z.infer<typeof AlertThresholds>;
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  schedulerStaleSec: { warn: 30, crit: 90 },
  queueOldestSec: { warn: 300, crit: 900 },
  queueWaiting: { warn: 1000, crit: 10_000 },
  deadLettersPerHour: { warn: 5, crit: 25 },
  infraFailurePct: { warn: 10, crit: 30 },
  notifyFailurePct: { warn: 10, crit: 50 },
  rollupLagSec: { warn: 600, crit: 1800 },
  retentionAgeHours: { warn: 3, crit: 6 },
  utilizationPct: { warn: 85, crit: 98 },
  dbConnectionsPct: { warn: 80, crit: 95 },
  redisMemoryPct: { warn: 80, crit: 95 },
  workerRestartsPerHour: { warn: 3, crit: 10 },
  timeoutPct: { warn: 10, crit: 30 },
  cpuPct: { warn: 85, crit: 97 },
  diskUsedPct: { warn: 85, crit: 95 },
  stalledSchedules: { warn: 1, crit: 50 },
  minSamples: 10,
};

/** Value against a warn/crit pair (higher is worse). */
export function level(value: number | null | undefined, p: { warn: number; crit: number }): HealthState {
  if (value === null || value === undefined || Number.isNaN(value)) return "UNKNOWN";
  return value >= p.crit ? "UNHEALTHY" : value >= p.warn ? "DEGRADED" : "HEALTHY";
}

/** A failure rate is only judged with enough samples — otherwise it is healthy-but-thin, never alarming on 1 of 2. */
export function rateLevel(failed: number, total: number, p: { warn: number; crit: number }, minSamples: number): { state: HealthState; pct: number | null } {
  if (total < minSamples) return { state: "HEALTHY", pct: total ? Math.round((failed / total) * 1000) / 10 : null };
  const pct = Math.round((failed / total) * 1000) / 10;
  return { state: level(pct, p), pct };
}

export interface DependencyProbe { ok: boolean; ms?: number; at: string; error?: string }
export interface WorkerFacts {
  workerId: string;
  kind: string;
  lastSeenAt: Date;
  startedAt: Date;
  activeJobs: number;
  capacity: number;
  processed: number;
  failed: number;
  timeouts: number;
  lastJobAt: Date | null;
  rssMb: number | null;
  deps: Record<string, DependencyProbe> | null;
}
export interface WorkerHealth {
  state: HealthState;
  /** heartbeat fresh */
  alive: boolean;
  /** all reported dependencies reachable (null = none reported) */
  depsOk: boolean | null;
  failingDeps: string[];
  /** free job slots */
  available: number;
  utilizationPct: number;
  memoryPct: number | null;
  reasons: string[];
}

/**
 * One worker: alive (fresh heartbeat), able to reach its dependencies, has capacity. Whether a QUEUE is being processed
 * is decided per queue (`queueProcessing`) because one idle worker among busy ones is fine.
 */
export function classifyWorker(w: WorkerFacts, now: Date, o: { staleSec: number; memoryMb: number; utilization: { warn: number; crit: number } }): WorkerHealth {
  const reasons: string[] = [];
  const age = Math.round((now.getTime() - w.lastSeenAt.getTime()) / 1000);
  const alive = age <= o.staleSec;
  const failingDeps = Object.entries(w.deps ?? {}).filter(([, d]) => !d.ok).map(([k]) => k).sort();
  const depsOk = w.deps && Object.keys(w.deps).length ? failingDeps.length === 0 : null;
  const utilizationPct = w.capacity > 0 ? Math.round((w.activeJobs / w.capacity) * 100) : 0;
  const memoryPct = w.rssMb === null ? null : Math.round((w.rssMb / o.memoryMb) * 100);
  const states: HealthState[] = [];
  if (!alive) { states.push("UNHEALTHY"); reasons.push(`heartbeat expired ${age} s ago`); }
  if (failingDeps.length) { states.push("DEGRADED"); reasons.push(`cannot reach ${failingDeps.join(", ")}`); }
  const mem = level(memoryPct, o.utilization);
  if (alive && (mem === "DEGRADED" || mem === "UNHEALTHY")) { states.push("DEGRADED"); reasons.push(`memory ${memoryPct}% of budget`); }
  return { state: worstHealth(states.length ? states : ["HEALTHY"]), alive, depsOk, failingDeps, available: Math.max(0, w.capacity - w.activeJobs), utilizationPct, memoryPct, reasons };
}

/**
 * Is a queue actually being worked? Jobs waiting + no worker of the queue finished a job within the stall window
 * (and none is busy) → not processing, even though heartbeats are fresh.
 */
export function queueProcessing(o: { waiting: number; aliveWorkers: number; busyWorkers: number; lastJobAt: Date | null; now: Date; stallSec: number; oldestWaitingSec: number | null }): { processing: boolean | null; reason?: string } {
  if (o.waiting === 0) return { processing: null };
  if (o.aliveWorkers === 0) return { processing: false, reason: "jobs waiting and no live worker" };
  if (o.busyWorkers > 0) return { processing: true };
  const sinceJob = o.lastJobAt ? (o.now.getTime() - o.lastJobAt.getTime()) / 1000 : Infinity;
  if (sinceJob > o.stallSec && (o.oldestWaitingSec ?? 0) > o.stallSec) return { processing: false, reason: `jobs waiting ${o.oldestWaitingSec} s; no job finished for ${Number.isFinite(sinceJob) ? `${Math.round(sinceJob)} s` : "ever"}` };
  return { processing: true };
}

/** Default severity: unhealthy → critical, degraded → warning; overridable per rule (setting `ops.alerts.severity`). */
export function alertSeverity(rule: AlertRule, state: HealthState, overrides: Partial<Record<AlertRule, "CRITICAL" | "WARNING" | "INFO">>): "CRITICAL" | "WARNING" | "INFO" {
  return overrides[rule] ?? (state === "UNHEALTHY" ? "CRITICAL" : "WARNING");
}
