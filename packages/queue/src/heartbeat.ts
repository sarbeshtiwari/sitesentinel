import { statfsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import type { Redis } from "ioredis";
import type { DependencyProbe } from "@wim/core";
import { withSystem, type Db } from "@wim/db";
import type { Logger } from "@wim/logger";
import { healthMetric, sanitizeError } from "./util.js";

export interface HeartbeatGauges { activeJobs: number; capacity: number; processed?: number; failed?: number; timeouts?: number; lastJobAt?: Date | null }

/**
 * Phase 4H heartbeat for every long-running process (execution workers, scheduler, notification worker).
 * Reports: alive (lastSeenAt), work done (processed / failed / timeouts / lastJobAt), capacity, memory and
 * dependency reachability (Redis always, plus process-specific probes such as the egress gateway, browser runner or
 * object storage). Probe results carry no URLs, credentials or customer data — only ok / latency / a sanitised error.
 * A start event is recorded so restarts (crash loops) are visible.
 */
export function createHeartbeat(o: {
  db: Db; connection?: Redis; log: Logger; workerId: string; kind: string; version?: string; startedAt?: Date;
  probes?: Record<string, () => Promise<void>>; meta?: () => Promise<Record<string, number | boolean | string>>;
  gauges: () => HeartbeatGauges; probeEveryMs?: number; sampleEveryMs?: number; probeTimeoutMs?: number;
}) {
  const startedAt = o.startedAt ?? new Date();
  let deps: Record<string, DependencyProbe> = {};
  let meta: Record<string, number | boolean | string> | undefined;
  let lastProbe = 0;
  let lastSample = 0;
  const timeout = o.probeTimeoutMs ?? 5000;
  // release readiness: process CPU (share of one core since the previous beat) and container filesystem usage
  let cpuPrev = process.cpuUsage();
  let cpuAt = Date.now();
  const resources = () => {
    const now = Date.now();
    const c = process.cpuUsage(cpuPrev);
    const cpuPct = Math.round(((c.user + c.system) / 1000 / Math.max(1, now - cpuAt)) * 100);
    cpuPrev = process.cpuUsage(); cpuAt = now;
    let diskUsedPct: number | null = null;
    try { const f = statfsSync(tmpdir()); diskUsedPct = f.blocks ? Math.round(((f.blocks - f.bavail) / f.blocks) * 100) : null; } catch { /* not supported */ }
    return { cpuPct, diskUsedPct };
  };

  async function probe(name: string, fn: () => Promise<void>) {
    const t = Date.now();
    try {
      await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("probe timed out")), timeout).unref())]);
      deps[name] = { ok: true, ms: Date.now() - t, at: new Date().toISOString() };
    } catch (e) {
      deps[name] = { ok: false, ms: Date.now() - t, at: new Date().toISOString(), error: sanitizeError((e as Error).message).slice(0, 120) };
    }
  }
  async function probeAll() {
    lastProbe = Date.now();
    deps = {};
    const all: Record<string, () => Promise<void>> = { ...(o.connection ? { redis: async () => { await o.connection!.ping(); } } : {}), ...(o.probes ?? {}) };
    await Promise.all(Object.entries(all).map(([k, fn]) => probe(k, fn)));
    if (o.meta) meta = await o.meta().catch(() => undefined);
  }

  async function beat() {
    if (Date.now() - lastProbe >= (o.probeEveryMs ?? 30_000)) await probeAll();
    const g = o.gauges();
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const res = resources();
    const data = {
      lastSeenAt: new Date(), activeJobs: g.activeJobs, capacity: g.capacity, rssMb, processed: g.processed ?? 0, failed: g.failed ?? 0,
      timeouts: g.timeouts ?? 0, lastJobAt: g.lastJobAt ?? null, deps: deps as object, meta: { ...(meta ?? {}), ...res } as object,
    };
    const sample = Date.now() - lastSample >= (o.sampleEveryMs ?? 120_000);
    await withSystem(o.db, async (tx) => {
      await tx.workerHeartbeat.upsert({
        where: { workerId: o.workerId },
        create: { workerId: o.workerId, kind: o.kind, region: "r1", version: o.version ?? "dev", hostname: hostname(), startedAt, ...data },
        update: data,
      });
      // history for the admin trend view: one aggregate sample per worker every 2 minutes
      if (sample) await healthMetric(tx, "worker", "sample", g.activeJobs, { kind: o.kind, worker: o.workerId, capacity: g.capacity, processed: g.processed ?? 0, failed: g.failed ?? 0, rss: rssMb });
    }).then(() => { if (sample) lastSample = Date.now(); }).catch((e) => o.log.warn({ err: sanitizeError((e as Error).message) }, "heartbeat failed"));
  }

  return {
    beat,
    /** record a process start (restarts per hour = crash-loop signal) */
    async started() {
      await withSystem(o.db, (tx) => healthMetric(tx, "worker", "start", 1, { kind: o.kind, worker: o.workerId })).catch(() => undefined);
    },
    async remove() {
      await withSystem(o.db, (tx) => tx.workerHeartbeat.deleteMany({ where: { workerId: o.workerId } })).catch(() => undefined);
    },
    deps: () => deps,
  };
}

/**
 * Release readiness: liveness for processes WITHOUT write access to operational tables (API: customer role; ingest:
 * ingest role). They publish a short-lived Redis key; the evaluator reads them. TTL = 3 × interval, so a stopped
 * process disappears and is reported as missing — never as healthy.
 */
export function createRedisHeartbeat(o: { connection: Redis; prefix: string; kind: "api" | "ingest"; id: string; everyMs?: number; check?: () => Promise<Record<string, boolean>> }) {
  const every = o.everyMs ?? 10_000;
  const key = `${o.prefix}:ops:hb:${o.kind}:${o.id}`;
  let cpuPrev = process.cpuUsage(), cpuAt = Date.now();
  const beat = async () => {
    const checks = o.check ? await o.check().catch(() => ({ self: false })) : {};
    const c = process.cpuUsage(cpuPrev); const now = Date.now();
    const cpuPct = Math.round(((c.user + c.system) / 1000 / Math.max(1, now - cpuAt)) * 100);
    cpuPrev = process.cpuUsage(); cpuAt = now;
    await o.connection.set(key, JSON.stringify({ kind: o.kind, id: o.id, at: new Date().toISOString(), checks, rssMb: Math.round(process.memoryUsage().rss / 1048576), cpuPct }), "PX", every * 3).catch(() => undefined);
  };
  void beat();
  const t = setInterval(() => void beat(), every);
  t.unref();
  return { stop: async () => { clearInterval(t); await o.connection.del(key).catch(() => undefined); } };
}
