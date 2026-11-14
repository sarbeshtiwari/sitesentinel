import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post, Patch, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ADMIN_ROLE_PERMISSIONS, adminHas, isProtectedSetting, isSettingKey, parseSetting, resolveSettings, SETTING_KEYS, SETTINGS, settingMeta,
  validateSettingsCombination, type AdminRoleKey,
} from "@wim/core";
import { burnPasswordVerification, hmacHex, normalizeEmailForHash, randomToken, verifyPassword, verifyTotp } from "@wim/crypto";
import type { Db } from "@wim/db";
import {
  AdminDeadLetterQuery, AdminLoginInput, AdminReplayInput, AdminSettingsPatchInput, AdminTransferDecisionInput, PageQuery, TotpCode, Uuid, type AdminWebsiteStatsDto,
  type AdminCustomerRowDto, type AdminMeDto, type AdminOverviewDto, type AdminSettingDto, type DataEnvelope, type ListEnvelope,
} from "@wim/contracts";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { QUEUES } from "@wim/queue";
import { ADMIN_DB, REDIS } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { KeysService } from "../crypto/keys.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { Errors } from "../common/errors.js";
import { AdminApi, Client, CurrentAdmin, parse, Public, RequireAdminPermission, type AdminContext, type ClientInfo } from "../common/context.js";
import { PLATFORM_STREAM, toAuditDto } from "../audit/audit.service.js";
import { cookieNames } from "../auth/session.service.js";
import { AdminSessionService } from "./admin-session.service.js";
import { WebsitesService } from "../websites/websites.service.js";
import { OpsController } from "./ops.controller.js";
import { BillingAdminController } from "./billing-admin.controller.js";

const ADMIN_TOTP_AAD = (adminId: string) => `admin_users.totp:${adminId}`;
const num = (v: unknown) => Number(v ?? 0);

/**
 * Super Admin API. Connects as wim_admin, which has NO grant on tenant content
 * tables (incidents, credentials, results, SDK events): platform statistics come
 * from aggregate views only (050_grants.sql, 060_identity.sql).
 */
@AdminApi()
@Controller("api/admin/v1")
export class AdminController {
  constructor(
    @Inject(ADMIN_DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: AdminSessionService,
    private readonly keys: KeysService,
    private readonly settings: SettingsService,
    private readonly rateLimit: RateLimitService,
    private readonly websites: WebsitesService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---------------------------------------------------------------- auth
  @Public()
  @Get("auth/csrf")
  csrf(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const n = cookieNames(this.env);
    const existing = req.admin?.csrfSecret ?? req.cookies[n.adminCsrf];
    const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken(32);
    reply.setCookie(n.adminCsrf, token, { path: "/", secure: this.env.COOKIE_SECURE, sameSite: "strict", httpOnly: false, maxAge: 3600 });
    return { data: { csrfToken: token } };
  }

  /** Password AND TOTP in one step: admins never hold a partially authenticated session. */
  @Public()
  @Post("auth/login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<DataEnvelope<AdminMeDto>> {
    const input = parse(AdminLoginInput.extend({ code: TotpCode }), body);
    await this.rateLimit.hit("admin-login-ip", client.ip ?? "unknown", (await this.settings.get())["admin.login.perIpPer15Min"], 900);
    const emailHash = hmacHex(this.keys.hmacKey("email"), normalizeEmailForHash(input.email));
    await this.rateLimit.hit("admin-login-email", emailHash, 5, 900);
    const admin = await this.db.adminUser.findUnique({ where: { email: input.email } });
    const fail = async (reason: string) => {
      await this.db.loginAttempt.createMany({ data: { actorType: "ADMIN", userId: admin?.id ?? null, emailHash, ipPrefix: client.ipPrefix, success: false, reason } });
      await this.db.securityEvent.createMany({ data: { kind: "ADMIN_LOGIN_FAILED", severity: "MEDIUM", actorRef: admin?.id ?? null, ipPrefix: client.ipPrefix, details: { reason } } });
      throw Errors.invalidCredentials();
    };
    if (!admin) {
      await burnPasswordVerification(input.password);
      return fail("UNKNOWN_EMAIL");
    }
    if (!admin.active || (admin.lockedUntil && admin.lockedUntil > new Date())) return fail("INACTIVE_OR_LOCKED");
    if (!(await verifyPassword(admin.passwordHash, input.password))) {
      const failed = admin.failedLoginCount + 1;
      await this.db.adminUser.update({ where: { id: admin.id }, data: { failedLoginCount: failed, lockedUntil: failed >= 10 ? new Date(Date.now() + 3_600_000) : null }, select: { id: true } });
      return fail("BAD_PASSWORD");
    }
    const secret = await this.keys.openPlatform(this.db, "admin-secrets", admin.totpSecretEnc, ADMIN_TOTP_AAD(admin.id));
    const step = verifyTotp(secret, input.code, { lastUsedStep: admin.totpLastUsedStep });
    const claimed = step !== null && (await this.db.adminUser.updateMany({
      where: { id: admin.id, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
      data: { totpLastUsedStep: step, failedLoginCount: 0, lastLoginAt: new Date() },
    })).count === 1;
    if (!claimed) return fail("BAD_TOTP");

    const issued = await this.sessions.create(admin.id, client);
    this.sessions.setCookies(reply, issued);
    await this.db.loginAttempt.createMany({ data: { actorType: "ADMIN", userId: admin.id, emailHash, ipPrefix: client.ipPrefix, success: true, reason: null } });
    await this.audit(admin.id, admin.email, "admin.login", client);
    return { data: this.meDto(admin) };
  }

  @Post("auth/logout")
  @HttpCode(204)
  async logout(@CurrentAdmin() a: AdminContext, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.sessions.revoke(a.sessionId, a.tokenHash);
    this.sessions.clearCookies(reply);
    await this.audit(a.adminId, a.email, "admin.logout", client);
  }

  @Get("me")
  async me(@CurrentAdmin() a: AdminContext): Promise<DataEnvelope<AdminMeDto>> {
    const admin = await this.db.adminUser.findUniqueOrThrow({ where: { id: a.adminId } });
    return { data: this.meDto(admin) };
  }

  // ---------------------------------------------------------------- platform statistics (aggregates only)
  @Get("overview")
  @RequireAdminPermission("admin:overview:read")
  async overview(): Promise<DataEnvelope<AdminOverviewDto>> {
    const [s] = await this.db.$queryRaw<Array<Record<string, bigint>>>`SELECT * FROM admin_v_platform_stats`;
    const daily = await this.db.$queryRaw<Array<{ day: Date; signups: bigint }>>`SELECT * FROM admin_v_signups_daily ORDER BY day`;
    return {
      data: {
        generatedAt: new Date().toISOString(),
        users: { total: num(s!.users_total), verified: num(s!.users_verified), withTwoFactor: num(s!.users_with_2fa), signups7d: num(s!.signups_7d), signups30d: num(s!.signups_30d) },
        organizations: { total: num(s!.orgs_total), active: num(s!.orgs_active), suspended: num(s!.orgs_suspended), pendingDeletion: num(s!.orgs_pending_deletion) },
        subscriptions: { trialing: num(s!.subs_trialing), paid: num(s!.subs_paid), pastDue: num(s!.subs_past_due), expired: num(s!.subs_expired) },
        websites: { total: num(s!.websites_total), active: num(s!.websites_active), pendingVerification: num(s!.websites_pending) },
        incidents: { open: num(s!.incidents_open), openCritical: num(s!.incidents_open_critical) },
        monitoring: { executions24h: num(s!.executions_24h), failedExecutions24h: num(s!.executions_failed_24h) },
        jobs: { unresolvedFailures: num(s!.job_failures_unresolved) },
        workers: { healthy: num(s!.workers_healthy), total: num(s!.workers_total) },
        signupsDaily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), count: num(d.signups) })),
      },
    };
  }

  /** Organization metadata (masked owner email, counts) — never customer content. */
  @Get("customers")
  @RequireAdminPermission("admin:customers:read")
  async customers(@Query() query: unknown): Promise<ListEnvelope<AdminCustomerRowDto>> {
    const q = parse(PageQuery.extend({ q: z.string().trim().max(100).optional() }), query);
    const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await this.db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM admin_v_organizations
       WHERE (${like}::text IS NULL OR name ILIKE ${like} OR slug ILIKE ${like})
       ORDER BY created_at DESC, id
       LIMIT ${q.limit + 1} OFFSET ${offset}`;
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => ({
        id: String(r.id), name: String(r.name), slug: String(r.slug), status: String(r.status),
        createdAt: (r.created_at as Date).toISOString(), planKey: (r.plan_key as string) ?? null,
        subscriptionStatus: (r.subscription_status as string) ?? null, trialStatus: (r.trial_status as string) ?? null,
        trialEndsAt: r.trial_ends_at ? (r.trial_ends_at as Date).toISOString() : null,
        memberCount: num(r.member_count), websiteCount: num(r.website_count), ownerEmailMasked: (r.owner_email_masked as string) ?? null,
      })),
      nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    };
  }

  // ---------------------------------------------------------------- website registry statistics (aggregates only)
  @Get("websites/stats")
  @RequireAdminPermission("admin:overview:read")
  async websiteStats(): Promise<DataEnvelope<AdminWebsiteStatsDto>> {
    const [r] = await this.db.$queryRaw<Array<Record<string, bigint>>>`SELECT * FROM admin_v_website_stats`;
    const daily = await this.db.$queryRaw<Array<{ day: Date; accepted: bigint; duplicates: bigint; verified: bigint }>>`SELECT * FROM admin_v_registration_daily ORDER BY day`;
    const n = (k: string) => num(r![k]);
    return {
      data: {
        generatedAt: new Date().toISOString(),
        websites: { total: n("websites_total"), verified: n("websites_verified"), unverified: n("websites_unverified"), archived: n("websites_archived"), added7d: n("websites_added_7d") },
        claims: { pending: n("claims_pending"), verified: n("claims_verified"), rootScope: n("claims_root_scope"), expired: n("claims_expired") },
        verifications: { dns: n("verifications_dns"), file: n("verifications_file"), meta: n("verifications_meta"), failed24h: n("verifications_failed_24h") },
        sdk: { notInstalled: n("sdk_not_installed"), seen24h: n("sdk_seen_24h"), inactive: n("sdk_inactive"), invalidConfiguration: n("sdk_invalid_configuration") },
        trials: { activatedTotal: n("trials_activated_total"), activated7d: n("trials_activated_7d"), active: n("trials_active"), domainsConsumed: n("domains_trial_consumed") },
        registrationAttempts: { duplicates24h: n("duplicate_attempts_24h"), duplicates30d: n("duplicate_attempts_30d"), blocked30d: n("blocked_attempts_30d"), suspiciousOrgs24h: n("suspicious_orgs_24h") },
        transfers: { pendingVerification: n("transfers_pending_verification"), pendingAdmin: n("transfers_pending_admin"), approved: n("transfers_approved"), rejected: n("transfers_rejected"), cancelled: n("transfers_cancelled") },
        daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), accepted: num(d.accepted), duplicates: num(d.duplicates), verified: num(d.verified) })),
      },
    };
  }

  /** Transfer review queue: domain + organization metadata only. */
  @Get("domain-transfers")
  @RequireAdminPermission("admin:customers:read")
  async domainTransfers() {
    const rows = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_domain_transfers ORDER BY created_at DESC LIMIT 200`;
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
    return {
      data: rows.map((r) => ({
        id: r.id, displayHost: r.display_host, registrableDomain: r.registrable_domain, status: r.status, ownerResponse: r.owner_response,
        ownerRespondBy: iso(r.owner_respond_by), createdAt: iso(r.created_at), verifiedAt: iso(r.verified_at), decidedAt: iso(r.decided_at),
        decisionReason: r.decision_reason, fromOrg: r.from_org_id ? { id: r.from_org_id, name: r.from_org_name } : null,
        toOrg: r.to_org_id ? { id: r.to_org_id, name: r.to_org_name } : null,
        currentClaimStatus: r.current_claim_status, currentClaimVerifiedAt: iso(r.current_claim_verified_at),
      })),
    };
  }

  /** Approve or reject a DNS-verified transfer. Approval is applied by the verification worker. */
  @Post("domain-transfers/:transferId/decision")
  @RequireAdminPermission("admin:transfers:decide")
  @HttpCode(200)
  async decideTransfer(@CurrentAdmin() a: AdminContext, @Param("transferId") transferId: string, @Body() body: unknown, @Client() client: ClientInfo) {
    const tid = parse(Uuid, transferId);
    const input = parse(AdminTransferDecisionInput, body);
    const approve = input.decision === "APPROVE";
    const updated = await this.db.$transaction(async (tx) => {
      const r = await tx.domainTransfer.updateMany({
        where: { id: tid, status: "PENDING_ADMIN" },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedByAdminId: a.adminId, decisionReason: input.reason, decidedAt: new Date() },
      });
      if (r.count !== 1) return false;
      await tx.auditLog.createMany({ data: { stream: PLATFORM_STREAM, actorType: "ADMIN", actorId: a.adminId, actorLabel: a.email, action: approve ? "admin.transfer_approved" : "admin.transfer_rejected", targetType: "domain_transfer", targetId: tid, reason: input.reason, ipPrefix: client.ipPrefix, requestId: client.requestId } });
      return true;
    });
    if (!updated) throw Errors.conflict("Only DNS-verified transfers awaiting review can be decided");
    if (approve) await this.websites.verifyQueue.add("APPLY_TRANSFER", { kind: "APPLY_TRANSFER", transferId: tid, adminId: a.adminId }, { jobId: `apply.${tid}`, attempts: 3, backoff: { type: "exponential", delay: 5000 } });
    else await this.websites.enqueueEmail({ kind: "TRANSFER_DECIDED", transferId: tid }, `transfer-decided.${tid}`);
    return { data: { status: approve ? "APPROVED" : "REJECTED" } };
  }

  // ---------------------------------------------------------------- monitoring infrastructure (Phase 4B; aggregates only)
  /** Queue depth, executions, workers and scheduler health. No organisation, website or domain appears here. */
  @Get("monitoring/health")
  @RequireAdminPermission("admin:monitoring:read")
  async monitoringHealth() {
    const counts: Record<string, Record<string, number>> = {};
    for (const name of Object.values(QUEUES)) {
      const q = new Queue(name, { connection: this.redis, prefix: this.env.QUEUE_PREFIX });
      try {
        counts[name] = await q.getJobCounts("waiting", "prioritized", "active", "delayed", "completed", "failed");
      } catch {
        counts[name] = {};
      } finally {
        await q.close();
      }
    }
    const executions = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_execution_health ORDER BY tier`;
    const schedules = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_schedule_health ORDER BY tier, status`;
    const workers = await this.db.workerHeartbeat.findMany({ orderBy: [{ kind: "asc" }, { workerId: "asc" }] });
    const [cycle] = await this.db.$queryRaw<Array<{ last_ok: Date | null; cycles_1h: bigint; backpressure_1h: bigint; dead_letters_24h: bigint; security_rejected_24h: bigint }>>`
      SELECT max(recorded_at) FILTER (WHERE component = 'scheduler' AND metric = 'cycle_ok') AS last_ok,
             count(*) FILTER (WHERE component = 'scheduler' AND metric = 'cycle_ok' AND recorded_at > now() - interval '1 hour') AS cycles_1h,
             count(*) FILTER (WHERE component = 'scheduler' AND metric = 'backpressure' AND recorded_at > now() - interval '1 hour') AS backpressure_1h,
             count(*) FILTER (WHERE component = 'queue' AND metric = 'dead_letter') AS dead_letters_24h,
             count(*) FILTER (WHERE component = 'queue' AND metric = 'security_rejected') AS security_rejected_24h
        FROM system_health_logs WHERE recorded_at > now() - interval '24 hours'`;
    const [http] = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_http_check_health`;
    const [browser] = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_browser_check_health`;
    const [deep] = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_deepscan_health`;
    const outcomes = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_monitoring_outcomes ORDER BY tier`;
    const usage = await this.db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM admin_v_usage_totals ORDER BY key`;
    const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
    const n = (v: unknown) => (v == null ? null : Number(v));
    const staleAfterMs = 60_000;
    return {
      data: {
        generatedAt: new Date().toISOString(),
        queues: counts,
        executions: executions.map((e) => ({
          tier: e.tier, scheduled: n(e.scheduled), queued: n(e.queued), running: n(e.running), retrying: n(e.retrying),
          succeeded1h: n(e.succeeded_1h), failed1h: n(e.failed_1h), deadLettered24h: n(e.dead_lettered_24h), cancelled24h: n(e.cancelled_24h),
          skipped24h: n(e.skipped_24h), retries24h: n(e.retries_24h), avgDurationMs1h: n(e.avg_duration_ms_1h), p50DurationMs1h: n(e.p50_duration_ms_1h),
          p95DurationMs1h: n(e.p95_duration_ms_1h), p95WaitMs1h: n(e.p95_wait_ms_1h), expiredLeases: n(e.expired_leases),
        })),
        schedules: schedules.map((x) => ({ tier: x.tier, status: x.status, pausedReason: x.paused_reason || null, count: n(x.schedules), overdue: n(x.overdue) })),
        workers: workers.map((w) => ({
          workerId: w.workerId, kind: w.kind, hostname: w.hostname, version: w.version, startedAt: w.startedAt.toISOString(), lastSeenAt: w.lastSeenAt.toISOString(),
          activeJobs: w.activeJobs, capacity: w.capacity, utilization: w.capacity ? w.activeJobs / w.capacity : null, rssMb: w.rssMb,
          available: Date.now() - w.lastSeenAt.getTime() < staleAfterMs,
        })),
        scheduler: {
          lastSuccessfulCycleAt: iso(cycle?.last_ok), cycles1h: n(cycle?.cycles_1h), backpressureEvents1h: n(cycle?.backpressure_1h),
          instances: workers.filter((w) => w.kind === "scheduler" && Date.now() - w.lastSeenAt.getTime() < staleAfterMs).length,
        },
        deadLetters24h: n(cycle?.dead_letters_24h), securityRejected24h: n(cycle?.security_rejected_24h),
        // Phase 4C: synthetic HTTP checks, aggregate only (no org, website, URL or address)
        httpChecks: http ? {
          checks1h: n(http.checks_1h), passed1h: n(http.passed_1h), failed1h: n(http.failed_1h), inconclusive1h: n(http.inconclusive_1h),
          infraFailures24h: n(http.infra_failures_24h), securityRejections24h: n(http.security_rejections_24h), blockedDestinations24h: n(http.blocked_destinations_24h),
          p50TotalMs1h: n(http.p50_total_ms_1h), p95TotalMs1h: n(http.p95_total_ms_1h), p95GatewayMs1h: n(http.p95_gateway_ms_1h), lastCompletedCheckAt: iso(http.last_completed_check_at),
        } : null,
        // Phase 4D: synthetic browser checks, aggregate only (no org, website, URL, page content or screenshots)
        browserChecks: browser ? {
          executions1h: n(browser.executions_1h), passed1h: n(browser.passed_1h), failed1h: n(browser.failed_1h), inconclusive1h: n(browser.inconclusive_1h),
          infraFailures24h: n(browser.infra_failures_24h), p95ViewportMs1h: n(browser.p95_viewport_ms_1h), screenshotBytes24h: n(browser.artifact_bytes_24h),
          lastCompletedAt: iso(browser.last_completed_at),
        } : null,
        // Phase 4E: deep scans, aggregate only (no org, website, URL, page content or finding text)
        deepScans: deep ? {
          running: n(deep.running), completed24h: n(deep.completed_24h), partial24h: n(deep.partial_24h), cancelled24h: n(deep.cancelled_24h),
          inconclusive24h: n(deep.inconclusive_24h), pages24h: n(deep.pages_24h), requests24h: n(deep.requests_24h), bytes24h: n(deep.bytes_24h),
          p95DurationSec24h: n(deep.p95_duration_sec_24h), openFindings: n(deep.open_findings),
        } : null,
        // Phase 4F: platform outcome totals and error rates per tier (aggregate; an INCONCLUSIVE result is our
        // infrastructure's, never a customer's outage)
        outcomes: outcomes.map((o) => {
          const total = n(o.results_24h) ?? 0;
          const rate = (v: unknown) => (total ? Math.round(((n(v) ?? 0) / total) * 1000) / 10 : null);
          return {
            tier: o.tier, results24h: total, passed24h: n(o.passed_24h), failed24h: n(o.failed_24h), inconclusive24h: n(o.inconclusive_24h),
            retried24h: n(o.retried_24h), results7d: n(o.results_7d), failureRatePercent24h: rate(o.failed_24h), inconclusiveRatePercent24h: rate(o.inconclusive_24h),
          };
        }),
        // The API has no network path to the egress gateway (by design); its health is inferred from outcomes.
        gateway: {
          infraFailures24h: (n(http?.infra_failures_24h) ?? 0) + (n(browser?.infra_failures_24h) ?? 0),
          securityRejections24h: n(http?.security_rejections_24h), blockedDestinations24h: n(http?.blocked_destinations_24h),
          p95GatewayMs1h: n(http?.p95_gateway_ms_1h), source: "derived from execution outcomes",
        },
        usage: usage.map((u) => ({ key: u.key, today: n(u.today), last30Days: n(u.last_30_days), organisationsToday: n(u.organisations_today) })),
      },
    };
  }

  /** Dead letters: identifiers and categories only (payloads are ids; error text is sanitised at the source). */
  @Get("monitoring/dead-letters")
  @RequireAdminPermission("admin:monitoring:read")
  async deadLetters(@Query() query: unknown) {
    const q = parse(AdminDeadLetterQuery, query);
    const rows = await this.db.jobFailure.findMany({
      where: q.status === "OPEN" ? { resolution: null } : q.status === "RESOLVED" ? { resolution: { not: null } } : {},
      orderBy: { failedAt: "desc" }, take: q.limit,
      select: {
        id: true, queue: true, jobType: true, failureCategory: true, attempts: true, error: true, failedAt: true, orgId: true, executionId: true,
        replayRequestedAt: true, resolution: true, resolvedAt: true, replayExecutionId: true,
      },
    });
    return {
      data: rows.map((r) => ({
        id: r.id, queue: r.queue, jobType: r.jobType, failureCategory: r.failureCategory, attempts: r.attempts, error: r.error, failedAt: r.failedAt.toISOString(),
        orgId: r.orgId, executionId: r.executionId, replayRequestedAt: r.replayRequestedAt?.toISOString() ?? null, resolution: r.resolution,
        resolvedAt: r.resolvedAt?.toISOString() ?? null, replayExecutionId: r.replayExecutionId, replayable: !r.resolution && !r.replayRequestedAt && r.failureCategory !== "SECURITY" && !String(r.jobType ?? "").startsWith("EMAIL:"),
      })),
    };
  }

  /**
   * Request a replay. The scheduler performs it only after re-checking the website's CURRENT ownership,
   * organisation status, entitlement and tier switch; security failures are never replayed.
   */
  @Post("monitoring/dead-letters/:id/replay")
  @RequireAdminPermission("admin:monitoring:replay")
  @HttpCode(202)
  async replayDeadLetter(@CurrentAdmin() a: AdminContext, @Param("id") failureId: string, @Body() body: unknown, @Client() client: ClientInfo) {
    const fid = parse(Uuid, failureId);
    const { reason } = parse(AdminReplayInput, body);
    const ok = await this.db.$transaction(async (tx) => {
      const r = await tx.jobFailure.updateMany({
        where: { id: fid, resolution: null, replayRequestedAt: null, NOT: { failureCategory: "SECURITY" } },
        data: { replayRequestedAt: new Date(), replayRequestedById: a.adminId, replayReason: reason },
      });
      if (r.count !== 1) return false;
      await tx.auditLog.createMany({ data: { stream: PLATFORM_STREAM, actorType: "ADMIN", actorId: a.adminId, actorLabel: a.email, action: "admin.dead_letter_replay_requested", targetType: "job_failure", targetId: fid, reason, ipPrefix: client.ipPrefix, requestId: client.requestId } });
      return true;
    });
    if (!ok) throw Errors.conflict("This dead letter is not replayable (already resolved, already requested, or a security failure)");
    return { data: { status: "REPLAY_REQUESTED" } };
  }

  // ---------------------------------------------------------------- audit
  @Get("audit-logs")
  @RequireAdminPermission("admin:audit:read")
  async auditLogs(@Query() query: unknown) {
    const q = parse(PageQuery.extend({ stream: z.string().regex(/^(platform|org:[0-9a-f-]{36}|user:[0-9a-f-]{36})$/).default(PLATFORM_STREAM) }), query);
    const cursor = q.cursor && /^\d+$/.test(q.cursor) ? BigInt(q.cursor) : undefined;
    const rows = await this.db.auditLog.findMany({
      where: { stream: q.stream, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: "desc" },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return { data: page.map(toAuditDto), nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null };
  }

  @Post("audit-logs/verify-chain")
  @RequireAdminPermission("admin:audit:read")
  @HttpCode(200)
  async verifyChain(@Body() body: unknown) {
    const { stream } = parse(z.object({ stream: z.string().regex(/^(platform|org:[0-9a-f-]{36}|user:[0-9a-f-]{36})$/) }), body);
    const [broken] = await this.db.$queryRaw<Array<{ broken_seq: bigint; reason: string }>>`SELECT * FROM audit_verify(${stream})`;
    const [{ checked }] = await this.db.$queryRaw<Array<{ checked: bigint }>>`SELECT count(*) AS checked FROM audit_logs WHERE stream = ${stream}`;
    return { data: { stream, valid: !broken, checked: num(checked), firstBrokenSeq: broken ? String(broken.broken_seq) : null, reason: broken?.reason ?? null } };
  }

  // ---------------------------------------------------------------- settings
  @Get("settings")
  @RequireAdminPermission("admin:settings:read")
  async listSettings(): Promise<DataEnvelope<AdminSettingDto[]>> {
    const rows = await this.db.platformSetting.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return {
      data: SETTING_KEYS.map((key) => {
        const def = SETTINGS[key];
        const row = byKey.get(key);
        return {
          key, group: def.group, description: def.description, value: row ? row.value : def.default, defaultValue: def.default,
          version: row?.version ?? null, updatedAt: row?.updatedAt.toISOString() ?? null, public: Boolean((def as { public?: boolean }).public),
          ...settingMeta(key),
        };
      }),
    };
  }

  /** Validated, versioned, audited and hot-reloaded (Redis pub/sub) — no redeploy. */
  @Patch("settings")
  @RequireAdminPermission("admin:settings:write")
  async patchSettings(@CurrentAdmin() a: AdminContext, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<AdminSettingDto[]>> {
    const input = parse(AdminSettingsPatchInput, body);
    const changes = input.changes.map((c) => {
      if (!isSettingKey(c.key)) throw new z.ZodError([{ code: "custom", path: ["changes", c.key], message: "Unknown setting", input: c.key }]);
      return { key: c.key, value: parseSetting(c.key, c.value) };
    });
    // Phase 4H: protected security policies need an extra permission and an explicit confirmation
    const prot = changes.filter((c) => isProtectedSetting(c.key)).map((c) => c.key);
    if (prot.length && !adminHas(a.role as AdminRoleKey, "admin:settings:protected")) throw Errors.forbidden(`Protected security settings can only be changed by a Super Admin: ${prot.join(", ")}`);
    if (prot.length && input.confirmProtected !== true) throw new z.ZodError([{ code: "custom", path: ["confirmProtected"], message: `Changing protected settings (${prot.join(", ")}) requires confirmProtected: true`, input: false }]);
    // Phase 4H: the resulting configuration as a whole must be safe (individually valid values can still conflict)
    const current = resolveSettings((await this.db.platformSetting.findMany()).map((r) => ({ key: r.key, value: r.value })));
    const issues = validateSettingsCombination({ ...current, ...Object.fromEntries(changes.map((c) => [c.key, c.value])) } as typeof current);
    if (issues.length) throw new z.ZodError(issues.map((m) => ({ code: "custom" as const, path: ["changes"], message: m, input: null })));
    await this.db.$transaction(async (tx) => {
      for (const c of changes) {
        const before = await tx.platformSetting.findUnique({ where: { key: c.key } });
        const version = (before?.version ?? 0) + 1;
        await tx.platformSetting.upsert({
          where: { key: c.key },
          create: { key: c.key, value: c.value as never, version, updatedById: a.adminId },
          update: { value: c.value as never, version, updatedById: a.adminId },
        });
        await tx.platformSettingHistory.create({ data: { key: c.key, version, value: c.value as never, updatedById: a.adminId } });
        await tx.auditLog.createMany({
          data: {
            stream: PLATFORM_STREAM, actorType: "ADMIN", actorId: a.adminId, actorLabel: a.email, action: "admin.setting_changed",
            targetType: "setting", targetId: c.key, changes: { from: (before?.value ?? SETTINGS[c.key].default) as never, to: c.value as never, version, protected: isProtectedSetting(c.key), apply: settingMeta(c.key).apply },
            reason: input.reason, ipPrefix: client.ipPrefix, requestId: client.requestId,
          },
        });
      }
    });
    await this.settings.publishChange(changes.map((c) => c.key));
    return this.listSettings();
  }

  // ---------------------------------------------------------------- helpers
  private meDto(admin: { id: string; email: string; name: string; role: string }): AdminMeDto {
    return { id: admin.id, email: admin.email, name: admin.name, role: admin.role, permissions: [...ADMIN_ROLE_PERMISSIONS[admin.role as AdminRoleKey]] };
  }

  private async audit(adminId: string, email: string, action: string, client: ClientInfo) {
    await this.db.auditLog.createMany({ data: { stream: PLATFORM_STREAM, actorType: "ADMIN", actorId: adminId, actorLabel: email, action, ipPrefix: client.ipPrefix, requestId: client.requestId } });
  }
}

@Module({ controllers: [AdminController, OpsController, BillingAdminController], providers: [AdminSessionService, WebsitesService], exports: [AdminSessionService, WebsitesService] })
export class AdminModule {}
