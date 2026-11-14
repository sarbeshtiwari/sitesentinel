"use client";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Skeleton, StatCard } from "@wim/ui";
import type { AdminOverviewDto, DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, get } from "@/lib/api";
import { qk } from "@/lib/hooks";

const n = (v: number) => v.toLocaleString();

export default function OverviewPage() {
  const q = useQuery({ queryKey: qk.overview, queryFn: () => get<DataEnvelope<AdminOverviewDto>>("/overview").then((r) => r.data), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="Platform overview" description={d ? `Updated ${new Date(d.generatedAt).toLocaleTimeString()}` : undefined} />
      <Alert className="mb-6" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Aggregate platform statistics only</span>}>
        Counts are computed by the database from aggregate views. No customer content (incidents, credentials, monitoring results) is accessible from this console.
      </Alert>
      {q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-6">
          <section aria-label="Users and organizations" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Users" value={n(d.users.total)} hint={`${n(d.users.verified)} verified · ${n(d.users.withTwoFactor)} with 2FA`} />
            <StatCard label="New signups" value={n(d.users.signups7d)} hint={`last 7 days · ${n(d.users.signups30d)} in 30 days`} />
            <StatCard label="Organizations" value={n(d.organizations.total)} hint={`${n(d.organizations.active)} active · ${n(d.organizations.suspended)} suspended`} />
            <StatCard label="Pending deletion" value={n(d.organizations.pendingDeletion)} />
          </section>
          <section aria-label="Subscriptions and monitoring" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Trialing" value={n(d.subscriptions.trialing)} />
            <StatCard label="Paid subscriptions" value={n(d.subscriptions.paid)} hint={`${n(d.subscriptions.pastDue)} past due · ${n(d.subscriptions.expired)} expired`} />
            <StatCard label="Websites" value={n(d.websites.total)} hint={`${n(d.websites.active)} active · ${n(d.websites.pendingVerification)} pending verification`} />
            <StatCard label="Open incidents" value={n(d.incidents.open)} hint={`${n(d.incidents.openCritical)} critical`} />
            <StatCard label="Executions (24 h)" value={n(d.monitoring.executions24h)} hint={`${n(d.monitoring.failedExecutions24h)} failed`} />
            <StatCard label="Failed background jobs" value={n(d.jobs.unresolvedFailures)} hint="unresolved" />
            <StatCard label="Workers" value={`${n(d.workers.healthy)} / ${n(d.workers.total)}`} hint="healthy (heartbeat < 30 s)" />
          </section>
          <Card>
            <CardHeader><CardTitle>Signups per day</CardTitle><CardDescription>Last 30 days</CardDescription></CardHeader>
            <CardContent>
              <div className="h-64" role="img" aria-label={`Signups per day over the last 30 days, ${d.signupsDaily.reduce((a, b) => a + b.count, 0)} total`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.signupsDaily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                    <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Bar dataKey="count" name="Signups" fill="var(--primary)" radius={[3, 3, 0, 0]} />
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
