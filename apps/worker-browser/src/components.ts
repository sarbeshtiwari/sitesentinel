import { createHash } from "node:crypto";
import {
  compareViewports, diffComponents, normalizeUrl, pathTemplate, stableJson,
  type DetectedComponent, type FunctionalResult, type LayoutFacts, type StoredComponent,
} from "@wim/core";
import type { Tx } from "@wim/db";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The checked page's inventory rows: the same `discovered_pages` row the deep scan maintains, plus its monitored page. */
export async function ensureMonitoredPage(tx: Tx, orgId: string, websiteId: string, pageUrl: string): Promise<string | null> {
  const norm = normalizeUrl(pageUrl, null, { queryParamMode: "KEEP_MEANINGFUL", queryParamAllowlist: [], excludedQueryParams: [] });
  if (!norm) return null;
  const [dp] = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO discovered_pages (org_id, website_id, url, url_hash, path_template, source, depth, last_seen_at)
    VALUES (${orgId}::uuid, ${websiteId}::uuid, ${norm.href}, ${sha(norm.href)}, ${pathTemplate(norm)}, 'BROWSER', 0, now())
    ON CONFLICT (website_id, url_hash) DO UPDATE SET last_seen_at = now()
    RETURNING id`;
  const [mp] = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO monitored_pages (org_id, website_id, discovered_page_id, t2_enabled, last_result_at)
    VALUES (${orgId}::uuid, ${websiteId}::uuid, ${dp!.id}::uuid, true, now())
    ON CONFLICT (discovered_page_id) DO UPDATE SET last_result_at = now(), t2_enabled = true
    RETURNING id`;
  return mp!.id;
}

export interface ComponentPersistInput {
  orgId: string;
  websiteId: string;
  executionId: string;
  windowStart: Date;
  pageUrl: string;
  /** components per observed viewport (first = primary) */
  byViewport: Array<{ viewport: string; width: number; components: DetectedComponent[]; navState: LayoutFacts["navState"] }>;
  /** primary viewport loaded and detection ran within the budget: absence may count towards removal */
  complete: boolean;
  functional: FunctionalResult[];
}

/**
 * Inside the browser result transaction, AFTER the ledger gate (so a replayed execution never reaches this):
 * the page's inventory (`discovered_pages` → `monitored_pages` → `page_components`), its history (`component_events`)
 * and the functional test rows (`component_test_results`, ledger-checked by trigger).
 */
export async function persistComponents(tx: Tx, i: ComponentPersistInput): Promise<{ added: number; changed: number; removed: number; restored: number; tests: number; crossViewport: number }> {
  const stats = { added: 0, changed: 0, removed: 0, restored: 0, tests: 0, crossViewport: 0 };
  const monitoredPageId = await ensureMonitoredPage(tx, i.orgId, i.websiteId, i.pageUrl);
  if (!monitoredPageId) return stats;

  // ---- inventory: identity from the PRIMARY viewport only (other viewports only add visibility)
  const primary = i.byViewport[0];
  const visibleAt = new Map<string, string[]>();
  for (const v of i.byViewport) for (const c of v.components) if (c.visible) visibleAt.set(`${c.type}|${c.key}`, [...(visibleAt.get(`${c.type}|${c.key}`) ?? []), v.viewport]);
  const keyIds = new Map<string, string>();
  if (primary) {
    const stored = await tx.$queryRaw<Array<{ id: string; type: StoredComponent["type"]; key: string; detail_hash: string; status: string; missed_runs: number; detail: unknown; label: string | null }>>`
      SELECT id, type::text AS type, evidence->>'key' AS key, detail_hash, status, missed_runs, detail, label FROM page_components WHERE monitored_page_id = ${monitoredPageId}::uuid FOR UPDATE`;
    const current = primary.components.map((c) => ({ ...c, detailHash: sha(stableJson(c.detail)).slice(0, 32) }));
    const changes = diffComponents(stored.map((s) => ({ id: s.id, type: s.type, key: s.key, detailHash: s.detail_hash, status: s.status as "PRESENT" | "REMOVED", missedRuns: s.missed_runs })), current, i.complete);
    const prevById = new Map(stored.map((s) => [s.id, s]));
    const event = (id: string, type: string, before: unknown, after: unknown) => tx.$executeRaw`
      INSERT INTO component_events (org_id, website_id, page_component_id, execution_id, type, before, after)
      VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${id}::uuid, ${i.executionId}::uuid, ${type}, ${before === null ? null : JSON.stringify(before)}::jsonb, ${after === null ? null : JSON.stringify(after)}::jsonb)
      ON CONFLICT (page_component_id, execution_id, type) DO NOTHING`;
    for (const ch of changes) {
      if (ch.kind === "ADDED") {
        const c = ch.component;
        const [row] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO page_components (org_id, website_id, monitored_page_id, type, selector, dom_path_hash, confidence, evidence, label, detail, detail_hash, viewports, last_execution_id)
          VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${monitoredPageId}::uuid, ${c.type}::"ComponentType", ${c.selector}, ${sha(`${c.type}|${c.key}`).slice(0, 40)}, 0.8,
                  ${JSON.stringify({ key: c.key, heuristic: "structural", count: c.count })}::jsonb, ${c.label}, ${JSON.stringify(c.detail)}::jsonb, ${ch.detailHash},
                  ${visibleAt.get(`${c.type}|${c.key}`) ?? []}::text[], ${i.executionId}::uuid)
          RETURNING id`;
        keyIds.set(`${c.type}|${c.key}`, row!.id);
        // the very first run is the baseline: nothing was "added" from the customer's point of view
        if (stored.length) { await event(row!.id, "ADDED", null, { label: c.label, detail: c.detail }); stats.added++; }
      } else if (ch.kind === "MISSED" || ch.kind === "REMOVED") {
        await tx.$executeRaw`
          UPDATE page_components SET missed_runs = ${ch.missedRuns}, status = ${ch.kind === "REMOVED" ? "REMOVED" : "PRESENT"},
                 removed_at = ${ch.kind === "REMOVED" ? new Date() : null}, viewports = ARRAY[]::text[]
           WHERE id = ${ch.id}::uuid`;
        if (ch.kind === "REMOVED") { await event(ch.id, "REMOVED", { label: prevById.get(ch.id)?.label, detail: prevById.get(ch.id)?.detail }, null); stats.removed++; }
      } else {
        const c = ch.component;
        keyIds.set(`${c.type}|${c.key}`, ch.id);
        await tx.$executeRaw`
          UPDATE page_components SET status = 'PRESENT', missed_runs = 0, removed_at = NULL, last_seen_at = now(), selector = ${c.selector}, label = ${c.label},
                 detail = ${JSON.stringify(c.detail)}::jsonb, detail_hash = ${ch.detailHash}, viewports = ${visibleAt.get(`${c.type}|${c.key}`) ?? []}::text[],
                 last_execution_id = ${i.executionId}::uuid, evidence = evidence || ${JSON.stringify({ count: c.count })}::jsonb
           WHERE id = ${ch.id}::uuid`;
        const prev = prevById.get(ch.id);
        if (ch.kind === "CHANGED") { await event(ch.id, "CHANGED", { label: prev?.label, detail: prev?.detail }, { label: c.label, detail: c.detail }); stats.changed++; }
        if (ch.kind === "RESTORED") { await event(ch.id, "RESTORED", null, { label: c.label, detail: c.detail }); stats.restored++; }
      }
    }
  }
  // ---- responsive visibility per component: compare only viewports observed in THIS run with their last known state
  // (viewports rotate between runs: an unobserved viewport is unknown, never "hidden")
  if (primary && keyIds.size) {
    const observed = i.byViewport.map((v) => v.viewport);
    const ids = [...keyIds.values()];
    const rows = await tx.$queryRaw<Array<{ id: string; visibility: Record<string, boolean> }>>`SELECT id, visibility FROM page_components WHERE id = ANY(${ids}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r.visibility ?? {}]));
    for (const [key, id] of keyIds) {
      const before = byId.get(id) ?? {};
      const now: Record<string, boolean> = {};
      for (const v of observed) now[v] = (visibleAt.get(key) ?? []).includes(v);
      const flipped = observed.filter((v) => v in before && before[v] !== now[v]);
      const merged = { ...before, ...now };
      await tx.$executeRaw`UPDATE page_components SET visibility = ${JSON.stringify(merged)}::jsonb WHERE id = ${id}::uuid`;
      if (flipped.length) {
        await tx.$executeRaw`
          INSERT INTO component_events (org_id, website_id, page_component_id, execution_id, type, before, after)
          VALUES (${i.orgId}::uuid, ${i.websiteId}::uuid, ${id}::uuid, ${i.executionId}::uuid, 'VISIBILITY',
                  ${JSON.stringify(Object.fromEntries(flipped.map((v) => [v, before[v]])))}::jsonb, ${JSON.stringify(Object.fromEntries(flipped.map((v) => [v, now[v]])))}::jsonb)
          ON CONFLICT (page_component_id, execution_id, type) DO NOTHING`;
      }
    }
  }
  stats.crossViewport = compareViewports(i.byViewport).length;

  // ---- functional test results (one row per test; typed values and page content are never stored)
  for (const r of i.functional) {
    const componentId = r.componentKey ? keyIds.get(`${r.componentType}|${r.componentKey}`) ?? null : null;
    await tx.$executeRaw`
      INSERT INTO component_test_results (tested_at, org_id, website_id, monitored_page_id, page_component_id, execution_id, component_type, viewport, status, confidence,
                                          coverage_note, steps, failure_reason, test_kind, target, safety, duration_ms)
      VALUES (${i.windowStart}, ${i.orgId}::uuid, ${i.websiteId}::uuid, ${monitoredPageId}::uuid, ${componentId}::uuid, ${i.executionId}::uuid, ${r.componentType}::"ComponentType",
              ${r.viewport}, ${r.outcome}::"ResultStatus", 1, ${r.outcome === "PASSED" ? null : r.reason}, ${JSON.stringify(r.steps)}::jsonb,
              ${r.outcome === "FAILED" ? r.reason : null}, ${r.kind}, ${r.target.slice(0, 200)}, ${r.safety}, ${r.durationMs})`;
    stats.tests++;
  }
  return stats;
}
