"use client";
import { Badge, buttonVariants, EmptyState, PageHeader } from "@wim/ui";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ExternalLink, FileText, Gauge, Layers, ListChecks, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { DataEnvelope } from "@wim/contracts";
import { Hint, KeyValue, QueryState, Section } from "@/components/monitoring";
import { get } from "@/lib/api";
import { useOrgId } from "@/lib/hooks";
import { fmtTime, mk, SEVERITY_TONE } from "@/lib/monitoring";
import { findingReason, GROUP_LABEL } from "../../deepscan-tab";
import { PageStatusBadge, pathOnly, provenance, ScoreBadge, SCORE_FORMULA_TEXT, SEV_ORDER, SeverityChips, skipText, SOURCE, type PageFacts, type Sev } from "../../pages-tab";

interface PageFinding {
  id: string; category: string; group: string; severity: Sev; status: string; title: string; description: string | null; howToFix: string;
  evidence: Record<string, unknown>; occurrenceCount: number; firstDetectedAt: string; lastDetectedAt: string; resolvedAt: string | null;
}
interface PageDetail extends Omit<PageFacts, "score"> {
  websiteOrigin: string;
  score: { value: number | null; band: string | null; basis: string; penalty: number; bySeverity: Record<Sev, number>; penalties: Record<Sev, number>; formula: string };
  findings: PageFinding[]; resolvedFindings: PageFinding[]; siteWideFindings: PageFinding[];
}

function Evidence({ e }: { e: Record<string, unknown> }) {
  const items = Object.entries(e ?? {}).filter(([k]) => k !== "impact");
  if (!items.length) return null;
  return (
    <dl className="mt-2 grid gap-1 rounded-md bg-sunken px-3 py-2 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="grid gap-x-3 sm:grid-cols-[9rem_1fr]">
          <dt className="font-medium text-muted-foreground first-letter:uppercase">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
          <dd className="break-all font-mono">{Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function FindingItem({ f, href, resolved }: { f: PageFinding; href: string; resolved?: boolean }) {
  return (
    <li className="grid gap-1.5 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={resolved ? "success" : SEVERITY_TONE[f.severity]}>{resolved ? "Fixed" : f.severity}</Badge>
        <Link href={href} className="font-medium hover:text-primary">{f.title}</Link>
        <span className="text-xs text-muted-foreground">{GROUP_LABEL[f.group] ?? f.group}</span>
      </div>
      {!resolved && findingReason(f.evidence) && <p className="text-sm font-medium">{findingReason(f.evidence)}</p>}
      {f.description && <p className="text-sm text-muted-foreground">{f.description}</p>}
      {!resolved && <p className="flex items-start gap-1.5 text-sm"><Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden /><span><span className="font-medium">How to fix: </span>{f.howToFix}</span></p>}
      {!resolved && <Evidence e={f.evidence} />}
      <p className="text-xs text-muted-foreground">
        {resolved ? <>Fixed {fmtTime(f.resolvedAt)} · first detected {fmtTime(f.firstDetectedAt)}</> : <>First seen {fmtTime(f.firstDetectedAt)} · last seen {fmtTime(f.lastDetectedAt)} · seen {f.occurrenceCount}×</>}
      </p>
    </li>
  );
}

export default function PageDetailPage() {
  const orgId = useOrgId();
  const { websiteId, pageId } = useParams<{ websiteId: string; pageId: string }>();
  const q = useQuery({
    queryKey: [...mk.site(orgId, websiteId), "page", pageId],
    queryFn: ({ signal }) => get<DataEnvelope<PageDetail>>(`/orgs/${orgId}/websites/${websiteId}/pages/${encodeURIComponent(pageId)}`, { signal }).then((r) => r.data),
  });
  const p = q.data;
  const findingHref = (id: string) => `/o/${orgId}/websites/${websiteId}/deep-scan/findings/${id}`;
  const safeUrl = p && /^https?:\/\//i.test(p.url) ? p.url : null;
  return (
    <>
      <div className="mb-3"><Link href={`/o/${orgId}/websites/${websiteId}?tab=pages`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Pages</Link></div>
      <QueryState q={q} skeleton="h-96">
        {p && (
          <>
            <PageHeader eyebrow="Page" title={<span className="break-all font-mono text-xl">{p.path}</span>} description={p.title ?? undefined}
              actions={<div className="flex flex-wrap items-center gap-2">
                <ScoreBadge score={p.score.value} band={p.score.band} basis={p.score.basis} />
                <PageStatusBadge p={p} />
                {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}><ExternalLink /> Open page</a>}
              </div>} />
            <div className="grid gap-5 lg:grid-cols-3">
              <div className="grid content-start gap-5 lg:col-span-2">
                <Section title={`Open findings (${p.findings.length})`} icon={<ListChecks />} flush
                  description={p.state === "NOT_CHECKED" ? "This page hasn't been checked yet, so nothing is known about it." : "Problems the last deep scans found on this page, most severe first."}>
                  {p.findings.length === 0
                    ? <div className="p-4 sm:p-5"><EmptyState icon={p.state === "CHECKED" ? <CheckCircle2 /> : <FileText />} title={p.state === "CHECKED" ? "No open findings" : p.state === "NOT_CHECKED" ? "Not checked yet" : "No findings recorded"} description={p.state === "NOT_CHECKED" ? "It will be checked by the next deep scans." : p.state === "SKIPPED" ? `The scan skipped this page: ${skipText(p.skipReason)}.` : "Nothing to fix on this page right now."} /></div>
                    : <ul className="divide-y divide-border">{p.findings.map((f) => <FindingItem key={f.id} f={f} href={findingHref(f.id)} />)}</ul>}
                </Section>
                {p.siteWideFindings.length > 0 && (
                  <Section title="Site-wide findings involving this page" icon={<Layers />} flush description="Shared across several pages (e.g. duplicate titles). Not counted in this page's score.">
                    <ul className="divide-y divide-border">{p.siteWideFindings.map((f) => <FindingItem key={f.id} f={f} href={findingHref(f.id)} />)}</ul>
                  </Section>
                )}
                <Section title={`Fixed in the last 30 days (${p.resolvedFindings.length})`} icon={<CheckCircle2 />} flush>
                  {p.resolvedFindings.length === 0
                    ? <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">Nothing fixed on this page in the last 30 days.</p>
                    : <ul className="divide-y divide-border">{p.resolvedFindings.map((f) => <FindingItem key={f.id} f={f} href={findingHref(f.id)} resolved />)}</ul>}
                </Section>
              </div>
              <div className="grid content-start gap-5">
                <Section title="Score" icon={<Gauge />}>
                  <div className="flex items-baseline gap-2"><span className="text-3xl font-semibold tabular-nums">{p.score.value ?? "—"}</span><span className="text-sm text-muted-foreground">{p.score.value === null ? "not checked yet" : "/ 100"}</span></div>
                  {p.score.basis === "BROKEN" && <p className="mt-1 text-sm text-danger-text">The page doesn&apos;t load{p.httpStatus ? ` (HTTP ${p.httpStatus})` : ""}, so it scores 0.</p>}
                  {p.score.basis === "FINDINGS" && (
                    <table className="mt-3 w-full text-xs">
                      <tbody>
                        {SEV_ORDER.map((s) => (
                          <tr key={s} className="border-b border-border last:border-0">
                            <td className="py-1"><Badge tone={SEVERITY_TONE[s]}>{s}</Badge></td>
                            <td className="py-1 text-right tabular-nums">{p.score.bySeverity[s]} × {p.score.penalties[s]}</td>
                            <td className="py-1 text-right tabular-nums text-muted-foreground">−{p.score.bySeverity[s] * p.score.penalties[s]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mt-3"><Hint>{SCORE_FORMULA_TEXT}</Hint></div>
                  {p.openFindings > 0 && <div className="mt-3"><SeverityChips counts={p.bySeverity} /></div>}
                </Section>
                <Section title="About this page" icon={<FileText />}>
                  <KeyValue items={[
                    ["URL", <span key="u" className="break-all font-mono text-xs">{p.url}</span>],
                    ["Status", <span key="s" className="inline-flex flex-wrap items-center gap-1"><PageStatusBadge p={p} />{p.state === "SKIPPED" && <span className="text-xs text-muted-foreground">{skipText(p.skipReason)}</span>}</span>],
                    ["HTTP status", p.httpStatus ?? "—"],
                    ["Found via", provenance(p).replace(/^Found via /, "")],
                    ["Source", SOURCE[p.source] ?? p.source],
                    ["Linked from", p.firstReferrer ? <span key="r" className="break-all font-mono text-xs">{pathOnly(p.firstReferrer)}</span> : "—"],
                    ["Depth", p.depth],
                    ["Last checked", p.lastCheckedAt ? fmtTime(p.lastCheckedAt) : "Not yet"],
                    ["First seen", fmtTime(p.firstSeenAt)],
                    ["Last seen", fmtTime(p.lastSeenAt)],
                  ]} />
                  {p.lastExecutionId && <p className="mt-3 text-xs"><Link className="text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}/deep-scan/scans/${p.lastExecutionId}`}>View the scan</Link></p>}
                </Section>
              </div>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
