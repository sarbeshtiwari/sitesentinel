"use client";
import { Alert, Badge, Button, PageHeader, toast } from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { Hint, KeyValue, QueryState, Section } from "@/components/monitoring";
import { errorMessage, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmtDuration, fmtUtc, INCIDENT_STATUS, mk, SEVERITY_TONE, SOURCE_LABEL, useIncident } from "@/lib/monitoring";

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Incident opened", OCCURRED: "Detected again", ACKNOWLEDGED: "Acknowledged", INVESTIGATING: "Investigating", ESCALATED: "Escalated",
  SEVERITY_CHANGED: "Severity changed", RESOLVED: "Resolved", AUTO_RESOLVED: "Recovered automatically", REOPENED: "Reopened", IGNORED: "Ignored", COMMENTED: "Comment",
  FLAPPING_STARTED: "Flapping detected", FLAPPING_ENDED: "Flapping ended",
};

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
      <div className="mb-2 text-sm"><Link href={`/o/${orgId}/incidents`} className="text-muted-foreground hover:underline">← Incidents</Link></div>
      <QueryState q={q} skeleton="h-96">
        {i && st && (
          <>
            <PageHeader title={`INC-${i.number} · ${i.title}`} description={i.description}
              actions={<div className="flex flex-wrap items-center gap-2">
                <Badge tone={st.tone}>{st.label}</Badge><Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                {can("incident:write") && (i.status === "OPEN" || i.status === "REOPENED") && <Button size="sm" onClick={acknowledge} disabled={busy}>{busy ? "Acknowledging…" : "Acknowledge"}</Button>}
              </div>} />
            <div className="grid gap-6">
              {active ? (
                <Alert tone="danger" title={i.status === "ACKNOWLEDGED" ? "Ongoing — acknowledged by your team" : "Ongoing problem"}>
                  Monitoring will mark this incident recovered automatically once checks pass again; acknowledging only tells your team someone is on it.
                </Alert>
              ) : (
                <Alert tone="success" title="Recovered">Resolved {fmtUtc(resolvedAt)}{i.autoResolved ? " automatically after checks passed again" : ""}.</Alert>
              )}
              <Section title="Summary">
                <KeyValue items={[
                  ["Website", <Link key="w" className="hover:underline" href={`/o/${orgId}/websites/${i.websiteId}`}>{i.websiteName ?? "Website"}</Link>],
                  ["Detected by", SOURCE_LABEL[i.source ?? ""] ?? i.source], ["Category", i.category.replaceAll("_", " ").toLowerCase()],
                  ["First detected", fmtUtc(i.firstDetectedAt)], ["Latest occurrence", fmtUtc(i.lastDetectedAt)], ["Occurrences", i.occurrenceCount],
                  ["Duration", `${fmtDuration((i as { durationSec?: number }).durationSec)}${active ? " so far" : ""}`],
                  ["Acknowledged", i.acknowledgedAt ? fmtUtc(i.acknowledgedAt) : "—"], ["Times reopened", i.reopenCount ?? 0],
                ]} />
              </Section>
              <Section title="Timeline">
                <ol className="relative grid gap-3 border-l border-border pl-4 text-sm">
                  {i.events.map((e, n) => (
                    <li key={n}>
                      <span aria-hidden className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${e.type === "AUTO_RESOLVED" || e.type === "RESOLVED" ? "bg-success" : e.type === "CREATED" || e.type === "REOPENED" ? "bg-danger" : "bg-muted-foreground/50"}`} />
                      <p className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
                      <p className="text-xs text-muted-foreground">{fmtUtc(e.at)}{typeof e.data?.durationSec === "number" ? ` · lasted ${fmtDuration(e.data.durationSec)}` : ""}</p>
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="Occurrences" description="Most recent first (up to 50). Each links to the monitoring result that detected it.">
                {!i.occurrences.length ? <p className="text-sm text-muted-foreground">No occurrences recorded.</p> : (
                  <ul className="grid gap-2 text-sm">
                    {i.occurrences.map((o, n) => (
                      <li key={n} className="flex flex-wrap items-baseline gap-2">
                        <span className="text-xs text-muted-foreground">{fmtUtc(o.at)}</span>
                        <span className="text-xs">{String(o.details.kind ?? o.details.failureKind ?? o.details.category ?? "")}</span>
                        {o.url && <span className="break-all text-xs text-muted-foreground">{o.url}</span>}
                        {o.link && <Link className="text-xs hover:underline" href={`/o/${orgId}${o.link}`}>View result</Link>}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Notifications" description="Delivery summary for this incident (no recipient details).">
                {!i.notifications?.length ? <p className="text-sm text-muted-foreground">No notifications were sent for this incident.</p> : (
                  <ul className="grid gap-1 text-sm">
                    {i.notifications.map((n, k) => <li key={k}>{n.event} · {n.channel.toLowerCase()} · {n.status.toLowerCase()} ×{n.count} <span className="text-xs text-muted-foreground">{fmtUtc(n.lastAt)}</span></li>)}
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
