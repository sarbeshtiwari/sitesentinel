"use client";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, MetricCard, PageHeader, Skeleton } from "@wim/ui";
import type { AdminWebsiteStatsDto, DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeftRight, Lock, ShieldAlert } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, get } from "@/lib/api";
import { qk } from "@/lib/hooks";

const n = (v: number) => v.toLocaleString();
const Group = ({ title, label, cols = "lg:grid-cols-4", children }: { title: string; label: string; cols?: string; children: React.ReactNode }) => (
  <section aria-label={label} className="grid gap-3">
    <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">{title}</h2>
    <div className={cn("grid gap-3 sm:grid-cols-2", cols)}>{children}</div>
  </section>
);

export default function WebsiteStatsPage() {
  const q = useQuery({ queryKey: qk.websiteStats, queryFn: () => get<DataEnvelope<AdminWebsiteStatsDto>>("/websites/stats").then((r) => r.data), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="Websites & domains" description={d ? `Updated ${new Date(d.generatedAt).toLocaleTimeString()}` : undefined} />
      <Alert className="mb-6" title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" aria-hidden /> Aggregate counts only</span>}>
        No customer telemetry, site keys, verification tokens or website content are accessible from this console.
      </Alert>
      {q.isLoading ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
        : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-7">
          <Group title="Registrations" label="Registrations">
            <MetricCard label="Websites" value={n(d.websites.total)} hint={`${n(d.websites.added7d)} added in 7 days · ${n(d.websites.archived)} archived`} />
            <MetricCard label="Verified" value={n(d.websites.verified)} hint={`${n(d.websites.unverified)} unverified`} />
            <MetricCard label="Pending claims" value={n(d.claims.pending)} hint={`${n(d.claims.expired)} expired (72 h)`} />
            <MetricCard label="Root-scope claims" value={n(d.claims.rootScope)} hint="registrable domains reserving subdomains" />
          </Group>
          <Group title="Verification" label="Verification">
            <MetricCard label="Verified by DNS" value={n(d.verifications.dns)} />
            <MetricCard label="Verified by file" value={n(d.verifications.file)} />
            <MetricCard label="Verified by meta tag" value={n(d.verifications.meta)} />
            <MetricCard label="Failed checks (24 h)" tone={d.verifications.failed24h ? "warning" : "neutral"} icon={d.verifications.failed24h ? <AlertTriangle /> : undefined} value={n(d.verifications.failed24h)} />
          </Group>
          <Group title="SDK installations" label="SDK installations">
            <MetricCard label="SDK seen (24 h)" value={n(d.sdk.seen24h)} />
            <MetricCard label="SDK not installed" value={n(d.sdk.notInstalled)} />
            <MetricCard label="SDK inactive" value={n(d.sdk.inactive)} />
            <MetricCard label="Invalid configuration" tone={d.sdk.invalidConfiguration ? "warning" : "neutral"} icon={d.sdk.invalidConfiguration ? <AlertTriangle /> : undefined} value={n(d.sdk.invalidConfiguration)} hint="e.g. key used on a foreign origin" />
          </Group>
          <Group title="Trials & abuse" label="Trials and abuse">
            <MetricCard label="Trials activated" value={n(d.trials.activatedTotal)} hint={`${n(d.trials.activated7d)} in 7 days · ${n(d.trials.active)} active`} />
            <MetricCard label="Domains with consumed trial" value={n(d.trials.domainsConsumed)} />
            <MetricCard label="Duplicate attempts" value={n(d.registrationAttempts.duplicates24h)} hint={`24 h · ${n(d.registrationAttempts.duplicates30d)} in 30 days`} />
            <MetricCard label="Suspicious orgs (24 h)" tone={d.registrationAttempts.suspiciousOrgs24h ? "danger" : "neutral"} icon={d.registrationAttempts.suspiciousOrgs24h ? <ShieldAlert /> : undefined} value={n(d.registrationAttempts.suspiciousOrgs24h)} hint={`≥ 5 refused registrations · ${n(d.registrationAttempts.blocked30d)} blocked in 30 days`} />
          </Group>
          <Group title="Transfers" label="Transfers" cols="lg:grid-cols-5">
            <MetricCard label="Transfers awaiting DNS" value={n(d.transfers.pendingVerification)} />
            <MetricCard label="Awaiting review" tone={d.transfers.pendingAdmin ? "brand" : "neutral"} icon={d.transfers.pendingAdmin ? <ArrowLeftRight /> : undefined} value={n(d.transfers.pendingAdmin)} />
            <MetricCard label="Approved" value={n(d.transfers.approved)} />
            <MetricCard label="Rejected" value={n(d.transfers.rejected)} />
            <MetricCard label="Cancelled" value={n(d.transfers.cancelled)} />
          </Group>
          <Card>
            <CardHeader><CardTitle>Registrations per day</CardTitle><CardDescription>Last 30 days</CardDescription></CardHeader>
            <CardContent>
              <div className="h-64" role="img" aria-label="Accepted registrations, duplicate attempts and verifications per day over the last 30 days">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={d.daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="accepted" name="Registered" stroke="var(--primary)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="verified" name="Verified" stroke="var(--success)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="duplicates" name="Duplicate attempts" stroke="var(--danger)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
