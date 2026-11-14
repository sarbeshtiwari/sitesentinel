import { z } from "zod";
import type { SettingsSnapshot } from "../settings/registry.js";

/**
 * Pure scheduling policy (Phase 4B). The scheduler and workers call these with
 * facts read from the database; nothing here touches I/O.
 */

export const MONITORING_TIERS = ["HTTP", "BROWSER", "DEEPSCAN"] as const;
export type MonitoringTier = (typeof MONITORING_TIERS)[number];

/** Database CheckTier ↔ monitoring tier ↔ queue. */
export const TIER_DB: Record<MonitoringTier, "T1_HTTP" | "T2_RENDER" | "T3_DEEP"> = { HTTP: "T1_HTTP", BROWSER: "T2_RENDER", DEEPSCAN: "T3_DEEP" };
export const TIER_FROM_DB: Record<string, MonitoringTier> = { T1_HTTP: "HTTP", T2_RENDER: "BROWSER", T3_DEEP: "DEEPSCAN" };
export const TIER_QUEUE: Record<MonitoringTier, string> = { HTTP: "http-monitoring", BROWSER: "browser-monitoring", DEEPSCAN: "deep-scan" };
const TIER_KEY: Record<MonitoringTier, "http" | "browser" | "deepscan"> = { HTTP: "http", BROWSER: "browser", DEEPSCAN: "deepscan" };

// ---------------------------------------------------------------- windows
/**
 * Execution windows of a schedule: [start, start + interval), offset by the schedule's
 * jitter so that thousands of schedules don't fire on the same second. The window
 * start is the durable identity of a scheduled execution (with the schedule id).
 */
export function windowStart(nowMs: number, intervalSec: number, jitterSec: number): number {
  const i = intervalSec * 1000;
  const j = (jitterSec % intervalSec) * 1000;
  return Math.floor((nowMs - j) / i) * i + j;
}

/** Stable jitter in [0, interval) derived from the schedule id. */
export function jitterFor(scheduleId: string, intervalSec: number): number {
  let h = 2166136261;
  for (let k = 0; k < scheduleId.length; k++) h = Math.imul(h ^ scheduleId.charCodeAt(k), 16777619) >>> 0;
  return h % intervalSec;
}

// ---------------------------------------------------------------- limits
export const MONITORING_ENTITLEMENT_KEYS = [
  "monitoring.entitled", "monitoring.http.minIntervalSec", "monitoring.browser.minIntervalSec", "monitoring.deepscan.minIntervalSec",
  "monitoring.maxWebsites", "monitoring.maxConcurrentJobs", "monitoring.maxOutstandingJobs", "monitoring.perCycleQuota", "monitoring.weight",
  "monitoring.browser.entitled", "monitoring.browser.maxWebsites", "monitoring.browser.maxViewportsPerRun",
  "monitoring.deepscan.entitled", "monitoring.deepscan.maxWebsites", "monitoring.deepscan.maxPages", "monitoring.deepscan.maxDepth",
  "monitoring.deepscan.maxDurationSec", "monitoring.deepscan.pagesPerDay", "monitoring.deepscan.browserPages", "monitoring.deepscan.externalLinks",
  "monitoring.deepscan.maxConcurrentScans", "monitoring.deepscan.retentionDays",
  "monitoring.performance.customThresholds",
] as const;
export type MonitoringEntitlementKey = (typeof MONITORING_ENTITLEMENT_KEYS)[number];

export interface MonitoringLimits {
  tiers: Record<MonitoringTier, { enabled: boolean; intervalSec: number }>;
  /** Phase 4D: browser monitoring needs the platform switch AND an entitlement (plan/override/default) */
  browser: { entitled: boolean; maxWebsites: number; maxViewportsPerRun: number; customPerfThresholds: boolean };
  /** Phase 4E: deep scanning needs the platform switch AND an entitlement; limits are caps customers can only lower */
  deepscan: import("./deepscan.js").DeepScanLimits & { entitled: boolean; maxWebsites: number; retentionDays: number };
  maxWebsites: number;
  maxConcurrentJobs: number;
  maxOutstandingJobs: number;
  perCycleQuota: number;
  /** Fair-share weight (plan priority). */
  weight: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Effective limits = platform defaults (admin settings) ⊕ plan entitlements ⊕ org overrides
 * (later wins), then the customer's requested interval, never faster than the entitled minimum.
 * The tier switch is platform-wide: a tier whose engine isn't released is disabled for everyone.
 */
export function resolveMonitoringLimits(
  s: SettingsSnapshot,
  plan: Partial<Record<MonitoringEntitlementKey, unknown>> | null,
  overrides: Partial<Record<MonitoringEntitlementKey, unknown>>,
  requested: Partial<Record<MonitoringTier, number | null>> = {},
): MonitoringLimits {
  const pick = (k: MonitoringEntitlementKey, def: number) => num(overrides[k]) ?? num(plan?.[k]) ?? def;
  const tiers = Object.fromEntries(MONITORING_TIERS.map((t) => {
    const key = TIER_KEY[t];
    const platformInterval = s[`monitoring.${key}.intervalSec` as const] as number;
    const minInterval = pick(`monitoring.${key}.minIntervalSec` as MonitoringEntitlementKey, platformInterval);
    const req = requested[t];
    const intervalSec = Math.max(minInterval, req && req > 0 ? req : platformInterval);
    return [t, { enabled: Boolean(s[`monitoring.${key}.enabled` as const]), intervalSec }];
  })) as MonitoringLimits["tiers"];
  const browserEntitled = typeof overrides["monitoring.browser.entitled"] === "boolean" ? (overrides["monitoring.browser.entitled"] as boolean)
    : typeof plan?.["monitoring.browser.entitled"] === "boolean" ? (plan["monitoring.browser.entitled"] as boolean)
    : Boolean(s["monitoring.browser.defaultEntitled"]);
  tiers.BROWSER = { ...tiers.BROWSER, enabled: tiers.BROWSER.enabled && browserEntitled };
  const bool = (k: MonitoringEntitlementKey, def: boolean) => typeof overrides[k] === "boolean" ? (overrides[k] as boolean) : typeof plan?.[k] === "boolean" ? (plan[k] as boolean) : def;
  const deepEntitled = bool("monitoring.deepscan.entitled", Boolean(s["monitoring.deepscan.defaultEntitled"]));
  tiers.DEEPSCAN = { ...tiers.DEEPSCAN, enabled: tiers.DEEPSCAN.enabled && deepEntitled };
  return {
    tiers,
    browser: {
      entitled: browserEntitled,
      maxWebsites: pick("monitoring.browser.maxWebsites", s["monitoring.browser.maxWebsites"]),
      maxViewportsPerRun: Math.max(1, Math.min(6, pick("monitoring.browser.maxViewportsPerRun", s["monitoring.browser.maxViewportsPerRun"]))),
      // Phase 4G: may the organisation set its own performance thresholds (otherwise the platform defaults apply)
      customPerfThresholds: bool("monitoring.performance.customThresholds", Boolean(s["monitoring.performance.customThresholdsDefault"])),
    },
    deepscan: {
      entitled: deepEntitled,
      maxWebsites: pick("monitoring.deepscan.maxWebsites", s["monitoring.deepscan.maxWebsites"]),
      maxPages: pick("monitoring.deepscan.maxPages", s["monitoring.deepscan.maxPages"]),
      maxDepth: pick("monitoring.deepscan.maxDepth", s["monitoring.deepscan.maxDepth"]),
      maxDurationSec: pick("monitoring.deepscan.maxDurationSec", s["monitoring.deepscan.maxDurationSec"]),
      minRequestDelayMs: s["monitoring.deepscan.minRequestDelayMs"],
      maxRequests: s["monitoring.deepscan.maxRequests"],
      maxResponseBytes: s["monitoring.deepscan.maxResponseBytes"],
      pagesPerDay: pick("monitoring.deepscan.pagesPerDay", s["monitoring.deepscan.pagesPerDay"]),
      browserPages: pick("monitoring.deepscan.browserPages", s["monitoring.deepscan.browserPages"]),
      externalLinks: bool("monitoring.deepscan.externalLinks", Boolean(s["monitoring.deepscan.externalLinks"])),
      maxExternalLinks: s["monitoring.deepscan.maxExternalLinks"],
      maxConcurrentScans: pick("monitoring.deepscan.maxConcurrentScans", s["monitoring.deepscan.maxConcurrentScans"]),
      retentionDays: pick("monitoring.deepscan.retentionDays", s["monitoring.deepscan.retentionDays"]),
    },
    maxWebsites: pick("monitoring.maxWebsites", s["monitoring.limits.maxWebsites"]),
    maxConcurrentJobs: pick("monitoring.maxConcurrentJobs", s["monitoring.limits.maxConcurrentJobs"]),
    maxOutstandingJobs: pick("monitoring.maxOutstandingJobs", s["monitoring.limits.maxOutstandingJobs"]),
    perCycleQuota: pick("monitoring.perCycleQuota", s["monitoring.limits.perCycleQuota"]),
    weight: Math.max(1, Math.min(10, pick("monitoring.weight", 1))),
  };
}

// ---------------------------------------------------------------- entitlement and eligibility
export interface EntitlementFacts {
  now: Date;
  trial: { status: string; endsAt: Date } | null;
  subscription: { status: string; currentPeriodEnd: Date | null; graceEndsAt: Date | null } | null;
  /** monitoring.entitled override (admin) */
  override: boolean | null;
}

/** Is the organization entitled to monitoring right now? (Expired trials and lapsed subscriptions are not.) */
export function isMonitoringEntitled(f: EntitlementFacts): { entitled: boolean; reason: string } {
  if (f.override === true) return { entitled: true, reason: "OVERRIDE" };
  if (f.override === false) return { entitled: false, reason: "OVERRIDE_DISABLED" };
  const t = f.now.getTime();
  const sub = f.subscription;
  if (sub) {
    if (sub.status === "ACTIVE" || sub.status === "TRIALING") return { entitled: true, reason: `SUBSCRIPTION_${sub.status}` };
    if (sub.status === "CANCELING" && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > t) return { entitled: true, reason: "SUBSCRIPTION_CANCELING" };
    if (sub.status === "PAST_DUE" && sub.graceEndsAt && sub.graceEndsAt.getTime() > t) return { entitled: true, reason: "SUBSCRIPTION_GRACE" };
  }
  if (f.trial && f.trial.status === "ACTIVE" && f.trial.endsAt.getTime() > t) return { entitled: true, reason: "TRIAL" };
  return { entitled: false, reason: f.trial ? "TRIAL_EXPIRED" : "NO_SUBSCRIPTION" };
}

export type PausedReason = "WEBSITE_PAUSED" | "WEBSITE_INACTIVE" | "OWNERSHIP_LAPSED" | "ORG_SUSPENDED" | "NOT_ENTITLED" | "TIER_DISABLED" | "WEBSITE_LIMIT" | "DISABLED_BY_CUSTOMER";

export interface EligibilityFacts {
  websiteStatus: string;
  websiteArchived: boolean;
  claimStatus: string;
  orgStatus: string;
  entitled: boolean;
  tierEnabled: boolean;
  /** rank of this website among the org's active websites (oldest first), 1-based */
  websiteRank: number;
  maxWebsites: number;
  /** per-website opt-out of this tier (customer configuration) */
  customerDisabled?: boolean;
}

/** null = eligible; otherwise why the schedule must be paused / the job skipped. */
export function ineligibility(f: EligibilityFacts): PausedReason | null {
  if (f.orgStatus !== "ACTIVE") return "ORG_SUSPENDED";
  if (f.websiteArchived) return "WEBSITE_INACTIVE";
  if (f.websiteStatus === "PAUSED") return "WEBSITE_PAUSED";
  if (f.websiteStatus === "LAPSED" || f.claimStatus === "LAPSED") return "OWNERSHIP_LAPSED";
  if (f.websiteStatus !== "ACTIVE" || f.claimStatus !== "VERIFIED") return "WEBSITE_INACTIVE";
  if (!f.entitled) return "NOT_ENTITLED";
  if (!f.tierEnabled) return "TIER_DISABLED";
  if (f.customerDisabled) return "DISABLED_BY_CUSTOMER";
  if (f.websiteRank > f.maxWebsites) return "WEBSITE_LIMIT";
  return null;
}

// ---------------------------------------------------------------- retries
export const QueuePolicy = z.object({
  /** jobs processed concurrently by ONE worker process */
  concurrency: z.number().int().min(1).max(500),
  /** jobs of this queue running at once across ALL worker processes */
  globalConcurrency: z.number().int().min(1).max(100_000),
  ratePerSecond: z.number().int().min(1).max(100000),
  attempts: z.number().int().min(1).max(20),
  backoffBaseMs: z.number().int().min(100).max(3_600_000),
  backoffMaxMs: z.number().int().min(1000).max(86_400_000),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
  keepCompletedHours: z.number().int().min(1).max(720),
  keepFailedDays: z.number().int().min(1).max(90),
}).strict();
export type QueuePolicy = z.infer<typeof QueuePolicy>;

/**
 * Exponential backoff with full jitter (AWS architecture blog): uniform in [0, min(max, base·2^(attempt-1))].
 * Full jitter spreads retries of many jobs that failed together (outage) instead of synchronising them.
 */
export function backoffDelay(attempt: number, base: number, max: number, rand: () => number = Math.random): number {
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * cap);
}

// ---------------------------------------------------------------- fairness
/**
 * Fair dispatch order across organizations: weighted round-robin by per-org rank.
 * Input rows are already ordered by due time within each org. An org of weight w
 * gets w slots per round; rounds interleave orgs, so a tenant with 10,000 due
 * websites contributes at most `quota` per cycle and never blocks others.
 */
export function fairOrder<T extends { orgId: string }>(rows: T[], quotaFor: (orgId: string) => number, weightFor: (orgId: string) => number, limit: number): T[] {
  const byOrg = new Map<string, T[]>();
  for (const r of rows) {
    const list = byOrg.get(r.orgId) ?? [];
    list.push(r);
    byOrg.set(r.orgId, list);
  }
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (let round = 0; out.length < limit; round++) {
    let progressed = false;
    for (const [org, list] of byOrg) {
      const quota = quotaFor(org);
      const w = weightFor(org);
      for (let k = 0; k < w && out.length < limit; k++) {
        const n = taken.get(org) ?? 0;
        if (n >= quota || n >= list.length) break;
        out.push(list[n]!);
        taken.set(org, n + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}
