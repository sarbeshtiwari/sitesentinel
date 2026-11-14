import { MONITORING_ENTITLEMENT_KEYS, type MonitoringEntitlementKey } from "../monitoring/scheduling.js";

/**
 * Phase 8: which plan's entitlements apply to an organisation (D-43). Pure.
 *
 * Billing disabled (`billing.enabled = false`): exactly the pre-Phase-8 behaviour — the plan of a current
 * subscription if there is one, otherwise platform defaults. Billing enabled:
 *   1. a current subscription (not CANCELED/EXPIRED)  → its plan
 *   2. an active, unexpired trial                     → the trial's plan (trials.plan_id, else setting trial.planKey)
 *   3. a free plan configured (billing.freePlanKey)    → the free plan (monitoring entitled unless the plan says otherwise)
 *   4. otherwise                                       → platform defaults (settings)
 * Org overrides (entitlement_overrides) are applied on top by resolveMonitoringLimits in every case.
 */
export type EntitlementSource = "SUBSCRIPTION" | "TRIAL" | "FREE" | "PLATFORM_DEFAULTS";

export interface PlanSourceFacts {
  billingEnabled: boolean;
  now: Date;
  subscription: { status: string; planId: string } | null;
  trial: { status: string; endsAt: Date; planId: string | null } | null;
  trialPlanId: string | null;
  freePlanId: string | null;
}

export function selectPlanSource(f: PlanSourceFacts): { source: EntitlementSource; planId: string | null } {
  const current = f.subscription && f.subscription.status !== "CANCELED" && f.subscription.status !== "EXPIRED" ? f.subscription : null;
  if (!f.billingEnabled) return current ? { source: "SUBSCRIPTION", planId: current.planId } : { source: "PLATFORM_DEFAULTS", planId: null };
  if (current) return { source: "SUBSCRIPTION", planId: current.planId };
  if (f.trial && f.trial.status === "ACTIVE" && f.trial.endsAt.getTime() > f.now.getTime()) {
    const planId = f.trial.planId ?? f.trialPlanId;
    return { source: "TRIAL", planId };
  }
  if (f.freePlanId) return { source: "FREE", planId: f.freePlanId };
  return { source: "PLATFORM_DEFAULTS", planId: null };
}

/** Entitlement keys a plan or override may set, with their value type (admin editors validate against this). */
const BOOLEAN_KEYS = new Set<MonitoringEntitlementKey>([
  "monitoring.entitled", "monitoring.browser.entitled", "monitoring.deepscan.entitled", "monitoring.deepscan.externalLinks",
  "monitoring.performance.customThresholds",
]);
export const ENTITLEMENT_KEY_TYPES: ReadonlyArray<{ key: MonitoringEntitlementKey; type: "number" | "boolean" }> =
  MONITORING_ENTITLEMENT_KEYS.map((key) => ({ key, type: BOOLEAN_KEYS.has(key) ? "boolean" : "number" }));

/** Validate a plan/override entitlement map; returns the issues (empty = valid). */
export function validateEntitlements(input: Record<string, unknown>): string[] {
  const types = new Map(ENTITLEMENT_KEY_TYPES.map((e) => [e.key as string, e.type]));
  const issues: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const t = types.get(k);
    if (!t) { issues.push(`${k}: unknown entitlement key`); continue; }
    if (t === "boolean" && typeof v !== "boolean") issues.push(`${k}: must be true or false`);
    if (t === "number" && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v))) issues.push(`${k}: must be a non-negative integer`);
  }
  return issues;
}
