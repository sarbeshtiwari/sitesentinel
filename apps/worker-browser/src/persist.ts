import {
  advanceClasses, BROWSER_CLASSES, BROWSER_INCIDENT_CLASSES, describeBrowserFailure,
  type BrowserClass, type BrowserEvaluation, type MonitorStateBase, type SettingsSnapshot, type ViewportObservation,
} from "@wim/core";
import type { Tx } from "@wim/db";
import { openIncident, outbox, recordLedger, recordOccurrence, resolveIncident, resolveThresholds } from "@wim/incidents";
import { addUsage } from "@wim/queue";
import { compareViewports, evaluateLayout, type DetectedComponent, type FunctionalResult, type LayoutFacts } from "@wim/core";
import type { PendingArtifact } from "./artifacts.js";
import { ensureMonitoredPage, persistComponents } from "./components.js";

export interface BrowserPersistInput {
  executionId: string;
  orgId: string;
  websiteId: string;
  windowStart: Date;
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  pagePath: string;
  observations: ViewportObservation[];
  ev: BrowserEvaluation;
  artifacts: PendingArtifact[];
  artifactRetentionDays: number;
  config: { failureThreshold?: number; recoveryThreshold?: number; performance?: { consecutiveFailures?: number; recoveryPasses?: number } };
  runnerMs: number;
  sandbox: boolean | null;
  /** Phase 4F (null when nothing was observed, e.g. infrastructure failure) */
  components?: {
    pageUrl: string;
    byViewport: Array<{ viewport: string; width: number; components: DetectedComponent[]; navState: LayoutFacts["navState"] }>;
    functional: FunctionalResult[];
    blocked: number;
    complete: boolean;
  } | null;
}

type BrowserState = MonitorStateBase<BrowserClass>;

/**
 * One transaction. The ledger row is the idempotency gate: only a NEW logical result writes viewport rows,
 * metrics, artifacts, counters, incidents, outbox events and billable usage.
 */
export async function persistBrowserResult(tx: Tx, i: BrowserPersistInput, s: SettingsSnapshot): Promise<{ duplicate: boolean; actions: string[] }> {
  if (!(await recordLedger(tx, { executionId: i.executionId, orgId: i.orgId, websiteId: i.websiteId, tier: "T2_RENDER", windowStart: i.windowStart, outcome: i.ev.status, attempt: i.attempt }))) {
    return { duplicate: true, actions: [] };
  }
  const at = i.windowStart;
  // Phase 4G: page identity for page-level rollups and views (same row the 4F inventory and the deep scan use)
  const monitoredPageId = i.components ? await ensureMonitoredPage(tx, i.orgId, i.websiteId, i.components.pageUrl) : null;
  const pv = new Map(i.ev.perViewport.map((p) => [p.viewport, p]));
  const shots = (vp: string) => i.artifacts.filter((a) => a.viewport === vp);
  const artifactIds = new Map<string, string>();
  for (const a of i.artifacts) {
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO artifacts (org_id, website_id, execution_id, kind, purpose, viewport, storage_key, content_type, bytes, sha256, expires_at)
      VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${i.executionId}::uuid, 'SCREENSHOT', ${a.purpose}, ${a.viewport}, ${a.key}, 'image/png', ${a.bytes}, ${a.sha256},
              now() + make_interval(days => ${i.artifactRetentionDays}))
      ON CONFLICT (storage_key) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, expires_at = EXCLUDED.expires_at
      RETURNING id`;
    artifactIds.set(a.key, row!.id);
  }
  // An INCONCLUSIVE result (our infrastructure) records the ledger + a single row explaining why; nothing else.
  const obs = i.observations.length ? i.observations : [];
  if (!obs.length) {
    await tx.$executeRaw`
      INSERT INTO page_test_results (tested_at, org_id, website_id, execution_id, tier, viewport, status, page_path, failure_kind, failure_category, available, details, attempt, started_at, finished_at)
      VALUES (${at}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${i.executionId}::uuid, 'T2_RENDER', 'none', ${i.ev.status}::"ResultStatus", ${i.pagePath},
              ${i.ev.failureKind}, ${i.ev.failureCategory}, ${i.ev.available}, ${JSON.stringify({ verdicts: i.ev.verdicts, warnings: i.ev.warnings, sandbox: i.sandbox })}::jsonb,
              ${i.attempt}, ${i.startedAt}, ${i.finishedAt})`;
  }
  const crossViewport = i.components ? compareViewports(i.components.byViewport) : [];
  for (const o of obs) {
    const v = pv.get(o.viewport);
    const status = i.ev.status === "INCONCLUSIVE" ? "INCONCLUSIVE" : v?.status ?? "PASSED";
    const ids = shots(o.viewport).map((a) => artifactIds.get(a.key)!).filter(Boolean);
    const errs = o.scripts.exceptions.length + o.scripts.rejections.length;
    await tx.$executeRaw`
      INSERT INTO page_test_results (tested_at, org_id, website_id, execution_id, tier, viewport, width, height, status, page_path, http_status,
                                     blank_page, js_error_count, console_error_count, failed_request_count, load_ms, artifact_ids, final_url,
                                     failure_kind, failure_category, available, navigation, rendering, network, scripts, details, attempt, started_at, finished_at)
      VALUES (${at}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${i.executionId}::uuid, 'T2_RENDER', ${o.viewport}, ${o.width}, ${o.height}, ${status}::"ResultStatus",
              ${i.pagePath}, ${o.mainStatus}, ${o.rendering ? o.rendering.textLength === 0 && o.rendering.meaningfulElements === 0 : false},
              ${o.scripts.exceptions.reduce((a, b) => a + b.count, 0) + o.scripts.rejections.reduce((a, b) => a + b.count, 0)},
              ${o.scripts.consoleErrors.reduce((a, b) => a + b.count, 0)}, ${o.network.failed.reduce((a, b) => a + b.count, 0) + o.network.httpErrors.reduce((a, b) => a + b.count, 0)},
              ${o.perf?.loadMs ?? null}, ${ids}::text[], ${o.finalUrl},
              ${v?.kinds[0] ?? (i.ev.status === "INCONCLUSIVE" ? i.ev.failureKind : null)}, ${v?.kinds.length || i.ev.status === "INCONCLUSIVE" ? i.ev.failureCategory : null},
              ${i.ev.status === "INCONCLUSIVE" || i.ev.available === null ? null : !(v?.kinds.some((k) => k === "BLANK_PAGE") || o.navError)},
              ${JSON.stringify({ requestedPath: i.pagePath, finalUrl: o.finalUrl, mainStatus: o.mainStatus, redirects: o.redirects, error: o.navError, readiness: o.readiness, durationMs: o.durationMs })}::jsonb,
              ${JSON.stringify(o.rendering)}::jsonb, ${JSON.stringify(o.network)}::jsonb, ${JSON.stringify(o.scripts)}::jsonb,
              ${JSON.stringify({ kinds: v?.kinds ?? [], warnings: i.ev.warnings.filter((w) => w.startsWith(o.viewport) || !/^[a-z-]+: /.test(w)), durationMs: o.durationMs, sandbox: i.sandbox, jsErrors: errs })}::jsonb,
              ${i.attempt}, ${i.startedAt}, ${i.finishedAt})`;
    if (o.perf && !o.navError) {
      await tx.$executeRaw`
        INSERT INTO performance_metrics (measured_at, org_id, website_id, monitored_page_id, execution_id, source, viewport, page_path, fcp_ms, lcp_ms, cls, tbt_ms, ttfb_ms, load_ms,
                                         transfer_bytes, request_count, long_tasks, navigation_timing)
        VALUES (${at}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${monitoredPageId}::uuid, ${i.executionId}::uuid, 'SYNTHETIC', ${o.viewport}, ${i.pagePath}, ${o.perf.fcpMs}, ${o.perf.lcpMs}, ${o.perf.cls},
                ${o.perf.tbtMs}, ${o.perf.ttfbMs}, ${o.perf.loadMs}, ${o.network.transferBytes}, ${o.network.requests}, ${o.perf.longTasks},
                ${JSON.stringify({ note: "synthetic: one Chromium through the egress gateway; not real-user data" })}::jsonb)`;
    }
    if (o.layout) {
      const lf: LayoutFacts = { clippedText: 0, overlaps: 0, obscuredControls: 0, offscreenControls: 0, oversizedImages: 0, navState: "NONE", samples: [], ...o.layout };
      const le = evaluateLayout(lf);
      const missing = crossViewport.filter((x) => x.viewport === o.viewport).map((x) => `${x.type.toLowerCase()} "${x.label ?? x.key.slice(0, 40)}" visible on wider screens but not here`);
      await tx.$executeRaw`
        INSERT INTO responsive_test_results (tested_at, org_id, website_id, monitored_page_id, execution_id, viewport, width, height, status, page_path,
                                             horizontal_overflow_px, offscreen_elements, "overlaps", clipped_text, oversized_images, nav_state,
                                             obscured_controls, offscreen_controls, findings, artifact_ids)
        VALUES (${at}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${monitoredPageId}::uuid, ${i.executionId}::uuid, ${o.viewport}, ${o.width}, ${o.height},
                ${le.status}::"ResultStatus", ${i.pagePath}, ${lf.overflowPx}, ${lf.offscreenText}, ${lf.overlaps}, ${lf.clippedText}, ${lf.oversizedImages},
                ${lf.navState}, ${lf.obscuredControls}, ${lf.offscreenControls},
                ${JSON.stringify({ objective: le.objective, heuristic: [...le.heuristic, ...missing], samples: lf.samples, firstViewportVisible: o.layout.firstViewportVisible, synthetic: true })}::jsonb,
                ${ids}::text[])`;
    }
  }

  // Phase 4F: component inventory and history, functional test rows (same transaction, behind the ledger gate)
  let componentStats: Awaited<ReturnType<typeof persistComponents>> | null = null;
  if (i.components && obs.length) {
    componentStats = await persistComponents(tx, {
      orgId: i.orgId, websiteId: i.websiteId, executionId: i.executionId, windowStart: i.windowStart, pageUrl: i.components.pageUrl,
      byViewport: i.components.byViewport, complete: i.components.complete, functional: i.components.functional,
    });
  }

  // Usage: billable once per logical result (the ledger made this the only write).
  const shotBytes = i.artifacts.reduce((a, b) => a + b.bytes, 0);
  await addUsage(tx, i.orgId, {
    "browser.executions": 1, "browser.ms": i.runnerMs, "browser.viewports": obs.length, "browser.screenshots": i.artifacts.length,
    "browser.screenshot_bytes": shotBytes, ...(i.ev.status === "INCONCLUSIVE" ? { "browser.inconclusive": 1 } : {}),
    ...(componentStats ? { "browser.functional_tests": componentStats.tests, "browser.components_changed": componentStats.added + componentStats.changed + componentStats.removed + componentStats.restored } : {}),
    ...(i.components?.blocked ? { "browser.unsafe_requests_blocked": i.components.blocked } : {}),
  });

  // Monitor state, incidents, notifications
  const [sched] = await tx.$queryRaw<Array<{ id: string; state: BrowserState | null; state_window_at: Date | null }>>`
    SELECT id, state, state_window_at FROM monitoring_schedules
     WHERE website_id = ${i.websiteId}::uuid AND tier = 'T2_RENDER' AND api_endpoint_id IS NULL FOR UPDATE`;
  if (!sched) return { duplicate: false, actions: ["no-schedule"] };
  if (sched.state_window_at && i.windowStart.getTime() < sched.state_window_at.getTime()) return { duplicate: false, actions: ["stale-window"] };
  const prev: BrowserState = sched.state && sched.state.v === 1 ? sched.state : { v: 1, classes: {}, lastResultAt: null, lastSuccessAt: null, lastFailureAt: null, inconclusiveStreak: 0, inconclusiveNotified: false };
  const categories = [...new Set(Object.values(BROWSER_INCIDENT_CLASSES).map((c) => c.category))];
  const thresholds = await resolveThresholds(tx, i.orgId, i.websiteId, categories, i.config, {
    failure: s["monitoring.browser.failureThreshold"], recovery: s["monitoring.browser.recoveryThreshold"],
  });
  // Phase 4G: performance has its own noise protection (synthetic timings vary run to run): website setting, else
  // the platform's performance thresholds; incident rules for PERFORMANCE still apply when the website sets nothing.
  const perfRule = thresholds.get("PERFORMANCE")!;
  const perfThr = {
    failure: i.config.performance?.consecutiveFailures ?? (i.config.failureThreshold === undefined ? Math.max(perfRule.failure, s["monitoring.performance.failureThreshold"]) : perfRule.failure),
    recovery: i.config.performance?.recoveryPasses ?? (i.config.recoveryThreshold === undefined ? Math.max(perfRule.recovery, s["monitoring.performance.recoveryThreshold"]) : perfRule.recovery),
  };
  const { state, actions } = advanceClasses<BrowserClass, BrowserState>(prev, i.ev, BROWSER_CLASSES, BROWSER_INCIDENT_CLASSES,
    (c) => (c === "performance" ? perfThr : thresholds.get(BROWSER_INCIDENT_CLASSES[c].category)!), i.finishedAt, s["monitoring.http.interruptedAfter"]);
  const done: string[] = [];
  const primary = obs[0];
  const occurrence = {
    executionId: i.executionId, pageUrl: primary?.finalUrl ?? null,
    details: { kind: i.ev.failureKind, viewports: i.ev.perViewport.filter((p) => p.status === "FAILED").map((p) => p.viewport), artifactIds: [...artifactIds.values()] },
  };
  for (const a of actions) {
    if (a.type === "OPEN" || a.type === "OCCUR") {
      const spec = BROWSER_INCIDENT_CLASSES[a.cls];
      const c = state.classes[a.cls]!;
      if (a.type === "OCCUR" && c.incidentId && (await recordOccurrence(tx, c.incidentId, i.orgId, i.finishedAt, occurrence, { lastKind: a.kind, kinds: c.kinds }))) {
        done.push(`occur:${a.cls}`);
        continue;
      }
      const r = await openIncident(tx, {
        orgId: i.orgId, websiteId: i.websiteId, fingerprint: `browser.${a.cls}:${i.websiteId}`, checkKey: `browser.${a.cls}`,
        category: spec.category, source: "BROWSER", severity: spec.severity, title: spec.title, description: describeBrowserFailure(a.kind), scope: i.pagePath,
        diagnostics: { lastKind: a.kind, kinds: c.kinds, streakStart: c.streakStart, url: occurrence.pageUrl, synthetic: true },
        firstDetectedAt: new Date(c.streakStart ?? i.finishedAt), detectedAt: i.finishedAt, count: a.type === "OPEN" ? a.count : 1, occurrence,
      });
      c.incidentId = r.incidentId;
      done.push(`${r.created ? "open" : r.reopened ? "reopen" : "occur"}:${a.cls}`);
    } else if (a.type === "RESOLVE") {
      const id = prev.classes[a.cls]?.incidentId;
      if (id && (await resolveIncident(tx, id, i.orgId, i.finishedAt, { checkKey: `browser.${a.cls}`, executionId: i.executionId }))) done.push(`resolve:${a.cls}`);
    } else if (a.type === "MONITORING_INTERRUPTED") {
      await outbox(tx, i.orgId, "monitoring.interrupted", { websiteId: i.websiteId, streak: a.streak, since: i.windowStart.toISOString(), tier: "BROWSER" },
        `interrupted:browser:${i.websiteId}:${i.windowStart.toISOString()}`);
      done.push("interrupted");
    }
  }
  await tx.$executeRaw`UPDATE monitoring_schedules SET state = ${JSON.stringify(state)}::jsonb, state_window_at = ${i.windowStart} WHERE id = ${sched.id}::uuid`;
  return { duplicate: false, actions: done };
}
