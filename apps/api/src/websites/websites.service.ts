import { Inject, Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  DomainError, generateSiteKey, type TrialOutcome, type WebsiteCategory, generateVerificationToken, installationState, normalizeWebsiteUrl, parseSdkConfig,
  verificationInstructions, type DomainIdentity, type InstallationState, type NormalizeOptions, type SettingsSnapshot,
} from "@wim/core";
import { withMember, type Db, type Prisma, type Tx } from "@wim/db";
import { SDK_MANIFEST } from "@wim/sdk";
import {
  REVALIDATE_QUEUE, VERIFY_QUEUE, type CreateWebsiteInput, type RevalidateJob, type EmailJob, type DomainAvailability, type InstallationDto, type TransferDto, type VerificationAttemptDto,
  type VerifyJob, type WebsiteClaimDto, type WebsiteDetailDto, type WebsiteMonitoringDto, type WebsitePreviewDto, type WebsiteSummaryDto,
} from "@wim/contracts";
import { APP_DB, EmailQueue, REDIS } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream } from "../audit/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { AppError, Errors } from "../common/errors.js";
import type { ClientInfo, OrgContext, SessionContext } from "../common/context.js";

const WEBSITE_SELECT = {
  id: true, orgId: true, name: true, description: true, category: true, monitoringTimezone: true, canonicalOrigin: true,
  status: true, verifiedAt: true, trialOutcome: true, createdAt: true, updatedAt: true, archivedAt: true,
  domainClaim: {
    select: {
      id: true, status: true, scope: true, verifiedAt: true, verifiedMethod: true, inheritedFromClaimId: true, pendingExpiresAt: true,
      verificationAttempts: true, verificationToken: true, lapsedAt: true,
      revalidationState: true, lastRevalidationAt: true, lastRevalidationOutcome: true, nextRevalidationAt: true, failingSince: true,
      domainRegistry: { select: { id: true, identityKey: true, displayHost: true, registrableDomain: true, isRoot: true } },
    },
  },
  installation: true,
} as const;

type WebsiteRow = Prisma.WebsiteGetPayload<{ select: typeof WEBSITE_SELECT }>;

/** Customer website registry: claims, verification, SDK keys, telemetry controls, transfers. */
@Injectable()
export class WebsitesService {
  readonly verifyQueue: Queue<VerifyJob>;
  readonly revalidateQueue: Queue<RevalidateJob>;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailQueue,
  ) {
    this.verifyQueue = new Queue<VerifyJob>(VERIFY_QUEUE, { connection: redis, prefix: env.QUEUE_PREFIX });
    this.revalidateQueue = new Queue<RevalidateJob>(REVALIDATE_QUEUE, { connection: redis, prefix: env.QUEUE_PREFIX });
  }

  enqueueEmail(job: EmailJob, id: string) {
    return this.email.enqueue(job, id);
  }

  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }

  private async normalizeOpts(): Promise<NormalizeOptions> {
    const s = await this.settings.get();
    const suffixes = await this.db.domainPolicySuffix.findMany({ select: { suffix: true } });
    return { aliasLabels: s["domain.aliasLabels"], extraSuffixes: suffixes.map((x) => x.suffix) };
  }

  private normalize(url: string, opts: NormalizeOptions): DomainIdentity {
    try {
      return normalizeWebsiteUrl(url, opts);
    } catch (e) {
      if (e instanceof DomainError) throw new AppError(400, "INVALID_URL", e.message, { reason: e.code });
      throw e;
    }
  }

  private audit_(tx: Tx, s: SessionContext, o: OrgContext, action: string, websiteId: string, changes: Record<string, unknown>, client: ClientInfo) {
    return this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action, targetType: "website", targetId: websiteId, changes, client }, tx);
  }

  // ---------------------------------------------------------------- registration
  async preview(s: SessionContext, o: OrgContext, url: string): Promise<WebsitePreviewDto> {
    const id = this.normalize(url, await this.normalizeOpts());
    const [row] = await this.member(s, o, (tx) => tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM domain_claim_status(${id.identityKey})`);
    const map: Record<string, DomainAvailability> = { UNCLAIMED: "AVAILABLE", YOURS: "YOURS", CLAIMED_ELSEWHERE: "CLAIMED_ELSEWHERE", PENDING_ELSEWHERE: "PENDING_ELSEWHERE", BLOCKED: "BLOCKED" };
    const notes: string[] = [];
    if (id.host !== id.hostKey) notes.push(`${id.host} and ${id.hostKey} are treated as the same website.`);
    if (!id.isRoot) notes.push(`This is a subdomain of ${id.registrableDomain}; it is registered and verified on its own.`);
    if (id.displayHost !== id.hostKey) notes.push(`Internationalized domain: stored as ${id.hostKey}.`);
    return {
      identityKey: id.identityKey, host: id.host, hostKey: id.hostKey, displayHost: id.displayHost, registrableDomain: id.registrableDomain,
      isRoot: id.isRoot, canonicalOrigin: id.canonicalOrigin, availability: map[row?.status ?? "UNCLAIMED"] ?? "AVAILABLE", notes,
    };
  }

  async create(s: SessionContext, o: OrgContext, input: CreateWebsiteInput, client: ClientInfo): Promise<WebsiteDetailDto> {
    if (!s.emailVerified) throw Errors.emailNotVerified();
    await this.rateLimit.hit("website-create", o.orgId, 20, 3600);
    const settings = await this.settings.get();
    const id = this.normalize(input.url, await this.normalizeOpts());
    const result = await this.member(s, o, async (tx) => {
      const [r] = await tx.$queryRaw<Array<{ outcome: string; claim_id: string | null }>>`
        SELECT * FROM register_domain_claim(${o.orgId}::uuid, ${id.identityKey}, ${id.registrableDomain}, ${id.displayHost}, ${id.isRoot},
          ${settings["domain.policy"]}, ${generateVerificationToken()}, ${settings["domain.pendingClaimHours"]}::int, ${settings["websites.maxPendingPerOrg"]}::int)`;
      if (!r || !["ACCEPTED", "INHERITED_VERIFIED"].includes(r.outcome)) return { outcome: r?.outcome ?? "ERROR", claimId: r?.claim_id ?? null, websiteId: null };
      const website = await tx.website.create({
        data: {
          orgId: o.orgId, domainClaimId: r.claim_id!, name: input.name, description: input.description ?? null, category: input.category,
          monitoringTimezone: input.monitoringTimezone ?? settings["platform.defaultTimezone"], canonicalOrigin: id.canonicalOrigin,
        },
        select: { id: true },
      });
      await tx.siteInstallation.create({ data: { orgId: o.orgId, websiteId: website.id, siteKey: generateSiteKey() } });
      await this.audit_(tx, s, o, "website.created", website.id, { identity: id.identityKey, input: id.host, outcome: r.outcome }, client);
      return { outcome: r.outcome, claimId: r.claim_id, websiteId: website.id };
    }, );
    switch (result.outcome) {
      case "ACCEPTED":
      case "INHERITED_VERIFIED":
        return this.detail(s, o, result.websiteId!);
      case "DUPLICATE_OWN": {
        const existing = await this.member(s, o, (tx) => tx.website.findFirst({ where: { orgId: o.orgId, domainClaimId: result.claimId ?? undefined, archivedAt: null }, select: { id: true } }));
        throw Errors.conflict("This website is already registered in your organization", { websiteId: existing?.id ?? null });
      }
      case "DUPLICATE":
      case "DUPLICATE_NAMESPACE":
        // Deliberately reveals nothing about the holder.
        throw new AppError(409, "DOMAIN_ALREADY_REGISTERED", result.outcome === "DUPLICATE_NAMESPACE"
          ? `${id.registrableDomain} and its subdomains are registered by another organization`
          : `${id.displayHost} is already registered by another organization`, { identity: id.identityKey, canRequestTransfer: true });
      case "BLOCKED":
        throw new AppError(403, "DOMAIN_BLOCKED", "This domain can't be registered");
      case "LIMIT":
        throw new AppError(429, "WEBSITE_LIMIT", `Verify your existing websites first: at most ${settings["websites.maxPendingPerOrg"]} can be unverified at once`);
      default:
        throw new Error(`unexpected registration outcome ${result.outcome}`);
    }
  }

  // ---------------------------------------------------------------- read
  async list(s: SessionContext, o: OrgContext): Promise<WebsiteSummaryDto[]> {
    const settings = await this.settings.get();
    const rows = await this.member(s, o, (tx) => tx.website.findMany({ where: { orgId: o.orgId, archivedAt: null }, orderBy: { createdAt: "desc" }, select: WEBSITE_SELECT }));
    return rows.map((w) => this.summary(w, settings));
  }

  async detail(s: SessionContext, o: OrgContext, websiteId: string): Promise<WebsiteDetailDto> {
    const settings = await this.settings.get();
    const { w, transfer, trial } = await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const [transfer] = await tx.$queryRaw<Array<{ id: string; status: string; owner_response: string | null; owner_respond_by: Date | null }>>`
        SELECT id, status, owner_response, owner_respond_by FROM incoming_domain_transfers() WHERE website_id = ${websiteId}::uuid AND status IN ('PENDING_VERIFICATION', 'PENDING_ADMIN') LIMIT 1`;
      const trial = await tx.trial.findUnique({ where: { orgId: o.orgId }, select: { status: true, startsAt: true, endsAt: true, registrableDomain: true } });
      return { w, transfer, trial };
    });
    const sum = this.summary(w, settings);
    const reg = w.domainClaim.domainRegistry;
    const claim = this.claimDto(w, settings);
    const needsProof = (claim.status === "PENDING" && !this.claimExpired(w)) || claim.status === "LAPSED" || claim.revalidation?.state === "FAILING";
    const instructions = needsProof && !claim.inherited ? this.instructions(w, settings) : null;
    return {
      ...sum,
      description: w.description, monitoringTimezone: w.monitoringTimezone, canonicalOrigin: w.canonicalOrigin,
      registrableDomain: reg.registrableDomain, verifiedAt: w.verifiedAt?.toISOString() ?? null, claim, instructions,
      install: this.installDto(w, settings),
      pendingTransfer: transfer ? { id: transfer.id, status: transfer.status, ownerResponse: transfer.owner_response, ownerRespondBy: transfer.owner_respond_by?.toISOString() ?? null } : null,
      orgTrial: trial ? { status: trial.status, startsAt: trial.startsAt.toISOString(), endsAt: trial.endsAt.toISOString(), registrableDomain: trial.registrableDomain } : null,
    };
  }

  private async load(tx: Tx, orgId: string, websiteId: string): Promise<WebsiteRow> {
    const w = await tx.website.findFirst({ where: { id: websiteId, orgId, archivedAt: null }, select: WEBSITE_SELECT });
    if (!w) throw Errors.notFound();
    return w;
  }

  private claimExpired(w: WebsiteRow) {
    const c = w.domainClaim;
    return c.status === "EXPIRED" || (c.status === "PENDING" && c.pendingExpiresAt !== null && c.pendingExpiresAt <= new Date());
  }

  private claimDto(w: WebsiteRow, s: SettingsSnapshot): WebsiteClaimDto {
    const c = w.domainClaim;
    return {
      status: this.claimExpired(w) ? "EXPIRED" : c.status, scope: c.scope, verifiedAt: c.verifiedAt?.toISOString() ?? null,
      verifiedMethod: c.verifiedMethod, inherited: c.inheritedFromClaimId !== null, pendingExpiresAt: c.pendingExpiresAt?.toISOString() ?? null,
      attemptsUsed: c.verificationAttempts, attemptsAllowed: s["verification.maxAttemptsPerToken"],
      revalidation: c.status === "VERIFIED" || c.status === "LAPSED" ? {
        state: c.revalidationState as "OK" | "FAILING" | "LAPSED",
        lastCheckedAt: c.lastRevalidationAt?.toISOString() ?? null,
        lastOutcome: c.lastRevalidationOutcome,
        nextCheckAt: c.inheritedFromClaimId ? null : c.nextRevalidationAt?.toISOString() ?? null,
        failingSince: c.failingSince?.toISOString() ?? null,
        lapsesAt: c.revalidationState === "FAILING" && c.failingSince ? new Date(c.failingSince.getTime() + s["revalidation.graceHours"] * 3_600_000).toISOString() : null,
        releaseAt: c.status === "LAPSED" && c.lapsedAt ? new Date(c.lapsedAt.getTime() + s["revalidation.lapseReleaseDays"] * 86_400_000).toISOString() : null,
      } : null,
    };
  }

  private instructions(w: WebsiteRow, s: SettingsSnapshot) {
    const reg = w.domainClaim.domainRegistry;
    const i = verificationInstructions({ token: w.domainClaim.verificationToken, hostKey: reg.identityKey, registrableDomain: reg.registrableDomain, prefix: s["verification.prefix"] });
    return { value: i.value, token: w.domainClaim.verificationToken, dns: i.dns, file: { url: `https://${reg.identityKey}${i.file.path}`, content: i.file.content }, meta: { tag: i.meta.tag } };
  }

  private state(w: WebsiteRow, s: SettingsSnapshot): InstallationState {
    const i = w.installation;
    if (!i) return "NOT_INSTALLED";
    return installationState(
      { firstSeenAt: i.firstSeenAt, lastSeenAt: i.lastSeenAt, heartbeatCount: i.heartbeatCount, lastInvalidAt: i.lastInvalidAt, lastInvalidReason: i.lastInvalidReason, keyRevoked: i.revokedAt !== null },
      { now: new Date(), activeWindowHours: s["sdk.activeWindowHours"], minHeartbeats: s["sdk.minHeartbeatsForActive"] },
    );
  }

  private scriptUrl() {
    return `${this.env.SDK_URL.replace(/\/$/, "")}/monitor.v${SDK_MANIFEST.major}.js`;
  }

  snippet(siteKey: string): string {
    const endpoint = this.env.INGEST_URL && new URL(this.env.INGEST_URL).origin !== new URL(this.env.SDK_URL).origin ? `\n  data-endpoint="${new URL(this.env.INGEST_URL).origin}"` : "";
    return `<script\n  src="${this.scriptUrl()}"\n  data-site-key="${siteKey}"${endpoint}\n  async>\n</script>`;
  }

  private installDto(w: WebsiteRow, s: SettingsSnapshot): InstallationDto {
    const i = w.installation!;
    const revoked = i.revokedAt !== null;
    return {
      state: this.state(w, s), siteKey: revoked ? null : i.siteKey, keyCreatedAt: i.keyCreatedAt.toISOString(), revoked,
      previousKeyValidUntil: i.previousKeyExpiresAt && i.previousKeyExpiresAt > new Date() ? i.previousKeyExpiresAt.toISOString() : null,
      telemetryPaused: i.telemetryPaused, sdkVersion: i.sdkVersion, firstSeenAt: i.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: i.lastSeenAt?.toISOString() ?? null, pageLoads: i.heartbeatCount, lastInvalidAt: i.lastInvalidAt?.toISOString() ?? null,
      lastInvalidReason: i.lastInvalidReason, lastCheck: i.lastCheck ?? null, lastCheckedAt: i.lastCheckedAt?.toISOString() ?? null,
      snippet: revoked ? null : this.snippet(i.siteKey), scriptUrl: this.scriptUrl(), sdkConfig: parseSdkConfig(i.sdkConfig ?? {}),
    };
  }

  private summary(w: WebsiteRow, s: SettingsSnapshot): WebsiteSummaryDto {
    const reg = w.domainClaim.domainRegistry;
    const last = [w.installation?.lastSeenAt, w.updatedAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
    return {
      id: w.id, name: w.name, displayHost: reg.displayHost, hostKey: reg.identityKey, status: w.status, category: w.category as WebsiteCategory,
      verification: this.claimDto(w, s).status, installation: this.state(w, s), trialOutcome: w.trialOutcome as TrialOutcome | null,
      createdAt: w.createdAt.toISOString(), lastActivityAt: last?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------- edit / delete
  async update(s: SessionContext, o: OrgContext, websiteId: string, input: { name?: string; description?: string | null; category?: string; monitoringTimezone?: string }, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const before = await this.load(tx, o.orgId, websiteId);
      await tx.website.update({ where: { id: websiteId }, data: input, select: { id: true } });
      const changes = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: v }]));
      await this.audit_(tx, s, o, "website.updated", websiteId, changes, client);
    });
    return this.detail(s, o, websiteId);
  }

  async remove(s: SessionContext, o: OrgContext, websiteId: string, confirmHost: string, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      if (confirmHost.toLowerCase() !== w.domainClaim.domainRegistry.identityKey && confirmHost !== w.domainClaim.domainRegistry.displayHost) {
        throw Errors.conflict("Type the website's domain to confirm deletion");
      }
      const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT archive_website(${websiteId}::uuid) AS ok`;
      if (!ok) throw Errors.forbidden();
      await this.audit_(tx, s, o, "website.deleted", websiteId, { identity: w.domainClaim.domainRegistry.identityKey }, client);
    });
  }

  // ---------------------------------------------------------------- verification
  async requestVerification(s: SessionContext, o: OrgContext, websiteId: string, method: "DNS_TXT" | "WELL_KNOWN_FILE" | "HTML_META" | "ANY", client: ClientInfo) {
    const settings = await this.settings.get();
    await this.rateLimit.hit("verify", websiteId, settings["verification.maxAttemptsPerHour"], 3600);
    const { claimId, token, revalidate } = await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const c = w.domainClaim;
      // Failing or lapsed ownership: re-check with the original method (restores monitoring on success).
      if (c.status === "LAPSED" || (c.status === "VERIFIED" && c.revalidationState === "FAILING")) {
        if (c.inheritedFromClaimId) throw Errors.conflict(`Ownership of this website follows ${w.domainClaim.domainRegistry.registrableDomain}; re-verify that website`);
        await this.audit_(tx, s, o, "website.revalidation_requested", websiteId, {}, client);
        return { claimId: c.id, token: c.verificationToken, revalidate: true };
      }
      if (c.status === "VERIFIED") throw Errors.conflict("This website is already verified");
      if (this.claimExpired(w)) throw new AppError(409, "VERIFICATION_EXPIRED", "The verification window expired. Restart verification to get a new token");
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT reserve_verification_attempt(${w.domainClaim.id}::uuid, ${settings["verification.maxAttemptsPerToken"]}::int) AS r`;
      if (r === "TOKEN_EXHAUSTED") throw new AppError(429, "TOKEN_EXHAUSTED", "Too many checks with this token. Generate a new verification token");
      if (r !== "OK") throw Errors.conflict(`Verification not possible (${r})`);
      await this.audit_(tx, s, o, "website.verification_requested", websiteId, { method }, client);
      return { claimId: w.domainClaim.id, token: w.domainClaim.verificationToken, revalidate: false };
    });
    if (revalidate) {
      const job = await this.revalidateQueue.add("REVALIDATE_DOMAIN", { kind: "REVALIDATE_DOMAIN", claimId, manual: true }, { removeOnComplete: { age: 3600 } });
      return { jobId: job.id ?? null, status: "QUEUED" as const, queue: "revalidate" as const };
    }
    const job = await this.verifyQueue.add("VERIFY_DOMAIN", { kind: "VERIFY_DOMAIN", claimId, websiteId, method, actorUserId: s.userId, token }, { removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } });
    return { jobId: job.id ?? null, status: "QUEUED" as const, queue: "verify" as const };
  }

  async regenerateToken(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    await this.rateLimit.hit("verify-token", websiteId, 10, 86_400);
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT regenerate_claim_token(${w.domainClaim.id}::uuid, ${generateVerificationToken()}) AS ok`;
      if (!ok) throw Errors.conflict("Only unverified, unexpired websites have a token to regenerate");
      await this.audit_(tx, s, o, "website.verification_token_regenerated", websiteId, {}, client);
    });
    return this.detail(s, o, websiteId);
  }

  async restartVerification(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    const settings = await this.settings.get();
    const outcome = await this.member(s, o, async (tx) => {
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT restart_website_claim(${websiteId}::uuid, ${generateVerificationToken()}, ${settings["domain.pendingClaimHours"]}::int, ${settings["websites.maxPendingPerOrg"]}::int) AS r`;
      if (r === "ACCEPTED" || r === "INHERITED_VERIFIED") await this.audit_(tx, s, o, "website.verification_restarted", websiteId, { outcome: r }, client);
      return r;
    });
    if (outcome === "NOT_FOUND") throw Errors.notFound();
    if (outcome === "NOT_EXPIRED") throw Errors.conflict("Verification has not expired");
    if (outcome === "DUPLICATE" || outcome === "DUPLICATE_NAMESPACE") throw new AppError(409, "DOMAIN_ALREADY_REGISTERED", "Another organization registered this domain after your claim expired", { canRequestTransfer: true });
    if (outcome === "LIMIT") throw new AppError(429, "WEBSITE_LIMIT", "Too many unverified websites");
    return this.detail(s, o, websiteId);
  }

  async verifications(s: SessionContext, o: OrgContext, websiteId: string): Promise<VerificationAttemptDto[]> {
    return this.member(s, o, async (tx) => {
      const w = await tx.website.findFirst({ where: { id: websiteId, orgId: o.orgId }, select: { domainClaimId: true } });
      if (!w) throw Errors.notFound();
      // Include earlier claims of this website's identity held by this org (restarts), never other orgs' (RLS).
      const rows = await tx.domainVerification.findMany({
        where: { orgId: o.orgId, domainClaim: { domainRegistry: { claims: { some: { id: w.domainClaimId } } } } },
        orderBy: { requestedAt: "desc" }, take: 100,
      });
      return rows.map((v) => ({ id: v.id, method: v.method, status: v.status, failureReason: v.failureReason, detail: v.detail, scopeGranted: v.scopeGranted, requestedAt: v.requestedAt.toISOString(), completedAt: v.completedAt?.toISOString() ?? null }));
    });
  }

  async registrationHistory(s: SessionContext, o: OrgContext, websiteId: string) {
    return this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const regId = w.domainClaim.domainRegistry.id;
      const claims = await tx.domainClaim.findMany({ where: { domainRegistryId: regId, orgId: o.orgId }, orderBy: { createdAt: "asc" },
        select: { id: true, status: true, scope: true, createdAt: true, verifiedAt: true, verifiedMethod: true, pendingExpiresAt: true, releasedAt: true, releaseReason: true } });
      const attempts = await tx.domainRegistrationAttempt.findMany({ where: { domainRegistryId: regId, orgId: o.orgId }, orderBy: { createdAt: "asc" }, select: { outcome: true, createdAt: true, inputHost: true } });
      return {
        claims: claims.map((c) => ({ ...c, createdAt: c.createdAt.toISOString(), verifiedAt: c.verifiedAt?.toISOString() ?? null, pendingExpiresAt: c.pendingExpiresAt?.toISOString() ?? null, releasedAt: c.releasedAt?.toISOString() ?? null })),
        attempts: attempts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
      };
    });
  }

  // ---------------------------------------------------------------- SDK installation
  async checkInstallation(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    await this.rateLimit.hit("install-check", websiteId, 10, 3600);
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      if (w.status !== "ACTIVE") throw Errors.conflict("Verify ownership before checking the installation");
      await this.audit_(tx, s, o, "website.installation_check_requested", websiteId, {}, client);
    });
    const job = await this.verifyQueue.add("CHECK_INSTALLATION", { kind: "CHECK_INSTALLATION", websiteId, actorUserId: s.userId }, { removeOnComplete: { age: 3600 } });
    return { jobId: job.id ?? null, status: "QUEUED" as const };
  }

  async regenerateKey(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    const settings = await this.settings.get();
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const i = w.installation!;
      const graceHours = i.revokedAt ? 0 : settings["sdk.keyRotationGraceHours"];
      await tx.siteInstallation.update({
        where: { websiteId },
        data: {
          siteKey: generateSiteKey(), keyCreatedAt: new Date(), revokedAt: null,
          previousSiteKey: graceHours > 0 ? i.siteKey : null,
          previousKeyExpiresAt: graceHours > 0 ? new Date(Date.now() + graceHours * 3_600_000) : null,
        },
        select: { id: true },
      });
      await this.audit_(tx, s, o, "website.site_key_regenerated", websiteId, { previousKeyGraceHours: graceHours }, client);
    });
    return this.detail(s, o, websiteId);
  }

  async revokeKey(s: SessionContext, o: OrgContext, websiteId: string, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      if (w.installation!.revokedAt) throw Errors.conflict("The site key is already revoked");
      await tx.siteInstallation.update({ where: { websiteId }, data: { revokedAt: new Date(), previousSiteKey: null, previousKeyExpiresAt: null }, select: { id: true } });
      await this.audit_(tx, s, o, "website.site_key_revoked", websiteId, {}, client);
    });
    return this.detail(s, o, websiteId);
  }

  // ---------------------------------------------------------------- monitoring (Phase 4B)
  async monitoring(s: SessionContext, o: OrgContext, websiteId: string): Promise<WebsiteMonitoringDto> {
    return this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const tiers = { T1_HTTP: "HTTP", T2_RENDER: "BROWSER", T3_DEEP: "DEEPSCAN" } as const;
      const schedules = await tx.monitoringSchedule.findMany({
        where: { websiteId, apiEndpointId: null, tier: { in: ["T1_HTTP", "T2_RENDER", "T3_DEEP"] } },
        select: { tier: true, status: true, pausedReason: true, intervalSec: true, nextRunAt: true, lastEnqueuedAt: true }, orderBy: { tier: "asc" },
      });
      const executions = await tx.$queryRaw<Array<{ id: string; tier: keyof typeof tiers; status: string; trigger: string; attempt: number; queued_at: Date; started_at: Date | null; finished_at: Date | null; duration_ms: number | null; failure_category: string | null }>>`
        SELECT id, tier::text AS tier, status::text AS status, trigger, attempt, queued_at, started_at, finished_at, duration_ms, failure_category
          FROM monitoring_executions
         WHERE website_id = ${websiteId}::uuid AND queued_at > now() - interval '7 days' AND tier IN ('T1_HTTP', 'T2_RENDER', 'T3_DEEP')
         ORDER BY queued_at DESC LIMIT 50`;
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      return {
        monitoringPaused: w.status === "PAUSED",
        schedules: schedules.map((x) => ({
          tier: tiers[x.tier as keyof typeof tiers], status: x.status, pausedReason: x.pausedReason, intervalSec: x.intervalSec,
          nextRunAt: x.status === "ACTIVE" ? x.nextRunAt.toISOString() : null, lastEnqueuedAt: iso(x.lastEnqueuedAt),
        })),
        executions: executions.map((e) => ({
          id: e.id, tier: tiers[e.tier], status: e.status, trigger: e.trigger, attempt: e.attempt, windowStart: e.queued_at.toISOString(),
          startedAt: iso(e.started_at), finishedAt: iso(e.finished_at), durationMs: e.duration_ms, failureCategory: e.failure_category,
        })),
      };
    });
  }

  /** Pause/resume all monitoring of a website. Pending work is cancelled in the same transaction (080_scheduler.sql). */
  async setMonitoringPaused(s: SessionContext, o: OrgContext, websiteId: string, paused: boolean, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      await this.load(tx, o.orgId, websiteId);
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT set_website_monitoring_paused(${websiteId}::uuid, ${paused}) AS r`;
      if (r === "NOT_FOUND") throw Errors.notFound();
      if (r === "NOT_ACTIVE") throw Errors.conflict("Only active, verified websites can be paused");
      if (r === "NOT_PAUSED") throw Errors.conflict("Monitoring is not paused");
      await this.audit_(tx, s, o, paused ? "website.monitoring_paused" : "website.monitoring_resumed", websiteId, {}, client);
    });
    return this.monitoring(s, o, websiteId);
  }

  async cancelExecution(s: SessionContext, o: OrgContext, websiteId: string, executionId: string, client: ClientInfo) {
    return this.member(s, o, async (tx) => {
      await this.load(tx, o.orgId, websiteId);
      const [own] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM monitoring_executions WHERE id = ${executionId}::uuid AND website_id = ${websiteId}::uuid AND queued_at > now() - interval '8 days'`;
      if (!own) throw Errors.notFound();
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT request_execution_cancel(${executionId}::uuid) AS r`;
      if (r === "NOT_FOUND") throw Errors.notFound();
      if (r === "NOT_CANCELLABLE") throw Errors.conflict("This execution has already finished");
      await this.audit_(tx, s, o, "website.execution_cancelled", websiteId, { executionId }, client);
      return { status: r as "CANCELLED" | "CANCEL_REQUESTED" };
    });
  }

  async setTelemetryPaused(s: SessionContext, o: OrgContext, websiteId: string, paused: boolean, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      await this.load(tx, o.orgId, websiteId);
      await tx.siteInstallation.update({ where: { websiteId }, data: { telemetryPaused: paused }, select: { id: true } });
      await this.audit_(tx, s, o, paused ? "website.telemetry_paused" : "website.telemetry_resumed", websiteId, {}, client);
    });
    return this.detail(s, o, websiteId);
  }

  async updateSdkConfig(s: SessionContext, o: OrgContext, websiteId: string, patch: Record<string, unknown>, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const w = await this.load(tx, o.orgId, websiteId);
      const before = parseSdkConfig(w.installation!.sdkConfig ?? {});
      const next = parseSdkConfig({ ...before, ...patch });
      await tx.siteInstallation.update({ where: { websiteId }, data: { sdkConfig: next as never }, select: { id: true } });
      await this.audit_(tx, s, o, "website.sdk_config_updated", websiteId, { changed: Object.keys(patch) }, client);
    });
    return this.detail(s, o, websiteId);
  }

  // ---------------------------------------------------------------- transfers (requester side)
  async requestTransfer(s: SessionContext, o: OrgContext, url: string, client: ClientInfo): Promise<TransferDto> {
    if (!s.emailVerified) throw Errors.emailNotVerified();
    await this.rateLimit.hit("transfer-request", o.orgId, 5, 86_400);
    const id = this.normalize(url, await this.normalizeOpts());
    const transferId = await this.member(s, o, async (tx) => {
      const [r] = await tx.$queryRaw<Array<{ outcome: string; transfer_id: string | null }>>`
        SELECT * FROM request_domain_transfer(${o.orgId}::uuid, ${id.identityKey}, ${generateVerificationToken()}, 72)`;
      if (r?.outcome !== "CREATED") return { error: String(r?.outcome ?? "ERROR") };
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "transfer.requested", targetType: "domain_transfer", targetId: r.transfer_id!, changes: { identity: id.identityKey }, client }, tx);
      return { id: r.transfer_id! };
    });
    if ("error" in transferId) {
      const msg: Record<string, string> = {
        UNCLAIMED: "This domain is not registered — add it as a website instead",
        YOURS: "This domain already belongs to your organization",
        PENDING_ELSEWHERE: "This domain has an unverified claim that expires soon; try again after it expires",
        ALREADY_REQUESTED: "You already have an open transfer request for this domain",
      };
      const reason = transferId.error ?? "ERROR";
      throw Errors.conflict(msg[reason] ?? "Transfer not possible", { reason });
    }
    return (await this.transfers(s, o)).find((t) => t.id === transferId.id)!;
  }

  async transfers(s: SessionContext, o: OrgContext): Promise<TransferDto[]> {
    const prefix = (await this.settings.get())["verification.prefix"];
    const rows = await this.member(s, o, (tx) => tx.domainTransfer.findMany({ where: { toOrgId: o.orgId }, orderBy: { createdAt: "desc" }, include: { domainRegistry: { select: { displayHost: true, identityKey: true } } } }));
    return rows.map((t) => ({
      id: t.id, displayHost: t.domainRegistry.displayHost, status: t.status, createdAt: t.createdAt.toISOString(), verifiedAt: t.verifiedAt?.toISOString() ?? null,
      decidedAt: t.decidedAt?.toISOString() ?? null, tokenExpiresAt: t.tokenExpiresAt?.toISOString() ?? null,
      record: t.status === "PENDING_VERIFICATION" && t.verificationToken
        ? { type: "TXT" as const, name: `_${prefix}-verification.${t.domainRegistry.identityKey}`, value: `${prefix}-transfer=${t.verificationToken}` } : null,
      lastCheckDetail: t.lastCheckDetail,
    }));
  }

  async verifyTransfer(s: SessionContext, o: OrgContext, transferId: string, client: ClientInfo) {
    await this.rateLimit.hit("transfer-verify", transferId, 10, 3600);
    await this.member(s, o, async (tx) => {
      const [{ r }] = await tx.$queryRaw<Array<{ r: string }>>`SELECT reserve_transfer_attempt(${transferId}::uuid, 30) AS r`;
      if (r === "NOT_FOUND") throw Errors.notFound();
      if (r !== "OK") throw Errors.conflict(`Transfer cannot be verified (${r})`);
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "transfer.verification_requested", targetType: "domain_transfer", targetId: transferId, client }, tx);
    });
    const job = await this.verifyQueue.add("VERIFY_TRANSFER", { kind: "VERIFY_TRANSFER", transferId, actorUserId: s.userId }, { removeOnComplete: { age: 3600 } });
    return { jobId: job.id ?? null, status: "QUEUED" as const };
  }

  async cancelTransfer(s: SessionContext, o: OrgContext, transferId: string, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT cancel_domain_transfer(${transferId}::uuid) AS ok`;
      if (!ok) throw Errors.notFound();
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "transfer.cancelled", targetType: "domain_transfer", targetId: transferId, client }, tx);
    });
  }

  // ---------------------------------------------------------------- transfers (current owner side)
  async incomingTransfers(s: SessionContext, o: OrgContext) {
    const rows = await this.member(s, o, (tx) => tx.$queryRaw<Array<{ id: string; website_id: string | null; display_host: string; status: string; owner_response: string | null; owner_respond_by: Date | null; created_at: Date }>>`
      SELECT * FROM incoming_domain_transfers()`);
    return rows.map((r) => ({ id: r.id, websiteId: r.website_id, displayHost: r.display_host, status: r.status, ownerResponse: r.owner_response, ownerRespondBy: r.owner_respond_by?.toISOString() ?? null, createdAt: r.created_at.toISOString() }));
  }

  async contestTransfer(s: SessionContext, o: OrgContext, transferId: string, client: ClientInfo) {
    await this.member(s, o, async (tx) => {
      const [{ ok }] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT contest_domain_transfer(${transferId}::uuid) AS ok`;
      if (!ok) throw Errors.notFound();
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "transfer.contested", targetType: "domain_transfer", targetId: transferId, client }, tx);
    });
  }

  async websiteAudit(s: SessionContext, o: OrgContext, websiteId: string) {
    return this.member(s, o, async (tx) => {
      await this.load(tx, o.orgId, websiteId);
      const rows = await tx.auditLog.findMany({ where: { stream: orgStream(o.orgId), targetId: websiteId }, orderBy: { id: "desc" }, take: 100 });
      return rows.map((r) => ({ id: String(r.id), occurredAt: r.occurredAt.toISOString(), actorType: r.actorType, actorLabel: r.actorLabel, action: r.action, changes: r.changes ?? null }));
    });
  }
}
