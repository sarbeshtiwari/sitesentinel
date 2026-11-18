import { Body, Controller, Get, Inject, Injectable, Param, Put, Query } from "@nestjs/common";
import { z } from "zod";
import {
  BrowserCheckConfig, classifyPerf, compareWindows, DEFAULT_ALERT_ON, effectivePerfThresholds, histPercentile, mergeHistograms, MIN_SAMPLES,
  PAGE_SCORE_FORMULA, PAGE_SCORE_PENALTY, PERF_METRICS, PerformanceConfig, worstPerfStatus,
  type Histogram, type PerfMetric, type PerfStatus, type PerfThresholdSet, type SettingsSnapshot,
} from "@wim/core";
import { withMember, type Db, type Tx } from "@wim/db";
import { loadOrgContexts } from "@wim/queue";
import { Uuid } from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";
import { rangeOf } from "./range.js";
import { inventorySummary, loadPageInventory, pageFacts, pageFindingDto, pathOf, queryInventory, type PageSort } from "./page-inventory.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const n = (v: unknown) => (v == null ? 0 : Number(v));
const Range = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }).strict();
const Viewport = z.string().regex(/^[a-z-]{3,20}$/);
const SummaryQuery = Range.extend({ viewport: Viewport.optional() }).strict();
const SeriesQuery = Range.extend({
  metric: z.enum(PERF_METRICS), viewport: Viewport.optional(), pageId: z.uuid().optional(),
}).strict();
const ThresholdInput = PerformanceConfig.pick({ thresholds: true, alertOn: true, consecutiveFailures: true, recoveryPasses: true }).strict();
const CompareQuery = z.object({ a: z.uuid(), b: z.uuid() }).strict();

/** Rollup granularity for a range: hourly up to 7 days, daily beyond (both kept within their retention). */
const grainOf = (from: Date, to: Date) => (to.getTime() - from.getTime() <= 7 * 86_400_000 ? "hour" : "day");

interface Agg { count: number; sum: number; min: number | null; max: number | null; hist: Histogram }
const emptyAgg = (): Agg => ({ count: 0, sum: 0, min: null, max: null, hist: {} });
function addRow(a: Agg, r: { count: number; sum: number; min: number | null; max: number | null; histogram: Histogram | null }) {
  a.count += r.count; a.sum += r.sum;
  a.min = r.min === null ? a.min : a.min === null ? r.min : Math.min(a.min, r.min);
  a.max = r.max === null ? a.max : a.max === null ? r.max : Math.max(a.max, r.max);
  a.hist = mergeHistograms([a.hist, r.histogram]);
}
function stats(metric: PerfMetric, a: Agg) {
  const b = { min: a.min, max: a.max };
  return {
    samples: a.count, avg: a.count ? round(metric, a.sum / a.count) : null, min: a.min, max: a.max,
    p50: histPercentile(metric, a.hist, 0.5, b), p75: histPercentile(metric, a.hist, 0.75, b), p95: histPercentile(metric, a.hist, 0.95, b),
    /** percentiles below MIN_SAMPLES are shown but flagged */
    sufficient: a.count >= MIN_SAMPLES,
  };
}
const round = (m: PerfMetric, v: number) => (m === "cls" ? Math.round(v * 10_000) / 10_000 : Math.round(v));

/**
 * Phase 4G performance intelligence, website pages, components and responsive dashboards. All aggregates come from the
 * rollup tables (bounded by range and index), except the latest per-execution values; every number carries its sample
 * count. Everything is SYNTHETIC (one Chromium in our infrastructure) — the API says so in `measurement`.
 */
@Injectable()
export class PerformanceService {
  constructor(@Inject(APP_DB) private readonly db: Db, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }
  private async website(tx: Tx, orgId: string, websiteId: string) {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: { id: true, canonicalOrigin: true } });
    if (!w) throw Errors.notFound();
    return w;
  }

  /** Effective thresholds and settings for one website (platform ⊕ entitlement ⊕ website), exactly as the engine uses them. */
  async thresholdsFor(tx: Tx, st: SettingsSnapshot, orgId: string, websiteId: string) {
    const limits = (await loadOrgContexts(tx, [orgId], st)).get(orgId)!.limits;
    const cfgRow = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { browserCheck: true } });
    const cfg = BrowserCheckConfig.safeParse(cfgRow?.browserCheck ?? {});
    const browser = cfg.success ? cfg.data : BrowserCheckConfig.parse({});
    const platform = this.platform(st);
    const custom = limits.browser.customPerfThresholds;
    return {
      thresholds: effectivePerfThresholds(platform, browser.performance, custom), platform, customAllowed: custom,
      alertOn: (custom && browser.performance.alertOn) || st["monitoring.performance.alertOn"] || DEFAULT_ALERT_ON,
      consecutiveFailures: browser.performance.consecutiveFailures ?? st["monitoring.performance.failureThreshold"],
      recoveryPasses: browser.performance.recoveryPasses ?? st["monitoring.performance.recoveryThreshold"],
      primaryViewport: browser.primaryViewport, custom: browser.performance,
    };
  }
  platform(st: SettingsSnapshot): PerfThresholdSet {
    const p = { ...st["monitoring.performance.thresholds"] } as PerfThresholdSet;
    if (st["monitoring.browser.lcpWarnMs"] < st["monitoring.browser.lcpCritMs"]) p.lcp = { good: st["monitoring.browser.lcpWarnMs"], poor: st["monitoring.browser.lcpCritMs"] };
    if (st["monitoring.browser.clsWarn"] < st["monitoring.browser.clsCrit"]) p.cls = { good: st["monitoring.browser.clsWarn"], poor: st["monitoring.browser.clsCrit"] };
    return p;
  }

  /** Rollup rows for websites / pages / metrics in [from, to), at the range's grain. */
  private async rollups(tx: Tx, q: { orgId: string; websiteIds?: string[]; subjectType: "WEBSITE" | "PAGE"; subjectId?: string; metricPrefix: string; from: Date; to: Date; grain: "hour" | "day" }) {
    const rows = q.grain === "hour"
      ? await tx.$queryRaw<Array<Record<string, any>>>`
          SELECT bucket, website_id, subject_id, metric, count, sum, min, max, histogram FROM metrics_hourly
           WHERE org_id = ${q.orgId}::uuid AND subject_type = ${q.subjectType} AND metric LIKE ${q.metricPrefix}
             AND (${q.websiteIds ?? null}::uuid[] IS NULL OR website_id = ANY(${q.websiteIds ?? null}::uuid[]))
             AND (${q.subjectId ?? null}::uuid IS NULL OR subject_id = ${q.subjectId ?? null}::uuid)
             AND bucket >= ${q.from} AND bucket < ${q.to}`
      : await tx.$queryRaw<Array<Record<string, any>>>`
          SELECT bucket::timestamptz AS bucket, website_id, subject_id, metric, count, sum, min, max, histogram FROM metrics_daily
           WHERE org_id = ${q.orgId}::uuid AND subject_type = ${q.subjectType} AND metric LIKE ${q.metricPrefix}
             AND (${q.websiteIds ?? null}::uuid[] IS NULL OR website_id = ANY(${q.websiteIds ?? null}::uuid[]))
             AND (${q.subjectId ?? null}::uuid IS NULL OR subject_id = ${q.subjectId ?? null}::uuid)
             AND bucket >= ${q.from}::date AND bucket < (${q.to}::timestamptz + interval '1 day')::date`;
    return rows.map((r) => ({ bucket: r.bucket as Date, websiteId: r.website_id as string, subjectId: r.subject_id as string, metric: r.metric as string, count: n(r.count), sum: Number(r.sum), min: r.min === null ? null : Number(r.min), max: r.max === null ? null : Number(r.max), histogram: (r.histogram ?? {}) as Histogram }));
  }

  /** Expected vs inconclusive browser executions in a range (data quality). */
  private async quality(tx: Tx, websiteId: string, from: Date, to: Date) {
    const [r] = await tx.$queryRaw<Array<{ total: bigint; inconclusive: bigint; failed: bigint }>>`
      SELECT count(*) AS total, count(*) FILTER (WHERE outcome = 'INCONCLUSIVE') AS inconclusive, count(*) FILTER (WHERE outcome = 'FAILED') AS failed
        FROM execution_results WHERE website_id = ${websiteId}::uuid AND tier = 'T2_RENDER' AND window_start >= ${from} AND window_start < ${to}`;
    const [e] = await tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM monitoring_executions WHERE website_id = ${websiteId}::uuid AND tier = 'T2_RENDER' AND trigger = 'SCHEDULE' AND queued_at >= ${from} AND queued_at < ${to}`;
    return { scheduledChecks: n(e!.n), recordedChecks: n(r!.total), inconclusiveChecks: n(r!.inconclusive), failedChecks: n(r!.failed) };
  }

  // ------------------------------------------------------------------ website summary
  async summary(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof SummaryQuery>) {
    const { from, to } = rangeOf(q);
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const t = await this.thresholdsFor(tx, st, o.orgId, websiteId);
      const viewport = q.viewport ?? t.primaryViewport;
      const grain = grainOf(from, to);
      const span = to.getTime() - from.getTime();
      const prevFrom = new Date(from.getTime() - span);
      const cur = await this.rollups(tx, { orgId: o.orgId, websiteIds: [websiteId], subjectType: "WEBSITE", metricPrefix: `perf.%.${viewport}`, from, to, grain });
      const prev = await this.rollups(tx, { orgId: o.orgId, websiteIds: [websiteId], subjectType: "WEBSITE", metricPrefix: `perf.%.${viewport}`, from: prevFrom, to: from, grain });
      const [latest] = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT p.execution_id, p.measured_at, p.fcp_ms, p.lcp_ms, p.cls, p.tbt_ms, p.ttfb_ms, p.load_ms FROM performance_metrics p
         WHERE p.website_id = ${websiteId}::uuid AND p.source = 'SYNTHETIC' AND p.viewport = ${viewport} ORDER BY p.measured_at DESC LIMIT 1`;
      const vps = await tx.$queryRaw<Array<{ viewport: string }>>`
        SELECT DISTINCT split_part(metric, '.', 3) AS viewport FROM metrics_daily WHERE website_id = ${websiteId}::uuid AND metric LIKE 'perf.%' AND bucket >= (now() - interval '62 days')::date`;
      const latestOf: Record<PerfMetric, number | null> = { fcp: latest?.fcp_ms ?? null, lcp: latest?.lcp_ms ?? null, cls: latest?.cls ?? null, tbt: latest?.tbt_ms ?? null, ttfb: latest?.ttfb_ms ?? null, load: latest?.load_ms ?? null };
      const metrics = PERF_METRICS.map((m) => {
        const a = emptyAgg(), b = emptyAgg();
        for (const r of cur) if (r.metric === `perf.${m}.${viewport}`) addRow(a, r);
        for (const r of prev) if (r.metric === `perf.${m}.${viewport}`) addRow(b, r);
        const sa = stats(m, a), sb = stats(m, b);
        const status: PerfStatus = sa.sufficient ? classifyPerf(sa.p75, t.thresholds[m]) : "INSUFFICIENT_DATA";
        return {
          metric: m, thresholds: t.thresholds[m], alerting: t.alertOn.includes(m), status, ...sa,
          latest: latestOf[m], latestStatus: classifyPerf(latestOf[m], t.thresholds[m]),
          previous: { samples: sb.samples, p75: sb.p75 },
          change: compareWindows(m, { p75: sa.p75, n: sa.samples }, { p75: sb.p75, n: sb.samples }, t.thresholds[m]),
        };
      });
      return {
        range: { from: from.toISOString(), to: to.toISOString(), previousFrom: prevFrom.toISOString(), grain }, timezone: "UTC", viewport,
        viewports: vps.map((v) => v.viewport).sort(), measurement: "SYNTHETIC_BROWSER",
        status: worstPerfStatus(metrics.filter((m) => m.alerting).map((m) => m.status)),
        metrics, latestExecutionId: latest?.execution_id ?? null, latestAt: iso(latest?.measured_at),
        quality: await this.quality(tx, websiteId, from, to),
        settings: { customAllowed: t.customAllowed, alertOn: t.alertOn, consecutiveFailures: t.consecutiveFailures, recoveryPasses: t.recoveryPasses },
        notes: ["Percentiles are computed from rollup histograms (about ±5 %); counts, averages, minimum and maximum are exact.", "Executions that were inconclusive or failed to load record no performance metrics."],
      };
    });
  }

  // ------------------------------------------------------------------ time series (gaps explicit)
  async series(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof SeriesQuery>) {
    const { from, to } = rangeOf(q);
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const t = await this.thresholdsFor(tx, st, o.orgId, websiteId);
      if (q.pageId && !(await tx.monitoredPage.findFirst({ where: { id: q.pageId, websiteId, orgId: o.orgId }, select: { id: true } }))) throw Errors.notFound();
      const viewport = q.viewport ?? t.primaryViewport;
      const grain = grainOf(from, to);
      const rows = await this.rollups(tx, { orgId: o.orgId, websiteIds: [websiteId], subjectType: q.pageId ? "PAGE" : "WEBSITE", subjectId: q.pageId, metricPrefix: `perf.${q.metric}.${viewport}`, from, to, grain });
      const step = grain === "hour" ? 3_600_000 : 86_400_000;
      const start = grain === "hour" ? Math.floor(from.getTime() / step) * step : Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
      const byBucket = new Map(rows.map((r) => [r.bucket.getTime(), r]));
      const points: Array<{ t: string; samples: number; p50: number | null; p75: number | null; p95: number | null; avg: number | null; status: PerfStatus }> = [];
      for (let x = start; x < to.getTime() && points.length < 2500; x += step) {
        const r = byBucket.get(x);
        if (!r) { points.push({ t: new Date(x).toISOString(), samples: 0, p50: null, p75: null, p95: null, avg: null, status: "INSUFFICIENT_DATA" }); continue; }
        const a = emptyAgg();
        addRow(a, r);
        const sa = stats(q.metric, a);
        points.push({ t: new Date(x).toISOString(), samples: sa.samples, p50: sa.p50, p75: sa.p75, p95: sa.p95, avg: sa.avg, status: classifyPerf(sa.p75, t.thresholds[q.metric]) });
      }
      return { metric: q.metric, viewport, grain, thresholds: t.thresholds[q.metric], range: { from: from.toISOString(), to: to.toISOString() }, points, measurement: "SYNTHETIC_BROWSER" };
    });
  }

  // ------------------------------------------------------------------ page comparison
  async pageComparison(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof SummaryQuery>) {
    const { from, to } = rangeOf(q);
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const t = await this.thresholdsFor(tx, st, o.orgId, websiteId);
      const viewport = q.viewport ?? t.primaryViewport;
      const rows = await this.rollups(tx, { orgId: o.orgId, websiteIds: [websiteId], subjectType: "PAGE", metricPrefix: `perf.%.${viewport}`, from, to, grain: grainOf(from, to) });
      const pages = await tx.$queryRaw<Array<{ id: string; url: string }>>`
        SELECT m.id, d.url FROM monitored_pages m JOIN discovered_pages d ON d.id = m.discovered_page_id WHERE m.website_id = ${websiteId}::uuid`;
      return {
        viewport, range: { from: from.toISOString(), to: to.toISOString() },
        pages: pages.map((p) => ({
          pageId: p.id, path: pathOf(p.url),
          metrics: Object.fromEntries(PERF_METRICS.map((m) => {
            const a = emptyAgg();
            for (const r of rows) if (r.subjectId === p.id && r.metric === `perf.${m}.${viewport}`) addRow(a, r);
            const sa = stats(m, a);
            return [m, { samples: sa.samples, p75: sa.p75, status: sa.sufficient ? classifyPerf(sa.p75, t.thresholds[m]) : "INSUFFICIENT_DATA" }];
          })),
        })),
      };
    });
  }

  // ------------------------------------------------------------------ thresholds (configurable, entitled, audited)
  async readThresholds(s: SessionContext, o: OrgContext, websiteId: string) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const t = await this.thresholdsFor(tx, st, o.orgId, websiteId);
      const history = await tx.$queryRaw<Array<{ occurred_at: Date; actor_label: string | null; changes: unknown }>>`
        SELECT occurred_at, actor_label, changes FROM audit_logs WHERE org_id = ${o.orgId}::uuid AND action = 'website.performance_thresholds_updated' AND target_id = ${websiteId}
         ORDER BY occurred_at DESC LIMIT 20`;
      return {
        effective: t.thresholds, platform: t.platform, custom: t.custom, customAllowed: t.customAllowed, alertOn: t.alertOn,
        consecutiveFailures: t.consecutiveFailures, recoveryPasses: t.recoveryPasses,
        history: history.map((h) => ({ at: h.occurred_at.toISOString(), by: h.actor_label, changes: h.changes })),
      };
    });
  }

  async updateThresholds(s: SessionContext, o: OrgContext, websiteId: string, input: z.infer<typeof ThresholdInput>, client: ClientInfo) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const limits = (await loadOrgContexts(tx, [o.orgId], st)).get(o.orgId)!.limits;
      // Noise protection can always be tightened; custom bounds and alert metrics need the plan entitlement.
      if ((input.thresholds || input.alertOn) && !limits.browser.customPerfThresholds) {
        throw new AppError(403, "FORBIDDEN", "Custom performance thresholds are not included in your plan");
      }
      const row = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { browserCheck: true } });
      const current = (row?.browserCheck ?? {}) as Record<string, any>;
      const before = (current.performance ?? {}) as Record<string, unknown>;
      const after: Record<string, unknown> = { ...before };
      for (const [k, v] of Object.entries(input)) if (v !== undefined) after[k] = v;
      const parsed = BrowserCheckConfig.safeParse({ ...current, performance: after });
      if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invalid performance thresholds", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      await tx.monitoringConfiguration.upsert({ where: { websiteId }, create: { orgId: o.orgId, websiteId, browserCheck: parsed.data as never }, update: { browserCheck: parsed.data as never } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.performance_thresholds_updated", targetType: "website", targetId: websiteId, changes: { before, after: parsed.data.performance }, client }, tx);
      return parsed.data.performance;
    });
  }

  // ------------------------------------------------------------------ organisation-wide (overview)
  /** Performance status and regressions per website over a range, from rollups (primary viewport, alerting metrics). */
  async orgPerformance(tx: Tx, st: SettingsSnapshot, orgId: string, websiteIds: string[], from: Date, to: Date) {
    if (!websiteIds.length) return new Map<string, { status: PerfStatus; samples: number; lcpP75: number | null; regressions: Array<{ metric: PerfMetric; deltaPct: number | null }> }>();
    const grain = grainOf(from, to);
    const span = to.getTime() - from.getTime();
    const cur = await this.rollups(tx, { orgId, websiteIds, subjectType: "WEBSITE", metricPrefix: "perf.%", from, to, grain });
    const prev = await this.rollups(tx, { orgId, websiteIds, subjectType: "WEBSITE", metricPrefix: "perf.%", from: new Date(from.getTime() - span), to: from, grain });
    const out = new Map<string, { status: PerfStatus; samples: number; lcpP75: number | null; regressions: Array<{ metric: PerfMetric; deltaPct: number | null }> }>();
    for (const w of websiteIds) {
      const t = await this.thresholdsFor(tx, st, orgId, w);
      const vp = t.primaryViewport;
      const statuses: PerfStatus[] = [];
      const regressions: Array<{ metric: PerfMetric; deltaPct: number | null }> = [];
      let samples = 0, lcpP75: number | null = null;
      for (const m of PERF_METRICS) {
        const a = emptyAgg(), b = emptyAgg();
        for (const r of cur) if (r.websiteId === w && r.metric === `perf.${m}.${vp}`) addRow(a, r);
        for (const r of prev) if (r.websiteId === w && r.metric === `perf.${m}.${vp}`) addRow(b, r);
        const sa = stats(m, a), sb = stats(m, b);
        if (m === "lcp") { lcpP75 = sa.p75; samples = sa.samples; }
        if (t.alertOn.includes(m)) statuses.push(sa.sufficient ? classifyPerf(sa.p75, t.thresholds[m]) : "INSUFFICIENT_DATA");
        const c = compareWindows(m, { p75: sa.p75, n: sa.samples }, { p75: sb.p75, n: sb.samples }, t.thresholds[m]);
        if (c.change === "REGRESSION") regressions.push({ metric: m, deltaPct: c.deltaPct });
      }
      out.set(w, { status: worstPerfStatus(statuses), samples, lcpP75, regressions });
    }
    return out;
  }

  // ------------------------------------------------------------------ pages
  /**
   * Every page of the website (see page-inventory.ts): discovered pages ∪ page URLs of the latest deep scan(s) that no
   * scan has fetched yet / that failed / were skipped, each with its score, open findings by severity and group, check
   * state, and — for the browser-monitored page — LCP, components and responsive. Offset pagination (the inventory is
   * bounded by the scan page limits); filters, search and sort are applied server-side before slicing.
   */
  async pages(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof PagesQuery>) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const t = await this.thresholdsFor(tx, st, o.orgId, websiteId);
      const cfgRow = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { browserCheck: true } });
      const browserPath = BrowserCheckConfig.safeParse(cfgRow?.browserCheck ?? {}).data?.path ?? "/";
      const browserOn = (await tx.monitoringSchedule.findFirst({ where: { websiteId, tier: "T2_RENDER", apiEndpointId: null, status: "ACTIVE" }, select: { id: true } })) !== null;
      const inv = await loadPageInventory(tx, websiteId);
      const [sort, dir] = (q.sort ?? "path:asc").split(":") as [PageSort, "asc" | "desc" | undefined];
      const { total, pages, slice } = queryInventory(inv.rows, { filter: q.filter, search: q.search, sort, dir: dir ?? (sort === "path" ? "asc" : "desc"), page: q.page, pageSize: q.pageSize });
      const mids = slice.map((r) => r.monitoredId).filter(Boolean) as string[];
      const comps = mids.length ? await tx.$queryRaw<Array<{ monitored_page_id: string; n: bigint; changes: bigint }>>`
        SELECT c.monitored_page_id, count(*) FILTER (WHERE c.status = 'PRESENT') AS n,
               (SELECT count(*) FROM component_events e JOIN page_components c2 ON c2.id = e.page_component_id WHERE c2.monitored_page_id = c.monitored_page_id AND e.created_at > now() - interval '7 days') AS changes
          FROM page_components c WHERE c.monitored_page_id = ANY(${mids}::uuid[]) GROUP BY 1` : [];
      const resp = mids.length ? await tx.$queryRaw<Array<{ monitored_page_id: string; failed: bigint; total: bigint }>>`
        SELECT DISTINCT ON (r.monitored_page_id) r.monitored_page_id,
               (SELECT count(*) FROM responsive_test_results x WHERE x.execution_id = r.execution_id AND x.status = 'FAILED') AS failed,
               (SELECT count(*) FROM responsive_test_results x WHERE x.execution_id = r.execution_id) AS total
          FROM responsive_test_results r WHERE r.website_id = ${websiteId}::uuid AND r.monitored_page_id = ANY(${mids}::uuid[]) AND r.tested_at > now() - interval '62 days'
         ORDER BY r.monitored_page_id, r.tested_at DESC` : [];
      const since = new Date(Date.now() - 86_400_000);
      const perf = mids.length ? await this.rollups(tx, { orgId: o.orgId, websiteIds: [websiteId], subjectType: "PAGE", metricPrefix: `perf.lcp.${t.primaryViewport}`, from: since, to: new Date(), grain: "hour" }) : [];
      const by = <T extends Record<string, any>>(list: T[], k: keyof T) => new Map(list.map((x) => [x[k] as string, x]));
      const cBy = by(comps, "monitored_page_id"), rBy = by(resp, "monitored_page_id");
      const latest = inv.latestScan;
      return {
        data: slice.map((r) => {
          const mid = r.monitoredId;
          const a = emptyAgg();
          for (const x of perf) if (x.subjectId === mid) addRow(a, x);
          const sa = stats("lcp", a);
          const rr = mid ? rBy.get(mid) : undefined;
          return {
            ...pageFacts(r),
            // scope: only the configured browser path is browser-monitored; other pages are covered by deep scans only
            monitoring: { browser: Boolean(mid) && browserOn && pathOf(r.url) === browserPath, deepScan: r.scanState !== null || r.lastExecutionId !== null, monitoredPageId: mid },
            browser: mid ? { lastResultAt: r.monitoredLastResultAt, lcpP75_24h: sa.p75, lcpSamples_24h: sa.samples, lcpStatus: sa.sufficient ? classifyPerf(sa.p75, t.thresholds.lcp) : "INSUFFICIENT_DATA" } : null,
            components: mid ? { present: n(cBy.get(mid)?.n), changes7d: n(cBy.get(mid)?.changes) } : null,
            responsive: rr ? { failedViewports: n(rr.failed), viewports: n(rr.total) } : null,
          };
        }),
        total, page: q.page, pageSize: q.pageSize, pages,
        summary: inventorySummary(inv.rows),
        latestScan: latest ? { ...latest, partial: latest.status !== "COMPLETED", notChecked: inv.rows.filter((r) => r.state === "NOT_CHECKED").length } : null,
        runningScan: inv.runningScan,
        scoreFormula: PAGE_SCORE_FORMULA,
        scope: { browserPath, browserMonitoring: browserOn, note: "Browser checks (performance, components, responsive) run on the configured browser path only; other pages are covered by deep scans." },
      };
    });
  }

  /** One page: facts, score breakdown, OPEN findings with how to fix, findings resolved in the last 30 days. 404 unless the page belongs to this website. */
  async pageDetail(s: SessionContext, o: OrgContext, websiteId: string, pageId: string) {
    return this.member(s, o, async (tx) => {
      const w = await this.website(tx, o.orgId, websiteId);
      const inv = await loadPageInventory(tx, websiteId);
      const hash = pageId.startsWith("url-") ? pageId.slice(4) : null;
      const r = inv.rows.find((x) => (hash ? x.urlHash === hash : x.id === pageId));
      if (!r) throw Errors.notFound();
      const cols = { id: true, category: true, groupKey: true, severity: true, status: true, subject: true, title: true, evidence: true, recommendation: true, detectionMethod: true, occurrenceCount: true, reopenCount: true, firstDetectedAt: true, lastDetectedAt: true, resolvedAt: true } as const;
      const rank = (sv: string) => ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(sv);
      const open = (await tx.scanFinding.findMany({ where: { websiteId, subject: r.url, status: "OPEN" }, select: cols, orderBy: { lastDetectedAt: "desc" }, take: 500 }))
        .sort((a, b) => rank(a.severity) - rank(b.severity));
      const resolved = await tx.scanFinding.findMany({ where: { websiteId, subject: r.url, status: "RESOLVED", resolvedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, select: cols, orderBy: { resolvedAt: "desc" }, take: 100 });
      // site-wide findings naming this page in their evidence (duplicate titles / descriptions / content): shown, not scored
      const related = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM scan_findings WHERE website_id = ${websiteId}::uuid AND status = 'OPEN' AND subject = 'site' AND evidence -> 'pages' ? ${r.url} LIMIT 50`;
      const siteWide = related.length ? await tx.scanFinding.findMany({ where: { websiteId, id: { in: related.map((x) => x.id) } }, select: cols }) : [];
      return {
        ...pageFacts(r),
        websiteOrigin: w.canonicalOrigin,
        score: { value: r.score.score, band: r.score.band, basis: r.score.basis, penalty: r.score.penalty, bySeverity: r.score.bySeverity, penalties: PAGE_SCORE_PENALTY, formula: PAGE_SCORE_FORMULA },
        findings: open.map(pageFindingDto),
        resolvedFindings: resolved.map(pageFindingDto),
        siteWideFindings: siteWide.map(pageFindingDto),
        latestScan: inv.latestScan,
      };
    });
  }

  // ------------------------------------------------------------------ components: per-component history, comparison with a date
  async componentDetail(s: SessionContext, o: OrgContext, websiteId: string, componentId: string) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const [c] = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT c.id, c.type::text AS type, c.label, c.status, c.detail, c.viewports, c.visibility, c.first_seen_at, c.last_seen_at, c.removed_at, d.url
          FROM page_components c JOIN monitored_pages m ON m.id = c.monitored_page_id JOIN discovered_pages d ON d.id = m.discovered_page_id
         WHERE c.id = ${componentId}::uuid AND c.website_id = ${websiteId}::uuid`;
      if (!c) throw Errors.notFound();
      const events = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT id, created_at, type, before, after, execution_id FROM component_events WHERE page_component_id = ${componentId}::uuid ORDER BY id DESC LIMIT 200`;
      return {
        id: c.id, type: c.type, label: c.label, status: c.status, detail: c.detail, pagePath: pathOf(c.url), viewports: c.viewports, visibility: c.visibility,
        firstSeenAt: iso(c.first_seen_at), lastSeenAt: iso(c.last_seen_at), removedAt: iso(c.removed_at),
        history: events.map((e) => ({ id: String(e.id), at: iso(e.created_at), type: e.type, before: e.before, after: e.after, executionId: e.execution_id })),
      };
    });
  }

  /** What changed in the component inventory since a date: net added / removed / changed / visibility per component. */
  async componentsSince(s: SessionContext, o: OrgContext, websiteId: string, since: Date) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT c.id, c.type::text AS type, c.label, c.status, c.first_seen_at, array_agg(e.type ORDER BY e.id) AS types
          FROM component_events e JOIN page_components c ON c.id = e.page_component_id
         WHERE e.website_id = ${websiteId}::uuid AND e.created_at > ${since} GROUP BY 1, 2, 3, 4, 5`;
      const added = [], removed = [], changed = [], visibility = [];
      for (const r of rows) {
        const types = r.types as string[];
        const item = { id: r.id, type: r.type, label: r.label };
        const last = [...types].reverse().find((x) => x === "REMOVED" || x === "RESTORED" || x === "ADDED");
        if (last === "REMOVED" && r.status === "REMOVED") removed.push(item);
        else if ((last === "ADDED" || last === "RESTORED") && r.status === "PRESENT") added.push(item);
        if (types.includes("CHANGED") && r.status === "PRESENT") changed.push(item);
        if (types.includes("VISIBILITY")) visibility.push(item);
      }
      const [{ oldest }] = await tx.$queryRaw<Array<{ oldest: Date | null }>>`SELECT min(first_seen_at) AS oldest FROM page_components WHERE website_id = ${websiteId}::uuid`;
      return { since: since.toISOString(), inventoryStartedAt: iso(oldest), complete: oldest !== null && oldest <= since, added, removed, changed, visibility };
    });
  }

  // ------------------------------------------------------------------ responsive dashboard
  async responsive(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof Range>) {
    const { from, to } = rangeOf(q);
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const latest = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT DISTINCT ON (viewport) viewport, width, height, status::text AS status, nav_state, horizontal_overflow_px, clipped_text, "overlaps", obscured_controls,
               offscreen_controls, offscreen_elements, oversized_images, findings, execution_id, tested_at
          FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND tested_at >= ${from} AND tested_at < ${to}
         ORDER BY viewport, tested_at DESC`;
      const daily = await tx.$queryRaw<Array<{ day: Date; viewport: string; passed: bigint; failed: bigint }>>`
        SELECT date_trunc('day', tested_at) AS day, viewport, count(*) FILTER (WHERE status = 'PASSED') AS passed, count(*) FILTER (WHERE status = 'FAILED') AS failed
          FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND tested_at >= ${from} AND tested_at < ${to} GROUP BY 1, 2 ORDER BY 1, 2`;
      const runs = await tx.$queryRaw<Array<{ execution_id: string; tested_at: Date; viewports: string[]; failed: bigint }>>`
        SELECT execution_id, max(tested_at) AS tested_at, array_agg(viewport ORDER BY viewport) AS viewports, count(*) FILTER (WHERE status = 'FAILED') AS failed
          FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND tested_at >= ${from} AND tested_at < ${to}
         GROUP BY execution_id ORDER BY max(tested_at) DESC LIMIT 30`;
      return {
        range: { from: from.toISOString(), to: to.toISOString() }, timezone: "UTC", measurement: "SYNTHETIC_BROWSER",
        latest: latest.map(dtoResponsive),
        daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), viewport: d.viewport, passed: n(d.passed), failed: n(d.failed) })),
        runs: runs.map((r) => ({ executionId: r.execution_id, at: iso(r.tested_at), viewports: r.viewports, failedViewports: n(r.failed) })),
      };
    });
  }

  async responsiveCompare(s: SessionContext, o: OrgContext, websiteId: string, a: string, b: string) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT execution_id, viewport, width, height, status::text AS status, nav_state, horizontal_overflow_px, clipped_text, "overlaps", obscured_controls,
               offscreen_controls, offscreen_elements, oversized_images, findings, tested_at
          FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND execution_id = ANY(${[a, b]}::uuid[])`;
      const A = rows.filter((r) => r.execution_id === a), B = rows.filter((r) => r.execution_id === b);
      if (!A.length || !B.length) throw Errors.notFound();
      const vps = [...new Set([...A, ...B].map((r) => r.viewport as string))].sort();
      return {
        a: { executionId: a, at: iso(A[0]!.tested_at) }, b: { executionId: b, at: iso(B[0]!.tested_at) },
        viewports: vps.map((v) => {
          const x = A.find((r) => r.viewport === v), y = B.find((r) => r.viewport === v);
          const ox = new Set<string>(x?.findings?.objective ?? []), oy = new Set<string>(y?.findings?.objective ?? []);
          return {
            viewport: v, a: x ? dtoResponsive(x) : null, b: y ? dtoResponsive(y) : null,
            // a viewport observed in only one run can't be compared (rotation), never reported as fixed or broken
            comparable: Boolean(x && y),
            newProblems: x && y ? [...oy].filter((f) => !ox.has(f)) : [], fixedProblems: x && y ? [...ox].filter((f) => !oy.has(f)) : [],
          };
        }),
      };
    });
  }
}

function dtoResponsive(x: Record<string, any>) {
  return {
    viewport: x.viewport, width: x.width, height: x.height, status: x.status, navState: x.nav_state, overflowPx: x.horizontal_overflow_px,
    clippedText: x.clipped_text, overlaps: x.overlaps, obscuredControls: x.obscured_controls, offscreenControls: x.offscreen_controls,
    offscreenText: x.offscreen_elements, oversizedImages: x.oversized_images, objective: x.findings?.objective ?? [], heuristic: x.findings?.heuristic ?? [],
    executionId: x.execution_id ?? null, at: x.tested_at ? new Date(x.tested_at).toISOString() : null,
  };
}

const id = (v: string) => parse(Uuid, v);
const PagesQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().refine((v) => [10, 25, 50, 100].includes(v), "pageSize must be 10, 25, 50 or 100").default(25),
  search: z.string().min(1).max(100).optional(),
  /** `path` | `score` | `findings`, optionally `:asc` / `:desc` (default asc for path, desc otherwise) */
  sort: z.string().regex(/^(path|score|findings)(:(asc|desc))?$/).optional(),
  filter: z.enum(["all", "with_findings", "not_checked", "failed", "skipped"]).default("all"),
}).strict();
/** discovered page id (uuid) or `url-<sha256 of the normalised URL>` for a URL no scan has fetched as a page yet */
const PageId = z.union([z.uuid(), z.string().regex(/^url-[0-9a-f]{64}$/)]);
const SinceQuery = z.object({ since: z.iso.datetime() }).strict();

@Controller("api/v1/orgs/:orgId/websites/:websiteId")
export class PerformanceController {
  constructor(private readonly p: PerformanceService) {}

  @Get("performance")
  @RequirePermission("website:read")
  async summary(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.p.summary(s, o, id(w), parse(SummaryQuery, q)) };
  }

  @Get("performance/series")
  @RequirePermission("website:read")
  async series(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.p.series(s, o, id(w), parse(SeriesQuery, q)) };
  }

  @Get("performance/pages")
  @RequirePermission("website:read")
  async pageComparison(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.p.pageComparison(s, o, id(w), parse(SummaryQuery, q)) };
  }

  @Get("performance/thresholds")
  @RequirePermission("website:read")
  async thresholds(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.p.readThresholds(s, o, id(w)) };
  }

  @Put("performance/thresholds")
  @RequirePermission("monitoring:write")
  async setThresholds(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.p.updateThresholds(s, o, id(w), parse(ThresholdInput, body), c) };
  }

  @Get("pages")
  @RequirePermission("website:read")
  async pages(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return this.p.pages(s, o, id(w), parse(PagesQuery, q));
  }

  @Get("pages/:pageId")
  @RequirePermission("website:read")
  async page(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("pageId") pg: string) {
    return { data: await this.p.pageDetail(s, o, id(w), parse(PageId, pg)) };
  }

  @Get("components/changes")
  @RequirePermission("website:read")
  async componentsSince(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.p.componentsSince(s, o, id(w), new Date(parse(SinceQuery, q).since)) };
  }

  @Get("components/:componentId")
  @RequirePermission("website:read")
  async component(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("componentId") c: string) {
    return { data: await this.p.componentDetail(s, o, id(w), id(c)) };
  }

  @Get("responsive")
  @RequirePermission("website:read")
  async responsive(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.p.responsive(s, o, id(w), parse(Range, q)) };
  }

  @Get("responsive/compare")
  @RequirePermission("website:read")
  async responsiveCompare(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    const c = parse(CompareQuery, q);
    return { data: await this.p.responsiveCompare(s, o, id(w), c.a, c.b) };
  }
}
