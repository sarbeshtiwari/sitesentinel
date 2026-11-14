import { Body, Controller, Get, Inject, Injectable, Param, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { describeHttpFailure, HttpCheckConfig, parseHttpCheckConfig, uptimeFrom } from "@wim/core";
import { withMember, type Db, type Tx } from "@wim/db";
import {
  HttpCheckConfigInput, HttpResultsQuery, IncidentListQuery, Uuid,
  type HttpCheckResultDto, type HttpMonitoringSummaryDto, type IncidentDetailDto, type IncidentSummaryDto, type UptimeDto,
} from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";

const ACTIVE = ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "REOPENED"];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Tenant-scoped HTTP monitoring and incident reads (Phase 4C). Every query runs inside
 * withMember (RLS on app.current_org_id), so other tenants' rows are invisible, not filtered.
 * All numbers come from persisted results; nothing is estimated or extrapolated.
 */
@Injectable()
export class MonitoringService {
  constructor(@Inject(APP_DB) private readonly db: Db, private readonly audit: AuditService) {}

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }

  private async website(tx: Tx, orgId: string, websiteId: string) {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: { id: true, status: true } });
    if (!w) throw Errors.notFound();
    return w;
  }

  async summary(s: SessionContext, o: OrgContext, websiteId: string): Promise<HttpMonitoringSummaryDto> {
    return this.member(s, o, async (tx) => {
      const w = await this.website(tx, o.orgId, websiteId);
      const latestRows = await tx.$queryRaw<ResultRow[]>`SELECT id, execution_id, checked_at, started_at, finished_at, attempt, status::text AS status, available, failure_kind, failure_category,
               method, url, final_url, http_status, redirect_chain, dns_ms, connect_ms, tls_ms, ttfb_ms, total_ms, bytes, content_type,
               response_headers, ssl_valid, ssl_expires_at, ssl_issuer, details FROM check_results WHERE website_id = ${websiteId}::uuid ORDER BY checked_at DESC, finished_at DESC NULLS LAST LIMIT 1`;
      const latest = latestRows[0] ? toDto(latestRows[0]) : null;
      const [last] = await tx.$queryRaw<Array<{ ok: Date | null; failed: Date | null }>>`
        SELECT max(finished_at) FILTER (WHERE available) AS ok, max(finished_at) FILTER (WHERE status = 'FAILED') AS failed
          FROM check_results WHERE website_id = ${websiteId}::uuid`;
      const uptime = async (hours: number): Promise<UptimeDto> => {
        const [r] = await tx.$queryRaw<Array<{ up: bigint; down: bigint }>>`
          SELECT count(*) FILTER (WHERE available) AS up, count(*) FILTER (WHERE available = false) AS down
            FROM check_results WHERE website_id = ${websiteId}::uuid AND checked_at > now() - make_interval(hours => ${hours})`;
        const [e] = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM monitoring_executions
           WHERE website_id = ${websiteId}::uuid AND tier = 'T1_HTTP' AND trigger = 'SCHEDULE' AND queued_at > now() - make_interval(hours => ${hours})`;
        return uptimeFrom({ up: Number(r!.up), down: Number(r!.down), scheduled: Number(e!.n) });
      };
      const [rt] = await tx.$queryRaw<Array<{ avg: number | null; p50: number | null; p95: number | null; n: bigint }>>`
        SELECT avg(total_ms)::float AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95, count(total_ms) AS n
          FROM check_results WHERE website_id = ${websiteId}::uuid AND available AND checked_at > now() - interval '24 hours'`;
      const [ssl] = await tx.$queryRaw<Array<{ ssl_expires_at: Date | null; ssl_issuer: string | null; ssl_valid: boolean | null; finished_at: Date | null }>>`
        SELECT ssl_expires_at, ssl_issuer, ssl_valid, finished_at FROM check_results
         WHERE website_id = ${websiteId}::uuid AND ssl_valid IS NOT NULL ORDER BY checked_at DESC LIMIT 1`;
      const incidents = await this.incidentRows(tx, o.orgId, { websiteId, status: "ACTIVE", limit: 20 });
      const cfgRow = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { httpCheck: true } });
      const sched = await tx.monitoringSchedule.findFirst({ where: { websiteId, tier: "T1_HTTP", apiEndpointId: null }, select: { status: true } });
      const open = new Set(incidents.map((i) => i.checkKey));
      const state: HttpMonitoringSummaryDto["state"] =
        w.status === "PAUSED" ? "PAUSED"
        : !sched || sched.status !== "ACTIVE" ? "NOT_MONITORED"
        : !latest ? "UNKNOWN"
        : open.has("http.down") || open.has("http.tls") ? "DOWN"
        : open.size || latest.outcome === "FAILED" ? "DEGRADED"
        : latest.outcome === "INCONCLUSIVE" ? "UNKNOWN" : "UP";
      return {
        state, latest, lastSuccessfulCheckAt: iso(last?.ok), lastFailedCheckAt: iso(last?.failed),
        uptime: { h24: await uptime(24), d7: await uptime(24 * 7), d30: await uptime(24 * 30) },
        responseTime24h: { avgMs: rt?.avg != null ? Math.round(rt.avg) : null, p50Ms: rt?.p50 != null ? Math.round(rt.p50) : null, p95Ms: rt?.p95 != null ? Math.round(rt.p95) : null, samples: Number(rt?.n ?? 0) },
        ssl: ssl ? {
          validTo: iso(ssl.ssl_expires_at), daysRemaining: ssl.ssl_expires_at ? Math.floor((ssl.ssl_expires_at.getTime() - Date.now()) / 86_400_000) : null,
          issuer: ssl.ssl_issuer, valid: ssl.ssl_valid, checkedAt: iso(ssl.finished_at),
        } : null,
        openIncidents: incidents,
        config: parseHttpCheckConfig(cfgRow?.httpCheck) as unknown as Record<string, unknown>,
        measurement: "SYNTHETIC_HTTP",
      };
    });
  }

  async results(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof HttpResultsQuery>): Promise<{ data: HttpCheckResultDto[]; nextBefore: string | null }> {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const before = q.before ? new Date(q.before) : new Date(Date.now() + 86_400_000);
      const rows = await tx.$queryRaw<ResultRow[]>`SELECT id, execution_id, checked_at, started_at, finished_at, attempt, status::text AS status, available, failure_kind, failure_category,
               method, url, final_url, http_status, redirect_chain, dns_ms, connect_ms, tls_ms, ttfb_ms, total_ms, bytes, content_type,
               response_headers, ssl_valid, ssl_expires_at, ssl_issuer, details FROM check_results
        WHERE website_id = ${websiteId}::uuid AND checked_at < ${before} AND (${q.outcome ?? null}::text IS NULL OR status::text = ${q.outcome ?? null})
          AND (${q.from ?? null}::timestamptz IS NULL OR checked_at >= ${q.from ?? null}::timestamptz)
        ORDER BY checked_at DESC LIMIT ${q.limit + 1}`;
      const page = rows.slice(0, q.limit).map(toDto);
      return { data: page, nextBefore: rows.length > q.limit ? page[page.length - 1]!.windowStart : null };
    });
  }

  async updateConfig(s: SessionContext, o: OrgContext, websiteId: string, input: z.infer<typeof HttpCheckConfigInput>, client: ClientInfo) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const current = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { httpCheck: true } });
      const merged: Record<string, unknown> = { ...(current?.httpCheck as Record<string, unknown> | null ?? {}) };
      for (const [k, v] of Object.entries(input)) {
        if (v === null) delete merged[k];
        else if (v !== undefined) merged[k] = v;
      }
      const parsed = HttpCheckConfig.safeParse(merged);
      if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invalid monitoring configuration", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      await tx.monitoringConfiguration.upsert({
        where: { websiteId },
        create: { orgId: o.orgId, websiteId, httpCheck: parsed.data as never },
        update: { httpCheck: parsed.data as never },
      });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.http_check_updated", targetType: "website", targetId: websiteId, changes: { fields: Object.keys(input) }, client }, tx);
      return parsed.data;
    });
  }

  /** Filtered, keyset-paginated incident list (newest activity first). */
  async incidentPage(s: SessionContext, o: OrgContext, q: z.infer<typeof IncidentListQuery>): Promise<{ data: IncidentSummaryDto[]; nextCursor: string | null }> {
    return this.member(s, o, async (tx) => {
      const rows = await this.incidentRows(tx, o.orgId, { ...q, limit: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { data: page, nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.lastDetectedAt}|${last.id}`).toString("base64url") : null };
    });
  }

  async incidents(s: SessionContext, o: OrgContext, q: { status: "ACTIVE" | "RESOLVED" | "ALL"; websiteId?: string; limit: number }) {
    return this.member(s, o, (tx) => this.incidentRows(tx, o.orgId, q));
  }

  async incident(s: SessionContext, o: OrgContext, id: string): Promise<IncidentDetailDto> {
    return this.member(s, o, async (tx) => {
      const [row] = await this.incidentRows(tx, o.orgId, { status: "ALL", limit: 1, id });
      if (!row) throw Errors.notFound();
      const inc = await tx.incident.findFirst({ where: { id, orgId: o.orgId }, select: { diagnostics: true } });
      const events = await tx.incidentEvent.findMany({ where: { incidentId: id, orgId: o.orgId }, orderBy: { createdAt: "asc" }, take: 200 });
      const occ = await tx.incidentOccurrence.findMany({ where: { incidentId: id, orgId: o.orgId }, orderBy: { occurredAt: "desc" }, take: 50 });
      return {
        ...row, diagnostics: (inc?.diagnostics ?? {}) as Record<string, unknown>,
        events: events.map((e) => ({ type: e.type, at: e.createdAt.toISOString(), fromStatus: e.fromStatus, toStatus: e.toStatus, data: (e.data ?? null) as Record<string, unknown> | null })),
        occurrences: occ.map((x) => ({
          at: x.occurredAt.toISOString(), executionId: x.executionId, url: x.pageUrl, details: x.details as Record<string, unknown>,
          link: x.executionId ? (row.checkKey.startsWith("browser.") ? `/websites/${row.websiteId}/browser/${x.executionId}`
            : row.checkKey.startsWith("deepscan.") ? `/websites/${row.websiteId}/deep-scan/scans/${x.executionId}` : `/websites/${row.websiteId}?tab=availability`) : null,
        })),
        notifications: (await tx.$queryRaw<Array<{ topic: string; channel: string; status: string; n: bigint; last: Date | null }>>`
          SELECT e.topic, d.channel::text AS channel, d.status::text AS status, count(*) AS n, max(coalesce(d.sent_at, d.created_at)) AS last
            FROM outbox_events e JOIN notification_delivery_logs d ON d.idempotency_key = 'outbox.' || e.id::text AND d.org_id = e.org_id
           WHERE e.org_id = ${o.orgId}::uuid AND e.payload->>'incidentId' = ${id} GROUP BY 1, 2, 3 ORDER BY 5`).map((r) => ({
          event: r.topic === "incident.opened" ? "Incident opened" : r.topic === "incident.resolved" ? "Recovered" : r.topic, channel: r.channel, status: r.status, count: Number(r.n), lastAt: iso(r.last),
        })),
        notifiedMe: (await tx.notification.count({ where: { orgId: o.orgId, userId: s.userId, incidentId: id } })) > 0,
      };
    });
  }

  private async incidentRows(tx: Tx, orgId: string, q: Partial<z.infer<typeof IncidentListQuery>> & { status: string; limit: number; id?: string }): Promise<IncidentSummaryDto[]> {
    let cursor: { at: Date; id: string } | null = null;
    if (q.cursor) {
      const [at, cid] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
      const d = new Date(at ?? "");
      if (Number.isNaN(d.getTime()) || !cid || !/^[0-9a-f-]{36}$/.test(cid)) throw new AppError(400, "VALIDATION_FAILED", "Invalid cursor");
      cursor = { at: d, id: cid };
    }
    const status = q.status === "ACTIVE" ? { in: ACTIVE as never } : q.status === "ALL" ? undefined : q.status;
    const sources = q.source === "HTTP" ? ["HTTP_PROBE", "SSL"] : q.source ? [q.source] : undefined;
    const rows = await tx.incident.findMany({
      where: {
        orgId, ...(q.websiteId ? { websiteId: q.websiteId } : {}), ...(q.id ? { id: q.id } : {}),
        ...(status ? { status: status as never } : {}), ...(q.severity ? { severity: q.severity } : {}),
        ...(sources ? { source: { in: sources as never } } : {}),
        // range: incidents active at any point inside [from, to)
        ...(q.to ? { firstDetectedAt: { lt: new Date(q.to) } } : {}),
        ...(q.from ? { OR: [{ resolvedAt: null }, { resolvedAt: { gte: new Date(q.from) } }] } : {}),
        ...(cursor ? { AND: [{ OR: [{ lastDetectedAt: { lt: cursor.at } }, { lastDetectedAt: cursor.at, id: { lt: cursor.id } }] }] } : {}),
      },
      orderBy: [{ lastDetectedAt: "desc" }, { id: "desc" }], take: q.limit,
      include: { website: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id, number: r.number, websiteId: r.websiteId, websiteName: r.website?.name, source: SOURCE_API[r.source] ?? r.source, title: r.title, description: r.description, category: r.category, severity: r.severity,
      status: r.status, checkKey: r.checkKey, occurrenceCount: r.occurrenceCount, firstDetectedAt: r.firstDetectedAt.toISOString(),
      lastDetectedAt: r.lastDetectedAt.toISOString(), resolvedAt: iso(r.resolvedAt), acknowledgedAt: iso(r.acknowledgedAt), autoResolved: r.autoResolved,
      reopenCount: r.reopenCount, updatedAt: r.updatedAt.toISOString(),
      durationSec: Math.round(((r.resolvedAt ?? new Date()).getTime() - r.firstDetectedAt.getTime()) / 1000),
    }));
  }
}

const SOURCE_API: Record<string, string> = { HTTP_PROBE: "HTTP", SSL: "HTTP", BROWSER: "BROWSER", DEEP_SCAN: "DEEP_SCAN" };

interface ResultRow {
  id: string; execution_id: string; checked_at: Date; started_at: Date | null; finished_at: Date | null; attempt: number | null; status: string;
  available: boolean | null; failure_kind: string | null; failure_category: string | null; method: string | null; url: string; final_url: string | null;
  http_status: number | null; redirect_chain: unknown; dns_ms: number | null; connect_ms: number | null; tls_ms: number | null; ttfb_ms: number | null;
  total_ms: number | null; bytes: number | null; content_type: string | null; response_headers: unknown; ssl_valid: boolean | null;
  ssl_expires_at: Date | null; ssl_issuer: string | null; details: { tls?: { error?: string | null; hostnameMatch?: boolean | null } } | null;
}


function toDto(r: ResultRow): HttpCheckResultDto {
  return {
    id: r.id, executionId: r.execution_id, windowStart: r.checked_at.toISOString(), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
    attempt: r.attempt, outcome: r.status as HttpCheckResultDto["outcome"], available: r.available, failureKind: r.failure_kind,
    failureCategory: r.failure_category, failureDescription: r.failure_kind ? describeHttpFailure(r.failure_kind) : null, method: r.method, url: r.url,
    finalUrl: r.final_url, httpStatus: r.http_status, redirects: (Array.isArray(r.redirect_chain) ? r.redirect_chain : []) as HttpCheckResultDto["redirects"],
    timings: { dnsMs: r.dns_ms, connectMs: r.connect_ms, tlsMs: r.tls_ms, ttfbMs: r.ttfb_ms, totalMs: r.total_ms }, bytes: r.bytes, contentType: r.content_type,
    headers: (r.response_headers ?? {}) as Record<string, string>,
    tls: r.ssl_valid === null && !r.details?.tls ? null : {
      valid: r.ssl_valid, validTo: iso(r.ssl_expires_at), daysRemaining: r.ssl_expires_at ? Math.floor((r.ssl_expires_at.getTime() - Date.now()) / 86_400_000) : null,
      issuer: r.ssl_issuer, error: r.details?.tls?.error ?? null, hostnameMatch: r.details?.tls?.hostnameMatch ?? null,
    },
  };
}

const id = (v: string) => parse(Uuid, v);

@Controller("api/v1/orgs/:orgId")
export class MonitoringController {
  constructor(private readonly m: MonitoringService) {}

  @Get("websites/:websiteId/monitoring/http")
  @RequirePermission("website:read")
  async summary(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.m.summary(s, o, id(w)) };
  }

  @Get("websites/:websiteId/monitoring/http/results")
  @RequirePermission("website:read")
  async results(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return this.m.results(s, o, id(w), parse(HttpResultsQuery, q));
  }

  @Put("websites/:websiteId/monitoring/http/config")
  @RequirePermission("monitoring:write")
  async config(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.m.updateConfig(s, o, id(w), parse(HttpCheckConfigInput, body), c) };
  }

  @Get("incidents")
  @RequirePermission("incident:read")
  async incidents(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Query() q: unknown) {
    return this.m.incidentPage(s, o, parse(IncidentListQuery, q));
  }

  @Get("incidents/:incidentId")
  @RequirePermission("incident:read")
  async incident(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("incidentId") i: string) {
    return { data: await this.m.incident(s, o, id(i)) };
  }
}
