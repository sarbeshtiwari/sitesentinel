"use client";
import { Alert, Badge, Card, PageHeader, Skeleton, StatCard, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { errorMessage, get } from "@/lib/api";

type N = number | null;
interface Health {
  generatedAt: string;
  queues: Record<string, Record<string, number>>;
  executions: Array<{ tier: string; scheduled: N; queued: N; running: N; retrying: N; succeeded1h: N; failed1h: N; deadLettered24h: N; p95DurationMs1h: N; p95WaitMs1h: N; expiredLeases: N }>;
  workers: Array<{ workerId: string; kind: string; version: string | null; lastSeenAt: string; activeJobs: number; capacity: number; available: boolean; rssMb: number | null }>;
  scheduler: { lastSuccessfulCycleAt: string | null; cycles1h: N; backpressureEvents1h: N; instances: number };
  deadLetters24h: N; securityRejected24h: N;
  outcomes: Array<{ tier: string; results24h: number; passed24h: N; failed24h: N; inconclusive24h: N; retried24h: N; results7d: N; failureRatePercent24h: N; inconclusiveRatePercent24h: N }>;
  gateway: { infraFailures24h: number; securityRejections24h: N; blockedDestinations24h: N; p95GatewayMs1h: N; source: string };
  usage: Array<{ key: string; today: N; last30Days: N; organisationsToday: N }>;
  deepScans: { running: N; completed24h: N; partial24h: N; cancelled24h: N; pages24h: N } | null;
}
const TIER: Record<string, string> = { T1_HTTP: "HTTP", T2_RENDER: "Browser", T3_DEEP: "Deep scan", T4_API: "API" };
const v = (x: N | undefined) => (x == null ? "—" : x.toLocaleString("en"));

/** Platform monitoring operations: aggregate counts only. No organisation, website, URL, result or screenshot. */
export default function MonitoringPage() {
  const q = useQuery({ queryKey: ["admin", "monitoring-health"], queryFn: ({ signal }) => get<DataEnvelope<Health>>("/monitoring/health", { signal }).then((r) => r.data), refetchInterval: 30_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="Monitoring operations" description={d ? `Updated ${d.generatedAt.slice(11, 19)} UTC · refreshes every 30 s` : undefined} />
      <Alert className="mb-6" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Aggregate operational data only</span>}>
        No customer URLs, page content, screenshots, incidents, findings or configuration are available here. Customer support access requires the break-glass process.
      </Alert>
      {q.isLoading ? <Skeleton className="h-96" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Scheduler" value={d.scheduler.instances ? <Badge tone="success">{d.scheduler.instances} running</Badge> : <Badge tone="danger">Not running</Badge>} hint={`last cycle ${d.scheduler.lastSuccessfulCycleAt?.slice(11, 19) ?? "—"} UTC · ${v(d.scheduler.cycles1h)} cycles/h`} />
            <StatCard label="Dead letters (24 h)" value={v(d.deadLetters24h)} hint={`${v(d.securityRejected24h)} security rejections`} />
            <StatCard label="Gateway infrastructure failures (24 h)" value={v(d.gateway.infraFailures24h)} hint={`p95 gateway ${v(d.gateway.p95GatewayMs1h)} ms · ${d.gateway.source}`} />
            <StatCard label="Deep scans (24 h)" value={v(d.deepScans?.completed24h)} hint={`${v(d.deepScans?.running)} running · ${v(d.deepScans?.partial24h)} partial · ${v(d.deepScans?.pages24h)} pages`} />
          </div>
          <Card className="overflow-hidden">
            <Table>
              <THead><TR><TH>Tier</TH><TH className="text-right">Results 24 h</TH><TH className="text-right">Failure rate</TH><TH className="text-right">Inconclusive rate</TH><TH className="text-right">Retried</TH><TH className="text-right">7 days</TH></TR></THead>
              <TBody>{d.outcomes.map((o) => (
                <TR key={o.tier}><TD>{TIER[o.tier] ?? o.tier}</TD><TD className="text-right tabular-nums">{v(o.results24h)}</TD><TD className="text-right tabular-nums">{o.failureRatePercent24h == null ? "—" : `${o.failureRatePercent24h}%`}</TD>
                  <TD className="text-right tabular-nums">{o.inconclusiveRatePercent24h == null ? "—" : `${o.inconclusiveRatePercent24h}%`}</TD><TD className="text-right tabular-nums">{v(o.retried24h)}</TD><TD className="text-right tabular-nums">{v(o.results7d)}</TD></TR>
              ))}</TBody>
            </Table>
          </Card>
          <Card className="overflow-hidden">
            <Table>
              <THead><TR><TH>Executions</TH><TH className="text-right">Queued</TH><TH className="text-right">Running</TH><TH className="text-right">Retrying</TH><TH className="text-right">OK 1 h</TH><TH className="text-right">Failed 1 h</TH><TH className="text-right">DLQ 24 h</TH><TH className="text-right">p95 duration</TH><TH className="text-right">p95 wait</TH></TR></THead>
              <TBody>{d.executions.map((e) => (
                <TR key={e.tier}><TD>{TIER[e.tier] ?? e.tier}</TD><TD className="text-right tabular-nums">{v(e.queued)}</TD><TD className="text-right tabular-nums">{v(e.running)}</TD><TD className="text-right tabular-nums">{v(e.retrying)}</TD>
                  <TD className="text-right tabular-nums">{v(e.succeeded1h)}</TD><TD className="text-right tabular-nums">{v(e.failed1h)}</TD><TD className="text-right tabular-nums">{v(e.deadLettered24h)}</TD>
                  <TD className="text-right tabular-nums">{v(e.p95DurationMs1h)} ms</TD><TD className="text-right tabular-nums">{v(e.p95WaitMs1h)} ms</TD></TR>
              ))}</TBody>
            </Table>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <Table>
                <THead><TR><TH>Queue</TH><TH className="text-right">Waiting</TH><TH className="text-right">Active</TH><TH className="text-right">Delayed</TH><TH className="text-right">Failed</TH></TR></THead>
                <TBody>{Object.entries(d.queues).map(([k, c]) => (
                  <TR key={k}><TD>{k}</TD><TD className="text-right tabular-nums">{v((c.waiting ?? 0) + (c.prioritized ?? 0))}</TD><TD className="text-right tabular-nums">{v(c.active)}</TD><TD className="text-right tabular-nums">{v(c.delayed)}</TD><TD className="text-right tabular-nums">{v(c.failed)}</TD></TR>
                ))}</TBody>
              </Table>
            </Card>
            <Card className="overflow-hidden">
              <Table>
                <THead><TR><TH>Worker</TH><TH>Kind</TH><TH>Status</TH><TH className="text-right">Load</TH></TR></THead>
                <TBody>{d.workers.length ? d.workers.map((w) => (
                  <TR key={w.workerId}><TD className="max-w-48 truncate text-xs">{w.workerId}</TD><TD className="text-xs">{w.kind}</TD><TD><Badge tone={w.available ? "success" : "danger"}>{w.available ? "Up" : "Stale"}</Badge></TD><TD className="text-right tabular-nums text-xs">{w.activeJobs}/{w.capacity}</TD></TR>
                )) : <TR><TD colSpan={4} className="text-sm text-muted-foreground">No worker heartbeats recorded.</TD></TR>}</TBody>
              </Table>
            </Card>
          </div>
          <Card className="overflow-hidden">
            <Table>
              <THead><TR><TH>Platform usage</TH><TH className="text-right">Today</TH><TH className="text-right">30 days</TH><TH className="text-right">Organisations today</TH></TR></THead>
              <TBody>{d.usage.map((u) => <TR key={u.key}><TD className="text-xs">{u.key}</TD><TD className="text-right tabular-nums">{v(u.today)}</TD><TD className="text-right tabular-nums">{v(u.last30Days)}</TD><TD className="text-right tabular-nums">{v(u.organisationsToday)}</TD></TR>)}</TBody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
