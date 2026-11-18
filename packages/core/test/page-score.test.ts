import { describe, expect, it } from "vitest";
import { pageScore, PAGE_SCORE_PENALTY, sanitizeEvidence, scoreBand } from "../src/index.js";

describe("page score", () => {
  it("is null for pages not checked yet or skipped (we don't score what we haven't seen)", () => {
    expect(pageScore({ state: "NOT_CHECKED", findings: [] })).toMatchObject({ score: null, band: null, basis: "NOT_CHECKED" });
    expect(pageScore({ state: "SKIPPED", findings: [{ severity: "HIGH" }] }).score).toBeNull();
  });
  it("is 0 when the page fails to load or has an open broken-page finding", () => {
    expect(pageScore({ state: "FAILED", findings: [] })).toMatchObject({ score: 0, band: "POOR", basis: "BROKEN" });
    expect(pageScore({ state: "CHECKED", findings: [{ severity: "HIGH", category: "REDIRECT_LOOP" }] }).score).toBe(0);
  });
  it("is 100 minus severity penalties of open findings, floored at 0", () => {
    expect(PAGE_SCORE_PENALTY).toEqual({ CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3, INFO: 0 });
    expect(pageScore({ state: "CHECKED", findings: [] })).toMatchObject({ score: 100, band: "GOOD", basis: "FINDINGS" });
    const s = pageScore({ state: "CHECKED", findings: [{ severity: "MEDIUM" }, { severity: "MEDIUM" }, { severity: "LOW" }, { severity: "INFO" }] });
    expect(s).toMatchObject({ score: 81, band: "NEEDS_WORK", penalty: 19 });
    expect(s.bySeverity).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 1, INFO: 1 });
    expect(pageScore({ state: "CHECKED", findings: Array.from({ length: 5 }, () => ({ severity: "CRITICAL" })) }).score).toBe(0);
    expect(pageScore({ state: "CHECKED", findings: [{ severity: "unknown" }] }).score).toBe(100); // unknown → info
  });
  it("bands: ≥ 90 good, 50–89 needs work, < 50 poor", () => {
    expect([100, 90, 89, 50, 49, 0, null].map(scoreBand)).toEqual(["GOOD", "GOOD", "NEEDS_WORK", "NEEDS_WORK", "POOR", "POOR", null]);
  });
});

describe("evidence sanitising", () => {
  it("drops credential-like keys, redacts bearer/JWT/secret query values and bounds size", () => {
    const out = sanitizeEvidence({
      status: 500, linkedFrom: "https://a.example/x", password: "hunter2", apiKey: "k", authorization: "Bearer abcdefghijklmnop",
      note: "sent Bearer abcdefghijklmnop to https://a.example/cb?token=abc123&page=2",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
      long: "x".repeat(900), list: Array.from({ length: 80 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("authorization");
    expect(out.note).toBe("sent [redacted] to https://a.example/cb?token=…&page=2");
    expect(out.jwt).toBe("[redacted]");
    expect(String(out.long).length).toBe(501);
    expect(out.list).toHaveLength(50);
    expect(out).toMatchObject({ status: 500, linkedFrom: "https://a.example/x" });
  });
});
