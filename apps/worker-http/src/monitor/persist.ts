import {
  advanceMonitorState, describeHttpFailure, emptyMonitorState, HTTP_INCIDENT_CLASSES, sslSeverity,
  type HttpClass, type HttpEvaluation, type HttpMonitorState, type SettingsSnapshot,
} from "@wim/core";
import type { Tx } from "@wim/db";
import { changeSeverity, openIncident, outbox, recordLedger, recordOccurrence, resolveIncident, resolveThresholds } from "@wim/incidents";
import type { ProbeResult } from "@wim/netguard";
import type { HttpTarget } from "./target.js";

export interface PersistInput {
  executionId: string;
  orgId: string;
  websiteId: string;
  windowStart: Date;
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  target: Pick<HttpTarget, "url" | "config" | "https"> | null;
  probe: ProbeResult | null;
  ev: HttpEvaluation;
}

export interface PersistOutcome { duplicate: boolean; actions: string[]; resultId: string | null }

/**
 * One transaction: the result row is the idempotency key. Only when it is NEW do counters,
 * incidents, occurrences and notification events change — so a re-run of the same
 * execution (crash, lease expiry, duplicate delivery) has no further effect.
 */
export async function persistResult(tx: Tx, i: PersistInput, s: SettingsSnapshot): Promise<PersistOutcome> {
  const p = i.probe;
  const finalHop = p?.hops.filter((h) => h.status !== null).at(-1);
  const details = {
    verdicts: i.ev.verdicts,
    kinds: i.ev.kinds,
    timings: p?.timings ?? null,
    hops: p?.hops.map((h) => ({ url: h.url, method: h.method, status: h.status, ms: { gateway: h.gatewayMs, dns: h.dnsMs, connect: h.connectMs, tls: h.tlsMs, ttfb: h.ttfbMs }, error: h.error })) ?? [],
    tls: p?.tls ? { authorized: p.tls.authorized, error: p.tls.error, validFrom: p.tls.validFrom, validTo: p.tls.validTo, issuer: p.tls.issuer, protocol: p.tls.protocol, hostnameMatch: p.tls.hostnameMatch, daysRemaining: i.ev.sslDaysRemaining } : null,
    truncated: p?.final?.truncated ?? false,
    headFallback: p?.headFallback ?? false,
    errorDetail: p?.error ? p.error : null, // the code only; free-text detail is not persisted
  };
  // The ledger row is the idempotency gate (one logical result per execution, enforced by the database).
  const ledger = await recordLedger(tx, { executionId: i.executionId, orgId: i.orgId, websiteId: i.websiteId, tier: "T1_HTTP", windowStart: i.windowStart, outcome: i.ev.status, attempt: i.attempt });
  if (!ledger) return { duplicate: true, actions: [], resultId: null };
  const [row] = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO check_results (checked_at, org_id, website_id, execution_id, url, status, failure_kind, http_status, redirect_chain,
                               dns_ms, connect_ms, tls_ms, ttfb_ms, total_ms, bytes, resolved_ip, ssl_expires_at, ssl_issuer, ssl_valid,
                               method, final_url, content_type, response_headers, failure_category, available, details, attempt, started_at, finished_at)
    VALUES (${i.windowStart}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${i.executionId}::uuid, ${p?.hops[0]?.url ?? i.target?.url ?? "[invalid]"},
            ${i.ev.status}::"ResultStatus", ${i.ev.failureKind}, ${p?.final?.status ?? null},
            ${JSON.stringify(p?.hops.filter((h) => h.status !== null && h.status >= 300 && h.status < 400).map((h) => ({ url: h.url, status: h.status })) ?? [])}::jsonb,
            ${p?.timings.dnsMs ?? null}, ${p?.timings.connectMs ?? null}, ${p?.timings.tlsMs ?? null}, ${p?.timings.ttfbMs ?? null}, ${p ? p.timings.totalMs : null},
            ${p?.final?.bytes ?? null}, ${finalHop?.address ?? null}::inet, ${p?.tls?.validTo ? new Date(p.tls.validTo) : null}, ${p?.tls?.issuer ?? null},
            ${p?.tls ? p.tls.authorized : null}, ${p?.methodUsed ?? null}, ${p?.final?.url ?? null}, ${p?.final?.contentType ?? null},
            ${JSON.stringify(p?.final?.headers ?? {})}::jsonb, ${i.ev.failureCategory}, ${i.ev.available}, ${JSON.stringify(details)}::jsonb,
            ${i.attempt}, ${i.startedAt}, ${i.finishedAt})
    ON CONFLICT (execution_id, checked_at) DO NOTHING
    RETURNING id`;
  if (!row) return { duplicate: true, actions: [], resultId: null };

  // Per-website state, serialised by the schedule row lock.
  const [sched] = await tx.$queryRaw<Array<{ id: string; state: HttpMonitorState | null; state_window_at: Date | null }>>`
    SELECT id, state, state_window_at FROM monitoring_schedules
     WHERE website_id = ${i.websiteId}::uuid AND tier = 'T1_HTTP' AND api_endpoint_id IS NULL FOR UPDATE`;
  if (!sched) return { duplicate: false, actions: ["no-schedule"], resultId: row.id };
  if (sched.state_window_at && i.windowStart.getTime() < sched.state_window_at.getTime()) {
    return { duplicate: false, actions: ["stale-window"], resultId: row.id }; // an older window finishing late never moves state backwards
  }
  const prev = sched.state && (sched.state as HttpMonitorState).v === 1 ? (sched.state as HttpMonitorState) : emptyMonitorState();
  const cfg = i.target?.config;
  const categories = [...new Set(Object.values(HTTP_INCIDENT_CLASSES).map((c) => c.category))];
  const thresholds = await resolveThresholds(tx, i.orgId, i.websiteId, categories, cfg ?? {}, {
    failure: s["monitoring.http.failureThreshold"], recovery: s["monitoring.http.recoveryThreshold"],
  });
  const now = i.finishedAt;
  const { state, actions } = advanceMonitorState(
    prev, i.ev, (cls) => thresholds.get(HTTP_INCIDENT_CLASSES[cls].category)!, now,
    { validTo: p?.tls?.validTo ?? null, warningDays: cfg?.sslWarningDays ?? [30, 14, 7, 3] }, s["monitoring.http.interruptedAfter"],
  );
  const done: string[] = [];
  const occurrence = {
    executionId: i.executionId, pageUrl: p?.final?.url ?? p?.hops.at(-1)?.url ?? null,
    details: { kind: i.ev.failureKind, httpStatus: p?.final?.status ?? null, totalMs: p?.timings.totalMs ?? null },
  };
  for (const a of actions) {
    if (a.type === "OPEN" || a.type === "OCCUR") {
      const spec = HTTP_INCIDENT_CLASSES[a.cls];
      const c = state.classes[a.cls]!;
      const severity = a.cls === "ssl_expiry" && i.ev.sslDaysRemaining !== null ? sslSeverity(i.ev.sslDaysRemaining) : spec.severity;
      if (a.type === "OCCUR" && c.incidentId) {
        const ok = await recordOccurrence(tx, c.incidentId, i.orgId, now, occurrence, { lastKind: a.kind, kinds: c.kinds });
        if (ok) { done.push(`occur:${a.cls}`); continue; }
        // the incident was resolved or ignored by someone else meanwhile: open/reopen below
      }
      const r = await openIncident(tx, {
        orgId: i.orgId, websiteId: i.websiteId, fingerprint: `http.${a.cls}:${i.websiteId}`, checkKey: `http.${a.cls}`,
        category: spec.category, source: a.cls === "ssl_expiry" || a.cls === "tls" ? "SSL" : "HTTP_PROBE", severity,
        title: spec.title, description: describeHttpFailure(a.kind), scope: "site",
        diagnostics: { lastKind: a.kind, kinds: c.kinds, streakStart: c.streakStart, url: occurrence.pageUrl },
        firstDetectedAt: new Date(c.streakStart ?? now), detectedAt: now, count: a.type === "OPEN" ? a.count : 1, occurrence,
      });
      c.incidentId = r.incidentId;
      done.push(`${r.created ? "open" : r.reopened ? "reopen" : "occur"}:${a.cls}`);
    } else if (a.type === "RESOLVE") {
      const id = prev.classes[a.cls]?.incidentId;
      if (id && (await resolveIncident(tx, id, i.orgId, now, { checkKey: `http.${a.cls}`, executionId: i.executionId }))) done.push(`resolve:${a.cls}`);
    } else if (a.type === "SSL_THRESHOLD") {
      const id = state.classes.ssl_expiry?.incidentId;
      if (id) await changeSeverity(tx, id, i.orgId, sslSeverity(a.days), { threshold: a.threshold });
      await outbox(tx, i.orgId, "ssl.expiring", { websiteId: i.websiteId, daysRemaining: a.days, threshold: a.threshold, validTo: a.validTo, incidentId: id ?? null },
        `ssl:${i.websiteId}:${a.validTo}:${a.threshold}`);
      done.push(`ssl:${a.threshold}`);
    } else if (a.type === "MONITORING_INTERRUPTED") {
      await outbox(tx, i.orgId, "monitoring.interrupted", { websiteId: i.websiteId, streak: a.streak, since: i.windowStart.toISOString() },
        `interrupted:${i.websiteId}:${i.windowStart.toISOString()}`);
      done.push("interrupted");
    }
  }
  await tx.$executeRaw`
    UPDATE monitoring_schedules SET state = ${JSON.stringify(state)}::jsonb, state_window_at = ${i.windowStart}
     WHERE id = ${sched.id}::uuid`;
  return { duplicate: false, actions: done, resultId: row.id };
}

export type { HttpClass };
