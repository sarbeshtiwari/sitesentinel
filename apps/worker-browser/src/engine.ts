import type { Redis } from "ioredis";
import {
  DEFAULT_ALERT_ON, effectivePerfThresholds, evaluateBrowser, parseBrowserCheckConfig, viewportsForRun, VIEWPORT_PRESETS, type PerfEvaluation,
  type BrowserEvaluation, type DetectedComponent, type FunctionalResult, type LayoutFacts, type SettingsSnapshot, type ViewportObservation,
  functionalBlockedReason,
} from "@wim/core";
import { loadSettings, withSystem, type Db } from "@wim/db";
import type { Logger } from "@wim/logger";
import { httpProbe, signCapability } from "@wim/netguard";
import { addUsage, loadOrgContexts, SecurityError, TransientError, type ExecutionContext, type ExecutionResult } from "@wim/queue";
import type { S3 } from "@wim/storage";
import { artifactKey, screenshotBytesToday, upload, type PendingArtifact } from "./artifacts.js";
import { observeViewport } from "./observe.js";
import { persistBrowserResult } from "./persist.js";
import { openSession, RunnerBusy, RunnerUnavailable, type BrowserSession } from "./session.js";
import { loadBrowserTarget } from "./target.js";

export interface BrowserEngineDeps {
  db: Db;
  redis: Redis;
  prefix: string;
  log: Logger;
  gatewayUrl: string;
  tokenSecret: string;
  /** browser runner control API (browser-control network) */
  runnerUrl: string;
  s3: S3 | null;
  /** queue job timeout: the whole execution must finish inside it */
  jobTimeoutMs: () => Promise<number>;
  hooks?: { afterNavigate?: (executionId: string) => void | Promise<void>; afterPersist?: (executionId: string) => void | Promise<void> };
}

const INFRA_NAV = new Set(["BROWSER_CRASHED", "BROWSER_UNAVAILABLE", "GATEWAY_UNAVAILABLE", "EGRESS_RATE_LIMITED", "GATEWAY_ERROR"]);

/**
 * Tier B browser engine. Runs in worker-browser (trusted: data + browser-control networks). The 4B
 * runtime has already validated the job, the execution row, the tenant binding and CURRENT eligibility
 * (website active/verified, ownership not lapsed, org active, entitled, browser enabled for platform + org +
 * website). Chromium runs in browser-runner and reaches the internet only through the gateway.
 */
export function createBrowserEngine(d: BrowserEngineDeps) {
  let cached: { at: number; s: SettingsSnapshot } | null = null;
  const settings = async () => {
    if (!cached || Date.now() - cached.at > 10_000) cached = { at: Date.now(), s: await loadSettings(d.db) };
    return cached.s;
  };

  /** A tunnel failure hides the gateway's reason from Chromium: ask the gateway the same question with a host-bound probe. */
  async function classifyTunnelFailure(ctx: ExecutionContext, url: string): Promise<string> {
    const r = await httpProbe({
      url, method: "HEAD", timeoutMs: 8000, maxRedirects: 0, maxBodyBytes: 1024, signal: ctx.signal,
      gateway: { url: d.gatewayUrl, token: (host) => signCapability(d.tokenSecret, { o: ctx.orgId, w: ctx.websiteId, e: ctx.executionId, k: "browser-classify", h: host }, 60) },
    });
    return r.error ?? "CONNECTION_FAILED";
  }

  return async function handle(ctx: ExecutionContext): Promise<ExecutionResult> {
    const s = await settings();
    const startedAt = new Date();
    // A recorded result means this execution is complete: never navigate again (crash after persistence).
    const [done] = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ outcome: string }>>`SELECT outcome FROM execution_results WHERE execution_id = ${ctx.executionId}::uuid`);
    if (done) return { summary: { duplicate: true, outcome: done.outcome } };

    const target = await withSystem(d.db, (tx) => loadBrowserTarget(tx, ctx.orgId, ctx.websiteId));
    const limits = await withSystem(d.db, async (tx) => (await loadOrgContexts(tx, [ctx.orgId], s)).get(ctx.orgId)!.limits);
    const jobTimeout = await d.jobTimeoutMs();
    const deadline = Date.now() + jobTimeout - 10_000; // leave time to persist
    let observations: ViewportObservation[] = [];
    let ev: BrowserEvaluation;
    let session: BrowserSession | null = null;
    const pending: PendingArtifact[] = [];
    const shots: Array<{ viewport: string; png: Buffer; purpose: PendingArtifact["purpose"] }> = [];
    let runnerMs = 0;
    // Phase 4F: per-viewport components, functional results and what the safety guard blocked
    const byViewport: Array<{ viewport: string; width: number; components: DetectedComponent[]; navState: LayoutFacts["navState"] }> = [];
    const functional: FunctionalResult[] = [];
    let blocked = 0;
    // Phase 4G: platform defaults (with the legacy 4D LCP / CLS settings), then the website's own thresholds only when
    // the organisation is entitled to custom thresholds.
    const platform = { ...s["monitoring.performance.thresholds"], lcp: { good: s["monitoring.browser.lcpWarnMs"], poor: s["monitoring.browser.lcpCritMs"] }, cls: { good: s["monitoring.browser.clsWarn"], poor: s["monitoring.browser.clsCrit"] } };
    if (!(platform.lcp.good < platform.lcp.poor)) platform.lcp = s["monitoring.performance.thresholds"].lcp;
    if (!(platform.cls.good < platform.cls.poor)) platform.cls = s["monitoring.performance.thresholds"].cls;
    const perf: PerfEvaluation = { thresholds: platform, alertOn: s["monitoring.performance.alertOn"] ?? DEFAULT_ALERT_ON };

    if ("problem" in target) {
      ev = evaluateBrowser([{ viewport: "desktop", width: 0, height: 0, navError: target.problem, mainStatus: null, finalUrl: null, redirects: 0, readiness: { strategy: "load", met: false, ms: 0 }, durationMs: 0, rendering: null, scripts: { exceptions: [], rejections: [], consoleErrors: [] }, network: { failed: [], httpErrors: [], requests: 0, transferBytes: 0 }, layout: null, perf: null }], parseBrowserCheckConfig({}), perf);
    } else {
      const cfg = target.config;
      const custom = limits.browser.customPerfThresholds;
      perf.thresholds = effectivePerfThresholds(platform, cfg.performance, custom);
      if (custom && cfg.performance.alertOn) perf.alertOn = cfg.performance.alertOn;
      // Rotation by the number of completed runs (a retry keeps its index: nothing was recorded yet).
      const [{ n: windowIndex }] = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM execution_results WHERE website_id = ${ctx.websiteId}::uuid AND tier = 'T2_RENDER'`);
      const viewports = viewportsForRun(cfg.primaryViewport, cfg.viewports, Math.min(cfg.extraViewportsPerRun, limits.browser.maxViewportsPerRun - 1), windowIndex);
      // Capability for THIS execution: org + website + execution, expiring with the job, carrying the website's
      // third-party policy (blocker 5) — the gateway enforces it for every request of the session (page load,
      // subresources, frames, fetch/XHR, WebSocket, redirects), in addition to refusing non-public destinations.
      const tp = cfg.thirdParty;
      const token = signCapability(d.tokenSecret, {
        o: ctx.orgId, w: ctx.websiteId, e: ctx.executionId, k: "browser",
        t: { f: [target.registrableDomain], m: tp.mode, ...(tp.mode === "allowlist" ? { a: tp.allowedDomains } : {}), n: tp.maxHosts },
      }, Math.ceil(jobTimeout / 1000) + 30);
      const t0 = Date.now();
      try {
        session = await openSession(d.runnerUrl, token, jobTimeout + 5000, ctx.executionId);
      } catch (e) {
        if (e instanceof RunnerBusy) throw new TransientError("browser runner at capacity");
        if (e instanceof RunnerUnavailable) {
          ev = infra("BROWSER_UNAVAILABLE");
        } else throw e;
      }
      if (session) {
        const quotaLeft = s["monitoring.browser.screenshotBytesPerDay"] - (await withSystem(d.db, (tx) => screenshotBytesToday(tx, ctx.orgId)));
        let quotaUsed = 0;
        try {
          for (const vp of viewports) {
            if (Date.now() > deadline - 5000) break; // budget exhausted: evaluate what was observed
            const out = await observeViewport({
              browser: session.browser, url: target.url, viewport: vp, config: cfg, registrableDomain: target.registrableDomain, deadline, signal: ctx.signal,
              maskSelectors: cfg.screenshots.mask, functional: vp === viewports[0],
              functionalAllowed: functionalBlockedReason(cfg.functional, s["monitoring.functional.enabled"]) === null,
              screenshot: (o) => {
                const failedHere = Boolean(o.navError) || evaluateBrowser([o], cfg, perf).status === "FAILED";
                return (failedHere ? cfg.screenshots.onFailure : cfg.screenshots.onSuccess) && d.s3 !== null && quotaUsed < quotaLeft;
              },
            });
            if (out.observation.navError === "TUNNEL_FAILED") out.observation.navError = await classifyTunnelFailure(ctx, target.url);
            observations.push(out.observation);
            if (!out.observation.navError) byViewport.push({ viewport: vp, width: VIEWPORT_PRESETS[vp].width, components: out.components, navState: (out.observation.layout?.navState ?? "NONE") as LayoutFacts["navState"] });
            functional.push(...out.functional);
            blocked += out.blocked.length;
            if (out.screenshot) {
              quotaUsed += out.screenshot.length;
              shots.push({ viewport: vp, png: out.screenshot, purpose: out.observation.navError || evaluateBrowser([out.observation], cfg, perf).status === "FAILED" ? "FAILURE" : cfg.screenshots.fullPage ? "FULL_PAGE" : "VIEWPORT" });
            }
            if (out.observation.navError && INFRA_NAV.has(out.observation.navError)) break;
            if (vp === viewports[0] && out.observation.navError) break; // the page doesn't load: other viewports add nothing
          }
        } finally {
          runnerMs = Date.now() - t0;
          await session.close();
        }
        if (ctx.signal.aborted) throw new Error("aborted");
        ev = evaluateBrowser(observations, cfg, perf, functional.filter((f) => f.kind !== "RESPONSIVE_NAV"));
      } else {
        runnerMs = Date.now() - t0;
      }
    }
    await d.hooks?.afterNavigate?.(ctx.executionId);

    if (ev!.failureCategory === "BROWSER_INFRASTRUCTURE" || ev!.failureCategory === "GATEWAY_INFRASTRUCTURE") {
      // Our failure, not the customer's: the attempt's cost is recorded as overhead; retried on the same execution.
      await withSystem(d.db, async (tx) => {
        await addUsage(tx, ctx.orgId, { "browser.retry_ms": runnerMs, "browser.infra_failures": 1 });
        await tx.systemHealthLog.create({ data: { component: "browser-monitoring", metric: "infra_failure", value: 1, labels: { kind: ev!.failureKind ?? "?" } } });
      }).catch(() => undefined);
      if (ctx.attempt < ctx.maxAttempts) throw new TransientError(`browser infrastructure: ${ev!.failureKind}`);
      observations = [];
    }

    // Artifacts are uploaded before the transaction (deterministic keys: a retry overwrites). Storage outages never fail monitoring.
    if (d.s3 && shots.length) {
      for (const sh of shots) {
        const key = artifactKey(ctx.orgId, ctx.websiteId, ctx.executionId, sh.viewport, sh.purpose);
        try {
          const u = await upload(d.s3, key, sh.png);
          pending.push({ key, viewport: sh.viewport, purpose: sh.purpose, ...u });
        } catch (e) {
          ev!.warnings.push("screenshot storage unavailable; capture discarded");
          await withSystem(d.db, (tx) => tx.systemHealthLog.create({ data: { component: "browser-monitoring", metric: "storage_failure", value: 1 } })).catch(() => undefined);
          d.log.warn({ err: (e as Error).message.slice(0, 120) }, "artifact upload failed");
        }
      }
    }

    const out = await withSystem(d.db, (tx) => persistBrowserResult(tx, {
      executionId: ctx.executionId, orgId: ctx.orgId, websiteId: ctx.websiteId, windowStart: ctx.windowStart, attempt: ctx.attempt,
      startedAt, finishedAt: new Date(), pagePath: "problem" in target ? "/" : target.config.path, observations, ev: ev!, artifacts: pending,
      artifactRetentionDays: s["monitoring.browser.artifactRetentionDays"], config: "problem" in target ? {} : target.config, runnerMs, sandbox: session?.sandbox ?? null,
      // detection is "complete" only if the primary viewport loaded and was inspected in this run
      components: "problem" in target || ev!.status === "INCONCLUSIVE" ? null : {
        pageUrl: target.url, byViewport, functional, blocked,
        complete: byViewport.length > 0 && byViewport[0]!.viewport === observations[0]?.viewport && !observations[0]?.navError && target.config.components.detect,
      },
    }, s));
    await d.hooks?.afterPersist?.(ctx.executionId);
    if (ev!.failureCategory === "SECURITY_REJECTION") throw new SecurityError("egress gateway rejected the browser's capability");
    if (out.actions.length) d.log.info({ execution: ctx.executionId, actions: out.actions }, "browser monitor state changed");
    return { summary: { outcome: ev!.status, kind: ev!.failureKind, category: ev!.failureCategory, viewports: observations.map((o) => o.viewport), duplicate: out.duplicate, actions: out.actions } };

    function infra(kind: string): BrowserEvaluation {
      return evaluateBrowser([{ viewport: "desktop", width: 0, height: 0, navError: kind, mainStatus: null, finalUrl: null, redirects: 0, readiness: { strategy: "load", met: false, ms: 0 }, durationMs: 0, rendering: null, scripts: { exceptions: [], rejections: [], consoleErrors: [] }, network: { failed: [], httpErrors: [], requests: 0, transferBytes: 0 }, layout: null, perf: null }],
        parseBrowserCheckConfig({}), perf);
    }
  };
}
