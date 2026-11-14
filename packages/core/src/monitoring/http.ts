import { z } from "zod";

/**
 * HTTP availability monitoring policy (Phase 4C). Pure functions: the worker passes
 * the probe outcome and stored state in, and persists what comes out.
 */

// ---------------------------------------------------------------- configuration
const StatusSpec = z.string().regex(/^[1-5]\d\d(-[1-5]\d\d)?$/, "status code or range, e.g. 200-299");

export const HttpCheckConfig = z.object({
  method: z.enum(["GET", "HEAD"]).default("GET"),
  /** path on the verified origin; never a full URL (the host always comes from the verified website) */
  path: z.string().max(500).regex(/^\/(?!\/)[^\s\\#]*$/, "must be a path starting with /").default("/"),
  expectedStatus: z.array(StatusSpec).min(1).max(20).default(["200-299", "401", "403"]),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  contentMarker: z.string().min(1).max(200).optional(),
  expectedContentType: z.string().min(3).max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i).optional(),
  /** 5xx counts as downtime (otherwise it is an unexpected-status failure) */
  serverErrorsAreDowntime: z.boolean().default(true),
  sslWarningDays: z.array(z.number().int().min(1).max(90)).min(1).max(6).default([30, 14, 7, 3]),
  failureThreshold: z.number().int().min(1).max(20).optional(),
  recoveryThreshold: z.number().int().min(1).max(20).optional(),
}).strict();
export type HttpCheckConfig = z.infer<typeof HttpCheckConfig>;

export function parseHttpCheckConfig(raw: unknown): HttpCheckConfig {
  const r = HttpCheckConfig.safeParse(raw ?? {});
  return r.success ? r.data : HttpCheckConfig.parse({}); // invalid stored config never breaks monitoring
}

export function statusMatches(status: number, specs: string[]): boolean {
  return specs.some((s) => {
    const [a, b] = s.split("-").map(Number);
    return b === undefined ? status === a : status >= a! && status <= b;
  });
}

// ---------------------------------------------------------------- evaluation
export const HTTP_CLASSES = ["down", "tls", "status", "content", "ssl_expiry", "config"] as const;
export type HttpClass = (typeof HTTP_CLASSES)[number];
export type Verdict = "PASS" | "FAIL" | "UNKNOWN";

export type FailureCategory =
  | "TARGET_TEMPORARY" | "TARGET_PERMANENT" | "GATEWAY_INFRASTRUCTURE" | "WORKER_INFRASTRUCTURE" | "SECURITY_REJECTION" | "INVALID_CONFIGURATION";

export interface ProbeOutcome {
  error: string | null;
  final: { status: number; contentType: string | null; body: Buffer | null; truncated: boolean } | null;
  https: boolean;
  tls: { authorized: boolean; validTo: string | null } | null;
}

export interface HttpEvaluation {
  status: "PASSED" | "FAILED" | "INCONCLUSIVE";
  failureKind: string | null;
  failureCategory: FailureCategory | null;
  /** counts towards uptime: true = up, false = down, null = excluded (inconclusive) */
  available: boolean | null;
  verdicts: Record<HttpClass, Verdict>;
  kinds: Partial<Record<HttpClass, string>>;
  sslDaysRemaining: number | null;
}

const INFRA = new Set(["GATEWAY_UNAVAILABLE", "EGRESS_RATE_LIMITED", "GATEWAY_ERROR", "ABORTED"]);
const CONFIG = new Set(["BLOCKED_ADDRESS", "BLOCKED_HOST", "BLOCKED_PORT", "INVALID_TARGET"]);
const DOWN = new Set(["DNS_FAILURE", "NO_ADDRESSES", "CONNECTION_FAILED", "CONNECT_TIMEOUT", "RESPONSE_TIMEOUT", "PROTOCOL_ERROR"]);
const STATUS_ERR = new Set(["REDIRECT_LOOP", "TOO_MANY_REDIRECTS", "INVALID_REDIRECT"]);

/**
 * @param infraSuspected the worker's canary says the monitoring path itself is broken: a
 *        connection-level failure is then OUR outage, never the customer's.
 */
export function evaluateHttp(p: ProbeOutcome, cfg: HttpCheckConfig, now: Date, infraSuspected = false): HttpEvaluation {
  const v: Record<HttpClass, Verdict> = { down: "UNKNOWN", tls: "UNKNOWN", status: "UNKNOWN", content: "UNKNOWN", ssl_expiry: "UNKNOWN", config: "UNKNOWN" };
  const kinds: Partial<Record<HttpClass, string>> = {};
  const fail = (c: HttpClass, kind: string) => { v[c] = "FAIL"; kinds[c] = kind; };
  let sslDays: number | null = null;
  if (p.tls?.validTo) {
    sslDays = Math.floor((new Date(p.tls.validTo).getTime() - now.getTime()) / 86_400_000);
  }
  const e = p.error;

  if (e === "EGRESS_UNAUTHORIZED") {
    return { status: "INCONCLUSIVE", failureKind: "EGRESS_UNAUTHORIZED", failureCategory: "SECURITY_REJECTION", available: null, verdicts: v, kinds, sslDaysRemaining: sslDays };
  }
  if ((e && INFRA.has(e)) || (e && infraSuspected && DOWN.has(e))) {
    return { status: "INCONCLUSIVE", failureKind: e === "GATEWAY_UNAVAILABLE" || !DOWN.has(e) ? e : `INFRA_${e}`, failureCategory: "GATEWAY_INFRASTRUCTURE", available: null, verdicts: v, kinds, sslDaysRemaining: sslDays };
  }
  if (e && CONFIG.has(e)) {
    fail("config", e);
    return { status: "FAILED", failureKind: e, failureCategory: "INVALID_CONFIGURATION", available: null, verdicts: v, kinds, sslDaysRemaining: sslDays };
  }
  v.config = "PASS";
  if (e === "TLS_INVALID") {
    fail("tls", "TLS_INVALID");
    // Users can't load the site: down for uptime purposes, reported as a certificate incident.
    return { status: "FAILED", failureKind: "TLS_INVALID", failureCategory: "TARGET_PERMANENT", available: false, verdicts: v, kinds, sslDaysRemaining: sslDays };
  }
  if (e && DOWN.has(e)) {
    fail("down", e);
    return { status: "FAILED", failureKind: e, failureCategory: "TARGET_TEMPORARY", available: false, verdicts: v, kinds, sslDaysRemaining: sslDays };
  }
  // Any HTTP response from here on: the server is up unless it says 5xx (configurable).
  if (p.https) v.tls = "PASS";
  if (p.https && sslDays !== null) {
    const warn = Math.max(...cfg.sslWarningDays);
    if (sslDays <= warn) fail("ssl_expiry", `EXPIRES_IN_${Math.max(0, sslDays)}_DAYS`);
    else v.ssl_expiry = "PASS";
  }
  if (e && STATUS_ERR.has(e)) {
    v.down = "PASS";
    fail("status", e);
    return finish("TARGET_PERMANENT");
  }
  const st = p.final?.status ?? 0;
  if (st >= 500 && cfg.serverErrorsAreDowntime) {
    fail("down", `HTTP_${st}`);
    return finish("TARGET_TEMPORARY", false);
  }
  v.down = "PASS";
  if (!statusMatches(st, cfg.expectedStatus)) {
    fail("status", `HTTP_${st}`);
    return finish(st >= 500 || st === 429 ? "TARGET_TEMPORARY" : "TARGET_PERMANENT");
  }
  v.status = "PASS";
  if (cfg.expectedContentType || cfg.contentMarker) {
    if (cfg.expectedContentType && !(p.final?.contentType ?? "").toLowerCase().startsWith(cfg.expectedContentType.toLowerCase())) {
      fail("content", "CONTENT_TYPE_MISMATCH");
    } else if (cfg.contentMarker && st >= 200 && st < 300) {
      const found = p.final?.body ? p.final.body.includes(Buffer.from(cfg.contentMarker)) : false;
      if (!found) fail("content", "CONTENT_MISMATCH");
      else v.content = "PASS";
    } else {
      v.content = "PASS";
    }
  }
  return finish(v.content === "FAIL" ? "TARGET_PERMANENT" : null);

  function finish(cat: FailureCategory | null, available = true): HttpEvaluation {
    const order: HttpClass[] = ["config", "tls", "down", "status", "content"];
    const first = order.find((c) => v[c] === "FAIL");
    return {
      status: first ? "FAILED" : "PASSED",
      failureKind: first ? kinds[first]! : null,
      failureCategory: first ? cat : null,
      available, verdicts: v, kinds, sslDaysRemaining: sslDays,
    };
  }
}

// ---------------------------------------------------------------- incidents
export interface IncidentClassSpec { category: "AVAILABILITY" | "SSL" | "HTTP_ERROR" | "SYSTEM"; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; title: string; fixedThreshold?: number }
export const HTTP_INCIDENT_CLASSES: Record<HttpClass, IncidentClassSpec> = {
  down: { category: "AVAILABILITY", severity: "CRITICAL", title: "Website unavailable" },
  tls: { category: "SSL", severity: "CRITICAL", title: "TLS certificate is not trusted" },
  status: { category: "HTTP_ERROR", severity: "HIGH", title: "Unexpected HTTP response" },
  content: { category: "HTTP_ERROR", severity: "MEDIUM", title: "Content check failed" },
  ssl_expiry: { category: "SSL", severity: "LOW", title: "TLS certificate expires soon", fixedThreshold: 1 },
  config: { category: "SYSTEM", severity: "HIGH", title: "Monitoring blocked by security policy", fixedThreshold: 1 },
};

export function sslSeverity(days: number): "HIGH" | "MEDIUM" | "LOW" {
  return days <= 3 ? "HIGH" : days <= 7 ? "MEDIUM" : "LOW";
}

export interface ClassState { fails: number; passes: number; open: boolean; incidentId: string | null; streakStart: string | null; kinds: Record<string, number> }
export interface HttpMonitorState {
  v: 1;
  classes: Partial<Record<HttpClass, ClassState>>;
  lastResultAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  inconclusiveStreak: number;
  inconclusiveNotified: boolean;
  /** lowest SSL warning threshold already notified for the current certificate */
  sslNotified: { validTo: string; threshold: number } | null;
}

export function emptyMonitorState(): HttpMonitorState {
  return { v: 1, classes: {}, lastResultAt: null, lastSuccessAt: null, lastFailureAt: null, inconclusiveStreak: 0, inconclusiveNotified: false, sslNotified: null };
}

export type IncidentAction =
  | { type: "OPEN"; cls: HttpClass; kind: string; streakStart: string; count: number }
  | { type: "OCCUR"; cls: HttpClass; kind: string }
  | { type: "RESOLVE"; cls: HttpClass }
  | { type: "SSL_THRESHOLD"; threshold: number; days: number; validTo: string }
  | { type: "MONITORING_INTERRUPTED"; streak: number };

export interface Thresholds { failure: number; recovery: number }

/**
 * Advance the per-website state by one result (in window order). Returns the new state and
 * the incident/notification actions. UNKNOWN verdicts leave counters untouched, so an
 * infrastructure outage neither opens nor resolves customer incidents.
 */
export function advanceMonitorState(
  prev: HttpMonitorState, ev: HttpEvaluation, thresholdsFor: (c: HttpClass) => Thresholds, now: Date,
  ssl: { validTo: string | null; warningDays: number[] }, interruptAfter: number,
): { state: HttpMonitorState; actions: IncidentAction[] } {
  const { state: s, actions } = advanceClasses<HttpClass, HttpMonitorState>(prev, ev, HTTP_CLASSES, HTTP_INCIDENT_CLASSES, thresholdsFor, now, interruptAfter);
  if (ev.status === "INCONCLUSIVE") return { state: s, actions: actions as IncidentAction[] };
  // SSL warning thresholds: one notice per threshold crossed per certificate.
  if (ev.verdicts.ssl_expiry === "FAIL" && ssl.validTo && ev.sslDaysRemaining !== null) {
    const crossed = [...ssl.warningDays].sort((a, b) => a - b).find((d) => ev.sslDaysRemaining! <= d);
    if (crossed !== undefined) {
      const already = s.sslNotified && s.sslNotified.validTo === ssl.validTo ? s.sslNotified.threshold : Number.POSITIVE_INFINITY;
      if (crossed < already) {
        s.sslNotified = { validTo: ssl.validTo, threshold: crossed };
        (actions as IncidentAction[]).push({ type: "SSL_THRESHOLD", threshold: crossed, days: ev.sslDaysRemaining, validTo: ssl.validTo });
      }
    }
  } else if (ev.verdicts.ssl_expiry === "PASS") {
    s.sslNotified = null;
  }
  return { state: s, actions: actions as IncidentAction[] };
}

/** State shared by every engine's per-website monitor (classes = that engine's check classes). */
export interface MonitorStateBase<C extends string> {
  v: 1;
  classes: Partial<Record<C, ClassState>>;
  lastResultAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  inconclusiveStreak: number;
  inconclusiveNotified: boolean;
}
export type ClassAction<C extends string> =
  | { type: "OPEN"; cls: C; kind: string; streakStart: string; count: number }
  | { type: "OCCUR"; cls: C; kind: string }
  | { type: "RESOLVE"; cls: C }
  | { type: "MONITORING_INTERRUPTED"; streak: number };

/**
 * Generic consecutive-failure / recovery state machine (4C HTTP, 4D browser). UNKNOWN verdicts and
 * INCONCLUSIVE results never move counters, so infrastructure failures neither open nor resolve incidents.
 */
export function advanceClasses<C extends string, S extends MonitorStateBase<C>>(
  prev: S,
  ev: { status: "PASSED" | "FAILED" | "INCONCLUSIVE"; available: boolean | null; verdicts: Record<C, Verdict>; kinds: Partial<Record<C, string>> },
  classes: readonly C[], specs: Record<C, { fixedThreshold?: number }>, thresholdsFor: (c: C) => Thresholds, now: Date, interruptAfter: number,
): { state: S; actions: ClassAction<C>[] } {
  const s: S = structuredClone(prev);
  const actions: ClassAction<C>[] = [];
  const iso = now.toISOString();
  s.lastResultAt = iso;
  if (ev.status === "INCONCLUSIVE") {
    s.inconclusiveStreak++;
    if (s.inconclusiveStreak >= interruptAfter && !s.inconclusiveNotified) {
      s.inconclusiveNotified = true;
      actions.push({ type: "MONITORING_INTERRUPTED", streak: s.inconclusiveStreak });
    }
    return { state: s, actions };
  }
  s.inconclusiveStreak = 0;
  s.inconclusiveNotified = false;
  if (ev.available === true) s.lastSuccessAt = iso;
  if (ev.status === "FAILED") s.lastFailureAt = iso;
  for (const cls of classes) {
    const verdict = ev.verdicts[cls];
    if (verdict === "UNKNOWN") continue;
    const c: ClassState = s.classes[cls] ?? { fails: 0, passes: 0, open: false, incidentId: null, streakStart: null, kinds: {} };
    const t = thresholdsFor(cls);
    const failureThreshold = specs[cls].fixedThreshold ?? t.failure;
    const recoveryThreshold = specs[cls].fixedThreshold ?? t.recovery;
    if (verdict === "FAIL") {
      const kind = ev.kinds[cls] ?? "FAILED";
      c.passes = 0;
      if (c.fails === 0) { c.streakStart = iso; c.kinds = {}; }
      c.fails++;
      c.kinds[kind] = (c.kinds[kind] ?? 0) + 1;
      if (c.open) actions.push({ type: "OCCUR", cls, kind });
      else if (c.fails >= failureThreshold) {
        c.open = true;
        actions.push({ type: "OPEN", cls, kind, streakStart: c.streakStart ?? iso, count: c.fails });
      }
    } else {
      c.passes++;
      if (c.open && c.passes >= recoveryThreshold) {
        actions.push({ type: "RESOLVE", cls });
        c.open = false;
        c.incidentId = null;
      }
      if (!c.open) { c.fails = 0; c.streakStart = null; c.kinds = {}; }
    }
    s.classes[cls] = c;
  }
  return { state: s, actions };
}

// ---------------------------------------------------------------- uptime
/**
 * Uptime over a period = up / (up + down) over results with an availability verdict.
 * Excluded: inconclusive results (our infrastructure), skipped/cancelled/dead-lettered
 * executions and windows with no execution. `coverage` reports how many scheduled windows
 * produced a verdict, so a high uptime from little data is visible as such. Never
 * extrapolated; null when there is no measured window.
 */
export function uptimeFrom(counts: { up: number; down: number; scheduled: number }) {
  const measured = counts.up + counts.down;
  return {
    uptimePercent: measured ? Math.round((counts.up / measured) * 100_000) / 1000 : null,
    measuredChecks: measured,
    upChecks: counts.up,
    downChecks: counts.down,
    scheduledChecks: counts.scheduled,
    coveragePercent: counts.scheduled ? Math.round((Math.min(measured, counts.scheduled) / counts.scheduled) * 1000) / 10 : null,
  };
}

/** Customer-facing wording for failure kinds (no internal detail). */
export function describeHttpFailure(kind: string): string {
  const m = /^HTTP_(\d{3})$/.exec(kind);
  if (m) return Number(m[1]) >= 500 ? `Server error (HTTP ${m[1]})` : `Unexpected HTTP status ${m[1]}`;
  const e = /^EXPIRES_IN_(\d+)_DAYS$/.exec(kind);
  if (e) return `Certificate expires in ${e[1]} day${e[1] === "1" ? "" : "s"}`;
  return ({
    DNS_FAILURE: "DNS lookup failed", NO_ADDRESSES: "The domain has no DNS address records", CONNECTION_FAILED: "Connection refused or reset",
    CONNECT_TIMEOUT: "Connection timed out", RESPONSE_TIMEOUT: "No complete response within the timeout", PROTOCOL_ERROR: "Invalid HTTP response",
    TLS_INVALID: "The TLS certificate is not trusted (expired, self-signed or wrong hostname)", REDIRECT_LOOP: "Redirect loop",
    TOO_MANY_REDIRECTS: "Too many redirects", INVALID_REDIRECT: "Redirect to an invalid location", CONTENT_MISMATCH: "Expected content not found",
    CONTENT_TYPE_MISMATCH: "Unexpected content type", BLOCKED_ADDRESS: "The domain resolves to a private or reserved address",
    BLOCKED_HOST: "The target host is not allowed", BLOCKED_PORT: "Only ports 80 and 443 can be monitored", INVALID_TARGET: "The monitored URL is invalid",
  } as Record<string, string>)[kind] ?? "Check failed";
}
