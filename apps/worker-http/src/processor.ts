import { generateSiteKey, generateVerificationToken, verificationInstructions, type SettingsSnapshot } from "@wim/core";
import { loadSettings, withSystem, type Db, type Tx } from "@wim/db";
import { VerifyJob, type EmailJob } from "@wim/contracts";
import type { Logger } from "@wim/logger";
import { checkDnsTxt, checkMetaTag, checkWellKnownFile, fetchPageForInstallCheck, findSdkScripts, type CheckContext, type CheckResult } from "./checks.js";
import { evaluateTrial } from "./trial.js";

export interface VerifyDeps {
  db: Db;
  log: Logger;
  ctx: CheckContext;
  /** Per-job check context (egress capability token bound to org/website/job). Defaults to ctx. */
  ctxFor?: (cap: { o: string | null; w: string | null; e: string; k: string }) => CheckContext;
  sdkUrl: string;
  /** Fetch the platform's own SDK script (trusted, deployment-configured URL; not customer input). */
  fetchSdk?: (url: string) => Promise<{ status: number; bytes: number }>;
  enqueueEmail: (job: EmailJob, id: string) => Promise<void>;
}

type Method = "DNS_TXT" | "WELL_KNOWN_FILE" | "HTML_META";

/** Audit rows are written by the worker in the org's stream (trigger assigns the hash chain). */
async function audit(tx: Tx, orgId: string, action: string, targetType: string, targetId: string, changes: Record<string, unknown>, actorId?: string) {
  await tx.auditLog.createMany({
    data: { stream: `org:${orgId}`, orgId, actorType: actorId ? "USER" : "SYSTEM", actorId: actorId ?? null, actorLabel: "verification-worker", action, targetType, targetId, changes: changes as never },
  });
}

export function createVerifyProcessor(deps: VerifyDeps) {
  const { db, log } = deps;
  const ctxFor = (o: string | null, w: string | null, e: string, k: string) => deps.ctxFor?.({ o, w, e, k }) ?? deps.ctx;

  return async function process(raw: unknown): Promise<Record<string, unknown>> {
    const job = VerifyJob.parse(raw);
    const s = await loadSettings(db);
    switch (job.kind) {
      case "VERIFY_DOMAIN": return verifyDomain(job, s);
      case "CHECK_INSTALLATION": return checkInstallation(job.websiteId, s);
      case "VERIFY_TRANSFER": return verifyTransfer(job.transferId, job.actorUserId, s);
      case "APPLY_TRANSFER": return applyTransfer(job.transferId, job.adminId, s);
      case "SWEEP_CLAIMS": {
        const n = await withSystem(db, async (tx) => (await tx.$queryRaw<Array<{ n: number }>>`SELECT expire_stale_domain_claims(NULL) AS n`)[0]!.n);
        return { expired: n };
      }
    }
  };

  // ---------------------------------------------------------------- ownership verification
  async function verifyDomain(job: Extract<VerifyJob, { kind: "VERIFY_DOMAIN" }>, s: SettingsSnapshot) {
    const claim = await withSystem(db, (tx) => tx.domainClaim.findUnique({
      where: { id: job.claimId },
      select: {
        id: true, orgId: true, status: true, verificationToken: true, pendingExpiresAt: true, scope: true, policy: true,
        domainRegistry: { select: { id: true, identityKey: true, registrableDomain: true, isRoot: true } },
        website: { select: { id: true, verifiedAt: true } },
      },
    }));
    if (!claim || !claim.orgId || claim.website?.id !== job.websiteId) return { status: "SKIPPED", reason: "claim not found" };
    const orgId = claim.orgId;
    const reg = claim.domainRegistry;
    const methods: Method[] = job.method === "ANY" ? ["DNS_TXT", "WELL_KNOWN_FILE", "HTML_META"] : [job.method];

    const record = async (method: Method, r: CheckResult | { ok: false; failureReason: string; detail: Record<string, unknown> }, scopeGranted: "ROOT" | "HOST" | null = null) =>
      withSystem(db, async (tx) => {
        const v = await tx.domainVerification.create({
          data: { orgId, domainClaimId: claim.id, method, status: r.ok ? "SUCCEEDED" : "FAILED", failureReason: r.failureReason, detail: r.detail as never, completedAt: new Date(), scopeGranted },
          select: { id: true },
        });
        if (!r.ok) await audit(tx, orgId, "website.verification_failed", "website", job.websiteId, { method, reason: r.failureReason }, job.actorUserId);
        return v.id;
      });

    // A token regenerated after this job was queued invalidates it (no verifying with a stale proof).
    if (claim.verificationToken !== job.token) {
      await record(methods[0]!, { ok: false, failureReason: "TOKEN_ROTATED", detail: {} });
      return { status: "FAILED", reason: "TOKEN_ROTATED" };
    }
    if (claim.status === "PENDING" && claim.pendingExpiresAt && claim.pendingExpiresAt <= new Date()) {
      await record(methods[0]!, { ok: false, failureReason: "VERIFICATION_EXPIRED", detail: { expiredAt: claim.pendingExpiresAt.toISOString() } });
      return { status: "FAILED", reason: "VERIFICATION_EXPIRED" };
    }
    if (claim.status !== "PENDING") return { status: "SKIPPED", reason: `claim is ${claim.status}` };

    const ins = verificationInstructions({ token: claim.verificationToken, hostKey: reg.identityKey, registrableDomain: reg.registrableDomain, prefix: s["verification.prefix"] });
    const ctx = ctxFor(orgId, job.websiteId, `verify:${claim.id}`, "verify");
    let success: { method: Method; result: CheckResult } | null = null;
    for (const method of methods) {
      let result: CheckResult;
      try {
        result = method === "DNS_TXT"
          ? await checkDnsTxt(ctx, { host: ins.dns.hostRecord.name, root: reg.isRoot ? null : ins.dns.rootRecord.name }, ins.value)
          : method === "WELL_KNOWN_FILE"
            ? await checkWellKnownFile(ctx, reg.identityKey, reg.identityKey, ins.file.path, ins.value)
            : await checkMetaTag(ctx, reg.identityKey, reg.identityKey, ins.meta.name, claim.verificationToken);
      } catch (e) {
        log.warn({ err: (e as Error).message, method }, "verification check error");
        result = { ok: false, failureReason: "CHECK_ERROR", detail: {} };
      }
      if (result.ok) { success = { method, result }; break; }
      await record(method, result);
    }
    if (!success) return { status: "FAILED" };

    // Commit: claim → VERIFIED, website → ACTIVE, first verification evaluates the trial. One transaction.
    const outcome = await withSystem(db, async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ status: string; pending_expires_at: Date | null; verification_token: string }>>`
        SELECT status, pending_expires_at, verification_token FROM domain_claims WHERE id = ${claim.id}::uuid FOR UPDATE`;
      if (!locked || locked.status !== "PENDING" || locked.verification_token !== job.token) return { ok: false as const, reason: "CLAIM_CHANGED" };
      if (locked.pending_expires_at && locked.pending_expires_at <= new Date()) return { ok: false as const, reason: "VERIFICATION_EXPIRED" };

      // ROOT scope (namespace reservation) only for the registrable domain itself, proven by DNS,
      // and only when no other org already holds a verified subdomain under it.
      let scope: "ROOT" | "HOST" = "HOST";
      if (reg.isRoot && success!.method === "DNS_TXT" && s["domain.policy"] === "ROOT_EXCLUSIVE") {
        const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id
           WHERE r.registrable_domain = ${reg.registrableDomain} AND c.status IN ('VERIFIED', 'LAPSED') AND c.org_id <> ${orgId}::uuid`;
        if (n === 0) scope = "ROOT";
      }
      await tx.domainClaim.update({
        where: { id: claim.id },
        data: {
          status: "VERIFIED", scope, verifiedAt: new Date(), verifiedMethod: success!.method, pendingExpiresAt: null, lastReverifiedAt: new Date(),
          revalidationState: "OK", nextRevalidationAt: new Date(Date.now() + s["revalidation.intervalHours"] * 3_600_000),
        },
        select: { id: true },
      });
      await tx.$executeRaw`UPDATE domain_registry SET first_verified_at = coalesce(first_verified_at, now()) WHERE id = ${reg.id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO domain_trial_ledger (registrable_domain, first_verified_at, updated_at) VALUES (${reg.registrableDomain}, now(), now())
        ON CONFLICT (registrable_domain) DO UPDATE SET first_verified_at = coalesce(domain_trial_ledger.first_verified_at, now()), updated_at = now()`;
      const firstVerification = claim.website?.verifiedAt == null;
      const trialOutcome = firstVerification ? await evaluateTrial(tx, orgId, reg.registrableDomain, s) : null;
      await tx.website.update({
        where: { id: job.websiteId },
        data: { status: "ACTIVE", verifiedAt: claim.website?.verifiedAt ?? new Date(), ...(trialOutcome ? { trialOutcome } : {}) },
        select: { id: true },
      });
      await tx.domainVerification.create({
        data: { orgId, domainClaimId: claim.id, method: success!.method, status: "SUCCEEDED", detail: success!.result.detail as never, completedAt: new Date(), scopeGranted: scope },
      });
      await audit(tx, orgId, "website.verified", "website", job.websiteId, { method: success!.method, scope, identity: reg.identityKey }, job.actorUserId);
      if (trialOutcome) await audit(tx, orgId, `trial.${trialOutcome.toLowerCase()}`, "website", job.websiteId, { registrableDomain: reg.registrableDomain, trialDays: s["trial.days"] });
      return { ok: true as const, scope, trialOutcome };
    });
    if (!outcome.ok) {
      await record(success.method, { ok: false, failureReason: outcome.reason, detail: {} });
      return { status: "FAILED", reason: outcome.reason };
    }
    return { status: "VERIFIED", method: success.method, ...outcome };
  }

  // ---------------------------------------------------------------- SDK installation check (diagnostic)
  async function checkInstallation(websiteId: string, _s: SettingsSnapshot) {
    const w = await withSystem(db, (tx) => tx.website.findUnique({
      where: { id: websiteId },
      select: { status: true, orgId: true, installation: { select: { siteKey: true, revokedAt: true } }, domainClaim: { select: { domainRegistry: { select: { identityKey: true } } } } },
    }));
    if (!w?.installation) return { status: "SKIPPED" };
    const identity = w.domainClaim.domainRegistry.identityKey;
    const result: Record<string, unknown> = { checkedAt: new Date().toISOString(), websiteVerified: w.status === "ACTIVE", keyRevoked: w.installation.revokedAt !== null };
    const { res, errors } = await fetchPageForInstallCheck(ctxFor(w.orgId, websiteId, `install:${websiteId}`, "verify"), identity, identity);
    result.pageReachable = Boolean(res && res.status === 200);
    result.pageStatus = res?.status ?? null;
    result.pageErrors = errors.map((e) => e.code);
    if (res && res.status === 200) {
      const scripts = findSdkScripts(res.body.toString("utf8"), res.finalUrl, deps.sdkUrl);
      result.scriptTagFound = scripts.length > 0;
      result.siteKeyMatches = scripts.some((sc) => sc.siteKey === w.installation!.siteKey);
      result.scriptTags = scripts.length;
      result.foundKeys = scripts.map((sc) => (sc.siteKey ? `${sc.siteKey.slice(0, 7)}…` : null));
      if (scripts[0]) {
        // The SDK URL is the platform's own (deployment config), so it is fetched directly.
        const probe = deps.fetchSdk ?? (async (u: string) => {
          const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
          return { status: r.status, bytes: (await r.arrayBuffer()).byteLength };
        });
        try {
          const p = await probe(new URL("monitor.v1.js", deps.sdkUrl.replace(/\/?$/, "/")).toString());
          result.scriptReachable = p.status === 200 && p.bytes > 0;
        } catch {
          result.scriptReachable = false;
        }
      }
    }
    await withSystem(db, (tx) => tx.siteInstallation.update({ where: { websiteId }, data: { lastCheck: result as never, lastCheckedAt: new Date() }, select: { id: true } }));
    return { status: "CHECKED", ...result };
  }

  // ---------------------------------------------------------------- transfers
  async function verifyTransfer(transferId: string, actorUserId: string, s: SettingsSnapshot) {
    const t = await withSystem(db, (tx) => tx.domainTransfer.findUnique({ where: { id: transferId }, include: { domainRegistry: true } }));
    if (!t || t.status !== "PENDING_VERIFICATION" || !t.verificationToken || !t.toOrgId) return { status: "SKIPPED" };
    if (t.tokenExpiresAt && t.tokenExpiresAt <= new Date()) return { status: "FAILED", reason: "EXPIRED" };
    const prefix = s["verification.prefix"];
    const value = `${prefix}-transfer=${t.verificationToken}`;
    const name = `_${prefix}-verification.${t.domainRegistry.identityKey}`;
    const r = await checkDnsTxt(ctxFor(t.toOrgId, null, `transfer:${transferId}`, "verify"), { host: name, root: null }, value);
    const respondBy = new Date(Date.now() + s["transfer.ownerResponseDays"] * 86_400_000);
    await withSystem(db, async (tx) => {
      await tx.domainTransfer.update({
        where: { id: transferId },
        data: r.ok
          ? { status: "PENDING_ADMIN", verifiedAt: new Date(), ownerResponse: "NONE", ownerRespondBy: respondBy, lastCheckDetail: r.detail as never }
          : { lastCheckDetail: { ...r.detail, failureReason: r.failureReason } as never },
      });
      await audit(tx, t.toOrgId!, r.ok ? "transfer.verified" : "transfer.verification_failed", "domain_transfer", transferId, { identity: t.domainRegistry.identityKey, reason: r.failureReason }, actorUserId);
      if (r.ok && t.fromOrgId) {
        // The current owner learns that a DNS-verified request exists — never who made it.
        await audit(tx, t.fromOrgId, "transfer.requested_against_domain", "domain_transfer", transferId, { identity: t.domainRegistry.identityKey, respondBy: respondBy.toISOString() });
      }
    });
    if (r.ok) await deps.enqueueEmail({ kind: "TRANSFER_REQUESTED", transferId }, `transfer-requested.${transferId}`);
    return { status: r.ok ? "VERIFIED" : "FAILED", reason: r.failureReason };
  }

  /** Approved by a Super Admin: move the identity to the requester. The old owner's data is never moved. */
  async function applyTransfer(transferId: string, adminId: string, s: SettingsSnapshot) {
    const result = await withSystem(db, async (tx) => {
      const [t] = await tx.$queryRaw<Array<{ id: string; status: string; applied_at: Date | null; to_org_id: string; from_claim_id: string | null; domain_registry_id: string }>>`
        SELECT id, status, applied_at, to_org_id, from_claim_id, domain_registry_id FROM domain_transfers WHERE id = ${transferId}::uuid FOR UPDATE`;
      if (!t || t.status !== "APPROVED" || t.applied_at) return null;
      const reg = await tx.domainRegistry.findUniqueOrThrow({ where: { id: t.domain_registry_id } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"domain:" + reg.registrableDomain}, 0))`;
      let fromOrg: string | null = null;
      if (t.from_claim_id) {
        const old = await tx.domainClaim.findUnique({ where: { id: t.from_claim_id }, select: { orgId: true, status: true, website: { select: { id: true } } } });
        fromOrg = old?.orgId ?? null;
        if (old && ["PENDING", "VERIFIED", "LAPSED"].includes(old.status)) {
          await tx.domainClaim.update({ where: { id: t.from_claim_id }, data: { status: "TRANSFERRED_OUT", releasedAt: new Date(), releaseReason: "TRANSFER" }, select: { id: true } });
        }
        if (old?.website) {
          await tx.website.update({ where: { id: old.website.id }, data: { status: "ARCHIVED", archivedAt: new Date() }, select: { id: true } });
          await tx.siteInstallation.updateMany({ where: { websiteId: old.website.id }, data: { revokedAt: new Date(), previousSiteKey: null, previousKeyExpiresAt: null } });
          if (fromOrg) await audit(tx, fromOrg, "website.transferred_out", "website", old.website.id, { identity: reg.identityKey });
        }
      }
      // Any other live claim (e.g. an expired-but-unswept pending one) is released too.
      await tx.domainClaim.updateMany({ where: { domainRegistryId: reg.id, status: { in: ["PENDING", "LAPSED"] } }, data: { status: "RELEASED", releasedAt: new Date(), releaseReason: "TRANSFER" } });
      const claim = await tx.domainClaim.create({
        data: { domainRegistryId: reg.id, orgId: t.to_org_id, scope: "HOST", status: "VERIFIED", policy: s["domain.policy"], verificationToken: generateVerificationToken(), verifiedAt: new Date(), verifiedMethod: "DNS_TXT" },
        select: { id: true },
      });
      const website = await tx.website.create({
        data: { orgId: t.to_org_id, domainClaimId: claim.id, name: reg.displayHost, canonicalOrigin: `https://${reg.identityKey}`, monitoringTimezone: s["platform.defaultTimezone"] },
        select: { id: true },
      });
      await tx.siteInstallation.create({ data: { orgId: t.to_org_id, websiteId: website.id, siteKey: generateSiteKey() } });
      const trialOutcome = await evaluateTrial(tx, t.to_org_id, reg.registrableDomain, s);
      await tx.website.update({ where: { id: website.id }, data: { verifiedAt: new Date(), trialOutcome }, select: { id: true } });
      await tx.domainTransfer.update({ where: { id: transferId }, data: { appliedAt: new Date(), toClaimId: claim.id, toWebsiteId: website.id } });
      await audit(tx, t.to_org_id, "website.transferred_in", "website", website.id, { identity: reg.identityKey, trialOutcome, approvedByAdmin: adminId });
      return { websiteId: website.id, trialOutcome };
    });
    if (!result) return { status: "SKIPPED" };
    await deps.enqueueEmail({ kind: "TRANSFER_DECIDED", transferId }, `transfer-decided.${transferId}`);
    return { status: "APPLIED", ...result };
  }
}
