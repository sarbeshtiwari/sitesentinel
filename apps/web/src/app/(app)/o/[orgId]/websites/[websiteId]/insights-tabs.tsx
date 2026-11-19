"use client";
import { Badge, Button, Card, cn, EmptyState, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { BarChart3, Boxes, GitCompare, History, MonitorSmartphone, Search, Smartphone, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { DataEnvelope } from "@wim/contracts";
import { FilterSelect, Hint, QueryState, RangePicker, Section, StackedBars } from "@/components/monitoring";
import { get } from "@/lib/api";
import { fmtTime, mk, presetRange, rangeQs, SCAN_STATUS, type Range } from "@/lib/monitoring";

const TYPE: Record<string, string> = {
  HEADER: "Header", NAV: "Navigation", FOOTER: "Footer", SEARCH: "Search", FORM: "Form", BUTTON: "Button", LINK: "Call to action", IMAGE: "Image / media",
  DROPDOWN: "Dropdown", MODAL: "Dialog", TABS: "Tabs", ACCORDION: "Accordion", SLIDER: "Slider", PAGINATION: "Pagination", TABLE: "Table",
  RESPONSIVE_NAV: "Mobile menu toggle", CARD_GROUP: "Repeated content", CUSTOM: "Custom",
};
const EVENT: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ADDED: { label: "Added", tone: "success" }, CHANGED: { label: "Changed", tone: "warning" }, REMOVED: { label: "Removed", tone: "danger" }, RESTORED: { label: "Restored", tone: "success" }, VISIBILITY: { label: "Visibility", tone: "warning" },
};

// ===================================================================================================== components
interface Comp { id: string; type: string; label: string | null; status: string; pagePath: string; viewports: string[]; firstSeenAt: string; lastSeenAt: string; removedAt: string | null }
export function ComponentsTab({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const [f, setF] = useState({ status: "PRESENT", type: "" });
  const [sel, setSel] = useState<string | null>(null);
  const [sinceDays, setSinceDays] = useState("7");
  const since = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - Number(sinceDays) * 86_400_000).toISOString();
  const base = `/orgs/${orgId}/websites/${websiteId}/components`;
  const list = useQuery({ queryKey: [...mk.site(orgId, websiteId), "components", f], queryFn: ({ signal }) => get<DataEnvelope<Comp[]>>(`${base}?${new URLSearchParams({ status: f.status, ...(f.type ? { type: f.type } : {}) })}`, { signal }).then((r) => r.data) });
  const changes = useQuery({ queryKey: [...mk.site(orgId, websiteId), "components-since", since], queryFn: ({ signal }) => get<DataEnvelope<{ complete: boolean; inventoryStartedAt: string | null; added: Comp[]; removed: Comp[]; changed: Comp[]; visibility: Comp[] }>>(`${base}/changes?since=${since}`, { signal }).then((r) => r.data) });
  const detail = useQuery({ queryKey: [...mk.site(orgId, websiteId), "component", sel], enabled: Boolean(sel), queryFn: ({ signal }) => get<DataEnvelope<Comp & { detail: Record<string, unknown>; visibility: Record<string, boolean>; history: Array<{ id: string; at: string; type: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }> }>>(`${base}/${sel}`, { signal }).then((r) => r.data) });
  const c = changes.data;
  return (
    <div className="grid gap-5">
      <Hint>Components are detected on the monitored page by our synthetic browser checks (Chromium runners), not from real visitors.</Hint>
      <Section title="What changed" icon={<GitCompare />} description="Compared with the inventory at the start of the period. Removals need two complete checks without the component." actions={<FilterSelect label="Since" value={sinceDays} onChange={setSinceDays} options={[["1", "1 day ago"], ["7", "7 days ago"], ["30", "30 days ago"]]} />}>
        <QueryState q={changes}>
          {c && (
            <div className="grid gap-3 text-sm">
              {!c.complete && <Hint>Component history starts {fmtTime(c.inventoryStartedAt)}; changes before that are unknown.</Hint>}
              <ul className="grid gap-2.5 sm:grid-cols-2">
                {([["Added", c.added, "success"], ["Removed", c.removed, "danger"], ["Changed", c.changed, "warning"], ["Responsive visibility changed", c.visibility, "warning"]] as const).map(([k, items, tone]) => (
                  <li key={k} className="grid content-start gap-2 rounded-lg border border-border px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2"><Badge tone={tone}>{k}</Badge><span className="text-lg font-semibold tabular-nums">{items.length}</span></div>
                    {items.length > 0 && <div className="flex flex-wrap gap-x-3 gap-y-1">{items.slice(0, 8).map((x) => <button key={x.id} type="button" className="cursor-pointer text-left text-xs text-primary hover:underline" onClick={() => setSel(x.id)}>{TYPE[x.type] ?? x.type}{x.label ? ` "${x.label}"` : ""}</button>)}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </QueryState>
      </Section>
      <Section title="Detected components" icon={<Boxes />} flush actions={<div className="flex flex-wrap gap-2">
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[["PRESENT", "Present"], ["REMOVED", "Removed"], ["ALL", "All"]]} />
        <FilterSelect label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={[["", "All types"], ...Object.entries(TYPE)]} />
      </div>}>
        <QueryState q={list} skeleton="h-40 m-4">
          {!list.data?.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No components match.</p> : (
            <Table>
              <THead><TR><TH>Component</TH><TH className="hidden md:table-cell">Page</TH><TH className="hidden md:table-cell">Visible at (last check)</TH><TH className="hidden lg:table-cell">First / last seen</TH></TR></THead>
              <TBody>{list.data.map((x) => (
                <TR key={x.id}>
                  <TD><button type="button" aria-pressed={sel === x.id} className={cn("cursor-pointer text-left text-sm font-medium hover:text-primary", sel === x.id && "text-primary")} onClick={() => setSel(x.id)}>{TYPE[x.type] ?? x.type}{x.label ? <span className="text-muted-foreground"> · {x.label}</span> : null}</button>{x.status === "REMOVED" && <Badge tone="danger" className="ml-2">Removed</Badge>}</TD>
                  <TD className="hidden font-mono text-xs md:table-cell">{x.pagePath}</TD>
                  <TD className="hidden text-xs md:table-cell">{x.viewports.join(", ") || "—"}</TD>
                  <TD className="hidden text-xs text-muted-foreground lg:table-cell">{fmtTime(x.firstSeenAt)} / {fmtTime(x.lastSeenAt)}</TD>
                </TR>
              ))}</TBody>
            </Table>
          )}
        </QueryState>
      </Section>
      {sel && (
        <Section title="Component history" icon={<History />} actions={<Button size="sm" variant="ghost" onClick={() => setSel(null)}><X /> Close</Button>}>
          <QueryState q={detail}>
            {detail.data && (
              <div className="grid gap-3 text-sm">
                <p className="font-medium">{TYPE[detail.data.type] ?? detail.data.type}{detail.data.label ? ` · ${detail.data.label}` : ""} <span className="text-xs text-muted-foreground">on {detail.data.pagePath}</span></p>
                <p className="rounded-md bg-sunken px-3 py-2 text-xs">Visibility by viewport (last observed): {Object.entries(detail.data.visibility).map(([v, on]) => `${v}: ${on ? "visible" : "hidden"}`).join(" · ") || "—"}</p>
                <ol className="grid gap-1.5">{detail.data.history.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-start gap-2 text-xs"><span className="text-muted-foreground">{fmtTime(e.at)}</span><Badge tone={EVENT[e.type]?.tone}>{EVENT[e.type]?.label ?? e.type}</Badge>
                    {(e.before || e.after) && <span className="break-all text-muted-foreground">{e.before ? JSON.stringify(e.before).slice(0, 160) : "—"} → {e.after ? JSON.stringify(e.after).slice(0, 160) : "—"}</span>}</li>
                ))}{!detail.data.history.length && <li className="text-xs text-muted-foreground">No changes since it was first detected.</li>}</ol>
              </div>
            )}
          </QueryState>
        </Section>
      )}
    </div>
  );
}

// ===================================================================================================== responsive
interface Resp { viewport: string; width: number; height: number; status: string; navState: string | null; overflowPx: number; clippedText: number; overlaps: number; obscuredControls: number; offscreenControls: number; objective: string[]; heuristic: string[]; executionId: string | null; at: string | null }
const NAV: Record<string, string> = { VISIBLE: "Visible", COLLAPSED_OK: "Menu opens", BROKEN: "Menu broken", MISSING: "Not reachable", NONE: "—" };
export function ResponsiveTab({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const [range, setRange] = useState<Range>(() => presetRange("7d"));
  const [cmp, setCmp] = useState<{ a: string; b: string }>({ a: "", b: "" });
  const base = `/orgs/${orgId}/websites/${websiteId}/responsive`;
  const q = useQuery({ queryKey: [...mk.site(orgId, websiteId), "responsive", range], queryFn: ({ signal }) => get<DataEnvelope<{ latest: Resp[]; daily: Array<{ day: string; viewport: string; passed: number; failed: number }>; runs: Array<{ executionId: string; at: string; viewports: string[]; failedViewports: number }> }>>(`${base}?${rangeQs(range)}`, { signal }).then((r) => r.data) });
  const c = useQuery({ queryKey: [...mk.site(orgId, websiteId), "responsive-compare", cmp], enabled: Boolean(cmp.a && cmp.b && cmp.a !== cmp.b), queryFn: ({ signal }) => get<DataEnvelope<{ viewports: Array<{ viewport: string; comparable: boolean; newProblems: string[]; fixedProblems: string[]; a: Resp | null; b: Resp | null }> }>>(`${base}/compare?a=${cmp.a}&b=${cmp.b}`, { signal }).then((r) => r.data) });
  const d = q.data;
  const days = [...new Set((d?.daily ?? []).map((x) => x.day))];
  const runOpts: Array<[string, string]> = [["", "Choose a check"], ...(d?.runs ?? []).map((r) => [r.executionId, `${fmtTime(r.at)} · ${r.viewports.length} vp${r.failedViewports ? ` · ${r.failedViewports} failing` : ""}`] as [string, string])];
  return (
    <div className="grid gap-5">
      <Card className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Smartphone className="h-4 w-4" aria-hidden />Layout checks from synthetic browser runs at each configured viewport.</p>
        <RangePicker value={range} onChange={setRange} />
      </Card>
      <QueryState q={q}>
        {d && (!d.latest.length ? <Card><EmptyState icon={<Smartphone />} title="No responsive results in this range." description="Responsive checks run with browser monitoring." /></Card> : (
          <div className="grid gap-5">
            <Section title="Latest per viewport" icon={<MonitorSmartphone />} flush description="Problems fail the check; heuristics are shown for review and never alert on their own. Synthetic: one Chromium per viewport.">
              <Table>
                <THead><TR><TH>Viewport</TH><TH>Result</TH><TH>Navigation</TH><TH className="hidden md:table-cell">Overflow</TH><TH className="hidden md:table-cell">Covered / off-screen controls</TH><TH className="hidden lg:table-cell">Problems</TH><TH className="hidden xl:table-cell">Heuristics</TH></TR></THead>
                <TBody>{d.latest.map((r) => (
                  <TR key={r.viewport}>
                    <TD className="text-xs"><span className="font-medium">{r.viewport}</span> <span className="text-muted-foreground tabular-nums">{r.width}×{r.height}</span><div className="text-muted-foreground">{fmtTime(r.at)}</div></TD>
                    <TD><Badge tone={r.status === "FAILED" ? "danger" : "success"}>{r.status === "FAILED" ? "Problems" : "OK"}</Badge></TD>
                    <TD className="text-xs">{NAV[r.navState ?? "NONE"] ?? r.navState}</TD>
                    <TD className="hidden tabular-nums md:table-cell">{r.overflowPx ? `${r.overflowPx}px` : "—"}</TD>
                    <TD className="hidden tabular-nums md:table-cell">{r.obscuredControls} / {r.offscreenControls}</TD>
                    <TD className="hidden max-w-60 text-xs text-danger lg:table-cell">{r.objective.join("; ") || "—"}</TD>
                    <TD className="hidden max-w-60 text-xs text-muted-foreground xl:table-cell">{r.heuristic.join("; ") || "—"}</TD>
                  </TR>
                ))}</TBody>
              </Table>
            </Section>
            <Section title="Outcomes per day" icon={<BarChart3 />} description="Checks per viewport and day: green passed, red failed; hatched = no check that day (viewports rotate between checks).">
              {[...new Set(d.daily.map((x) => x.viewport))].map((v) => (
                <div key={v} className="mb-4 last:mb-0"><p className="mb-1 text-xs font-medium">{v}</p>
                  <StackedBars ariaLabel={`Responsive outcomes per day at ${v}`} bars={days.map((day) => { const x = d.daily.find((y) => y.day === day && y.viewport === v); return { t: day, label: `${day}: ${x?.passed ?? 0} passed, ${x?.failed ?? 0} failed`, values: [{ v: x?.passed ?? 0, tone: "success" }, { v: x?.failed ?? 0, tone: "danger" }] }; })} />
                </div>
              ))}
            </Section>
            <Section title="Compare two checks" icon={<GitCompare />} actions={<div className="flex flex-wrap gap-2"><FilterSelect label="Earlier" value={cmp.a} onChange={(a) => setCmp({ ...cmp, a })} options={runOpts} /><FilterSelect label="Later" value={cmp.b} onChange={(b) => setCmp({ ...cmp, b })} options={runOpts} /></div>}>
              {!c.data ? <p className="text-sm text-muted-foreground">Choose two checks to compare their layout results.</p> : (
                <ul className="divide-y divide-border rounded-lg border border-border text-sm">{c.data.viewports.map((v) => (
                  <li key={v.viewport} className="px-3.5 py-2.5"><span className="font-medium">{v.viewport}</span>{" "}
                    {!v.comparable ? <span className="text-xs text-muted-foreground">checked in only one of the two (viewports rotate) — not compared</span>
                      : <>{v.newProblems.map((p) => <Badge key={p} tone="danger" className="mr-1">new: {p}</Badge>)}{v.fixedProblems.map((p) => <Badge key={p} tone="success" className="mr-1">fixed: {p}</Badge>)}{!v.newProblems.length && !v.fixedProblems.length && <span className="text-xs text-muted-foreground">no change in problems</span>}</>}
                  </li>
                ))}</ul>
              )}
            </Section>
          </div>
        ))}
      </QueryState>
      <Hint>Per-check details (functional tests, screenshots) are on each browser check. <Link className="text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}?tab=performance&section=browser`}>Browser checks</Link> · deep-scan pages: {SCAN_STATUS.COMPLETED.label.toLowerCase()} scans only mark pages removed.</Hint>
    </div>
  );
}
