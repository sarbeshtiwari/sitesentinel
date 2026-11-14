import { describe, expect, it } from "vitest";
import {
  ALERT_DEPENDENCIES, ALERT_RULES, AlertThresholds, alertSeverity, billableUsage, classifyWorker, DEFAULT_ALERT_THRESHOLDS, defaultSettings,
  FunctionalConfig, functionalBlockedReason, FUNCTIONAL_RISK_VERSION, isProtectedSetting, level, pathAllowed, queueProcessing, rateLevel,
  SETTING_KEYS, settingMeta, usageKeyDef, USAGE_KEYS, validateSettingsCombination, worstHealth, type WorkerFacts,
} from "../src/index.js";

const now = new Date("2026-11-15T12:00:00Z");
const w = (o: Partial<WorkerFacts> = {}): WorkerFacts => ({
  workerId: "w1", kind: "http-monitoring", lastSeenAt: new Date(now.getTime() - 5000), startedAt: new Date(now.getTime() - 3_600_000), activeJobs: 1, capacity: 4,
  processed: 10, failed: 0, timeouts: 0, lastJobAt: new Date(now.getTime() - 10_000), rssMb: 200, deps: { redis: { ok: true, at: now.toISOString() } }, ...o,
});
const cls = { staleSec: 45, memoryMb: 2048, utilization: { warn: 85, crit: 98 } };

describe("Phase 4H health vocabulary", () => {
  it("worst state wins; nothing reported is UNKNOWN, never HEALTHY", () => {
    expect(worstHealth([])).toBe("UNKNOWN");
    expect(worstHealth(["HEALTHY", "DEGRADED", "UNKNOWN"])).toBe("DEGRADED");
    expect(worstHealth(["HEALTHY", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstHealth(["UNHEALTHY", "DEGRADED"])).toBe("UNHEALTHY");
    expect(level(null, { warn: 1, crit: 2 })).toBe("UNKNOWN");
    expect(level(Number.NaN, { warn: 1, crit: 2 })).toBe("UNKNOWN");
    expect(level(1, { warn: 1, crit: 2 })).toBe("DEGRADED");
    expect(level(2, { warn: 1, crit: 2 })).toBe("UNHEALTHY");
  });

  it("failure rates need enough samples: 1 failure of 2 is not an outage", () => {
    expect(rateLevel(1, 2, { warn: 10, crit: 30 }, 10).state).toBe("HEALTHY");
    expect(rateLevel(4, 10, { warn: 10, crit: 30 }, 10)).toEqual({ state: "UNHEALTHY", pct: 40 });
    expect(rateLevel(0, 0, { warn: 10, crit: 30 }, 10)).toEqual({ state: "HEALTHY", pct: null });
  });

  it("a worker: alive vs expired, dependencies, capacity, memory", () => {
    expect(classifyWorker(w(), now, cls)).toMatchObject({ state: "HEALTHY", alive: true, depsOk: true, available: 3, utilizationPct: 25 });
    expect(classifyWorker(w({ lastSeenAt: new Date(now.getTime() - 60_000) }), now, cls)).toMatchObject({ state: "UNHEALTHY", alive: false });
    expect(classifyWorker(w({ deps: { redis: { ok: true, at: "" }, gateway: { ok: false, at: "" } } }), now, cls)).toMatchObject({ state: "DEGRADED", depsOk: false, failingDeps: ["gateway"] });
    expect(classifyWorker(w({ deps: null }), now, cls).depsOk).toBeNull(); // nothing reported ≠ ok
    expect(classifyWorker(w({ rssMb: 1900 }), now, cls)).toMatchObject({ state: "DEGRADED", memoryPct: 93 });
  });

  it("alive but not processing: waiting jobs, idle live workers, nothing finished within the stall window", () => {
    const base = { waiting: 5, aliveWorkers: 2, busyWorkers: 0, now, stallSec: 600, oldestWaitingSec: 900 };
    expect(queueProcessing({ ...base, lastJobAt: new Date(now.getTime() - 3_600_000) }).processing).toBe(false);
    expect(queueProcessing({ ...base, lastJobAt: null }).processing).toBe(false);
    expect(queueProcessing({ ...base, lastJobAt: new Date(now.getTime() - 10_000) }).processing).toBe(true);
    expect(queueProcessing({ ...base, busyWorkers: 1, lastJobAt: null }).processing).toBe(true);
    expect(queueProcessing({ ...base, aliveWorkers: 0, lastJobAt: null })).toMatchObject({ processing: false, reason: "jobs waiting and no live worker" });
    expect(queueProcessing({ ...base, waiting: 0, lastJobAt: null }).processing).toBeNull();
    // a job that just arrived is not a stall
    expect(queueProcessing({ ...base, oldestWaitingSec: 5, lastJobAt: new Date(now.getTime() - 3_600_000) }).processing).toBe(true);
  });

  it("severity: critical when unhealthy, warning when degraded, per-rule overrides", () => {
    expect(alertSeverity("queue.backlog", "UNHEALTHY", {})).toBe("CRITICAL");
    expect(alertSeverity("queue.backlog", "DEGRADED", {})).toBe("WARNING");
    expect(alertSeverity("queue.backlog", "UNHEALTHY", { "queue.backlog": "INFO" })).toBe("INFO");
  });

  it("shared-dependency suppression only names known rules and never suppresses the root cause itself", () => {
    for (const [root, deps] of Object.entries(ALERT_DEPENDENCIES)) {
      expect(ALERT_RULES).toContain(root);
      for (const d of deps!) { expect(ALERT_RULES).toContain(d); expect(d).not.toBe(root); }
    }
    expect(ALERT_DEPENDENCIES["postgres.unavailable"]).not.toContain("redis.unavailable");
    expect(Object.values(ALERT_DEPENDENCIES).flat()).not.toContain("alerts.storm");
  });

  it("alert thresholds are validated: warning below critical, bounded", () => {
    expect(AlertThresholds.safeParse(DEFAULT_ALERT_THRESHOLDS).success).toBe(true);
    expect(AlertThresholds.safeParse({ ...DEFAULT_ALERT_THRESHOLDS, queueWaiting: { warn: 10, crit: 5 } }).success).toBe(false);
    expect(AlertThresholds.safeParse({ ...DEFAULT_ALERT_THRESHOLDS, infraFailurePct: { warn: 10, crit: 300 } }).success).toBe(false);
    expect(AlertThresholds.safeParse({ ...DEFAULT_ALERT_THRESHOLDS, extra: 1 }).success).toBe(false);
  });
});

describe("Phase 4H configuration safety", () => {
  it("defaults are a safe combination", () => {
    expect(validateSettingsCombination(defaultSettings())).toEqual([]);
  });
  it("individually valid but unsafe combinations are rejected", () => {
    const d = defaultSettings();
    const q = d["queue.http-monitoring"];
    expect(validateSettingsCombination({ ...d, "queue.http-monitoring": { ...q, backoffBaseMs: 120_000, backoffMaxMs: 60_000 } })).toHaveLength(1);
    expect(validateSettingsCombination({ ...d, "queue.http-monitoring": { ...q, concurrency: 400, globalConcurrency: 100 } })).toHaveLength(1);
    expect(validateSettingsCombination({ ...d, "monitoring.browser.lcpWarnMs": 5000, "monitoring.browser.lcpCritMs": 4000 })).toHaveLength(1);
    expect(validateSettingsCombination({ ...d, "ops.health.heartbeatStaleSec": 600 })).toHaveLength(1);
    expect(validateSettingsCombination({ ...d, "ops.alerts.disabledRules": ["alerts.storm"] })).toHaveLength(1);
  });
  it("security policies are protected; queue policies need a restart; every key has a section", () => {
    for (const k of SETTING_KEYS) expect(settingMeta(k).scope).toBe("global");
    expect(isProtectedSetting("auth.password.minLength")).toBe(true);
    expect(isProtectedSetting("admin.session.idleMinutes" as never)).toBe(true);
    expect(isProtectedSetting("monitoring.functional.enabled")).toBe(true);
    expect(isProtectedSetting("ops.alerts.cooldownMin")).toBe(false);
    expect(settingMeta("queue.deep-scan").apply).toBe("restart");
    expect(settingMeta("ops.alerts.cooldownMin").apply).toBe("live");
    expect(settingMeta("monitoring.http.enabled").section).toBe("features");
    expect(settingMeta("monitoring.deepscan.retentionDays").section).toBe("retention");
  });
});

describe("Phase 4H usage policy", () => {
  it("inconclusive is recorded but not billable; overhead never billable; unknown keys are refused", () => {
    expect(billableUsage({ "http.checks": 100, "http.inconclusive": 7, "exec.http.failed": 9, "browser.executions": 3, "browser.inconclusive": 5 }))
      .toMatchObject({ "http.checks": 93, "browser.executions": 0, "deepscan.pages": 0 });
    expect(usageKeyDef("exec.http.retries")).toMatchObject({ kind: "overhead" });
    expect(usageKeyDef("exec.deepscan.cancelled")).toMatchObject({ kind: "overhead" });
    expect(usageKeyDef("exec.browser.ok")).toMatchObject({ kind: "info" });
    expect(usageKeyDef("browser.retry_ms")).toMatchObject({ kind: "overhead" });
    expect(usageKeyDef("made.up")).toBeNull();
    expect(usageKeyDef("exec.t1.ok")).toBeNull();
    for (const [k, d] of Object.entries(USAGE_KEYS)) if (d.kind === "exclusion") expect(USAGE_KEYS[d.reduces!]?.kind, k).toBe("work");
  });
});

describe("Phase 4H functional-test policy", () => {
  const ack = { version: FUNCTIONAL_RISK_VERSION, at: now.toISOString(), by: "8d9a9a32-8c41-4a39-9a2a-0d5f6b0e8f11" } as const;
  it("interactions need the website opt-in, the platform switch and a current acknowledgement", () => {
    const off = FunctionalConfig.parse({});
    expect(off.riskAcknowledgement).toBeNull();
    expect(functionalBlockedReason(off, true)).toMatch(/not enabled/);
    const on = FunctionalConfig.parse({ enabled: true });
    expect(functionalBlockedReason(on, true)).toMatch(/acknowledgement/);
    expect(functionalBlockedReason({ ...on, riskAcknowledgement: ack }, false)).toMatch(/switched off/);
    // release readiness (blocker 9): explicit safe destinations are mandatory
    expect(functionalBlockedReason({ ...on, riskAcknowledgement: ack }, true)).toMatch(/no allowed paths/);
    expect(functionalBlockedReason({ ...on, riskAcknowledgement: ack, allowedPaths: ["/search"] }, true)).toBeNull();
    expect(FunctionalConfig.safeParse({ enabled: true, riskAcknowledgement: { ...ack, version: 0 } }).success).toBe(false);
  });
  it("destination policy: allowed path prefixes, case-insensitive, no prefix tricks", () => {
    expect(pathAllowed("https://a.example/search?q=x", [])).toBe(true);
    expect(pathAllowed("https://a.example/search?q=x", ["/search"])).toBe(true);
    expect(pathAllowed("https://a.example/Search/results", ["/search"])).toBe(true);
    expect(pathAllowed("https://a.example/searchx", ["/search"])).toBe(false);
    expect(pathAllowed("https://a.example/account/delete", ["/search", "/products"])).toBe(false);
    expect(pathAllowed("https://a.example/products/%2e%2e/admin", ["/products"])).toBe(false); // dot segments are resolved before matching
    expect(pathAllowed("not a url", ["/search"])).toBe(false);
    // "/" is the home page only, not a wildcard for the whole site
    expect(pathAllowed("https://a.example/", ["/"])).toBe(true);
    expect(pathAllowed("https://a.example/account/delete", ["/"])).toBe(false);
    expect(FunctionalConfig.safeParse({ allowedPaths: ["search"] }).success).toBe(false);
    expect(FunctionalConfig.safeParse({ allowedPaths: Array.from({ length: 21 }, (_, i) => `/p${i}`) }).success).toBe(false);
  });
});
