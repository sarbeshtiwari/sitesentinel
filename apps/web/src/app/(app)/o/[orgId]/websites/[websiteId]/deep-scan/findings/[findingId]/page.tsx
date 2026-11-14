"use client";
import { Badge, PageHeader } from "@wim/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileCode, History, Info, Search, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { DataEnvelope } from "@wim/contracts";
import { Hint, KeyValue, QueryState, Section } from "@/components/monitoring";
import { get } from "@/lib/api";
import { useOrgId } from "@/lib/hooks";
import { fmtUtc, mk, SEVERITY_TONE } from "@/lib/monitoring";
import { GROUP_LABEL, type FindingDto } from "../../../deepscan-tab";

const METHOD: Record<string, string> = { HTTP: "HTTP request", HTML_ANALYSIS: "Static HTML analysis", SITEMAP: "Sitemap analysis", ROBOTS: "robots.txt", BROWSER: "Rendered in a browser" };
const EVENT: Record<string, string> = { OPENED: "Detected", RECURRED: "Detected again", REOPENED: "Reappeared after being fixed", RESOLVED: "Fixed (not found by a complete scan)" };

export default function FindingPage() {
  const orgId = useOrgId();
  const { websiteId, findingId } = useParams<{ websiteId: string; findingId: string }>();
  const q = useQuery({
    queryKey: [...mk.deep(orgId, websiteId), "finding", findingId],
    queryFn: ({ signal }) => get<DataEnvelope<FindingDto & { history: Array<{ type: string; executionId: string; at: string }> }>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan/findings/${findingId}`, { signal }).then((r) => r.data),
  });
  const f = q.data;
  const evidence = f ? Object.entries(f.evidence).filter(([k]) => k !== "impact") : [];
  return (
    <>
      <div className="mb-3"><Link href={`/o/${orgId}/websites/${websiteId}?tab=deep-scan`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Deep scans</Link></div>
      <QueryState q={q} skeleton="h-96">
        {f && (
          <>
            <PageHeader eyebrow="Deep scan finding" title={f.title} description={GROUP_LABEL[f.group] ?? f.group}
              actions={<div className="flex gap-2"><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge><Badge tone={f.status === "OPEN" ? "warning" : "success"}>{f.status === "OPEN" ? "Open" : "Resolved"}</Badge></div>} />
            <div className="grid gap-5 lg:grid-cols-3">
              <div className="grid content-start gap-5 lg:col-span-2">
              <Section title="What was detected" icon={<Search />}>
                <KeyValue items={[
                  ["Where", <span key="w" className="break-all">{f.subject}</span>], ["Detection", METHOD[f.detectionMethod] ?? f.detectionMethod],
                  ["First detected", fmtUtc(f.firstDetectedAt)], ["Last detected", fmtUtc(f.lastDetectedAt)], ["Times seen", f.occurrenceCount],
                  ["Resolved", f.resolvedAt ? fmtUtc(f.resolvedAt) : "—"],
                ]} />
                {f.group === "accessibility" && <div className="mt-3"><Hint>Automated accessibility check — useful signal, not a WCAG conformance assessment.</Hint></div>}
              </Section>
              {f.impact && <Section title="Why it matters" icon={<Info />}><p className="text-sm leading-relaxed">{f.impact}</p></Section>}
              <Section title="How to fix it" icon={<Wrench />}><p className="text-sm leading-relaxed">{f.recommendation}</p></Section>
              {evidence.length > 0 && (
                <Section title="Evidence" icon={<FileCode />} description="What the scanner recorded (no page content is stored)." flush>
                  <dl className="divide-y divide-border text-sm">
                    {evidence.map(([k, v]) => (
                      <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[12rem_1fr] sm:px-5">
                        <dt className="text-xs font-medium text-muted-foreground first-letter:uppercase">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                        <dd className="break-all font-mono text-xs">{Array.isArray(v) ? v.slice(0, 50).map((x) => <div key={String(x)}>{typeof x === "object" ? JSON.stringify(x) : String(x)}</div>) : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              )}
              </div>
              <Section title="History" icon={<History />} className="self-start">
                <ol className="relative grid gap-4 border-l border-border pl-5 text-sm">
                  {f.history.map((h, i) => (
                    <li key={i} className="relative">
                      <span aria-hidden className={`absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card ${h.type === "RESOLVED" ? "bg-success" : h.type === "REOPENED" ? "bg-danger" : "bg-warning"}`} />
                      <p className="font-medium">{EVENT[h.type] ?? h.type}</p>
                      <p className="text-xs text-muted-foreground">{fmtUtc(h.at)} · <Link className="text-primary hover:underline" href={`/o/${orgId}/websites/${websiteId}/deep-scan/scans/${h.executionId}`}>scan</Link></p>
                    </li>
                  ))}
                </ol>
              </Section>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
