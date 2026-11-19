"use client";
import type { WebsiteSummaryDto } from "@wim/contracts";
import { buttonVariants, Card, DropdownItem, DropdownMenu, EmptyState, ErrorState, FilterChip, Input, PageHeader, Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { ArrowLeftRight, ArrowRight, Globe, MoreHorizontal, Plus, Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage } from "@/lib/api";
import { DayStrip } from "@/components/org-ui";
import { useOrg } from "@/lib/hooks";
import { fmtMs, presetRange, useOverview, useUsage } from "@/lib/monitoring";
import { INSTALL_STATE, relative, TRIAL_OUTCOME, useWebsites, VERIFICATION_STATE, fmtDate } from "@/lib/websites";
import { HEALTH_PILL, isSerious, tabHref, useAvailability30dMany, useOrgProblems, websiteHealth, type HealthKey } from "./[websiteId]/website-data";

function RowActions({ w, base, write }: { w: WebsiteSummaryDto; base: string; write: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu label={`Actions for ${w.name}`} triggerClassName={buttonVariants({ variant: "ghost", size: "icon" })} trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}`)}>Overview</DropdownItem>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=settings&section=ownership`)}>Verification</DropdownItem>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=settings&section=script`)}>Installation</DropdownItem>
      {write && <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=settings&section=general`)}>Settings</DropdownItem>}
    </DropdownMenu>
  );
}

type Filter = "ALL" | "ATTENTION" | "DOWN" | "HEALTHY" | "SETUP" | "PAUSED";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "ALL", label: "All" }, { key: "DOWN", label: "Down" }, { key: "ATTENTION", label: "Needs attention" }, { key: "HEALTHY", label: "Healthy" },
  { key: "SETUP", label: "Setting up" }, { key: "PAUSED", label: "Paused" },
];

export default function WebsitesPage() {
  const { orgId, can } = useOrg();
  const sites = useWebsites(orgId);
  const usage = useUsage(orgId);
  const [range] = useState(() => presetRange("24h")); // same 24 h overview as the website pages and the sidebar
  const overview = useOverview(orgId, range);
  const write = can("website:write");
  const base = `/o/${orgId}/websites`;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");

  const list = sites.data ?? [];
  const verifiedIds = list.filter((w) => w.verification === "VERIFIED").map((w) => w.id);
  const problems = useOrgProblems(orgId, verifiedIds);
  const avail = useAvailability30dMany(orgId, verifiedIds);
  const rows = list.map((w) => {
    const m = overview.data?.websites.find((x) => x.id === w.id);
    const open = problems.byWebsite.get(w.id);
    const a = avail[verifiedIds.indexOf(w.id)]?.data;
    return { w, m, open, a, health: websiteHealth(w, m, open?.list ?? []) as HealthKey };
  });
  const count = (f: Filter) => (f === "ALL" ? rows.length : rows.filter((r) => r.health === f).length);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === "ALL" || r.health === filter) && (!needle || r.w.name.toLowerCase().includes(needle) || r.w.displayHost.toLowerCase().includes(needle)));
  const slots = usage.data ? Math.max(0, usage.data.limits.maxWebsites - usage.data.websites.total) : null;

  const issues = (r: (typeof rows)[number]) => {
    if (r.w.verification !== "VERIFIED") return <span className="text-muted-foreground">—</span>;
    if (!r.open || r.open.isLoading) return <span className="text-muted-foreground">…</span>;
    const n = r.open.list.length;
    const serious = r.open.list.filter(isSerious).length;
    return n ? <Link href={tabHref(orgId, r.w.id, "issues")} className={serious ? "font-medium text-warning-text hover:underline" : "hover:underline"}>{n}</Link> : <span className="text-muted-foreground">0</span>;
  };
  const strip = (r: (typeof rows)[number]) => r.w.verification !== "VERIFIED"
    ? (write ? <Link href={tabHref(orgId, r.w.id, "settings", "ownership")} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">Verify ownership <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link> : <span className="text-xs text-muted-foreground">Not verified</span>)
    : r.a && r.a.checks.total > 0 ? <DayStrip a={r.a} className="h-5 w-40" /> : <span className="text-xs text-muted-foreground">No checks yet</span>;

  return (
    <>
      <PageHeader
        title="Websites"
        description={sites.data ? <>{list.length} website{list.length === 1 ? "" : "s"}{slots !== null ? ` · ${slots} of ${usage.data!.limits.maxWebsites} slots free on your plan` : ""}. Register websites, prove ownership and install the monitoring script.</> : "Register websites, prove ownership and install the monitoring script."}
        actions={<>
          <Link href={`${base}/transfers`} className={buttonVariants({ variant: "outline", size: "sm" })}><ArrowLeftRight /> Transfers</Link>
          {write && <Link href={`${base}/new`} className={buttonVariants({ size: "sm" })}><Plus /> Add website</Link>}
        </>}
      />
      {sites.isLoading ? <div role="status" aria-label="Loading"><Skeleton className="h-64" /></div> : sites.isError ? <ErrorState title="Couldn't load websites" description={errorMessage(sites.error)} onRetry={() => void sites.refetch()} /> : !list.length ? (
        <EmptyState
          icon={<Globe />}
          title="No websites yet"
          description="Add a website, verify that you own its domain, then install the monitoring script. Monitoring checks start in a later release."
          action={write ? <Link href={`${base}/new`} className={buttonVariants()}><Plus className="h-4 w-4" /> Add website</Link> : undefined}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" aria-label="Search websites" placeholder="Search websites" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-9" />
            </div>
            <div role="group" aria-label="Filter by health" className="flex flex-wrap gap-1.5">
              {FILTERS.filter((f) => f.key === "ALL" || f.key === filter || count(f.key) > 0).map((f) => (
                <FilterChip key={f.key} selected={filter === f.key} count={f.key === "ALL" ? undefined : count(f.key)} onClick={() => setFilter(f.key)}>{f.label}</FilterChip>
              ))}
            </div>
          </div>
          {!shown.length ? (
            <EmptyState icon={<SearchX />} title="No websites match" description="Try another search or health filter." />
          ) : (
            <Card className="overflow-hidden">
              {/* Cards on small screens */}
              <ul className="divide-y divide-border md:hidden">
                {shown.map((r) => {
                  const v = VERIFICATION_STATE[r.w.verification] ?? { label: r.w.verification, tone: "neutral" as const };
                  const i = INSTALL_STATE[r.w.installation];
                  return (
                    <li key={r.w.id} className="flex items-start gap-2 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link href={`${base}/${r.w.id}`} className="block truncate font-medium hover:text-primary">{r.w.name}</Link>
                            <p className="truncate text-xs text-muted-foreground">{r.w.displayHost} · {relative(r.w.lastActivityAt)}</p>
                          </div>
                          <StatusPill tone={HEALTH_PILL[r.health].tone}>{HEALTH_PILL[r.health].label}</StatusPill>
                        </div>
                        <div className="mt-2">{strip(r)}</div>
                        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{v.label}</span><span>Script: {i.label}</span><span>Issues: {issues(r)}</span>{r.a?.responseMs.avg != null && <span>{fmtMs(r.a.responseMs.avg)}</span>}
                        </p>
                      </div>
                      <RowActions w={r.w} base={base} write={write} />
                    </li>
                  );
                })}
              </ul>
              {/* Table from md up */}
              <div className="hidden md:block">
                <Table>
                  <THead>
                    <TR><TH>Website</TH><TH>Health</TH><TH className="hidden lg:table-cell">Last 30 days</TH><TH className="hidden text-right lg:table-cell">Response</TH><TH className="text-right">Issues</TH><TH>Script</TH><TH className="hidden xl:table-cell">Last activity</TH><TH><span className="sr-only">Actions</span></TH></TR>
                  </THead>
                  <TBody>
                    {shown.map((r) => {
                      const i = INSTALL_STATE[r.w.installation];
                      const v = VERIFICATION_STATE[r.w.verification] ?? { label: r.w.verification, tone: "neutral" as const };
                      return (
                        <TR key={r.w.id}>
                          <TD className="max-w-64">
                            <Link href={`${base}/${r.w.id}`} className="block truncate font-medium hover:text-primary">{r.w.name}</Link>
                            <div className="truncate text-xs text-muted-foreground">{r.w.displayHost}</div>
                            {r.w.trialOutcome && <div className="hidden truncate text-xs text-muted-foreground lg:block" title={TRIAL_OUTCOME[r.w.trialOutcome] ?? r.w.trialOutcome}>{TRIAL_OUTCOME[r.w.trialOutcome] ?? r.w.trialOutcome}</div>}
                          </TD>
                          <TD>
                            <StatusPill tone={HEALTH_PILL[r.health].tone} title={r.m?.reasons.join(" · ") || undefined}>{HEALTH_PILL[r.health].label}</StatusPill>
                            {r.w.verification !== "VERIFIED" && <div className="mt-1 text-xs text-muted-foreground">{v.label}</div>}
                            <div className="mt-1 lg:hidden">{strip(r)}</div>
                          </TD>
                          <TD className="hidden lg:table-cell">{strip(r)}</TD>
                          <TD className="hidden whitespace-nowrap text-right tabular-nums lg:table-cell">{r.a?.responseMs.avg != null ? fmtMs(r.a.responseMs.avg) : <span className="text-muted-foreground">—</span>}</TD>
                          <TD className="text-right tabular-nums">{issues(r)}</TD>
                          <TD className="whitespace-nowrap"><span className={i.tone === "danger" ? "text-danger-text" : i.tone === "warning" || r.w.installation === "NOT_INSTALLED" ? "text-warning-text" : "text-muted-foreground"}>{i.label}</span></TD>
                          <TD className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">{relative(r.w.lastActivityAt)}<div>Added {fmtDate(r.w.createdAt)}</div></TD>
                          <TD className="text-right"><RowActions w={r.w} base={base} write={write} /></TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}
