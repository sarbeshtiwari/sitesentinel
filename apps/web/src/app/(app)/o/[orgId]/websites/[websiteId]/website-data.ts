"use client";
/**
 * Shared data for the website pages (header, Overview, Issues): the deep-scan summary, the merged list of open
 * problems (incidents of this website + deep-scan findings grouped by problem type) and the one health state.
 * Everything here is derived from existing API responses; nothing is invented.
 */
import { useQuery } from "@tanstack/react-query";
import type { DataEnvelope, HttpAnalyticsDto, IncidentSummaryDto, WebsiteDetailDto, WebsiteHealthDto } from "@wim/contracts";
import type { BadgeTone } from "@wim/ui";
import { get } from "@/lib/api";
import { mk } from "@/lib/monitoring";
import { findingReason, type FindingDto, type ScanDto } from "./deepscan-tab";

// ---------------------------------------------------------------- tabs and old URLs
export const TABS = ["overview", "issues", "pages", "performance", "settings"] as const;
export type Tab = (typeof TABS)[number];
export const PERF_SECTIONS = ["speed", "browser", "components", "layout", "availability"] as const;
export type PerfSection = (typeof PERF_SECTIONS)[number];
export const SETTINGS_SECTIONS = ["general", "monitoring", "ownership", "script", "alerts", "activity", "danger"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Old `?tab=` values (before the five-tab layout) → the tab and section that now hold the same content. */
export const TAB_ALIAS: Record<string, { tab: Tab; section?: string }> = {
  availability: { tab: "performance", section: "availability" },
  browser: { tab: "performance", section: "browser" },
  components: { tab: "performance", section: "components" },
  responsive: { tab: "performance", section: "layout" },
  "deep-scan": { tab: "issues", section: "deep-scan" },
  "monitoring-settings": { tab: "settings", section: "monitoring" },
  monitoring: { tab: "settings", section: "monitoring" },
  verification: { tab: "settings", section: "ownership" },
  installation: { tab: "settings", section: "script" },
  history: { tab: "settings", section: "activity" },
  audit: { tab: "settings", section: "activity" },
};

/** Resolve `?tab=…&section=…` (new or old form) to a tab and an optional section. Unknown values show the Overview. */
export function resolveTab(tab: string | null, section: string | null): { tab: Tab; section: string | null } {
  if (tab && (TABS as readonly string[]).includes(tab)) return { tab: tab as Tab, section };
  const a = tab ? TAB_ALIAS[tab] : undefined;
  if (a) return { tab: a.tab, section: a.section ?? section };
  return { tab: "overview", section: null };
}

export const tabHref = (orgId: string, websiteId: string, tab: Tab, section?: string | null) =>
  `/o/${orgId}/websites/${websiteId}?tab=${tab}${section ? `&section=${section}` : ""}`;

// ---------------------------------------------------------------- deep-scan summary (shared query key with the panel)
export interface DeepSummaryDto {
  entitled: boolean; enabled: boolean; pausedReason: string | null; resuming?: boolean; nextRunAt: string | null; latestScan: ScanDto | null;
  pending?: { executionId: string; status: string; queuedAt: string } | null;
  openFindings: Array<{ group: string; severity: string; count: number }>; openSitemapBroken?: number;
  effectiveLimits: { maxPages: number; maxDepth: number; browserPages: number; externalLinks: boolean };
}
export function useDeepSummary(orgId: string, websiteId: string, refetchInterval?: number | false | ((q: { state: { data?: DeepSummaryDto } }) => number | false)) {
  return useQuery({
    queryKey: mk.deep(orgId, websiteId),
    queryFn: ({ signal }) => get<DataEnvelope<DeepSummaryDto>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && websiteId),
    refetchInterval: refetchInterval as never,
  });
}

/** 30 days of HTTP availability, one bucket per day (the API picks daily buckets for ranges over 14 days). */
export function useAvailability30d(orgId: string, websiteId: string) {
  // whole minutes: the key stays stable between renders
  const to = new Date(Math.ceil(Date.now() / 600_000) * 600_000);
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const range = { from: from.toISOString(), to: to.toISOString() };
  return useQuery({
    queryKey: [...mk.site(orgId, websiteId), "availability-30d", range.from],
    queryFn: ({ signal }) => get<DataEnvelope<HttpAnalyticsDto>>(`/orgs/${orgId}/websites/${websiteId}/monitoring/http/analytics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && websiteId),
    placeholderData: (p) => p,
  });
}

/** Total of the page inventory, with the same query key the Pages tab uses for its first page (shared cache). */
export function usePagesTotal(orgId: string, websiteId: string) {
  const qs = new URLSearchParams({ page: "1", pageSize: "25", sort: "path:asc", filter: "all" });
  return useQuery({
    queryKey: [...mk.site(orgId, websiteId), "pages", qs.toString()],
    queryFn: ({ signal }) => get<{ total: number; summary: { total: number } }>(`/orgs/${orgId}/websites/${websiteId}/pages?${qs}`, { signal }),
    enabled: Boolean(orgId && websiteId),
  });
}

// ---------------------------------------------------------------- problems (incidents + grouped findings)
export const SEV_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
export const AREA_LABEL = {
  availability: "Availability", certificate: "Certificate", speed: "Speed", broken: "Broken links", sitemap: "Sitemap", seo: "SEO",
  accessibility: "Accessibility", forms: "Forms", layout: "Layout", behaviour: "Page behaviour",
} as const;
export type Area = keyof typeof AREA_LABEL;
const GROUP_AREA: Record<string, Area> = { broken_pages: "broken", broken_resources: "broken", sitemap: "sitemap", seo: "seo", structure: "seo", accessibility: "accessibility", forms: "forms" };
function incidentArea(i: IncidentSummaryDto): Area {
  if (i.checkKey.startsWith("deepscan.broken")) return "broken";
  switch (i.category) {
    case "SSL": return "certificate";
    case "PERFORMANCE": return "speed";
    case "RESOURCE": return "broken";
    case "FORM": case "SEARCH": return "forms";
    case "RESPONSIVE": return "layout";
    case "JS_ERROR": case "COMPONENT": case "FUNCTIONAL": return "behaviour";
    default: return "availability";
  }
}
const ACTIVE = new Set(["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "REOPENED"]);

export interface Problem {
  key: string;
  kind: "incident" | "finding";
  status: "OPEN" | "FIXED";
  severity: string;
  area: Area;
  title: string;
  /** one plain line: what is wrong (incident description, or the scanner's reason for a single finding) */
  summary: string | null;
  impact: string | null;
  fix: string | null;
  since: string;
  lastSeen: string;
  resolvedAt: string | null;
  incident?: IncidentSummaryDto;
  /** deep-scan findings of the same problem type (one category), most severe first */
  findings: FindingDto[];
}

export function findingProblems(findings: FindingDto[]): Problem[] {
  const groups = new Map<string, FindingDto[]>();
  for (const f of findings) {
    const k = `${f.category}|${f.status}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.entries()].map(([k, fs]) => {
    fs.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || a.subject.localeCompare(b.subject));
    const f0 = fs[0]!;
    const sev = fs.reduce((s, f) => ((SEV_RANK[f.severity] ?? 9) < (SEV_RANK[s] ?? 9) ? f.severity : s), f0.severity);
    const open = f0.status === "OPEN";
    return {
      key: `f:${k}`, kind: "finding" as const, status: open ? "OPEN" as const : "FIXED" as const, severity: sev, area: GROUP_AREA[f0.group] ?? "seo",
      title: f0.title, summary: fs.length === 1 ? findingReason(f0.evidence) : null,
      impact: f0.impact ?? (typeof f0.evidence.impact === "string" ? f0.evidence.impact : null), fix: f0.recommendation || null,
      since: fs.reduce((m, f) => (f.firstDetectedAt < m ? f.firstDetectedAt : m), f0.firstDetectedAt),
      lastSeen: fs.reduce((m, f) => (f.lastDetectedAt > m ? f.lastDetectedAt : m), f0.lastDetectedAt),
      resolvedAt: open ? null : fs.reduce<string | null>((m, f) => (f.resolvedAt && (!m || f.resolvedAt > m) ? f.resolvedAt : m), null),
      findings: fs,
    };
  });
}

export function incidentProblem(i: IncidentSummaryDto): Problem {
  return {
    key: `i:${i.id}`, kind: "incident", status: ACTIVE.has(i.status) ? "OPEN" : "FIXED", severity: i.severity, area: incidentArea(i), title: i.title,
    summary: i.description || null, impact: null, fix: null, since: i.firstDetectedAt, lastSeen: i.lastDetectedAt, resolvedAt: i.resolvedAt, incident: i, findings: [],
  };
}

export const byImpact = (a: Problem, b: Problem) =>
  (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || (a.kind === b.kind ? 0 : a.kind === "incident" ? -1 : 1) || b.findings.length - a.findings.length || b.lastSeen.localeCompare(a.lastSeen);
export const byNewest = (a: Problem, b: Problem) => (b.resolvedAt ?? b.lastSeen).localeCompare(a.resolvedAt ?? a.lastSeen);

/** Incidents of this website and deep-scan findings, open or fixed. */
export function useWebsiteProblems(orgId: string, websiteId: string, status: "OPEN" | "FIXED", opts: { url?: string; severity?: string } = {}) {
  const incidents = useQuery({
    queryKey: [...mk.incidents(orgId, { websiteId, status: status === "OPEN" ? "ACTIVE" : "RESOLVED", scope: "website-issues" })],
    queryFn: ({ signal }) => get<{ data: IncidentSummaryDto[] }>(`/orgs/${orgId}/incidents?${new URLSearchParams({ websiteId, status: status === "OPEN" ? "ACTIVE" : "RESOLVED", limit: "100" })}`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && websiteId),
  });
  const findings = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "findings", { status: status === "OPEN" ? "OPEN" : "RESOLVED", group: "", severity: opts.severity ?? "", url: opts.url ?? "" }],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto[]>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan/findings?${new URLSearchParams({ status: status === "OPEN" ? "OPEN" : "RESOLVED", limit: "500", ...(opts.severity ? { severity: opts.severity } : {}), ...(opts.url ? { url: opts.url } : {}) })}`, { signal }).then((r) => r.data),
    enabled: Boolean(orgId && websiteId),
  });
  const list = [
    ...(opts.url ? [] : (incidents.data ?? []).filter((i) => !opts.severity || i.severity === opts.severity).map(incidentProblem)),
    ...findingProblems(findings.data ?? []),
  ].sort(byImpact);
  return { incidents, findings, list, isLoading: incidents.isLoading || findings.isLoading, isError: incidents.isError && findings.isError, error: incidents.error ?? findings.error, refetch: () => { void incidents.refetch(); void findings.refetch(); } };
}

// ---------------------------------------------------------------- one health state
export type HealthKey = "HEALTHY" | "ATTENTION" | "DOWN" | "SETUP" | "PAUSED";
export const HEALTH_PILL: Record<HealthKey, { label: string; tone: BadgeTone }> = {
  HEALTHY: { label: "Healthy", tone: "success" }, ATTENTION: { label: "Needs attention", tone: "warning" }, DOWN: { label: "Down", tone: "danger" },
  SETUP: { label: "Setting up", tone: "info" }, PAUSED: { label: "Paused", tone: "neutral" },
};

/** Worst real signal wins: paused / not set up first, then down, then anything that needs a person. */
export function websiteHealth(w: WebsiteDetailDto, m: WebsiteHealthDto | undefined, open: Problem[]): HealthKey {
  if (w.status === "PAUSED" || w.status === "SUSPENDED") return "PAUSED";
  if (w.status === "LAPSED") return "ATTENTION";
  if (w.verification !== "VERIFIED") return "SETUP";
  if (m?.health === "DOWN") return "DOWN";
  if (m?.health === "DISABLED") return "PAUSED";
  const serious = open.some((p) => p.kind === "incident" || (SEV_RANK[p.severity] ?? 9) <= SEV_RANK.MEDIUM!);
  if (serious || m?.health === "DEGRADED" || (m?.activeIncidents ?? 0) > 0) return "ATTENTION";
  if (!m || m.health === "NO_DATA" || m.health === "NOT_VERIFIED") return "SETUP";
  if (m.health === "INCONCLUSIVE") return "ATTENTION";
  return "HEALTHY";
}

/** Consecutive most-recent days with checks and no failed check (today counts once it has a check). */
export function cleanDays(a: HttpAnalyticsDto | undefined): number {
  if (!a) return 0;
  const days = [...a.series];
  if (days.length && days[days.length - 1]!.up + days[days.length - 1]!.down === 0) days.pop(); // today: nothing measured yet
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (d.down > 0 || d.up === 0) break;
    n++;
  }
  return n;
}

const lower = (s: string) => (s.length > 1 && s[1] === s[1]!.toLowerCase() ? s.charAt(0).toLowerCase() + s.slice(1) : s);
export function problemPhrase(p: Problem) {
  const n = p.findings.length;
  return `${lower(p.title)}${n > 1 ? ` (${n} ${p.area === "broken" || p.area === "sitemap" ? "URLs" : "pages"})` : ""}`;
}

/** One plain sentence from real data, e.g. "Online for 12 days straight. 2 things need you: …". */
export function healthSentence(h: HealthKey, w: WebsiteDetailDto, open: Problem[], days: number, hasChecks: boolean): string {
  if (h === "PAUSED") return w.status === "SUSPENDED" ? "Monitoring is suspended by the platform. History is kept." : "Monitoring is paused. History is kept; nothing is checked until you resume.";
  if (w.status === "LAPSED") return "Monitoring is paused because ownership verification lapsed. Restore verification to resume.";
  if (w.verification !== "VERIFIED") return `Verify that you control ${w.displayHost} to start monitoring.`;
  const parts: string[] = [];
  if (h === "DOWN") parts.push("Your website is not answering our checks right now.");
  else if (days > 0) parts.push(`Online for ${days} day${days === 1 ? "" : "s"} straight.`);
  else if (!hasChecks) parts.push("Waiting for the first checks.");
  if (open.length === 0) parts.push(hasChecks ? "Nothing needs you right now." : "");
  else {
    const top = open.slice(0, 2).map(problemPhrase);
    parts.push(`${open.length} thing${open.length === 1 ? "" : "s"} need${open.length === 1 ? "s" : ""} you: ${top.join(", and ")}${open.length > 2 ? ", and more" : ""}.`);
  }
  return parts.filter(Boolean).join(" ");
}

export { ACTIVE as ACTIVE_INCIDENT };
