"use client";
import { Alert, Badge, Button, MetricCard, PageHeader } from "@wim/ui";
import { CalendarCheck, ChevronLeft, Clock, FlaskConical, Image as ImageIcon, MonitorSmartphone, MousePointerClick, RotateCw, Smartphone } from "lucide-react";
import { describeBrowserFailure } from "@wim/core";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { ArtifactLinkDto, BrowserViewportResultDto, DataEnvelope, FunctionalTestDto, ResponsiveResultDto } from "@wim/contracts";
import { Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { Hint, KeyValue, QueryState, Section } from "@/components/monitoring";
import { ApiError, get } from "@/lib/api";
import { useOrgId } from "@/lib/hooks";
import { fmtBytes, fmtMs, fmtTime, outcome, useBrowserResult } from "@/lib/monitoring";

type Issue = { message?: string; source?: string | null; count?: number; signature?: string };
type NetIssue = { host?: string; type?: string; error?: string; status?: number; count?: number; firstParty?: boolean };
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export default function BrowserExecutionPage() {
  const orgId = useOrgId();
  const { websiteId, executionId } = useParams<{ websiteId: string; executionId: string }>();
  const q = useBrowserResult(orgId, websiteId, executionId);
  const r = q.data;
  return (
    <>
      <div className="mb-3"><Link href={`/o/${orgId}/websites/${websiteId}?tab=browser`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Browser monitoring</Link></div>
      <QueryState q={q} skeleton="h-96">
        {r && (
          <>
            <PageHeader eyebrow={<span className="inline-flex items-center gap-1.5"><FlaskConical className="h-3.5 w-3.5" aria-hidden />Synthetic browser check</span>} title={`Browser check · ${fmtTime(r.windowStart)}`}
              description="Synthetic measurement: one Chromium through our egress gateway, without a real visitor's cache, device or network."
              actions={<Badge tone={outcome(r.outcome).tone}>{outcome(r.outcome).label}</Badge>} />
            <div className="grid gap-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard label="Started window" value={<span className="text-base">{fmtTime(r.windowStart)}</span>} icon={<Clock />} />
                <MetricCard label="Recorded" value={<span className="text-base">{fmtTime(r.recordedAt)}</span>} icon={<CalendarCheck />} />
                <MetricCard label="Attempt" value={r.attempt} icon={<RotateCw />} />
                <MetricCard label="Viewports" value={r.viewports.length} icon={<MonitorSmartphone />} tone="brand" />
              </div>
              {r.responsive && r.responsive.length > 0 && <ResponsiveMatrix rows={r.responsive} />}
              {r.functional && r.functional.length > 0 && <FunctionalTests rows={r.functional} />}
              {r.viewports.map((v) => <ViewportCard key={v.viewport} orgId={orgId} v={v} />)}
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}

function ViewportCard({ orgId, v }: { orgId: string; v: BrowserViewportResultDto }) {
  const nav = (v.navigation ?? {}) as Record<string, any>;
  const rend = (v.rendering ?? {}) as Record<string, any>;
  const scripts = (v.scripts ?? {}) as Record<string, unknown>;
  const net = (v.network ?? {}) as Record<string, any>;
  const p = v.syntheticPerformance;
  const blank = v.failureKind === "BLANK_PAGE";
  return (
    <Section title={`${v.viewport}${v.width ? ` · ${v.width}×${v.height}` : ""}`} icon={<MonitorSmartphone />} description={v.failureDescription ?? "No problem detected"}
      actions={<Badge tone={outcome(v.outcome).tone}>{outcome(v.outcome).label}</Badge>}>
      <div className="grid gap-5">
        <KeyValue items={[
          ["Navigation", nav.error ? `Failed: ${describeBrowserFailure(String(nav.error))}` : "Loaded"], ["Main document status", nav.mainStatus ?? "—"], ["Redirects", nav.redirects ?? 0],
          ["Final URL", <span key="u" className="break-all">{nav.finalUrl ?? "—"}</span>],
          ["Readiness", nav.readiness ? `${nav.readiness.strategy} · ${nav.readiness.met ? "met" : "not met"} (${fmtMs(nav.readiness.ms)})` : "—"],
          ["Duration", fmtMs(nav.durationMs)],
          ["Blank page", blank ? "Yes — no visible content" : v.rendering ? "No" : "—"],
          ["Visible text", rend.textLength ?? "—"], ["Broken images", arr(rend.brokenImages).length], ["Failed fonts", rend.failedFonts ?? 0],
          ["Failed stylesheets", rend.failedStylesheets ?? 0],
          ["Layout overflow", v.layout ? (v.layout.horizontalOverflowPx > 4 ? `${v.layout.horizontalOverflowPx} px horizontal scroll` : "None") : "—"],
          ["Popup on load", <span key="ov" data-testid={`overlay-${v.viewport}`}>{overlayLine(v.overlay)}</span>],
          ...(v.dialogs?.count ? [["JavaScript dialogs", <span key="dl" className="break-words">{`${v.dialogs.count} (${[...new Set(v.dialogs.items.map((d) => d.type))].join(", ") || "dialog"}) — dismissed, never accepted${v.dialogs.items[0]?.message ? `: “${v.dialogs.items[0].message}”` : ""}`}</span>] as [string, React.ReactNode]] : []),
        ]} />
        <div className="border-t border-border pt-4">
          <SubHeading>Synthetic performance <Badge tone="info" className="ml-1">Lab, not real users</Badge></SubHeading>
          {p ? (
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-6">
              {([["FCP", fmtMs(p.fcpMs)], ["LCP", fmtMs(p.lcpMs)], ["CLS", p.cls?.toFixed(3) ?? "—"], ["TBT", fmtMs(p.tbtMs)], ["TTFB", fmtMs(p.ttfbMs)], ["Load", fmtMs(p.loadMs)]] as const).map(([k, val]) => (
                <div key={k} className="bg-card px-3 py-2"><p className="text-xs text-muted-foreground">{k}</p><p className="mt-0.5 text-sm font-semibold tabular-nums">{val}</p></div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Not measured (the page did not load).</p>}
          {p && <p className="mt-1 text-xs text-muted-foreground">{p.requests ?? 0} requests · {fmtBytes(p.transferBytes)} transferred. Not real-user Core Web Vitals.</p>}
        </div>
        <IssueList title="JavaScript exceptions" items={arr<Issue>(scripts.exceptions)} />
        <IssueList title="Unhandled promise rejections" items={arr<Issue>(scripts.rejections)} />
        <IssueList title="Console errors" items={arr<Issue>(scripts.consoleErrors)} />
        <NetList title="Failed requests" items={arr<NetIssue>(net.failed)} />
        <NetList title="HTTP errors on resources" items={arr<NetIssue>(net.httpErrors)} />
        {arr<{ src: string }>(rend.brokenImages).length > 0 && (
          <div><SubHeading>Broken images</SubHeading>
            <ul className="grid gap-1 text-xs">{arr<{ src: string }>(rend.brokenImages).map((b, i) => <li key={i} className="break-all">{b.src}</li>)}</ul></div>
        )}
        {v.artifacts.map((a) => <Screenshot key={a.id} orgId={orgId} artifact={a} />)}
      </div>
    </Section>
  );
}

/** One honest line: what covered the page on load at this viewport and what closing it did. */
function overlayLine(o: BrowserViewportResultDto["overlay"]): string {
  if (!o) return "—";
  if (!o.found) return "None detected";
  return o.summary ?? "Detected";
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 flex flex-wrap items-center gap-1 text-sm font-semibold">{children}</h3>;
}

function IssueList({ title, items }: { title: string; items: Issue[] }) {
  if (!items.length) return null;
  return (
    <div>
      <SubHeading>{title} <span className="font-normal tabular-nums text-muted-foreground">({items.reduce((a, b) => a + (b.count ?? 1), 0)})</span></SubHeading>
      <ul className="grid gap-1">{items.map((x, i) => <li key={x.signature ?? i} className="rounded-md border border-border bg-sunken px-2.5 py-1.5 font-mono text-xs"><span className="break-all">{x.message}</span>{x.count && x.count > 1 ? ` ×${x.count}` : ""}{x.source ? <span className="text-muted-foreground"> · {x.source}</span> : null}</li>)}</ul>
    </div>
  );
}
function NetList({ title, items }: { title: string; items: NetIssue[] }) {
  if (!items.length) return null;
  return (
    <div>
      <SubHeading>{title}</SubHeading>
      <ul className="grid gap-1 rounded-md border border-border bg-sunken px-2.5 py-1.5 text-xs">{items.map((x, i) => <li key={i}>{x.type ?? "resource"} from {x.host ?? "unknown host"}{x.firstParty === false ? " (third party)" : ""}: {x.status ?? x.error}{x.count && x.count > 1 ? ` ×${x.count}` : ""}</li>)}</ul>
    </div>
  );
}

/** Screenshots are fetched only on demand, through a fresh 5-minute signed link; never cached by us. */
function Screenshot({ orgId, artifact }: { orgId: string; artifact: { id: string; purpose: string | null; bytes: number; expiresAt: string } }) {
  const [state, setState] = useState<{ url?: string; error?: string; loading?: boolean }>({});
  const expired = new Date(artifact.expiresAt).getTime() <= Date.now();
  const load = async () => {
    setState({ loading: true });
    try {
      const r = await get<DataEnvelope<ArtifactLinkDto>>(`/orgs/${orgId}/artifacts/${artifact.id}/link`);
      const u = new URL(r.data.url);
      setState({ url: `${u.pathname}${u.search}` });
    } catch (e) {
      setState({ error: e instanceof ApiError && e.status === 410 ? "This screenshot has expired under the retention policy." : "The screenshot is not available." });
    }
  };
  return (
    <div className="grid gap-2 border-t border-border pt-4">
      <SubHeading>Screenshot <span className="font-normal text-muted-foreground">({(artifact.purpose ?? "capture").toLowerCase()}, {fmtBytes(artifact.bytes)})</span></SubHeading>
      {expired ? <Alert title="Screenshot expired">Screenshots are kept until {fmtTime(artifact.expiresAt)} under your retention policy.</Alert>
        : state.error ? <Alert tone="warning" title={state.error}><Button size="sm" variant="outline" className="mt-1 justify-self-start" onClick={load}>Try again</Button></Alert>
        : state.url ? <img src={state.url} alt={`Screenshot of the page (${(artifact.purpose ?? "capture").toLowerCase()})`} className="max-h-[32rem] w-auto max-w-full rounded-md border border-border shadow-xs" referrerPolicy="no-referrer" onError={() => setState({ error: "The screenshot couldn't be loaded — the link may have expired or storage is temporarily unavailable." })} />
        : <div><Button size="sm" variant="outline" onClick={load} disabled={state.loading}><ImageIcon />{state.loading ? "Loading…" : "Show screenshot"}</Button></div>}
      <Hint>Form fields and configured areas are masked before capture. Links expire after 5 minutes.</Hint>
    </div>
  );
}

const NAV_STATE: Record<string, string> = { VISIBLE: "Visible", COLLAPSED_OK: "Menu opens", BROKEN: "Menu broken", MISSING: "Not reachable", NONE: "—" };
const TEST_TONE: Record<string, "success" | "danger" | "neutral" | "warning"> = { PASSED: "success", FAILED: "danger", SKIPPED: "neutral", INCONCLUSIVE: "neutral" };
const KIND: Record<string, string> = { SEARCH: "Search", NAVIGATION: "Navigation", FORM: "Form validation", BUTTON: "Button", RESPONSIVE_NAV: "Mobile menu" };

function ResponsiveMatrix({ rows }: { rows: ResponsiveResultDto[] }) {
  return (
    <Section title="Responsive matrix" icon={<Smartphone />} flush description="Layout checks at each viewport rendered in this run (synthetic). Objective problems fail the check; heuristics are shown for review.">
      <Table>
        <THead><TR><TH>Viewport</TH><TH>Result</TH><TH>Navigation</TH><TH className="hidden md:table-cell">Overflow</TH><TH className="hidden md:table-cell">Controls covered / off-screen</TH><TH className="hidden lg:table-cell">Findings</TH></TR></THead>
        <TBody>
          {rows.map((x) => (
            <TR key={x.viewport}>
              <TD className="text-xs"><span className="font-medium">{x.viewport}</span> <span className="text-muted-foreground tabular-nums">{x.width}×{x.height}</span></TD>
              <TD><Badge tone={x.status === "FAILED" ? "danger" : "success"}>{x.status === "FAILED" ? "Problems" : "OK"}</Badge></TD>
              <TD className="text-xs">{NAV_STATE[x.navState ?? "NONE"] ?? x.navState}</TD>
              <TD className="hidden tabular-nums md:table-cell">{x.overflowPx ? `${x.overflowPx}px` : "—"}</TD>
              <TD className="hidden tabular-nums md:table-cell">{x.obscuredControls} / {x.offscreenControls}</TD>
              <TD className="hidden max-w-80 text-xs lg:table-cell">{[...x.objective, ...x.heuristic.map((h) => `${h} (heuristic)`)].join("; ") || "—"}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Section>
  );
}

function FunctionalTests({ rows }: { rows: FunctionalTestDto[] }) {
  const n = (o: string) => rows.filter((r) => r.outcome === o).length;
  return (
    <Section title="Functional tests" icon={<MousePointerClick />} flush description={`${n("PASSED")} passed · ${n("FAILED")} failed · ${n("SKIPPED")} skipped · ${n("INCONCLUSIVE")} inconclusive. Forms are never submitted; actions that could buy, delete, log out or send data are never performed.`}>
      <Table>
        <THead><TR><TH>Test</TH><TH>Target</TH><TH>Result</TH><TH className="hidden md:table-cell">Reason</TH></TR></THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              <TD className="text-xs"><span className="font-medium">{KIND[r.kind] ?? r.kind}</span><div className="text-muted-foreground">{r.viewport}</div></TD>
              <TD className="max-w-64 break-words text-xs">{r.target}</TD>
              <TD><Badge tone={TEST_TONE[r.outcome]}>{r.outcome.toLowerCase()}</Badge>{r.safety === "UNSAFE" && <span className="ml-1 text-xs text-muted-foreground">(unsafe)</span>}</TD>
              <TD className="hidden max-w-72 text-xs text-muted-foreground md:table-cell">{r.reason ?? "—"}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <div className="border-t border-border px-4 py-3 sm:px-5"><Hint>Skipped and inconclusive tests never count against your website: they mean the action wasn't safe to perform, or our infrastructure couldn't complete it.</Hint></div>
    </Section>
  );
}
