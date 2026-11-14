import { createHmac, timingSafeEqual } from "node:crypto";
import { Body, Controller, Get, Inject, Injectable, Param, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { BrowserCheckConfig, describeBrowserFailure, FUNCTIONAL_RISK_STATEMENT, FUNCTIONAL_RISK_VERSION, parseBrowserCheckConfig } from "@wim/core";
import { withMember, withTenant, type Db, type Tx } from "@wim/db";
import { createS3, type S3 } from "@wim/storage";
import {
  BrowserCheckConfigInput, BrowserResultsQuery, ComponentHistoryQuery, ComponentListQuery, Uuid,
  type ComponentDto, type ComponentEventDto,
  type ArtifactLinkDto, type BrowserCheckResultDto, type BrowserMonitoringSummaryDto, type BrowserViewportResultDto,
} from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { KeysService } from "../crypto/keys.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { AppError, Errors } from "../common/errors.js";
import { Client, CurrentOrg, CurrentSession, parse, Public, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";
import { SettingsService } from "../settings/settings.service.js";
import { MonitoringService } from "./monitoring.controller.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const LINK_TTL_SEC = 300;
const PROBLEM_KIND: Record<string, string> = {
  NAVIGATION: "^(HTTP_|NAVIGATION_|READINESS_|REDIRECT|TOO_MANY_REDIRECTS|DOWNLOAD_|BLOCKED_|TLS_|DNS_|NO_ADDRESSES|CONNECT)",
  RENDERING: "^(BLANK_PAGE|BROKEN_IMAGES_)", JAVASCRIPT: "^(UNCAUGHT_EXCEPTION|UNHANDLED_REJECTION|CONSOLE_ERROR)",
  NETWORK: "^(SCRIPT_FAILED|STYLESHEET_FAILED|DOCUMENT_FAILED)", LAYOUT: "^HORIZONTAL_OVERFLOW_", PERFORMANCE: "^(LCP_POOR|CLS_POOR)",
};

/**
 * Tenant-scoped browser monitoring reads (Phase 4D) and screenshot access. All queries run under RLS
 * (withMember). Screenshots: customers get a 5-minute HMAC-signed link bound to the artifact and the
 * organisation; the download endpoint re-checks the artifact under that organisation's RLS context and
 * streams it from private object storage. Admin endpoints never touch artifacts.
 */
@Injectable()
export class BrowserMonitoringService {
  private readonly s3: S3 | null;
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly keys: KeysService,
    private readonly audit: AuditService,
    private readonly monitoring: MonitoringService,
    private readonly settings: SettingsService,
  ) {
    this.s3 = env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? createS3({ endpoint: env.S3_ENDPOINT, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET_ARTIFACTS })
      : null;
  }

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }

  private async website(tx: Tx, orgId: string, websiteId: string) {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: { id: true, status: true } });
    if (!w) throw Errors.notFound();
    return w;
  }

  private async executions(tx: Tx, websiteId: string, opts: { before: Date; limit: number; from?: Date; outcome?: string; viewport?: string; problem?: string; executionId?: string }): Promise<BrowserCheckResultDto[]> {
    // problem category = the viewport's primary failure kind (the finer diagnostics are in the result JSON)
    const pattern = opts.problem ? PROBLEM_KIND[opts.problem] ?? null : null;
    const ledger = await tx.$queryRaw<Array<{ execution_id: string; window_start: Date; outcome: string; attempt: number; recorded_at: Date }>>`
      SELECT r.execution_id, r.window_start, r.outcome, r.attempt, r.recorded_at FROM execution_results r
       WHERE r.website_id = ${websiteId}::uuid AND r.tier = 'T2_RENDER' AND r.window_start < ${opts.before}
         AND (${opts.from ?? null}::timestamptz IS NULL OR r.window_start >= ${opts.from ?? null}::timestamptz)
         AND (${opts.outcome ?? null}::text IS NULL OR r.outcome = ${opts.outcome ?? null})
         AND (${opts.executionId ?? null}::uuid IS NULL OR r.execution_id = ${opts.executionId ?? null}::uuid)
         AND (${opts.viewport ?? null}::text IS NULL AND ${pattern}::text IS NULL OR EXISTS (
               SELECT 1 FROM page_test_results p WHERE p.website_id = r.website_id AND p.execution_id = r.execution_id
                  AND (${opts.viewport ?? null}::text IS NULL OR p.viewport = ${opts.viewport ?? null})
                  AND (${pattern}::text IS NULL OR p.failure_kind ~ ${pattern})))
       ORDER BY r.window_start DESC LIMIT ${opts.limit}`;
    if (!ledger.length) return [];
    const ids = ledger.map((l) => l.execution_id);
    const rows = await tx.$queryRaw<Array<Record<string, any>>>`
      SELECT execution_id, viewport, width, height, status::text AS status, failure_kind, navigation, rendering, scripts, network, details, artifact_ids
        FROM page_test_results WHERE website_id = ${websiteId}::uuid AND execution_id = ANY(${ids}::uuid[]) ORDER BY tested_at DESC, viewport`;
    const perf = await tx.$queryRaw<Array<Record<string, any>>>`
      SELECT execution_id, viewport, ttfb_ms, fcp_ms, lcp_ms, cls, tbt_ms, load_ms, request_count, transfer_bytes
        FROM performance_metrics WHERE website_id = ${websiteId}::uuid AND execution_id = ANY(${ids}::uuid[])`;
    const layout = await tx.$queryRaw<Array<Record<string, any>>>`
      SELECT execution_id, viewport, horizontal_overflow_px, offscreen_elements, findings
        FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND execution_id = ANY(${ids}::uuid[])`;
    const arts = await tx.artifact.findMany({ where: { websiteId, executionId: { in: ids } }, select: { id: true, executionId: true, viewport: true, purpose: true, bytes: true, expiresAt: true } });
    return ledger.map((l) => ({
      executionId: l.execution_id, windowStart: l.window_start.toISOString(), outcome: l.outcome as BrowserCheckResultDto["outcome"], attempt: l.attempt, recordedAt: l.recorded_at.toISOString(),
      viewports: rows.filter((r) => r.execution_id === l.execution_id).map((r): BrowserViewportResultDto => {
        const p = perf.find((x) => x.execution_id === l.execution_id && x.viewport === r.viewport);
        const lay = layout.find((x) => x.execution_id === l.execution_id && x.viewport === r.viewport);
        return {
          viewport: r.viewport, width: r.width, height: r.height, outcome: r.status, failureKind: r.failure_kind,
          failureDescription: r.failure_kind ? describeBrowserFailure(r.failure_kind) : null,
          navigation: r.navigation, rendering: r.rendering, scripts: r.scripts, network: r.network,
          layout: lay ? { horizontalOverflowPx: lay.horizontal_overflow_px, offscreenText: lay.offscreen_elements, findings: lay.findings } : null,
          syntheticPerformance: p ? { ttfbMs: p.ttfb_ms, fcpMs: p.fcp_ms, lcpMs: p.lcp_ms, cls: p.cls, tbtMs: p.tbt_ms, loadMs: p.load_ms, requests: p.request_count, transferBytes: p.transfer_bytes } : null,
          warnings: (r.details?.warnings ?? []) as string[],
          artifacts: arts.filter((a) => a.executionId === l.execution_id && a.viewport === r.viewport).map((a) => ({ id: a.id, purpose: a.purpose, bytes: a.bytes, expiresAt: a.expiresAt.toISOString() })),
        };
      }),
    }));
  }

  async summary(s: SessionContext, o: OrgContext, websiteId: string): Promise<BrowserMonitoringSummaryDto> {
    return this.member(s, o, async (tx) => {
      const w = await this.website(tx, o.orgId, websiteId);
      const [latest] = await this.executions(tx, websiteId, { before: new Date(Date.now() + 86_400_000), limit: 1 });
      const [last] = await tx.$queryRaw<Array<{ ok: Date | null; failed: Date | null }>>`
        SELECT max(recorded_at) FILTER (WHERE outcome = 'PASSED') AS ok, max(recorded_at) FILTER (WHERE outcome = 'FAILED') AS failed
          FROM execution_results WHERE website_id = ${websiteId}::uuid AND tier = 'T2_RENDER'`;
      const sched = await tx.monitoringSchedule.findFirst({ where: { websiteId, tier: "T2_RENDER", apiEndpointId: null }, select: { status: true, pausedReason: true } });
      const incidents = (await this.monitoring.incidents(s, o, { status: "ACTIVE", websiteId, limit: 20 })).filter((i) => i.checkKey.startsWith("browser."));
      const cfg = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { browserCheck: true } });
      const open = new Set(incidents.map((i) => i.checkKey));
      const state: BrowserMonitoringSummaryDto["state"] =
        w.status === "PAUSED" ? "PAUSED"
        : !sched || sched.status !== "ACTIVE" ? "NOT_MONITORED"
        : !latest ? "UNKNOWN"
        : open.has("browser.navigation") || open.has("browser.blank") ? "DOWN"
        : open.size || latest.outcome === "FAILED" ? "DEGRADED"
        : latest.outcome === "INCONCLUSIVE" ? "UNKNOWN" : "UP";
      return {
        state, pausedReason: sched && sched.status !== "ACTIVE" ? sched.pausedReason : null, latest: latest ?? null,
        lastSuccessfulCheckAt: iso(last?.ok), lastFailedCheckAt: iso(last?.failed), openIncidents: incidents,
        config: parseBrowserCheckConfig(cfg?.browserCheck) as unknown as Record<string, unknown>, measurement: "SYNTHETIC_BROWSER",
      };
    });
  }

  async results(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof BrowserResultsQuery>) {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const data = await this.executions(tx, websiteId, {
        before: q.before ? new Date(q.before) : new Date(Date.now() + 86_400_000), limit: q.limit + 1,
        from: q.from ? new Date(q.from) : undefined, outcome: q.outcome, viewport: q.viewport, problem: q.problem,
      });
      const page = data.slice(0, q.limit);
      return { data: page, nextBefore: data.length > q.limit ? page[page.length - 1]!.windowStart : null };
    });
  }

  /** One browser execution with all viewports, diagnostics, synthetic metrics and screenshot references. */
  async result(s: SessionContext, o: OrgContext, websiteId: string, executionId: string): Promise<BrowserCheckResultDto> {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const [r] = await this.executions(tx, websiteId, { before: new Date(Date.now() + 86_400_000), limit: 1, executionId });
      if (!r) throw Errors.notFound();
      const ft = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT test_kind, component_type::text AS component_type, target, viewport, status::text AS status, coverage_note, failure_reason, safety, steps, duration_ms
          FROM component_test_results WHERE website_id = ${websiteId}::uuid AND execution_id = ${executionId}::uuid ORDER BY test_kind, viewport, target`;
      const rr = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT viewport, width, height, status::text AS status, nav_state, horizontal_overflow_px, clipped_text, "overlaps", obscured_controls, offscreen_controls,
               offscreen_elements, oversized_images, findings
          FROM responsive_test_results WHERE website_id = ${websiteId}::uuid AND execution_id = ${executionId}::uuid ORDER BY width DESC`;
      return {
        ...r,
        functional: ft.map((x) => ({
          kind: x.test_kind ?? "UNKNOWN", componentType: x.component_type, target: x.target ?? "", viewport: x.viewport, outcome: x.status,
          reason: x.failure_reason ?? x.coverage_note ?? null, safety: x.safety, steps: Array.isArray(x.steps) ? x.steps : [], durationMs: x.duration_ms,
        })),
        responsive: rr.map((x) => ({
          viewport: x.viewport, width: x.width, height: x.height, status: x.status, navState: x.nav_state, overflowPx: x.horizontal_overflow_px,
          clippedText: x.clipped_text, overlaps: x.overlaps, obscuredControls: x.obscured_controls, offscreenControls: x.offscreen_controls,
          offscreenText: x.offscreen_elements, oversizedImages: x.oversized_images, objective: x.findings?.objective ?? [], heuristic: x.findings?.heuristic ?? [],
          samples: Array.isArray(x.findings?.samples) ? x.findings.samples : [],
        })),
      };
    });
  }

  /** Phase 4F: the website's component inventory (synthetic detection on the monitored page). */
  async components(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof ComponentListQuery>): Promise<ComponentDto[]> {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT c.id, c.type::text AS type, c.label, c.status, c.detail, c.viewports, c.first_seen_at, c.last_seen_at, c.removed_at, c.evidence, d.url
          FROM page_components c JOIN monitored_pages m ON m.id = c.monitored_page_id JOIN discovered_pages d ON d.id = m.discovered_page_id
         WHERE c.website_id = ${websiteId}::uuid AND (${q.status} = 'ALL' OR c.status = ${q.status}) AND (${q.type ?? null}::text IS NULL OR c.type::text = ${q.type ?? null})
         ORDER BY c.type, c.label NULLS LAST LIMIT ${q.limit}`;
      return rows.map((r) => ({
        id: r.id, type: r.type, label: r.label, status: r.status, pagePath: (() => { try { return new URL(r.url).pathname; } catch { return "/"; } })(),
        detail: r.detail ?? {}, viewports: r.viewports ?? [], firstSeenAt: iso(r.first_seen_at)!, lastSeenAt: iso(r.last_seen_at)!, removedAt: iso(r.removed_at),
        occurrences: Number(r.evidence?.count ?? 1),
      }));
    });
  }

  /** Phase 4F: component history (added / changed / removed / restored), newest first, keyset by id. */
  async componentHistory(s: SessionContext, o: OrgContext, websiteId: string, q: z.infer<typeof ComponentHistoryQuery>): Promise<{ data: ComponentEventDto[]; nextCursor: string | null }> {
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT e.id, e.created_at, e.type, e.before, e.after, e.execution_id, c.id AS component_id, c.type::text AS component_type, c.label
          FROM component_events e JOIN page_components c ON c.id = e.page_component_id
         WHERE e.website_id = ${websiteId}::uuid AND (${q.cursor ?? null}::bigint IS NULL OR e.id < ${q.cursor ?? null}::bigint)
         ORDER BY e.id DESC LIMIT ${q.limit + 1}`;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({ id: String(r.id), at: iso(r.created_at)!, type: r.type, componentId: r.component_id, componentType: r.component_type, label: r.label, before: r.before, after: r.after, executionId: r.execution_id })),
        nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
      };
    });
  }

  async updateConfig(s: SessionContext, o: OrgContext, websiteId: string, input: z.infer<typeof BrowserCheckConfigInput>, client: ClientInfo) {
    let acknowledgeFunctionalRisk: boolean | undefined;
    return this.member(s, o, async (tx) => {
      await this.website(tx, o.orgId, websiteId);
      const current = await tx.monitoringConfiguration.findUnique({ where: { websiteId }, select: { browserCheck: true } });
      const merged: Record<string, unknown> = { ...(current?.browserCheck as Record<string, unknown> | null ?? {}) };
      // Phase 4H: the risk acknowledgement is never taken from input — only recorded here, from the signed-in user
      const { acknowledgeFunctionalRisk: ack, ...rest } = input;
      acknowledgeFunctionalRisk = ack;
      if (rest.functional && "riskAcknowledgement" in rest.functional) throw new AppError(400, "VALIDATION_FAILED", "The risk acknowledgement cannot be set directly; send acknowledgeFunctionalRisk: true");
      input = rest as typeof input;
      for (const [k, v] of Object.entries(input)) {
        if (v === null) delete merged[k];
        // nested objects merge into what is stored; a null inside one removes that key (also when nothing was stored yet)
        else if (v !== undefined) merged[k] = typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries({ ...(merged[k] && typeof merged[k] === "object" ? (merged[k] as object) : {}), ...(v as object) }).filter(([, x]) => x !== null)) : v;
      }
      const parsed = BrowserCheckConfig.safeParse(merged);
      if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invalid browser monitoring configuration", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      // Phase 4H functional-test policy: enabling needs the platform switch AND an explicit acknowledgement of the risk
      const fn = parsed.data.functional;
      const wasEnabled = Boolean((current?.browserCheck as { functional?: { enabled?: boolean } } | null)?.functional?.enabled);
      if (fn.enabled) {
        if (!wasEnabled && !(await this.settings.get())["monitoring.functional.enabled"]) {
          throw new AppError(409, "FEATURE_UNAVAILABLE", "Functional tests are switched off on this platform");
        }
        if (acknowledgeFunctionalRisk === true) fn.riskAcknowledgement = { version: FUNCTIONAL_RISK_VERSION, at: new Date().toISOString(), by: s.userId };
        if (!fn.riskAcknowledgement || fn.riskAcknowledgement.version !== FUNCTIONAL_RISK_VERSION) {
          throw new AppError(400, "RISK_ACKNOWLEDGEMENT_REQUIRED", FUNCTIONAL_RISK_STATEMENT, { requires: "acknowledgeFunctionalRisk", version: FUNCTIONAL_RISK_VERSION });
        }
        if (!fn.allowedPaths.length) {
          throw new AppError(400, "VALIDATION_FAILED", "Functional tests need at least one allowed path (the parts of your site that are safe to open)", { issues: [{ path: "functional.allowedPaths", message: "At least one path is required" }] });
        }
      } else fn.riskAcknowledgement = null; // turning it off withdraws the acknowledgement; re-enabling asks again
      await tx.monitoringConfiguration.upsert({ where: { websiteId }, create: { orgId: o.orgId, websiteId, browserCheck: parsed.data as never }, update: { browserCheck: parsed.data as never } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "website.browser_check_updated", targetType: "website", targetId: websiteId, changes: { fields: Object.keys(input), ...(acknowledgeFunctionalRisk === true ? { functionalRiskAcknowledged: FUNCTIONAL_RISK_VERSION } : {}), functionalEnabled: parsed.data.functional.enabled }, client }, tx);
      return parsed.data;
    });
  }

  // ---------------------------------------------------------------- screenshots
  private sign(payload: string) {
    return createHmac("sha256", this.keys.hmacKey("artifact-download-links")).update(payload).digest("base64url");
  }

  async link(s: SessionContext, o: OrgContext, artifactId: string): Promise<ArtifactLinkDto> {
    const a = await this.member(s, o, (tx) => tx.artifact.findFirst({ where: { id: artifactId, orgId: o.orgId }, select: { id: true, contentType: true, bytes: true, expiresAt: true } }));
    if (!a) throw Errors.notFound(); // unknown or another organisation's: indistinguishable
    // this organisation's screenshot, past its retention: say so (the file itself is deleted by the cleanup job)
    if (a.expiresAt <= new Date()) throw new AppError(410, "ARTIFACT_EXPIRED", "This screenshot has expired under the retention policy");
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SEC;
    const payload = Buffer.from(JSON.stringify({ a: a.id, o: o.orgId, x: exp })).toString("base64url");
    const u = new URL("/api/v1/artifact-downloads", this.env.API_URL);
    u.searchParams.set("token", `${payload}.${this.sign(payload)}`);
    return { url: u.toString(), expiresAt: new Date(exp * 1000).toISOString(), contentType: a.contentType, bytes: a.bytes };
  }

  async download(token: string): Promise<{ body: Buffer; contentType: string }> {
    const m = /^([A-Za-z0-9_-]{10,400})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) throw Errors.notFound();
    const expected = Buffer.from(this.sign(m[1]!));
    const given = Buffer.from(m[2]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw Errors.notFound();
    let claims: { a: string; o: string; x: number };
    try { claims = JSON.parse(Buffer.from(m[1]!, "base64url").toString()); } catch { throw Errors.notFound(); }
    if (typeof claims.x !== "number" || claims.x < Date.now() / 1000) throw new AppError(410, "LINK_EXPIRED", "This download link has expired");
    if (!z.uuid().safeParse(claims.a).success || !z.uuid().safeParse(claims.o).success) throw Errors.notFound();
    // Re-checked under the organisation's RLS context: an artifact of another tenant is invisible here.
    const a = await withTenant(this.db, claims.o, (tx) => tx.artifact.findFirst({ where: { id: claims.a, orgId: claims.o, expiresAt: { gt: new Date() } }, select: { storageKey: true, contentType: true } }));
    if (!a || !this.s3) throw Errors.notFound();
    const body = await this.s3.get(a.storageKey);
    if (!body) throw Errors.notFound();
    return { body, contentType: a.contentType };
  }
}

const id = (v: string) => parse(Uuid, v);

@Controller("api/v1")
export class BrowserMonitoringController {
  constructor(private readonly b: BrowserMonitoringService) {}

  @Get("orgs/:orgId/websites/:websiteId/monitoring/browser")
  @RequirePermission("website:read")
  async summary(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.b.summary(s, o, id(w)) };
  }

  @Get("orgs/:orgId/websites/:websiteId/monitoring/browser/results")
  @RequirePermission("website:read")
  async results(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return this.b.results(s, o, id(w), parse(BrowserResultsQuery, q));
  }

  @Get("orgs/:orgId/websites/:websiteId/monitoring/browser/results/:executionId")
  @RequirePermission("website:read")
  async result(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string) {
    return { data: await this.b.result(s, o, id(w), id(e)) };
  }

  @Get("orgs/:orgId/websites/:websiteId/components")
  @RequirePermission("website:read")
  async components(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return { data: await this.b.components(s, o, id(w), parse(ComponentListQuery, q)) };
  }

  @Get("orgs/:orgId/websites/:websiteId/components/history")
  @RequirePermission("website:read")
  async componentHistory(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Query() q: unknown) {
    return this.b.componentHistory(s, o, id(w), parse(ComponentHistoryQuery, q));
  }

  @Put("orgs/:orgId/websites/:websiteId/monitoring/browser/config")
  @RequirePermission("monitoring:write")
  async config(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.b.updateConfig(s, o, id(w), parse(BrowserCheckConfigInput, body), c) };
  }

  @Get("orgs/:orgId/artifacts/:artifactId/link")
  @RequirePermission("website:read")
  async link(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("artifactId") a: string) {
    return { data: await this.b.link(s, o, id(a)) };
  }

  /** Bearer link (5 minutes, HMAC-signed, bound to artifact + organisation). No session needed so <img> tags work. */
  @Public()
  @Get("artifact-downloads")
  async download(@Query() q: unknown, @Res({ passthrough: false }) reply: FastifyReply) {
    const { token } = parse(z.object({ token: z.string().max(600) }).strict(), q);
    const f = await this.b.download(token);
    reply.header("content-type", f.contentType).header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox").header("content-disposition", "inline; filename=screenshot.png").header("referrer-policy", "no-referrer");
    return reply.send(f.body);
  }
}
