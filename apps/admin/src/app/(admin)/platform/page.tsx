"use client";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { errorMessage, get } from "@/lib/api";

type State = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
const STATE_TONE: Record<State, "success" | "warning" | "danger" | "neutral"> = { HEALTHY: "success", DEGRADED: "warning", UNHEALTHY: "danger", UNKNOWN: "neutral" };
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
      <Alert className="mb-4" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Operational data only</span>}>
        Worker identities, queue numbers and dependency reachability. No customer URLs, content, screenshots, incidents or telemetry.
      </Alert>
      {q.isLoading ? <Skeleton className="h-96" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-6">
          {d.snapshotStale && <Alert tone="danger" title="Health evaluation is not running">The last evaluation is {d.snapshotAgeSec === null ? "missing" : `${ago(d.snapshotAgeSec)} old`}; every component is shown as unknown. Check the scheduler and notification workers (both evaluate).</Alert>}
          <Card data-testid="platform-verdict">
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
              <span className="flex items-center gap-2 font-medium">Platform <StateBadge s={d.platform.state} /></span>
              <span className="flex items-center gap-2">Customer monitoring on schedule <StateBadge s={d.platform.customerMonitoring} /></span>
              <span className="flex items-center gap-2">Pipeline <StateBadge s={d.platform.pipeline} /></span>
              <span className="flex items-center gap-2">Dependencies <StateBadge s={d.platform.dependencies} /></span>
              <span className="text-xs text-muted-foreground">The platform verdict asks whether customer websites are being checked; worker rows below show individual processes.</span>
            </CardContent>
          </Card>
          {open > 0 && <Alert tone={critical ? "danger" : "warning"} title={`${open} platform alert${open === 1 ? "" : "s"} active${critical ? ` (${critical} critical)` : ""}`}><Link className="underline" href="/alerts">Open alerts</Link></Alert>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.components.map((c) => (
              <Card key={c.component} data-testid={`component-${c.component}`}>
                <CardContent className="grid gap-1 p-4">
                  <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs">{c.component}</span><StateBadge s={c.state} /></div>
                  <p className="text-xs text-muted-foreground">since {t(c.since)}</p>
                  {c.reasons.length > 0 && <ul className="text-xs">{c.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul>}
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Workers</CardTitle></CardHeader>
            <Table>
              <THead><TR><TH>Worker</TH><TH>State</TH><TH>Heartbeat</TH><TH className="text-right">Busy / capacity</TH><TH className="text-right">Done / failed / timeouts</TH><TH>Last job</TH><TH>Dependencies</TH><TH className="text-right">Memory</TH></TR></THead>
              <TBody>{d.workers.length ? d.workers.map((w) => (
                <TR key={w.workerId}>
                  <TD className="max-w-56"><div className="truncate font-mono text-xs">{w.workerId}</div><div className="text-xs text-muted-foreground">{w.kind} · {w.version} · up since {t(w.startedAt)}</div></TD>
                  <TD><StateBadge s={w.state} /></TD>
                  <TD className="text-xs">{ago(w.heartbeatAgeSec)} ago{!w.alive && <div className="text-danger">expired</div>}</TD>
                  <TD className="text-right tabular-nums text-xs">{w.activeJobs}/{w.capacity}</TD>
                  <TD className="text-right tabular-nums text-xs">{w.processed} / {w.failed} / {w.timeouts}</TD>
                  <TD className="text-xs">{t(w.lastJobAt)}</TD>
                  <TD className="text-xs">{Object.entries(w.dependencies).map(([k, v]) => <div key={k}><Badge tone={v.ok ? "success" : "danger"}>{k}</Badge> {v.ms != null ? `${v.ms} ms` : ""}{v.error ? ` · ${v.error}` : ""}</div>)}{!Object.keys(w.dependencies).length && "—"}
                    {typeof w.meta.runnerSessions === "number" && <div className="text-muted-foreground">runner {String(w.meta.runnerSessions)}/{String(w.meta.runnerMaxSessions)} sessions{w.meta.runnerSandbox === false ? " · SANDBOX OFF" : ""}</div>}</TD>
                  <TD className="text-right tabular-nums text-xs">{w.rssMb ?? "—"} MB</TD>
                </TR>
              )) : <TR><TD colSpan={8} className="text-sm text-muted-foreground">No workers have registered a heartbeat.</TD></TR>}</TBody>
            </Table>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle>History</CardTitle>
              <Select aria-label="Period" value={hours} onChange={(e) => setHours(e.target.value)} className="w-36">{[["6", "6 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></CardHeader>
            <CardContent className="grid gap-4">
              {h.data && (
                <>
                  <p className="text-xs text-muted-foreground">Restarts: {h.data.restarts.length ? h.data.restarts.map((r) => `${r.kind} ${r.n}`).join(" · ") : "none"}</p>
                  <Table>
                    <THead><TR><TH>Time (UTC)</TH><TH>Component</TH><TH>Change</TH></TR></THead>
                    <TBody>{h.data.transitions.length ? h.data.transitions.slice(0, 100).map((x, i) => (
                      <TR key={i}><TD className="text-xs">{t(x.at)}</TD><TD className="font-mono text-xs">{x.component}</TD><TD className="text-xs"><StateBadge s={x.from === "NONE" ? "UNKNOWN" : x.from} /> → <StateBadge s={x.to} /></TD></TR>
                    )) : <TR><TD colSpan={3} className="text-sm text-muted-foreground">No state changes in this period.</TD></TR>}</TBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
