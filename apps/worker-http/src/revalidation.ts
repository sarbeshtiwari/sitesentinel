import type { Redis } from "ioredis";
import { classifyVerificationFailure, decideRevalidation, verificationInstructions, type RevalidationPolicy, type SettingsSnapshot } from "@wim/core";
import { loadSettings, withSystem, type Db, type Tx } from "@wim/db";
import { RevalidateJob, type EmailJob } from "@wim/contracts";
import type { Logger } from "@wim/logger";
import { checkDnsTxt, checkMetaTag, checkWellKnownFile, type CheckContext, type CheckResult } from "./checks.js";

/**
 * Periodic ownership revalidation (ARCHITECTURE D-44). Re-checks a verified claim with
 * the method that originally verified it, then applies the policy decision from
 * @wim/core in one transaction (claim, website, inherited subdomain claims, history, audit).
 *
 * Concurrency: the sweep leases due claims (next_revalidation_at pushed forward under
 * FOR UPDATE SKIP LOCKED) and enqueues deterministic job ids; a Redis lock per claim
 * stops a manual "verify now" and a scheduled check running at the same time.
 */
export interface RevalidationDeps {
  db: Db;
  redis: Redis;
  log: Logger;
  ctxFor: (cap: { o: string | null; w: string | null; e: string; k: string }) => CheckContext;
  enqueue: (job: RevalidateJob, jobId: string) => Promise<void>;
  enqueueEmail: (job: EmailJob, id: string) => Promise<void>;
}

export function policyFrom(s: SettingsSnapshot): RevalidationPolicy {
  return {
    intervalHours: s["revalidation.intervalHours"], failingRetryHours: s["revalidation.failingRetryHours"],
    transientRetryMinutes: s["revalidation.transientRetryMinutes"], graceHours: s["revalidation.graceHours"],
    lapseReleaseDays: s["revalidation.lapseReleaseDays"], maxUnverifiableHours: s["revalidation.maxUnverifiableHours"],
  };
}

async function audit(tx: Tx, orgId: string, action: string, websiteId: string | null, changes: Record<string, unknown>) {
  await tx.auditLog.createMany({ data: { stream: `org:${orgId}`, orgId, actorType: "SYSTEM", actorLabel: "ownership-revalidation", action, targetType: "website", targetId: websiteId, changes: changes as never } });
}

export function createRevalidationProcessor(deps: RevalidationDeps) {
  const { db, log } = deps;

  return async function process(raw: unknown): Promise<Record<string, unknown>> {
    const job = RevalidateJob.parse(raw);
    const s = await loadSettings(db);
    if (job.kind === "SWEEP_REVALIDATION") return sweep(s);
    return revalidate(job.claimId, job.manual, s);
  };

  async function sweep(s: SettingsSnapshot) {
    if (!s["revalidation.enabled"]) return { enqueued: 0, disabled: true };
    const interval = s["revalidation.intervalHours"];
    // Lease: due claims get next_revalidation_at pushed 15 min ahead so overlapping sweeps can't double-enqueue.
    const due = await withSystem(db, (tx) => tx.$queryRaw<Array<{ id: string }>>`
      WITH due AS (
        SELECT id FROM domain_claims
         WHERE status IN ('VERIFIED', 'LAPSED') AND inherited_from_claim_id IS NULL AND org_id IS NOT NULL
           AND coalesce(next_revalidation_at, coalesce(last_reverified_at, verified_at) + make_interval(hours => ${interval}::int)) <= now()
         ORDER BY coalesce(next_revalidation_at, coalesce(last_reverified_at, verified_at)) ASC
         LIMIT ${s["revalidation.maxPerSweep"]}::int
         FOR UPDATE SKIP LOCKED)
      UPDATE domain_claims c SET next_revalidation_at = now() + interval '15 minutes'
        FROM due WHERE c.id = due.id
      RETURNING c.id`);
    const bucket = Math.floor(Date.now() / 600_000);
    for (const { id } of due) await deps.enqueue({ kind: "REVALIDATE_DOMAIN", claimId: id, manual: false }, `reval.${id}.${bucket}`);
    return { enqueued: due.length };
  }

  async function revalidate(claimId: string, manual: boolean, s: SettingsSnapshot): Promise<Record<string, unknown>> {
    const lockKey = `reval-lock:${claimId}`;
    if ((await deps.redis.set(lockKey, "1", "EX", 120, "NX")) !== "OK") return { status: "SKIPPED", reason: "already running" };
    try {
      const claim = await withSystem(db, (tx) => tx.domainClaim.findUnique({
        where: { id: claimId },
        select: {
          id: true, orgId: true, status: true, verifiedMethod: true, verificationToken: true, verifiedAt: true, lastReverifiedAt: true,
          revalidationState: true, failingSince: true, lapsedAt: true, revalidationFailures: true, transientFailures: true, inheritedFromClaimId: true,
          domainRegistry: { select: { identityKey: true, registrableDomain: true, isRoot: true, displayHost: true } },
          website: { select: { id: true, status: true } },
        },
      }));
      if (!claim?.orgId || !["VERIFIED", "LAPSED"].includes(claim.status) || claim.inheritedFromClaimId) return { status: "SKIPPED", reason: "not revalidatable" };
      const reg = claim.domainRegistry;
      const method = claim.verifiedMethod ?? "DNS_TXT";
      const ins = verificationInstructions({ token: claim.verificationToken, hostKey: reg.identityKey, registrableDomain: reg.registrableDomain, prefix: s["verification.prefix"] });
      const ctx = deps.ctxFor({ o: claim.orgId, w: claim.website?.id ?? null, e: `revalidate:${claimId}`, k: "revalidate" });
      let result: CheckResult;
      try {
        result = method === "WELL_KNOWN_FILE" ? await checkWellKnownFile(ctx, reg.identityKey, reg.identityKey, ins.file.path, ins.value)
          : method === "HTML_META" ? await checkMetaTag(ctx, reg.identityKey, reg.identityKey, ins.meta.name, claim.verificationToken)
          : await checkDnsTxt(ctx, { host: ins.dns.hostRecord.name, root: reg.isRoot ? null : ins.dns.rootRecord.name }, ins.value);
      } catch (e) {
        log.warn({ claimId, err: (e as Error).message }, "revalidation check error");
        result = { ok: false, failureReason: "CHECK_ERROR", detail: {} };
      }
      const outcome = result.ok ? "SUCCEEDED" : classifyVerificationFailure(result.failureReason);
      const now = new Date();
      const d = decideRevalidation({
        state: claim.revalidationState as "OK" | "FAILING" | "LAPSED", claimStatus: claim.status as "VERIFIED" | "LAPSED",
        failingSince: claim.failingSince, lapsedAt: claim.lapsedAt, lastSuccessAt: claim.lastReverifiedAt ?? claim.verifiedAt,
        revalidationFailures: claim.revalidationFailures, transientFailures: claim.transientFailures,
      }, outcome, policyFrom(s), now);

      const websiteIds = await withSystem(db, async (tx) => {
        // Inherited subdomain claims share this claim's fate.
        const inherited = await tx.domainClaim.findMany({ where: { inheritedFromClaimId: claimId, status: { in: ["VERIFIED", "LAPSED"] } }, select: { id: true, website: { select: { id: true } } } });
        const claimIds = [claimId, ...inherited.map((c) => c.id)];
        const sites = [claim.website?.id, ...inherited.map((c) => c.website?.id)].filter((x): x is string => Boolean(x));
        await tx.domainClaim.update({
          where: { id: claimId },
          data: {
            revalidationState: d.state === "RELEASED" ? "LAPSED" : d.state, lastRevalidationAt: now, lastRevalidationOutcome: d.outcome,
            revalidationFailures: d.revalidationFailures, transientFailures: d.transientFailures, failingSince: d.failingSince,
            nextRevalidationAt: d.nextCheckAt, ...(outcome === "SUCCEEDED" ? { lastReverifiedAt: now } : {}),
          },
          select: { id: true },
        });
        // History: the failure reason and resolver/HTTP metadata only — never the token.
        await tx.domainVerification.create({
          data: {
            orgId: claim.orgId!, domainClaimId: claimId, method, status: result.ok ? "SUCCEEDED" : "FAILED", failureReason: result.failureReason,
            detail: { ...result.detail, outcome: d.outcome, manual } as never, completedAt: now, isReverification: true,
          },
        });
        if (d.effect === "LAPSE") {
          await tx.domainClaim.updateMany({ where: { id: { in: claimIds } }, data: { status: "LAPSED", lapsedAt: now } });
          await tx.website.updateMany({ where: { id: { in: sites }, status: "ACTIVE" }, data: { status: "LAPSED" } });
          await audit(tx, claim.orgId!, "website.ownership_lapsed", claim.website?.id ?? null, { identity: reg.identityKey, inheritedWebsites: sites.length - 1 });
        } else if (d.effect === "RESTORE") {
          await tx.domainClaim.updateMany({ where: { id: { in: claimIds } }, data: { status: "VERIFIED", lapsedAt: null } });
          await tx.website.updateMany({ where: { id: { in: sites }, status: "LAPSED" }, data: { status: "ACTIVE" } });
          await audit(tx, claim.orgId!, "website.ownership_restored", claim.website?.id ?? null, { identity: reg.identityKey, manual });
        } else if (d.effect === "RELEASE") {
          await tx.domainClaim.updateMany({ where: { id: { in: claimIds } }, data: { status: "RELEASED", releasedAt: now, releaseReason: "LAPSED" } });
          await tx.website.updateMany({ where: { id: { in: sites } }, data: { status: "ARCHIVED", archivedAt: now } });
          await tx.siteInstallation.updateMany({ where: { websiteId: { in: sites } }, data: { revokedAt: now, previousSiteKey: null, previousKeyExpiresAt: null } });
          await tx.$executeRaw`UPDATE domain_trial_ledger SET last_released_at = now(), updated_at = now() WHERE registrable_domain = ${reg.registrableDomain}`;
          await audit(tx, claim.orgId!, "website.ownership_lost", claim.website?.id ?? null, { identity: reg.identityKey });
        } else if (d.effect === "NOTIFY_FAILING") {
          await audit(tx, claim.orgId!, "website.ownership_failing", claim.website?.id ?? null, { identity: reg.identityKey, reason: result.failureReason });
        }
        if (outcome === "SERVICE_UNAVAILABLE") {
          // Our own failure is observable to operators, never charged to the customer.
          await tx.systemHealthLog.createMany({ data: { component: "revalidation", metric: "service_unavailable", value: 1, labels: { reason: result.failureReason } as never } });
        }
        return sites;
      });
      const notice = { NOTIFY_FAILING: "FAILING", LAPSE: "LAPSED", RESTORE: "RESTORED", RELEASE: "LOST", NONE: null }[d.effect] as "FAILING" | "LAPSED" | "RESTORED" | "LOST" | null;
      if (notice) await deps.enqueueEmail({ kind: "OWNERSHIP_NOTICE", claimId, notice }, `ownership.${claimId}.${notice}.${Math.floor(now.getTime() / 60_000)}`);
      return { status: "REVALIDATED", outcome: d.outcome, state: d.state, effect: d.effect, failureReason: result.failureReason, websites: websiteIds.length };
    } finally {
      await deps.redis.del(lockKey);
    }
  }
}
