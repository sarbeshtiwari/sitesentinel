"use client";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  BrowserCheckResultDto, BrowserMonitoringSummaryDto, ChangeFeedDto, DataEnvelope, HistoryEventDto, HttpAnalyticsDto, HttpCheckResultDto,
  HttpMonitoringSummaryDto, IncidentDetailDto, IncidentSummaryDto, MonitoringOverviewDto, MonitoringUsageDto, NotificationDto,
  NotificationPreferenceDto, TierEntitlementsDto,
} from "@wim/contracts";
import { get } from "./api";

/** Same value as realtime-notifications (kept here to avoid an import cycle). */
const NOTIFICATIONS_CHANGED_EVENT = "wim:notifications-changed";

/** Query keys. Everything monitoring-related for an org sits under ["org", orgId, "mon"] so the change feed can
 *  invalidate precisely (per website where possible). */
export const mk = {
  all: (o: string) => ["org", o, "mon"] as const,
  overview: (o: string, range: Range) => ["org", o, "mon", "overview", range.from, range.to] as const,
  site: (o: string, w: string) => ["org", o, "mon", "site", w] as const,
  http: (o: string, w: string) => ["org", o, "mon", "site", w, "http"] as const,
  analytics: (o: string, w: string, range: Range) => ["org", o, "mon", "site", w, "analytics", range.from, range.to] as const,
  httpResults: (o: string, w: string, f: object) => ["org", o, "mon", "site", w, "http-results", f] as const,
  browser: (o: string, w: string) => ["org", o, "mon", "site", w, "browser"] as const,
  browserResults: (o: string, w: string, f: object) => ["org", o, "mon", "site", w, "browser-results", f] as const,
  browserResult: (o: string, w: string, e: string) => ["org", o, "mon", "site", w, "browser-result", e] as const,
  deep: (o: string, w: string) => ["org", o, "mon", "site", w, "deep"] as const,
  schedule: (o: string, w: string) => ["org", o, "mon", "site", w, "schedule"] as const,
  incidents: (o: string, f: object) => ["org", o, "mon", "incidents", f] as const,
  incident: (o: string, i: string) => ["org", o, "mon", "incident", i] as const,
  history: (o: string, f: object) => ["org", o, "mon", "history", f] as const,
  usage: (o: string) => ["org", o, "mon", "usage"] as const,
  notifications: (o: string, f: object) => ["org", o, "notifications", f] as const,
  prefs: (o: string) => ["org", o, "notification-prefs"] as const,
};

// ------------------------------------------------------------------ time ranges (sent to the API as UTC instants)
export type RangeKey = "24h" | "7d" | "30d" | "custom";
export interface Range { key: RangeKey; from: string; to: string }
const HOURS: Record<Exclude<RangeKey, "custom">, number> = { "24h": 24, "7d": 168, "30d": 720 };
/** Rounded to the minute so the query key is stable between renders. */
export function presetRange(key: Exclude<RangeKey, "custom">): Range {
  const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  return { key, from: new Date(to.getTime() - HOURS[key] * 3_600_000).toISOString(), to: to.toISOString() };
}
export const rangeQs = (r: Range) => `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;

// ------------------------------------------------------------------ formatting (viewer's time zone, labelled)
// The API stores and reports UTC; every timestamp is shown in the viewer's browser time zone with its short name
// (e.g. "2026-11-15 20:22 IST"). Monitoring data loads client-side, so server and browser never disagree.
const two = (n: number) => String(n).padStart(2, "0");
function zoneName(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { return ""; }
}
/** "YYYY-MM-DD HH:mm <zone>" in the viewer's time zone. */
export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} ${zoneName(d)}`.trim();
};
/** Calendar day (YYYY-MM-DD) in the viewer's time zone. */
export const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
/** Value for <input type="datetime-local"> in the viewer's time zone. */
export const toLocalInput = (iso: string) => { const d = new Date(iso); return `${localDay(iso)}T${two(d.getHours())}:${two(d.getMinutes())}`; };
/** Short name of the viewer's time zone (client only; empty during server render). */
export const localZone = () => (typeof window === "undefined" ? "" : zoneName(new Date()));
export const fmtMs = (v: number | null | undefined) => (v == null ? "—" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
export const fmtPct = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `${v.toFixed(digits).replace(/\.?0+$/, "")}%`);
export function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86_400)} d ${Math.round((sec % 86_400) / 3600)} h`;
}
export function fmtBytes(b: number | null | undefined) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(2)} GB`;
}

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger";
/** One vocabulary for monitoring state across all pages. Colour only for meaningful states. */
export const HEALTH: Record<string, { label: string; tone: Tone; help: string }> = {
  HEALTHY: { label: "Healthy", tone: "success", help: "All active checks pass with enough coverage" },
  UP: { label: "Up", tone: "success", help: "The latest checks pass" },
  DEGRADED: { label: "Degraded", tone: "warning", help: "Some checks fail or an incident is open" },
  DOWN: { label: "Down", tone: "danger", help: "The website is unavailable" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "neutral", help: "Not enough reliable data — not a confirmed outage" },
  UNKNOWN: { label: "No data yet", tone: "neutral", help: "Monitoring is on but has no result yet" },
  NO_DATA: { label: "No data yet", tone: "neutral", help: "Monitoring is on but has no result yet" },
  DISABLED: { label: "Disabled", tone: "neutral", help: "Monitoring is off or paused" },
  PAUSED: { label: "Paused", tone: "neutral", help: "Monitoring is paused" },
  NOT_MONITORED: { label: "Not monitored", tone: "neutral", help: "This check is not active for this website" },
  NOT_VERIFIED: { label: "Not verified", tone: "warning", help: "Verify ownership to start monitoring" },
  TIER_DISABLED: { label: "Not available", tone: "neutral", help: "Not offered on this platform yet" },
  NOT_ENTITLED: { label: "Not in plan", tone: "neutral", help: "Not included in your plan" },
  DISABLED_BY_CUSTOMER: { label: "Turned off", tone: "neutral", help: "Turned off in the monitoring settings" },
  WEBSITE_LIMIT: { label: "Over limit", tone: "warning", help: "Your plan's website limit for this check is reached" },
  WEBSITE_PAUSED: { label: "Paused", tone: "neutral", help: "Monitoring of this website is paused" },
  OWNERSHIP_LAPSED: { label: "Verification lapsed", tone: "warning", help: "Restore ownership verification to resume" },
};
export const health = (s: string | null | undefined) => HEALTH[s ?? ""] ?? { label: s ?? "—", tone: "neutral" as Tone, help: "" };
export const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  PASSED: { label: "Passed", tone: "success" }, FAILED: { label: "Failed", tone: "danger" }, INCONCLUSIVE: { label: "Inconclusive", tone: "neutral" },
};
export const outcome = (o: string | null | undefined) => OUTCOME[o ?? ""] ?? { label: o ?? "—", tone: "neutral" as Tone };
export const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "neutral", INFO: "neutral" };
export const INCIDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: "Open", tone: "danger" }, REOPENED: { label: "Reopened", tone: "danger" }, ACKNOWLEDGED: { label: "Acknowledged", tone: "warning" },
  INVESTIGATING: { label: "Investigating", tone: "warning" }, RESOLVED: { label: "Resolved", tone: "success" }, IGNORED: { label: "Ignored", tone: "neutral" },
};
export const SOURCE_LABEL: Record<string, string> = { HTTP: "HTTP availability", BROWSER: "Browser", DEEP_SCAN: "Deep scan" };
export const SCAN_STATUS: Record<string, { label: string; tone: Tone; help: string }> = {
  RUNNING: { label: "Running", tone: "brand", help: "The scan is in progress" },
  COMPLETED: { label: "Completed", tone: "success", help: "The planned scan ran to its end" },
  PARTIAL: { label: "Partial", tone: "warning", help: "Stopped early — not everything was checked; nothing is resolved by a partial scan" },
  CANCELLED: { label: "Cancelled", tone: "neutral", help: "Cancelled; partial data kept, nothing resolved" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "neutral", help: "Our infrastructure could not complete the scan" },
};

// ------------------------------------------------------------------ queries (abort signals cancel superseded requests)
export function useOverview(orgId: string, range: Range) {
  return useQuery({
    queryKey: mk.overview(orgId, range),
    queryFn: ({ signal }) => get<DataEnvelope<MonitoringOverviewDto>>(`/orgs/${orgId}/monitoring/overview?${rangeQs(range)}`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId), placeholderData: (prev) => prev,
  });
}
export function useHttpSummary(orgId: string, w: string) {
  return useQuery({ queryKey: mk.http(orgId, w), queryFn: ({ signal }) => get<DataEnvelope<HttpMonitoringSummaryDto>>(`/orgs/${orgId}/websites/${w}/monitoring/http`, { signal }).then((r) => r.data), enabled: Boolean(orgId && w) });
}
export function useAnalytics(orgId: string, w: string, range: Range) {
  return useQuery({
    queryKey: mk.analytics(orgId, w, range),
    queryFn: ({ signal }) => get<DataEnvelope<HttpAnalyticsDto>>(`/orgs/${orgId}/websites/${w}/monitoring/http/analytics?${rangeQs(range)}`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && w), placeholderData: (prev) => prev,
  });
}
export function useHttpResults(orgId: string, w: string, f: { outcome?: string; from?: string }) {
  return useInfiniteQuery({
    queryKey: mk.httpResults(orgId, w, f),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ limit: "25", ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.from ? { from: f.from } : {}), ...(pageParam ? { before: pageParam } : {}) });
      return get<{ data: HttpCheckResultDto[]; nextBefore: string | null }>(`/orgs/${orgId}/websites/${w}/monitoring/http/results?${p}`, { signal });
    },
    initialPageParam: "" as string, getNextPageParam: (l) => l.nextBefore ?? undefined, enabled: Boolean(orgId && w),
  });
}
export function useBrowserSummary(orgId: string, w: string) {
  return useQuery({ queryKey: mk.browser(orgId, w), queryFn: ({ signal }) => get<DataEnvelope<BrowserMonitoringSummaryDto>>(`/orgs/${orgId}/websites/${w}/monitoring/browser`, { signal }).then((r) => r.data), enabled: Boolean(orgId && w) });
}
export function useBrowserResults(orgId: string, w: string, f: { outcome?: string; viewport?: string; problem?: string; from?: string }) {
  return useInfiniteQuery({
    queryKey: mk.browserResults(orgId, w, f),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ limit: "10", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(pageParam ? { before: pageParam } : {}) });
      return get<{ data: BrowserCheckResultDto[]; nextBefore: string | null }>(`/orgs/${orgId}/websites/${w}/monitoring/browser/results?${p}`, { signal });
    },
    initialPageParam: "" as string, getNextPageParam: (l) => l.nextBefore ?? undefined, enabled: Boolean(orgId && w),
  });
}
export function useBrowserResult(orgId: string, w: string, e: string) {
  return useQuery({ queryKey: mk.browserResult(orgId, w, e), queryFn: ({ signal }) => get<DataEnvelope<BrowserCheckResultDto>>(`/orgs/${orgId}/websites/${w}/monitoring/browser/results/${e}`, { signal }).then((r) => r.data), enabled: Boolean(orgId && w && e) });
}
export function useSchedule(orgId: string, w: string) {
  return useQuery({
    queryKey: mk.schedule(orgId, w),
    queryFn: ({ signal }) => get<DataEnvelope<{ requested: { httpIntervalSec: number | null; browserIntervalSec: number | null; deepScanIntervalSec: number | null }; entitlements: TierEntitlementsDto }>>(`/orgs/${orgId}/websites/${w}/monitoring/schedule`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && w),
  });
}
export interface IncidentFilters { status: string; severity?: string; source?: string; websiteId?: string; from?: string }
export function useIncidents(orgId: string, f: IncidentFilters, limit = 25) {
  return useInfiniteQuery({
    queryKey: mk.incidents(orgId, { ...f, limit }),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ limit: String(limit), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(pageParam ? { cursor: pageParam } : {}) });
      return get<{ data: IncidentSummaryDto[]; nextCursor: string | null }>(`/orgs/${orgId}/incidents?${p}`, { signal });
    },
    initialPageParam: "" as string, getNextPageParam: (l) => l.nextCursor ?? undefined, enabled: Boolean(orgId),
  });
}
export function useIncident(orgId: string, id: string) {
  return useQuery({ queryKey: mk.incident(orgId, id), queryFn: ({ signal }) => get<DataEnvelope<IncidentDetailDto & { resolvedAt?: string | null }>>(`/orgs/${orgId}/incidents/${id}`, { signal }).then((r) => r.data), enabled: Boolean(orgId && id) });
}
export interface HistoryFilters { websiteId?: string; type?: string; source?: string; result?: string; from?: string; to?: string }
export function useHistory(orgId: string, f: HistoryFilters) {
  return useInfiniteQuery({
    queryKey: mk.history(orgId, f),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ limit: "50", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(pageParam ? { cursor: pageParam } : {}) });
      return get<{ data: HistoryEventDto[]; nextCursor: string | null; retention?: { checksDays: number | null; browserDays: number | null } }>(`/orgs/${orgId}/monitoring/history?${p}`, { signal });
    },
    initialPageParam: "" as string, getNextPageParam: (l) => l.nextCursor ?? undefined, enabled: Boolean(orgId),
  });
}
export function useUsage(orgId: string) {
  return useQuery({ queryKey: mk.usage(orgId), queryFn: ({ signal }) => get<DataEnvelope<MonitoringUsageDto>>(`/orgs/${orgId}/monitoring/usage`, { signal }).then((r) => r.data), enabled: Boolean(orgId) });
}
export function useNotifications(orgId: string, unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: mk.notifications(orgId, { unreadOnly }),
    queryFn: ({ signal, pageParam }) => {
      const p = new URLSearchParams({ limit: "30", ...(unreadOnly ? { unread: "true" } : {}), ...(pageParam ? { cursor: pageParam } : {}) });
      return get<{ data: NotificationDto[]; nextCursor: string | null; unread: number }>(`/orgs/${orgId}/notifications?${p}`, { signal });
    },
    initialPageParam: "" as string, getNextPageParam: (l) => l.nextCursor ?? undefined, enabled: Boolean(orgId),
  });
}
export function useNotificationPrefs(orgId: string) {
  return useQuery({ queryKey: mk.prefs(orgId), queryFn: ({ signal }) => get<DataEnvelope<NotificationPreferenceDto[]>>(`/orgs/${orgId}/notification-preferences`, { signal }).then((r) => r.data), enabled: Boolean(orgId) });
}

/** Debounced value (search boxes). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ------------------------------------------------------------------ live updates
/**
 * One poller per organisation (mounted in the app shell). Asks the authenticated change feed what changed since the
 * last cursor and invalidates only the affected queries; the data itself is always refetched through the normal,
 * authorised endpoints. 15 s when the tab is visible, paused when hidden, exponential backoff (max 2 min) on errors;
 * the cursor carries over, so nothing is missed across a reconnect. Returns the unread notification count.
 */
/** How often an open (visible) tab asks the API what changed; hidden tabs pause and catch up when shown again. */
const LIVE_POLL_MS = 5_000;
/** Routine check results (CHECK / EXECUTION arrive about once a minute per website) refresh the screen at most this often. */
const ROUTINE_REFRESH_MS = 30_000;
/** Per-website queries that are expensive and barely move with a single check; they refresh on their own events. */
const HEAVY_KEYS = new Set(["availability-30d", "pages", "findings", "deep"]);
const isHeavy = (key: readonly unknown[]) => key.some((k) => typeof k === "string" && HEAVY_KEYS.has(k));
export function useLiveUpdates(orgId: string | undefined) {
  const qc = useQueryClient();
  const [unread, setUnread] = useState(0);
  const cursor = useRef<string | null>(null);
  const lastUnread = useRef(0);
  const lastRoutine = useRef(0);
  useEffect(() => {
    if (!orgId) return;
    cursor.current = null;
    let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const ctl = new AbortController();
    const tick = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") { timer = setTimeout(tick, 5000); return; }
      try {
        const qs = cursor.current ? `?since=${cursor.current}` : "";
        const r = await get<DataEnvelope<ChangeFeedDto>>(`/orgs/${orgId}/changes${qs}`, { signal: ctl.signal, noAuthRedirect: true });
        const first = cursor.current === null;
        cursor.current = r.data.cursor;
        // New notifications: the real-time notifier (leader tab) fetches them right away.
        if (!first && (r.data.unreadNotifications > lastUnread.current || r.data.changes.some((c) => c.kind === "NOTIFICATION"))) {
          window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { orgId } }));
        }
        lastUnread.current = r.data.unreadNotifications;
        setUnread(r.data.unreadNotifications);
        failures = 0;
        if (!first && r.data.changes.length) {
          // Status changes (incidents, deep scans, websites, notifications) refresh every on-screen query of the
          // organisation at once (inactive queries are only marked stale). Routine check results are frequent, so they
          // refresh at most every ROUTINE_REFRESH_MS and leave the heavy per-website queries alone.
          const important = r.data.changes.some((c) => c.kind !== "CHECK" && c.kind !== "EXECUTION");
          if (important) void qc.invalidateQueries({ queryKey: ["org", orgId] });
          else if (Date.now() - lastRoutine.current >= ROUTINE_REFRESH_MS) {
            lastRoutine.current = Date.now();
            void qc.invalidateQueries({ queryKey: ["org", orgId], predicate: (q) => !isHeavy(q.queryKey) });
          }
        }
      } catch {
        if (stopped) return;
        failures++;
      }
      timer = setTimeout(tick, failures ? Math.min(120_000, LIVE_POLL_MS * 2 ** failures) : LIVE_POLL_MS);
    };
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => { stopped = true; ctl.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [orgId, qc]);
  return unread;
}
