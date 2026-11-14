import { describe, expect, it } from "vitest";
import {
  applyBillingFact, canTransition, classifyPlanChange, dunningSchedule, expireIfDue, nextDunningReminder, selectPlanSource,
  validateEntitlements, ENTITLEMENT_KEY_TYPES, settingMeta, defaultSettings, type SubscriptionState,
} from "../src/index.js";

const T0 = new Date("2026-11-01T00:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const policy = { graceDays: 7 };
const base = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  status: "ACTIVE", planId: "p1", planPriceId: "pp1", currentPeriodStart: T0, currentPeriodEnd: at(720), cancelAtPeriodEnd: false,
  canceledAt: null, graceEndsAt: null, pendingPlanPriceId: null, gatewayUpdatedAt: T0, ...over,
});

describe("subscription state machine", () => {
  it("TRIALING → ACTIVE on first successful payment", () => {
    const r = applyBillingFact(base({ status: "TRIALING" }), { kind: "PAYMENT_SUCCEEDED", at: at(1), currentPeriodEnd: at(800) }, policy);
    expect(r.applied && r.to).toBe("ACTIVE");
    expect(r.state.currentPeriodEnd).toEqual(at(800));
  });

  it("ACTIVE → PAST_DUE on failure sets a grace period from settings; a retry keeps the original grace end", () => {
    const r1 = applyBillingFact(base(), { kind: "PAYMENT_FAILED", at: at(10) }, policy);
    expect(r1.applied && r1.to).toBe("PAST_DUE");
    expect(r1.state.graceEndsAt).toEqual(new Date(at(10).getTime() + 7 * 86_400_000));
    const r2 = applyBillingFact(r1.state, { kind: "PAYMENT_FAILED", at: at(50) }, policy);
    expect(r2.state.graceEndsAt).toEqual(r1.state.graceEndsAt);
  });

  it("PAST_DUE → ACTIVE on recovery clears the grace period", () => {
    const pd = applyBillingFact(base(), { kind: "PAYMENT_FAILED", at: at(10) }, policy).state;
    const r = applyBillingFact(pd, { kind: "PAYMENT_SUCCEEDED", at: at(20) }, policy);
    expect(r.applied && r.to).toBe("ACTIVE");
    expect(r.state.graceEndsAt).toBeNull();
  });

  it("PAST_DUE → EXPIRED when the grace period elapses (sweep)", () => {
    const pd = applyBillingFact(base(), { kind: "PAYMENT_FAILED", at: at(10) }, policy).state;
    expect(expireIfDue(pd, at(11)).applied).toBe(false);
    const r = expireIfDue(pd, at(10 + 7 * 24));
    expect(r.applied && r.to).toBe("EXPIRED");
  });

  it("cancel at period end → CANCELING → CANCELED at period end; resume returns to ACTIVE", () => {
    const c = applyBillingFact(base(), { kind: "SNAPSHOT", at: at(5), status: "ACTIVE", cancelAtPeriodEnd: true }, policy);
    expect(c.applied && c.to).toBe("CANCELING");
    const resumed = applyBillingFact(c.state, { kind: "SNAPSHOT", at: at(6), status: "ACTIVE", cancelAtPeriodEnd: false }, policy);
    expect(resumed.applied && resumed.to).toBe("ACTIVE");
    expect(expireIfDue(c.state, at(719)).applied).toBe(false);
    const ended = expireIfDue(c.state, at(720));
    expect(ended.applied && ended.to).toBe("CANCELED");
    expect(ended.state.canceledAt).toEqual(at(720));
  });

  it("terminal states never change again", () => {
    const canceled = base({ status: "CANCELED" });
    const r = applyBillingFact(canceled, { kind: "SNAPSHOT", at: at(100), status: "ACTIVE" }, policy);
    expect(r).toMatchObject({ applied: false, reason: "TERMINAL" });
    expect(canTransition("EXPIRED", "ACTIVE")).toBe(false);
    expect(canTransition("CANCELED", "PAST_DUE")).toBe(false);
  });

  it("out-of-order guard: an older event is ignored (a late failure cannot undo a newer success)", () => {
    const ok = applyBillingFact(base({ status: "PAST_DUE", graceEndsAt: at(200) }), { kind: "PAYMENT_SUCCEEDED", at: at(30) }, policy).state;
    expect(ok.status).toBe("ACTIVE");
    const late = applyBillingFact(ok, { kind: "PAYMENT_FAILED", at: at(20) }, policy);
    expect(late).toMatchObject({ applied: false, reason: "STALE_EVENT" });
    expect(late.state.status).toBe("ACTIVE");
  });

  it("an equal timestamp is applied (idempotent re-delivery of the same snapshot is harmless)", () => {
    const s = base({ gatewayUpdatedAt: at(5) });
    const r = applyBillingFact(s, { kind: "SNAPSHOT", at: at(5), status: "ACTIVE" }, policy);
    expect(r.applied).toBe(true);
    expect(r.state).toEqual({ ...s, gatewayUpdatedAt: at(5) });
  });

  it("upgrade applies the new plan immediately; a scheduled downgrade clears when it takes effect", () => {
    const up = applyBillingFact(base(), { kind: "SNAPSHOT", at: at(3), status: "ACTIVE", planId: "p2", planPriceId: "pp2" }, policy);
    expect(up.state.planId).toBe("p2");
    const sched = applyBillingFact(up.state, { kind: "SNAPSHOT", at: at(4), status: "ACTIVE", pendingPlanPriceId: "pp1" }, policy).state;
    expect(sched.pendingPlanPriceId).toBe("pp1");
    const done = applyBillingFact(sched, { kind: "SNAPSHOT", at: at(5), status: "ACTIVE", planId: "p1", planPriceId: "pp1" }, policy).state;
    expect(done.pendingPlanPriceId).toBeNull();
    expect(done.planId).toBe("p1");
  });

  it("classifies plan changes on a monthly-equivalent basis", () => {
    expect(classifyPlanChange({ amountMinor: 1000, interval: "MONTH", currency: "USD" }, { amountMinor: 2000, interval: "MONTH", currency: "USD" })).toBe("UPGRADE");
    expect(classifyPlanChange({ amountMinor: 2000, interval: "MONTH", currency: "USD" }, { amountMinor: 12000, interval: "YEAR", currency: "USD" })).toBe("DOWNGRADE");
    expect(classifyPlanChange({ amountMinor: 1000, interval: "MONTH", currency: "USD" }, { amountMinor: 12000, interval: "YEAR", currency: "USD" })).toBe("UPGRADE");
    expect(classifyPlanChange({ amountMinor: 1000, interval: "MONTH", currency: "USD" }, { amountMinor: 1000, interval: "MONTH", currency: "INR" })).toBe("CURRENCY_MISMATCH");
  });
});

describe("dunning", () => {
  it("schedules reminders within the grace period only", () => {
    expect(dunningSchedule(T0, [6, 0, 3, 3, 12], 7).map((d) => (d.getTime() - T0.getTime()) / 86_400_000)).toEqual([0, 3, 6]);
  });
  it("returns the latest due reminder not yet sent", () => {
    expect(nextDunningReminder(T0, [0, 3, 6], 7, 0, at(1))).toBe(0);
    expect(nextDunningReminder(T0, [0, 3, 6], 7, 1, at(1))).toBeNull();
    expect(nextDunningReminder(T0, [0, 3, 6], 7, 1, at(24 * 7))).toBe(2);
  });
});

describe("entitlement plan source (D-43)", () => {
  const now = at(0);
  const trial = { status: "ACTIVE", endsAt: at(100), planId: null };
  it("billing disabled: identical to the pre-Phase-8 behaviour (subscription plan or platform defaults; no trial/free plan)", () => {
    expect(selectPlanSource({ billingEnabled: false, now, subscription: null, trial, trialPlanId: "pro", freePlanId: "free" })).toEqual({ source: "PLATFORM_DEFAULTS", planId: null });
    expect(selectPlanSource({ billingEnabled: false, now, subscription: { status: "ACTIVE", planId: "p" }, trial, trialPlanId: "pro", freePlanId: null })).toEqual({ source: "SUBSCRIPTION", planId: "p" });
  });
  it("billing enabled: subscription > active trial > free plan > defaults", () => {
    expect(selectPlanSource({ billingEnabled: true, now, subscription: { status: "PAST_DUE", planId: "p" }, trial, trialPlanId: "pro", freePlanId: "free" }).source).toBe("SUBSCRIPTION");
    expect(selectPlanSource({ billingEnabled: true, now, subscription: { status: "EXPIRED", planId: "p" }, trial, trialPlanId: "pro", freePlanId: "free" })).toEqual({ source: "TRIAL", planId: "pro" });
    expect(selectPlanSource({ billingEnabled: true, now, subscription: null, trial: { ...trial, planId: "biz" }, trialPlanId: "pro", freePlanId: null })).toEqual({ source: "TRIAL", planId: "biz" });
    expect(selectPlanSource({ billingEnabled: true, now: at(200), subscription: null, trial, trialPlanId: "pro", freePlanId: "free" })).toEqual({ source: "FREE", planId: "free" });
    expect(selectPlanSource({ billingEnabled: true, now: at(200), subscription: null, trial, trialPlanId: "pro", freePlanId: null })).toEqual({ source: "PLATFORM_DEFAULTS", planId: null });
  });
  it("validates entitlement maps against the registry", () => {
    expect(validateEntitlements({ "monitoring.maxWebsites": 5, "monitoring.browser.entitled": true })).toEqual([]);
    expect(validateEntitlements({ "monitoring.maxWebsites": -1 })).toHaveLength(1);
    expect(validateEntitlements({ "monitoring.browser.entitled": 1 })).toHaveLength(1);
    expect(validateEntitlements({ "nope.key": 1 })).toHaveLength(1);
    expect(ENTITLEMENT_KEY_TYPES.find((e) => e.key === "monitoring.entitled")?.type).toBe("boolean");
  });
  it("billing is off by default and its switch is a protected feature setting", () => {
    expect(defaultSettings()["billing.enabled"]).toBe(false);
    expect(settingMeta("billing.enabled")).toMatchObject({ protected: true, section: "features" });
  });
});
