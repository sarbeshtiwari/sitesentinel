import type { Tx } from "@wim/db";

/**
 * Error text safe to persist and show to operators: bounded, no URLs (customer domains and
 * query strings never reach failure records or admin views), no long opaque tokens.
 */
export function sanitizeError(message: unknown): string {
  return String(message ?? "error")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[redacted]")
    // Phase 4H: no internal addresses (probe and connection errors name them)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[addr]")
    .replace(/\[?\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d+)?/gi, "[addr]")
    .slice(0, 300);
}

/** Per-org usage accounting (daily buckets). Later phases bill from these. */
export async function addUsage(tx: Tx, orgId: string, entries: Record<string, number>): Promise<void> {
  const keys = Object.keys(entries).filter((k) => entries[k]);
  if (!keys.length) return;
  await tx.$executeRaw`
    INSERT INTO usage_counters (org_id, period_start, key, value, updated_at)
    SELECT ${orgId}::uuid, (now() AT TIME ZONE 'UTC')::date, k, v, now()
      FROM unnest(${keys}::text[], ${keys.map((k) => Math.round(entries[k]!))}::bigint[]) AS u(k, v)
    ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = now()`;
}

export async function healthMetric(tx: Tx, component: string, metric: string, value: number, labels?: Record<string, string | number>): Promise<void> {
  await tx.systemHealthLog.create({ data: { component, metric, value, labels: labels ?? undefined } });
}

/** Release readiness: outcome of a periodic maintenance task (cleanup.failing / retention.failing rules). Never throws. */
export async function recordMaintenance(db: import("@wim/db").Db, task: string, ok: boolean): Promise<void> {
  const { withSystem } = await import("@wim/db");
  await withSystem(db, (tx) => tx.systemHealthLog.create({ data: { component: "maintenance", metric: ok ? `${task}_ok` : `${task}_failed`, value: 1 } })).catch(() => undefined);
}
