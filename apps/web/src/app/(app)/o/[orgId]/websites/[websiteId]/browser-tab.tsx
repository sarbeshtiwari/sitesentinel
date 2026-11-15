"use client";
import { Badge, buttonVariants, EmptyState, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { ArrowRight, Boxes, History, MonitorSmartphone } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { ComponentDto, ComponentEventDto, DataEnvelope } from "@wim/contracts";
import { get } from "@/lib/api";
import Link from "next/link";
import { useState } from "react";
import { SyntheticNote } from "./performance-tab";
import { FilterSelect, HealthBadge, KeyValue, LoadMore, QueryState, Section } from "@/components/monitoring";
import { fmtMs, fmtTime, mk, outcome, presetRange, useBrowserResults, useBrowserSummary } from "@/lib/monitoring";

export const VIEWPORTS: Array<[string, string]> = [["", "All viewports"], ["desktop", "Desktop"], ["desktop-large", "Desktop large"], ["tablet", "Tablet"], ["mobile-landscape", "Mobile landscape"], ["mobile-large", "Mobile large"], ["mobile-small", "Mobile small"]];
const PROBLEMS: Array<[string, string]> = [["", "All problems"], ["NAVIGATION", "Navigation"], ["RENDERING", "Rendering"], ["JAVASCRIPT", "JavaScript"], ["NETWORK", "Failed resources"], ["LAYOUT", "Layout"], ["PERFORMANCE", "Performance"]];
const SINCE: Array<[string, string]> = [["", "Any time"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]];

export function BrowserTab({ orgId, websiteId, entitledReason }: { orgId: string; websiteId: string; entitledReason: string | null }) {
  const sum = useBrowserSummary(orgId, websiteId);
  const [f, setF] = useState({ outcome: "", viewport: "", problem: "", since: "" });
  const from = f.since ? presetRange(f.since as "24h").from : undefined;
  const res = useBrowserResults(orgId, websiteId, { outcome: f.outcome || undefined, viewport: f.viewport || undefined, problem: f.problem || undefined, from });
  const s = sum.data;
  const latest = s?.latest;
  const base = `/o/${orgId}/websites/${websiteId}/browser`;

  return (
    <div className="grid gap-5">
      <SyntheticNote />
      <QueryState q={sum}>
        {s && (s.state === "NOT_MONITORED" || s.state === "PAUSED") && !latest ? (
          <Section title="Browser monitoring" icon={<MonitorSmartphone />}>
            <EmptyState icon={<MonitorSmartphone />} title={entitledReason ? `Browser monitoring is unavailable: ${entitledReason}.` : s.pausedReason === "DISABLED_BY_CUSTOMER" ? "Browser monitoring is turned off for this website." : "Browser monitoring is not active for this website yet."}
              description="Browser checks load your page in a real Chromium browser through our network gateway and report rendering, JavaScript and resource problems." />
          </Section>
        ) : s && (
          <Section title="Browser monitoring" icon={<MonitorSmartphone />} description="Synthetic checks: one Chromium in our infrastructure — not real-user measurements; INP is never produced here."
            actions={latest && <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${base}/${latest.executionId}`}>Latest check <ArrowRight /></Link>}>
            <div className="grid gap-5">
              <KeyValue items={[
                ["State", <HealthBadge key="s" state={s.state} />],
                ["Last execution", latest ? <Link key="l" className="font-medium hover:text-primary" href={`${base}/${latest.executionId}`}>{fmtTime(latest.windowStart)}</Link> : "—"],
                ["Last result", latest ? <Badge key="o" tone={outcome(latest.outcome).tone}>{outcome(latest.outcome).label}</Badge> : "—"],
                ["Last successful", fmtTime(s.lastSuccessfulCheckAt)], ["Last failed", fmtTime(s.lastFailedCheckAt)],
                ["Viewports (latest)", latest ? latest.viewports.map((v) => v.viewport).join(", ") || "—" : "—"],
                ["Open incidents", s.openIncidents.length],
              ]} />
              {latest?.viewports[0] && (
                <div>
                  <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">Synthetic performance of the latest check · {latest.viewports[0].viewport} <Badge tone="info">Lab, not real users</Badge></p>
                  <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-6">
                    {([["FCP", fmtMs(latest.viewports[0].syntheticPerformance?.fcpMs)], ["LCP", fmtMs(latest.viewports[0].syntheticPerformance?.lcpMs)],
                      ["CLS", latest.viewports[0].syntheticPerformance?.cls?.toFixed(3) ?? "—"], ["TBT", fmtMs(latest.viewports[0].syntheticPerformance?.tbtMs)],
                      ["TTFB", fmtMs(latest.viewports[0].syntheticPerformance?.ttfbMs)], ["Load", fmtMs(latest.viewports[0].syntheticPerformance?.loadMs)]] as const).map(([k, v]) => (
                      <div key={k} className="bg-card px-3 py-2.5"><p className="text-xs text-muted-foreground">{k} <span className="sr-only">(synthetic)</span></p><p className="mt-0.5 font-semibold tabular-nums">{v}</p></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}
      </QueryState>
      <ComponentsSection orgId={orgId} websiteId={websiteId} />
      <Section title="Browser check history" icon={<History />} flush description="Synthetic checks, newest first. Times in your time zone.">
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap [&_select]:min-w-0 sm:[&_select]:min-w-36">
            <FilterSelect label="Date" value={f.since} onChange={(v) => setF({ ...f, since: v })} options={SINCE} />
            <FilterSelect label="Result" value={f.outcome} onChange={(v) => setF({ ...f, outcome: v })} options={[["", "All"], ["PASSED", "Passed"], ["FAILED", "Failed"], ["INCONCLUSIVE", "Inconclusive"]]} />
            <FilterSelect label="Viewport" value={f.viewport} onChange={(v) => setF({ ...f, viewport: v })} options={VIEWPORTS} />
            <FilterSelect label="Problem" value={f.problem} onChange={(v) => setF({ ...f, problem: v })} options={PROBLEMS} />
          </div>
        </div>
        <QueryState q={res} skeleton="h-40 m-4">
          {!res.data?.pages[0]?.data.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No browser checks match.</p> : (
            <>
              <Table>
                <THead><TR><TH>Time</TH><TH>Result</TH><TH>Viewports</TH><TH className="hidden md:table-cell">Problem</TH><TH className="hidden text-right lg:table-cell">LCP (synthetic)</TH></TR></THead>
                <TBody>
                  {res.data.pages.flatMap((p) => p.data).map((r) => {
                    const failing = r.viewports.find((v) => v.outcome !== "PASSED");
                    return (
                      <TR key={r.executionId}>
                        <TD className="whitespace-nowrap text-xs"><Link className="font-medium hover:text-primary" href={`${base}/${r.executionId}`}>{fmtTime(r.windowStart)}</Link></TD>
                        <TD><Badge tone={outcome(r.outcome).tone}>{outcome(r.outcome).label}</Badge></TD>
                        <TD className="text-xs text-muted-foreground">{r.viewports.map((v) => v.viewport).join(", ")}</TD>
                        <TD className="hidden max-w-72 truncate text-xs text-muted-foreground md:table-cell">{failing?.failureDescription ?? "—"}</TD>
                        <TD className="hidden text-right tabular-nums lg:table-cell">{fmtMs(r.viewports[0]?.syntheticPerformance?.lcpMs)}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <LoadMore q={res} />
            </>
          )}
        </QueryState>
      </Section>
    </div>
  );
}

const TYPE: Record<string, string> = {
  HEADER: "Header", NAV: "Navigation", FOOTER: "Footer", SEARCH: "Search", FORM: "Form", BUTTON: "Button", LINK: "Call to action", IMAGE: "Image / media",
  DROPDOWN: "Dropdown", MODAL: "Dialog", TABS: "Tabs", ACCORDION: "Accordion", SLIDER: "Slider", PAGINATION: "Pagination", TABLE: "Table",
  RESPONSIVE_NAV: "Mobile menu toggle", CARD_GROUP: "Repeated content", CUSTOM: "Custom",
};
const EVENT: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ADDED: { label: "Added", tone: "success" }, CHANGED: { label: "Changed", tone: "warning" }, REMOVED: { label: "Removed", tone: "danger" }, RESTORED: { label: "Restored", tone: "success" },
};

/** Phase 4F: detected components of the monitored page and their change history (the full component dashboard is Phase 4G). */
function ComponentsSection({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const comps = useQuery({ queryKey: [...mk.browser(orgId, websiteId), "components"], queryFn: ({ signal }) => get<DataEnvelope<ComponentDto[]>>(`/orgs/${orgId}/websites/${websiteId}/components?status=ALL`, { signal }).then((r) => r.data) });
  const hist = useQuery({ queryKey: [...mk.browser(orgId, websiteId), "component-history"], queryFn: ({ signal }) => get<{ data: ComponentEventDto[] }>(`/orgs/${orgId}/websites/${websiteId}/components/history?limit=20`, { signal }).then((r) => r.data) });
  const present = (comps.data ?? []).filter((c) => c.status === "PRESENT");
  const counts = new Map<string, number>();
  for (const c of present) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return (
    <Section title="Detected components" icon={<Boxes />} description="Found on the monitored page by the browser check (synthetic, read-only detection). Changes are recorded when the structure changes; a component counts as removed only after two complete checks without it.">
      <QueryState q={comps}>
        {!present.length ? <p className="text-sm text-muted-foreground">No components detected yet.</p> : (
          <div className="grid gap-4">
            <ul className="flex flex-wrap gap-2">{[...counts].map(([t, n]) => <li key={t}><Badge>{TYPE[t] ?? t} · <span className="tabular-nums">{n}</span></Badge></li>)}</ul>
            <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <THead><TR><TH>Component</TH><TH className="hidden md:table-cell">Visible at</TH><TH className="hidden lg:table-cell">First seen</TH></TR></THead>
              <TBody>
                {present.filter((c) => ["NAV", "SEARCH", "FORM", "RESPONSIVE_NAV", "HEADER", "FOOTER", "CARD_GROUP"].includes(c.type)).map((c) => (
                  <TR key={c.id}>
                    <TD className="text-sm">{TYPE[c.type] ?? c.type}{c.label ? <span className="text-muted-foreground"> · {c.label}</span> : null}</TD>
                    <TD className="hidden text-xs md:table-cell">{c.viewports.join(", ") || "—"}</TD>
                    <TD className="hidden text-xs text-muted-foreground lg:table-cell">{fmtTime(c.firstSeenAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            </div>
          </div>
        )}
      </QueryState>
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="mb-2 text-sm font-semibold">Recent changes</h3>
        {!hist.data?.length ? <p className="text-sm text-muted-foreground">No component changes recorded.</p> : (
          <ul className="grid gap-1.5 text-sm">{hist.data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2"><Badge tone={EVENT[e.type]?.tone}>{EVENT[e.type]?.label ?? e.type}</Badge><span>{TYPE[e.componentType] ?? e.componentType}{e.label ? <span className="text-muted-foreground"> · {e.label}</span> : ""}</span><span className="text-xs text-muted-foreground sm:ml-auto">{fmtTime(e.at)}</span></li>
          ))}</ul>
        )}
      </div>
    </Section>
  );
}
