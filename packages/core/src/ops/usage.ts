/**
 * Phase 4H: usage accounting policy (docs/OPERATIONS_RUNBOOK.md §Usage). One table, used by the customer usage page, the
 * Super Admin reconciliation and (later) Phase 8 billing — nothing else decides what counts.
 *
 * Kinds:
 *  - work:      customer work actually performed and recorded once per logical result (ledger-gated, retry-safe)
 *  - exclusion: part of a `work` counter that must NOT be charged (inconclusive = our infrastructure could not decide)
 *  - overhead:  platform cost of retries, failures and cancellations — never charged to the customer
 *  - info:      informational detail (bytes, durations, counts of things seen)
 *  - gauge:     a level, not a flow (snapshot once a day; the latest value of a day is the value)
 *
 * Counters are daily (UTC) per organisation; a period's usage is the sum of its days. Entitlement limits are enforced
 * server-side by the workers/API that perform the work (e.g. deep-scan pages per day, screenshot bytes per day).
 */
export type UsageKind = "work" | "exclusion" | "overhead" | "info" | "gauge";
export interface UsageKeyDef { kind: UsageKind; unit: "count" | "ms" | "bytes"; label: string; /** for exclusions: the work key they reduce */ reduces?: string }

export const USAGE_KEYS: Record<string, UsageKeyDef> = {
  "http.checks": { kind: "work", unit: "count", label: "HTTP checks recorded" },
  "http.inconclusive": { kind: "exclusion", unit: "count", label: "HTTP checks inconclusive (not charged)", reduces: "http.checks" },
  "http.bytes": { kind: "info", unit: "bytes", label: "HTTP bytes read" },
  "http.redirects": { kind: "info", unit: "count", label: "Redirects followed" },
  "browser.executions": { kind: "work", unit: "count", label: "Browser checks recorded" },
  "browser.inconclusive": { kind: "exclusion", unit: "count", label: "Browser checks inconclusive (not charged)", reduces: "browser.executions" },
  "browser.ms": { kind: "info", unit: "ms", label: "Browser time" },
  "browser.viewports": { kind: "info", unit: "count", label: "Viewports rendered" },
  "browser.screenshots": { kind: "work", unit: "count", label: "Screenshots stored" },
  "browser.screenshot_bytes": { kind: "work", unit: "bytes", label: "Screenshot bytes stored" },
  "browser.functional_tests": { kind: "work", unit: "count", label: "Functional tests executed" },
  "browser.components_changed": { kind: "info", unit: "count", label: "Component changes detected" },
  "browser.unsafe_requests_blocked": { kind: "info", unit: "count", label: "Requests blocked by the interaction guard" },
  "browser.retry_ms": { kind: "overhead", unit: "ms", label: "Browser time spent on infrastructure retries" },
  "browser.infra_failures": { kind: "overhead", unit: "count", label: "Browser infrastructure failures" },
  "deepscan.scans": { kind: "work", unit: "count", label: "Deep scans finished" },
  "deepscan.partial_scans": { kind: "info", unit: "count", label: "Deep scans stopped early (quota, limits)" },
  "deepscan.pages": { kind: "work", unit: "count", label: "Pages scanned" },
  "deepscan.bytes": { kind: "info", unit: "bytes", label: "Deep-scan bytes read" },
  "deepscan.requests": { kind: "info", unit: "count", label: "Deep-scan requests" },
  "deepscan.resources": { kind: "info", unit: "count", label: "Resources checked" },
  "deepscan.external_links_seen": { kind: "info", unit: "count", label: "External links seen" },
  "deepscan.duration_ms": { kind: "info", unit: "ms", label: "Deep-scan duration" },
  "deepscan.browser_ms": { kind: "info", unit: "ms", label: "Deep-scan browser time" },
  "deepscan.failed_attempts": { kind: "overhead", unit: "count", label: "Deep-scan infrastructure failures" },
  "deepscan.overhead_requests": { kind: "overhead", unit: "count", label: "Requests repeated after infrastructure failures" },
  "websites.registered": { kind: "gauge", unit: "count", label: "Websites registered" },
  "websites.verified": { kind: "gauge", unit: "count", label: "Websites verified" },
  "storage.screenshot_bytes": { kind: "gauge", unit: "bytes", label: "Screenshot storage in use" },
};
/** Per-tier execution-lifecycle keys written by the runtime (`exec.http.ok`, `.failed`, `.retries`, `.cancelled`, `.skipped`, `.ms`, `.wait_ms`). */
export function usageKeyDef(key: string): UsageKeyDef | null {
  if (USAGE_KEYS[key]) return USAGE_KEYS[key]!;
  const m = /^exec\.(http|browser|deepscan)\.(ok|failed|retries|cancelled|skipped|ms|wait_ms)$/.exec(key);
  if (!m) return null;
  const k = m[2]!;
  return { kind: k === "ok" || k === "ms" || k === "wait_ms" ? "info" : "overhead", unit: k.endsWith("ms") ? "ms" : "count", label: `${m[1]} executions: ${k.replace("_", " ")}` };
}
export const GAUGE_KEYS = Object.entries(USAGE_KEYS).filter(([, d]) => d.kind === "gauge").map(([k]) => k);

/**
 * Chargeable quantities from summed counters: work minus its exclusions. Cancelled executions, failed attempts and
 * retries never appear (they are overhead); inconclusive results are recorded but subtracted.
 */
export function billableUsage(sums: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, d] of Object.entries(USAGE_KEYS)) if (d.kind === "work") out[k] = sums[k] ?? 0;
  for (const d of Object.values(USAGE_KEYS)) if (d.kind === "exclusion" && d.reduces) out[d.reduces] = Math.max(0, (out[d.reduces] ?? 0) - (sumsOf(sums, d)));
  return out;
  function sumsOf(s: Record<string, number>, def: UsageKeyDef) {
    const key = Object.entries(USAGE_KEYS).find(([, x]) => x === def)![0];
    return s[key] ?? 0;
  }
}
