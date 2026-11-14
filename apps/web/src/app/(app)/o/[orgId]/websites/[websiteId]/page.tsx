"use client";
import { Alert, Badge, PageHeader, Skeleton, Tabs } from "@wim/ui";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { INSTALL_STATE, useWebsite, VERIFICATION_STATE } from "@/lib/websites";
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
import { useSchedule } from "@/lib/monitoring";

const TABS = ["overview", "availability", "performance", "browser", "pages", "components", "responsive", "deep-scan", "monitoring-settings", "verification", "installation", "settings", "history", "audit"] as const;
const LABEL: Partial<Record<Tab, string>> = { "deep-scan": "Deep scan", "monitoring-settings": "Monitoring" };
type Tab = (typeof TABS)[number];

export default function WebsiteDetailPage() {
  const { orgId, can } = useOrg();
  const { websiteId } = useParams<{ websiteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview";
  const site = useWebsite(orgId, websiteId);
  const sched = useSchedule(orgId, websiteId);
  const setTab = (t: Tab) => router.replace(`/o/${orgId}/websites/${websiteId}?tab=${t}`, { scroll: false });

  if (site.isLoading) return <Skeleton className="h-64" />;
  if (site.isError || !site.data) return <Alert tone="danger" title={site.isError ? errorMessage(site.error) : "Website not found"} />;
  const w = site.data;
  const v = VERIFICATION_STATE[w.verification] ?? { label: w.verification, tone: "neutral" as const };
  const i = INSTALL_STATE[w.installation];
  const items = TABS.filter((t) => t !== "audit" || can("audit:read")).filter((t) => t !== "settings" || can("website:write") || can("website:delete"))
    .map((t) => ({ value: t, label: LABEL[t] ?? t[0]!.toUpperCase() + t.slice(1) }));
  const ent = sched.data?.entitlements;

  return (
    <>
      <div className="mb-2 text-sm"><Link href={`/o/${orgId}/websites`} className="text-muted-foreground hover:underline">← Websites</Link></div>
      <PageHeader
        title={w.name}
        description={w.displayHost}
        actions={<div className="flex gap-2"><Badge tone={v.tone}>{v.label}</Badge><Badge tone={i.tone}>{i.label}</Badge></div>}
      />
      <div className="-mx-1 mb-4 overflow-x-auto px-1 pb-1"><Tabs label="Website sections" value={tab} onChange={setTab} items={items} /></div>
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
