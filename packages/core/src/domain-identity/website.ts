import { randomBytes } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------- tokens and keys
/**
 * Ownership verification token: 256 random bits, base64url. It is a proof value
 * the customer publishes (DNS/file/meta), not a secret — it is bound to one claim,
 * so learning another org's token gives no advantage.
 */
export function generateVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isVerificationToken(v: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(v);
}

/**
 * Public site key: an identifier for SDK telemetry only (never an authorization
 * credential). 192 random bits so keys can't be enumerated.
 */
export function generateSiteKey(): string {
  return `pk_${randomBytes(24).toString("base64url")}`;
}

export function isSiteKey(v: unknown): v is string {
  return typeof v === "string" && /^pk_[A-Za-z0-9_-]{32}$/.test(v);
}

/** The three published forms of a verification token. */
export function verificationInstructions(opts: { token: string; hostKey: string; registrableDomain: string; prefix: string }) {
  const value = `${opts.prefix}-verification=${opts.token}`;
  return {
    dns: {
      // Host-scope record proves control of this website; a record on the registrable domain also claims its namespace.
      hostRecord: { type: "TXT" as const, name: `_${opts.prefix}-verification.${opts.hostKey}`, value },
      rootRecord: { type: "TXT" as const, name: `_${opts.prefix}-verification.${opts.registrableDomain}`, value },
    },
    file: { path: `/.well-known/${opts.prefix}-verification.txt`, content: value },
    meta: { tag: `<meta name="${opts.prefix}-verification" content="${opts.token}">`, name: `${opts.prefix}-verification` },
    value,
  };
}

// ---------------------------------------------------------------- categories
export const WEBSITE_CATEGORIES = [
  "ECOMMERCE", "SAAS", "CORPORATE", "BLOG_MEDIA", "EDUCATION", "GOVERNMENT", "NONPROFIT", "PORTFOLIO", "OTHER",
] as const;
export type WebsiteCategory = (typeof WEBSITE_CATEGORIES)[number];

// ---------------------------------------------------------------- trial decision
export type TrialOutcome =
  | "ACTIVATED"
  | "COVERED_BY_ACTIVE_TRIAL"
  | "ORG_TRIAL_ALREADY_USED"
  | "DOMAIN_PREVIOUSLY_TRIALED"
  | "TRIALS_DISABLED";

export interface TrialFacts {
  trialsEnabled: boolean;
  /** domain_trial_ledger.trial_consumed_at IS NOT NULL for the registrable domain. */
  domainTrialConsumed: boolean;
  /** The org's trial row, if any (one per org, ever). */
  orgTrial: { status: "ACTIVE" | "CONVERTED" | "EXPIRED" | "REVOKED"; endsAt: Date } | null;
  now: Date;
}

/**
 * Trial eligibility (ARCHITECTURE.md §12.4–12.5). Evaluated when a website's
 * ownership is first verified; the caller holds a row lock on the ledger entry.
 * - first verification, fresh domain, org never trialed → ACTIVATED
 * - org currently trialing → the domain is covered and marked as trialed
 *   (prevents "trial on a second domain, then re-register it elsewhere")
 * - domain already trialed anywhere (including by a deleted account) → no trial
 */
export function decideTrial(f: TrialFacts): { outcome: TrialOutcome; markDomainConsumed: boolean } {
  if (!f.trialsEnabled) return { outcome: "TRIALS_DISABLED", markDomainConsumed: false };
  const orgTrialActive = f.orgTrial?.status === "ACTIVE" && f.orgTrial.endsAt > f.now;
  if (f.domainTrialConsumed) return { outcome: "DOMAIN_PREVIOUSLY_TRIALED", markDomainConsumed: false };
  if (orgTrialActive) return { outcome: "COVERED_BY_ACTIVE_TRIAL", markDomainConsumed: true };
  if (f.orgTrial) return { outcome: "ORG_TRIAL_ALREADY_USED", markDomainConsumed: false };
  return { outcome: "ACTIVATED", markDomainConsumed: true };
}

// ---------------------------------------------------------------- SDK configuration
/**
 * Customer-editable SDK settings (site_installations.sdk_config). Everything is
 * opt-in or bounded; nothing here can enable collection of form values, cookies,
 * storage, request/response bodies or headers — the SDK has no code for that.
 */
export const SdkConfig = z.object({
  captureErrors: z.boolean().default(true),
  captureResourceErrors: z.boolean().default(true),
  captureVitals: z.boolean().default(true),
  captureApiFailures: z.boolean().default(false),
  errorSampleRate: z.number().min(0).max(1).default(1),
  vitalsSampleRate: z.number().min(0).max(1).default(0.2),
  requireConsent: z.boolean().default(false),
  respectGlobalPrivacyControl: z.boolean().default(true),
  /** Extra path-segment masks (regex source strings), applied in the SDK and again at ingest. */
  maskPatterns: z.array(z.string().min(1).max(200).refine(isSafeRegex, "Invalid or unsafe pattern")).max(20).default([]),
}).strict();
export type SdkConfig = z.infer<typeof SdkConfig>;

export function parseSdkConfig(input: unknown): SdkConfig {
  return SdkConfig.parse(input ?? {});
}

/** Reject invalid regexes and the obvious catastrophic-backtracking shapes (nested quantifiers). */
function isSafeRegex(src: string): boolean {
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(src)) return false;
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- installation status
export type InstallationState = "NOT_INSTALLED" | "DETECTED" | "ACTIVE" | "INACTIVE" | "INVALID_CONFIGURATION";

export interface InstallationFacts {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  heartbeatCount: number;
  lastInvalidAt: Date | null;
  lastInvalidReason: string | null;
  keyRevoked: boolean;
}

/**
 * Derived, never stored: a heartbeat only counts when it came from the registered
 * origin with a valid, unrevoked key for a verified website (checked at ingest).
 *  - INVALID_CONFIGURATION: the most recent signal (within the window) was rejected, or the key was revoked after installation
 *  - NOT_INSTALLED: no valid heartbeat ever
 *  - DETECTED: valid heartbeats, but fewer than `minHeartbeats` distinct page loads
 *  - ACTIVE: ≥ minHeartbeats page loads and one within the window
 *  - INACTIVE: no valid heartbeat within the window
 */
export function installationState(f: InstallationFacts, opts: { now: Date; activeWindowHours: number; minHeartbeats: number }): InstallationState {
  const windowMs = opts.activeWindowHours * 3_600_000;
  const recentInvalid = f.lastInvalidAt && opts.now.getTime() - f.lastInvalidAt.getTime() < windowMs;
  if (recentInvalid && (!f.lastSeenAt || f.lastInvalidAt! > f.lastSeenAt)) return "INVALID_CONFIGURATION";
  // A revoked key can't report anything: a previously installed script is now misconfigured.
  if (f.keyRevoked) return f.lastSeenAt ? "INVALID_CONFIGURATION" : "NOT_INSTALLED";
  if (!f.lastSeenAt) return "NOT_INSTALLED";
  if (opts.now.getTime() - f.lastSeenAt.getTime() >= windowMs) return "INACTIVE";
  return f.heartbeatCount >= opts.minHeartbeats ? "ACTIVE" : "DETECTED";
}
