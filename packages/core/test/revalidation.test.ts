import { describe, expect, it } from "vitest";
import { classifyVerificationFailure, decideRevalidation, defaultSettings, type ClaimRevalidationFacts, type RevalidationPolicy } from "../src/index.js";

const s = defaultSettings();
const p: RevalidationPolicy = {
  intervalHours: s["revalidation.intervalHours"], failingRetryHours: s["revalidation.failingRetryHours"], transientRetryMinutes: s["revalidation.transientRetryMinutes"],
  graceHours: s["revalidation.graceHours"], lapseReleaseDays: s["revalidation.lapseReleaseDays"], maxUnverifiableHours: s["revalidation.maxUnverifiableHours"],
};
const now = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);
const ok: ClaimRevalidationFacts = { state: "OK", claimStatus: "VERIFIED", failingSince: null, lapsedAt: null, lastSuccessAt: hoursAgo(24), revalidationFailures: 0, transientFailures: 0 };

describe("failure classification", () => {
  it.each([
    ["DNS_RECORD_NOT_FOUND", "DEFINITIVE_FAILURE"], ["TOKEN_NOT_FOUND_IN_FILE", "DEFINITIVE_FAILURE"], ["META_TOKEN_MISMATCH", "DEFINITIVE_FAILURE"],
    ["HTTP_404", "DEFINITIVE_FAILURE"], ["BLOCKED_DESTINATION", "DEFINITIVE_FAILURE"], ["HOST_NOT_FOUND", "DEFINITIVE_FAILURE"],
    ["DNS_UNAVAILABLE", "TEMPORARY_FAILURE"], ["DNS_PROPAGATING", "TEMPORARY_FAILURE"], ["SITE_UNREACHABLE", "TEMPORARY_FAILURE"], ["HTTP_503", "TEMPORARY_FAILURE"],
    ["SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE"], ["CHECK_ERROR", "SERVICE_UNAVAILABLE"], [null, "SUCCEEDED"],
  ])("%s → %s", (reason, outcome) => expect(classifyVerificationFailure(reason)).toBe(outcome));
});

describe("revalidation state machine", () => {
  it("defaults: every 24 h, 72 h grace, 30-day release", () => {
    expect([p.intervalHours, p.graceHours, p.lapseReleaseDays]).toEqual([24, 72, 30]);
    expect(decideRevalidation(ok, "SUCCEEDED", p, now)).toMatchObject({ state: "OK", effect: "NONE", nextCheckAt: new Date(now.getTime() + 24 * 3_600_000) });
  });
  it("a temporary DNS outage never advances the state", () => {
    const d = decideRevalidation(ok, "TEMPORARY_FAILURE", p, now);
    expect(d).toMatchObject({ state: "OK", claimStatus: "VERIFIED", effect: "NONE", transientFailures: 1, revalidationFailures: 0 });
    expect(d.nextCheckAt.getTime() - now.getTime()).toBe(30 * 60_000);
  });
  it("our own outage is not counted at all", () => {
    expect(decideRevalidation({ ...ok, transientFailures: 3 }, "SERVICE_UNAVAILABLE", p, now)).toMatchObject({ state: "OK", transientFailures: 3, revalidationFailures: 0, effect: "NONE" });
  });
  it("first definitive failure → FAILING + notify; still verified (monitoring continues)", () => {
    expect(decideRevalidation(ok, "DEFINITIVE_FAILURE", p, now)).toMatchObject({ state: "FAILING", claimStatus: "VERIFIED", effect: "NOTIFY_FAILING", failingSince: now, revalidationFailures: 1 });
  });
  it("within grace: stays FAILING without repeated notifications", () => {
    const f = { ...ok, state: "FAILING" as const, failingSince: hoursAgo(48), revalidationFailures: 4 };
    expect(decideRevalidation(f, "DEFINITIVE_FAILURE", p, now)).toMatchObject({ state: "FAILING", effect: "NONE", revalidationFailures: 5 });
  });
  it("grace exhausted → LAPSED (monitoring suspended)", () => {
    const f = { ...ok, state: "FAILING" as const, failingSince: hoursAgo(73), revalidationFailures: 8 };
    expect(decideRevalidation(f, "DEFINITIVE_FAILURE", p, now)).toMatchObject({ state: "LAPSED", claimStatus: "LAPSED", effect: "LAPSE" });
  });
  it("lapsed for the release period → RELEASED (ownership lost)", () => {
    const f = { ...ok, state: "LAPSED" as const, claimStatus: "LAPSED" as const, failingSince: hoursAgo(800), lapsedAt: hoursAgo(31 * 24) };
    expect(decideRevalidation(f, "DEFINITIVE_FAILURE", p, now)).toMatchObject({ state: "RELEASED", claimStatus: "RELEASED", effect: "RELEASE" });
    expect(decideRevalidation({ ...f, lapsedAt: hoursAgo(5 * 24) }, "DEFINITIVE_FAILURE", p, now)).toMatchObject({ state: "LAPSED", effect: "NONE" });
  });
  it("success from FAILING or LAPSED restores", () => {
    expect(decideRevalidation({ ...ok, state: "FAILING", failingSince: hoursAgo(10) }, "SUCCEEDED", p, now)).toMatchObject({ state: "OK", claimStatus: "VERIFIED", effect: "RESTORE", failingSince: null });
    expect(decideRevalidation({ ...ok, state: "LAPSED", claimStatus: "LAPSED", lapsedAt: hoursAgo(48) }, "SUCCEEDED", p, now)).toMatchObject({ state: "OK", claimStatus: "VERIFIED", effect: "RESTORE" });
  });
  it("temporary failures for longer than maxUnverifiableHours count as definitive", () => {
    const f = { ...ok, lastSuccessAt: hoursAgo(170), transientFailures: 50 };
    expect(decideRevalidation(f, "TEMPORARY_FAILURE", p, now)).toMatchObject({ state: "FAILING", effect: "NOTIFY_FAILING" });
  });
});
