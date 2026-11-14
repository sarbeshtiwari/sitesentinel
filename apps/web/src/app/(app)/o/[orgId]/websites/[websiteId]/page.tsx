"use client";
import { Alert, Badge, buttonVariants, cn, Skeleton } from "@wim/ui";
import { ChevronLeft, Code2, ExternalLink, Globe, ShieldCheck, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { INSTALL_STATE, useWebsite, VERIFICATION_STATE } from "@/lib/websites";
import { HealthBadge } from "@/components/monitoring";
import { OverviewTab } from "./overview-tab";
import { VerificationTab } from "./verification-tab";
import { InstallationTab } from "./installation-tab";
import { SettingsTab } from "./settings-tab";
import { AuditTab, HistoryTab } from "./history-tabs";
import { AvailabilityTab } from "./availability-tab";
import { BrowserTab } from "./browser-tab";
import { DeepScanTab } from "./deepscan-tab";
import { MonitoringSettingsTab } from "./monitoring-settings-tab";
import { PerformanceTab } from "./performance-tab";
import { ComponentsTab, PagesTab, ResponsiveTab } from "./insights-tabs";
import { presetRange, useOverview, useSchedule } from "@/lib/monitoring";

const TABS = ["overview", "availability", "performance", "browser", "pages", "components", "responsive", "deep-scan", "monitoring-settings", "verification", "installation", "settings", "history", "audit"] as const;
const LABEL: Partial<Record<Tab, string>> = { "deep-scan": "Deep scan", "monitoring-settings": "Monitoring" };
/** Tabs that start a new visual group in the tab bar (configuration, then records). */
const GROUP_START: ReadonlySet<Tab> = new Set<Tab>(["monitoring-settings", "history"]);
type Tab = (typeof TABS)[number];

/** Underline tab bar that scrolls horizontally on small screens; the active tab is kept in view. */
function TabBar({ value, onChange, items }: { value: Tab; onChange: (t: Tab) => void; items: Array<{ value: Tab; label: string }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = ref.current;
    const el = bar?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !el) return;
    const left = el.offsetLeft - bar.offsetLeft;
    if (left < bar.scrollLeft || left + el.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left - 16;
  }, [value]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    onChange(items[next]!.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="relative mb-5 border-b border-border">
      <div ref={ref} role="tablist" aria-label="Website sections" className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it, i) => {
          const active = it.value === value;
          return (
            <div key={it.value} role="presentation" className="flex shrink-0 items-center">
              {GROUP_START.has(it.value) && i > 0 && <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />}
              <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} onClick={() => onChange(it.value)} onKeyDown={(e) => onKey(e, i)}
                className={cn("relative cursor-pointer whitespace-nowrap rounded-t-md border-b-2 px-2.5 pb-2.5 pt-2 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground")}>
                {it.label}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WebsiteDetailPage() {
  const { orgId, can } = useOrg();
  const { websiteId } = useParams<{ websiteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview";
  const site = useWebsite(orgId, websiteId);
  const sched = useSchedule(orgId, websiteId);
  // Same 24 h organisation overview the Overview tab reads; used here only for the health badge.
  const [range] = useState(() => presetRange("24h"));
  const overview = useOverview(orgId, range);
  const setTab = (t: Tab) => router.replace(`/o/${orgId}/websites/${websiteId}?tab=${t}`, { scroll: false });
  const back = <Link href={`/o/${orgId}/websites`} className="inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Websites</Link>;

  if (site.isLoading) return <div role="status" aria-label="Loading" className="grid gap-4"><Skeleton className="h-20" /><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (site.isError || !site.data) return <div className="grid gap-4"><div>{back}</div><Alert tone="danger" title={site.isError ? errorMessage(site.error) : "Website not found"} /></div>;
  const w = site.data;
  const v = VERIFICATION_STATE[w.verification] ?? { label: w.verification, tone: "neutral" as const };
  const i = INSTALL_STATE[w.installation];
  const m = overview.data?.websites.find((x) => x.id === w.id);
  const items = TABS.filter((t) => t !== "audit" || can("audit:read")).filter((t) => t !== "settings" || can("website:write") || can("website:delete"))
    .map((t) => ({ value: t, label: LABEL[t] ?? t[0]!.toUpperCase() + t.slice(1) }));
  const ent = sched.data?.entitlements;
  const verified = w.verification === "VERIFIED";

  return (
    <>
      <div className="mb-3">{back}</div>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"><Globe className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-semibold leading-tight tracking-tight sm:text-2xl">{w.name}</h1>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{w.displayHost}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {m && <HealthBadge state={m.health} />}
              <Badge tone={v.tone} title="Ownership verification"><ShieldCheck className="h-3 w-3" aria-hidden />{v.label}</Badge>
              <Badge tone={i.tone} title="Monitoring script installation"><Code2 className="h-3 w-3" aria-hidden />{i.label}</Badge>
              {m && m.activeIncidents > 0 && <Link href={`/o/${orgId}/incidents?websiteId=${w.id}`} className="text-xs font-medium text-danger hover:underline">{m.activeIncidents} open incident{m.activeIncidents === 1 ? "" : "s"}</Link>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!verified && can("website:write") && tab !== "verification" && (
            <button type="button" className={buttonVariants({ size: "sm" })} onClick={() => setTab("verification")}><ShieldCheck /> Verify ownership</button>
          )}
          {verified && can("monitoring:write") && tab !== "monitoring-settings" && (
            <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} onClick={() => setTab("monitoring-settings")}><SlidersHorizontal /> Configure monitoring</button>
          )}
          <a href={w.canonicalOrigin} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}><ExternalLink /> Open website<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </header>
      <TabBar value={tab} onChange={setTab} items={items} />
      {tab === "overview" && <OverviewTab w={w} orgId={orgId} canWrite={can("website:write")} onNavigate={setTab} />}
      {tab === "availability" && <AvailabilityTab orgId={orgId} websiteId={w.id} />}
      {tab === "performance" && <PerformanceTab orgId={orgId} websiteId={w.id} canWrite={can("monitoring:write")} />}
      {tab === "pages" && <PagesTab orgId={orgId} websiteId={w.id} />}
      {tab === "components" && <ComponentsTab orgId={orgId} websiteId={w.id} />}
      {tab === "responsive" && <ResponsiveTab orgId={orgId} websiteId={w.id} />}
      {tab === "browser" && <BrowserTab orgId={orgId} websiteId={w.id} entitledReason={ent?.BROWSER.available === false ? ent.BROWSER.reason : null} />}
      {tab === "deep-scan" && <DeepScanTab orgId={orgId} websiteId={w.id} canWrite={can("monitoring:write")} entitledReason={ent?.DEEPSCAN.available === false ? ent.DEEPSCAN.reason : null} />}
      {tab === "monitoring-settings" && <MonitoringSettingsTab orgId={orgId} websiteId={w.id} canWrite={can("monitoring:write")} />}
      {tab === "verification" && <VerificationTab w={w} orgId={orgId} canWrite={can("website:write")} />}
      {tab === "installation" && <InstallationTab w={w} orgId={orgId} canWrite={can("website:write")} />}
      {tab === "settings" && <SettingsTab w={w} orgId={orgId} canWrite={can("website:write")} canDelete={can("website:delete")} />}
      {tab === "history" && <HistoryTab w={w} orgId={orgId} />}
      {tab === "audit" && <AuditTab w={w} orgId={orgId} />}
    </>
  );
}
