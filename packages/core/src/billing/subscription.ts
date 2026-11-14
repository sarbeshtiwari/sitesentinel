/**
 * Phase 8: subscription state machine (pure; no I/O). The gateway is the source of truth for money; this module
 * decides how a verified gateway fact changes OUR subscription row, and refuses facts that would move it backwards.
 *
 *   TRIALING ─▶ ACTIVE ─▶ PAST_DUE ─(grace elapses)─▶ EXPIRED
 *       │          │  ▲       │
 *       │          ▼  │       ▼
 *       └──────▶ CANCELING ─(period end)─▶ CANCELED
 *
 * CANCELED and EXPIRED are terminal: subscribing again creates a new subscription row (the partial unique index
 * `subscriptions_one_current_per_org` allows one non-terminal row per organisation).
 *
 * Out-of-order guard: every gateway fact carries the gateway's own timestamp (`at`). A fact older than the last one
 * applied (`gatewayUpdatedAt`) is ignored, so a delayed `payment_failed` can never undo a later `payment_succeeded`.
 */
export const SUBSCRIPTION_STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELING", "CANCELED", "EXPIRED"] as const;
export type SubStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<SubStatus> = new Set(["CANCELED", "EXPIRED"]);

const ALLOWED: Record<SubStatus, readonly SubStatus[]> = {
  TRIALING: ["ACTIVE", "PAST_DUE", "CANCELING", "CANCELED", "EXPIRED"],
  ACTIVE: ["PAST_DUE", "CANCELING", "CANCELED", "EXPIRED"],
  PAST_DUE: ["ACTIVE", "CANCELING", "CANCELED", "EXPIRED"],
  CANCELING: ["ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"],
  CANCELED: [],
  EXPIRED: [],
};

export function canTransition(from: SubStatus, to: SubStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export interface SubscriptionState {
  status: SubStatus;
  planId: string;
  planPriceId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  graceEndsAt: Date | null;
  pendingPlanPriceId: string | null;
  /** timestamp of the newest gateway fact applied (out-of-order guard) */
  gatewayUpdatedAt: Date | null;
}

export interface BillingPolicy {
  /** days of continued service after the first failed renewal (setting billing.graceDays) */
  graceDays: number;
}

/**
 * A verified, gateway-neutral fact. Adapters translate Stripe / Razorpay events into these.
 *  - SNAPSHOT: the gateway's current view of the subscription (status + period + plan), the common case
 *  - PAYMENT_SUCCEEDED / PAYMENT_FAILED: invoice outcomes (renewals, dunning retries)
 */
export type BillingFact =
  | {
    kind: "SNAPSHOT"; at: Date; status: SubStatus;
    currentPeriodStart?: Date | null; currentPeriodEnd?: Date | null; cancelAtPeriodEnd?: boolean;
    planId?: string; planPriceId?: string | null; pendingPlanPriceId?: string | null; canceledAt?: Date | null;
  }
  | { kind: "PAYMENT_SUCCEEDED"; at: Date; currentPeriodStart?: Date | null; currentPeriodEnd?: Date | null }
  | { kind: "PAYMENT_FAILED"; at: Date };

export type TransitionResult =
  | { applied: true; state: SubscriptionState; from: SubStatus; to: SubStatus }
  | { applied: false; reason: "STALE_EVENT" | "ILLEGAL_TRANSITION" | "TERMINAL"; state: SubscriptionState };

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Apply one gateway fact. Pure: returns the next state (or why the fact was ignored). */
export function applyBillingFact(prev: SubscriptionState, fact: BillingFact, policy: BillingPolicy): TransitionResult {
  if (prev.gatewayUpdatedAt && fact.at.getTime() < prev.gatewayUpdatedAt.getTime()) return { applied: false, reason: "STALE_EVENT", state: prev };
  if (TERMINAL_STATUSES.has(prev.status)) return { applied: false, reason: "TERMINAL", state: prev };

  let to: SubStatus;
  const next: SubscriptionState = { ...prev, gatewayUpdatedAt: fact.at };
  switch (fact.kind) {
    case "SNAPSHOT": {
      to = fact.status;
      if (fact.cancelAtPeriodEnd !== undefined) next.cancelAtPeriodEnd = fact.cancelAtPeriodEnd;
      // a subscription set to cancel at period end is CANCELING while it is otherwise in good standing
      if (next.cancelAtPeriodEnd && (to === "ACTIVE" || to === "TRIALING")) to = "CANCELING";
      if (!next.cancelAtPeriodEnd && to === "CANCELING") to = "ACTIVE";
      if (fact.currentPeriodStart !== undefined) next.currentPeriodStart = fact.currentPeriodStart;
      if (fact.currentPeriodEnd !== undefined) next.currentPeriodEnd = fact.currentPeriodEnd;
      if (fact.planId) next.planId = fact.planId;
      if (fact.planPriceId !== undefined) next.planPriceId = fact.planPriceId;
      if (fact.pendingPlanPriceId !== undefined) next.pendingPlanPriceId = fact.pendingPlanPriceId;
      // the scheduled downgrade has taken effect once the gateway reports the pending price as current
      if (next.pendingPlanPriceId && next.pendingPlanPriceId === next.planPriceId) next.pendingPlanPriceId = null;
      if (to === "CANCELED") next.canceledAt = fact.canceledAt ?? prev.canceledAt ?? fact.at;
      break;
    }
    case "PAYMENT_SUCCEEDED":
      to = prev.status === "PAST_DUE" || prev.status === "TRIALING" ? (prev.cancelAtPeriodEnd ? "CANCELING" : "ACTIVE") : prev.status;
      if (fact.currentPeriodStart !== undefined) next.currentPeriodStart = fact.currentPeriodStart;
      if (fact.currentPeriodEnd !== undefined) next.currentPeriodEnd = fact.currentPeriodEnd;
      break;
    case "PAYMENT_FAILED":
      to = "PAST_DUE";
      break;
  }
  if (!canTransition(prev.status, to)) return { applied: false, reason: "ILLEGAL_TRANSITION", state: prev };
  next.status = to;
  if (to === "PAST_DUE") next.graceEndsAt = prev.status === "PAST_DUE" && prev.graceEndsAt ? prev.graceEndsAt : addDays(fact.at, policy.graceDays);
  else next.graceEndsAt = null;
  return { applied: true, state: next, from: prev.status, to };
}

/**
 * Time-based transitions (the daily sweep, no gateway fact needed):
 *  - CANCELING whose paid period has ended → CANCELED
 *  - PAST_DUE whose grace period has elapsed → EXPIRED
 * Does not touch gatewayUpdatedAt (a later gateway fact still applies… unless the row became terminal).
 */
export function expireIfDue(prev: SubscriptionState, now: Date): TransitionResult {
  if (prev.status === "CANCELING" && prev.currentPeriodEnd && prev.currentPeriodEnd.getTime() <= now.getTime()) {
    return { applied: true, state: { ...prev, status: "CANCELED", canceledAt: prev.canceledAt ?? now, graceEndsAt: null }, from: prev.status, to: "CANCELED" };
  }
  if (prev.status === "PAST_DUE" && prev.graceEndsAt && prev.graceEndsAt.getTime() <= now.getTime()) {
    return { applied: true, state: { ...prev, status: "EXPIRED", graceEndsAt: null }, from: prev.status, to: "EXPIRED" };
  }
  return { applied: false, reason: "ILLEGAL_TRANSITION", state: prev };
}

/**
 * Dunning schedule: reminder days after the first failure (setting billing.dunning.reminderDays), limited to the
 * grace period. The gateway performs the actual payment retries (Stripe Smart Retries / Razorpay retry policy).
 */
export function dunningSchedule(pastDueSince: Date, reminderDays: readonly number[], graceDays: number): Date[] {
  return [...new Set(reminderDays)].filter((d) => d >= 0 && d <= graceDays).sort((a, b) => a - b).map((d) => addDays(pastDueSince, d));
}

/** The reminder due now (index into the schedule), or null. `sent` = reminders already sent for this past-due episode. */
export function nextDunningReminder(pastDueSince: Date, reminderDays: readonly number[], graceDays: number, sent: number, now: Date): number | null {
  const schedule = dunningSchedule(pastDueSince, reminderDays, graceDays);
  let due: number | null = null;
  for (let i = sent; i < schedule.length; i++) if (schedule[i]!.getTime() <= now.getTime()) due = i;
  return due;
}

/** Upgrade or downgrade, compared as a monthly-equivalent amount in the same currency. */
export function classifyPlanChange(
  current: { amountMinor: number; interval: "MONTH" | "YEAR"; currency: string },
  next: { amountMinor: number; interval: "MONTH" | "YEAR"; currency: string },
): "UPGRADE" | "DOWNGRADE" | "SAME" | "CURRENCY_MISMATCH" {
  if (current.currency !== next.currency) return "CURRENCY_MISMATCH";
  const monthly = (p: { amountMinor: number; interval: "MONTH" | "YEAR" }) => (p.interval === "YEAR" ? p.amountMinor / 12 : p.amountMinor);
  const a = monthly(current), b = monthly(next);
  if (b > a) return "UPGRADE";
  if (b < a) return "DOWNGRADE";
  return current.interval === next.interval ? "SAME" : next.interval === "YEAR" ? "UPGRADE" : "DOWNGRADE";
}
