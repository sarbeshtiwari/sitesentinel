import { describe, expect, it } from "vitest";
import {
  backoffDelay, defaultSettings, fairOrder, ineligibility, isMonitoringEntitled, jitterFor, resolveMonitoringLimits, windowStart,
  SETTINGS, type EligibilityFacts,
} from "../src/index.js";

const s = defaultSettings();

describe("windows", () => {
  it("are aligned to interval + jitter and identical for every caller inside the window", () => {
    const t0 = Date.UTC(2026, 10, 13, 10, 0, 0);
    expect(windowStart(t0 + 5_000, 60, 7)).toBe(t0 + 7_000 - 60_000);
    expect(windowStart(t0 + 7_000, 60, 7)).toBe(t0 + 7_000);
    expect(windowStart(t0 + 66_999, 60, 7)).toBe(t0 + 7_000);
    expect(windowStart(t0 + 67_000, 60, 7)).toBe(t0 + 67_000);
  });
  it("jitter is stable per schedule and spreads schedules over the interval", () => {
    expect(jitterFor("a", 60)).toBe(jitterFor("a", 60));
    const buckets = new Set(Array.from({ length: 500 }, (_, i) => jitterFor(`sched-${i}`, 60)));
    expect(buckets.size).toBeGreaterThan(50);
    for (const b of buckets) expect(b).toBeLessThan(60);
  });
});

describe("effective limits", () => {
  it("platform defaults: HTTP 60 s, browser 15 min, deep scan daily; all tiers disabled until their engines ship", () => {
    const l = resolveMonitoringLimits(s, null, {});
    expect(l.tiers).toEqual({ HTTP: { enabled: false, intervalSec: 60 }, BROWSER: { enabled: false, intervalSec: 900 }, DEEPSCAN: { enabled: false, intervalSec: 86_400 } });
    expect(SETTINGS["revalidation.intervalHours"].default).toBe(24);
  });
  it("admin settings change intervals and switches", () => {
    const l = resolveMonitoringLimits({ ...s, "monitoring.http.enabled": true, "monitoring.http.intervalSec": 120, "monitoring.deepscan.intervalSec": 3600 }, null, {});
    expect(l.tiers.HTTP).toEqual({ enabled: true, intervalSec: 120 });
    expect(l.tiers.DEEPSCAN.intervalSec).toBe(3600);
  });
  it("plan entitlements set a minimum interval; org overrides win over the plan", () => {
    const plan = { "monitoring.http.minIntervalSec": 300, "monitoring.maxWebsites": 5 };
    expect(resolveMonitoringLimits(s, plan, {}).tiers.HTTP.intervalSec).toBe(300);
    expect(resolveMonitoringLimits(s, plan, { "monitoring.http.minIntervalSec": 60 }).tiers.HTTP.intervalSec).toBe(60);
    expect(resolveMonitoringLimits(s, plan, {}).maxWebsites).toBe(5);
  });
  it("customers can ask for slower, never faster, than entitled", () => {
    const plan = { "monitoring.http.minIntervalSec": 300 };
    expect(resolveMonitoringLimits(s, plan, {}, { HTTP: 60 }).tiers.HTTP.intervalSec).toBe(300);
    expect(resolveMonitoringLimits(s, plan, {}, { HTTP: 900 }).tiers.HTTP.intervalSec).toBe(900);
  });
  it("ignores non-numeric entitlement values and clamps the fairness weight", () => {
    const l = resolveMonitoringLimits(s, { "monitoring.maxWebsites": "lots", "monitoring.weight": 500 }, {});
    expect(l.maxWebsites).toBe(s["monitoring.limits.maxWebsites"]);
    expect(l.weight).toBe(10);
  });
});

describe("entitlement", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  const later = new Date("2026-12-01T00:00:00Z");
  const earlier = new Date("2026-11-01T00:00:00Z");
  it.each([
    [{ trial: { status: "ACTIVE", endsAt: later }, subscription: null, override: null }, true],
    [{ trial: { status: "ACTIVE", endsAt: earlier }, subscription: null, override: null }, false], // expired trial
    [{ trial: { status: "EXPIRED", endsAt: earlier }, subscription: null, override: null }, false],
    [{ trial: null, subscription: null, override: null }, false],
    [{ trial: null, subscription: { status: "ACTIVE", currentPeriodEnd: later, graceEndsAt: null }, override: null }, true],
    [{ trial: null, subscription: { status: "PAST_DUE", currentPeriodEnd: earlier, graceEndsAt: later }, override: null }, true],
    [{ trial: null, subscription: { status: "PAST_DUE", currentPeriodEnd: earlier, graceEndsAt: earlier }, override: null }, false],
    [{ trial: null, subscription: { status: "CANCELING", currentPeriodEnd: later, graceEndsAt: null }, override: null }, true],
    [{ trial: null, subscription: { status: "EXPIRED", currentPeriodEnd: earlier, graceEndsAt: null }, override: null }, false],
    [{ trial: null, subscription: null, override: true }, true],
    [{ trial: { status: "ACTIVE", endsAt: later }, subscription: null, override: false }, false],
  ] as const)("%j → %s", (f, expected) => {
    expect(isMonitoringEntitled({ now, ...(f as never) }).entitled).toBe(expected);
  });
});

describe("eligibility", () => {
  const ok: EligibilityFacts = { websiteStatus: "ACTIVE", websiteArchived: false, claimStatus: "VERIFIED", orgStatus: "ACTIVE", entitled: true, tierEnabled: true, websiteRank: 1, maxWebsites: 25 };
  it.each([
    [{}, null],
    [{ orgStatus: "SUSPENDED" }, "ORG_SUSPENDED"],
    [{ websiteArchived: true }, "WEBSITE_INACTIVE"],
    [{ websiteStatus: "PAUSED" }, "WEBSITE_PAUSED"],
    [{ websiteStatus: "LAPSED", claimStatus: "LAPSED" }, "OWNERSHIP_LAPSED"],
    [{ websiteStatus: "PENDING_VERIFICATION", claimStatus: "PENDING" }, "WEBSITE_INACTIVE"],
    [{ websiteStatus: "SUSPENDED" }, "WEBSITE_INACTIVE"],
    [{ entitled: false }, "NOT_ENTITLED"],
    [{ tierEnabled: false }, "TIER_DISABLED"],
    [{ websiteRank: 26 }, "WEBSITE_LIMIT"],
  ] as const)("%j → %s", (patch, reason) => {
    expect(ineligibility({ ...ok, ...(patch as Partial<EligibilityFacts>) })).toBe(reason);
  });
});

describe("retry backoff", () => {
  it("is exponential, capped and fully jittered", () => {
    expect(backoffDelay(1, 1000, 60_000, () => 0.999)).toBe(999);
    expect(backoffDelay(4, 1000, 60_000, () => 0.999)).toBe(7992);
    expect(backoffDelay(20, 1000, 60_000, () => 0.999)).toBe(59_940);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBe(0);
    const spread = new Set(Array.from({ length: 200 }, () => backoffDelay(5, 1000, 60_000)));
    expect(spread.size).toBeGreaterThan(100); // a burst of failures does not retry in lock-step
  });
});

describe("fair dispatch", () => {
  const rows = [
    ...Array.from({ length: 1000 }, (_, i) => ({ orgId: "BIG", id: `big-${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ orgId: "small1", id: `s1-${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ orgId: "small2", id: `s2-${i}` })),
  ];
  it("a tenant with 1000 due websites cannot starve small tenants", () => {
    const out = fairOrder(rows, () => 10, () => 1, 12);
    const first = out.slice(0, 6).map((r) => r.orgId);
    expect(first).toEqual(["BIG", "small1", "small2", "BIG", "small1", "small2"]);
    expect(out.filter((r) => r.orgId === "small1")).toHaveLength(3);
  });
  it("respects per-org quota and weights", () => {
    const out = fairOrder(rows, (o) => (o === "BIG" ? 4 : 10), (o) => (o === "BIG" ? 2 : 1), 100);
    expect(out.filter((r) => r.orgId === "BIG")).toHaveLength(4);
    expect(out.length).toBe(10);
    expect(out.slice(0, 4).map((r) => r.orgId)).toEqual(["BIG", "BIG", "small1", "small2"]);
  });
});
