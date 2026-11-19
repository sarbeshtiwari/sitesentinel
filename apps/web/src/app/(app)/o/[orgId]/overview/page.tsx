"use client";
import type { DataEnvelope, InvitationDto, MemberDto, MonitoringOverviewDto, WebsiteHealthDto, WebsiteSummaryDto } from "@wim/contracts";
import { buttonVariants, Card, cn, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ChevronRight, Circle, Gauge, Globe, MonitorSmartphone, Plus, ScanSearch, Siren } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PerfBadge } from "../websites/[websiteId]/performance-tab";
import {
  cleanDays, healthSentence, HEALTH_PILL, isSerious, tabHref, useAvailability30dMany, useOrgProblems, usePagesTotalMany, websiteHealth, type HealthKey, type Problem,
} from "../websites/[websiteId]/website-data";
import { Dot, HealthBadge, Hint, QueryState, RangePicker, Section } from "@/components/monitoring";
import { DayStrip, StatStrip, type Stat } from "@/components/org-ui";
import { get } from "@/lib/api";
import { qk, useOrg } from "@/lib/hooks";
import {
  fmtPct, fmtTime, INCIDENT_STATUS, presetRange, SCAN_STATUS, SEVERITY_TONE, SOURCE_LABEL, useIncidents, useNotificationPrefs, useOverview, useUsage, type Range,
} from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";

// Order in which health states are summarised (worst first). Everything shown is counted from the API response.
const FLEET: Array<{ key: string; label: string; bar: string }> = [
  { key: "DOWN", label: "Down", bar: "bg-danger" },
  { key: "DEGRADED", label: "Degraded", bar: "bg-warning" },
  { key: "NOT_VERIFIED", label: "Not verified", bar: "bg-[color-mix(in_srgb,var(--warning)_45%,transparent)]" },
  { key: "INCONCLUSIVE", label: "Inconclusive", bar: "bg-subtle-foreground" },
  { key: "NO_DATA", label: "No data yet", bar: "bg-[color-mix(in_srgb,var(--info)_45%,transparent)]" },
  { key: "DISABLED", label: "Disabled", bar: "bg-border-strong" },
  { key: "HEALTHY", label: "Healthy", bar: "bg-success" },
];
const RANGE_LABEL: Record<Range["key"], string> = { "24h": "24 h", "7d": "7 days", "30d": "30 days", custom: "custom range" };
const fmtSec = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Row { m: WebsiteHealthDto; health: HealthKey; sentence: string; open: Problem[]; loading: boolean; avail: ReturnType<typeof useAvailability30dMany>[number] | undefined }

/** "Both websites are online. 2 issues need you." — built only from the overview and the open problems. */
function headline(rows: Row[], orgName: string | undefined, problemsLoading: boolean) {
  const total = rows.length;
  if (!total) return { title: orgName ? `Welcome to ${orgName}` : "Welcome", sub: null };
  const down = rows.filter((r) => r.health === "DOWN");
  const online = rows.filter((r) => r.m.http.state === "UP").length;
  const monitored = rows.filter((r) => r.m.verification === "VERIFIED" && r.health !== "PAUSED").length;
  let status: string;
  if (down.length === 1) status = `${down[0]!.m.name} is down.`;
  else if (down.length > 1) status = `${down.length} websites are down.`;
  else if (monitored === 0) status = rows.some((r) => r.health === "PAUSED") ? (total === 1 ? "Monitoring is paused." : "Monitoring is paused or not set up yet.") : rows.some((r) => r.m.verification !== "VERIFIED") ? "Verify a website to start monitoring." : "Monitoring hasn't started yet.";
  else if (online === total) status = total === 1 ? "Your website is online." : total === 2 ? "Both websites are online." : `All ${total} websites are online.`;
  else if (online > 0) status = `${online} of ${plural(total, "website")} ${online === 1 ? "is" : "are"} online.`;
  else status = "No confirmed outages.";
  if (problemsLoading) return { title: status, sub: null };
  const need = rows.reduce((a, r) => a + r.open.filter(isSerious).length, 0);
  const issues = need === 0 ? "Nothing needs you right now." : `${plural(need, "issue")} need${need === 1 ? "s" : ""} you.`;
  return { title: `${status} ${issues}`, sub: null };
}

function WebsitesList({ rows, base, orgId }: { rows: Row[]; base: string; orgId: string }) {
  const issues = (r: Row) => {
    if (r.loading) return <span className="text-muted-foreground">—</span>;
    const n = r.open.length, serious = r.open.filter(isSerious).length;
    if (!n) return <span className="text-muted-foreground">No issues</span>;
    const label = serious === 0 && n === 1 ? "1 low issue" : plural(n, "issue");
    return <Link href={tabHref(orgId, r.m.id, "issues")} className={cn("hover:underline", serious ? "font-medium text-warning-text" : "text-muted-foreground")}>{label}</Link>;
  };
  return (
    <section aria-labelledby="your-websites">
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <h2 id="your-websites" className="text-[15px] font-semibold tracking-tight">Your websites</h2>
        <Link href={`${base}/websites`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">Manage <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
      </div>
      {/* Cards on small screens */}
      <ul className="grid gap-2.5 md:hidden">
        {rows.map((r) => (
          <li key={r.m.id}>
            <Card className="relative px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`${base}/websites/${r.m.id}`} className="block truncate font-semibold after:absolute after:inset-0">{r.m.name}</Link>
                  <p className="truncate text-xs text-muted-foreground">{r.m.displayHost}</p>
                </div>
                <StatusPill tone={HEALTH_PILL[r.health].tone}>{HEALTH_PILL[r.health].label}</StatusPill>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{r.sentence}</p>
              <DayStrip a={r.avail?.data} className="mt-2.5 h-5" />
              <p className="mt-2 flex justify-between text-xs text-muted-foreground"><span>Uptime {fmtPct(r.m.http.uptime.uptimePercent)} · {r.m.http.uptime.measuredChecks} checks</span><span className="relative z-10">{issues(r)}</span></p>
            </Card>
          </li>
        ))}
      </ul>
      {/* Table from md up */}
      <Card className="hidden overflow-hidden md:block">
        <Table>
          <THead className="sr-only"><TR><TH>Website</TH><TH>Health</TH><TH>Last 30 days</TH><TH>Issues</TH><TH>Open</TH></TR></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.m.id}>
                <TD className="w-[26%] max-w-64 py-3.5">
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", { success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info", neutral: "bg-faint", brand: "bg-primary" }[HEALTH_PILL[r.health].tone])} />
                    <div className="min-w-0">
                      <Link href={`${base}/websites/${r.m.id}`} className="block truncate font-semibold hover:text-primary">{r.m.name}</Link>
                      <div className="truncate text-xs text-muted-foreground">{r.m.displayHost}{r.m.http.lastCheckAt ? ` · checked ${fmtTime(r.m.http.lastCheckAt)}` : ""}</div>
                    </div>
                  </div>
                </TD>
                <TD className="py-3.5">
                  <StatusPill tone={HEALTH_PILL[r.health].tone}>{HEALTH_PILL[r.health].label}</StatusPill>
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{r.sentence}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                    <span className="tabular-nums">Uptime {fmtPct(r.m.http.uptime.uptimePercent)} · {r.m.http.uptime.measuredChecks} checks · coverage {fmtPct(r.m.http.uptime.coveragePercent, 1)}</span>
                    <span className="hidden xl:inline-flex xl:items-center xl:gap-1">Browser <HealthBadge state={r.m.browser.state} className="py-0" /></span>
                    {r.m.performance && <Link href={tabHref(orgId, r.m.id, "performance", "speed")} className="inline-flex items-center gap-1">Speed <PerfBadge s={r.m.performance.status} />{r.m.performance.regressions.length ? <span className="text-danger-text">{plural(r.m.performance.regressions.length, "regression")}</span> : null}</Link>}
                    {r.m.deepScan.lastStatus && <span className="hidden xl:inline">Deep scan: {SCAN_STATUS[r.m.deepScan.lastStatus]?.label ?? r.m.deepScan.lastStatus}{r.m.deepScan.openFindings ? ` · ${r.m.deepScan.openFindings} findings` : ""}</span>}
                    {r.m.reasons[0] && <span className="sr-only">{r.m.reasons.join(". ")}</span>}
                  </p>
                </TD>
                <TD className="hidden w-[22%] lg:table-cell">{r.avail?.data && r.avail.data.checks.total > 0 ? <DayStrip a={r.avail.data} /> : <span className="text-xs text-muted-foreground">{r.m.verification === "VERIFIED" ? "No checks yet" : "Starts after verification"}</span>}</TD>
                <TD className="whitespace-nowrap text-right text-[13px]">
                  {issues(r)}
                  {r.m.activeIncidents > 0 && <div><Link className="text-xs font-medium text-danger-text hover:underline" href={`${base}/incidents?websiteId=${r.m.id}`}>{r.m.activeIncidents} open incident{r.m.activeIncidents === 1 ? "" : "s"}</Link></div>}
                </TD>
                <TD className="w-8 pl-0"><Link href={`${base}/websites/${r.m.id}`} aria-label={`Open ${r.m.name}`} className="flex text-faint hover:text-foreground"><ChevronRight className="h-4 w-4" aria-hidden /></Link></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </section>
  );
}

function ActiveIncidents({ orgId, base }: { orgId: string; base: string }) {
  const q = useIncidents(orgId, { status: "ACTIVE" }, 5);
  const items = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Section title="Active incidents" icon={<Siren />} flush actions={<Link href={`${base}/incidents`} className={buttonVariants({ variant: "ghost", size: "sm" })}>View all <ArrowRight /></Link>}>
      <QueryState q={q} skeleton="h-40 m-4">
        {!items.length ? (
          <div className="flex items-center gap-3 px-5 py-6 text-sm text-muted-foreground"><CheckCircle2 className="h-5 w-5 text-success" aria-hidden /> No active incidents.</div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => {
              const st = INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
              return (
                <li key={i.id}>
                  <Link href={`${base}/incidents/${i.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-sunken/70 sm:px-5">
                    <span className="mt-1.5"><Dot tone={SEVERITY_TONE[i.severity] ?? "neutral"} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{i.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">#{i.number} · {i.websiteName ?? "Website"}{i.source ? ` · ${SOURCE_LABEL[i.source] ?? i.source}` : ""} · since {fmtTime(i.firstDetectedAt)}</span>
                    </span>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Section>
  );
}

function RecentChanges({ d, base }: { d: MonitoringOverviewDto; base: string }) {
  return (
    <section aria-labelledby="recent-changes">
      <h2 id="recent-changes" className="text-[15px] font-semibold tracking-tight">What changed recently</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Component changes and synthetic performance regressions vs. the previous period.</p>
      {!d.recentChanges.length ? <p className="mt-3 text-sm text-muted-foreground">Nothing changed in this range.</p> : (
        <ol className="mt-2 divide-y divide-border">
          {d.recentChanges.map((c, i) => (
            <li key={i} className="flex items-start gap-3 py-3">
              <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", c.kind === "PERFORMANCE_REGRESSION" ? "bg-warning" : "bg-info")} />
              <div className="min-w-0">
                <Link className="block text-sm hover:text-primary" href={`${base}${c.link}`}><span className="font-medium">{c.websiteName}</span>: {c.title}</Link>
                <p className="text-xs text-muted-foreground">{c.kind === "PERFORMANCE_REGRESSION" ? "Speed regression" : "Component change"} · {fmtTime(c.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Setup steps from real data only; done steps are ticked, the card disappears once everything is done. */
function SetupChecklist({ orgId, base, sites }: { orgId: string; base: string; sites: WebsiteSummaryDto[] }) {
  const { can } = useOrg();
  const prefs = useNotificationPrefs(orgId);
  const members = useQuery({ queryKey: qk.members(orgId), queryFn: () => get<DataEnvelope<MemberDto[]>>(`/orgs/${orgId}/members`).then((r) => r.data), enabled: Boolean(orgId) && can("member:read") });
  const invites = useQuery({ queryKey: qk.invitations(orgId), queryFn: () => get<DataEnvelope<InvitationDto[]>>(`/orgs/${orgId}/invitations`).then((r) => r.data), enabled: Boolean(orgId) && can("member:manage") });
  const unverified = sites.filter((w) => w.verification !== "VERIFIED");
  const noScript = sites.filter((w) => w.verification === "VERIFIED" && w.installation === "NOT_INSTALLED");
  const steps: Array<{ label: string; done: boolean; href: string }> = [
    { label: sites.length === 1 ? "Verify your website" : sites.length === 2 ? "Verify both websites" : "Verify all websites", done: !unverified.length, href: unverified[0] ? tabHref(orgId, unverified[0].id, "settings", "ownership") : `${base}/websites` },
    { label: "Install the monitoring script", done: !noScript.length && !unverified.length, href: noScript[0] ? tabHref(orgId, noScript[0].id, "settings", "script") : unverified[0] ? tabHref(orgId, unverified[0].id, "settings", "ownership") : `${base}/websites` },
  ];
  if (prefs.data) steps.push({ label: "Turn on an alert channel", done: prefs.data.some((p) => p.enabled), href: `${base}/notifications/preferences` });
  if (members.data) steps.push({ label: "Invite a teammate", done: members.data.length > 1 || Boolean(invites.data?.some((i) => i.status === "PENDING")), href: `${base}/settings/team` });
  if (steps.every((s) => s.done)) return null;
  return (
    <Card className="border-transparent bg-primary-soft/60 px-5 py-4">
      <h2 className="text-[15px] font-semibold tracking-tight text-primary">Get more from monitoring</h2>
      <ul className="mt-2.5 grid gap-2 text-sm">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2.5">
            {s.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Circle className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
            {s.done ? <span className="text-muted-foreground">{s.label}<span className="sr-only"> (done)</span></span> : <Link href={s.href} className="hover:underline">{s.label}</Link>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Fleet health distribution, check totals and plan usage (the former hero and metric cards). */
function MonitoringSummary({ d, base }: { d: MonitoringOverviewDto; base: string }) {
  const { orgId } = useOrg();
  const usage = useUsage(orgId);
  const counts = FLEET.map((f) => ({ ...f, n: d.websites.filter((w) => w.health === f.key).length })).filter((f) => f.n > 0);
  const other = d.websites.length - counts.reduce((a, c) => a + c.n, 0);
  const checks = d.totals.httpChecks;
  const total = checks.passed + checks.failed + checks.inconclusive;
  const down = d.websites.filter((w) => w.health === "DOWN").length;
  const rows: Array<[string, React.ReactNode, React.ReactNode?]> = [
    ["HTTP check success", fmtPct(checks.successRatePercent, 1), total ? `${checks.passed} of ${total} checks` : "No checks in range"],
    ["Failed checks", <span key="f" className={cn(checks.failed > 0 && "text-danger-text")}>{checks.failed}</span>, `${checks.inconclusive} inconclusive (not outages)`],
    ["Down now", <span key="d" className={cn(down > 0 && "text-danger-text")}>{down}</span>, "Confirmed outages right now"],
    ["Resolved incidents", d.totals.resolvedIncidentsInRange, <Link key="h" href={`${base}/history`} className="hover:text-foreground hover:underline">In this range · history</Link>],
    ["Websites", <Link key="w" href={`${base}/websites`} className="hover:text-primary">{d.totals.websites}</Link>, `${d.totals.monitored} monitored`],
    ["Plan usage", usage.data ? <Link key="u" href={`${base}/usage`} className="hover:text-primary">{usage.data.websites.total} / {usage.data.limits.maxWebsites}</Link> : "—", "Websites in your plan"],
  ];
  return (
    <Card className="px-5 py-4">
      <h2 className="text-[15px] font-semibold tracking-tight">Monitoring in this range</h2>
      <div className="mt-3">
        <div className="mb-1.5 flex justify-between text-xs text-muted-foreground"><span>{plural(d.websites.length, "website")} by health</span><span>{d.totals.monitored} monitored</span></div>
        <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={counts.map((c) => `${c.n} ${c.label}`).join(", ") || "No websites"}>
          {counts.map((c) => <span key={c.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", c.bar)} style={{ width: `${(c.n / d.websites.length) * 100}%` }} />)}
          {other > 0 && <span className="h-full bg-border-strong" style={{ width: `${(other / d.websites.length) * 100}%` }} />}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {counts.map((c) => <li key={c.key} className="inline-flex items-center gap-1.5"><span aria-hidden className={cn("h-2 w-2 rounded-full", c.bar)} /><span className="font-medium tabular-nums">{c.n}</span><span className="text-muted-foreground">{c.label}</span></li>)}
        </ul>
      </div>
      <dl className="mt-3 divide-y divide-border text-sm">
        {rows.map(([k, v, sub]) => (
          <div key={k} data-metric={k} className="flex items-baseline justify-between gap-3 py-2">
            <dt className="min-w-0"><span className="block">{k}</span>{sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}</dt>
            <dd data-metric-value className="shrink-0 font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function PlanCoverage({ d }: { d: MonitoringOverviewDto }) {
  const tiers = [
    { name: "HTTP availability", icon: Globe, e: d.entitlements.HTTP },
    { name: "Synthetic browser checks", icon: MonitorSmartphone, e: d.entitlements.BROWSER },
    { name: "Deep scans", icon: ScanSearch, e: d.entitlements.DEEPSCAN },
  ];
  return (
    <Section title="Monitoring in your plan" description="Enabled by the platform and your plan; you can only lower limits." icon={<Gauge />}>
      <ul className="grid gap-2.5 lg:grid-cols-3">
        {tiers.map(({ name, icon: Icon, e }) => (
          <li key={name} className="flex min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2.5">
            <span aria-hidden className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", e.available ? "bg-primary-soft text-primary" : "bg-muted text-subtle-foreground")}><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">{e.available ? `Checks every ${Math.round(e.minIntervalSec / 60) || 1} min or slower` : e.reason}</p>
            </div>
            <StatusPill tone={e.available ? "success" : "neutral"}>{e.available ? "Included" : "Unavailable"}</StatusPill>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Today() {
  const [s, setS] = useState(""); // client only: the server doesn't know the viewer's day
  useEffect(() => setS(new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })), []);
  return <>{s}</>;
}

export default function OverviewPage() {
  const { data: org, orgId, can } = useOrg();
  const [range, setRange] = useState(() => presetRange("24h"));
  const q = useOverview(orgId, range);
  const sites = useWebsites(orgId);
  const d = q.data;
  const base = `/o/${orgId}`;
  const ws = d?.websites ?? [];
  const verifiedIds = ws.filter((w) => w.verification === "VERIFIED").map((w) => w.id);
  const problems = useOrgProblems(orgId, verifiedIds);
  const avail = useAvailability30dMany(orgId, verifiedIds);
  const pages = usePagesTotalMany(orgId, verifiedIds);
  const rows: Row[] = ws.map((m) => {
    const open = problems.byWebsite.get(m.id)?.list ?? [];
    const a = avail[verifiedIds.indexOf(m.id)];
    const site = { status: m.websiteStatus, verification: m.verification, displayHost: m.displayHost };
    const health = websiteHealth(site, m, open);
    const hasChecks = (a?.data?.checks.total ?? 0) > 0;
    return { m, health, open, avail: a, loading: problems.byWebsite.get(m.id)?.isLoading ?? false, sentence: healthSentence(health, site, open, cleanDays(a?.data), hasChecks) };
  });
  const h = headline(rows, org?.name, problems.isLoading);

  // Summary strip: only metrics that exist in real data.
  const stats: Stat[] = [];
  if (d && ws.length) {
    const measured = ws.reduce((a, w) => a + w.http.uptime.measuredChecks, 0);
    const up = ws.reduce((a, w) => a + w.http.uptime.upChecks, 0);
    const pct = measured ? (up / measured) * 100 : null;
    stats.push({ label: `Uptime · ${RANGE_LABEL[range.key]}`, value: fmtPct(pct, 2), sub: measured ? `across ${plural(ws.filter((w) => w.http.uptime.measuredChecks > 0).length, "website")}` : "No checks in this range", tone: pct == null ? undefined : pct >= 99.5 ? "success" : pct >= 95 ? "warning" : "danger" });
    if (!problems.isLoading) {
      const open = rows.reduce((a, r) => a + r.open.length, 0);
      const need = rows.reduce((a, r) => a + r.open.filter(isSerious).length, 0);
      stats.push({ label: "Open issues", value: open, sub: open ? `${need} need${need === 1 ? "s" : ""} action` : "Nothing open", tone: need ? "warning" : undefined });
    }
    const slow = ws.filter((w) => w.performance?.lcpP75 != null).sort((a, b) => b.performance!.lcpP75! - a.performance!.lcpP75!)[0];
    if (slow) stats.push({ label: "Slowest page", value: fmtSec(slow.performance!.lcpP75!), sub: `${slow.displayHost} · main content (p75)`, tone: slow.performance!.status === "POOR" ? "danger" : slow.performance!.status === "NEEDS_IMPROVEMENT" ? "warning" : undefined });
    const totals = pages.map((p) => p.data?.summary.total).filter((n): n is number => typeof n === "number");
    if (totals.length && totals.length === pages.length) stats.push({ label: "Pages watched", value: totals.reduce((a, n) => a + n, 0).toLocaleString("en"), sub: "pages found by scans and checks" });
  }

  return (
    <>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid min-w-0 gap-1.5">
          <p className="text-[13px] text-muted-foreground"><Today /><span className="hidden sm:inline">{org ? <> · Monitoring overview · your role: {org.myRole.name}</> : null}</span></p>
          <h1 className="text-balance break-words text-[24px] font-medium leading-[1.2] tracking-[-0.022em] sm:text-[30px]">{d ? h.title : org?.name ?? "Home"}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          {can("website:write") && <Link href={`${base}/websites/new`} className={buttonVariants({ size: "sm" })}><Plus /> Add website</Link>}
        </div>
      </header>
      <QueryState q={q} skeleton="h-[28rem]">
        {d && !d.websites.length ? (
          <EmptyState icon={<Globe />} title="No websites yet"
            description="Add a website and verify that you own it. HTTP availability monitoring starts automatically once it is verified."
            action={can("website:write") ? <Link href={`${base}/websites/new`} className={buttonVariants()}><Plus /> Add website</Link> : undefined} />
        ) : d && (
          <div className="grid gap-7">
            <StatStrip items={stats} />
            <WebsitesList rows={rows} base={base} orgId={orgId} />
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid min-w-0 content-start gap-6">
                <RecentChanges d={d} base={base} />
                <ActiveIncidents orgId={orgId} base={base} />
              </div>
              <div className="grid min-w-0 content-start gap-4">
                {sites.data && <SetupChecklist orgId={orgId} base={base} sites={sites.data} />}
                <MonitoringSummary d={d} base={base} />
              </div>
            </div>
            <PlanCoverage d={d} />
            <Hint>Statuses distinguish outages (your website), inconclusive checks (our monitoring infrastructure), disabled monitoring and insufficient coverage. Uptime is computed from measured checks only; coverage shows how many scheduled checks produced a result. Range: {fmtTime(d.range.from)} – {fmtTime(d.range.to)}.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
