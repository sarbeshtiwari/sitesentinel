import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { uptimeFrom, type MonitoringLimits, type SettingsSnapshot } from "@wim/core";
import { withMember, type Db, type Tx } from "@wim/db";
import { loadOrgContexts } from "@wim/queue";
import {
  HistoryQuery, RangeQuery, ScheduleInput, Uuid,
  type ChangeFeedDto, type HealthState, type HistoryEventDto, type HttpAnalyticsDto, type MonitoringOverviewDto, type MonitoringUsageDto,
  type TierEntitlementsDto, type WebsiteHealthDto,
} from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";
import { WebsitesService } from "../websites/websites.service.js";
import { PerformanceService } from "./performance.controller.js";
import { rangeOf } from "./range.js";

export { rangeOf };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const n = (v: unknown) => (v == null ? 0 : Number(v));
const SOURCE_DB: Record<string, string> = { HTTP: "HTTP_PROBE", BROWSER: "BROWSER", DEEP_SCAN: "DEEP_SCAN" };
const SOURCE_API: Record<string, string> = { HTTP_PROBE: "HTTP", BROWSER: "BROWSER", DEEP_SCAN: "DEEP_SCAN", SSL: "HTTP" };
const TIER_SOURCE: Record<string, string> = { T1_HTTP: "HTTP", T2_RENDER: "BROWSER", T3_DEEP: "DEEP_SCAN" };
const RANK: HealthState[] = ["DOWN", "DEGRADED", "INCONCLUSIVE", "NO_DATA", "HEALTHY"];
/** Below this share of scheduled checks actually measured, a website is never shown as healthy. */
const MIN_COVERAGE_PERCENT = 80;


/** Opaque keyset cursor: (timestamp, tiebreak id). */
const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
  const d = new Date(at ?? "");
  if (Number.isNaN(d.getTime()) || !id || id.length > 80) throw new AppError(400, "VALIDATION_FAILED", "Invalid cursor");
  return { at: d, id };
}

/**
 * Phase 4F customer dashboard API: organisation overview, range analytics, unified history, usage, change feed,
 * per-tier schedule, incident acknowledgement. Every read runs under RLS (withMember); every number comes from
 * persisted results, executions, incidents and usage counters — nothing is estimated or generated here.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly websites: WebsitesService,
    private readonly perf: PerformanceService,
  ) {}

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }
  private async limits(tx: Tx, orgId: string, st: SettingsSnapshot): Promise<MonitoringLimits> {
    return (await loadOrgContexts(tx, [orgId], st)).get(orgId)!.limits;
  }
  private async website(tx: Tx, orgId: string, websiteId: string) {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: { id: true } });
    if (!w) throw Errors.notFound();
  }

  /** Why each tier is or isn't available to this organisation (platform switch vs entitlement). */
  entitlements(st: SettingsSnapshot, l: MonitoringLimits): TierEntitlementsDto {
    const why = (platform: boolean, entitled: boolean) => (!platform ? "Not offered on this platform yet" : !entitled ? "Not included in your plan" : null);
    return {
      HTTP: { available: l.tiers.HTTP.enabled, reason: why(st["monitoring.http.enabled"], true), minIntervalSec: l.tiers.HTTP.intervalSec },
      BROWSER: { available: l.tiers.BROWSER.enabled, reason: why(st["monitoring.browser.enabled"], l.browser.entitled), minIntervalSec: l.tiers.BROWSER.intervalSec },
      DEEPSCAN: {
        available: l.tiers.DEEPSCAN.enabled, reason: why(st["monitoring.deepscan.enabled"], l.deepscan.entitled), minIntervalSec: l.tiers.DEEPSCAN.intervalSec,
        browserDiscovery: l.tiers.DEEPSCAN.enabled && l.deepscan.browserPages > 0, externalLinks: l.tiers.DEEPSCAN.enabled && l.deepscan.externalLinks,
      },
    };
  }

  // ------------------------------------------------------------------ organisation overview
  async overview(s: SessionContext, o: OrgContext, q: z.infer<typeof RangeQuery>): Promise<MonitoringOverviewDto> {
    const { from, to } = rangeOf(q);
    const st = await this.settings.get();
    const sites = await this.websites.list(s, o);
    return this.member(s, o, async (tx) => {
      const limits = await this.limits(tx, o.orgId, st);
      const ids = sites.map((w) => w.id);
      // One grouped query per source — no per-website requests.
      const scheds = await tx.$queryRaw<Array<{ website_id: string; tier: string; status: string; paused_reason: string | null }>>`
        SELECT website_id, tier::text AS tier, status::text AS status, paused_reason FROM monitoring_schedules
         WHERE website_id = ANY(${ids}::uuid[]) AND api_endpoint_id IS NULL`;
      const http = await tx.$queryRaw<Array<{ website_id: string; up: bigint; down: bigint; inconclusive: bigint; infra: bigint }>>`
        SELECT website_id, count(*) FILTER (WHERE available) AS up, count(*) FILTER (WHERE available = false) AS down,
               count(*) FILTER (WHERE status = 'INCONCLUSIVE') AS inconclusive,
               count(*) FILTER (WHERE failure_category = 'GATEWAY_INFRASTRUCTURE') AS infra
          FROM check_results WHERE website_id = ANY(${ids}::uuid[]) AND checked_at >= ${from} AND checked_at < ${to} GROUP BY 1`;
      const scheduled = await tx.$queryRaw<Array<{ website_id: string; n: bigint }>>`
        SELECT website_id, count(*) AS n FROM monitoring_executions
         WHERE website_id = ANY(${ids}::uuid[]) AND tier = 'T1_HTTP' AND trigger = 'SCHEDULE' AND queued_at >= ${from} AND queued_at < ${to} GROUP BY 1`;
      const lastHttp = await tx.$queryRaw<Array<{ website_id: string; at: Date; status: string; ok: Date | null; failed: Date | null }>>`
        SELECT DISTINCT ON (website_id) website_id, finished_at AS at, status::text AS status,
               (SELECT max(finished_at) FROM check_results c2 WHERE c2.website_id = c.website_id AND c2.available) AS ok,
               (SELECT max(finished_at) FROM check_results c3 WHERE c3.website_id = c.website_id AND c3.status = 'FAILED') AS failed
          FROM check_results c WHERE website_id = ANY(${ids}::uuid[]) ORDER BY website_id, checked_at DESC`;
      const lastBrowser = await tx.$queryRaw<Array<{ website_id: string; at: Date; outcome: string }>>`
        SELECT DISTINCT ON (website_id) website_id, recorded_at AS at, outcome FROM execution_results
         WHERE website_id = ANY(${ids}::uuid[]) AND tier = 'T2_RENDER' ORDER BY website_id, window_start DESC`;
      const deep = await tx.$queryRaw<Array<{ website_id: string; status: string; complete: boolean; finished_at: Date | null; completed_at: Date | null }>>`
        SELECT DISTINCT ON (website_id) website_id, status, complete, finished_at,
               (SELECT max(finished_at) FROM deep_scans d2 WHERE d2.website_id = d.website_id AND d2.status = 'COMPLETED') AS completed_at
          FROM deep_scans d WHERE website_id = ANY(${ids}::uuid[]) ORDER BY website_id, started_at DESC`;
      const findings = await tx.$queryRaw<Array<{ website_id: string; n: bigint }>>`
        SELECT website_id, count(*) AS n FROM scan_findings WHERE website_id = ANY(${ids}::uuid[]) AND status = 'OPEN' GROUP BY 1`;
      const incidents = await tx.$queryRaw<Array<{ website_id: string; check_key: string; status: string }>>`
        SELECT website_id, check_key, status::text AS status FROM incidents
         WHERE org_id = ${o.orgId}::uuid AND status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED')`;
      const [resolved] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM incidents WHERE org_id = ${o.orgId}::uuid AND status = 'RESOLVED' AND resolved_at >= ${from} AND resolved_at < ${to}`;

      const perfBy = await this.perf.orgPerformance(tx, st, o.orgId, ids, from, to);
      const compEvents = await tx.$queryRaw<Array<{ created_at: Date; website_id: string; type: string; ctype: string; label: string | null }>>`
        SELECT e.created_at, e.website_id, e.type, c.type::text AS ctype, c.label FROM component_events e JOIN page_components c ON c.id = e.page_component_id
         WHERE e.org_id = ${o.orgId}::uuid AND e.created_at >= ${from} AND e.created_at < ${to} ORDER BY e.id DESC LIMIT 20`;
      const by = <T extends { website_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.website_id, r]));
      const httpBy = by(http), schedBy = (w: string, t: string) => scheds.find((x) => x.website_id === w && x.tier === t);
      const scheduledBy = by(scheduled), lastHttpBy = by(lastHttp), lastBrowserBy = by(lastBrowser), deepBy = by(deep), findingsBy = by(findings);
      let passed = 0, failed = 0, inconclusive = 0;

      const websites: WebsiteHealthDto[] = sites.map((w) => {
        const h = httpBy.get(w.id);
        const up = n(h?.up), down = n(h?.down), inc = n(h?.inconclusive);
        passed += up; failed += down; inconclusive += inc;
        const uptime = uptimeFrom({ up, down, scheduled: n(scheduledBy.get(w.id)?.n) });
        const open = incidents.filter((i) => i.website_id === w.id);
        const keys = new Set(open.map((i) => i.check_key));
        const t1 = schedBy(w.id, "T1_HTTP"), t2 = schedBy(w.id, "T2_RENDER"), t3 = schedBy(w.id, "T3_DEEP");
        const lh = lastHttpBy.get(w.id), lb = lastBrowserBy.get(w.id), d = deepBy.get(w.id);
        const reasons: string[] = [];
        const tierState = (sched: typeof t1, last: string | null | undefined, down: boolean, degraded: boolean): HealthState | "OFF" => {
          if (!sched || sched.status !== "ACTIVE") return "OFF";
          if (down) return "DOWN";
          if (degraded || last === "FAILED") return "DEGRADED";
          if (!last) return "NO_DATA";
          return last === "INCONCLUSIVE" ? "INCONCLUSIVE" : "HEALTHY";
        };
        const httpKeys = [...keys].filter((k) => k.startsWith("http."));
        const browserKeys = [...keys].filter((k) => k.startsWith("browser."));
        const deepKeys = [...keys].filter((k) => k.startsWith("deepscan."));
        const hs = tierState(t1, lh?.status, keys.has("http.down") || keys.has("http.tls"), httpKeys.length > 0);
        const bs = tierState(t2, lb?.outcome, keys.has("browser.navigation") || keys.has("browser.blank"), browserKeys.length > 0);
        const ds: HealthState | "OFF" = !t3 || t3.status !== "ACTIVE" ? "OFF" : deepKeys.length ? "DEGRADED" : !d ? "NO_DATA" : d.status === "COMPLETED" ? "HEALTHY" : "INCONCLUSIVE";
        let health: HealthState;
        if (w.verification !== "VERIFIED") { health = "NOT_VERIFIED"; reasons.push("Website ownership is not verified"); }
        else if (w.status === "PAUSED") { health = "DISABLED"; reasons.push("Monitoring is paused for this website"); }
        else {
          const states = [hs, bs, ds].filter((x): x is HealthState => x !== "OFF");
          if (!states.length) { health = "DISABLED"; reasons.push("No monitoring is active for this website"); }
          else {
            health = RANK.find((r) => states.includes(r)) ?? "NO_DATA";
            if (hs === "DOWN") reasons.push("Website is down (HTTP)");
            if (bs === "DOWN") reasons.push("Page does not load in a browser");
            if (hs === "DEGRADED" || bs === "DEGRADED") reasons.push("Checks are failing");
            if (ds === "DEGRADED") reasons.push("Deep scan found broken pages or resources");
            if (n(h?.infra) > 0) reasons.push(`${n(h?.infra)} check(s) inconclusive because of a monitoring infrastructure problem (not counted against your website)`);
            // Never show a website as healthy on thin data.
            if (health === "HEALTHY" && hs !== "OFF" && uptime.coveragePercent !== null && uptime.coveragePercent < MIN_COVERAGE_PERCENT) {
              health = "INCONCLUSIVE";
              reasons.push(`Insufficient monitoring coverage (${uptime.coveragePercent}% of scheduled checks measured)`);
            }
          }
        }
        return {
          id: w.id, name: w.name, displayHost: w.displayHost, websiteStatus: w.status, verification: w.verification, health, reasons,
          http: { state: hs === "OFF" ? (t1?.paused_reason ?? "NOT_MONITORED") : hs, uptime, lastCheckAt: iso(lh?.at), lastOutcome: lh?.status ?? null, lastSuccessAt: iso(lh?.ok), lastFailureAt: iso(lh?.failed), infraFailures: n(h?.infra) },
          browser: { state: bs === "OFF" ? (t2?.paused_reason ?? "NOT_MONITORED") : bs, lastCheckAt: iso(lb?.at), lastOutcome: lb?.outcome ?? null },
          deepScan: { state: ds === "OFF" ? (t3?.paused_reason ?? "NOT_MONITORED") : ds, lastStatus: d?.status ?? null, lastComplete: d?.complete ?? null, lastFinishedAt: iso(d?.finished_at), lastCompletedAt: iso(d?.completed_at), openFindings: n(findingsBy.get(w.id)?.n) },
          activeIncidents: open.length,
          performance: t2 && t2.status === "ACTIVE" ? perfBy.get(w.id) ?? null : null,
        };
      });
      const nameOf = new Map(sites.map((w) => [w.id, w.name]));
      const recentChanges: MonitoringOverviewDto["recentChanges"] = [
        ...compEvents.map((e) => ({ at: e.created_at.toISOString(), websiteId: e.website_id, websiteName: nameOf.get(e.website_id) ?? "", kind: "COMPONENT" as const,
          title: `${e.ctype.toLowerCase().replace("_", " ")} ${e.label ? `"${e.label}" ` : ""}${e.type.toLowerCase()}`, link: `/websites/${e.website_id}?tab=components` })),
        ...[...perfBy].flatMap(([wid, p]) => p.regressions.map((r) => ({ at: to.toISOString(), websiteId: wid, websiteName: nameOf.get(wid) ?? "", kind: "PERFORMANCE_REGRESSION" as const,
          title: `${r.metric.toUpperCase()} p75 ${r.deltaPct === null ? "worse" : `+${r.deltaPct}%`} vs the previous period`, link: `/websites/${wid}?tab=performance` }))),
      ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
      const measured = passed + failed;
      return {
        range: { from: from.toISOString(), to: to.toISOString() }, timezone: "UTC", websites, recentChanges,
        totals: {
          websites: sites.length, monitored: websites.filter((w) => !["DISABLED", "NOT_VERIFIED"].includes(w.health)).length,
          activeIncidents: incidents.length, resolvedIncidentsInRange: n(resolved?.n),
          httpChecks: { passed, failed, inconclusive, successRatePercent: measured ? Math.round((passed / measured) * 1000) / 10 : null },
        },
        entitlements: this.entitlements(st, limits),
      };
    });
  }

  // ------------------------------------------------------------------ HTTP range analytics (authoritative)
  async httpAnalytics(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof RangeQuery>): Promise<HttpAnalyticsDto> {
    const { from, to } = rangeOf(q);
    const span = to.getTime() - from.getTime();
    const bucketSec = span <= 2 * 86_400_000 ? 3600 : span <= 14 * 86_400_000 ? 21_600 : 86_400;
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const [c] = await tx.$queryRaw<Array<Record<string, number | bigint | null>>>`
        SELECT count(*) AS total, count(*) FILTER (WHERE status = 'PASSED') AS passed, count(*) FILTER (WHERE status = 'FAILED') AS failed,
               count(*) FILTER (WHERE status = 'INCONCLUSIVE') AS inconclusive,
               count(*) FILTER (WHERE available) AS up, count(*) FILTER (WHERE available = false) AS down,
               avg(total_ms) FILTER (WHERE available)::float AS avg_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE available) AS p95_ms,
               max(total_ms) FILTER (WHERE available) AS max_ms,
               avg(dns_ms)::float AS dns, avg(connect_ms)::float AS conn, avg(tls_ms)::float AS tls, avg(ttfb_ms)::float AS ttfb, avg(total_ms)::float AS tot
          FROM check_results WHERE website_id = ${websiteId}::uuid AND checked_at >= ${from} AND checked_at < ${to}`;
      const [sch] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM monitoring_executions
         WHERE website_id = ${websiteId}::uuid AND tier = 'T1_HTTP' AND trigger = 'SCHEDULE' AND queued_at >= ${from} AND queued_at < ${to}`;
      const series = await tx.$queryRaw<Array<{ t: Date; up: bigint; down: bigint; inc: bigint; sched: bigint; avg_ms: number | null; p95_ms: number | null }>>`
        WITH b AS (SELECT generate_series(date_bin(make_interval(secs => ${bucketSec}), ${from}::timestamptz, 'epoch'::timestamptz), ${to}::timestamptz, make_interval(secs => ${bucketSec})) AS t),
             r AS (SELECT date_bin(make_interval(secs => ${bucketSec}), checked_at, 'epoch'::timestamptz) AS t,
                          count(*) FILTER (WHERE available) AS up, count(*) FILTER (WHERE available = false) AS down,
                          count(*) FILTER (WHERE status = 'INCONCLUSIVE') AS inc,
                          avg(total_ms) FILTER (WHERE available)::float AS avg_ms,
                          percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE available) AS p95_ms
                     FROM check_results WHERE website_id = ${websiteId}::uuid AND checked_at >= ${from} AND checked_at < ${to} GROUP BY 1),
             e AS (SELECT date_bin(make_interval(secs => ${bucketSec}), queued_at, 'epoch'::timestamptz) AS t, count(*) AS sched
                     FROM monitoring_executions WHERE website_id = ${websiteId}::uuid AND tier = 'T1_HTTP' AND trigger = 'SCHEDULE'
                      AND queued_at >= ${from} AND queued_at < ${to} GROUP BY 1)
        SELECT b.t, coalesce(r.up, 0) AS up, coalesce(r.down, 0) AS down, coalesce(r.inc, 0) AS inc, coalesce(e.sched, 0) AS sched, r.avg_ms, r.p95_ms
          FROM b LEFT JOIN r ON r.t = b.t LEFT JOIN e ON e.t = b.t WHERE b.t < ${to} ORDER BY b.t`;
      const dist = await tx.$queryRaw<Array<{ k: string; n: bigint }>>`
        SELECT CASE WHEN http_status IS NULL THEN 'No response' ELSE (http_status / 100)::text || 'xx' END AS k, count(*) AS n
          FROM check_results WHERE website_id = ${websiteId}::uuid AND checked_at >= ${from} AND checked_at < ${to} GROUP BY 1 ORDER BY 1`;
      const cats = await tx.$queryRaw<Array<{ k: string; n: bigint }>>`
        SELECT failure_category AS k, count(*) AS n FROM check_results
         WHERE website_id = ${websiteId}::uuid AND checked_at >= ${from} AND checked_at < ${to} AND status <> 'PASSED' AND failure_category IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`;
      // Downtime = time covered by availability incidents ("http.down") inside the range — the incident engine's
      // thresholds decide what counts as an outage, not a frontend count of failed checks.
      const inc = await tx.$queryRaw<Array<{ id: string; number: number; title: string; status: string; severity: string; check_key: string; first_detected_at: Date; resolved_at: Date | null }>>`
        SELECT id, number, title, status::text AS status, severity::text AS severity, check_key, first_detected_at, resolved_at FROM incidents
         WHERE website_id = ${websiteId}::uuid AND check_key LIKE 'http.%' AND first_detected_at < ${to} AND (resolved_at IS NULL OR resolved_at > ${from})
         ORDER BY first_detected_at`;
      const downtimeMs = inc.filter((i) => i.check_key === "http.down").reduce((a, i) => {
        const end = Math.min((i.resolved_at ?? new Date()).getTime(), to.getTime());
        return a + Math.max(0, end - Math.max(i.first_detected_at.getTime(), from.getTime()));
      }, 0);
      const r = (v: unknown) => (v == null ? null : Math.round(Number(v)));
      const total = n(c!.total), scheduled = n(sch!.n);
      return {
        range: { from: from.toISOString(), to: to.toISOString() }, bucketSec,
        uptime: uptimeFrom({ up: n(c!.up), down: n(c!.down), scheduled }),
        checks: { total, passed: n(c!.passed), failed: n(c!.failed), inconclusive: n(c!.inconclusive), scheduled, skippedOrMissing: Math.max(0, scheduled - total) },
        downtimeSec: Math.round(downtimeMs / 1000),
        responseMs: { avg: r(c!.avg_ms), p95: r(c!.p95_ms), max: r(c!.max_ms) },
        timings: { dnsMs: r(c!.dns), connectMs: r(c!.conn), tlsMs: r(c!.tls), ttfbMs: r(c!.ttfb), totalMs: r(c!.tot) },
        statusDistribution: dist.map((d) => ({ status: d.k, count: n(d.n) })),
        failureCategories: cats.map((d) => ({ category: d.k, count: n(d.n) })),
        series: series.map((x) => ({ t: x.t.toISOString(), up: n(x.up), down: n(x.down), inconclusive: n(x.inc), scheduled: n(x.sched), avgMs: r(x.avg_ms), p95Ms: r(x.p95_ms) })),
        incidents: inc.map((i) => ({ id: i.id, number: i.number, title: i.title, status: i.status, severity: i.severity, from: i.first_detected_at.toISOString(), to: iso(i.resolved_at) })),
      };
    });
  }

  // ------------------------------------------------------------------ per-tier schedule (can only slow down)
  async schedule(s: SessionContext, o: OrgContext, websiteId: string, input: z.infer<typeof ScheduleInput>, client: ClientInfo) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const l = await this.limits(tx, o.orgId, st);
      const checks: Array<[keyof typeof input, "HTTP" | "BROWSER" | "DEEPSCAN", string]> = [
        ["httpIntervalSec", "HTTP", "t1IntervalSec"], ["browserIntervalSec", "BROWSER", "t2IntervalSec"], ["deepScanIntervalSec", "DEEPSCAN", "t3IntervalSec"],
      ];
      const data: Record<string, number | null> = {};
      const issues: Array<{ path: string; message: string }> = [];
      for (const [k, tier, col] of checks) {
        const v = input[k];
        if (v === undefined) continue;
        if (v !== null && v < l.tiers[tier].intervalSec) issues.push({ path: k, message: `Your plan allows checks every ${l.tiers[tier].intervalSec} s at most` });
        data[col] = v;
      }
      if (issues.length) throw new AppError(400, "VALIDATION_FAILED", "Interval below your plan's minimum", { issues });
      await tx.monitoringConfiguration.upsert({ where: { websiteId }, create: { orgId: o.orgId, websiteId, ...data }, update: data });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.monitoring_schedule_updated", targetType: "website", targetId: websiteId, changes: input, client }, tx);
      const row = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { t1IntervalSec: true, t2IntervalSec: true, t3IntervalSec: true } });
      return { httpIntervalSec: row?.t1IntervalSec ?? null, browserIntervalSec: row?.t2IntervalSec ?? null, deepScanIntervalSec: row?.t3IntervalSec ?? null };
    });
  }

  async scheduleRead(s: SessionContext, o: OrgContext, websiteId: string) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const l = await this.limits(tx, o.orgId, st);
      const row = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { t1IntervalSec: true, t2IntervalSec: true, t3IntervalSec: true } });
      return {
        requested: { httpIntervalSec: row?.t1IntervalSec ?? null, browserIntervalSec: row?.t2IntervalSec ?? null, deepScanIntervalSec: row?.t3IntervalSec ?? null },
        entitlements: this.entitlements(st, l),
      };
    });
  }

  // ------------------------------------------------------------------ incident acknowledgement
  async acknowledge(s: SessionContext, o: OrgContext, incidentId: string, client: ClientInfo) {
    return this.member(s, o, async (tx) => {
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT acknowledge_incident(${incidentId}::uuid) AS r`;
      if (r === "NOT_FOUND") throw Errors.notFound();
      if (r === "NOT_ACTIVE") throw new AppError(409, "CONFLICT", "Only open incidents can be acknowledged");
      if (r === "ACKNOWLEDGED") {
        await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "incident.acknowledged", targetType: "incident", targetId: incidentId, changes: {}, client }, tx);
      }
      const i = await tx.incident.findFirst({ where: { id: incidentId, orgId: o.orgId }, select: { status: true, acknowledgedAt: true } });
      return { status: i!.status, acknowledgedAt: iso(i!.acknowledgedAt), changed: r === "ACKNOWLEDGED" };
    });
  }

  // ------------------------------------------------------------------ unified history (persisted events only)
  async history(s: SessionContext, o: OrgContext, q: z.infer<typeof HistoryQuery>): Promise<{ data: HistoryEventDto[]; nextCursor: string | null }> {
    const cur = decodeCursor(q.cursor);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 60_000);
    const from = q.from ? new Date(q.from) : new Date(0);
    const atMax = cur && cur.at < to ? cur.at : to;
    const idMax = cur ? cur.id : "~"; // sorts above every key under COLLATE "C" (keys start with a lower-case letter)
    const lim = q.limit + 1;
    const w = q.websiteId ?? null;
    const want = (t: HistoryEventDto["type"]) => !q.type || q.type === t;
    const tiers = q.source ? [{ HTTP: "T1_HTTP", BROWSER: "T2_RENDER", DEEP_SCAN: "T3_DEEP" }[q.source]] : ["T1_HTTP", "T2_RENDER", "T3_DEEP"];
    return this.member(s, o, async (tx) => {
      const names = new Map((await tx.website.findMany({ where: { orgId: o.orgId }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
      const rows: Array<HistoryEventDto & { key: string }> = [];
      // Each branch: org-scoped, time-bounded, index-ordered, limited; then merged by (at, key).
      if (want("CHECK")) {
        const r = await tx.$queryRaw<Array<{ execution_id: string; website_id: string; tier: string; outcome: string; window_start: Date }>>`
          SELECT execution_id, website_id, tier::text AS tier, outcome, window_start FROM execution_results
           WHERE org_id = ${o.orgId}::uuid AND tier::text = ANY(${tiers}::text[]) AND (${w}::uuid IS NULL OR website_id = ${w}::uuid)
             AND (${q.result ?? null}::text IS NULL OR outcome = ${q.result ?? null})
             AND window_start >= ${from} AND (window_start, ('c:' || execution_id::text) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
           ORDER BY window_start DESC, execution_id DESC LIMIT ${lim}`;
        for (const x of r) {
          const src = TIER_SOURCE[x.tier]!;
          const label = src === "HTTP" ? "HTTP check" : src === "BROWSER" ? "Browser check" : "Deep scan";
          rows.push({ key: `c:${x.execution_id}`, id: `c:${x.execution_id}`, at: x.window_start.toISOString(), type: "CHECK", source: src, websiteId: x.website_id, websiteName: names.get(x.website_id) ?? null,
            title: `${label}: ${x.outcome.toLowerCase()}`, result: x.outcome,
            link: src === "BROWSER" ? `/websites/${x.website_id}/browser/${x.execution_id}` : src === "DEEP_SCAN" ? `/websites/${x.website_id}/deep-scan/scans/${x.execution_id}` : `/websites/${x.website_id}?tab=availability` });
        }
      }
      if (want("INCIDENT") && !q.result) {
        const srcs = q.source ? [SOURCE_DB[q.source]!, ...(q.source === "HTTP" ? ["SSL"] : [])] : null;
        const r = await tx.$queryRaw<Array<{ id: string; type: string; created_at: Date; incident_id: string; number: number; title: string; website_id: string; source: string }>>`
          SELECT e.id, e.type::text AS type, e.created_at, i.id AS incident_id, i.number, i.title, i.website_id, i.source::text AS source
            FROM incident_events e JOIN incidents i ON i.id = e.incident_id
           WHERE e.org_id = ${o.orgId}::uuid AND e.type IN ('CREATED', 'REOPENED', 'RESOLVED', 'AUTO_RESOLVED', 'ACKNOWLEDGED')
             AND (${w}::uuid IS NULL OR i.website_id = ${w}::uuid) AND (${srcs}::text[] IS NULL OR i.source::text = ANY(${srcs}::text[]))
             AND e.created_at >= ${from} AND (e.created_at, ('i:' || e.id::text) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
           ORDER BY e.created_at DESC, e.id DESC LIMIT ${lim}`;
        const verb: Record<string, string> = { CREATED: "opened", REOPENED: "reopened", RESOLVED: "resolved", AUTO_RESOLVED: "recovered", ACKNOWLEDGED: "acknowledged" };
        for (const x of r) rows.push({ key: `i:${x.id}`, id: `i:${x.id}`, at: x.created_at.toISOString(), type: "INCIDENT", source: SOURCE_API[x.source] ?? x.source, websiteId: x.website_id, websiteName: names.get(x.website_id) ?? null,
          title: `INC-${x.number} ${verb[x.type] ?? x.type.toLowerCase()}: ${x.title}`, result: x.type, link: `/incidents/${x.incident_id}` });
      }
      if ((want("CONFIG") || want("VERIFICATION")) && !q.result && !q.source) {
        // Only monitoring and verification actions; actor identity and request metadata are not exposed here.
        const pattern = q.type === "CONFIG" ? "^website\\.(http_check|browser_check|deep_scan|monitoring|performance)" : q.type === "VERIFICATION" ? "^website\\.(verified|verification|ownership)" : "^website\\.(http_check|browser_check|deep_scan|monitoring|performance|verified|verification|ownership)";
        const r = await tx.$queryRaw<Array<{ id: string; action: string; occurred_at: Date; target_id: string | null }>>`
          SELECT id::text AS id, action, occurred_at, target_id FROM audit_logs
           WHERE org_id = ${o.orgId}::uuid AND action ~ ${pattern} AND (${w}::text IS NULL OR target_id = ${w}::text)
             AND occurred_at >= ${from} AND (occurred_at, ('a:' || id::text) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
           ORDER BY occurred_at DESC, id DESC LIMIT ${lim}`;
        for (const x of r) {
          const verification = /^website\.(verified|verification|ownership)/.test(x.action);
          rows.push({ key: `a:${x.id}`, id: `a:${x.id}`, at: x.occurred_at.toISOString(), type: verification ? "VERIFICATION" : "CONFIG", source: null, websiteId: x.target_id, websiteName: x.target_id ? names.get(x.target_id) ?? null : null,
            title: x.action.replace(/^website\./, "").replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()), result: null, link: x.target_id ? `/websites/${x.target_id}?tab=${verification ? "verification" : "monitoring-settings"}` : null });
        }
      }
      if (want("COMPONENT") && !q.result && (!q.source || q.source === "BROWSER")) {
        const r = await tx.$queryRaw<Array<{ id: bigint; created_at: Date; website_id: string; type: string; ctype: string; label: string | null; component_id: string }>>`
          SELECT e.id, e.created_at, e.website_id, e.type, c.type::text AS ctype, c.label, c.id AS component_id
            FROM component_events e JOIN page_components c ON c.id = e.page_component_id
           WHERE e.org_id = ${o.orgId}::uuid AND (${w}::uuid IS NULL OR e.website_id = ${w}::uuid)
             AND e.created_at >= ${from} AND (e.created_at, ('m:' || lpad(e.id::text, 20, '0')) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
           ORDER BY e.created_at DESC, e.id DESC LIMIT ${lim}`;
        for (const x of r) {
          const key = `m:${String(x.id).padStart(20, "0")}`;
          rows.push({ key, id: key, at: x.created_at.toISOString(), type: "COMPONENT", source: "BROWSER", websiteId: x.website_id, websiteName: names.get(x.website_id) ?? null,
            title: `Component ${x.type === "VISIBILITY" ? "visibility changed" : x.type.toLowerCase()}: ${x.ctype.toLowerCase().replace("_", " ")}${x.label ? ` "${x.label}"` : ""}`, result: x.type,
            link: `/websites/${x.website_id}?tab=components&component=${x.component_id}` });
        }
      }
      if ((want("FUNCTIONAL") || want("RESPONSIVE")) && (!q.source || q.source === "BROWSER") && (!q.result || q.result === "FAILED")) {
        // only failures are timeline events (passing tests are in the execution detail)
        if (want("FUNCTIONAL")) {
          const r = await tx.$queryRaw<Array<{ id: string; tested_at: Date; website_id: string; execution_id: string; test_kind: string; target: string | null; failure_reason: string | null }>>`
            SELECT id::text, tested_at, website_id, execution_id, test_kind, target, failure_reason FROM component_test_results
             WHERE org_id = ${o.orgId}::uuid AND status = 'FAILED' AND (${w}::uuid IS NULL OR website_id = ${w}::uuid)
               AND tested_at >= ${from} AND (tested_at, ('f:' || id::text) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
             ORDER BY tested_at DESC, id DESC LIMIT ${lim}`;
          for (const x of r) rows.push({ key: `f:${x.id}`, id: `f:${x.id}`, at: x.tested_at.toISOString(), type: "FUNCTIONAL", source: "BROWSER", websiteId: x.website_id, websiteName: names.get(x.website_id) ?? null,
            title: `Functional test failed: ${(x.test_kind ?? "").toLowerCase()} ${x.target ?? ""} (${x.failure_reason ?? "failed"})`, result: "FAILED", link: `/websites/${x.website_id}/browser/${x.execution_id}` });
        }
        if (want("RESPONSIVE")) {
          const r = await tx.$queryRaw<Array<{ id: string; tested_at: Date; website_id: string; execution_id: string; viewport: string; findings: { objective?: string[] } | null }>>`
            SELECT id::text, tested_at, website_id, execution_id, viewport, findings FROM responsive_test_results
             WHERE org_id = ${o.orgId}::uuid AND status = 'FAILED' AND (${w}::uuid IS NULL OR website_id = ${w}::uuid)
               AND tested_at >= ${from} AND (tested_at, ('r:' || id::text) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
             ORDER BY tested_at DESC, id DESC LIMIT ${lim}`;
          for (const x of r) rows.push({ key: `r:${x.id}`, id: `r:${x.id}`, at: x.tested_at.toISOString(), type: "RESPONSIVE", source: "BROWSER", websiteId: x.website_id, websiteName: names.get(x.website_id) ?? null,
            title: `Responsive problem at ${x.viewport}: ${(x.findings?.objective ?? []).join("; ") || "layout failed"}`, result: "FAILED", link: `/websites/${x.website_id}/browser/${x.execution_id}` });
        }
      }
      if (want("INTERRUPTION") && !q.result && (!q.source || q.source === "HTTP")) {
        const r = await tx.$queryRaw<Array<{ id: bigint; created_at: Date; website_id: string | null }>>`
          SELECT id, created_at, payload->>'websiteId' AS website_id FROM outbox_events
           WHERE org_id = ${o.orgId}::uuid AND topic = 'monitoring.interrupted' AND (${w}::text IS NULL OR payload->>'websiteId' = ${w}::text)
             AND created_at >= ${from} AND (created_at, ('o:' || lpad(id::text, 20, '0')) COLLATE "C") < (${atMax}, ${idMax}::text COLLATE "C")
           ORDER BY created_at DESC, id DESC LIMIT ${lim}`;
        for (const x of r) {
          const key = `o:${String(x.id).padStart(20, "0")}`;
          rows.push({ key, id: key, at: x.created_at.toISOString(), type: "INTERRUPTION", source: "HTTP", websiteId: x.website_id, websiteName: x.website_id ? names.get(x.website_id) ?? null : null,
            title: "Monitoring interrupted (our infrastructure, not your website)", result: "INCONCLUSIVE", link: x.website_id ? `/websites/${x.website_id}?tab=availability` : null });
        }
      }
      rows.sort((a, b) => (a.at === b.at ? (a.key < b.key ? 1 : -1) : a.at < b.at ? 1 : -1));
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const ret = new Map((await tx.$queryRaw<Array<{ parent: string; days: number }>>`SELECT parent, days FROM result_retention_days()`).map((r) => [r.parent, r.days]));
      return {
        data: page.map(({ key: _k, ...r }) => r), nextCursor: rows.length > q.limit && last ? encodeCursor(new Date(last.at), last.key) : null,
        // events older than these are deleted by retention: an empty older range means "expired", not "nothing happened"
        retention: { checksDays: ret.get("check_results") ?? null, browserDays: ret.get("page_test_results") ?? null, incidentOccurrencesDays: ret.get("incident_occurrences") ?? null },
      };
    });
  }

  // ------------------------------------------------------------------ usage and plan limits
  async usage(s: SessionContext, o: OrgContext): Promise<MonitoringUsageDto> {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      const l = await this.limits(tx, o.orgId, st);
      const rows = await tx.$queryRaw<Array<{ key: string; today: bigint; d30: bigint }>>`
        SELECT key, sum(value) FILTER (WHERE period_start = (now() AT TIME ZONE 'UTC')::date) AS today, sum(value) AS d30
          FROM usage_counters WHERE org_id = ${o.orgId}::uuid AND period_start > (now() AT TIME ZONE 'UTC')::date - 30
           AND (key LIKE 'http.%' OR key LIKE 'browser.%' OR key LIKE 'deepscan.%') GROUP BY key ORDER BY key`;
      const usage = Object.fromEntries(rows.map((r) => [r.key, { today: n(r.today), last30Days: n(r.d30) }]));
      const sched = await tx.$queryRaw<Array<{ tier: string; n: bigint }>>`
        SELECT tier::text AS tier, count(*) AS n FROM monitoring_schedules WHERE org_id = ${o.orgId}::uuid AND api_endpoint_id IS NULL AND status = 'ACTIVE' GROUP BY 1`;
      const total = await tx.website.count({ where: { orgId: o.orgId, archivedAt: null } });
      const [art] = await tx.$queryRaw<Array<{ bytes: bigint | null; n: bigint }>>`
        SELECT sum(bytes) AS bytes, count(*) AS n FROM artifacts WHERE org_id = ${o.orgId}::uuid AND expires_at > now()`;
      const ret = new Map((await tx.$queryRaw<Array<{ parent: string; days: number }>>`SELECT parent, days FROM result_retention_days()`).map((r) => [r.parent, r.days]));
      const tierN = (t: string) => n(sched.find((x) => x.tier === t)?.n);
      const warnings: MonitoringUsageDto["warnings"] = [];
      const warn = (key: string, used: number, cap: number, label: string) => {
        if (cap <= 0) return;
        const pct = Math.round((used / cap) * 100);
        if (pct >= 80) warnings.push({ key, percent: pct, message: `${label}: ${used} of ${cap} used (${pct}%)` });
      };
      warn("websites", total, l.maxWebsites, "Websites");
      if (l.tiers.DEEPSCAN.enabled) warn("deepscan.pages", usage["deepscan.pages"]?.today ?? 0, l.deepscan.pagesPerDay, "Deep-scan pages today");
      if (l.tiers.BROWSER.enabled) {
        warn("browser.websites", tierN("T2_RENDER"), l.browser.maxWebsites, "Browser-monitored websites");
        warn("browser.screenshot_bytes", usage["browser.screenshot_bytes"]?.today ?? 0, st["monitoring.browser.screenshotBytesPerDay"], "Screenshot storage today (bytes)");
      }
      if (l.tiers.DEEPSCAN.enabled) warn("deepscan.websites", tierN("T3_DEEP"), l.deepscan.maxWebsites, "Deep-scanned websites");
      const today = new Date().toISOString().slice(0, 10);
      return {
        period: { today, last30DaysFrom: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), timezone: "UTC" },
        websites: { total, httpMonitored: tierN("T1_HTTP"), browserMonitored: tierN("T2_RENDER"), deepScanned: tierN("T3_DEEP") },
        limits: {
          maxWebsites: l.maxWebsites,
          http: { enabled: l.tiers.HTTP.enabled, minIntervalSec: l.tiers.HTTP.intervalSec },
          browser: { enabled: l.tiers.BROWSER.enabled, maxWebsites: l.browser.maxWebsites, minIntervalSec: l.tiers.BROWSER.intervalSec, screenshotBytesPerDay: st["monitoring.browser.screenshotBytesPerDay"], artifactRetentionDays: st["monitoring.browser.artifactRetentionDays"] },
          deepScan: { enabled: l.tiers.DEEPSCAN.enabled, maxWebsites: l.deepscan.maxWebsites, maxPages: l.deepscan.maxPages, pagesPerDay: l.deepscan.pagesPerDay, maxConcurrentScans: l.deepscan.maxConcurrentScans, retentionDays: l.deepscan.retentionDays },
          resultRetentionDays: { http: ret.get("check_results") ?? 0, browser: ret.get("page_test_results") ?? 0 },
        },
        usage, storage: { screenshotBytes: n(art?.bytes), screenshots: n(art?.n) }, warnings,
      };
    });
  }

  // ------------------------------------------------------------------ change feed (live updates by polling)
  /**
   * What changed for this organisation (and this user's notifications) since the cursor. Kinds only — the client
   * refetches through the normal, authorised endpoints. The query window overlaps the previous one by 30 s, so rows
   * committed late (long transactions) are never missed; duplicates are harmless invalidations.
   */
  async changes(s: SessionContext, o: OrgContext, since: string | undefined): Promise<ChangeFeedDto> {
    return this.member(s, o, async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      const sinceMs = since && /^\d{13}$/.test(since) ? Number(since) : now.getTime() - 60_000;
      const after = new Date(Math.max(sinceMs - 30_000, now.getTime() - 3_600_000));
      const inc = await tx.$queryRaw<Array<{ website_id: string; at: Date }>>`
        SELECT i.website_id, max(e.created_at) AS at FROM incident_events e JOIN incidents i ON i.id = e.incident_id
         WHERE e.org_id = ${o.orgId}::uuid AND e.created_at > ${after} GROUP BY 1`;
      const chk = await tx.$queryRaw<Array<{ website_id: string; at: Date }>>`
        SELECT website_id, max(recorded_at) AS at FROM execution_results WHERE org_id = ${o.orgId}::uuid AND recorded_at > ${after} GROUP BY 1`;
      const deep = await tx.$queryRaw<Array<{ website_id: string; at: Date }>>`
        SELECT website_id, max(updated_at) AS at FROM deep_scans WHERE org_id = ${o.orgId}::uuid AND updated_at > ${after} GROUP BY 1`;
      // execution state changes (queued → running → finished: checks, scans, verification-triggered work)
      const exec = await tx.$queryRaw<Array<{ website_id: string; at: Date }>>`
        SELECT website_id, max(greatest(queued_at, coalesce(started_at, queued_at), coalesce(finished_at, queued_at))) AS at
          FROM monitoring_executions
         WHERE org_id = ${o.orgId}::uuid AND queued_at > now() - interval '8 days'
           AND (queued_at > ${after} OR started_at > ${after} OR finished_at > ${after}) GROUP BY 1`;
      // website, ownership-verification and installation state
      const site = await tx.$queryRaw<Array<{ website_id: string; at: Date }>>`
        SELECT w.id AS website_id, greatest(w.updated_at, coalesce(c.updated_at, w.updated_at), coalesce(i.updated_at, w.updated_at)) AS at
          FROM websites w LEFT JOIN domain_claims c ON c.id = w.domain_claim_id LEFT JOIN site_installations i ON i.website_id = w.id
         WHERE w.org_id = ${o.orgId}::uuid AND (w.updated_at > ${after} OR c.updated_at > ${after} OR i.updated_at > ${after})`;
      const notes = await tx.$queryRaw<Array<{ at: Date | null; unread: bigint }>>`
        SELECT max(created_at) FILTER (WHERE created_at > ${after}) AS at, count(*) FILTER (WHERE read_at IS NULL) AS unread
          FROM notifications WHERE org_id = ${o.orgId}::uuid AND user_id = ${s.userId}::uuid`;
      const changes: ChangeFeedDto["changes"] = [
        ...inc.map((x) => ({ kind: "INCIDENT" as const, websiteId: x.website_id, at: x.at.toISOString() })),
        ...chk.map((x) => ({ kind: "CHECK" as const, websiteId: x.website_id, at: x.at.toISOString() })),
        ...deep.map((x) => ({ kind: "DEEP_SCAN" as const, websiteId: x.website_id, at: x.at.toISOString() })),
        ...exec.map((x) => ({ kind: "EXECUTION" as const, websiteId: x.website_id, at: x.at.toISOString() })),
        ...site.map((x) => ({ kind: "WEBSITE" as const, websiteId: x.website_id, at: x.at.toISOString() })),
        ...(notes[0]?.at ? [{ kind: "NOTIFICATION" as const, websiteId: null, at: notes[0].at.toISOString() }] : []),
      ];
      return { cursor: String(now.getTime()), changes, unreadNotifications: n(notes[0]?.unread) };
    });
  }
}

const id = (v: string) => parse(Uuid, v);

@Controller("api/v1/orgs/:orgId")
export class DashboardController {
  constructor(private readonly d: DashboardService) {}

  @Get("monitoring/overview")
  @RequirePermission("website:read")
  async overview(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Query() q: unknown) {
    return { data: await this.d.overview(s, o, parse(RangeQuery, q)) };
  }

  @Get("websites/:websiteId/monitoring/http/analytics")
  @RequirePermission("website:read")
  async analytics(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.d.httpAnalytics(s, o, id(w), parse(RangeQuery, q)) };
  }

  @Get("websites/:websiteId/monitoring/schedule")
  @RequirePermission("website:read")
  async scheduleRead(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.d.scheduleRead(s, o, id(w)) };
  }

  @Put("websites/:websiteId/monitoring/schedule")
  @RequirePermission("monitoring:write")
  async schedule(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.d.schedule(s, o, id(w), parse(ScheduleInput, body), c) };
  }

  @Post("incidents/:incidentId/acknowledge")
  @RequirePermission("incident:write")
  @HttpCode(200)
  async acknowledge(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("incidentId") i: string, @Client() c: ClientInfo) {
    return { data: await this.d.acknowledge(s, o, id(i), c) };
  }

  @Get("monitoring/history")
  @RequirePermission("website:read")
  async history(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Query() q: unknown) {
    return this.d.history(s, o, parse(HistoryQuery, q));
  }

  @Get("monitoring/usage")
  @RequirePermission("website:read")
  async usage(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.d.usage(s, o) };
  }

  @Get("changes")
  @RequirePermission("org:read")
  async changes(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Query("since") since?: string) {
    return { data: await this.d.changes(s, o, since) };
  }
}
