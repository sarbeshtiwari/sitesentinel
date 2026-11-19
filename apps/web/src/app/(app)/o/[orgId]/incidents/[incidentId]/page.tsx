"use client";
import { Alert, Breadcrumbs, Button, Card, cn, SeverityBadge, StatusPill, toast } from "@wim/ui";
import { Bell, CheckCheck, ExternalLink } from "lucide-react";
import { describeBrowserFailure, describeHttpFailure } from "@wim/core";
import type { IncidentDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { Hint, QueryState } from "@/components/monitoring";
import { errorMessage, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmtDuration, fmtMs, fmtTime, INCIDENT_STATUS, mk, SOURCE_LABEL, useIncident } from "@/lib/monitoring";
import { AREA_LABEL, incidentArea } from "../../websites/[websiteId]/website-data";

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

/** Response time of each recorded occurrence (HTTP checks record it); shown only when at least two exist. */
function OccurrenceTrend({ i }: { i: IncidentDetailDto }) {
  const pts = i.occurrences.filter((o) => typeof o.details.totalMs === "number").map((o) => ({ at: o.at, ms: o.details.totalMs as number })).reverse().slice(-24);
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((p) => p.ms)) || 1;
  return (
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Response time at each failed check</h2>
        <span className="text-xs text-muted-foreground">max {fmtMs(max)}</span>
      </div>
      <ol role="img" aria-label={`Response times of the last ${pts.length} occurrences, from ${fmtMs(Math.min(...pts.map((p) => p.ms)))} to ${fmtMs(max)}`} className="mt-4 flex h-32 items-end gap-1.5">
        {pts.map((p) => <li key={p.at} title={`${fmtTime(p.at)}: ${fmtMs(p.ms)}`} className="min-w-0 flex-1 rounded-t-[3px] bg-warning" style={{ height: `${Math.max(4, (p.ms / max) * 100)}%` }} />)}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">Last {pts.length} occurrences · {fmtTime(pts[0]!.at)} – {fmtTime(pts[pts.length - 1]!.at)}</p>
    </Card>
  );
}

function SideCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("px-5 py-4", className)}>
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
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
  const resolvedAt = i?.resolvedAt ?? null;
  const st = i ? INCIDENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const } : null;
  const page = i && typeof i.diagnostics.url === "string" ? i.diagnostics.url : i?.occurrences.find((o) => o.url)?.url ?? null;
  const channels = [...new Set((i?.notifications ?? []).filter((n) => n.status.toUpperCase() !== "FAILED").map((n) => (n.channel === "IN_APP" ? "in-app" : n.channel.toLowerCase())))];

  return (
    <>
      <Breadcrumbs className="mb-4" LinkComponent={Link} items={[{ label: "Issues", href: `/o/${orgId}/incidents` }, { label: i ? `INC-${i.number}` : "Incident" }]} />
      <QueryState q={q} skeleton="h-96">
        {i && st && (
          <>
            <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h1 className="min-w-0 break-words text-[24px] font-medium leading-tight tracking-[-0.02em] sm:text-[28px]">{i.title}</h1>
                  <SeverityBadge severity={i.severity} />
                  <StatusPill tone={st.tone}>{st.label} · {fmtDuration(i.durationSec)}{active ? " so far" : ""}</StatusPill>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  <Link className="hover:text-foreground hover:underline" href={`/o/${orgId}/websites/${i.websiteId}`}>{i.websiteName ?? "Website"}</Link>
                  {" · "}{AREA_LABEL[incidentArea(i)]} · found by {(SOURCE_LABEL[i.source ?? ""] ?? i.source ?? "monitoring").toLowerCase()} checks from our servers · INC-{i.number}
                </p>
              </div>
              {can("incident:write") && (i.status === "OPEN" || i.status === "REOPENED") && (
                <div className="flex shrink-0 gap-2"><Button onClick={acknowledge} loading={busy} disabled={busy}>{!busy && <CheckCheck />}{busy ? "Acknowledging…" : "Acknowledge"}</Button></div>
              )}
            </header>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid min-w-0 content-start gap-5">
                {active ? (
                  <Alert tone="danger" title={i.status === "ACKNOWLEDGED" ? "Ongoing — acknowledged by your team" : "Ongoing problem"}>
                    Monitoring will mark this incident recovered automatically once checks pass again; acknowledging only tells your team someone is on it.
                  </Alert>
                ) : (
                  <Alert tone="success" title="Recovered">Resolved {fmtTime(resolvedAt)}{i.autoResolved ? " automatically after checks passed again" : ""}.</Alert>
                )}
                <Card className="px-5 py-4">
                  <h2 className="text-[15px] font-semibold tracking-tight">What happened</h2>
                  <p className="mt-2 text-[15px] leading-relaxed">{i.description || "No description was recorded for this incident."}</p>
                  {page && <p className="mt-2 break-all text-xs text-muted-foreground">Page: {page}</p>}
                </Card>
                <OccurrenceTrend i={i} />
                <Card className="overflow-hidden">
                  <div className="border-b border-border px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold tracking-tight">Occurrences</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">Most recent first (up to 50). Each links to the monitoring result that detected it.</p>
                  </div>
                  {!i.occurrences.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No occurrences recorded.</p> : (
                    <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto text-sm">
                      {i.occurrences.map((o, n) => (
                        <li key={n} className="flex items-start justify-between gap-3 px-5 py-2.5">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">{describeOccurrence(i.source, o.details)}{typeof o.details.totalMs === "number" ? <span className="font-normal text-muted-foreground"> · {fmtMs(o.details.totalMs)}</span> : null}{typeof o.details.httpStatus === "number" ? <span className="font-normal text-muted-foreground"> · HTTP {o.details.httpStatus}</span> : null}</p>
                            <p className="text-xs text-muted-foreground tabular-nums">{fmtTime(o.at)}</p>
                            {o.url && <p className="break-all text-xs text-muted-foreground">{o.url}</p>}
                          </div>
                          {o.link && <Link className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline" href={`/o/${orgId}${o.link}`}>View result<ExternalLink className="h-3 w-3" aria-hidden /></Link>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              <div className="grid min-w-0 content-start gap-5">
                <SideCard title="Timeline">
                  <ol className="grid gap-3 text-sm">
                    {i.events.map((e, n) => (
                      <li key={n} className="flex gap-2.5">
                        <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", e.type === "AUTO_RESOLVED" || e.type === "RESOLVED" ? "bg-success" : e.type === "CREATED" || e.type === "REOPENED" ? "bg-danger" : e.type === "ACKNOWLEDGED" ? "bg-warning" : "bg-border-strong")} />
                        <div className="min-w-0">
                          <p className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
                          <p className="text-xs text-muted-foreground tabular-nums">{fmtTime(e.at)}{typeof e.data?.durationSec === "number" ? ` · lasted ${fmtDuration(e.data.durationSec)}` : ""}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </SideCard>
                <SideCard title="Details">
                  <dl className="grid gap-2 text-sm">
                    {([
                      ["Website", <Link key="w" className="font-medium text-primary hover:underline" href={`/o/${orgId}/websites/${i.websiteId}`}>{i.websiteName ?? "Website"}</Link>],
                      ["Area", AREA_LABEL[incidentArea(i)]],
                      ["Detected by", SOURCE_LABEL[i.source ?? ""] ?? i.source],
                      ["Category", <span key="c" className="capitalize">{i.category.replaceAll("_", " ").toLowerCase()}</span>],
                      ["First detected", fmtTime(i.firstDetectedAt)],
                      ["Latest occurrence", fmtTime(i.lastDetectedAt)],
                      ["Occurrences", <span key="o" className="tabular-nums">{i.occurrenceCount}</span>],
                      ["Duration", `${fmtDuration(i.durationSec)}${active ? " so far" : ""}`],
                      ["Acknowledged", i.acknowledgedAt ? fmtTime(i.acknowledgedAt) : "—"],
                      ["Times reopened", <span key="r" className="tabular-nums">{i.reopenCount ?? 0}</span>],
                      ["Notified", channels.length ? channels.join(", ") : "—"],
                    ] as Array<[string, React.ReactNode]>).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3"><dt className="shrink-0 text-muted-foreground">{k}</dt><dd className="min-w-0 break-words text-right">{v}</dd></div>
                    ))}
                  </dl>
                </SideCard>
                <SideCard title="Notifications">
                  <p className="-mt-1 mb-2 text-xs text-muted-foreground">Delivery summary for this incident (no recipient details).</p>
                  {!i.notifications?.length ? <p className="text-sm text-muted-foreground">No notifications were sent for this incident.</p> : (
                    <ul className="divide-y divide-border text-sm">
                      {i.notifications.map((n, k) => (
                        <li key={k} className="flex flex-wrap items-center justify-between gap-x-2 py-1.5">
                          <span className="inline-flex items-center gap-1.5"><Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{n.event} · {n.channel.toLowerCase()} · {n.status.toLowerCase()} <span className="tabular-nums">×{n.count}</span></span>
                          <span className="text-xs text-muted-foreground tabular-nums">{fmtTime(n.lastAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {i.notifiedMe && <p className="mt-2 text-xs text-muted-foreground">You received an in-app notification about this incident.</p>}
                </SideCard>
              </div>
            </div>
            <div className="mt-5"><Hint>Monitoring results are immutable. Recovery is decided by the monitoring engine from new results, not set manually.</Hint></div>
          </>
        )}
      </QueryState>
    </>
  );
}
