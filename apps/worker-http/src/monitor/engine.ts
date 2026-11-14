import type { Redis } from "ioredis";
import { evaluateHttp, parseHttpCheckConfig, type HttpEvaluation, type SettingsSnapshot } from "@wim/core";
import { loadSettings, withSystem, type Db } from "@wim/db";
import type { Logger } from "@wim/logger";
import { httpProbe, signCapability, type ProbeResult } from "@wim/netguard";
import { addUsage, SecurityError, TransientError, type ExecutionContext, type ExecutionResult } from "@wim/queue";
import { persistResult } from "./persist.js";
import { loadTarget } from "./target.js";

export interface HttpEngineDeps {
  db: Db;
  redis: Redis;
  prefix: string;
  log: Logger;
  gatewayUrl: string;
  tokenSecret: string;
  userAgent?: string;
  /** TEST ONLY (fixture PKI); ignored unless NODE_ENV=test */
  testCa?: string;
  /** TEST ONLY crash points */
  hooks?: { afterProbe?: (executionId: string) => void | Promise<void>; afterPersist?: (executionId: string) => void | Promise<void> };
}

/** Connection-level failures that could equally be our egress path failing. */
const CONNECTION_LEVEL = new Set(["DNS_FAILURE", "CONNECTION_FAILED", "CONNECT_TIMEOUT"]);

/**
 * Tier A HTTP availability engine: consumes `http-monitoring` executions (the 4B runtime has
 * already validated the payload, the tenant binding and current eligibility).
 */
export function createHttpEngine(d: HttpEngineDeps) {
  let cached: { at: number; s: SettingsSnapshot } | null = null;
  const settings = async () => {
    if (!cached || Date.now() - cached.at > 10_000) cached = { at: Date.now(), s: await loadSettings(d.db) };
    return cached.s;
  };
  let canary: { at: number; ok: boolean } | null = null;

  /** Is our own path to the internet healthy? Probed only after a connection-level failure, cached 15 s. */
  async function egressHealthy(s: SettingsSnapshot, targetHost: string): Promise<boolean | null> {
    const url = s["monitoring.http.canaryUrl"];
    if (!url) return null;
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
    if (host === targetHost) return null;
    if (canary && Date.now() - canary.at < 15_000) return canary.ok;
    const r = await httpProbe({
      url, method: "HEAD", timeoutMs: 8000, maxRedirects: 3, maxBodyBytes: 1024, testCa: d.testCa,
      gateway: { url: d.gatewayUrl, token: (h) => signCapability(d.tokenSecret, { o: null, w: null, e: "canary", k: "canary", h }, 60) },
    });
    canary = { at: Date.now(), ok: r.error === null };
    return canary.ok;
  }

  return async function handle(ctx: ExecutionContext): Promise<ExecutionResult> {
    const s = await settings();
    const startedAt = new Date();
    const target = await withSystem(d.db, (tx) => loadTarget(tx, ctx.orgId, ctx.websiteId));
    let probe: ProbeResult | null = null;
    let ev: HttpEvaluation;
    if ("problem" in target) {
      ev = evaluateHttp({ error: target.problem, final: null, https: false, tls: null }, parseHttpCheckConfig({}), startedAt);
    } else {
      // One capability per hop, bound to that hop's host, the org, the website and this execution.
      probe = await httpProbe({
        url: target.url, method: target.config.method, timeoutMs: target.config.timeoutMs, maxRedirects: target.config.maxRedirects,
        maxBodyBytes: s["monitoring.http.maxBodyBytes"], userAgent: d.userAgent, signal: ctx.signal, testCa: d.testCa,
        gateway: { url: d.gatewayUrl, token: (host) => signCapability(d.tokenSecret, { o: ctx.orgId, w: ctx.websiteId, e: ctx.executionId, k: "http", h: host }, 120) },
      });
      if (probe.error === "ABORTED") throw new Error("aborted"); // cancellation/shutdown: the runtime decides
      await d.hooks?.afterProbe?.(ctx.executionId);
      const infra = probe.error && CONNECTION_LEVEL.has(probe.error) ? (await egressHealthy(s, target.host)) === false : false;
      ev = evaluateHttp({ error: probe.error, final: probe.final, https: target.https, tls: probe.tls }, target.config, new Date(), infra);
    }

    if (ev.failureCategory === "GATEWAY_INFRASTRUCTURE") {
      // Our outage, not the customer's. Retry (same execution) unless this is the last attempt or the
      // fleet-wide circuit is open — then record an INCONCLUSIVE result (excluded from uptime).
      const key = `${d.prefix}:circuit:http-infra:${Math.floor(Date.now() / 30_000)}`;
      const n = await d.redis.incr(key).catch(() => Number.MAX_SAFE_INTEGER);
      await d.redis.expire(key, 60).catch(() => undefined);
      await withSystem(d.db, (tx) => tx.systemHealthLog.create({ data: { component: "http-monitoring", metric: "infra_failure", value: 1, labels: { kind: ev.failureKind ?? "?" } } })).catch(() => undefined);
      if (ctx.attempt < ctx.maxAttempts && n <= s["monitoring.http.circuitThreshold"]) throw new TransientError(`monitoring infrastructure: ${ev.failureKind}`);
    }

    const out = await withSystem(d.db, async (tx) => {
      const r = await persistResult(tx, {
        executionId: ctx.executionId, orgId: ctx.orgId, websiteId: ctx.websiteId, windowStart: ctx.windowStart, attempt: ctx.attempt,
        startedAt, finishedAt: new Date(), target: "problem" in target ? null : target, probe, ev,
      }, s);
      if (!r.duplicate) {
        await addUsage(tx, ctx.orgId, {
          "http.checks": 1, "http.bytes": probe?.final?.bytes ?? 0, "http.redirects": Math.max(0, (probe?.hops.length ?? 1) - 1),
          ...(ev.status === "INCONCLUSIVE" ? { "http.inconclusive": 1 } : {}),
        });
      }
      return r;
    });
    await d.hooks?.afterPersist?.(ctx.executionId);
    if (ev.failureCategory === "SECURITY_REJECTION") {
      // The gateway refused OUR credentials: a platform misconfiguration. Recorded (inconclusive) and dead-lettered, never retried.
      throw new SecurityError("egress gateway rejected the worker's capability");
    }
    if (out.actions.length) d.log.info({ execution: ctx.executionId, actions: out.actions }, "http monitor state changed");
    return {
      summary: { outcome: ev.status, kind: ev.failureKind, category: ev.failureCategory, httpStatus: probe?.final?.status ?? null, totalMs: probe?.timings.totalMs ?? null, duplicate: out.duplicate, actions: out.actions },
    };
  };
}
