"use client";
import { Alert, buttonVariants, CountBadge, ErrorState, Skeleton, StatusPill, Tabs } from "@wim/ui";
import { ChevronLeft, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { useWebsite } from "@/lib/websites";
import { presetRange, useOverview, useSchedule } from "@/lib/monitoring";
import { OverviewTab } from "./overview-tab";
import { IssuesTab } from "./issues-tab";
import { PagesTab } from "./pages-tab";
import { PerformanceTabs } from "./performance-tabs";
import { SettingsTabs } from "./settings-tabs";
import {
  cleanDays, healthSentence, HEALTH_PILL, resolveTab, tabHref, usePagesTotal, useAvailability30d, useWebsiteProblems, websiteHealth, type Tab,
} from "./website-data";

const LABEL: Record<Tab, string> = { overview: "Overview", issues: "Issues", pages: "Pages", performance: "Performance", settings: "Settings" };
/** Phone labels: five segments must fit 390 px. */
const SHORT: Record<Tab, string> = { overview: "Overview", issues: "Issues", pages: "Pages", performance: "Speed", settings: "Settings" };

export default function WebsiteDetailPage() {
  const { orgId, can } = useOrg();
  const { websiteId } = useParams<{ websiteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  // Old ?tab= values (availability, browser, deep-scan, verification, …) map to the tab + section that now holds them.
  const { tab, section } = resolveTab(params.get("tab"), params.get("section"));
  const site = useWebsite(orgId, websiteId);
  const sched = useSchedule(orgId, websiteId);
  // Same 24 h organisation overview the home page reads; used for the health state of this website.
  const [range] = useState(() => presetRange("24h"));
  const overview = useOverview(orgId, range);
  const open = useWebsiteProblems(orgId, websiteId, "OPEN");
  const avail = useAvailability30d(orgId, websiteId);
  const pages = usePagesTotal(orgId, websiteId);
  const go = (t: Tab, s?: string | null) => router.replace(tabHref(orgId, websiteId, t, s), { scroll: false });
  const back = <Link href={`/o/${orgId}/websites`} className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Websites</Link>;

  if (site.isLoading) return <div role="status" aria-label="Loading" className="grid gap-4"><Skeleton className="h-20" /><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (site.isError || !site.data) {
    const notFound = !site.isError || (site.error instanceof ApiError && site.error.status === 404);
    return (
      <div className="grid gap-4">
        <div>{back}</div>
        {notFound
          ? <Alert tone="warning" title="Website not found">It may have been removed, or it belongs to another organisation.</Alert>
          : <ErrorState title="Couldn't load this website" description={errorMessage(site.error)} onRetry={() => void site.refetch()} />}
      </div>
    );
  }
  const w = site.data;
  const m = overview.data?.websites.find((x) => x.id === w.id);
  const ent = sched.data?.entitlements;
  const verified = w.verification === "VERIFIED";
  const health = websiteHealth(w, m, open.list);
  const hasChecks = (avail.data?.checks.total ?? 0) > 0;
  const sentence = healthSentence(health, w, open.list, cleanDays(avail.data), hasChecks);
  const issueCount = open.isLoading ? undefined : open.list.length;
  const pageCount = pages.data?.summary.total;
  const items = (["overview", "issues", "pages", "performance", "settings"] as const).map((t) => ({
    value: t, label: LABEL[t],
    count: t === "issues" && issueCount ? <CountBadge tone="warning">{issueCount}</CountBadge> : t === "pages" && pageCount ? <CountBadge>{pageCount}</CountBadge> : undefined,
  }));

  return (
    <>
      <div className="mb-3 lg:hidden">{back}</div>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 break-words text-[24px] font-semibold leading-tight tracking-[-0.02em] sm:text-[28px]">{w.name}</h1>
            <StatusPill tone={HEALTH_PILL[health].tone} data-testid="website-health" title={m?.reasons.join(" · ") || undefined}>{HEALTH_PILL[health].label}</StatusPill>
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{w.displayHost}</p>
          {tab === "overview" && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground" data-testid="website-sentence">{sentence}</p>}
          {tab === "issues" && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">Every problem we found, in one list: open incidents from uptime and browser checks, and deep-scan findings. Sorted by what hurts visitors most.</p>}
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {!verified && can("website:write") && !(tab === "settings" && section === "ownership") && (
            <button type="button" className={buttonVariants({ size: "md" })} onClick={() => go("settings", "ownership")}><ShieldCheck /> Verify ownership</button>
          )}
          <a href={w.canonicalOrigin} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "md" })}><ExternalLink /> Open site<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </header>
      <Tabs className="mb-6 hidden sm:flex" variant="underline" label="Website sections" value={tab} onChange={(t) => go(t)} items={items} />
      <Tabs className="mb-5 flex w-full sm:hidden [&>button]:flex-1 [&>button]:justify-center [&>button]:px-1.5" label="Website sections" value={tab} onChange={(t) => go(t)}
        items={items.map((it) => ({ value: it.value, label: <>{SHORT[it.value]}{it.value === "issues" && issueCount ? <span className="tabular-nums text-muted-foreground"> {issueCount}</span> : null}</> }))} />
      {tab === "overview" && <OverviewTab w={w} orgId={orgId} canWrite={can("website:write")} health={health} problems={open} m={m} avail={avail} onNavigate={go} />}
      {tab === "issues" && <IssuesTab orgId={orgId} websiteId={w.id} canWrite={can("monitoring:write")} canAck={can("incident:write")} section={section}
        deepEntitledReason={ent?.DEEPSCAN.available === false ? ent.DEEPSCAN.reason : null} />}
      {tab === "pages" && <PagesTab orgId={orgId} websiteId={w.id} />}
      {tab === "performance" && <PerformanceTabs orgId={orgId} websiteId={w.id} section={section} canWrite={can("monitoring:write")} onSection={(s) => go("performance", s)}
        browserEntitledReason={ent?.BROWSER.available === false ? ent.BROWSER.reason : null} />}
      {tab === "settings" && <SettingsTabs w={w} orgId={orgId} section={section} can={can} />}
    </>
  );
}
