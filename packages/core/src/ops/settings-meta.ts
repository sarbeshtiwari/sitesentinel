import { SETTINGS, type SettingKey, type SettingsSnapshot } from "../settings/registry.js";

/**
 * Phase 4H: how a setting is managed in the Super Admin configuration pages.
 *  - section: where it appears (operational sections; product groups stay on the generic settings page)
 *  - protected: a security policy — changing it needs `admin:settings:protected` (Super Admin) and an explicit confirmation
 *  - apply: "live" (picked up within ~30 s by every process) or "restart" (read when a worker starts)
 *  - scope: all settings here are GLOBAL; per-organisation limits come from plan entitlements / entitlement overrides
 */
export type SettingSection = "features" | "scheduling" | "queues" | "limits" | "performance" | "alerts" | "health" | "cooldowns" | "retention" | "security" | "product";
export interface SettingMeta { section: SettingSection; protected: boolean; apply: "live" | "restart"; scope: "global" }

const PROTECTED_PREFIXES = ["auth.", "admin.", "ingest.", "verification.", "domain.", "revalidation.", "transfer.", "sdk."];
const PROTECTED_KEYS = new Set<string>([
  "monitoring.functional.enabled", "monitoring.deepscan.externalLinks", "monitoring.deepscan.minRequestDelayMs",
  "monitoring.browser.maxConnectionsPerExecution", "ops.alerts.enabled", "ops.alerts.disabledRules", "ops.alerts.recipients",
  "platform.maintenanceMode",
  // Phase 8: turning billing on starts real payment-gateway traffic
  "billing.enabled",
]);

export function settingMeta(key: SettingKey): SettingMeta {
  const k = key as string;
  const prot = PROTECTED_KEYS.has(k) || PROTECTED_PREFIXES.some((p) => k.startsWith(p));
  const apply: SettingMeta["apply"] = k.startsWith("queue.") ? "restart" : "live";
  let section: SettingSection = "product";
  if (PROTECTED_PREFIXES.some((p) => k.startsWith(p))) section = "security";
  else if (/^monitoring\.[a-z]+\.(enabled|defaultEntitled)$/.test(k) || k === "monitoring.deepscan.externalLinks" || k === "platform.maintenanceMode" || k === "billing.enabled" || k === "ops.alerts.enabled" || k === "ops.usage.reconcileDaily") section = "features";
  else if (k.startsWith("scheduler.") || /intervalSec$/.test(k) || /OutstandingJobs$|perCycleQuota$/.test(k)) section = "scheduling";
  else if (k.startsWith("queue.")) section = "queues";
  else if (/(manualCooldownSec|minRequestDelayMs)$/.test(k) || k === "ops.alerts.cooldownMin") section = "cooldowns";
  else if (/[Rr]etentionDays$/.test(k)) section = "retention";
  else if (k.startsWith("monitoring.performance.") || /^monitoring\.browser\.(lcp|cls)/.test(k)) section = "performance";
  else if (k.startsWith("ops.alerts.") || /(failure|recovery)Threshold$|interruptedAfter$|circuitThreshold$/.test(k)) section = "alerts";
  else if (k.startsWith("ops.health.")) section = "health";
  else if (k.startsWith("monitoring.") || k.startsWith("ops.")) section = "limits";
  return { section, protected: prot, apply, scope: "global" };
}

export const isProtectedSetting = (key: SettingKey) => settingMeta(key).protected;

/**
 * Cross-setting safety checks applied to the snapshot that WOULD result from a change. Single values are already
 * validated by their schema; these catch combinations that are individually valid but unsafe or contradictory.
 */
export function validateSettingsCombination(s: SettingsSnapshot): string[] {
  const issues: string[] = [];
  for (const q of ["queue.http-monitoring", "queue.browser-monitoring", "queue.deep-scan"] as const) {
    const p = s[q];
    if (p.backoffBaseMs > p.backoffMaxMs) issues.push(`${q}: backoffBaseMs must not exceed backoffMaxMs`);
    if (p.concurrency > p.globalConcurrency) issues.push(`${q}: concurrency per worker must not exceed globalConcurrency`);
  }
  // a job must be able to finish before its lease is considered lost; the lease is renewed while the job runs,
  // but an execution timeout far beyond what the queue can retry within the reconcile window is a misconfiguration
  if (s["scheduler.leaseSec"] < 15) issues.push("scheduler.leaseSec must be at least 15 seconds");
  if (s["monitoring.browser.lcpWarnMs"] >= s["monitoring.browser.lcpCritMs"]) issues.push("monitoring.browser.lcpWarnMs must be below lcpCritMs");
  if (s["monitoring.browser.clsWarn"] >= s["monitoring.browser.clsCrit"]) issues.push("monitoring.browser.clsWarn must be below clsCrit");
  if (s["monitoring.limits.perCycleQuota"] > s["monitoring.global.maxOutstandingJobs"]) issues.push("monitoring.limits.perCycleQuota must not exceed monitoring.global.maxOutstandingJobs");
  if (s["ops.health.heartbeatStaleSec"] * 2 > s["ops.health.processingStallSec"]) issues.push("ops.health.processingStallSec must be at least twice ops.health.heartbeatStaleSec");
  if (s["ops.alerts.disabledRules"].includes("alerts.storm")) issues.push("the alert-storm summary cannot be disabled");
  return issues;
}

export const OPERATIONAL_SECTIONS: SettingSection[] = ["features", "scheduling", "queues", "limits", "performance", "alerts", "health", "cooldowns", "retention", "security"];
export const settingsInSection = (section: SettingSection): SettingKey[] => (Object.keys(SETTINGS) as SettingKey[]).filter((k) => settingMeta(k).section === section);
