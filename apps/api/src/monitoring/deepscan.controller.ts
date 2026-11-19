import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query } from "@nestjs/common";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { DeepScanConfig, effectiveScanLimits, FINDINGS, parseDeepScanConfig, type FindingCategory, type SettingsSnapshot } from "@wim/core";
import { withMember, type Db, type Tx } from "@wim/db";
import { jobOptions, loadOrgContexts, policyFor, QUEUES } from "@wim/queue";
import { Uuid } from "@wim/contracts";
import { APP_DB, REDIS } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const num = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * Tenant-scoped deep-scan API (Phase 4E). Reads run under RLS (withMember); customers can't write scans, findings,
 * executions or usage — they can only change their own configuration and ask (through a SECURITY DEFINER function
 * that re-checks membership, eligibility and cooldown in the database) for a scan to start, or cancel one.
 */
@Injectable()
export class DeepScanService {
  private readonly queue: Queue;
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) redis: Redis,
    @Inject(ENV) env: Env,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {
    this.queue = new Queue(QUEUES.deepscan, { connection: redis, prefix: env.QUEUE_PREFIX });
  }

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }
  private async website(tx: Tx, orgId: string, websiteId: string) {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: { id: true, canonicalOrigin: true } });
    if (!w) throw Errors.notFound();
    return w;
  }
  private async limitsFor(tx: Tx, orgId: string, s: SettingsSnapshot) {
    // entitlement tables are readable to the API role only for its own org (RLS); plans are platform data
    return (await loadOrgContexts(tx, [orgId], s)).get(orgId)!.limits;
  }

  async summary(s: SessionContext, o: OrgContext, websiteId: string) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const cfgRow = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { deepScan: true, maxPages: true, maxDepth: true } });
      const cfg = parseDeepScanConfig(cfgRow?.deepScan);
      const limits = await this.limitsFor(tx, o.orgId, st);
      const sched = await tx.monitoringSchedule.findFirst({ where: { websiteId, tier: "T3_DEEP", apiEndpointId: null }, select: { status: true, pausedReason: true, intervalSec: true, nextRunAt: true } });
      const latest = await tx.deepScan.findFirst({ where: { websiteId }, orderBy: { startedAt: "desc" } });
      const open = await tx.$queryRaw<Array<{ group_key: string; severity: string; n: bigint }>>`
        SELECT group_key, severity, count(*) AS n FROM scan_findings WHERE website_id = ${websiteId}::uuid AND status = 'OPEN' GROUP BY 1, 2`;
      const [{ sitemapBroken }] = await tx.$queryRaw<Array<{ sitemapBroken: number }>>`
        SELECT count(*)::int AS "sitemapBroken" FROM scan_findings WHERE website_id = ${websiteId}::uuid AND status = 'OPEN' AND category = 'SITEMAP_URL_BROKEN'`;
      // A requested/scheduled scan exists only as an execution until the scanner picks it up (then it gets a scan row).
      const [pending] = await tx.$queryRaw<Array<{ id: string; status: string; queued_at: Date }>>`
        SELECT e.id, e.status::text AS status, e.queued_at FROM monitoring_executions e
         WHERE e.website_id = ${websiteId}::uuid AND e.tier = 'T3_DEEP' AND e.status IN ('SCHEDULED', 'QUEUED', 'RETRYING', 'RUNNING')
           AND e.queued_at > now() - interval '8 days'
           AND NOT EXISTS (SELECT 1 FROM deep_scans d WHERE d.execution_id = e.id)
         ORDER BY e.queued_at DESC LIMIT 1`;
      // The customer's pause/resume takes effect at once here; the scheduler syncs the schedule on its next cycle.
      const customerPaused = cfg.paused;
      const scheduleActive = sched?.status === "ACTIVE";
      const resuming = !customerPaused && !scheduleActive && sched?.pausedReason === "DISABLED_BY_CUSTOMER";
      return {
        entitled: limits.tiers.DEEPSCAN.enabled,
        enabled: !customerPaused && scheduleActive,
        pausedReason: customerPaused ? "DISABLED_BY_CUSTOMER" : sched && !scheduleActive && !resuming ? sched.pausedReason : null,
        resuming,
        pending: pending ? { executionId: pending.id, status: pending.status, queuedAt: pending.queued_at.toISOString() } : null,
        intervalSec: sched?.intervalSec ?? null,
        nextRunAt: !customerPaused && scheduleActive ? iso(sched!.nextRunAt) : null,
        config: cfg,
        effectiveLimits: effectiveScanLimits(limits.deepscan, cfg, { maxPages: cfgRow?.maxPages, maxDepth: cfgRow?.maxDepth }),
        latestScan: latest ? this.scanDto(latest) : null,
        openFindings: open.map((r) => ({ group: r.group_key, severity: r.severity, count: Number(r.n) })),
        /** broken URLs listed only in the sitemap (group "sitemap"), shown with broken pages */
        openSitemapBroken: sitemapBroken,
        measurement: "AUTOMATED_CHECKS",
      };
    });
  }

  async updateConfig(s: SessionContext, o: OrgContext, websiteId: string, body: unknown, client: ClientInfo) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const current = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { deepScan: true } });
      const patch = z.record(z.string(), z.unknown()).parse(body ?? {});
      const merged: Record<string, unknown> = { ...((current?.deepScan as Record<string, unknown> | null) ?? {}) };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete merged[k]; else merged[k] = v; }
      const parsed = DeepScanConfig.safeParse(merged);
      if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invalid deep-scan configuration", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      // additional hosts must be separately verified, active websites of this organisation
      if (parsed.data.additionalHosts.length) {
        const ok = await tx.$queryRaw<Array<{ host: string }>>`
          SELECT lower(split_part(split_part(w.canonical_origin, '://', 2), '/', 1)) AS host FROM websites w JOIN domain_claims c ON c.id = w.domain_claim_id
           WHERE w.org_id = ${o.orgId}::uuid AND w.status = 'ACTIVE' AND w.archived_at IS NULL AND c.status = 'VERIFIED'`;
        const allowed = new Set(ok.map((x) => x.host));
        const bad = parsed.data.additionalHosts.filter((h) => !allowed.has(h));
        if (bad.length) throw new AppError(400, "VALIDATION_FAILED", "Additional hosts must be verified websites of this organisation", { hosts: bad });
      }
      await tx.monitoringConfiguration.upsert({ where: { websiteId }, create: { orgId: o.orgId, websiteId, deepScan: parsed.data as never }, update: { deepScan: parsed.data as never } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.deep_scan_config_updated", targetType: "website", targetId: websiteId, changes: { fields: Object.keys(patch) }, client }, tx);
      return parsed.data;
    });
  }

  async start(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    const st = await this.settings.get();
    const r = await this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const [row] = await tx.$queryRaw<Array<{ result: string; execution_id: string | null; queued_at: Date | null }>>`SELECT * FROM request_deep_scan(${websiteId}::uuid, ${st["monitoring.deepscan.manualCooldownSec"]})`;
      if (row!.result === "SCHEDULED") await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.deep_scan_started", targetType: "website", targetId: websiteId, changes: { executionId: row!.execution_id }, client }, tx);
      return row!;
    });
    if (r.result === "NOT_FOUND") throw Errors.notFound();
    if (r.result === "ALREADY_RUNNING") throw Errors.conflict("A deep scan of this website is already queued or running");
    if (r.result === "COOLDOWN") {
      const until = r.queued_at ?? new Date(Date.now() + st["monitoring.deepscan.manualCooldownSec"] * 1000);
      const sec = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
      throw Errors.rateLimited(sec, `A deep scan ran recently. You can start another in ${sec >= 90 ? `${Math.ceil(sec / 60)} minutes` : `${sec} seconds`}.`);
    }
    if (r.result.startsWith("NOT_ELIGIBLE")) throw Errors.conflict(`Deep scanning isn't available for this website (${r.result.split(":")[1]})`);
    // Enqueue now; if Redis is unavailable the scheduler's reconcile enqueues the committed execution.
    await this.queue.add("EXECUTE", { v: 1, executionId: r.execution_id!, windowStart: r.queued_at!.toISOString() }, jobOptions(r.execution_id!, policyFor(st, QUEUES.deepscan))).catch(() => undefined);
    return { executionId: r.execution_id, status: "SCHEDULED" };
  }

  async setPaused(s: SessionContext, o: OrgContext, websiteId: string, paused: boolean, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const current = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { deepScan: true } });
      const next = DeepScanConfig.parse({ ...((current?.deepScan as Record<string, unknown> | null) ?? {}), paused });
      await tx.monitoringConfiguration.upsert({ where: { websiteId }, create: { orgId: o.orgId, websiteId, deepScan: next as never }, update: { deepScan: next as never } });
      if (paused) {
        // stop the running/queued scan; partial results are kept, nothing is resolved
        const running = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM monitoring_executions WHERE website_id = ${websiteId}::uuid AND tier = 'T3_DEEP' AND status IN ('SCHEDULED', 'QUEUED', 'RUNNING', 'RETRYING') AND queued_at > now() - interval '8 days'`;
        for (const e of running) await tx.$queryRaw`SELECT request_execution_cancel(${e.id}::uuid)`;
      }
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: paused ? "website.deep_scan_paused" : "website.deep_scan_resumed", targetType: "website", targetId: websiteId, changes: {}, client }, tx);
    });
    return this.summary(s, o, websiteId);
  }

  async cancel(s: SessionContext, o: OrgContext, websiteId: string, executionId: string, client: ClientInfo) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const [own] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM monitoring_executions WHERE id = ${executionId}::uuid AND website_id = ${websiteId}::uuid AND tier = 'T3_DEEP' AND queued_at > now() - interval '8 days'`;
      if (!own) throw Errors.notFound();
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT request_execution_cancel(${executionId}::uuid) AS r`;
      if (r === "NOT_CANCELLABLE") throw Errors.conflict("This scan has already finished");
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.deep_scan_cancelled", targetType: "website", targetId: websiteId, changes: { executionId }, client }, tx);
      return { status: r };
    });
  }

  private scanDto(x: { executionId: string; trigger: string; status: string; complete: boolean; stopReason: string | null; pagesDiscovered: number; pagesCompleted: number; pagesFailed: number; pagesSkipped: number; pagesDropped: number; pagesInconclusive: number; resourcesChecked: number; requests: number; bytes: bigint; browserMs: number; findingsOpened: number; findingsResolved: number; startedAt: Date; finishedAt: Date | null; baselineExecutionId: string | null }) {
    return {
      executionId: x.executionId, trigger: x.trigger, status: x.status, complete: x.complete, stopReason: x.stopReason,
      coverage: { pagesDiscovered: x.pagesDiscovered, pagesChecked: x.pagesCompleted + x.pagesFailed, pagesFailed: x.pagesFailed, pagesSkippedByPolicy: x.pagesSkipped, pagesNotCrawledLimits: x.pagesDropped, pagesInconclusive: x.pagesInconclusive, resourcesChecked: x.resourcesChecked },
      requests: x.requests, bytes: Number(x.bytes), browserMs: x.browserMs, findingsOpened: x.findingsOpened, findingsResolved: x.findingsResolved,
      startedAt: x.startedAt.toISOString(), finishedAt: iso(x.finishedAt), baselineExecutionId: x.baselineExecutionId,
    };
  }

  async scans(s: SessionContext, o: OrgContext, websiteId: string, limit: number) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      return (await tx.deepScan.findMany({ where: { websiteId }, orderBy: { startedAt: "desc" }, take: limit })).map((x) => this.scanDto(x));
    });
  }

  async scan(s: SessionContext, o: OrgContext, websiteId: string, executionId: string) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const x = await tx.deepScan.findFirst({ where: { executionId, websiteId } });
      if (!x) throw Errors.notFound();
      const d = (x.discovery ?? {}) as { sitemaps?: unknown; issues?: unknown[]; spa?: unknown; robots?: Record<string, unknown> };
      return {
        ...this.scanDto(x),
        discovery: { sitemaps: d.sitemaps ?? null, sitemapIssues: (d.issues ?? []).length, robotsFound: Object.fromEntries(Object.entries(d.robots ?? {}).map(([h, r]) => [h, r !== null])), spa: d.spa ?? [] },
        comparison: x.comparison ?? null,
      };
    });
  }

  /**
   * Compare two scans of this website, page by page, from their stored frontier rows. Unlike the comparison stored
   * at finalisation (always against the previous COMPLETED scan) any two scans can be chosen; a page missing from an
   * incomplete scan is "not observed", never "removed".
   */
  async compare(s: SessionContext, o: OrgContext, websiteId: string, executionId: string, baseId: string) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const scans = await tx.deepScan.findMany({ where: { websiteId, executionId: { in: [executionId, baseId] } }, select: { executionId: true, status: true, complete: true, startedAt: true } });
      const cur = scans.find((x) => x.executionId === executionId), base = scans.find((x) => x.executionId === baseId);
      if (!cur || !base || executionId === baseId) throw Errors.notFound();
      const rows = await tx.$queryRaw<Array<{ execution_id: string; url: string; state: string; status_code: number | null; title: string | null }>>`
        SELECT execution_id, url, state, status_code, facts ->> 'title' AS title FROM deep_scan_urls
         WHERE website_id = ${websiteId}::uuid AND kind = 'PAGE' AND execution_id = ANY(${[executionId, baseId]}::uuid[])`;
      const a = new Map(rows.filter((r) => r.execution_id === baseId).map((r) => [r.url, r]));
      const b = new Map(rows.filter((r) => r.execution_id === executionId).map((r) => [r.url, r]));
      const checked = (r?: { state: string }) => r && (r.state === "DONE" || r.state === "FAILED");
      const cap = (x: string[]) => ({ count: x.length, items: x.slice(0, 100) });
      const added: string[] = [], removed: string[] = [], notObserved: string[] = [], status: string[] = [], newBroken: string[] = [], recovered: string[] = [], titles: string[] = [];
      for (const [u, r] of b) if (checked(r) && !a.has(u)) added.push(u);
      for (const [u, r] of a) {
        if (!checked(r)) continue;
        const n = b.get(u);
        if (!checked(n)) { (cur.complete && !n ? removed : notObserved).push(u); continue; }
        if (r.status_code !== n!.status_code) status.push(`${u} (${r.status_code ?? "—"} → ${n!.status_code ?? "—"})`);
        if (r.state !== "FAILED" && n!.state === "FAILED") newBroken.push(u);
        if (r.state === "FAILED" && n!.state !== "FAILED") recovered.push(u);
        if ((r.title ?? null) !== (n!.title ?? null)) titles.push(u);
      }
      return {
        base: { executionId: baseId, status: base.status, complete: base.complete, startedAt: base.startedAt.toISOString() },
        current: { executionId, status: cur.status, complete: cur.complete, startedAt: cur.startedAt.toISOString() },
        newPages: cap(added), removedPages: cap(removed), notObservedThisScan: cap(notObserved), statusChanged: cap(status),
        newBrokenPages: cap(newBroken), recoveredPages: cap(recovered), titleChanged: cap(titles),
        reliable: base.status === "COMPLETED" && cur.status === "COMPLETED",
      };
    });
  }

  async pages(s: SessionContext, o: OrgContext, websiteId: string, executionId: string, q: { state?: string; kind: string; limit: number; after?: number }) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT id, url, kind, resource_type, state, skip_reason, depth, source, in_sitemap, referrers, first_referrer, status_code, final_url, redirect_chain,
               content_type, bytes, duration_ms, error, checked_at, facts ->> 'title' AS title, facts ->> 'canonical' AS canonical
          FROM deep_scan_urls WHERE execution_id = ${executionId}::uuid AND website_id = ${websiteId}::uuid AND kind = ${q.kind}
           AND (${q.state ?? null}::text IS NULL OR state = ${q.state ?? null}) AND id > ${q.after ?? 0}
         ORDER BY id LIMIT ${q.limit + 1}`;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({
          url: r.url, kind: r.kind, resourceType: r.resource_type, state: r.state, skipReason: r.skip_reason, depth: r.depth, source: r.source, inSitemap: r.in_sitemap,
          linkCount: r.referrers, linkedFrom: r.first_referrer, status: r.status_code, finalUrl: r.final_url, redirectChain: r.redirect_chain ?? [],
          contentType: r.content_type, bytes: r.bytes, durationMs: r.duration_ms, error: r.error, title: r.title, canonical: r.canonical, checkedAt: iso(r.checked_at),
        })),
        nextAfter: rows.length > q.limit ? Number(page[page.length - 1]!.id) : null,
      };
    });
  }

  async findings(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof FindingsQuery>) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.scanFinding.findMany({
        where: {
          websiteId, ...(q.status === "ALL" ? {} : { status: q.status }), ...(q.group ? { groupKey: q.group } : {}), ...(q.severity ? { severity: q.severity } : {}),
          ...(q.category ? { category: q.category } : {}), ...(q.url ? { subject: { contains: q.url, mode: "insensitive" as const } } : {}),
          ...(q.firstDetectedFrom ? { firstDetectedAt: { gte: new Date(q.firstDetectedFrom) } } : {}),
          ...(q.lastDetectedFrom ? { lastDetectedAt: { gte: new Date(q.lastDetectedFrom) } } : {}),
        },
        orderBy: [{ status: "asc" }, { lastDetectedAt: "desc" }], take: q.limit,
      });
      return rows.map((f) => this.findingDto(f));
    });
  }

  private findingDto(f: { id: string; category: string; groupKey: string; severity: string; status: string; subject: string; title: string; evidence: unknown; recommendation: string; detectionMethod: string; confirmed: boolean; occurrenceCount: number; reopenCount: number; firstDetectedAt: Date; lastDetectedAt: Date; resolvedAt: Date | null; lastExecutionId: string }) {
    return {
      id: f.id, category: f.category, group: f.groupKey, severity: f.severity, status: f.status, subject: f.subject, title: f.title, evidence: f.evidence,
      impact: (FINDINGS as Record<string, { impact: string }>)[f.category as FindingCategory]?.impact ?? null, recommendation: f.recommendation, detectionMethod: f.detectionMethod,
      confirmed: f.confirmed, automated: true, occurrenceCount: f.occurrenceCount, reopenCount: f.reopenCount,
      firstDetectedAt: f.firstDetectedAt.toISOString(), lastDetectedAt: f.lastDetectedAt.toISOString(), resolvedAt: iso(f.resolvedAt), lastExecutionId: f.lastExecutionId,
    };
  }

  async finding(s: SessionContext, o: OrgContext, websiteId: string, findingId: string) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const f = await tx.scanFinding.findFirst({ where: { id: findingId, websiteId } });
      if (!f) throw Errors.notFound();
      const events = await tx.scanFindingEvent.findMany({ where: { findingId }, orderBy: { createdAt: "asc" }, take: 500 });
      return { ...this.findingDto(f), history: events.map((e) => ({ type: e.type, executionId: e.executionId, at: e.createdAt.toISOString() })) };
    });
  }

  async usage(s: SessionContext, o: OrgContext) {
    const st = await this.settings.get();
    return this.member(s, o, async (tx) => {
      const limits = await this.limitsFor(tx, o.orgId, st);
      const rows = await tx.$queryRaw<Array<{ key: string; today: bigint; d30: bigint }>>`
        SELECT key, sum(value) FILTER (WHERE period_start = (now() AT TIME ZONE 'UTC')::date) AS today, sum(value) AS d30
          FROM usage_counters WHERE org_id = ${o.orgId}::uuid AND key LIKE 'deepscan.%' AND period_start > (now() AT TIME ZONE 'UTC')::date - 30 GROUP BY key`;
      const u = Object.fromEntries(rows.map((r) => [r.key.replace("deepscan.", ""), { today: num(r.today), last30Days: num(r.d30) }]));
      return {
        entitled: limits.deepscan.entitled, limits: limits.deepscan,
        quota: { pagesPerDay: limits.deepscan.pagesPerDay, pagesUsedToday: u.pages?.today ?? 0 },
        usage: u,
      };
    });
  }
}

const id = (v: string) => parse(Uuid, v);
const FindingsQuery = z.object({
  status: z.enum(["OPEN", "RESOLVED", "ALL"]).default("OPEN"),
  group: z.enum(["broken_pages", "broken_resources", "forms", "sitemap", "seo", "accessibility", "structure"]).optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  category: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
  /** substring of the subject URL (case-insensitive) */
  url: z.string().min(1).max(200).optional(),
  firstDetectedFrom: z.iso.datetime().optional(),
  lastDetectedFrom: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
const CompareQuery = z.object({ base: z.uuid() }).strict();
const PagesQuery = z.object({
  state: z.enum(["QUEUED", "DONE", "FAILED", "SKIPPED", "INCONCLUSIVE"]).optional(),
  kind: z.enum(["PAGE", "RESOURCE", "EXTERNAL"]).default("PAGE"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: z.coerce.number().int().min(0).optional(),
}).strict();

@Controller("api/v1/orgs/:orgId")
export class DeepScanController {
  constructor(private readonly d: DeepScanService) {}

  @Get("websites/:websiteId/deep-scan")
  @RequirePermission("website:read")
  async summary(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.d.summary(s, o, id(w)) };
  }

  @Put("websites/:websiteId/deep-scan/config")
  @RequirePermission("monitoring:write")
  async config(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.d.updateConfig(s, o, id(w), body, c) };
  }

  @Post("websites/:websiteId/deep-scan/start")
  @RequirePermission("monitoring:write")
  @HttpCode(202)
  async start(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.d.start(s, o, id(w), c) };
  }

  @Post("websites/:websiteId/deep-scan/pause")
  @RequirePermission("monitoring:write")
  @HttpCode(200)
  async pause(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.d.setPaused(s, o, id(w), parse(z.object({ paused: z.boolean() }).strict(), body).paused, c) };
  }

  @Post("websites/:websiteId/deep-scan/scans/:executionId/cancel")
  @RequirePermission("monitoring:write")
  @HttpCode(200)
  async cancel(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string, @Client() c: ClientInfo) {
    return { data: await this.d.cancel(s, o, id(w), id(e), c) };
  }

  @Get("websites/:websiteId/deep-scan/scans")
  @RequirePermission("website:read")
  async scans(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.d.scans(s, o, id(w), parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict(), q).limit) };
  }

  @Get("websites/:websiteId/deep-scan/scans/:executionId")
  @RequirePermission("website:read")
  async scan(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string) {
    return { data: await this.d.scan(s, o, id(w), id(e)) };
  }

  @Get("websites/:websiteId/deep-scan/scans/:executionId/compare")
  @RequirePermission("website:read")
  async compare(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string, @Query() q: unknown) {
    return { data: await this.d.compare(s, o, id(w), id(e), parse(CompareQuery, q).base) };
  }

  @Get("websites/:websiteId/deep-scan/scans/:executionId/pages")
  @RequirePermission("website:read")
  async pages(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string, @Query() q: unknown) {
    return this.d.pages(s, o, id(w), id(e), parse(PagesQuery, q));
  }

  @Get("websites/:websiteId/deep-scan/findings")
  @RequirePermission("website:read")
  async findings(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.d.findings(s, o, id(w), parse(FindingsQuery, q)) };
  }

  @Get("websites/:websiteId/deep-scan/findings/:findingId")
  @RequirePermission("website:read")
  async finding(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("findingId") f: string) {
    return { data: await this.d.finding(s, o, id(w), id(f)) };
  }

  @Get("deep-scan/usage")
  @RequirePermission("website:read")
  async usage(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.d.usage(s, o) };
  }
}
