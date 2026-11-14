"use client";
import { Alert, Badge, Card, PageHeader, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import type { DataEnvelope } from "@wim/contracts";
import { FilterSelect, Hint, KeyValue, LoadMore, QueryState, Section } from "@/components/monitoring";
import { get } from "@/lib/api";
import { useOrgId } from "@/lib/hooks";
import { fmtDuration, fmtUtc, mk } from "@/lib/monitoring";
import { ScanStatusBadge, stopLabel, type ScanDto } from "../../../deepscan-tab";

type Change = { count: number; items: string[] };
interface ScanDetail extends ScanDto {
  discovery: { sitemaps: { fetched?: number; urls?: number; outOfScope?: number } | null; sitemapIssues: number; robotsFound: Record<string, boolean>; spa: unknown[] };
  comparison: (Record<string, Change | unknown> & { baselineExecutionId?: string; currentComplete?: boolean; baselineComplete?: boolean }) | null;
}
interface PageRow { url: string; state: string; skipReason: string | null; depth: number; source: string; status: number | null; title: string | null; canonical: string | null; checkedAt: string | null; linkedFrom: string | null }
const SOURCE: Record<string, string> = { START: "Start page", SITEMAP: "Sitemap", CRAWL: "Link", BROWSER: "Rendered link" };
const CHANGE_LABEL: Record<string, string> = {
  newPages: "New pages", removedPages: "Removed pages", notObservedThisScan: "Not observed this scan", statusChanged: "Status changed", newBrokenPages: "Newly broken",
  recoveredPages: "Recovered", titleChanged: "Title changed", descriptionChanged: "Description changed", canonicalChanged: "Canonical changed",
  newRedirects: "New redirects", removedRedirects: "Removed redirects", contentChanged: "Content changed", structureChanged: "Structure changed",
};

export default function ScanPage() {
  const orgId = useOrgId();
  const { websiteId, executionId } = useParams<{ websiteId: string; executionId: string }>();
  const base = `/orgs/${orgId}/websites/${websiteId}/deep-scan`;
  const q = useQuery({ queryKey: [...mk.deep(orgId, websiteId), "scan", executionId], queryFn: ({ signal }) => get<DataEnvelope<ScanDetail>>(`${base}/scans/${executionId}`, { signal }).then((r) => r.data) });
  const scans = useQuery({ queryKey: [...mk.deep(orgId, websiteId), "scans"], queryFn: ({ signal }) => get<DataEnvelope<ScanDto[]>>(`${base}/scans?limit=20`, { signal }).then((r) => r.data) });
  const [state, setState] = useState("");
  const [compareWith, setCompareWith] = useState("");
  const pages = useInfiniteQuery({
    queryKey: [...mk.deep(orgId, websiteId), "pages", executionId, state],
    queryFn: ({ signal, pageParam }) => get<{ data: PageRow[]; nextAfter: number | null }>(`${base}/scans/${executionId}/pages?${new URLSearchParams({ limit: "50", ...(state ? { state } : {}), ...(pageParam ? { after: String(pageParam) } : {}) })}`, { signal }),
    initialPageParam: 0, getNextPageParam: (l) => l.nextAfter ?? undefined,
  });
  const cmp = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "compare", executionId, compareWith],
    queryFn: ({ signal }) => get<DataEnvelope<Record<string, Change | unknown> & { reliable: boolean }>>(`${base}/scans/${executionId}/compare?base=${compareWith}`, { signal }).then((r) => r.data),
    enabled: Boolean(compareWith),
  });
  const s = q.data;
  const comparison = compareWith ? cmp.data : s?.comparison;
  return (
    <>
      <div className="mb-2 text-sm"><Link href={`/o/${orgId}/websites/${websiteId}?tab=deep-scan`} className="text-muted-foreground hover:underline">← Deep scans</Link></div>
      <QueryState q={q} skeleton="h-96">
        {s && (
          <>
            <PageHeader title={`Deep scan · ${fmtUtc(s.startedAt)}`} description={stopLabel(s.stopReason)} actions={<ScanStatusBadge s={s} />} />
            <div className="grid gap-6">
              {s.status !== "COMPLETED" && s.status !== "RUNNING" && <Alert tone="warning" title="This scan did not check the whole site">Findings were not resolved by it and no page is reported as removed.</Alert>}
              <Section title="Coverage">
                <KeyValue items={[
                  ["Pages discovered", s.coverage.pagesDiscovered], ["Pages checked", s.coverage.pagesChecked], ["Broken (failed)", s.coverage.pagesFailed],
                  ["Skipped by policy", s.coverage.pagesSkippedByPolicy], ["Not crawled (limits)", s.coverage.pagesNotCrawledLimits], ["Inconclusive", s.coverage.pagesInconclusive],
                  ["Resources checked", s.coverage.resourcesChecked], ["Requests", s.requests],
                  ["Duration", s.finishedAt ? fmtDuration(Math.round((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)) : "running"],
                  ["Sitemaps read", s.discovery.sitemaps?.fetched ?? 0], ["robots.txt", Object.values(s.discovery.robotsFound).some(Boolean) ? "Found and respected" : "Not found"],
                  ["Findings", `+${s.findingsOpened} opened · ${s.findingsResolved} resolved`],
                ]} />
              </Section>
              <Section title="Comparison" description={compareWith ? "Page-by-page comparison with the scan you chose." : "Against the previous completed scan, as recorded when this scan finished."}
                actions={<FilterSelect label="Compare with" value={compareWith} onChange={setCompareWith} options={[["", "Previous completed (default)"], ...(scans.data ?? []).filter((x) => x.executionId !== executionId && x.status !== "RUNNING").map((x) => [x.executionId, `${fmtUtc(x.startedAt)} · ${x.status.toLowerCase()}`] as [string, string])]} />}>
                {compareWith && cmp.isLoading ? <p className="text-sm text-muted-foreground">Comparing…</p> : !comparison ? <p className="text-sm text-muted-foreground">No earlier completed scan to compare with.</p> : (
                  <div className="grid gap-3">
                    {compareWith && cmp.data && !cmp.data.reliable && <Hint>One of these scans is not COMPLETED: pages it didn't reach are "not observed", never "removed".</Hint>}
                    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {Object.entries(comparison).filter(([k, v]) => CHANGE_LABEL[k] && typeof v === "object" && v && "count" in (v as object)).map(([k, v]) => {
                        const c = v as Change;
                        return (
                          <li key={k} className="rounded-md border border-border p-3">
                            <p className="text-sm font-medium">{CHANGE_LABEL[k]} <span className="tabular-nums text-muted-foreground">({c.count})</span></p>
                            {c.items.length > 0 && <ul className="mt-1 max-h-32 overflow-auto text-xs text-muted-foreground">{c.items.slice(0, 20).map((i) => <li key={i} className="break-all">{i}</li>)}</ul>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </Section>
              <Section title="Discovered pages" actions={<FilterSelect label="State" value={state} onChange={setState} options={[["", "All"], ["DONE", "Checked"], ["FAILED", "Broken"], ["SKIPPED", "Skipped"], ["QUEUED", "Not reached"], ["INCONCLUSIVE", "Inconclusive"]]} />}>
                <QueryState q={pages}>
                  {!pages.data?.pages[0]?.data.length ? <p className="text-sm text-muted-foreground">No pages match.</p> : (
                    <Card className="overflow-hidden">
                      <Table>
                        <THead><TR><TH>URL</TH><TH>Status</TH><TH className="hidden lg:table-cell">Title</TH><TH className="hidden md:table-cell">Source</TH><TH className="hidden md:table-cell">Depth</TH><TH className="hidden xl:table-cell">Checked</TH></TR></THead>
                        <TBody>
                          {pages.data.pages.flatMap((p) => p.data).map((p) => (
                            <TR key={p.url}>
                              <TD className="max-w-80"><span className="break-all text-xs">{p.url}</span>{p.canonical && <div className="truncate text-xs text-muted-foreground">canonical: {p.canonical}</div>}</TD>
                              <TD>{p.state === "SKIPPED" ? <Badge title={p.skipReason ?? ""}>Skipped</Badge> : p.state === "QUEUED" ? <Badge>Not reached</Badge> : <Badge tone={p.state === "FAILED" ? "danger" : p.state === "DONE" ? "success" : "neutral"}>{p.status ?? p.state}</Badge>}</TD>
                              <TD className="hidden max-w-56 truncate text-xs lg:table-cell">{p.title ?? "—"}</TD>
                              <TD className="hidden text-xs md:table-cell">{SOURCE[p.source] ?? p.source}</TD>
                              <TD className="hidden tabular-nums md:table-cell">{p.depth}</TD>
                              <TD className="hidden text-xs text-muted-foreground xl:table-cell">{fmtUtc(p.checkedAt)}</TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                      <LoadMore q={pages} />
                    </Card>
                  )}
                </QueryState>
              </Section>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
