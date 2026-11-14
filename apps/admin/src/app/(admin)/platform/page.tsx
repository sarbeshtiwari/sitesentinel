"use client";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Lock, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { errorMessage, get } from "@/lib/api";

type State = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
const STATE_TONE: Record<State, "success" | "warning" | "danger" | "neutral"> = { HEALTHY: "success", DEGRADED: "warning", UNHEALTHY: "danger", UNKNOWN: "neutral" };
const RING: Record<string, string> = {
  HEALTHY: "text-success bg-[color-mix(in_srgb,var(--success)_11%,transparent)]", DEGRADED: "text-warning bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]",
  UNHEALTHY: "text-danger bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]", UNKNOWN: "text-muted-foreground bg-muted",
};
const StateBadge = ({ s }: { s: string }) => <Badge tone={STATE_TONE[s as State] ?? "neutral"}>{s.toLowerCase()}</Badge>;
interface Dep { ok: boolean; ms?: number; at: string; error?: string }
interface Health {
  evaluatedAt: string | null; evaluatedBy: string | null; snapshotAgeSec: number | null; snapshotStale: boolean;
  components: Array<{ component: string; state: State; lastEvaluatedState: State; reasons: string[]; metrics: Record<string, unknown>; since: string }>;
  workers: Array<{ workerId: string; kind: string; version: string; startedAt: string; heartbeatAgeSec: number; alive: boolean; state: State; activeJobs: number; capacity: number; available: number; processed: number; failed: number; timeouts: number; lastJobAt: string | null; rssMb: number | null; dependencies: Record<string, Dep>; meta: Record<string, unknown> }>;
  openAlerts: Array<{ severity: string; state: string; count: number }>;
  platform: { state: State; customerMonitoring: State; pipeline: State; dependencies: State };
}
interface History { transitions: Array<{ at: string; component: string; from: string; to: string }>; samples: Array<{ bucket: string; kind: string; workers: number; active: number; capacity: number }>; restarts: Array<{ kind: string; n: number }> }
const t = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : "—");
const ago = (sec: number) => (sec < 120 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

/**
 * Platform health: evaluated component states, every worker (alive / processing / dependencies / capacity), history.
 * Operational data only: worker identities, queue numbers, dependency reachability — never customer data.
 */
export default function PlatformHealthPage() {
  const [hours, setHours] = useState("24");
  const q = useQuery({ queryKey: ["ops", "health"], queryFn: ({ signal }) => get<DataEnvelope<Health>>("/ops/health", { signal }).then((r) => r.data), refetchInterval: 30_000 });
  const h = useQuery({ queryKey: ["ops", "history", hours], queryFn: ({ signal }) => get<DataEnvelope<History>>(`/ops/history?hours=${hours}`, { signal }).then((r) => r.data), refetchInterval: 60_000 });
  const d = q.data;
  const critical = d?.openAlerts.filter((a) => a.severity === "CRITICAL").reduce((s, a) => s + a.count, 0) ?? 0;
  const open = d?.openAlerts.reduce((s, a) => s + a.count, 0) ?? 0;
  return (
    <>
      <PageHeader title="Platform health" description={d?.evaluatedAt ? `Evaluated ${t(d.evaluatedAt)} UTC by ${d.evaluatedBy} · refreshes every 30 s` : "Not evaluated yet"} />
      <Alert className="mb-6" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Operational data only</span>}>
        Worker identities, queue numbers and dependency reachability. No customer URLs, content, screenshots, incidents or telemetry.
      </Alert>
      {q.isLoading ? <Skeleton className="h-96" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-6">
          {d.snapshotStale && <Alert tone="danger" title="Health evaluation is not running">The last evaluation is {d.snapshotAgeSec === null ? "missing" : `${ago(d.snapshotAgeSec)} old`}; every component is shown as unknown. Check the scheduler and notification workers (both evaluate).</Alert>}
          <Card data-testid="platform-verdict" className="overflow-hidden">
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-4">
                <span aria-hidden className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", RING[d.platform.state] ?? RING.UNKNOWN)}>{d.platform.state === "HEALTHY" ? <CheckCircle2 className="h-5 w-5" /> : d.platform.state === "UNKNOWN" ? <Activity className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}</span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-lg font-semibold tracking-tight">Platform <StateBadge s={d.platform.state} /></p>
                  <p className="mt-0.5 text-xs text-muted-foreground">The platform verdict asks whether customer websites are being checked; worker rows below show individual processes.</p>
                </div>
              </div>
            </div>
            <dl className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
              {([["Customer monitoring on schedule", d.platform.customerMonitoring], ["Pipeline", d.platform.pipeline], ["Dependencies", d.platform.dependencies]] as const).map(([l, s]) => (
                <div key={l} className="flex items-center justify-between gap-2 bg-sunken px-5 py-3 text-sm"><dt className="text-muted-foreground">{l}</dt><dd><StateBadge s={s} /></dd></div>
              ))}
            </dl>
          </Card>
          {open > 0 && <Alert tone={critical ? "danger" : "warning"} title={`${open} platform alert${open === 1 ? "" : "s"} active${critical ? ` (${critical} critical)` : ""}`}><Link className="underline" href="/alerts">Open alerts</Link></Alert>}
          <section aria-label="Components" className="grid gap-3">
            <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">Components</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {d.components.map((c) => (
                <Card key={c.component} data-testid={`component-${c.component}`} className="grid content-start gap-1.5 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[13px] font-medium">{c.component}</span><StateBadge s={c.state} /></div>
                  <p className="text-xs tabular-nums text-muted-foreground">since {t(c.since)}</p>
                  {c.reasons.length > 0 && <ul className="grid gap-0.5 border-t border-border pt-1.5 text-xs">{c.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul>}
                </Card>
              ))}
            </div>
          </section>
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle>Workers</CardTitle><span className="text-xs tabular-nums text-muted-foreground">{d.workers.filter((w) => w.alive).length} of {d.workers.length} alive</span></CardHeader>
            <Table>
              <THead><TR><TH>Worker</TH><TH>State</TH><TH>Heartbeat</TH><TH className="text-right">Busy / capacity</TH><TH className="text-right">Done / failed / timeouts</TH><TH>Last job</TH><TH>Dependencies</TH><TH className="text-right">Memory</TH></TR></THead>
              <TBody>{d.workers.length ? d.workers.map((w) => (
                <TR key={w.workerId}>
                  <TD className="max-w-56"><div className="truncate font-mono text-xs font-medium">{w.workerId}</div><div className="text-xs text-muted-foreground">{w.kind} · {w.version} · up since {t(w.startedAt)}</div></TD>
                  <TD><StateBadge s={w.state} /></TD>
                  <TD className="whitespace-nowrap text-xs tabular-nums">{ago(w.heartbeatAgeSec)} ago{!w.alive && <div className="text-danger">expired</div>}</TD>
                  <TD className="text-right tabular-nums text-xs">{w.activeJobs}/{w.capacity}</TD>
                  <TD className="text-right tabular-nums text-xs">{w.processed} / {w.failed} / {w.timeouts}</TD>
                  <TD className="whitespace-nowrap text-xs tabular-nums">{t(w.lastJobAt)}</TD>
                  <TD className="text-xs"><div className="flex flex-wrap gap-x-2 gap-y-1">{Object.entries(w.dependencies).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1"><Badge tone={v.ok ? "success" : "danger"}>{k}</Badge><span className="tabular-nums text-muted-foreground">{v.ms != null ? `${v.ms} ms` : ""}{v.error ? ` · ${v.error}` : ""}</span></span>)}</div>{!Object.keys(w.dependencies).length && "—"}
                    {typeof w.meta.runnerSessions === "number" && <div className="text-muted-foreground">runner {String(w.meta.runnerSessions)}/{String(w.meta.runnerMaxSessions)} sessions{w.meta.runnerSandbox === false ? " · SANDBOX OFF" : ""}</div>}</TD>
                  <TD className="whitespace-nowrap text-right tabular-nums text-xs">{w.rssMb ?? "—"} MB</TD>
                </TR>
              )) : <TR><TD colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No workers have registered a heartbeat.</TD></TR>}</TBody>
            </Table>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between gap-2"><div className="grid gap-1"><CardTitle>History</CardTitle><CardDescription>Component state changes and worker restarts</CardDescription></div>
              <Select aria-label="Period" value={hours} onChange={(e) => setHours(e.target.value)} className="h-8 w-36">{[["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></CardHeader>
            {h.isLoading ? <CardContent><Skeleton className="h-32" /></CardContent> : h.data && (
                <>
                  <p className="flex flex-wrap items-center gap-2 border-b border-border bg-sunken/50 px-5 py-2.5 text-xs text-muted-foreground">Restarts: {h.data.restarts.length ? h.data.restarts.map((r) => <Badge key={r.kind} className="font-mono tabular-nums">{r.kind} {r.n}</Badge>) : "none"}</p>
                  <Table>
                    <THead><TR><TH>Time (UTC)</TH><TH>Component</TH><TH>Change</TH></TR></THead>
                    <TBody>{h.data.transitions.length ? h.data.transitions.slice(0, 100).map((x, i) => (
                      <TR key={i}><TD className="whitespace-nowrap text-xs tabular-nums">{t(x.at)}</TD><TD className="font-mono text-xs">{x.component}</TD><TD className="text-xs"><span className="relative inline-flex items-center gap-1.5"><StateBadge s={x.from === "NONE" ? "UNKNOWN" : x.from} /><span aria-hidden className="text-muted-foreground">→</span><span className="sr-only">to</span><StateBadge s={x.to} /></span></TD></TR>
                    )) : <TR><TD colSpan={3} className="py-8 text-center text-sm text-muted-foreground">No state changes in this period.</TD></TR>}</TBody>
                  </Table>
                </>
              )}
          </Card>
        </div>
      )}
    </>
  );
}
