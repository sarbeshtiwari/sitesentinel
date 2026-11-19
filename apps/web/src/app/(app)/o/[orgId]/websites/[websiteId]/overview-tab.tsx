"use client";
import { Alert, Button, buttonVariants, Card, cn, Skeleton, StatusPill, Stepper, toast, type BadgeTone } from "@wim/ui";
import {
  Accessibility, Activity, ArrowRight, Code2, FileX2, Gauge, Gift, Globe, LayoutTemplate, ListChecks, Lock, MonitorSmartphone, MousePointerClick,
  ScanSearch, Search, ShieldCheck, Siren, Smartphone, Unlink, Wrench, type LucideIcon,
} from "lucide-react";
import type { DataEnvelope, HttpAnalyticsDto, WebsiteDetailDto, WebsiteHealthDto } from "@wim/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import { KeyValue, QueryState, Section } from "@/components/monitoring";
import { fmtMs, fmtPct, fmtTime, health as healthOf, localDay, mk, outcome, useBrowserSummary, useHistory, useHttpSummary } from "@/lib/monitoring";
import { errorMessage, get, post } from "@/lib/api";
import { categoryLabel, fmt, fmtDate, INSTALL_STATE, relative, TRIAL_OUTCOME, VERIFICATION_STATE, wk } from "@/lib/websites";
import { AREA_LABEL, tabHref, useDeepSummary, type Area, type HealthKey, type Problem, type Tab, type useWebsiteProblems } from "./website-data";

type Nav = (t: Tab, section?: string | null) => void;
const AREA_ICON: Record<Area, LucideIcon> = {
  availability: Activity, certificate: Lock, speed: Gauge, broken: Unlink, sitemap: FileX2, seo: Search, accessibility: Accessibility,
  forms: ListChecks, layout: LayoutTemplate, behaviour: MousePointerClick,
};
const AREA_TONE: Record<string, string> = { CRITICAL: "bg-danger-soft text-danger-text", HIGH: "bg-danger-soft text-danger-text", MEDIUM: "bg-warning-soft text-warning-text" };

export function OverviewTab({ w, orgId, canWrite, health, problems, m, avail, onNavigate }: {
  w: WebsiteDetailDto; orgId: string; canWrite: boolean; health: HealthKey; problems: ReturnType<typeof useWebsiteProblems>;
  m: WebsiteHealthDto | undefined; avail: UseQueryResult<HttpAnalyticsDto>; onNavigate: Nav;
}) {
  const qc = useQueryClient();
  const contest = async () => {
    try {
      await post(`/orgs/${orgId}/domain-transfers/incoming/${w.pendingTransfer!.id}/contest`);
      await qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) });
      toast.success("Transfer contested. A platform administrator will review it.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const verified = w.verification === "VERIFIED";
  const hasChecks = (avail.data?.checks.total ?? 0) > 0;
  const setup = health !== "PAUSED" && !["LAPSED", "PAUSED", "SUSPENDED"].includes(w.status) && (!verified || w.installation === "NOT_INSTALLED" || (!avail.isLoading && !hasChecks));
  return (
    <div className="grid gap-6">
      {w.pendingTransfer && (
        <Alert tone="warning" title="Another organization requested ownership of this domain">
          <p>They proved DNS control of {w.displayHost}. A platform administrator will review the request
            {w.pendingTransfer.ownerRespondBy ? `; respond before ${fmt(w.pendingTransfer.ownerRespondBy)}` : ""}. Your data is never shared.</p>
          {w.pendingTransfer.ownerResponse === "CONTESTED" ? <p className="mt-1 font-medium">You have contested this request.</p>
            : canWrite && <Button className="mt-2" size="sm" variant="outline" onClick={contest}>Contest the transfer</Button>}
        </Alert>
      )}
      {w.status === "LAPSED" && (
        <Alert tone="danger" title="Monitoring paused: ownership verification lapsed">
          <p>Restore verification to resume monitoring.</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => onNavigate("settings", "ownership")}><ShieldCheck /> Restore verification</Button>
        </Alert>
      )}
      {setup && <SetupChecklist w={w} hasChecks={hasChecks} onNavigate={onNavigate} />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 content-start gap-6">
          <NeedsYou orgId={orgId} websiteId={w.id} problems={problems} verified={verified} hasChecks={hasChecks} />
          <AvailabilityStrip q={avail} verified={verified} onNavigate={onNavigate} />
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <RightNow w={w} orgId={orgId} m={m} health={health} onNavigate={onNavigate} />
          <RecentActivity orgId={orgId} websiteId={w.id} />
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-3">
        <Section title="About this website" icon={<Globe />} className="xl:col-span-2">
          <KeyValue items={[
            ["Domain", <>{w.displayHost}{w.displayHost !== w.hostKey && <span className="text-muted-foreground"> ({w.hostKey})</span>}</>],
            ["Registrable domain", w.registrableDomain],
            ["Category", categoryLabel(w.category)],
            ["Verification", <>{VERIFICATION_STATE[w.verification]?.label ?? w.verification}{w.claim.verifiedMethod ? ` (${w.claim.verifiedMethod.replace("_", " ").toLowerCase()})` : ""}</>],
            ["Verified at", fmt(w.verifiedAt)],
            ["SDK installation", INSTALL_STATE[w.installation].label],
            ["Monitoring timezone", w.monitoringTimezone],
            ["Created", fmtDate(w.createdAt)],
            ["Description", w.description || "—"],
          ]} />
        </Section>
        <Section title="Free trial" icon={<Gift />}>
          <div className="grid gap-2 text-sm">
            {w.trialOutcome ? <p>{TRIAL_OUTCOME[w.trialOutcome] ?? w.trialOutcome}</p> : <p className="text-muted-foreground">The trial is evaluated when the website&apos;s ownership is first verified.</p>}
            {w.orgTrial && <p className="text-muted-foreground">Organization trial: {w.orgTrial.status.toLowerCase()}, {fmtDate(w.orgTrial.startsAt)} – {fmtDate(w.orgTrial.endsAt)} (started by {w.orgTrial.registrableDomain}).</p>}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Verify → install the script → first checks, instead of empty dashes on a new website. */
function SetupChecklist({ w, hasChecks, onNavigate }: { w: WebsiteDetailDto; hasChecks: boolean; onNavigate: Nav }) {
  const verified = w.verification === "VERIFIED";
  const installed = w.installation !== "NOT_INSTALLED";
  const current = !verified ? 0 : !installed ? 1 : !hasChecks ? 2 : 3;
  return (
    <Card className="grid gap-4 px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">Finish setting up {w.displayHost}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Monitoring starts once ownership is verified. The monitoring script adds real-visitor data and is optional for uptime checks.</p>
      </div>
      <Stepper steps={["Verify ownership", "Install monitoring script", "First checks"]} current={current} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {!verified && <><Button size="sm" onClick={() => onNavigate("settings", "ownership")}><ShieldCheck /> Go to verification</Button><span className="text-muted-foreground">Verify that you control {w.displayHost} to activate the website.</span></>}
        {verified && !installed && <><Button size="sm" variant="outline" onClick={() => onNavigate("settings", "script")}><Code2 /> Get the installation snippet</Button><span className="text-muted-foreground">Add the snippet to your pages to start collecting browser telemetry.</span></>}
        {verified && installed && !hasChecks && <span className="text-muted-foreground">Waiting for the first scheduled checks — results appear here on their own. <button type="button" className="text-primary hover:underline" onClick={() => onNavigate("settings", "monitoring")}>Monitoring settings</button></span>}
      </div>
    </Card>
  );
}

function NeedsYou({ orgId, websiteId, problems, verified, hasChecks }: { orgId: string; websiteId: string; problems: ReturnType<typeof useWebsiteProblems>; verified: boolean; hasChecks: boolean }) {
  const top = problems.list.slice(0, 3);
  const issuesHref = tabHref(orgId, websiteId, "issues");
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold tracking-tight">What needs you</h2>
        {problems.list.length > 0 && <Link href={issuesHref} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">All {problems.list.length} issue{problems.list.length === 1 ? "" : "s"} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}
      </div>
      {problems.isLoading ? <div role="status" aria-label="Loading" className="p-5"><Skeleton className="h-24" /></div>
        : problems.incidents.isError && problems.findings.isError ? <p className="px-5 py-6 text-sm text-danger-text">Couldn&apos;t load open issues: {errorMessage(problems.error)}</p>
        : !top.length ? (
          <p className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <span aria-hidden className={cn("h-2 w-2 rounded-full", verified && hasChecks ? "bg-success" : "bg-faint")} />
            {!verified ? "Nothing to report until ownership is verified." : hasChecks ? "Nothing needs you right now: no open incidents and no open deep-scan findings." : "No checks have run yet, so there is nothing to report."}
          </p>
        ) : (
          <ul className="divide-y divide-border">{top.map((p) => <NeedItem key={p.key} p={p} orgId={orgId} websiteId={websiteId} />)}</ul>
        )}
    </Card>
  );
}

function NeedItem({ p, orgId, websiteId }: { p: Problem; orgId: string; websiteId: string }) {
  const Icon = AREA_ICON[p.area];
  const n = p.findings.length;
  const href = p.kind === "incident" ? `/o/${orgId}/incidents/${p.incident!.id}`
    : n === 1 ? `/o/${orgId}/websites/${websiteId}/deep-scan/findings/${p.findings[0]!.id}` : `${tabHref(orgId, websiteId, "issues")}&open=${encodeURIComponent(p.key)}`;
  const action = p.kind === "incident" ? "View incident" : n === 1 ? "Details" : `Show the ${n} ${p.area === "broken" || p.area === "sitemap" ? "URLs" : "pages"}`;
  const detail = p.summary ?? p.impact;
  return (
    <li className="flex gap-3.5 px-5 py-4">
      <span aria-hidden className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:h-4 [&_svg]:w-4", AREA_TONE[p.severity])}><Icon /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="font-medium leading-snug">{n > 1 ? `${p.title} (${n})` : p.title}</p>
          <Link href={href} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start")}>{action}</Link>
        </div>
        {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
        {p.fix && <p className="mt-1.5 flex items-start gap-1.5 text-sm"><Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden /><span>{p.fix}</span></p>}
        <p className="mt-1.5 text-xs text-muted-foreground">{AREA_LABEL[p.area]} · {p.severity.toLowerCase()} · since {localDay(p.since)}{p.incident ? ` · incident INC-${p.incident.number}` : ""}</p>
      </div>
    </li>
  );
}

/** 30 daily bars from the real availability analytics; days without checks are grey (a gap, not uptime). */
function AvailabilityStrip({ q, verified, onNavigate }: { q: UseQueryResult<HttpAnalyticsDto>; verified: boolean; onNavigate: Nav }) {
  const d = q.data;
  const days = (d?.series ?? []).slice(-30);
  const worst = days.reduce<{ t: string; down: number } | null>((acc, x) => (x.down > 0 && (!acc || x.down > acc.down) ? { t: x.t, down: x.down } : acc), null);
  return (
    <section aria-labelledby="avail-30">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <h2 id="avail-30" className="text-[15px] font-semibold tracking-tight">Availability · last 30 days</h2>
          <p className="text-xs text-muted-foreground">HTTP checks from our servers (synthetic). Grey = no checks that day.</p>
        </div>
        {d && d.checks.total > 0 && <p className={cn("text-2xl font-medium tabular-nums", (d.uptime.uptimePercent ?? 100) >= 99.5 ? "text-success-text" : "text-warning-text")}>{fmtPct(d.uptime.uptimePercent, 2)}</p>}
      </div>
      <QueryState q={q} skeleton="h-12">
        {!d || d.checks.total === 0 ? (
          <Card className="px-4 py-4 text-sm text-muted-foreground">
            {verified ? <>No availability checks in the last 30 days. <button type="button" className="text-primary hover:underline" onClick={() => onNavigate("settings", "monitoring")}>Check the monitoring settings</button></> : "Availability checks start once ownership is verified."}
          </Card>
        ) : (
          <>
            <ol role="img" aria-label={`Availability per day for 30 days: ${days.filter((x) => x.down > 0).length} days with failed checks, ${days.filter((x) => x.up + x.down === 0).length} days without data`} className="flex h-10 gap-[3px]">
              {days.map((x) => {
                const tone = x.down > 0 ? (x.up === 0 ? "bg-danger" : "bg-warning") : x.up > 0 ? "bg-success" : x.inconclusive > 0 ? "bg-border-strong" : "bg-muted";
                return <li key={x.t} title={`${x.t.slice(0, 10)}: ${x.up} up, ${x.down} down, ${x.inconclusive} inconclusive`} className={cn("min-w-0 flex-1 rounded-[3px]", tone)} />;
              })}
            </ol>
            <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
              <span>{days[0] ? days[0].t.slice(0, 10) : ""}</span>
              {worst && <span className="truncate text-warning-text">{worst.t.slice(0, 10)} · {worst.down} failed check{worst.down === 1 ? "" : "s"}</span>}
              <span>Today</span>
            </div>
          </>
        )}
      </QueryState>
      <button type="button" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline" onClick={() => onNavigate("performance", "availability")}>Uptime details, response times and check history <ArrowRight className="h-3.5 w-3.5" aria-hidden /></button>
    </section>
  );
}

type Row = { icon: LucideIcon; label: string; sub?: React.ReactNode; value: React.ReactNode; tone?: BadgeTone; action?: { label: string; go: () => void } };
function VitalRow({ r }: { r: Row }) {
  const Icon = r.icon;
  const dot: Record<string, string> = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", neutral: "bg-faint", info: "bg-info", brand: "bg-primary" };
  const text: Record<string, string> = { success: "text-foreground", warning: "text-warning-text", danger: "text-danger-text", neutral: "text-muted-foreground", info: "text-foreground", brand: "text-foreground" };
  return (
    <li className="flex items-start gap-3 py-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{r.label}</p>
        {r.sub && <p className="text-xs text-muted-foreground">{r.sub}</p>}
      </div>
      <div className="max-w-[55%] text-right">
        <p className={cn("inline-flex items-center gap-1.5 text-sm font-medium", text[r.tone ?? "neutral"])}><span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot[r.tone ?? "neutral"])} />{r.value}</p>
        {r.action && <button type="button" className="block w-full text-right text-xs text-primary hover:underline" onClick={r.action.go}>{r.action.label}</button>}
      </div>
    </li>
  );
}

const lcpTone = (v: number | null | undefined, t: { good: number; poor: number } | undefined): BadgeTone => (v == null || !t ? "neutral" : v <= t.good ? "success" : v > t.poor ? "danger" : "warning");
const lcpWord = (tone: BadgeTone) => (tone === "success" ? "good" : tone === "warning" ? "slow" : tone === "danger" ? "very slow" : "");

/** "Right now": each vital only from real data; otherwise an honest "not set up / no data yet" with a way to fix it. */
function RightNow({ w, orgId, m, health, onNavigate }: { w: WebsiteDetailDto; orgId: string; m: WebsiteHealthDto | undefined; health: HealthKey; onNavigate: Nav }) {
  const http = useHttpSummary(orgId, w.id);
  const browser = useBrowserSummary(orgId, w.id);
  const deep = useDeepSummary(orgId, w.id);
  const thr = useQuery({
    queryKey: [...mk.site(orgId, w.id), "perf-thresholds"],
    queryFn: ({ signal }) => get<DataEnvelope<{ effective: Record<string, { good: number; poor: number }> }>>(`/orgs/${orgId}/websites/${w.id}/performance/thresholds`, { signal }).then((r) => r.data),
    enabled: w.verification === "VERIFIED",
  });
  const verified = w.verification === "VERIFIED";
  const setUp = { label: "Set up", go: () => onNavigate("settings", "monitoring") };
  const h = http.data;
  const latest = h?.latest;
  const httpRow: Row = !verified ? { icon: Activity, label: "Availability", value: "Not set up", sub: "Starts after verification", action: { label: "Verify", go: () => onNavigate("settings", "ownership") } }
    : !h ? { icon: Activity, label: "Availability", value: http.isLoading ? "…" : "No data yet" }
    : h.state === "NOT_MONITORED" || h.state === "PAUSED" ? { icon: Activity, label: "Availability", value: healthOf(h.state).label, sub: "HTTP checks are not running", action: setUp }
    : !latest ? { icon: Activity, label: "Availability", value: "No data yet", sub: "Waiting for the first check" }
    : { icon: Activity, label: "Availability", tone: h.state === "UP" ? "success" : h.state === "DOWN" ? "danger" : h.state === "DEGRADED" ? "warning" : "neutral",
      value: `${h.state === "UP" ? "Up" : h.state === "DOWN" ? "Down" : h.state === "DEGRADED" ? "Degraded" : outcome(latest.outcome).label}${latest.timings.totalMs != null ? ` · ${fmtMs(latest.timings.totalMs)}` : ""}`,
      sub: <>Checked {relative(latest.windowStart)}{m ? <> · 24 h uptime {fmtPct(m.http.uptime.uptimePercent)} ({fmtPct(m.http.uptime.coveragePercent, 1)} coverage)</> : null}</> };

  const vps = browser.data?.latest?.viewports ?? [];
  const lcpT = thr.data?.effective.lcp;
  const loadRow = (label: string, icon: LucideIcon, match: (v: string) => boolean): Row => {
    const v = vps.find((x) => match(x.viewport));
    if (!verified) return { icon, label, value: "Not set up" };
    if (browser.data && (browser.data.state === "NOT_MONITORED" || browser.data.state === "PAUSED") && !browser.data.latest) return { icon, label, value: "Not set up", sub: "Browser checks are off", action: setUp };
    if (!v) return { icon, label, value: browser.isLoading ? "…" : "No data yet", sub: browser.data?.latest ? "Not checked at this size in the latest run" : "Waiting for a browser check", action: browser.data?.latest ? { label: "Screen sizes", go: () => onNavigate("settings", "monitoring") } : undefined };
    const lcp = v.syntheticPerformance?.lcpMs;
    const tone = v.outcome === "FAILED" ? "danger" : lcpTone(lcp, lcpT);
    return { icon, label, tone, value: v.outcome === "FAILED" ? "Failed" : `${fmtMs(lcp)}${lcpWord(tone) ? ` · ${lcpWord(tone)}` : ""}`,
      sub: <>Main content appears{lcpT ? ` · target under ${fmtMs(lcpT.good)}` : ""} · <Link className="hover:text-primary" href={`/o/${orgId}/websites/${w.id}/browser/${browser.data!.latest!.executionId}`}>{relative(browser.data!.latest!.windowStart)}</Link></> };
  };

  const ds = deep.data;
  const scan = ds?.latestScan;
  const broken = (ds?.openFindings.filter((x) => x.group === "broken_pages").reduce((a, b) => a + b.count, 0) ?? 0) + (ds?.openSitemapBroken ?? 0);
  const deepRow: Row = !verified ? { icon: ScanSearch, label: "Deep scan", value: "Not set up" }
    : !ds ? { icon: ScanSearch, label: "Deep scan", value: deep.isLoading ? "…" : "No data yet" }
    : !ds.entitled && !scan ? { icon: ScanSearch, label: "Deep scan", value: "Not in your plan" }
    : !scan ? { icon: ScanSearch, label: "Deep scan", value: "No scan yet", sub: ds.nextRunAt ? `Next ${fmtTime(ds.nextRunAt)}` : "Not scheduled yet", action: { label: "Start a scan", go: () => onNavigate("issues", "deep-scan") } }
    : { icon: ScanSearch, label: "Deep scan", tone: scan.status === "RUNNING" ? "info" : broken ? "warning" : "success",
      value: scan.status === "RUNNING" ? "Running…" : `${scan.coverage.pagesDiscovered} pages · ${broken} broken`,
      sub: <Link className="hover:text-primary" href={`/o/${orgId}/websites/${w.id}/deep-scan/scans/${scan.executionId}`}>{fmtTime(scan.startedAt)}{ds.nextRunAt ? ` · next ${fmtTime(ds.nextRunAt)}` : ""}</Link> };

  const ssl = h?.ssl;
  const certRow: Row = !ssl || (ssl.valid == null && ssl.daysRemaining == null)
    ? { icon: Lock, label: "Certificate", value: verified ? "No data yet" : "Not set up", sub: verified ? "Read by the HTTPS availability check" : undefined }
    : { icon: Lock, label: "Certificate", tone: ssl.valid === false ? "danger" : (ssl.daysRemaining ?? 99) < 14 ? "warning" : "success",
      value: ssl.valid === false ? "Not trusted" : `Valid · ${ssl.daysRemaining} days left`, sub: ssl.issuer ? `Issued by ${ssl.issuer}` : undefined };

  const i = w.install;
  const scriptTone: BadgeTone = w.installation === "ACTIVE" ? "success" : w.installation === "INVALID_CONFIGURATION" ? "danger" : w.installation === "INACTIVE" ? "warning" : "neutral";
  const scriptRow: Row = { icon: Code2, label: "Monitoring script", tone: scriptTone,
    value: w.installation === "NOT_INSTALLED" ? "Not installed" : `${INSTALL_STATE[w.installation].label}${i.pageLoads ? ` · ${i.pageLoads} page loads` : ""}`,
    sub: i.lastSeenAt ? `Last heartbeat ${relative(i.lastSeenAt)}` : w.installation === "NOT_INSTALLED" ? "Optional: adds real-visitor data" : undefined,
    action: w.installation === "NOT_INSTALLED" || w.installation === "INVALID_CONFIGURATION" ? { label: "Install", go: () => onNavigate("settings", "script") } : undefined };

  return (
    <section aria-labelledby="right-now">
      <div className="flex items-center justify-between gap-2">
        <h2 id="right-now" className="text-[15px] font-semibold tracking-tight">Right now</h2>
        {m && m.activeIncidents > 0 && <Link href={`/o/${orgId}/incidents?websiteId=${w.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-danger-text hover:underline"><Siren className="h-3.5 w-3.5" aria-hidden />{m.activeIncidents} open incident{m.activeIncidents === 1 ? "" : "s"}</Link>}
      </div>
      {m && m.reasons.length > 0 && health !== "HEALTHY" && <p className="mt-1 text-xs text-muted-foreground">{m.reasons.join(" · ")}</p>}
      <ul className="mt-1 divide-y divide-border">
        {[httpRow, loadRow("Desktop load", MonitorSmartphone, (v) => v.startsWith("desktop")), loadRow("Mobile load", Smartphone, (v) => v.startsWith("mobile")), deepRow, certRow, scriptRow].map((r) => <VitalRow key={r.label} r={r} />)}
      </ul>
      {m && (
        <dl className="mt-2 grid gap-1 rounded-md bg-sunken px-3 py-2.5 text-xs text-muted-foreground" aria-label="Monitoring in the last 24 hours">
          <div className="flex flex-wrap items-center justify-between gap-2"><dt>HTTP checks (24 h)</dt><dd><StatusPill tone={healthOf(m.http.state).tone as BadgeTone}>{healthOf(m.http.state).label}</StatusPill></dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Last success / failure</dt><dd className="text-foreground">{fmtTime(m.http.lastSuccessAt)} / {fmtTime(m.http.lastFailureAt)}</dd></div>
          <div className="flex flex-wrap items-center justify-between gap-2"><dt>Browser checks</dt><dd><StatusPill tone={healthOf(m.browser.state).tone as BadgeTone}>{healthOf(m.browser.state).label}</StatusPill></dd></div>
          <div className="flex flex-wrap justify-between gap-2"><dt>Deep scan</dt><dd className="text-foreground">{m.deepScan.lastStatus ? `${m.deepScan.openFindings} open findings · last completed ${fmtTime(m.deepScan.lastCompletedAt)}` : healthOf(m.deepScan.state).label}</dd></div>
        </dl>
      )}
    </section>
  );
}

const RESULT_DOT: Record<string, string> = { PASSED: "bg-success", RESOLVED: "bg-success", RECOVERED: "bg-success", FAILED: "bg-danger", OPENED: "bg-warning", REOPENED: "bg-danger" };
function RecentActivity({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const q = useHistory(orgId, { websiteId });
  const events = (q.data?.pages[0]?.data ?? []).slice(0, 6);
  return (
    <section aria-labelledby="recent-activity">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recent-activity" className="text-[15px] font-semibold tracking-tight">Recent activity</h2>
        <Link href={`/o/${orgId}/history?websiteId=${websiteId}`} className="text-xs font-medium text-primary hover:underline">All history</Link>
      </div>
      <QueryState q={q} skeleton="h-32 mt-2">
        {!events.length ? <p className="mt-2 text-sm text-muted-foreground">Nothing recorded yet.</p> : (
          <ul className="mt-2 grid gap-3">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2.5">
                <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", RESULT_DOT[e.result ?? ""] ?? (e.type === "CONFIG" || e.type === "VERIFICATION" ? "bg-primary" : "bg-faint"))} />
                <div className="min-w-0">
                  {e.link ? <Link className="break-words text-sm hover:text-primary" href={`/o/${orgId}${e.link}`}>{e.title}</Link> : <p className="break-words text-sm">{e.title}</p>}
                  <p className="text-xs text-muted-foreground">{fmtTime(e.at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
