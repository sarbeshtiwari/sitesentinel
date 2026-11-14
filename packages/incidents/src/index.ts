import type { Tx } from "@wim/db";

/**
 * Incident store (first writer of `incidents`, shared by every monitoring engine).
 * All functions run inside the caller's transaction, so an incident change, its
 * occurrence and its notification event commit (or roll back) together.
 *
 * Grouping: one active incident per (org, fingerprint) — enforced by the partial unique
 * index incidents_one_active_per_fingerprint; a fingerprint resolved within the reopen
 * window is reopened instead of duplicated.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
const ACTIVE = ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "REOPENED"];

export interface OpenInput {
  orgId: string;
  websiteId: string;
  fingerprint: string;
  checkKey: string;
  category: "AVAILABILITY" | "SSL" | "HTTP_ERROR" | "SYSTEM" | "JS_ERROR" | "RESOURCE" | "RESPONSIVE" | "PERFORMANCE" | "FUNCTIONAL";
  source: "HTTP_PROBE" | "SSL" | "BROWSER" | "DEEP_SCAN";
  severity: Severity;
  title: string;
  description: string;
  scope: string;
  diagnostics: Record<string, unknown>;
  firstDetectedAt: Date;
  detectedAt: Date;
  count: number;
  occurrence: { executionId: string; pageUrl: string | null; details: Record<string, unknown> };
  reopenWindowSec?: number;
}

export interface OpenResult { incidentId: string; number: number; created: boolean; reopened: boolean }

export async function openIncident(tx: Tx, i: OpenInput): Promise<OpenResult> {
  // Serialise incident creation per org (numbering) and per fingerprint.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wim.incident'), hashtext(${i.orgId}))`;
  const [active] = await tx.$queryRaw<Array<{ id: string; number: number }>>`
    SELECT id, number FROM incidents WHERE org_id = ${i.orgId}::uuid AND fingerprint = ${i.fingerprint} AND status::text = ANY(${ACTIVE}::text[]) FOR UPDATE`;
  if (active) {
    await recordOccurrence(tx, active.id, i.orgId, i.detectedAt, i.occurrence, {});
    return { incidentId: active.id, number: active.number, created: false, reopened: false };
  }
  const [recent] = await tx.$queryRaw<Array<{ id: string; number: number; reopen_count: number }>>`
    SELECT id, number, reopen_count FROM incidents
     WHERE org_id = ${i.orgId}::uuid AND fingerprint = ${i.fingerprint} AND status = 'RESOLVED'
       AND resolved_at > ${i.detectedAt}::timestamptz - make_interval(secs => ${i.reopenWindowSec ?? 3600})
     ORDER BY resolved_at DESC LIMIT 1 FOR UPDATE`;
  if (recent) {
    await tx.$executeRaw`
      UPDATE incidents SET status = 'REOPENED', resolved_at = NULL, resolved_by_id = NULL, auto_resolved = false,
             reopen_count = reopen_count + 1, occurrence_count = occurrence_count + ${i.count}, last_detected_at = ${i.detectedAt},
             severity = ${i.severity}::"Severity", diagnostics = ${JSON.stringify(i.diagnostics)}::jsonb, updated_at = now()
       WHERE id = ${recent.id}::uuid`;
    await event(tx, i.orgId, recent.id, "REOPENED", "RESOLVED", "REOPENED", { reopenCount: recent.reopen_count + 1 });
    await occurrenceRow(tx, recent.id, i.orgId, i.detectedAt, i.occurrence);
    await outbox(tx, i.orgId, "incident.opened", { incidentId: recent.id, reopened: true }, `incident:${recent.id}:opened:${recent.reopen_count + 1}`);
    return { incidentId: recent.id, number: recent.number, created: false, reopened: true };
  }
  const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT coalesce(max(number), 1000)::int + 1 AS n FROM incidents WHERE org_id = ${i.orgId}::uuid`;
  const [row] = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO incidents (org_id, website_id, number, fingerprint, check_key, category, source, severity, status, title, description, scope,
                           diagnostics, occurrence_count, first_detected_at, last_detected_at, updated_at)
    VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${n}, ${i.fingerprint}, ${i.checkKey}, ${i.category}::"IncidentCategory", ${i.source}::"SignalSource",
            ${i.severity}::"Severity", 'OPEN', ${i.title}, ${i.description}, ${i.scope}, ${JSON.stringify(i.diagnostics)}::jsonb, ${i.count},
            ${i.firstDetectedAt}, ${i.detectedAt}, now())
    RETURNING id`;
  await event(tx, i.orgId, row!.id, "CREATED", null, "OPEN", { count: i.count });
  await occurrenceRow(tx, row!.id, i.orgId, i.detectedAt, i.occurrence);
  await outbox(tx, i.orgId, "incident.opened", { incidentId: row!.id, reopened: false }, `incident:${row!.id}:opened:0`);
  return { incidentId: row!.id, number: n, created: true, reopened: false };
}

/** Another failing check while the incident is active. No notification (no per-interval emails). */
export async function recordOccurrence(
  tx: Tx, incidentId: string, orgId: string, at: Date, occ: OpenInput["occurrence"], diagnosticsPatch: Record<string, unknown>,
): Promise<boolean> {
  const n = await tx.$executeRaw`
    UPDATE incidents SET occurrence_count = occurrence_count + 1, last_detected_at = GREATEST(last_detected_at, ${at}),
           diagnostics = diagnostics || ${JSON.stringify(diagnosticsPatch)}::jsonb, updated_at = now()
     WHERE id = ${incidentId}::uuid AND org_id = ${orgId}::uuid AND status::text = ANY(${ACTIVE}::text[])`;
  if (n) await occurrenceRow(tx, incidentId, orgId, at, occ);
  return n > 0;
}

export async function resolveIncident(tx: Tx, incidentId: string, orgId: string, at: Date, data: Record<string, unknown>): Promise<boolean> {
  const [r] = await tx.$queryRaw<Array<{ from_status: string; reopen_count: number; first_detected_at: Date }>>`
    UPDATE incidents i SET status = 'RESOLVED', resolved_at = ${at}, auto_resolved = true, updated_at = now()
      FROM (SELECT id, status::text AS from_status FROM incidents WHERE id = ${incidentId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE) o
     WHERE i.id = o.id AND i.status::text = ANY(${ACTIVE}::text[])
    RETURNING o.from_status, i.reopen_count, i.first_detected_at`;
  if (!r) return false;
  const durationSec = Math.max(0, Math.round((at.getTime() - r.first_detected_at.getTime()) / 1000));
  await event(tx, orgId, incidentId, "AUTO_RESOLVED", r.from_status, "RESOLVED", { ...data, recoveredAt: at.toISOString(), durationSec });
  await outbox(tx, orgId, "incident.resolved", { incidentId, durationSec }, `incident:${incidentId}:resolved:${r.reopen_count}`);
  return true;
}

export async function changeSeverity(tx: Tx, incidentId: string, orgId: string, severity: Severity, data: Record<string, unknown>) {
  const [r] = await tx.$queryRaw<Array<{ old: string }>>`
    UPDATE incidents i SET severity = ${severity}::"Severity", updated_at = now()
      FROM (SELECT id, severity::text AS old FROM incidents WHERE id = ${incidentId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE) o
     WHERE i.id = o.id AND o.old <> ${severity} RETURNING o.old`;
  if (r) await event(tx, orgId, incidentId, "SEVERITY_CHANGED", null, null, { from: r.old, to: severity, ...data });
}

/** Transactional outbox. `dedupeKey` makes one event per logical occurrence, whatever retries happen. */
export async function outbox(tx: Tx, orgId: string | null, topic: string, payload: Record<string, unknown>, dedupeKey: string): Promise<boolean> {
  const n = await tx.$executeRaw`
    INSERT INTO outbox_events (org_id, topic, payload, dedupe_key) VALUES (${orgId}::uuid, ${topic}, ${JSON.stringify(payload)}::jsonb, ${dedupeKey})
    ON CONFLICT (dedupe_key) DO NOTHING`;
  return n > 0;
}

async function event(tx: Tx, orgId: string, incidentId: string, type: string, from: string | null, to: string | null, data: Record<string, unknown>) {
  await tx.$executeRaw`
    INSERT INTO incident_events (org_id, incident_id, type, actor_type, from_status, to_status, data)
    VALUES (${orgId}::uuid, ${incidentId}::uuid, ${type}::"IncidentEventType", 'SYSTEM', ${from}::"IncidentStatus", ${to}::"IncidentStatus", ${JSON.stringify(data)}::jsonb)`;
}

async function occurrenceRow(tx: Tx, incidentId: string, orgId: string, at: Date, o: OpenInput["occurrence"]) {
  await tx.$executeRaw`
    INSERT INTO incident_occurrences (occurred_at, org_id, incident_id, execution_id, page_url, region, details)
    VALUES (${at}, ${orgId}::uuid, ${incidentId}::uuid, ${o.executionId}::uuid, ${o.pageUrl}, 'r1', ${JSON.stringify(o.details)}::jsonb)`;
}

export interface ThresholdSource { failureThreshold?: number; recoveryThreshold?: number }

/** Website config → incident rule (website, org, platform default) → platform setting. */
export async function resolveThresholds(
  tx: Tx, orgId: string, websiteId: string, categories: string[], cfg: ThresholdSource, defaults: { failure: number; recovery: number },
): Promise<Map<string, { failure: number; recovery: number }>> {
  const rules = await tx.$queryRaw<Array<{ category: string; failure_threshold: number; recovery_passes: number; rank: number }>>`
    SELECT category::text AS category, failure_threshold, recovery_passes,
           CASE WHEN website_id IS NOT NULL THEN 1 WHEN org_id IS NOT NULL THEN 2 ELSE 3 END AS rank
      FROM incident_rules
     WHERE enabled AND category::text = ANY(${categories}::text[])
       AND (website_id = ${websiteId}::uuid OR (website_id IS NULL AND (org_id = ${orgId}::uuid OR org_id IS NULL)))`;
  const out = new Map<string, { failure: number; recovery: number }>();
  for (const c of categories) {
    const rule = rules.filter((r) => r.category === c).sort((a, b) => a.rank - b.rank)[0];
    out.set(c, {
      failure: cfg.failureThreshold ?? rule?.failure_threshold ?? defaults.failure,
      recovery: cfg.recoveryThreshold ?? rule?.recovery_passes ?? defaults.recovery,
    });
  }
  return out;
}

/**
 * Claim the single logical result of an execution (execution_results, non-partitioned PK). Returns false when
 * a result was already recorded — the caller must then write nothing else (re-runs are no-ops).
 */
export async function recordLedger(tx: Tx, r: { executionId: string; orgId: string; websiteId: string; tier: "T1_HTTP" | "T2_RENDER" | "T3_DEEP"; windowStart: Date; outcome: string; attempt: number }): Promise<boolean> {
  const n = await tx.$executeRaw`
    INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
    VALUES (${r.executionId}::uuid, ${r.orgId}::uuid, ${r.websiteId}::uuid, ${r.tier}::"CheckTier", ${r.windowStart}, ${r.outcome}, ${r.attempt})
    ON CONFLICT (execution_id) DO NOTHING`;
  return n > 0;
}
