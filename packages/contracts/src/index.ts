import { z } from "zod";
import { ALL_PERMISSIONS, type Permission } from "@wim/core";
import { WEBSITE_CATEGORIES, SdkConfig, type InstallationState, type TrialOutcome, type WebsiteCategory } from "@wim/core";


/**
 * Request schemas and response DTOs shared by apps/api, apps/web and apps/admin.
 * Server-side policy that depends on settings (e.g. a configured minimum password
 * length above 12) is enforced additionally by the API.
 */

// ---------------------------------------------------------------- primitives
export const Email = z.email().max(254).transform((e) => e.trim().toLowerCase());
export const Password = z.string().min(12).max(128);
export const Name = z.string().trim().min(1).max(100);
export const Uuid = z.uuid();
export const TotpCode = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");
export const RecoveryCodeInput = z.string().trim().min(12).max(20);
export const Timezone = z.string().min(1).max(64).refine((tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}, "Unknown timezone");
const PermissionSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

// ---------------------------------------------------------------- auth
export const RegisterInput = z.object({
  email: Email,
  password: Password,
  name: Name,
  acceptTerms: z.literal(true),
  termsVersion: z.string().min(1).max(40),
  timezone: Timezone.optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({ email: Email, password: z.string().min(1).max(128) });
export type LoginInput = z.infer<typeof LoginInput>;

export const TokenInput = z.object({ token: z.string().min(20).max(200) });
export const ForgotPasswordInput = z.object({ email: Email });
export const ResetPasswordInput = z.object({ token: z.string().min(20).max(200), password: Password });
export const ChangePasswordInput = z.object({ currentPassword: z.string().min(1).max(128), newPassword: Password });

export const TotpConfirmInput = z.object({ code: TotpCode });
export const SecondFactorInput = z.union([
  z.object({ code: TotpCode }),
  z.object({ recoveryCode: RecoveryCodeInput }),
]);
export type SecondFactorInput = z.infer<typeof SecondFactorInput>;
export const TwoFactorDisableInput = z.object({ password: z.string().min(1).max(128), code: TotpCode });
export const RegenerateRecoveryCodesInput = z.object({ code: TotpCode });

export const UpdateMeInput = z.object({ name: Name.optional(), timezone: Timezone.optional(), locale: z.string().min(2).max(10).optional() });

// ---------------------------------------------------------------- orgs, members, roles
export const CreateOrgInput = z.object({ name: Name, timezone: Timezone.optional() });
export const UpdateOrgInput = z.object({
  name: Name.optional(),
  timezone: Timezone.optional(),
  supportAccess: z.enum(["REQUIRE_CUSTOMER_CONSENT", "ALLOW_WITH_NOTICE", "DENY"]).optional(),
});
export const InviteInput = z.object({ email: Email, roleId: Uuid });
export const UpdateMemberInput = z.object({ roleId: Uuid });
export const CreateRoleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(PermissionSchema).min(1).max(ALL_PERMISSIONS.length),
});
export const UpdateRoleInput = CreateRoleInput.partial();
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- admin
export const AdminLoginInput = LoginInput;
export const AdminSecondFactorInput = z.object({ code: TotpCode });
export const AdminReason = z.string().trim().min(5).max(500);
export const AdminSettingsPatchInput = z.object({
  changes: z.array(z.object({ key: z.string().min(1).max(100), value: z.unknown() })).min(1).max(50),
  reason: AdminReason,
  /** Phase 4H: required (true) when a change touches a protected security policy */
  confirmProtected: z.boolean().optional(),
});
// ---- Phase 4H: operations
export const AdminAlertQuery = z.object({
  state: z.enum(["ACTIVE", "OPEN", "ACKNOWLEDGED", "RECOVERED", "ALL"]).default("ACTIVE"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export const AdminAckInput = z.object({ reason: AdminReason }).strict();
export const AdminOpsHistoryQuery = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).strict();
export const AdminUsageQuery = z.object({
  from: z.iso.date(), to: z.iso.date(),
  orgId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict().refine((q) => q.from <= q.to && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92, { message: "range must be ascending and at most 92 days" });
export const AdminReconcileInput = z.object({ day: z.iso.date(), reason: AdminReason }).strict();
export const AdminAdjustInput = z.object({
  orgId: Uuid, day: z.iso.date(), key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,3}$/).max(80),
  delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 100_000_000, { message: "delta must be a non-zero integer up to 1e8" }),
  reason: z.string().trim().min(10).max(500), discrepancyId: Uuid.optional(),
}).strict();
export const AdminAcceptDiscrepancyInput = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const AdminRetentionInput = z.object({ days: z.number().int().min(1).max(1095), reason: AdminReason }).strict();

// ---------------------------------------------------------------- queue contracts
/**
 * Transactional email jobs. Payloads carry ids only: tokens are issued by the
 * worker at send time, so no secret ever rests in Redis (SECURITY.md §13).
 */
export const EMAIL_QUEUE = "email";
export const SecurityNotice = z.enum([
  "PASSWORD_CHANGED", "TWO_FACTOR_ENABLED", "TWO_FACTOR_DISABLED", "RECOVERY_CODE_USED",
  "RECOVERY_CODES_REGENERATED", "MFA_RESET_COMPLETED", "ACCOUNT_LOCKED",
]);
export type SecurityNotice = z.infer<typeof SecurityNotice>;
export const EmailJob = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("VERIFY_EMAIL"), userId: Uuid }),
  z.object({ kind: z.literal("ACCOUNT_EXISTS"), userId: Uuid }),
  z.object({ kind: z.literal("PASSWORD_RESET"), userId: Uuid }),
  z.object({ kind: z.literal("SECURITY_NOTICE"), userId: Uuid, notice: SecurityNotice, data: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
  z.object({ kind: z.literal("MFA_RESET_CONFIRM"), requestId: Uuid }),
  z.object({ kind: z.literal("MFA_RESET_SCHEDULED"), requestId: Uuid }),
  z.object({ kind: z.literal("INVITATION"), orgId: Uuid, invitationId: Uuid }),
  z.object({ kind: z.literal("TRANSFER_REQUESTED"), transferId: Uuid }),
  z.object({ kind: z.literal("TRANSFER_DECIDED"), transferId: Uuid }),
  z.object({ kind: z.literal("OWNERSHIP_NOTICE"), claimId: Uuid, notice: z.enum(["FAILING", "LAPSED", "RESTORED", "LOST"]) }),
  /** Phase 4C: monitoring notice built from a transactional outbox event (ids only). */
  z.object({ kind: z.literal("MONITORING_NOTICE"), outboxId: z.string().regex(/^\d{1,19}$/) }),
  /** Phase 4H: platform self-alert from the outbox (ids only), sent to platform operators. */
  z.object({ kind: z.literal("PLATFORM_ALERT"), outboxId: z.string().regex(/^\d{1,19}$/) }),
  /** Phase 4H: PostgreSQL itself unavailable — the alert cannot go through the outbox; recipients from the environment. */
  z.object({ kind: z.literal("PLATFORM_ALERT_DIRECT"), rule: z.literal("postgres.unavailable"), since: z.iso.datetime(), reason: z.string().max(200), evaluator: z.string().max(80) }),
]);
export type EmailJob = z.infer<typeof EmailJob>;

// ---------------------------------------------------------------- responses
export type ErrorCode =
  | "VALIDATION_FAILED" | "UNAUTHENTICATED" | "SECOND_FACTOR_REQUIRED" | "FORBIDDEN" | "CSRF_INVALID"
  | "ACCOUNT_SUSPENDED" | "EMAIL_NOT_VERIFIED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED"
  | "REGISTRATION_CLOSED" | "INVALID_TOKEN" | "INVALID_CODE" | "WEAK_PASSWORD" | "LAST_OWNER" | "INTERNAL"
  | "INVALID_URL" | "DOMAIN_ALREADY_REGISTERED" | "DOMAIN_BLOCKED" | "WEBSITE_LIMIT" | "VERIFICATION_EXPIRED" | "TOKEN_EXHAUSTED"
  | "LINK_EXPIRED"
  | "ARTIFACT_EXPIRED" | "FEATURE_UNAVAILABLE" | "RISK_ACKNOWLEDGEMENT_REQUIRED";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown>; requestId: string };
}

export interface DataEnvelope<T> { data: T }
export interface ListEnvelope<T> { data: T[]; nextCursor: string | null }

export interface OrgMembershipDto { id: string; name: string; slug: string; role: { id: string; key: string; name: string } }

export interface MeDto {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  timezone: string;
  locale: string;
  twoFactor: { enabled: boolean; recoveryCodesRemaining: number };
  orgs: OrgMembershipDto[];
}

export type LoginStatus = "AUTHENTICATED" | "SECOND_FACTOR_REQUIRED";
export interface LoginResultDto { status: LoginStatus; me?: MeDto; mfaReset?: MfaResetStatusDto | null }

export interface MfaResetStatusDto { id: string; status: "PENDING_EMAIL" | "WAITING" | "READY"; eligibleAt: string | null }

export interface SessionDto {
  id: string; current: boolean; userAgent: string | null; ipPrefix: string | null;
  createdAt: string; lastSeenAt: string; expiresAt: string;
}

export interface TotpEnrollmentDto { otpauthUrl: string; secret: string; qrSvg: string }
export interface RecoveryCodesDto { recoveryCodes: string[] }

export interface OrgDto {
  id: string; name: string; slug: string; status: string; timezone: string; currency: string;
  supportAccess: string; createdAt: string; myRole: { id: string; key: string; name: string; permissions: Permission[] };
}

export interface MemberDto {
  id: string; userId: string; name: string | null; email: string; twoFactorEnabled: boolean;
  role: { id: string; key: string; name: string }; joinedAt: string; isMe: boolean;
}

export interface InvitationDto {
  id: string; email: string; role: { id: string; key: string; name: string }; status: string;
  expiresAt: string; createdAt: string;
}

export interface InvitationPreviewDto { orgName: string; roleName: string; email: string; expiresAt: string }

export interface RoleDto {
  id: string; key: string; name: string; description: string | null; isSystem: boolean;
  permissions: Permission[]; memberCount: number;
}

export interface PermissionDto { key: Permission; description: string }

export interface AuditEntryDto {
  id: string; seq: string; occurredAt: string; actorType: string; actorLabel: string | null;
  action: string; targetType: string | null; targetId: string | null; ipPrefix: string | null;
  changes: unknown; reason: string | null;
}

export interface PublicConfigDto {
  productName: string; logoUrl: string | null; faviconUrl: string | null; primaryColor: string;
  supportEmail: string | null; termsUrl: string | null; privacyUrl: string | null; termsVersion: string;
  registration: "OPEN" | "INVITE_ONLY" | "CLOSED"; passwordMinLength: number; maintenanceMode: boolean;
}

// ---------------------------------------------------------------- admin responses
export interface AdminMeDto { id: string; email: string; name: string; role: string; permissions: string[] }

export interface AdminOverviewDto {
  generatedAt: string;
  users: { total: number; verified: number; withTwoFactor: number; signups7d: number; signups30d: number };
  organizations: { total: number; active: number; suspended: number; pendingDeletion: number };
  subscriptions: { trialing: number; paid: number; pastDue: number; expired: number };
  websites: { total: number; active: number; pendingVerification: number };
  incidents: { open: number; openCritical: number };
  monitoring: { executions24h: number; failedExecutions24h: number };
  jobs: { unresolvedFailures: number };
  workers: { healthy: number; total: number };
  signupsDaily: Array<{ day: string; count: number }>;
}

export interface AdminCustomerRowDto {
  id: string; name: string; slug: string; status: string; createdAt: string; planKey: string | null;
  subscriptionStatus: string | null; trialStatus: string | null; trialEndsAt: string | null;
  memberCount: number; websiteCount: number; ownerEmailMasked: string | null;
}

export interface AdminSettingDto {
  key: string; group: string; description: string; value: unknown; defaultValue: unknown;
  version: number | null; updatedAt: string | null; public: boolean;
  /** Phase 4H */
  section?: string; protected?: boolean; apply?: "live" | "restart"; scope?: "global";
}

// =============================================================================
// Phase 3 — websites, verification, SDK installation, transfers
// =============================================================================

export const WebsiteCategoryInput = z.enum(WEBSITE_CATEGORIES);
export const WebsitePreviewInput = z.object({ url: z.string().trim().min(1).max(2048) });
export const CreateWebsiteInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048),
  description: z.string().trim().max(500).optional(),
  category: WebsiteCategoryInput.default("OTHER"),
  monitoringTimezone: Timezone.optional(),
});
export type CreateWebsiteInput = z.infer<typeof CreateWebsiteInput>;
export const UpdateWebsiteInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  category: WebsiteCategoryInput.optional(),
  monitoringTimezone: Timezone.optional(),
});
export const VerificationMethodInput = z.enum(["DNS_TXT", "WELL_KNOWN_FILE", "HTML_META", "ANY"]);
export const VerifyWebsiteInput = z.object({ method: VerificationMethodInput.default("ANY") });
export const DeleteWebsiteInput = z.object({ confirmHost: z.string().trim().min(1).max(253) });
export const UpdateSdkConfigInput = SdkConfig.partial().strict();
export const RequestTransferInput = z.object({ url: z.string().trim().min(1).max(2048) });

export type DomainAvailability = "AVAILABLE" | "YOURS" | "CLAIMED_ELSEWHERE" | "PENDING_ELSEWHERE" | "BLOCKED";

export interface WebsitePreviewDto {
  identityKey: string; host: string; hostKey: string; displayHost: string; registrableDomain: string; isRoot: boolean;
  canonicalOrigin: string; availability: DomainAvailability; notes: string[];
}

export interface VerificationInstructionsDto {
  value: string;
  token: string;
  dns: { hostRecord: { type: "TXT"; name: string; value: string }; rootRecord: { type: "TXT"; name: string; value: string } };
  file: { url: string; content: string };
  meta: { tag: string };
}

export interface WebsiteClaimDto {
  status: "PENDING" | "VERIFIED" | "LAPSED" | "EXPIRED" | "RELEASED" | "TRANSFERRED_OUT" | "REJECTED";
  scope: "ROOT" | "HOST";
  verifiedAt: string | null;
  verifiedMethod: string | null;
  inherited: boolean;
  pendingExpiresAt: string | null;
  attemptsUsed: number;
  attemptsAllowed: number;
  revalidation: {
    state: "OK" | "FAILING" | "LAPSED";
    lastCheckedAt: string | null;
    lastOutcome: string | null;
    nextCheckAt: string | null;
    failingSince: string | null;
    /** when a FAILING claim lapses (monitoring suspended) */
    lapsesAt: string | null;
    /** when a LAPSED claim is released (ownership lost) */
    releaseAt: string | null;
  } | null;
}

export interface InstallationDto {
  state: InstallationState;
  siteKey: string | null;
  keyCreatedAt: string;
  revoked: boolean;
  previousKeyValidUntil: string | null;
  telemetryPaused: boolean;
  sdkVersion: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  pageLoads: number;
  lastInvalidAt: string | null;
  lastInvalidReason: string | null;
  lastCheck: unknown;
  lastCheckedAt: string | null;
  snippet: string | null;
  scriptUrl: string;
  sdkConfig: z.infer<typeof SdkConfig>;
}

export interface WebsiteSummaryDto {
  id: string; name: string; displayHost: string; hostKey: string; status: string; category: WebsiteCategory;
  verification: WebsiteClaimDto["status"]; installation: InstallationState; trialOutcome: TrialOutcome | null;
  createdAt: string; lastActivityAt: string | null;
}

export interface WebsiteDetailDto extends WebsiteSummaryDto {
  description: string | null;
  monitoringTimezone: string;
  canonicalOrigin: string;
  registrableDomain: string;
  verifiedAt: string | null;
  claim: WebsiteClaimDto;
  instructions: VerificationInstructionsDto | null;
  installation: InstallationState;
  install: InstallationDto;
  pendingTransfer: { id: string; status: string; ownerResponse: string | null; ownerRespondBy: string | null } | null;
  orgTrial: { status: string; startsAt: string; endsAt: string; registrableDomain: string } | null;
}

export interface VerificationAttemptDto {
  id: string; method: string; status: string; failureReason: string | null; detail: unknown;
  scopeGranted: string | null; requestedAt: string; completedAt: string | null;
}

export interface TransferDto {
  id: string; displayHost: string; status: string; createdAt: string; verifiedAt: string | null; decidedAt: string | null;
  tokenExpiresAt: string | null; record: { type: "TXT"; name: string; value: string } | null; lastCheckDetail: unknown;
}

// ---------------------------------------------------------------- verification queue (ids only)
export const VERIFY_QUEUE = "verify";
export const VerifyJob = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("VERIFY_DOMAIN"), claimId: Uuid, websiteId: Uuid, method: VerificationMethodInput, actorUserId: Uuid, token: z.string() }),
  z.object({ kind: z.literal("CHECK_INSTALLATION"), websiteId: Uuid, actorUserId: Uuid }),
  z.object({ kind: z.literal("VERIFY_TRANSFER"), transferId: Uuid, actorUserId: Uuid }),
  z.object({ kind: z.literal("APPLY_TRANSFER"), transferId: Uuid, adminId: Uuid }),
  z.object({ kind: z.literal("SWEEP_CLAIMS") }),
]);
export type VerifyJob = z.infer<typeof VerifyJob>;

// ---------------------------------------------------------------- ownership revalidation queue (Phase 4A)
export const REVALIDATE_QUEUE = "revalidate";
export const RevalidateJob = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("REVALIDATE_DOMAIN"), claimId: Uuid, manual: z.boolean().default(false) }),
  z.object({ kind: z.literal("SWEEP_REVALIDATION") }),
]);
export type RevalidateJob = z.infer<typeof RevalidateJob>;

// ---------------------------------------------------------------- admin
export const AdminTransferDecisionInput = z.object({ decision: z.enum(["APPROVE", "REJECT"]), reason: AdminReason });

export interface AdminWebsiteStatsDto {
  generatedAt: string;
  websites: { total: number; verified: number; unverified: number; archived: number; added7d: number };
  claims: { pending: number; verified: number; rootScope: number; expired: number };
  verifications: { dns: number; file: number; meta: number; failed24h: number };
  sdk: { notInstalled: number; seen24h: number; inactive: number; invalidConfiguration: number };
  trials: { activatedTotal: number; activated7d: number; active: number; domainsConsumed: number };
  registrationAttempts: { duplicates24h: number; duplicates30d: number; blocked30d: number; suspiciousOrgs24h: number };
  transfers: { pendingVerification: number; pendingAdmin: number; approved: number; rejected: number; cancelled: number };
  daily: Array<{ day: string; accepted: number; duplicates: number; verified: number }>;
}

// ============================================================================ Phase 4B: monitoring schedules & executions
export interface MonitoringScheduleDto {
  tier: "HTTP" | "BROWSER" | "DEEPSCAN";
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  /** why a schedule is paused (customer-safe codes) */
  pausedReason: string | null;
  intervalSec: number;
  nextRunAt: string | null;
  lastEnqueuedAt: string | null;
}
export interface MonitoringExecutionDto {
  id: string;
  tier: "HTTP" | "BROWSER" | "DEEPSCAN";
  status: string;
  trigger: string;
  attempt: number;
  windowStart: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  failureCategory: string | null;
}
export interface WebsiteMonitoringDto {
  monitoringPaused: boolean;
  schedules: MonitoringScheduleDto[];
  executions: MonitoringExecutionDto[];
}
export const MonitoringPauseInput = z.object({ paused: z.boolean() }).strict();

export const AdminReplayInput = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const AdminDeadLetterQuery = z.object({
  status: z.enum(["OPEN", "RESOLVED", "ALL"]).default("OPEN"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// ============================================================================ Phase 4C: HTTP availability monitoring
/** Same shape as @wim/core HttpCheckConfig; validated again by the core schema. */
export const HttpCheckConfigInput = z.object({
  method: z.enum(["GET", "HEAD"]).optional(),
  path: z.string().max(500).optional(),
  expectedStatus: z.array(z.string()).min(1).max(20).optional(),
  timeoutMs: z.number().int().optional(),
  maxRedirects: z.number().int().optional(),
  contentMarker: z.string().max(200).nullable().optional(),
  expectedContentType: z.string().max(100).nullable().optional(),
  serverErrorsAreDowntime: z.boolean().optional(),
  sslWarningDays: z.array(z.number().int()).optional(),
  failureThreshold: z.number().int().nullable().optional(),
  recoveryThreshold: z.number().int().nullable().optional(),
}).strict();

export interface HttpCheckResultDto {
  id: string;
  executionId: string;
  windowStart: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number | null;
  outcome: "PASSED" | "FAILED" | "INCONCLUSIVE";
  available: boolean | null;
  failureKind: string | null;
  failureCategory: string | null;
  failureDescription: string | null;
  method: string | null;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  redirects: Array<{ url: string; status: number }>;
  timings: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null; totalMs: number | null };
  bytes: number | null;
  contentType: string | null;
  headers: Record<string, string>;
  tls: { valid: boolean | null; validTo: string | null; daysRemaining: number | null; issuer: string | null; error: string | null; hostnameMatch: boolean | null } | null;
}

export interface UptimeDto { uptimePercent: number | null; measuredChecks: number; upChecks: number; downChecks: number; scheduledChecks: number; coveragePercent: number | null }

export interface HttpMonitoringSummaryDto {
  state: "UP" | "DOWN" | "DEGRADED" | "UNKNOWN" | "PAUSED" | "NOT_MONITORED";
  latest: HttpCheckResultDto | null;
  lastSuccessfulCheckAt: string | null;
  lastFailedCheckAt: string | null;
  uptime: { h24: UptimeDto; d7: UptimeDto; d30: UptimeDto };
  responseTime24h: { avgMs: number | null; p50Ms: number | null; p95Ms: number | null; samples: number };
  ssl: { validTo: string | null; daysRemaining: number | null; issuer: string | null; valid: boolean | null; checkedAt: string | null } | null;
  openIncidents: IncidentSummaryDto[];
  config: Record<string, unknown>;
  /** what these numbers are: synthetic checks from our infrastructure, not real-user measurements */
  measurement: "SYNTHETIC_HTTP";
}

export interface IncidentSummaryDto {
  id: string;
  number: number;
  websiteId: string;
  websiteName?: string;
  /** HTTP | BROWSER | DEEP_SCAN (detection source) */
  source?: string;
  acknowledgedAt?: string | null;
  autoResolved?: boolean;
  reopenCount?: number;
  updatedAt?: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  checkKey: string;
  occurrenceCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  durationSec: number | null;
}
export interface IncidentDetailDto extends IncidentSummaryDto {
  diagnostics: Record<string, unknown>;
  events: Array<{ type: string; at: string; fromStatus: string | null; toStatus: string | null; data: Record<string, unknown> | null }>;
  occurrences: Array<{ at: string; executionId: string | null; url: string | null; details: Record<string, unknown>; link?: string | null }>;
  /** delivery summary only: counts and times, never recipient addresses */
  notifications?: Array<{ event: string; channel: string; status: string; count: number; lastAt: string | null }>;
  /** the signed-in user's own in-app notifications about this incident */
  notifiedMe?: boolean;
}
export const IncidentListQuery = z.object({
  /** ACTIVE = open, acknowledged, investigating or reopened */
  status: z.enum(["ACTIVE", "OPEN", "ACKNOWLEDGED", "REOPENED", "RESOLVED", "ALL"]).default("ACTIVE"),
  websiteId: z.uuid().optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  source: z.enum(["HTTP", "BROWSER", "DEEP_SCAN"]).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** keyset cursor from a previous page (`nextCursor`) */
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const HttpResultsQuery = z.object({
  before: z.iso.datetime().optional(),
  from: z.iso.datetime().optional(),
  outcome: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// ============================================================================ Phase 4D: browser monitoring
export const BrowserCheckConfigInput = z.object({
  enabled: z.boolean().optional(),
  path: z.string().max(500).optional(),
  readiness: z.object({
    strategy: z.enum(["load", "domcontentloaded", "networkquiet", "selector", "fixed"]).optional(),
    selector: z.string().max(200).nullable().optional(),
    quietMs: z.number().int().optional(),
    settleMs: z.number().int().optional(),
  }).strict().optional(),
  navigationTimeoutMs: z.number().int().optional(),
  maxRedirects: z.number().int().optional(),
  primaryViewport: z.string().optional(),
  viewports: z.array(z.string()).optional(),
  extraViewportsPerRun: z.number().int().optional(),
  screenshots: z.object({ onFailure: z.boolean().optional(), onSuccess: z.boolean().optional(), fullPage: z.boolean().optional(), mask: z.array(z.string()).optional() }).strict().optional(),
  consoleErrorsAreFailures: z.boolean().optional(),
  thirdPartyFailuresAreFailures: z.boolean().optional(),
  performance: z.object({ lcpWarnMs: z.number().optional(), lcpCritMs: z.number().optional(), clsWarn: z.number().optional(), clsCrit: z.number().optional() }).strict().optional(),
  failureThreshold: z.number().int().nullable().optional(),
  recoveryThreshold: z.number().int().nullable().optional(),
  /** Phase 4F (validated in full by the core schema) */
  components: z.object({ detect: z.boolean().optional() }).strict().optional(),
  functional: z.record(z.string(), z.unknown()).optional(),
  /** release readiness: third-party policy enforced by the gateway (validated in full by the core schema) */
  thirdParty: z.object({ mode: z.enum(["all", "allowlist", "none"]).optional(), allowedDomains: z.array(z.string().max(253)).max(50).optional(), maxHosts: z.number().int().optional() }).strict().optional(),
  /** popups / cookie banners on load (closeSelector validated in full by the core schema; null clears it) */
  popups: z.object({ dismiss: z.boolean().optional(), closeSelector: z.string().max(200).nullable().optional() }).strict().optional(),
  /** Phase 4H: required (true) the first time functional tests are enabled — records who accepted the risk, and when */
  acknowledgeFunctionalRisk: z.boolean().optional(),
}).strict();

// ---------------------------------------------------------------- Phase 4F: components, functional tests, responsive matrix
export interface ComponentDto {
  id: string; type: string; label: string | null; status: "PRESENT" | "REMOVED"; pagePath: string; detail: Record<string, unknown>;
  viewports: string[]; firstSeenAt: string; lastSeenAt: string; removedAt: string | null; occurrences: number;
}
export interface ComponentEventDto { id: string; at: string; type: "ADDED" | "CHANGED" | "REMOVED" | "RESTORED"; componentId: string; componentType: string; label: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; executionId: string }
export interface FunctionalTestDto {
  kind: string; componentType: string; target: string; viewport: string; outcome: "PASSED" | "FAILED" | "SKIPPED" | "INCONCLUSIVE";
  reason: string | null; safety: string | null; steps: Array<{ step: string; ok: boolean; ms: number; note?: string }>; durationMs: number | null;
}
export interface ResponsiveResultDto {
  viewport: string; width: number; height: number; status: string; navState: string | null; overflowPx: number; clippedText: number; overlaps: number;
  obscuredControls: number; offscreenControls: number; offscreenText: number; oversizedImages: number;
  objective: string[]; heuristic: string[]; samples: Array<{ issue: string; selector: string }>;
}
export const ComponentListQuery = z.object({
  status: z.enum(["PRESENT", "REMOVED", "ALL"]).default("PRESENT"),
  type: z.string().regex(/^[A-Z_]{3,20}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();
export const ComponentHistoryQuery = z.object({ cursor: z.string().regex(/^\d{1,20}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

export interface BrowserViewportResultDto {
  viewport: string;
  width: number | null;
  height: number | null;
  outcome: "PASSED" | "FAILED" | "INCONCLUSIVE";
  failureKind: string | null;
  failureDescription: string | null;
  navigation: Record<string, unknown> | null;
  rendering: Record<string, unknown> | null;
  scripts: Record<string, unknown> | null;
  network: Record<string, unknown> | null;
  layout: { horizontalOverflowPx: number; offscreenText: number; findings: Record<string, unknown> | null } | null;
  /** synthetic (one Chromium through our gateway) — not real-user Core Web Vitals; INP is never produced here */
  syntheticPerformance: { ttfbMs: number | null; fcpMs: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; loadMs: number | null; requests: number | null; transferBytes: number | null } | null;
  warnings: string[];
  /** popup / cookie banner on load and what closing it did (null on results recorded before this existed) */
  overlay: {
    found: boolean;
    items: Array<{ kind: string; selector: string; label: string | null; dismissed: boolean; method: string | null; control: string | null; attempted: boolean; reason: string | null; blocksPage: boolean }>;
    summary: string | null;
  } | null;
  /** JavaScript dialogs the page opened (all dismissed, never accepted) */
  dialogs: { count: number; items: Array<{ type: string; message: string }> } | null;
  artifacts: Array<{ id: string; purpose: string | null; bytes: number; expiresAt: string }>;
}
export interface BrowserCheckResultDto {
  executionId: string;
  windowStart: string;
  outcome: "PASSED" | "FAILED" | "INCONCLUSIVE";
  attempt: number;
  recordedAt: string;
  viewports: BrowserViewportResultDto[];
  /** Phase 4F, execution detail only */
  functional?: FunctionalTestDto[];
  responsive?: ResponsiveResultDto[];
}
export interface BrowserMonitoringSummaryDto {
  state: "UP" | "DOWN" | "DEGRADED" | "UNKNOWN" | "PAUSED" | "NOT_MONITORED";
  pausedReason: string | null;
  latest: BrowserCheckResultDto | null;
  lastSuccessfulCheckAt: string | null;
  lastFailedCheckAt: string | null;
  openIncidents: IncidentSummaryDto[];
  config: Record<string, unknown>;
  measurement: "SYNTHETIC_BROWSER";
}
export interface ArtifactLinkDto { url: string; expiresAt: string; contentType: string; bytes: number }


// ============================================================================ Phase 4F: dashboard
/** Time range for analytics: explicit ISO bounds (max 90 days), defaulting to the last 24 h. */
export const RangeQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
}).strict();

export type HealthState = "HEALTHY" | "DEGRADED" | "DOWN" | "INCONCLUSIVE" | "NO_DATA" | "DISABLED" | "NOT_VERIFIED";

export interface WebsiteHealthDto {
  id: string;
  name: string;
  displayHost: string;
  websiteStatus: string;
  verification: string;
  /** overall: worst of the monitored tiers; NO_DATA never reads as healthy */
  health: HealthState;
  reasons: string[];
  http: { state: string; uptime: UptimeDto; lastCheckAt: string | null; lastOutcome: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; infraFailures: number };
  browser: { state: string; lastCheckAt: string | null; lastOutcome: string | null };
  deepScan: { state: string; lastStatus: string | null; lastComplete: boolean | null; lastFinishedAt: string | null; lastCompletedAt: string | null; openFindings: number };
  /** Phase 4G: synthetic performance over the range (primary viewport, alerting metrics) */
  performance: { status: "GOOD" | "NEEDS_IMPROVEMENT" | "POOR" | "INSUFFICIENT_DATA"; samples: number; lcpP75: number | null; regressions: Array<{ metric: string; deltaPct: number | null }> } | null;
  activeIncidents: number;
}
/**
 * Live progress of a RUNNING deep scan (`live` on the scan DTO; absent once the scan has finished). Counters come from
 * the scan row and its frontier; findings are only written when the scan finishes, so `pagesFailed` is "so far".
 */
export interface DeepScanLiveDto {
  phase: "DISCOVERY" | "BROWSER" | "PAGES" | "RESOURCES" | "FINISHING";
  pagesChecked: number;
  /** pages that will be checked in this scan: checked + still queued (not the ones skipped by policy or over limits) */
  pagesFound: number;
  pagesFailed: number;
  resourcesChecked: number;
  resourcesFound: number;
  browserRendered: number;
  /** browser-assisted discovery runs in this scan */
  browserEnabled: boolean;
  requests: number;
  elapsedSec: number;
}

export interface MonitoringOverviewDto {
  range: { from: string; to: string };
  timezone: "UTC";
  websites: WebsiteHealthDto[];
  /** Phase 4G: recent component changes and performance regressions across websites */
  recentChanges: Array<{ at: string; websiteId: string; websiteName: string; kind: "COMPONENT" | "PERFORMANCE_REGRESSION"; title: string; link: string }>;
  totals: {
    websites: number; monitored: number; activeIncidents: number; resolvedIncidentsInRange: number;
    httpChecks: { passed: number; failed: number; inconclusive: number; successRatePercent: number | null };
  };
  entitlements: TierEntitlementsDto;
}
export interface TierEntitlementsDto {
  HTTP: { available: boolean; reason: string | null; minIntervalSec: number };
  BROWSER: { available: boolean; reason: string | null; minIntervalSec: number };
  DEEPSCAN: { available: boolean; reason: string | null; minIntervalSec: number; browserDiscovery: boolean; externalLinks: boolean };
}

export interface HttpAnalyticsDto {
  range: { from: string; to: string };
  bucketSec: number;
  uptime: UptimeDto;
  checks: { total: number; passed: number; failed: number; inconclusive: number; scheduled: number; skippedOrMissing: number };
  downtimeSec: number;
  responseMs: { avg: number | null; p95: number | null; max: number | null };
  timings: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null; totalMs: number | null };
  statusDistribution: Array<{ status: string; count: number }>;
  failureCategories: Array<{ category: string; count: number }>;
  series: Array<{ t: string; up: number; down: number; inconclusive: number; scheduled: number; avgMs: number | null; p95Ms: number | null }>;
  incidents: Array<{ id: string; number: number; title: string; status: string; severity: string; from: string; to: string | null }>;
}

export const BrowserResultsQuery = z.object({
  before: z.iso.datetime().optional(),
  from: z.iso.datetime().optional(),
  outcome: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]).optional(),
  viewport: z.string().max(40).optional(),
  problem: z.enum(["NAVIGATION", "RENDERING", "JAVASCRIPT", "NETWORK", "LAYOUT", "PERFORMANCE"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const ScheduleInput = z.object({
  /** requested check interval per tier, seconds; null = plan default. Can only slow a tier down. */
  httpIntervalSec: z.number().int().min(30).max(86_400).nullable().optional(),
  browserIntervalSec: z.number().int().min(60).max(86_400).nullable().optional(),
  deepScanIntervalSec: z.number().int().min(3600).max(30 * 86_400).nullable().optional(),
}).strict();

export const HistoryQuery = z.object({
  websiteId: z.uuid().optional(),
  type: z.enum(["CHECK", "INCIDENT", "CONFIG", "VERIFICATION", "INTERRUPTION", "COMPONENT", "FUNCTIONAL", "RESPONSIVE"]).optional(),
  source: z.enum(["HTTP", "BROWSER", "DEEP_SCAN"]).optional(),
  result: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export interface HistoryEventDto {
  id: string;
  at: string;
  type: "CHECK" | "INCIDENT" | "CONFIG" | "VERIFICATION" | "INTERRUPTION" | "COMPONENT" | "FUNCTIONAL" | "RESPONSIVE";
  source: string | null;
  websiteId: string | null;
  websiteName: string | null;
  title: string;
  result: string | null;
  link: string | null;
}

export interface MonitoringUsageDto {
  period: { today: string; last30DaysFrom: string; timezone: "UTC" };
  websites: { total: number; httpMonitored: number; browserMonitored: number; deepScanned: number };
  limits: {
    maxWebsites: number;
    http: { enabled: boolean; minIntervalSec: number };
    browser: { enabled: boolean; maxWebsites: number; minIntervalSec: number; screenshotBytesPerDay: number; artifactRetentionDays: number };
    deepScan: { enabled: boolean; maxWebsites: number; maxPages: number; pagesPerDay: number; maxConcurrentScans: number; retentionDays: number };
    resultRetentionDays: { http: number; browser: number };
  };
  usage: Record<string, { today: number; last30Days: number }>;
  storage: { screenshotBytes: number; screenshots: number };
  warnings: Array<{ key: string; message: string; percent: number }>;
}

export const NotificationListQuery = z.object({
  unread: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(100).optional(),
  /** only notifications created at or after this instant (real-time delivery polling; ISO 8601) */
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export interface NotificationDto {
  id: string; type: string; severity: string | null; title: string; body: string; link: string | null;
  incidentId: string | null; read: boolean; createdAt: string;
  /** website the notification is about (via its incident or link), when known; same organisation only */
  websiteId?: string | null; websiteName?: string | null;
}
export const NOTIFICATION_EVENT_TYPES = ["INCIDENT_OPENED", "INCIDENT_RESOLVED", "SSL_EXPIRING", "BROWSER_FAILURE", "DEEP_SCAN_FINDINGS", "MONITORING_INTERRUPTED"] as const;
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
export const QuietHoursInput = z.object({
  start: HHMM,
  end: HHMM,
  tz: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown time zone"),
  exceptCritical: z.boolean(),
}).strict();
export const NotificationPreferenceInput = z.object({
  channel: z.enum(["EMAIL", "IN_APP"]),
  enabled: z.boolean(),
  minSeverity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
  /** empty = all event types */
  eventTypes: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).max(10),
  /** empty = all websites */
  websiteIds: z.array(z.uuid()).max(500),
  /** in-app only: play an alert sound in the web app for notifications at or above soundMinSeverity (omitted = unchanged) */
  soundEnabled: z.boolean().optional(),
  soundMinSeverity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  /** in-app only: no sound / desktop popups in this local-time window (null = off; omitted = unchanged) */
  quietHours: QuietHoursInput.nullable().optional(),
}).strict();
export const NotificationPreferencesInput = z.object({ preferences: z.array(NotificationPreferenceInput).min(1).max(2) }).strict();
export interface NotificationPreferenceDto extends Omit<z.infer<typeof NotificationPreferenceInput>, "soundEnabled" | "soundMinSeverity" | "quietHours"> {
  isDefault: boolean;
  soundEnabled: boolean;
  soundMinSeverity: z.infer<typeof NotificationPreferenceInput>["minSeverity"];
  quietHours: z.infer<typeof QuietHoursInput> | null;
}

export interface ChangeFeedDto {
  /** opaque cursor for the next poll */
  cursor: string;
  /** what changed since the previous cursor (kinds only; payloads are fetched through the normal APIs) */
  changes: Array<{ kind: "INCIDENT" | "CHECK" | "DEEP_SCAN" | "NOTIFICATION" | "EXECUTION" | "WEBSITE"; websiteId: string | null; at: string }>;
  unreadNotifications: number;
}

// ---------------------------------------------------------------- billing (Phase 8)
export const BILLING_GATEWAYS = ["STRIPE", "RAZORPAY"] as const;
export type BillingGateway = (typeof BILLING_GATEWAYS)[number];
export const BillingIntervalInput = z.enum(["MONTH", "YEAR"]);
export const BillingCurrency = z.string().regex(/^[A-Z]{3}$/);
export const PlanKey = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);

export interface PlanPriceDto {
  id: string; interval: "MONTH" | "YEAR"; currency: string; amountMinor: number; version: number; active: boolean;
  /** true when the gateway price/plan id is linked (checkout through that gateway is possible) */
  stripeLinked: boolean; razorpayLinked: boolean;
}
export interface PlanDto {
  id: string; key: string; name: string; description: string; visible: boolean; active: boolean; trialEligible: boolean; sortOrder: number;
  prices: PlanPriceDto[];
  /** entitlement key → value (registry keys, e.g. monitoring.maxWebsites) */
  entitlements: Record<string, unknown>;
}
export interface BillingSubscriptionDto {
  id: string; status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELING" | "CANCELED" | "EXPIRED";
  planKey: string; planName: string; interval: "MONTH" | "YEAR" | null; currency: string | null; amountMinor: number | null;
  gateway: BillingGateway | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; graceEndsAt: string | null;
  pendingPlanKey: string | null;
}
export interface BillingTrialDto { status: "ACTIVE" | "CONVERTED" | "EXPIRED" | "REVOKED"; startsAt: string; endsAt: string; daysLeft: number; planKey: string | null }
export interface BillingOverviewDto {
  /** platform setting billing.enabled: when false, no checkout or gateway call is possible */
  billingEnabled: boolean;
  /** gateways that are enabled AND have secrets configured (empty while billing is disabled) */
  gatewaysAvailable: BillingGateway[];
  /** currency → gateway used for checkout (only currencies whose gateway is available) */
  checkoutCurrencies: Array<{ currency: string; gateway: BillingGateway }>;
  intervals: Array<"MONTH" | "YEAR">;
  taxMode: "NONE" | "GATEWAY" | "GST";
  subscription: BillingSubscriptionDto | null;
  trial: BillingTrialDto | null;
  entitlement: { entitled: boolean; reason: string; source: "SUBSCRIPTION" | "TRIAL" | "FREE" | "PLATFORM_DEFAULTS"; planKey: string | null };
  limits: {
    maxWebsites: number;
    http: { enabled: boolean; minIntervalSec: number };
    browser: { enabled: boolean; entitled: boolean; maxWebsites: number };
    deepscan: { enabled: boolean; entitled: boolean; maxWebsites: number };
  };
  usage: { websites: number; browserWebsites: number; deepscanWebsites: number };
}
export interface InvoiceDto {
  id: string; number: string; status: string; currency: string; subtotalMinor: number; taxMinor: number; totalMinor: number;
  periodStart: string | null; periodEnd: string | null; issuedAt: string; paidAt: string | null; gateway: BillingGateway | null;
}
export const CheckoutInput = z.object({ planKey: PlanKey, interval: BillingIntervalInput, currency: BillingCurrency }).strict();
export const ChangePlanInput = z.object({ planKey: PlanKey, interval: BillingIntervalInput }).strict();

// admin
const EntitlementValue = z.union([z.number(), z.boolean(), z.string().max(100)]);
export const AdminPlanCreateInput = z.object({
  key: PlanKey, name: z.string().trim().min(1).max(60), description: z.string().trim().max(500).default(""),
  visible: z.boolean().default(true), trialEligible: z.boolean().default(true), sortOrder: z.number().int().min(0).max(1000).default(0),
  reason: AdminReason,
}).strict();
export const AdminPlanPatchInput = z.object({
  name: z.string().trim().min(1).max(60).optional(), description: z.string().trim().max(500).optional(), visible: z.boolean().optional(),
  active: z.boolean().optional(), trialEligible: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional(),
  reason: AdminReason,
}).strict();
export const AdminPlanEntitlementsInput = z.object({
  /** full replacement of the plan's entitlement set (keys are validated against the entitlement registry by the API) */
  entitlements: z.record(z.string().regex(/^[a-z][A-Za-z0-9_.]{1,79}$/), EntitlementValue),
  reason: AdminReason,
}).strict();
export const AdminPriceCreateInput = z.object({
  interval: BillingIntervalInput, currency: BillingCurrency, amountMinor: z.number().int().min(0).max(100_000_000),
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9]{6,64}$/).optional(), razorpayPlanId: z.string().regex(/^plan_[A-Za-z0-9]{6,64}$/).optional(),
  reason: AdminReason,
}).strict();
export const AdminPricePatchInput = z.object({
  active: z.boolean().optional(),
  /** linking only: an already linked gateway id cannot be changed (prices are immutable; create a new version) */
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9]{6,64}$/).optional(), razorpayPlanId: z.string().regex(/^plan_[A-Za-z0-9]{6,64}$/).optional(),
  reason: AdminReason,
}).strict();
export const AdminGatewayConfigInput = z.object({
  enabled: z.boolean(), mode: z.enum(["test", "live"]),
  publicKey: z.string().trim().max(200).nullable().optional(),
  currencies: z.array(BillingCurrency).max(20).default([]),
  /** write-only; omitted = keep the stored value. Both must be present the first time. */
  secretKey: z.string().min(8).max(500).optional(),
  webhookSecret: z.string().min(8).max(500).optional(),
  reason: AdminReason,
}).strict();
export interface AdminGatewayConfigDto {
  gateway: BillingGateway; enabled: boolean; mode: "test" | "live"; publicKey: string | null; currencies: string[];
  /** true when both the secret key and the webhook secret are stored (values are never returned) */
  secretsConfigured: boolean; secretHint: string | null; updatedAt: string | null;
  /** path to register at the gateway (prefix with the public API origin) */
  webhookPath: string;
}
export const AdminEntitlementOverrideInput = z.object({
  key: z.string().regex(/^[a-z][A-Za-z0-9_.]{1,79}$/), value: EntitlementValue, expiresAt: z.iso.datetime().nullable().optional(), reason: AdminReason,
}).strict();
