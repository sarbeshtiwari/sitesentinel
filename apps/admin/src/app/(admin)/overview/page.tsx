"use client";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, MetricCard, PageHeader, Skeleton } from "@wim/ui";
import type { AdminOverviewDto, DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertOctagon, Building2, CheckCircle2, CreditCard, Globe, Hourglass, Lock, Server, ShieldAlert, Trash2, UserPlus, Users, Workflow,
} from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, get } from "@/lib/api";
import { qk, useAdminMe } from "@/lib/hooks";

const n = (v: number) => v.toLocaleString();
type Tone = "success" | "warning" | "danger" | "neutral";

/** Verdict from the counts already on this page: worker heartbeats and unresolved background-job failures. */
function verdict(d: AdminOverviewDto): { tone: Tone; title: string; text: string } {
  if (d.workers.total === 0) return { tone: "neutral", title: "No workers have reported a heartbeat", text: "Worker health is unknown until a worker process registers." };
  if (d.workers.healthy === 0) return { tone: "danger", title: "No healthy workers", text: `0 of ${n(d.workers.total)} workers sent a heartbeat in the last 30 s. Check Platform health.` };
  if (d.workers.healthy < d.workers.total) return { tone: "warning", title: `${n(d.workers.total - d.workers.healthy)} of ${n(d.workers.total)} workers not healthy`, text: "Some worker processes missed their heartbeat. Check Platform health for details." };
  if (d.jobs.unresolvedFailures > 0) return { tone: "warning", title: `${n(d.jobs.unresolvedFailures)} unresolved background job failure${d.jobs.unresolvedFailures === 1 ? "" : "s"}`, text: "All workers are healthy; failed jobs are waiting for review." };
  return { tone: "success", title: "Workers healthy, no unresolved job failures", text: `All ${n(d.workers.total)} workers sent a heartbeat in the last 30 s.` };
}

const RING: Record<Tone, string> = {
  danger: "text-danger bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]",
  warning: "text-warning bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]",
  success: "text-success bg-[color-mix(in_srgb,var(--success)_11%,transparent)]",
  neutral: "text-muted-foreground bg-muted",
};

function HealthStrip({ d, canOps }: { d: AdminOverviewDto; canOps: boolean }) {
  const v = verdict(d);
  const Icon = v.tone === "success" ? CheckCircle2 : v.tone === "neutral" ? Activity : ShieldAlert;
  const failRate = d.monitoring.executions24h ? (d.monitoring.failedExecutions24h / d.monitoring.executions24h) * 100 : null;
  const cells: Array<{ label: string; value: string; hint: string; tone: Tone }> = [
    { label: "Workers healthy", value: `${n(d.workers.healthy)} / ${n(d.workers.total)}`, hint: "heartbeat < 30 s", tone: d.workers.total && d.workers.healthy === d.workers.total ? "success" : d.workers.healthy === 0 ? "danger" : "warning" },
    { label: "Failed background jobs", value: n(d.jobs.unresolvedFailures), hint: "unresolved", tone: d.jobs.unresolvedFailures ? "warning" : "success" },
    { label: "Failed executions (24 h)", value: n(d.monitoring.failedExecutions24h), hint: failRate === null ? "no executions" : `${failRate.toFixed(1)}% of ${n(d.monitoring.executions24h)}`, tone: "neutral" },
    { label: "Open critical incidents", value: n(d.incidents.openCritical), hint: `${n(d.incidents.open)} open in total`, tone: d.incidents.openCritical ? "danger" : "neutral" },
  ];
  const label: Record<Tone, string> = { success: "ok", warning: "attention", danger: "action needed", neutral: "info" };
  return (
    <Card className="overflow-hidden" data-testid="overview-verdict">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <span aria-hidden className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", RING[v.tone])}><Icon className="h-5 w-5" /></span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Platform processing</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight">{v.title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{v.text}</p>
          </div>
        </div>
        {canOps && <Link href="/platform" className="shrink-0 text-sm font-medium text-primary underline-offset-2 hover:underline">Health details →</Link>}
      </div>
      <dl className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="bg-sunken px-5 py-3">
            <dt className="flex items-center justify-between gap-2 text-xs text-muted-foreground">{c.label}{c.tone !== "neutral" && <Badge tone={c.tone} className="hidden sm:inline-flex">{label[c.tone]}</Badge>}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight">{c.value}</dd>
            <dd className="text-xs text-muted-foreground tabular-nums">{c.hint}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

const Group = ({ title, label, cols = "lg:grid-cols-4", children }: { title: string; label: string; cols?: string; children: React.ReactNode }) => (
  <section aria-label={label} className="grid gap-3">
    <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">{title}</h2>
    <div className={cn("grid gap-3 sm:grid-cols-2", cols)}>{children}</div>
  </section>
);

export default function OverviewPage() {
  const me = useAdminMe();
  const q = useQuery({ queryKey: qk.overview, queryFn: () => get<DataEnvelope<AdminOverviewDto>>("/overview").then((r) => r.data), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="Platform overview" description={d ? `Updated ${d.generatedAt.slice(11, 19)} UTC · refreshes every minute` : undefined} />
      <Alert className="mb-6" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Aggregate platform statistics only</span>}>
        Counts are computed by the database from aggregate views. No customer content (incidents, credentials, monitoring results) is accessible from this console.
      </Alert>
      {q.isLoading ? (
        <div className="grid gap-6">
          <Skeleton className="h-40" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
        </div>
      ) : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-7">
          <HealthStrip d={d} canOps={me.can("admin:monitoring:read")} />
          <Group title="Accounts" label="Users and organizations">
            <MetricCard icon={<Users />} label="Users" value={n(d.users.total)} hint={`${n(d.users.verified)} verified · ${n(d.users.withTwoFactor)} with 2FA`} />
            <MetricCard icon={<UserPlus />} tone="brand" label="New signups" value={n(d.users.signups7d)} hint={`last 7 days · ${n(d.users.signups30d)} in 30 days`} />
            <MetricCard icon={<Building2 />} label="Organizations" value={n(d.organizations.total)} hint={`${n(d.organizations.active)} active · ${n(d.organizations.suspended)} suspended`} />
            <MetricCard icon={<Trash2 />} tone={d.organizations.pendingDeletion ? "warning" : "neutral"} label="Pending deletion" value={n(d.organizations.pendingDeletion)} />
          </Group>
          <Group title="Subscriptions & monitoring" label="Subscriptions and monitoring">
            <MetricCard icon={<Hourglass />} label="Trialing subscriptions" value={n(d.subscriptions.trialing)} hint="billing subscriptions only · website free trials are listed per customer" />
            <MetricCard icon={<CreditCard />} tone="brand" label="Paid subscriptions" value={n(d.subscriptions.paid)} hint={`${n(d.subscriptions.pastDue)} past due · ${n(d.subscriptions.expired)} expired`} />
            <MetricCard icon={<Globe />} label="Websites" value={n(d.websites.total)} hint={`${n(d.websites.active)} active · ${n(d.websites.pendingVerification)} pending verification`} />
            <MetricCard icon={<AlertOctagon />} tone={d.incidents.openCritical ? "danger" : d.incidents.open ? "warning" : "neutral"} label="Open incidents" value={n(d.incidents.open)} hint={`${n(d.incidents.openCritical)} critical`} />
          </Group>
          <Group title="Processing" label="Processing" cols="lg:grid-cols-3">
            <MetricCard icon={<Activity />} label="Executions (24 h)" value={n(d.monitoring.executions24h)} hint={`${n(d.monitoring.failedExecutions24h)} failed`} />
            <MetricCard icon={<Workflow />} tone={d.jobs.unresolvedFailures ? "warning" : "success"} label="Failed background jobs" value={n(d.jobs.unresolvedFailures)} hint="unresolved" />
            <MetricCard icon={<Server />} tone={d.workers.total && d.workers.healthy === d.workers.total ? "success" : "danger"} label="Workers" value={`${n(d.workers.healthy)} / ${n(d.workers.total)}`} hint="healthy (heartbeat < 30 s)" />
          </Group>
          <Card>
            <CardHeader className="flex flex-row items-end justify-between gap-4">
              <div className="grid gap-1"><CardTitle>Signups per day</CardTitle><CardDescription>Last 30 days</CardDescription></div>
              <p className="text-right text-xs text-muted-foreground"><span className="block text-lg font-semibold tabular-nums text-foreground">{n(d.signupsDaily.reduce((a, b) => a + b.count, 0))}</span>total</p>
            </CardHeader>
            <CardContent>
              <div className="h-64" role="img" aria-label={`Signups per day over the last 30 days, ${d.signupsDaily.reduce((a, b) => a + b.count, 0)} total`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.signupsDaily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Bar dataKey="count" name="Signups" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
