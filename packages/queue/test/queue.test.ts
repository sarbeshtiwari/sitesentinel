import { describe, expect, it } from "vitest";
import { defaultSettings } from "@wim/core";
import {
  backoffStrategy, categorize, ExecutionJob, jobOptions, PermanentError, policyFor, QUEUES, SecurityError, TIER_QUEUE_NAME, TransientError,
} from "../src/index.js";
import { sanitizeError } from "../src/util.js";

describe("queue topology", () => {
  it("defines each queue once and reuses the Phase 4A revalidation queue", () => {
    expect(QUEUES).toEqual({ http: "http-monitoring", browser: "browser-monitoring", deepscan: "deep-scan", revalidation: "revalidate", deadLetter: "dead-letter" });
    expect(TIER_QUEUE_NAME).toEqual({ HTTP: "http-monitoring", BROWSER: "browser-monitoring", DEEPSCAN: "deep-scan" });
  });
  it("every execution queue has an independently configurable policy", () => {
    const s = defaultSettings();
    for (const q of Object.values(TIER_QUEUE_NAME)) {
      const p = policyFor(s, q);
      expect(Object.keys(p).sort()).toEqual(["attempts", "backoffBaseMs", "backoffMaxMs", "concurrency", "globalConcurrency", "keepCompletedHours", "keepFailedDays", "ratePerSecond", "timeoutMs"]);
    }
    expect(policyFor(s, "browser-monitoring").timeoutMs).toBeGreaterThan(policyFor(s, "http-monitoring").timeoutMs);
    expect(() => policyFor(s, "unknown")).toThrow();
  });
  it("job options: jobId = execution id, policy attempts, retention, custom backoff", () => {
    const p = policyFor(defaultSettings(), "http-monitoring");
    const o = jobOptions("6f0c0d5e-0000-4000-8000-000000000000", p);
    expect(o).toMatchObject({ jobId: "6f0c0d5e-0000-4000-8000-000000000000", attempts: p.attempts, backoff: { type: "full-jitter" } });
    expect(o.removeOnComplete.age).toBe(p.keepCompletedHours * 3600);
    const b = backoffStrategy(p);
    for (let i = 1; i < 10; i++) {
      const d = b(i);
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(p.backoffMaxMs);
    }
  });
});

describe("execution payload schema", () => {
  const ok = { v: 1, executionId: "6f0c0d5e-0000-4000-8000-000000000000", windowStart: "2026-11-13T10:00:00.000Z" };
  it("accepts identifiers only", () => expect(ExecutionJob.safeParse(ok).success).toBe(true));
  it.each([
    ["extra tenant id", { ...ok, orgId: "6f0c0d5e-0000-4000-8000-000000000001" }],
    ["extra url", { ...ok, url: "http://169.254.169.254/" }],
    ["extra command", { ...ok, cmd: "rm -rf /" }],
    ["bad uuid", { ...ok, executionId: "../../etc/passwd" }],
    ["bad date", { ...ok, windowStart: "yesterday" }],
    ["wrong version", { ...ok, v: 2 }],
    ["string", "EXECUTE"],
    ["null", null],
  ])("rejects %s", (_, v) => expect(ExecutionJob.safeParse(v).success).toBe(false));
});

describe("failure categories", () => {
  it("decide retry behaviour", () => {
    expect(categorize(new TransientError("x"))).toBe("TRANSIENT");
    expect(categorize(new PermanentError("x"))).toBe("PERMANENT");
    expect(categorize(new SecurityError("x"))).toBe("SECURITY");
    expect(categorize(new Error("unknown"))).toBe("TRANSIENT");
  });
  it("sanitised error text never carries URLs (customer domains), query strings or long tokens", () => {
    const e = sanitizeError("GET https://shop.customer.example/x?token=abc&y=2 failed: key sk_0123456789abcdef0123456789abcdef");
    expect(e).toBe("GET [url] failed: key [redacted]");
    expect(sanitizeError("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
