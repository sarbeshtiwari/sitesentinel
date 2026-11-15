"use client";
import { Alert, Badge, Button, cn, PageHeader, toast } from "@wim/ui";
import { ArrowLeft, Bell, ExternalLink, FileText, History, ListTree } from "lucide-react";
import { describeBrowserFailure, describeHttpFailure } from "@wim/core";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { Hint, KeyValue, QueryState, Section } from "@/components/monitoring";
import { errorMessage, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmtDuration, fmtTime, INCIDENT_STATUS, mk, SEVERITY_TONE, SOURCE_LABEL, useIncident } from "@/lib/monitoring";

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Incident opened", OCCURRED: "Detected again", ACKNOWLEDGED: "Acknowledged", INVESTIGATING: "Investigating", ESCALATED: "Escalated",
  SEVERITY_CHANGED: "Severity changed", RESOLVED: "Resolved", AUTO_RESOLVED: "Recovered automatically", REOPENED: "Reopened", IGNORED: "Ignored", COMMENTED: "Comment",
  FLAPPING_STARTED: "Flapping detected", FLAPPING_ENDED: "Flapping ended",
};

/** Customer wording for an occurrence's failure code (e.g. NO_ADDRESSES), same vocabulary as the monitoring results. */
function describeOccurrence(source: string | null | undefined, details: Record<string, unknown>): string {
  const raw = details.kind ?? details.failureKind ?? details.category;
  if (typeof raw !== "string" || !raw) return "";
  const text = source === "HTTP" ? describeHttpFailure(raw) : source === "BROWSER" ? describeBrowserFailure(raw) : null;
  // Unknown codes fall back to the generic "… failed" wording in core; show the code readably instead of hiding it.
  return text && !/^(Check|Browser check) failed$/.test(text) ? text : raw.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export default function IncidentPage() {
  const { orgId, can } = useOrg();
  const { incidentId } = useParams<{ incidentId: string }>();
  const q = useIncident(orgId, incidentId);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // a double click sends one request; the API is idempotent as well
  const i = q.data;
  const acknowledge = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const r = await post<{ data: { changed: boolean } }>(`/orgs/${orgId}/incidents/${incidentId}/acknowledge`);
      toast.success(r.data.changed ? "Incident acknowledged" : "Already acknowledged");
      await qc.invalidateQueries({ queryKey: mk.incident(orgId, incidentId) });
      await qc.invalidateQueries({ queryKey: ["org", orgId, "mon", "incidents"] });
    } catch (e) { toast.error(errorMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const active = i && i.status !== "RESOLVED" && i.status !== "IGNORED";
  const resolvedAt = (i as { resolvedAt?: string | null } | undefined)?.resolvedAt ?? null;
  const st = i ? INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const } : null;

  return (
    <>
      <div className="mb-3 text-sm"><Link href={`/o/${orgId}/incidents`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Incidents</Link></div>
      <QueryState q={q} skeleton="h-96">
        {i && st && (
          <>
            <PageHeader
              eyebrow={<span className="flex flex-wrap items-center gap-2"><Badge tone={st.tone}>{st.label}</Badge><Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge><span>{i.websiteName ?? "Website"} · {SOURCE_LABEL[i.source ?? ""] ?? i.source}</span></span>}
              title={`INC-${i.number} · ${i.title}`} description={i.description}
              actions={can("incident:write") && (i.status === "OPEN" || i.status === "REOPENED") ? <Button onClick={acknowledge} loading={busy} disabled={busy}>{busy ? "Acknowledging…" : "Acknowledge"}</Button> : undefined} />
            <div className="grid gap-5">
              {active ? (
                <Alert tone="danger" title={i.status === "ACKNOWLEDGED" ? "Ongoing — acknowledged by your team" : "Ongoing problem"}>
                  Monitoring will mark this incident recovered automatically once checks pass again; acknowledging only tells your team someone is on it.
                </Alert>
              ) : (
                <Alert tone="success" title="Recovered">Resolved {fmtTime(resolvedAt)}{i.autoResolved ? " automatically after checks passed again" : ""}.</Alert>
              )}
              <Section title="Summary" icon={<FileText />}>
                <KeyValue items={[
                  ["Website", <Link key="w" className="font-medium text-primary hover:underline" href={`/o/${orgId}/websites/${i.websiteId}`}>{i.websiteName ?? "Website"}</Link>],
                  ["Detected by", SOURCE_LABEL[i.source ?? ""] ?? i.source], ["Category", <span key="c" className="capitalize">{i.category.replaceAll("_", " ").toLowerCase()}</span>],
                  ["First detected", fmtTime(i.firstDetectedAt)], ["Latest occurrence", fmtTime(i.lastDetectedAt)], ["Occurrences", <span key="o" className="tabular-nums">{i.occurrenceCount}</span>],
                  ["Duration", `${fmtDuration((i as { durationSec?: number }).durationSec)}${active ? " so far" : ""}`],
                  ["Acknowledged", i.acknowledgedAt ? fmtTime(i.acknowledgedAt) : "—"], ["Times reopened", <span key="r" className="tabular-nums">{i.reopenCount ?? 0}</span>],
                ]} />
              </Section>
              <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
                <Section title="Timeline" icon={<History />}>
                  <ol className="relative ml-1 grid gap-4 border-l border-border pl-5 text-sm">
                    {i.events.map((e, n) => (
                      <li key={n} className="relative">
                        <span aria-hidden className={cn("absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-card", e.type === "AUTO_RESOLVED" || e.type === "RESOLVED" ? "bg-success" : e.type === "CREATED" || e.type === "REOPENED" ? "bg-danger" : e.type === "ACKNOWLEDGED" ? "bg-warning" : "bg-border-strong")} />
                        <p className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{fmtTime(e.at)}{typeof e.data?.durationSec === "number" ? ` · lasted ${fmtDuration(e.data.durationSec)}` : ""}</p>
                      </li>
                    ))}
                  </ol>
                </Section>
                <Section title="Occurrences" icon={<ListTree />} description="Most recent first (up to 50). Each links to the monitoring result that detected it." flush>
                  {!i.occurrences.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No occurrences recorded.</p> : (
                    <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto text-sm">
                      {i.occurrences.map((o, n) => (
                        <li key={n} className="flex items-start justify-between gap-3 px-4 py-2.5 sm:px-5">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">{describeOccurrence(i.source, o.details)}</p>
                            <p className="text-xs text-muted-foreground tabular-nums">{fmtTime(o.at)}</p>
                            {o.url && <p className="break-all text-xs text-muted-foreground">{o.url}</p>}
                          </div>
                          {o.link && <Link className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline" href={`/o/${orgId}${o.link}`}>View result<ExternalLink className="h-3 w-3" aria-hidden /></Link>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </div>
              <Section title="Notifications" icon={<Bell />} description="Delivery summary for this incident (no recipient details).">
                {!i.notifications?.length ? <p className="text-sm text-muted-foreground">No notifications were sent for this incident.</p> : (
                  <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                    {i.notifications.map((n, k) => (
                      <li key={k} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span>{n.event} · {n.channel.toLowerCase()} · {n.status.toLowerCase()} <span className="tabular-nums">×{n.count}</span></span>
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtTime(n.lastAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {i.notifiedMe && <p className="mt-2 text-xs text-muted-foreground">You received an in-app notification about this incident.</p>}
              </Section>
              <Hint>Monitoring results are immutable. Recovery is decided by the monitoring engine from new results, not set manually.</Hint>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
