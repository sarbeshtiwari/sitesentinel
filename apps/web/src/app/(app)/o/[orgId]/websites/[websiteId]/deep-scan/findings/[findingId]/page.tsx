"use client";
import { Button, buttonVariants, Card, cn, SeverityBadge, StatusPill, toast } from "@wim/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Copy, ExternalLink, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { DataEnvelope } from "@wim/contracts";
import { Hint, QueryState } from "@/components/monitoring";
import { get } from "@/lib/api";
import { useOrgId } from "@/lib/hooks";
import { fmtTime, mk } from "@/lib/monitoring";
import { findingReason, GROUP_LABEL, type FindingDto } from "../../../deepscan-tab";

const METHOD: Record<string, string> = { HTTP: "HTTP request", HTML_ANALYSIS: "Static HTML analysis", SITEMAP: "Sitemap analysis", ROBOTS: "robots.txt", BROWSER: "Rendered in a browser", SEARCH_PROBE: "Test query through the site's search form" };
const EVENT: Record<string, string> = { OPENED: "Detected", RECURRED: "Detected again", REOPENED: "Reappeared after being fixed", RESOLVED: "Fixed (not found by a complete scan)" };
const pathOf = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("px-5 py-4", className)}>
      <h2 className="mb-2 text-[15px] font-semibold tracking-tight">{title}</h2>
      {children}
    </Card>
  );
}

export default function FindingPage() {
  const orgId = useOrgId();
  const { websiteId, findingId } = useParams<{ websiteId: string; findingId: string }>();
  const q = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "finding", findingId],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto & { history: Array<{ type: string; executionId: string; at: string }> }>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan/findings/${findingId}`, { signal }).then((r) => r.data),
  });
  const f = q.data;
  // Other open findings of the same problem type (same category) on this website.
  const same = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "findings", "same-category", f?.category],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto[]>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan/findings?${new URLSearchParams({ status: "OPEN", category: f!.category, limit: "100" })}`, { signal }).then((r) => r.data),
    enabled: Boolean(f && /^[A-Z_]{3,40}$/.test(f.category)),
  });
  const others = (same.data ?? []).filter((x) => x.id !== findingId);
  const evidence = f ? Object.entries(f.evidence).filter(([k]) => k !== "impact") : [];
  const reason = f ? findingReason(f.evidence) : null;
  const safeUrl = f && /^https?:\/\//i.test(f.subject) ? f.subject : null;
  const issuesHref = `/o/${orgId}/websites/${websiteId}?tab=issues`;
  const copy = async () => {
    if (!f) return;
    try { await navigator.clipboard.writeText(f.subject); toast.success("URL copied"); } catch { toast.error("Couldn't copy — select the text and copy it manually"); }
  };
  return (
    <div className="pb-20 sm:pb-0">
      <div className="mb-3"><Link href={issuesHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Issues</Link></div>
      <QueryState q={q} skeleton="h-96">
        {f && (
          <>
            <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-[13px] text-muted-foreground">Deep scan finding</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h1 className="break-words text-[24px] font-semibold leading-tight tracking-[-0.02em] sm:text-[28px]">{f.title}</h1>
                  <SeverityBadge severity={f.severity} />
                  <StatusPill tone={f.status === "OPEN" ? "warning" : "success"}>{f.status === "OPEN" ? "Open" : "Resolved"}</StatusPill>
                </div>
                <p className="mt-1 break-all text-sm text-muted-foreground">{pathOf(f.subject)} · {GROUP_LABEL[f.group] ?? f.group} · first seen {fmtTime(f.firstDetectedAt)}</p>
              </div>
              <div className="hidden shrink-0 gap-2 sm:flex">
                <Button variant="secondary" onClick={copy}><Copy /> Copy URL</Button>
                {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary" })}><ExternalLink /> Open URL<span className="sr-only"> (opens in a new tab)</span></a>}
              </div>
            </header>
            {reason && <p className="mb-5 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium">{reason}</p>}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="grid min-w-0 content-start gap-5">
                {f.impact && <Panel title="Why it matters"><p className="text-sm leading-relaxed">{f.impact}</p></Panel>}
                <section className="rounded-lg bg-success-soft px-5 py-4">
                  <h2 className="mb-2 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-success-text"><Wrench className="h-4 w-4" aria-hidden />How to fix it</h2>
                  <p className="text-sm leading-relaxed">{f.recommendation}</p>
                </section>
                <Panel title="What the scanner recorded">
                  <dl className="divide-y divide-border text-sm">
                    {([["Where", <span key="w" className="break-all font-mono text-xs">{f.subject}</span>], ["Detection", METHOD[f.detectionMethod] ?? f.detectionMethod],
                      ["First detected", fmtTime(f.firstDetectedAt)], ["Last detected", fmtTime(f.lastDetectedAt)], ["Times seen", f.occurrenceCount], ["Resolved", f.resolvedAt ? fmtTime(f.resolvedAt) : "—"]] as Array<[string, React.ReactNode]>)
                      .concat(evidence.map(([k, v]) => [k.replace(/([A-Z])/g, " $1").toLowerCase(),
                        <span key={k} className="break-all font-mono text-xs">{Array.isArray(v) ? v.slice(0, 50).map((x) => <span className="block" key={String(typeof x === "object" ? JSON.stringify(x) : x)}>{typeof x === "object" ? JSON.stringify(x) : String(x)}</span>) : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}</span>]))
                      .map(([k, v]) => (
                        <div key={k} className="grid gap-1 py-2 sm:grid-cols-[10rem_1fr]">
                          <dt className="text-xs font-medium text-muted-foreground first-letter:uppercase">{k}</dt>
                          <dd className="min-w-0">{v}</dd>
                        </div>
                      ))}
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">No page content is stored.</p>
                  {f.group === "accessibility" && <div className="mt-3"><Hint>Automated accessibility check — useful signal, not a WCAG conformance assessment.</Hint></div>}
                </Panel>
              </div>
              <div className="grid min-w-0 content-start gap-5">
                <Panel title="History">
                  <ol className="relative grid gap-4 border-l border-border pl-5 text-sm">
                    {f.history.map((h, i) => (
                      <li key={i} className="relative">
                        <span aria-hidden className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card ${h.type === "RESOLVED" ? "bg-success" : h.type === "REOPENED" ? "bg-danger" : "bg-warning"}`} />
                        <p className="font-medium">{EVENT[h.type] ?? h.type}</p>
                        <p className="text-xs text-muted-foreground">{fmtTime(h.at)} · <Link className="text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}/deep-scan/scans/${h.executionId}`}>scan</Link></p>
                      </li>
                    ))}
                  </ol>
                </Panel>
                {others.length > 0 && (
                  <Panel title={`Same problem on ${others.length} more URL${others.length === 1 ? "" : "s"}`}>
                    <ul className="grid gap-1">
                      {others.slice(0, 20).map((x) => <li key={x.id}><Link className="break-all font-mono text-xs text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}/deep-scan/findings/${x.id}`}>{pathOf(x.subject)}</Link></li>)}
                    </ul>
                    {others.length > 20 && <Link className="mt-2 block text-xs text-primary hover:underline" href={issuesHref}>All {others.length + 1} in Issues</Link>}
                  </Panel>
                )}
              </div>
            </div>
            {/* phone: actions stay reachable at the bottom */}
            <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 grid grid-cols-2 gap-2 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:hidden">
              <Link href={issuesHref} className={buttonVariants({ variant: "secondary" })}>All issues</Link>
              <Button onClick={copy}><Copy /> Copy URL</Button>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
