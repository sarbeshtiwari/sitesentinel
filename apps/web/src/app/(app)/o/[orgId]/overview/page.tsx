"use client";
import type { MonitoringOverviewDto, WebsiteHealthDto } from "@wim/contracts";
import {
  Badge, buttonVariants, Card, cn, EmptyState, MetricCard, PageHeader, Table, TBody, TD, TH, THead, TR,
} from "@wim/ui";
import {
  Activity, ArrowRight, CheckCircle2, Gauge, Globe, MonitorSmartphone, Plus, ScanSearch, ShieldAlert, Siren, TrendingDown,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PerfBadge } from "../websites/[websiteId]/performance-tab";
import { Dot, HealthBadge, Hint, QueryState, RangePicker, Section } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import {
  fmtPct, fmtUtc, INCIDENT_STATUS, presetRange, SCAN_STATUS, SEVERITY_TONE, SOURCE_LABEL, useIncidents, useOverview, useUsage,
} from "@/lib/monitoring";

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

function fleetVerdict(d: MonitoringOverviewDto) {
  const by = (k: string) => d.websites.filter((w) => w.health === k).length;
  if (by("DOWN")) return { tone: "danger" as const, title: `${by("DOWN")} website${by("DOWN") > 1 ? "s are" : " is"} down`, text: "Confirmed outages from our monitoring network. Open incidents have the details." };
  if (by("DEGRADED") || d.totals.activeIncidents) return { tone: "warning" as const, title: "Some checks need attention", text: `${d.totals.activeIncidents} active incident${d.totals.activeIncidents === 1 ? "" : "s"} across your websites.` };
  if (d.totals.monitored === 0) return { tone: "neutral" as const, title: "Monitoring hasn't started yet", text: "Verify ownership of a website to start HTTP availability checks. Browser monitoring and deep scans depend on your plan." };
  if (by("HEALTHY") === d.totals.monitored) return { tone: "success" as const, title: "All monitored websites are healthy", text: "Every active check passes with enough coverage in this range." };
  return { tone: "neutral" as const, title: "No confirmed problems", text: "Some websites don't have enough reliable data yet — that is not reported as healthy." };
}

function FleetHero({ d, base }: { d: MonitoringOverviewDto; base: string }) {
  const v = fleetVerdict(d);
  const counts = FLEET.map((f) => ({ ...f, n: d.websites.filter((w) => w.health === f.key).length })).filter((f) => f.n > 0);
  const other = d.websites.length - counts.reduce((a, c) => a + c.n, 0);
  const ring = { danger: "text-danger bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]", warning: "text-warning bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]", success: "text-success bg-[color-mix(in_srgb,var(--success)_11%,transparent)]", neutral: "text-muted-foreground bg-muted" }[v.tone];
  const Icon = v.tone === "success" ? CheckCircle2 : v.tone === "neutral" ? Activity : ShieldAlert;
  const checks = d.totals.httpChecks;
  const totalChecks = checks.passed + checks.failed + checks.inconclusive;
  return (
    <Card className="overflow-hidden">
      <div className="grid">
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <span aria-hidden className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", ring)}><Icon className="h-[22px] w-[22px]" /></span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Current status</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">{v.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{v.text}</p>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground lg:max-w-2xl">
              <span>{d.websites.length} website{d.websites.length === 1 ? "" : "s"} by health</span>
              <span>{d.totals.monitored} monitored</span>
            </div>
            <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted lg:max-w-2xl" role="img" aria-label={counts.map((c) => `${c.n} ${c.label}`).join(", ") || "No websites"}>
              {counts.map((c) => <span key={c.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", c.bar)} style={{ width: `${(c.n / d.websites.length) * 100}%` }} />)}
              {other > 0 && <span className="h-full bg-border-strong" style={{ width: `${(other / d.websites.length) * 100}%` }} />}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              {counts.map((c) => (
                <li key={c.key} className="inline-flex items-center gap-1.5"><span aria-hidden className={cn("h-2 w-2 rounded-full", c.bar)} /><span className="font-medium tabular-nums">{c.n}</span><span className="text-muted-foreground">{c.label}</span></li>
              ))}
            </ul>
          </div>
        </div>
        <div className="grid grid-cols-3 border-t border-border bg-sunken/50">
          <HeroStat label="HTTP check success" value={fmtPct(checks.successRatePercent, 1)} sub={totalChecks ? `${checks.passed} of ${totalChecks} checks` : "No checks in range"} />
          <HeroStat label="Failed checks" value={String(checks.failed)} sub={`${checks.inconclusive} inconclusive (not outages)`} tone={checks.failed ? "danger" : undefined} />
          <HeroStat label="Resolved incidents" value={String(d.totals.resolvedIncidentsInRange)} sub={<Link href={`${base}/history`} className="hover:text-foreground">In this range · history</Link>} />
        </div>
      </div>
    </Card>
  );
}

function HeroStat({ label, value, sub, tone }: { label: string; value: string; sub: React.ReactNode; tone?: "danger" }) {
  return (
    <div className="min-w-0 border-r border-border px-3 py-3.5 last:border-r-0 sm:px-6 sm:py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl", tone === "danger" && "text-danger")}>{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground sm:text-xs">{sub}</p>
    </div>
  );
}

function ActiveIncidents({ orgId, base }: { orgId: string; base: string }) {
  const q = useIncidents(orgId, { status: "ACTIVE" }, 5);
  const items = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Section title="Active incidents" icon={<Siren />} flush actions={<Link href={`${base}/incidents`} className={buttonVariants({ variant: "ghost", size: "sm" })}>View all <ArrowRight /></Link>}>
      <QueryState q={q} skeleton="h-40 m-4">
        {!items.length ? (
          <div className="flex items-center gap-3 px-5 py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden /> No active incidents.
          </div>
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
                      <span className="block truncate text-xs text-muted-foreground">
                        #{i.number} · {i.websiteName ?? "Website"}{i.source ? ` · ${SOURCE_LABEL[i.source] ?? i.source}` : ""} · since {fmtUtc(i.firstDetectedAt)}
                      </span>
                    </span>
                    <Badge tone={st.tone}>{st.label}</Badge>
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

function WebsiteRowMeta({ w }: { w: WebsiteHealthDto }) {
  return w.reasons.length > 0 ? <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{w.reasons[0]}</p> : null;
}

function WebsitesHealth({ d, base }: { d: MonitoringOverviewDto; base: string }) {
  return (
    <Section title="Websites" description="Health across availability, synthetic browser checks, performance and deep scans." icon={<Globe />} flush
      actions={<Link href={`${base}/websites`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Manage <ArrowRight /></Link>}>
      {/* Cards on small screens */}
      <ul className="divide-y divide-border md:hidden">
        {d.websites.map((w) => (
          <li key={w.id}>
            <Link href={`${base}/websites/${w.id}`} className="block px-4 py-3 hover:bg-sunken/70">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="truncate font-medium">{w.name}</p><p className="truncate text-xs text-muted-foreground">{w.displayHost}</p></div>
                <HealthBadge state={w.health} />
              </div>
              <dl className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-muted-foreground">Uptime</dt><dd className="font-medium tabular-nums">{fmtPct(w.http.uptime.uptimePercent)}</dd></div>
                <div><dt className="text-muted-foreground">Coverage</dt><dd className="font-medium tabular-nums">{fmtPct(w.http.uptime.coveragePercent, 1)}</dd></div>
                <div><dt className="text-muted-foreground">Incidents</dt><dd className={cn("font-medium tabular-nums", w.activeIncidents && "text-danger")}>{w.activeIncidents}</dd></div>
              </dl>
            </Link>
          </li>
        ))}
      </ul>
      {/* Table from md up */}
      <div className="hidden md:block">
        <Table>
          <THead><TR>
            <TH>Website</TH><TH>Status</TH><TH className="text-right">Uptime</TH><TH className="hidden text-right lg:table-cell">Coverage</TH>
            <TH className="hidden xl:table-cell">Browser</TH><TH className="hidden lg:table-cell">Performance</TH><TH className="hidden xl:table-cell">Deep scan</TH><TH className="text-right">Incidents</TH>
          </TR></THead>
          <TBody>
            {d.websites.map((w) => (
              <TR key={w.id}>
                <TD className="max-w-72">
                  <Link href={`${base}/websites/${w.id}`} className="font-medium hover:text-primary">{w.name}</Link>
                  <div className="truncate text-xs text-muted-foreground">{w.displayHost}{w.http.lastCheckAt ? ` · checked ${fmtUtc(w.http.lastCheckAt)}` : ""}</div>
                  <WebsiteRowMeta w={w} />
                </TD>
                <TD><HealthBadge state={w.health} /></TD>
                <TD className="text-right tabular-nums">{fmtPct(w.http.uptime.uptimePercent)}<div className="text-xs text-muted-foreground">{w.http.uptime.measuredChecks} checks</div></TD>
                <TD className="hidden text-right tabular-nums lg:table-cell">{fmtPct(w.http.uptime.coveragePercent, 1)}</TD>
                <TD className="hidden xl:table-cell"><HealthBadge state={w.browser.state} /></TD>
                <TD className="hidden lg:table-cell">
                  {w.performance ? <Link href={`${base}/websites/${w.id}?tab=performance`}><PerfBadge s={w.performance.status} /></Link> : <span className="text-xs text-muted-foreground">—</span>}
                  {w.performance?.regressions.length ? <div className="mt-0.5 text-xs text-danger">{w.performance.regressions.length} regression{w.performance.regressions.length > 1 ? "s" : ""}</div> : null}
                </TD>
                <TD className="hidden xl:table-cell">
                  {w.deepScan.lastStatus
                    ? <span className="text-xs">{SCAN_STATUS[w.deepScan.lastStatus]?.label ?? w.deepScan.lastStatus}{w.deepScan.openFindings ? <span className="text-muted-foreground"> · {w.deepScan.openFindings} findings</span> : ""}</span>
                    : <HealthBadge state={w.deepScan.state} />}
                </TD>
                <TD className="text-right tabular-nums">
                  {w.activeIncidents ? <Link className="font-medium text-danger hover:underline" href={`${base}/incidents?websiteId=${w.id}`}>{w.activeIncidents} open</Link> : <span className="text-muted-foreground">0</span>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Section>
  );
}

function RecentChanges({ d, base }: { d: MonitoringOverviewDto; base: string }) {
  return (
    <Section title="Recent changes" description="Component changes and synthetic performance regressions vs. the previous period." icon={<TrendingDown />}>
      {!d.recentChanges.length ? <p className="text-sm text-muted-foreground">Nothing changed in this range.</p> : (
        <ol className="relative grid gap-4 border-l border-border pl-5">
          {d.recentChanges.map((c, i) => (
            <li key={i} className="relative">
              <span aria-hidden className={cn("absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card", c.kind === "PERFORMANCE_REGRESSION" ? "bg-danger" : "bg-warning")} />
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={c.kind === "PERFORMANCE_REGRESSION" ? "danger" : "warning"}>{c.kind === "PERFORMANCE_REGRESSION" ? "Regression" : "Component"}</Badge>
                <span className="text-xs text-muted-foreground">{fmtUtc(c.at)}</span>
              </div>
              <Link className="mt-1 block text-sm hover:text-primary" href={`${base}${c.link}`}><span className="font-medium">{c.websiteName}</span>: {c.title}</Link>
            </li>
          ))}
        </ol>
      )}
    </Section>
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
          <li key={name} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
            <span aria-hidden className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", e.available ? "bg-primary-soft text-primary" : "bg-muted text-subtle-foreground")}><Icon className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{name}</p>
              <p className="truncate text-xs text-muted-foreground">{e.available ? `Checks every ${Math.round(e.minIntervalSec / 60) || 1} min or slower` : e.reason}</p>
            </div>
            <Badge tone={e.available ? "success" : "neutral"}>{e.available ? "Included" : "Unavailable"}</Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function OverviewPage() {
  const { data: org, orgId, can } = useOrg();
  const [range, setRange] = useState(() => presetRange("24h"));
  const q = useOverview(orgId, range);
  const usage = useUsage(orgId);
  const d = q.data;
  const base = `/o/${orgId}`;
  const down = d ? d.websites.filter((w) => w.health === "DOWN").length : 0;

  return (
    <>
      <PageHeader
        eyebrow={org ? <>Monitoring overview · your role: {org.myRole.name}</> : undefined}
        title={org?.name ?? "Overview"}
        actions={<>
          <RangePicker value={range} onChange={setRange} />
          {can("website:write") && <Link href={`${base}/websites/new`} className={buttonVariants({ size: "sm" })}><Plus /> Add website</Link>}
        </>}
      />
      <QueryState q={q} skeleton="h-[28rem]">
        {d && !d.websites.length ? (
          <EmptyState icon={<Globe />} title="No websites yet"
            description="Add a website and verify that you own it. HTTP availability monitoring starts automatically once it is verified."
            action={can("website:write") ? <Link href={`${base}/websites/new`} className={buttonVariants()}><Plus /> Add website</Link> : undefined} />
        ) : d && (
          <div className="grid gap-5">
            <FleetHero d={d} base={base} />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard label="Websites" value={d.totals.websites} icon={<Globe />} tone="brand" hint={`${d.totals.monitored} monitored`} href={`${base}/websites`} LinkComponent={Link} />
              <MetricCard label="Active incidents" value={d.totals.activeIncidents} icon={<Siren />} tone={d.totals.activeIncidents ? "danger" : "success"} hint={d.totals.activeIncidents ? "Needs attention" : "Nothing open"} href={`${base}/incidents`} LinkComponent={Link} />
              <MetricCard label="Down now" value={down} icon={<ShieldAlert />} tone={down ? "danger" : "neutral"} hint="Confirmed outages right now" />
              <MetricCard label="Plan usage" value={usage.data ? <>{usage.data.websites.total}<span className="text-base font-medium text-muted-foreground"> / {usage.data.limits.maxWebsites}</span></> : "—"} icon={<Gauge />} tone="info" hint="Websites in your plan" href={`${base}/usage`} LinkComponent={Link} />
            </div>
            <WebsitesHealth d={d} base={base} />
            <div className="grid gap-5 xl:grid-cols-2">
              <ActiveIncidents orgId={orgId} base={base} />
              <RecentChanges d={d} base={base} />
            </div>
            <PlanCoverage d={d} />
            <Hint>Statuses distinguish outages (your website), inconclusive checks (our monitoring infrastructure), disabled monitoring and insufficient coverage. Uptime is computed from measured checks only; coverage shows how many scheduled checks produced a result. Range: {fmtUtc(d.range.from)} – {fmtUtc(d.range.to)}.</Hint>
          </div>
        )}
      </QueryState>
    </>
  );
}
