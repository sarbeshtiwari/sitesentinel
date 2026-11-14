/**
 * Periodic ownership revalidation (Phase 4A, ARCHITECTURE D-44). Pure policy:
 * the worker supplies the check outcome and the claim's current state; this
 * decides the next state, the next check time and what to tell the customer.
 *
 *   OK ──definitive failure──▶ FAILING ──grace exhausted──▶ LAPSED ──release period over──▶ RELEASED (ownership lost)
 *    ▲                            │                            │
 *    └────────── success ─────────┴──────────── success ───────┘   (monitoring resumes)
 *
 * Temporary failures (our side or theirs) never advance the state, unless the
 * domain has been unverifiable for longer than `maxUnverifiableHours`.
 */

export type CheckOutcome = "SUCCEEDED" | "TEMPORARY_FAILURE" | "DEFINITIVE_FAILURE" | "SERVICE_UNAVAILABLE";
export type RevalidationState = "OK" | "FAILING" | "LAPSED";

/** Failure reasons that prove the proof is gone (or the domain moved). */
const DEFINITIVE = new Set([
  "DNS_RECORD_NOT_FOUND", "TOKEN_NOT_FOUND_IN_FILE", "META_TAG_NOT_FOUND", "META_TOKEN_MISMATCH",
  "HTTP_404", "HTTP_410", "HTTP_401", "HTTP_403", "REDIRECTS_OFF_SITE", "BLOCKED_DESTINATION", "HOST_NOT_FOUND",
]);
/** Our own infrastructure couldn't perform the check: never the customer's fault. */
const SERVICE = new Set(["SERVICE_UNAVAILABLE", "CHECK_ERROR"]);

export function classifyVerificationFailure(reason: string | null): CheckOutcome {
  if (!reason) return "SUCCEEDED";
  if (SERVICE.has(reason)) return "SERVICE_UNAVAILABLE";
  if (DEFINITIVE.has(reason)) return "DEFINITIVE_FAILURE";
  // DNS_UNAVAILABLE, DNS_PROPAGATING, SITE_UNREACHABLE, HTTP_5xx, timeouts, TLS errors, …
  return "TEMPORARY_FAILURE";
}

export interface RevalidationPolicy {
  intervalHours: number;
  failingRetryHours: number;
  transientRetryMinutes: number;
  graceHours: number;
  lapseReleaseDays: number;
  maxUnverifiableHours: number;
}

export interface ClaimRevalidationFacts {
  state: RevalidationState;
  /** claim.status: VERIFIED or LAPSED */
  claimStatus: "VERIFIED" | "LAPSED";
  failingSince: Date | null;
  lapsedAt: Date | null;
  lastSuccessAt: Date | null;
  revalidationFailures: number;
  transientFailures: number;
}

export type RevalidationEffect = "NONE" | "NOTIFY_FAILING" | "LAPSE" | "RELEASE" | "RESTORE";

export interface RevalidationDecision {
  outcome: CheckOutcome;
  state: RevalidationState | "RELEASED";
  claimStatus: "VERIFIED" | "LAPSED" | "RELEASED";
  failingSince: Date | null;
  revalidationFailures: number;
  transientFailures: number;
  nextCheckAt: Date;
  effect: RevalidationEffect;
}

const h = (n: number) => n * 3_600_000;

export function decideRevalidation(f: ClaimRevalidationFacts, outcome: CheckOutcome, p: RevalidationPolicy, now: Date): RevalidationDecision {
  const at = (ms: number) => new Date(now.getTime() + ms);
  if (outcome === "SUCCEEDED") {
    return {
      outcome, state: "OK", claimStatus: "VERIFIED", failingSince: null, revalidationFailures: 0, transientFailures: 0,
      nextCheckAt: at(h(p.intervalHours)), effect: f.state === "OK" && f.claimStatus === "VERIFIED" ? "NONE" : "RESTORE",
    };
  }
  if (outcome === "SERVICE_UNAVAILABLE") {
    // Nothing is counted: we couldn't look.
    return { ...carry(f), outcome, nextCheckAt: at(p.transientRetryMinutes * 60_000), effect: "NONE" };
  }
  let definitive = outcome === "DEFINITIVE_FAILURE";
  if (!definitive) {
    // Temporary failures don't count — until the domain has been unverifiable for too long.
    const since = f.lastSuccessAt?.getTime() ?? 0;
    if (now.getTime() - since < h(p.maxUnverifiableHours)) {
      return { ...carry(f), outcome, transientFailures: f.transientFailures + 1, nextCheckAt: at(p.transientRetryMinutes * 60_000), effect: "NONE" };
    }
    definitive = true;
  }
  const failingSince = f.failingSince ?? now;
  const failures = f.revalidationFailures + 1;
  if (f.claimStatus === "LAPSED") {
    const lapsedAt = f.lapsedAt ?? now;
    if (now.getTime() - lapsedAt.getTime() >= p.lapseReleaseDays * 86_400_000) {
      return { outcome, state: "RELEASED", claimStatus: "RELEASED", failingSince, revalidationFailures: failures, transientFailures: 0, nextCheckAt: at(h(p.intervalHours)), effect: "RELEASE" };
    }
    return { outcome, state: "LAPSED", claimStatus: "LAPSED", failingSince, revalidationFailures: failures, transientFailures: 0, nextCheckAt: at(h(p.failingRetryHours)), effect: "NONE" };
  }
  if (now.getTime() - failingSince.getTime() >= h(p.graceHours)) {
    return { outcome, state: "LAPSED", claimStatus: "LAPSED", failingSince, revalidationFailures: failures, transientFailures: 0, nextCheckAt: at(h(p.failingRetryHours)), effect: "LAPSE" };
  }
  return {
    outcome, state: "FAILING", claimStatus: "VERIFIED", failingSince, revalidationFailures: failures, transientFailures: 0,
    nextCheckAt: at(h(p.failingRetryHours)), effect: f.state === "OK" ? "NOTIFY_FAILING" : "NONE",
  };
}

function carry(f: ClaimRevalidationFacts) {
  return {
    state: f.state, claimStatus: f.claimStatus, failingSince: f.failingSince,
    revalidationFailures: f.revalidationFailures, transientFailures: f.transientFailures,
  } as const;
}
