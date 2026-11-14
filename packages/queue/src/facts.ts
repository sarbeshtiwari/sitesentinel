import {
  ineligibility, isMonitoringEntitled, MONITORING_ENTITLEMENT_KEYS, resolveMonitoringLimits, selectPlanSource, type EntitlementSource,
  type MonitoringEntitlementKey, type MonitoringLimits, type MonitoringTier, type PausedReason, type SettingsSnapshot,
} from "@wim/core";
import type { Tx } from "@wim/db";

/**
 * Trusted monitoring facts, read in a system-context transaction. Used by the
 * scheduler (sync/dispatch) AND by workers immediately before execution, so a job
 * that was valid when scheduled is re-checked against current state.
 */
export interface WebsiteFacts {
  websiteId: string;
  orgId: string;
  websiteStatus: string;
  archived: boolean;
  claimStatus: string;
  orgStatus: string;
  rank: number;
  /** browser websites are ranked separately (oldest opted-in websites first) for the browser website cap */
  browserRank: number;
  browserEnabled: boolean;
  deepRank: number;
  deepPaused: boolean;
  requested: Partial<Record<MonitoringTier, number | null>>;
}

export interface OrgContext {
  limits: MonitoringLimits;
  entitled: boolean;
  entitlementReason: string;
  /** Phase 8: where the plan entitlements came from */
  planSource: EntitlementSource;
  planId: string | null;
}

export async function loadWebsiteFacts(tx: Tx, websiteIds?: string[]): Promise<WebsiteFacts[]> {
  const rows = await tx.$queryRaw<Array<{
    website_id: string; org_id: string; website_status: string; archived: boolean; claim_status: string; org_status: string; rank: bigint;
    browser_rank: bigint; browser_enabled: boolean; deep_rank: bigint; deep_paused: boolean;
    t1: number | null; t2: number | null; t3: number | null;
  }>>`
    SELECT w.id AS website_id, w.org_id, w.status::text AS website_status, w.archived_at IS NOT NULL AS archived,
           c.status::text AS claim_status, o.status::text AS org_status,
           -- websites count towards the limit oldest-first; archived and unverified ones don't count
           CASE WHEN w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED')
                THEN row_number() OVER (PARTITION BY w.org_id, (w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED')) ORDER BY w.created_at, w.id)
                ELSE 0 END AS rank,
           CASE WHEN w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED') AND coalesce((mc.browser_check ->> 'enabled')::boolean, true)
                THEN row_number() OVER (PARTITION BY w.org_id, (w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED') AND coalesce((mc.browser_check ->> 'enabled')::boolean, true)) ORDER BY w.created_at, w.id)
                ELSE 0 END AS browser_rank,
           coalesce((mc.browser_check ->> 'enabled')::boolean, true) AS browser_enabled,
           CASE WHEN w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED') AND NOT coalesce((mc.deep_scan ->> 'paused')::boolean, false)
                THEN row_number() OVER (PARTITION BY w.org_id, (w.archived_at IS NULL AND w.status IN ('ACTIVE', 'PAUSED', 'LAPSED') AND NOT coalesce((mc.deep_scan ->> 'paused')::boolean, false)) ORDER BY w.created_at, w.id)
                ELSE 0 END AS deep_rank,
           coalesce((mc.deep_scan ->> 'paused')::boolean, false) AS deep_paused,
           mc.t1_interval_sec AS t1, mc.t2_interval_sec AS t2, mc.t3_interval_sec AS t3
      FROM websites w
      JOIN domain_claims c ON c.id = w.domain_claim_id
      JOIN organizations o ON o.id = w.org_id
      LEFT JOIN monitoring_configurations mc ON mc.website_id = w.id
     WHERE (${websiteIds ?? null}::uuid[] IS NULL OR w.id = ANY(${websiteIds ?? null}::uuid[]))
     ORDER BY w.id`;
  return rows.map((r) => ({
    websiteId: r.website_id, orgId: r.org_id, websiteStatus: r.website_status, archived: r.archived, claimStatus: r.claim_status,
    orgStatus: r.org_status, rank: Number(r.rank), browserRank: Number(r.browser_rank), browserEnabled: r.browser_enabled, deepRank: Number(r.deep_rank), deepPaused: r.deep_paused, requested: { HTTP: r.t1, BROWSER: r.t2, DEEPSCAN: r.t3 },
  }));
}

/**
 * Effective limits and entitlement per organization (plan ⊕ overrides ⊕ settings).
 * Phase 8 (D-43): which plan applies is decided by selectPlanSource — with billing disabled this is exactly the
 * pre-Phase-8 behaviour; with billing enabled an active trial uses the trial plan and organisations without a
 * subscription or trial fall back to the free plan (billing.freePlanKey) when one is configured. Everything is read
 * fresh on every call (scheduler cycle / job start), so admin edits to plans and overrides apply without a redeploy.
 */
export async function loadOrgContexts(tx: Tx, orgIds: string[], s: SettingsSnapshot, now = new Date()): Promise<Map<string, OrgContext>> {
  const out = new Map<string, OrgContext>();
  if (!orgIds.length) return out;
  const billing = Boolean(s["billing.enabled"]);
  const trials = await tx.trial.findMany({
    where: { orgId: { in: orgIds } },
    select: billing ? { orgId: true, status: true, endsAt: true, planId: true } : { orgId: true, status: true, endsAt: true },
  }) as Array<{ orgId: string; status: string; endsAt: Date; planId?: string | null }>;
  const subs = await tx.subscription.findMany({
    where: { orgId: { in: orgIds }, status: { notIn: ["CANCELED", "EXPIRED"] } },
    select: { orgId: true, status: true, currentPeriodEnd: true, graceEndsAt: true, planId: true },
  });
  let trialPlanId: string | null = null, freePlanId: string | null = null;
  if (billing) {
    const keys = [s["trial.planKey"], s["billing.freePlanKey"]].filter((k): k is string => typeof k === "string");
    const plans = keys.length ? await tx.subscriptionPlan.findMany({ where: { key: { in: keys }, active: true }, select: { id: true, key: true } }) : [];
    trialPlanId = plans.find((p) => p.key === s["trial.planKey"])?.id ?? null;
    freePlanId = plans.find((p) => p.key === s["billing.freePlanKey"])?.id ?? null;
  }
  const sources = new Map(orgIds.map((orgId) => {
    const sub = subs.find((x) => x.orgId === orgId) ?? null;
    const t = trials.find((x) => x.orgId === orgId) ?? null;
    return [orgId, selectPlanSource({
      billingEnabled: billing, now, subscription: sub, trialPlanId, freePlanId,
      trial: t ? { status: t.status, endsAt: t.endsAt, planId: t.planId ?? null } : null,
    })] as const;
  }));
  const planIds = [...new Set([...sources.values()].map((x) => x.planId).filter((x): x is string => !!x))];
  const ents = planIds.length ? await tx.planEntitlement.findMany({ where: { planId: { in: planIds }, key: { in: [...MONITORING_ENTITLEMENT_KEYS] } } }) : [];
  const overrides = await tx.entitlementOverride.findMany({
    where: { orgId: { in: orgIds }, key: { in: [...MONITORING_ENTITLEMENT_KEYS] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { orgId: true, key: true, value: true },
  });
  for (const orgId of orgIds) {
    const sub = subs.find((x) => x.orgId === orgId) ?? null;
    const src = sources.get(orgId)!;
    const plan = src.planId ? Object.fromEntries(ents.filter((e) => e.planId === src.planId).map((e) => [e.key, e.value])) as Partial<Record<MonitoringEntitlementKey, unknown>> : null;
    const ov = Object.fromEntries(overrides.filter((o) => o.orgId === orgId).map((o) => [o.key, o.value])) as Partial<Record<MonitoringEntitlementKey, unknown>>;
    const trial = trials.find((t) => t.orgId === orgId) ?? null;
    // the free plan grants monitoring unless the plan itself (or an override) says otherwise
    const freeGrant = src.source === "FREE" && plan?.["monitoring.entitled"] !== false;
    const override = typeof ov["monitoring.entitled"] === "boolean" ? (ov["monitoring.entitled"] as boolean) : null;
    let e = isMonitoringEntitled({ now, trial, subscription: sub, override });
    if (!e.entitled && override === null && freeGrant) e = { entitled: true, reason: "FREE_PLAN" };
    out.set(orgId, { limits: resolveMonitoringLimits(s, plan, ov), entitled: e.entitled, entitlementReason: e.reason, planSource: src.source, planId: src.planId });
  }
  return out;
}

export function evaluate(w: WebsiteFacts, org: OrgContext, tier: MonitoringTier): { reason: PausedReason | null; intervalSec: number } {
  const limits = { ...org.limits, tiers: { ...org.limits.tiers } };
  const tierLimits = limits.tiers[tier];
  // The customer's requested interval can only slow a tier down (resolved against the entitled minimum).
  const requested = w.requested[tier];
  const intervalSec = requested && requested > tierLimits.intervalSec ? requested : tierLimits.intervalSec;
  const reason = ineligibility({
    websiteStatus: w.websiteStatus, websiteArchived: w.archived, claimStatus: w.claimStatus, orgStatus: w.orgStatus,
    entitled: org.entitled, tierEnabled: tierLimits.enabled,
    customerDisabled: (tier === "BROWSER" && !w.browserEnabled) || (tier === "DEEPSCAN" && w.deepPaused),
    websiteRank: (tier === "BROWSER" ? w.browserRank : tier === "DEEPSCAN" ? w.deepRank : w.rank) || Number.MAX_SAFE_INTEGER,
    maxWebsites: tier === "BROWSER" ? Math.min(limits.maxWebsites, limits.browser.maxWebsites)
      : tier === "DEEPSCAN" ? Math.min(limits.maxWebsites, limits.deepscan.maxWebsites) : limits.maxWebsites,
  });
  return { reason, intervalSec };
}
