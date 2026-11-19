"use client";
import { Badge, Card, cn, Tabs, type BadgeTone } from "@wim/ui";
import { ArrowRight, Boxes, MonitorSmartphone, PlusCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ComponentDto, ComponentEventDto, DataEnvelope } from "@wim/contracts";
import { QueryState } from "@/components/monitoring";
import { get } from "@/lib/api";
import { fmtMs, fmtTime, mk, outcome, useBrowserSummary } from "@/lib/monitoring";
import { AvailabilityTab } from "./availability-tab";
import { BrowserTab } from "./browser-tab";
import { ComponentsTab, ResponsiveTab } from "./insights-tabs";
import { PerformanceTab } from "./performance-tab";
import { PERF_SECTIONS, type PerfSection } from "./website-data";

const SECTION_LABEL: Record<PerfSection, string> = { speed: "Speed", browser: "Browser checks", components: "Components", layout: "Layout", availability: "Availability" };

/** Performance: speed (vitals, by screen size, what's on the page), browser checks, components, responsive layout and availability. */
export function PerformanceTabs({ orgId, websiteId, section, canWrite, onSection, browserEntitledReason }: {
  orgId: string; websiteId: string; section: string | null; canWrite: boolean; onSection: (s: PerfSection) => void; browserEntitledReason: string | null;
}) {
  const s: PerfSection = (PERF_SECTIONS as readonly string[]).includes(section ?? "") ? (section as PerfSection) : "speed";
  return (
    <div className="grid gap-5">
      <Tabs label="Performance sections" value={s} onChange={onSection} className="w-full sm:w-auto sm:self-start"
        items={PERF_SECTIONS.map((x) => ({ value: x, label: SECTION_LABEL[x] }))} />
      {s === "speed" && (
        <PerformanceTab orgId={orgId} websiteId={websiteId} canWrite={canWrite}>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <ByScreenSize orgId={orgId} websiteId={websiteId} onMore={() => onSection("browser")} />
            <WhatsOnThePage orgId={orgId} websiteId={websiteId} onMore={() => onSection("components")} />
          </div>
        </PerformanceTab>
      )}
      {s === "browser" && <BrowserTab orgId={orgId} websiteId={websiteId} entitledReason={browserEntitledReason} />}
      {s === "components" && <ComponentsTab orgId={orgId} websiteId={websiteId} />}
      {s === "layout" && <ResponsiveTab orgId={orgId} websiteId={websiteId} />}
      {s === "availability" && <AvailabilityTab orgId={orgId} websiteId={websiteId} />}
    </div>
  );
}

/** Latest browser check, one row per screen size: main-content time, popup / layout note, link to the run. */
function ByScreenSize({ orgId, websiteId, onMore }: { orgId: string; websiteId: string; onMore: () => void }) {
  const q = useBrowserSummary(orgId, websiteId);
  const thr = useQuery({
    queryKey: [...mk.site(orgId, websiteId), "perf-thresholds"],
    queryFn: ({ signal }) => get<DataEnvelope<{ effective: Record<string, { good: number; poor: number }> }>>(`/orgs/${orgId}/websites/${websiteId}/performance/thresholds`, { signal }).then((r) => r.data),
  });
  const latest = q.data?.latest;
  const t = thr.data?.effective.lcp;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="text-[15px] font-semibold tracking-tight">By screen size (latest check)</h2>
        {latest && <span className="text-xs text-muted-foreground">{fmtTime(latest.windowStart)}</span>}
      </div>
      <QueryState q={q} skeleton="h-32 m-4">
        {!latest ? <p className="px-5 pb-5 text-sm text-muted-foreground">No browser check yet. <button type="button" className="text-primary hover:underline" onClick={onMore}>Browser checks</button></p> : (
          <ul className="divide-y divide-border px-5 pb-2">
            {latest.viewports.map((v) => {
              const lcp = v.syntheticPerformance?.lcpMs;
              const tone: BadgeTone = v.outcome === "FAILED" ? "danger" : lcp == null || !t ? "neutral" : lcp <= t.good ? "success" : lcp > t.poor ? "danger" : "warning";
              const note = v.outcome === "FAILED" ? v.failureDescription ?? "Check failed"
                : v.overlay?.summary ?? (v.layout ? (v.layout.horizontalOverflowPx > 4 ? `${v.layout.horizontalOverflowPx} px horizontal scroll` : "No layout problems") : outcome(v.outcome).label);
              return (
                <li key={v.viewport} className="flex items-center gap-3 py-3">
                  <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{v.viewport}{v.width ? <span className="font-normal text-muted-foreground"> · {v.width} px</span> : null}</p>
                    <p className="truncate text-xs text-muted-foreground">{note}</p>
                  </div>
                  <span className={cn("text-sm font-medium tabular-nums", tone === "success" ? "text-success-text" : tone === "warning" ? "text-warning-text" : tone === "danger" ? "text-danger-text" : "text-muted-foreground")}
                    title="Main content appears (LCP, synthetic)">{v.outcome === "FAILED" ? "Failed" : fmtMs(lcp)}</span>
                  <Link className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}/browser/${latest.executionId}`}>View run <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

const TYPE: Record<string, string> = {
  HEADER: "Header", NAV: "Navigation", FOOTER: "Footer", SEARCH: "Search", FORM: "Form", BUTTON: "Button", LINK: "Call to action", IMAGE: "Image / media",
  DROPDOWN: "Dropdown", MODAL: "Dialog", TABS: "Tabs", ACCORDION: "Accordion", SLIDER: "Slider", PAGINATION: "Pagination", TABLE: "Table",
  RESPONSIVE_NAV: "Mobile menu toggle", CARD_GROUP: "Repeated content", CUSTOM: "Custom",
};

const EVENT: Record<string, string> = { ADDED: "Added", CHANGED: "Changed", REMOVED: "Removed", RESTORED: "Restored" };

/** Components the browser check found on the monitored page (same queries as the Browser checks section). */
function WhatsOnThePage({ orgId, websiteId, onMore }: { orgId: string; websiteId: string; onMore: () => void }) {
  const comps = useQuery({ queryKey: [...mk.browser(orgId, websiteId), "components"], queryFn: ({ signal }) => get<DataEnvelope<ComponentDto[]>>(`/orgs/${orgId}/websites/${websiteId}/components?status=ALL`, { signal }).then((r) => r.data) });
  const hist = useQuery({ queryKey: [...mk.browser(orgId, websiteId), "component-history"], queryFn: ({ signal }) => get<{ data: ComponentEventDto[] }>(`/orgs/${orgId}/websites/${websiteId}/components/history?limit=20`, { signal }).then((r) => r.data) });
  const present = (comps.data ?? []).filter((c) => c.status === "PRESENT");
  const counts = new Map<string, number>();
  for (const c of present) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  const last = hist.data?.[0];
  return (
    <Card className="px-5 py-4">
      <h2 className="text-[15px] font-semibold tracking-tight">What&apos;s on the page</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Detected by the browser check. Changes are recorded; a component counts as removed after two complete checks without it.</p>
      <QueryState q={comps} skeleton="h-16 mt-3">
        {!present.length ? <p className="mt-3 text-sm text-muted-foreground">No components detected yet.</p> : (
          <ul className="mt-3 flex flex-wrap gap-1.5">{[...counts].map(([t, n]) => <li key={t}><Badge>{TYPE[t] ?? t}{n > 1 ? <span className="tabular-nums"> · {n}</span> : null}</Badge></li>)}</ul>
        )}
      </QueryState>
      {last && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground"><PlusCircle className="mt-px h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          <span>{EVENT[last.type] ?? last.type} {fmtTime(last.at)}: {TYPE[last.componentType] ?? last.componentType}{last.label ? ` “${last.label}”` : ""}</span></p>
      )}
      <button type="button" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" onClick={onMore}><Boxes className="h-3.5 w-3.5" aria-hidden /> All components and changes</button>
    </Card>
  );
}
