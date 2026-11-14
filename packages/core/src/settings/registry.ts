import { z } from "zod";
import { QueuePolicy } from "../monitoring/scheduling.js";
import { DEFAULT_PERF_THRESHOLDS, PERF_METRICS, PerfThresholdMap } from "../monitoring/performance.js";
import { AlertThresholds, ALERT_RULES, DEFAULT_ALERT_THRESHOLDS } from "../ops/health.js";

/** Every metric must have bounds in the platform default. */
const PerfThresholdSettings = PerfThresholdMap.refine((m) => PERF_METRICS.every((k) => m[k]), { message: "bounds for every metric" })
  .transform((m) => m as Required<typeof m>);

/**
 * Typed registry of operationally configurable settings (ARCHITECTURE.md §19).
 * Values live in `platform_settings` (seeded from these defaults); code reads
 * them through the settings service and never hard-codes them. Deployment-level
 * values that differ per environment (URLs, sender domain, region) are
 * environment variables instead — see apps/api/src/config/env.ts.
 */
interface SettingDef<T extends z.ZodType> {
  schema: T;
  default: z.infer<T>;
  group: "branding" | "legal" | "auth" | "admin" | "trial" | "billing" | "platform" | "websites" | "monitoring" | "operations";
  /** Exposed unauthenticated to the web/admin apps (branding, legal links). */
  public?: boolean;
  description: string;
}

function def<T extends z.ZodType>(d: SettingDef<T>): SettingDef<T> {
  return d;
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionalUrl = z.url().max(2048).nullable();

export const SETTINGS = {
  // ---- branding (global, no code change needed to rebrand)
  "branding.productName": def({ schema: z.string().trim().min(1).max(60), default: "SiteSentinel", group: "branding", public: true, description: "Product name used in the UI, emails and the authenticator app issuer" }),
  "branding.logoUrl": def({ schema: optionalUrl, default: null, group: "branding", public: true, description: "Logo image URL" }),
  "branding.faviconUrl": def({ schema: optionalUrl, default: null, group: "branding", public: true, description: "Favicon URL" }),
  "branding.primaryColor": def({ schema: hexColor, default: "#4f46e5", group: "branding", public: true, description: "Primary brand colour" }),
  "branding.supportEmail": def({ schema: z.email().nullable(), default: null, group: "branding", public: true, description: "Support contact shown to customers" }),

  // ---- legal
  "legal.termsUrl": def({ schema: optionalUrl, default: null, group: "legal", public: true, description: "Terms of service URL" }),
  "legal.privacyUrl": def({ schema: optionalUrl, default: null, group: "legal", public: true, description: "Privacy policy URL" }),
  "legal.termsVersion": def({ schema: z.string().min(1).max(40), default: "2026-11-13", group: "legal", public: true, description: "Version customers accept at registration" }),

  // ---- authentication policy
  "auth.registration": def({ schema: z.enum(["OPEN", "INVITE_ONLY", "CLOSED"]), default: "OPEN", group: "auth", public: true, description: "Who can create accounts" }),
  "auth.password.minLength": def({ schema: z.number().int().min(12).max(64), default: 12, group: "auth", public: true, description: "Minimum password length" }),
  "auth.password.breachCheck": def({ schema: z.boolean(), default: true, group: "auth", description: "Reject passwords found in breach corpora (HIBP k-anonymity, fail-open)" }),
  "auth.session.idleHours": def({ schema: z.number().int().min(1).max(720), default: 168, group: "auth", description: "Customer session idle timeout" }),
  "auth.session.absoluteDays": def({ schema: z.number().int().min(1).max(90), default: 30, group: "auth", description: "Customer session absolute lifetime" }),
  "auth.partialSessionMinutes": def({ schema: z.number().int().min(2).max(30), default: 10, group: "auth", description: "Time allowed to complete the second factor" }),
  "auth.login.failuresBeforeDelay": def({ schema: z.number().int().min(3).max(20), default: 5, group: "auth", description: "Account failures (15 min) before progressive delay" }),
  "auth.login.lockThreshold24h": def({ schema: z.number().int().min(5).max(100), default: 20, group: "auth", description: "Account failures in 24 h that trigger a temporary lock" }),
  "auth.login.lockMinutes": def({ schema: z.number().int().min(5).max(1440), default: 60, group: "auth", description: "Temporary lock duration" }),
  "auth.login.perIpPer15Min": def({ schema: z.number().int().min(5).max(1000), default: 20, group: "auth", description: "Login attempts per IP per 15 minutes" }),
  "auth.register.perIpPerHour": def({ schema: z.number().int().min(1).max(1000), default: 5, group: "auth", description: "Registrations per IP per hour" }),
  "auth.emailVerification.ttlHours": def({ schema: z.number().int().min(1).max(168), default: 24, group: "auth", description: "Email verification link lifetime" }),
  "auth.passwordReset.ttlMinutes": def({ schema: z.number().int().min(10).max(120), default: 30, group: "auth", description: "Password reset link lifetime" }),
  "auth.mfaReset.delayHours": def({ schema: z.number().int().min(0).max(336), default: 72, group: "auth", description: "Waiting period before a lost-2FA reset takes effect" }),
  "auth.invitation.ttlDays": def({ schema: z.number().int().min(1).max(30), default: 7, group: "auth", description: "Invitation lifetime" }),

  // ---- super admin sessions
  "admin.session.idleMinutes": def({ schema: z.number().int().min(5).max(120), default: 30, group: "admin", description: "Admin session idle timeout" }),
  "admin.login.perIpPer15Min": def({ schema: z.number().int().min(3).max(1000), default: 10, group: "admin", description: "Admin login attempts per IP per 15 minutes" }),
  "admin.session.absoluteHours": def({ schema: z.number().int().min(1).max(24), default: 8, group: "admin", description: "Admin session absolute lifetime" }),

  // ---- trial (enforced in Phase 8)
  "trial.days": def({ schema: z.number().int().min(1).max(90), default: 30, group: "trial", public: true, description: "Free trial length" }),
  "trial.requiresCard": def({ schema: z.boolean(), default: false, group: "trial", public: true, description: "Require a payment method to start a trial" }),
  "trial.activation": def({ schema: z.enum(["FIRST_VERIFIED_WEBSITE"]), default: "FIRST_VERIFIED_WEBSITE", group: "trial", description: "When the trial clock starts" }),

  "trial.enabled": def({ schema: z.boolean(), default: true, group: "trial", description: "Grant free trials at first website verification" }),

  // ---- websites and domain identity (Phase 3)
  "domain.policy": def({ schema: z.enum(["ROOT_EXCLUSIVE", "SUBDOMAIN_INDEPENDENT"]), default: "ROOT_EXCLUSIVE", group: "websites", description: "ROOT_EXCLUSIVE: a DNS-verified registrable domain reserves all its subdomains for that organization" }),
  "domain.aliasLabels": def({ schema: z.array(z.string().regex(/^[a-z0-9-]{1,63}$/)).max(5), default: ["www"], group: "websites", description: "Leading labels treated as the same website (www.example.com = example.com)" }),
  "domain.pendingClaimHours": def({ schema: z.number().int().min(1).max(336), default: 72, group: "websites", description: "Unverified claims expire after this many hours" }),
  "websites.maxPendingPerOrg": def({ schema: z.number().int().min(1).max(1000), default: 10, group: "websites", description: "Unverified websites an organization may hold at once (abuse control)" }),
  "verification.prefix": def({ schema: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), default: "sitesentinel", group: "websites", description: "Prefix for the DNS record, file and meta tag names (changing it invalidates published records)" }),
  "verification.maxAttemptsPerHour": def({ schema: z.number().int().min(1).max(100), default: 10, group: "websites", description: "Verification checks per website per hour" }),
  "verification.maxAttemptsPerToken": def({ schema: z.number().int().min(5).max(500), default: 50, group: "websites", description: "Checks allowed before the token must be regenerated" }),
  "sdk.activeWindowHours": def({ schema: z.number().int().min(1).max(168), default: 24, group: "websites", description: "An installation is ACTIVE if a valid heartbeat arrived within this window" }),
  "sdk.minHeartbeatsForActive": def({ schema: z.number().int().min(1).max(100), default: 2, group: "websites", description: "Distinct page loads needed before DETECTED becomes ACTIVE" }),
  "sdk.keyRotationGraceHours": def({ schema: z.number().int().min(0).max(168), default: 24, group: "websites", description: "How long the previous site key keeps working after regeneration (revocation has no grace)" }),
  "ingest.perIpPerMinute": def({ schema: z.number().int().min(10).max(100000), default: 120, group: "websites", description: "SDK requests per client IP per minute" }),
  "ingest.perKeyPerMinute": def({ schema: z.number().int().min(10).max(1000000), default: 1200, group: "websites", description: "SDK requests per site key per minute" }),
  "revalidation.enabled": def({ schema: z.boolean(), default: true, group: "websites", description: "Periodically re-check ownership of verified domains with their original method" }),
  "revalidation.intervalHours": def({ schema: z.number().int().min(1).max(720), default: 24, group: "websites", description: "Re-check interval for healthy claims" }),
  "revalidation.failingRetryHours": def({ schema: z.number().int().min(1).max(72), default: 6, group: "websites", description: "Re-check interval while a claim is failing or lapsed" }),
  "revalidation.transientRetryMinutes": def({ schema: z.number().int().min(5).max(1440), default: 30, group: "websites", description: "Retry delay after a temporary failure (DNS outage, unreachable site) or our own outage" }),
  "revalidation.graceHours": def({ schema: z.number().int().min(1).max(720), default: 72, group: "websites", description: "Grace period of definitive failures before the claim lapses and monitoring is suspended" }),
  "revalidation.lapseReleaseDays": def({ schema: z.number().int().min(1).max(365), default: 30, group: "websites", description: "Days a lapsed claim is kept before ownership is considered lost and the domain released" }),
  "revalidation.maxUnverifiableHours": def({ schema: z.number().int().min(24).max(720), default: 168, group: "websites", description: "Temporary failures for longer than this since the last success count as definitive" }),
  "revalidation.maxPerSweep": def({ schema: z.number().int().min(1).max(10000), default: 200, group: "websites", description: "Claims enqueued per sweep (rate limit)" }),
  "transfer.ownerResponseDays": def({ schema: z.number().int().min(1).max(30), default: 7, group: "websites", description: "Days the current owner has to contest a transfer request" }),

  // ---- monitoring engine (Phase 4B). Tier switches stay off until each engine ships (4C/4D/4E).
  "monitoring.http.enabled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Schedule HTTP availability checks (engine ships in Phase 4C)" }),
  "monitoring.browser.enabled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Schedule browser monitoring (engine ships in Phase 4D)" }),
  "monitoring.deepscan.enabled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Schedule deep scans (engine ships in Phase 4E)" }),
  "monitoring.http.intervalSec": def({ schema: z.number().int().min(30).max(86_400), default: 60, group: "monitoring", description: "Default HTTP check interval (plans/overrides may set a slower minimum)" }),
  "monitoring.browser.intervalSec": def({ schema: z.number().int().min(300).max(86_400), default: 900, group: "monitoring", description: "Default browser monitoring interval" }),
  "monitoring.deepscan.intervalSec": def({ schema: z.number().int().min(3600).max(604_800), default: 86_400, group: "monitoring", description: "Default deep-scan interval (hourly = 3600, daily = 86400)" }),
  "monitoring.limits.maxWebsites": def({ schema: z.number().int().min(1).max(100_000), default: 25, group: "monitoring", description: "Monitored websites per organization (default entitlement)" }),
  "monitoring.limits.maxConcurrentJobs": def({ schema: z.number().int().min(1).max(1000), default: 4, group: "monitoring", description: "Jobs of one organization executing at the same time" }),
  "monitoring.limits.maxOutstandingJobs": def({ schema: z.number().int().min(1).max(100_000), default: 50, group: "monitoring", description: "Scheduled + queued + running jobs per organization (backpressure)" }),
  "monitoring.limits.perCycleQuota": def({ schema: z.number().int().min(1).max(10_000), default: 10, group: "monitoring", description: "Jobs one organization may receive per scheduling cycle (fair share)" }),
  "monitoring.global.maxOutstandingJobs": def({ schema: z.number().int().min(10).max(10_000_000), default: 20_000, group: "monitoring", description: "Platform-wide outstanding jobs per tier before the scheduler applies backpressure" }),
  "monitoring.http.failureThreshold": def({ schema: z.number().int().min(1).max(20), default: 2, group: "monitoring", description: "Consecutive failing HTTP checks before an incident opens (website config / incident rules may override)" }),
  "monitoring.http.recoveryThreshold": def({ schema: z.number().int().min(1).max(20), default: 2, group: "monitoring", description: "Consecutive passing HTTP checks before an incident auto-resolves" }),
  "monitoring.http.maxBodyBytes": def({ schema: z.number().int().min(1024).max(10_485_760), default: 1_048_576, group: "monitoring", description: "Response bytes read for content assertions (larger responses are truncated, not failed)" }),
  "monitoring.http.canaryUrl": def({ schema: z.url().nullable(), default: null, group: "monitoring", description: "Known-good URL probed through the gateway when a check fails at connection level; if it fails too the failure is classified as monitoring infrastructure" }),
  "monitoring.http.interruptedAfter": def({ schema: z.number().int().min(2).max(1000), default: 10, group: "monitoring", description: "Consecutive inconclusive (infrastructure) checks before the customer is told monitoring is interrupted" }),
  "monitoring.http.circuitThreshold": def({ schema: z.number().int().min(1).max(100_000), default: 50, group: "monitoring", description: "Infrastructure failures per 30 s (per worker fleet) after which they are recorded without retries" }),
  "monitoring.browser.defaultEntitled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Organisations get browser monitoring without a plan entitlement or override (keep off: browser monitoring is enabled per plan/org)" }),
  "monitoring.browser.maxWebsites": def({ schema: z.number().int().min(0).max(10_000), default: 5, group: "monitoring", description: "Websites per organisation with browser monitoring (default entitlement)" }),
  "monitoring.browser.maxViewportsPerRun": def({ schema: z.number().int().min(1).max(6), default: 2, group: "monitoring", description: "Viewports rendered per browser execution (cost cap; configured viewports rotate)" }),
  "monitoring.browser.lcpWarnMs": def({ schema: z.number().int().min(100).max(60_000), default: 2500, group: "monitoring", description: "Synthetic LCP warning threshold" }),
  "monitoring.browser.lcpCritMs": def({ schema: z.number().int().min(100).max(60_000), default: 4000, group: "monitoring", description: "Synthetic LCP critical threshold (opens a performance incident)" }),
  "monitoring.browser.clsWarn": def({ schema: z.number().min(0).max(5), default: 0.1, group: "monitoring", description: "Synthetic CLS warning threshold" }),
  "monitoring.browser.clsCrit": def({ schema: z.number().min(0).max(5), default: 0.25, group: "monitoring", description: "Synthetic CLS critical threshold" }),
  // Phase 4G: synthetic performance thresholds (good / poor per metric) and rollups
  "monitoring.performance.thresholds": def({ schema: PerfThresholdSettings, default: DEFAULT_PERF_THRESHOLDS, group: "monitoring", description: "Platform default performance thresholds (good / poor) per synthetic metric" }),
  "monitoring.performance.alertOn": def({ schema: z.array(z.enum(PERF_METRICS)).max(6), default: ["lcp", "cls"], group: "monitoring", description: "Metrics whose POOR result fails a browser check by default" }),
  "monitoring.performance.customThresholdsDefault": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Organisations may set their own performance thresholds without a plan entitlement" }),
  "monitoring.performance.failureThreshold": def({ schema: z.number().int().min(1).max(20), default: 3, group: "monitoring", description: "Consecutive poor checks before a performance incident opens" }),
  "monitoring.performance.recoveryThreshold": def({ schema: z.number().int().min(1).max(20), default: 3, group: "monitoring", description: "Consecutive passing checks before a performance incident recovers" }),
  "monitoring.rollups.enabled": def({ schema: z.boolean(), default: true, group: "monitoring", description: "Maintain hourly / daily performance rollups" }),
  "monitoring.browser.failureThreshold": def({ schema: z.number().int().min(1).max(20), default: 2, group: "monitoring", description: "Consecutive failing browser checks before an incident opens" }),
  "monitoring.browser.recoveryThreshold": def({ schema: z.number().int().min(1).max(20), default: 2, group: "monitoring", description: "Consecutive passing browser checks before an incident auto-resolves" }),
  "monitoring.browser.screenshotBytesPerDay": def({ schema: z.number().int().min(0).max(10_737_418_240), default: 52_428_800, group: "monitoring", description: "Screenshot storage per organisation per day (quota; captures are skipped once reached)" }),
  "monitoring.browser.artifactRetentionDays": def({ schema: z.number().int().min(1).max(365), default: 14, group: "monitoring", description: "Days screenshots are kept" }),
  "monitoring.browser.maxConnectionsPerExecution": def({ schema: z.number().int().min(10).max(5000), default: 300, group: "monitoring", description: "Informational: the gateway's per-execution connection budget (EGRESS_MAX_CONNECTIONS_PER_EXECUTION)" }),
  "monitoring.deepscan.defaultEntitled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Organisations get deep scanning without a plan entitlement or override (keep off)" }),
  "monitoring.deepscan.maxWebsites": def({ schema: z.number().int().min(0).max(10_000), default: 3, group: "monitoring", description: "Websites per organisation with deep scanning (default entitlement)" }),
  "monitoring.deepscan.maxPages": def({ schema: z.number().int().min(1).max(100_000), default: 100, group: "monitoring", description: "Pages per scan (default entitlement; customers can only lower it)" }),
  "monitoring.deepscan.maxDepth": def({ schema: z.number().int().min(0).max(50), default: 5, group: "monitoring", description: "Maximum link depth from the start pages" }),
  "monitoring.deepscan.maxDurationSec": def({ schema: z.number().int().min(30).max(86_400), default: 600, group: "monitoring", description: "Maximum scan duration (the scan stops as PARTIAL when reached)" }),
  "monitoring.deepscan.minRequestDelayMs": def({ schema: z.number().int().min(0).max(60_000), default: 1000, group: "monitoring", description: "Minimum delay between requests to a customer origin (politeness; customers can only increase it)" }),
  "monitoring.deepscan.maxRequests": def({ schema: z.number().int().min(10).max(1_000_000), default: 1000, group: "monitoring", description: "Requests per scan (pages + resources + sitemaps + robots)" }),
  "monitoring.deepscan.maxResponseBytes": def({ schema: z.number().int().min(16_384).max(52_428_800), default: 2_097_152, group: "monitoring", description: "Bytes read per response (pages, sitemaps); larger responses are truncated" }),
  "monitoring.deepscan.pagesPerDay": def({ schema: z.number().int().min(1).max(10_000_000), default: 2000, group: "monitoring", description: "Pages per organisation per day (quota)" }),
  "monitoring.deepscan.browserPages": def({ schema: z.number().int().min(0).max(1000), default: 0, group: "monitoring", description: "Pages per scan rendered in the browser for discovery (needs browser runners; 0 = off)" }),
  "monitoring.deepscan.externalLinks": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Allow external-link status checks (customers must also enable them)" }),
  "monitoring.deepscan.maxExternalLinks": def({ schema: z.number().int().min(0).max(10_000), default: 100, group: "monitoring", description: "External links checked per scan (HEAD only, never followed)" }),
  "monitoring.deepscan.maxConcurrentScans": def({ schema: z.number().int().min(1).max(100), default: 1, group: "monitoring", description: "Deep scans of one organisation running at the same time" }),
  "monitoring.deepscan.retentionDays": def({ schema: z.number().int().min(7).max(730), default: 90, group: "monitoring", description: "Days scan history (scans, page facts, resolved findings) is kept" }),
  "monitoring.deepscan.manualCooldownSec": def({ schema: z.number().int().min(0).max(86_400), default: 900, group: "monitoring", description: "Minimum time between customer-started scans of a website" }),
  "scheduler.batchSize": def({ schema: z.number().int().min(10).max(10_000), default: 500, group: "monitoring", description: "Due schedules considered per cycle" }),
  "scheduler.reconcileAfterSec": def({ schema: z.number().int().min(5).max(3600), default: 30, group: "monitoring", description: "Re-enqueue executions stuck in SCHEDULED/QUEUED for longer than this" }),
  "scheduler.leaseSec": def({ schema: z.number().int().min(10).max(7200), default: 60, group: "monitoring", description: "A RUNNING execution whose worker stopped renewing for this long is recovered" }),
  "queue.http-monitoring": def({ schema: QueuePolicy, default: { concurrency: 50, globalConcurrency: 500, ratePerSecond: 200, attempts: 3, backoffBaseMs: 5000, backoffMaxMs: 60_000, timeoutMs: 30_000, keepCompletedHours: 24, keepFailedDays: 7 }, group: "monitoring", description: "HTTP monitoring queue policy" }),
  "queue.browser-monitoring": def({ schema: QueuePolicy, default: { concurrency: 4, globalConcurrency: 40, ratePerSecond: 10, attempts: 2, backoffBaseMs: 30_000, backoffMaxMs: 600_000, timeoutMs: 120_000, keepCompletedHours: 24, keepFailedDays: 7 }, group: "monitoring", description: "Browser monitoring queue policy" }),
  "queue.deep-scan": def({ schema: QueuePolicy, default: { concurrency: 2, globalConcurrency: 10, ratePerSecond: 2, attempts: 2, backoffBaseMs: 60_000, backoffMaxMs: 1_800_000, timeoutMs: 900_000, keepCompletedHours: 48, keepFailedDays: 14 }, group: "monitoring", description: "Deep-scan queue policy" }),

  // ---- Phase 4H: platform operations (health evaluation, self-alerts, usage reconciliation, functional-test policy)
  "monitoring.functional.enabled": def({ schema: z.boolean(), default: false, group: "monitoring", description: "Platform switch for opt-in functional tests (interactions on customer pages). Off: no interaction runs, whatever websites configured" }),
  "ops.health.evaluateEverySec": def({ schema: z.number().int().min(10).max(300), default: 30, group: "operations", description: "How often platform health is evaluated (one evaluator at a time)" }),
  "ops.health.heartbeatStaleSec": def({ schema: z.number().int().min(25).max(900), default: 45, group: "operations", description: "A worker whose heartbeat is older than this is not alive" }),
  "ops.health.processingStallSec": def({ schema: z.number().int().min(60).max(7200), default: 600, group: "operations", description: "Jobs are waiting but no worker of the queue finished a job for this long → not processing" }),
  "ops.health.workerMemoryMb": def({ schema: z.number().int().min(128).max(65_536), default: 2048, group: "operations", description: "Memory budget per worker process (utilisation alerts)" }),
  "ops.alerts.enabled": def({ schema: z.boolean(), default: true, group: "operations", description: "Platform self-alerts (evaluation still runs and is shown when off; nothing is opened or sent)" }),
  "ops.alerts.recipients": def({ schema: z.array(z.email().max(254)).max(20), default: [], group: "operations", description: "Alert e-mail recipients; empty = all active Super Admins and operators" }),
  "ops.alerts.thresholds": def({ schema: AlertThresholds, default: DEFAULT_ALERT_THRESHOLDS, group: "operations", description: "Warning / critical thresholds per signal (warning must be below critical)" }),
  "ops.alerts.severity": def({ schema: z.partialRecord(z.enum(ALERT_RULES), z.enum(["CRITICAL", "WARNING", "INFO"])), default: {}, group: "operations", description: "Severity override per alert rule (default: critical when unhealthy, warning when degraded)" }),
  "ops.alerts.disabledRules": def({ schema: z.array(z.enum(ALERT_RULES)).max(ALERT_RULES.length), default: [], group: "operations", description: "Alert rules that never open an alert (state is still evaluated and shown)" }),
  "ops.alerts.openAfterEvaluations": def({ schema: z.number().int().min(1).max(20), default: 2, group: "operations", description: "Consecutive bad evaluations before an alert opens (noise protection)" }),
  "ops.alerts.recoverAfterEvaluations": def({ schema: z.number().int().min(1).max(20), default: 2, group: "operations", description: "Consecutive good evaluations before an alert recovers" }),
  "ops.alerts.cooldownMin": def({ schema: z.number().int().min(1).max(1440), default: 30, group: "operations", description: "An alert that recovers and fails again within this window is reopened (not new) and not re-sent" }),
  "ops.alerts.renotifyCriticalMin": def({ schema: z.number().int().min(0).max(10_080), default: 120, group: "operations", description: "Repeat the notification of an unacknowledged critical alert after this long (0 = never)" }),
  "ops.alerts.maxNotificationsPer10Min": def({ schema: z.number().int().min(1).max(200), default: 10, group: "operations", description: "Alert-storm cap: notifications beyond this in 10 minutes are recorded, summarised once, not sent" }),
  "ops.alerts.delivery": def({ schema: z.object({ attempts: z.number().int().min(1).max(20), backoffMs: z.number().int().min(100).max(3_600_000) }).strict(), default: { attempts: 6, backoffMs: 30_000 }, group: "operations", description: "Alert e-mail delivery retries" }),
  "ops.usage.reconcileDaily": def({ schema: z.boolean(), default: true, group: "operations", description: "Reconcile yesterday's usage against the execution ledger and stored results once a day" }),

  // ---- billing (Phase 8)
  "billing.enabled": def({ schema: z.boolean(), default: false, group: "billing", public: true, description: "Billing is live: checkout, plan changes and every payment-gateway call are refused while this is off. Plan entitlements of a current subscription apply either way" }),
  "billing.gatewayByCurrency": def({ schema: z.record(z.string().regex(/^[A-Z]{3}$/), z.enum(["STRIPE", "RAZORPAY"])), default: { INR: "RAZORPAY", USD: "STRIPE" }, group: "billing", description: "Which payment gateway handles checkout in each currency" }),
  "billing.graceDays": def({ schema: z.number().int().min(0).max(30), default: 7, group: "billing", description: "Days of continued service after a failed renewal before the subscription expires" }),
  "billing.dunning.reminderDays": def({ schema: z.array(z.number().int().min(0).max(30)).max(10), default: [0, 3, 6], group: "billing", description: "Days after the first failed renewal on which payment reminders are due (within the grace period)" }),
  "billing.webhookToleranceSec": def({ schema: z.number().int().min(60).max(900), default: 300, group: "billing", description: "Maximum age of a signed webhook (replay window)" }),
  "billing.freePlanKey": def({ schema: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/).nullable(), default: null, group: "billing", description: "Plan applied to organisations without a subscription or active trial (null = none: monitoring stops after the trial)" }),
  "billing.reconcileDaily": def({ schema: z.boolean(), default: true, group: "billing", description: "Daily comparison of local subscriptions with the gateway (only while billing is enabled and a gateway is configured)" }),
  "trial.planKey": def({ schema: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/).nullable(), default: "pro", group: "trial", description: "Plan whose entitlements apply during the free trial (only while billing is enabled)" }),
  "billing.intervals": def({ schema: z.array(z.enum(["MONTH", "YEAR"])).min(1), default: ["MONTH", "YEAR"], group: "billing", public: true, description: "Billing intervals offered" }),
  "billing.tax.mode": def({ schema: z.enum(["NONE", "GATEWAY", "GST"]), default: "GATEWAY", group: "billing", description: "Tax calculation: gateway-calculated (Stripe Tax) or Indian GST computed by the platform" }),
  "billing.tax.gstRatePct": def({ schema: z.number().min(0).max(28), default: 18, group: "billing", description: "GST rate for Indian customers (IGST/CGST+SGST split by place of supply)" }),
  "billing.tax.sellerGstin": def({ schema: z.string().regex(/^[0-9A-Z]{15}$/).nullable(), default: null, group: "billing", description: "Seller GSTIN printed on invoices" }),
  "billing.tax.sellerStateCode": def({ schema: z.string().regex(/^\d{2}$/).nullable(), default: "27", group: "billing", description: "Seller state code for place-of-supply (27 = Maharashtra)" }),

  // ---- platform
  "platform.defaultTimezone": def({ schema: z.string().min(1).max(64), default: "Asia/Kolkata", group: "platform", public: true, description: "Default display timezone for new organizations" }),
  "platform.defaultCurrency": def({ schema: z.string().regex(/^[A-Z]{3}$/), default: "INR", group: "platform", public: true, description: "Default currency for new organizations" }),
  "platform.maintenanceMode": def({ schema: z.boolean(), default: false, group: "platform", public: true, description: "Read-only maintenance mode" }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export type SettingsSnapshot = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, k);
}

export function defaultSettings(): SettingsSnapshot {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as SettingsSnapshot;
}

/** Validate a value for a key. Throws a ZodError on invalid input. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(value) as SettingValue<K>;
}

/**
 * Merge stored values over defaults. Invalid stored values fall back to the
 * default (and are reported) so a bad row can never take the platform down.
 */
export function resolveSettings(
  stored: Array<{ key: string; value: unknown }>,
  onInvalid?: (key: string, error: unknown) => void,
): SettingsSnapshot {
  const out = defaultSettings() as Record<string, unknown>;
  for (const row of stored) {
    if (!isSettingKey(row.key)) continue;
    const r = SETTINGS[row.key].schema.safeParse(row.value);
    if (r.success) out[row.key] = r.data;
    else onInvalid?.(row.key, r.error);
  }
  return out as SettingsSnapshot;
}

export function publicSettings(s: SettingsSnapshot): Partial<SettingsSnapshot> {
  return Object.fromEntries(SETTING_KEYS.filter((k) => SETTINGS[k].public).map((k) => [k, s[k]])) as Partial<SettingsSnapshot>;
}
