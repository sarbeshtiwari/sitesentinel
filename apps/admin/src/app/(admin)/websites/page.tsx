"use client";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Skeleton, StatCard } from "@wim/ui";
import type { AdminWebsiteStatsDto, DataEnvelope } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, get } from "@/lib/api";
import { qk } from "@/lib/hooks";

const n = (v: number) => v.toLocaleString();

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
        <div className="grid gap-6">
          <section aria-label="Registrations" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Websites" value={n(d.websites.total)} hint={`${n(d.websites.added7d)} added in 7 days · ${n(d.websites.archived)} archived`} />
            <StatCard label="Verified" value={n(d.websites.verified)} hint={`${n(d.websites.unverified)} unverified`} />
            <StatCard label="Pending claims" value={n(d.claims.pending)} hint={`${n(d.claims.expired)} expired (72 h)`} />
            <StatCard label="Root-scope claims" value={n(d.claims.rootScope)} hint="registrable domains reserving subdomains" />
          </section>
          <section aria-label="Verification" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Verified by DNS" value={n(d.verifications.dns)} />
            <StatCard label="Verified by file" value={n(d.verifications.file)} />
            <StatCard label="Verified by meta tag" value={n(d.verifications.meta)} />
            <StatCard label="Failed checks (24 h)" value={n(d.verifications.failed24h)} />
          </section>
          <section aria-label="SDK installations" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="SDK seen (24 h)" value={n(d.sdk.seen24h)} />
            <StatCard label="SDK not installed" value={n(d.sdk.notInstalled)} />
            <StatCard label="SDK inactive" value={n(d.sdk.inactive)} />
            <StatCard label="Invalid configuration" value={n(d.sdk.invalidConfiguration)} hint="e.g. key used on a foreign origin" />
          </section>
          <section aria-label="Trials and abuse" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Trials activated" value={n(d.trials.activatedTotal)} hint={`${n(d.trials.activated7d)} in 7 days · ${n(d.trials.active)} active`} />
            <StatCard label="Domains with consumed trial" value={n(d.trials.domainsConsumed)} />
            <StatCard label="Duplicate attempts" value={n(d.registrationAttempts.duplicates24h)} hint={`24 h · ${n(d.registrationAttempts.duplicates30d)} in 30 days`} />
            <StatCard label="Suspicious orgs (24 h)" value={n(d.registrationAttempts.suspiciousOrgs24h)} hint={`≥ 5 refused registrations · ${n(d.registrationAttempts.blocked30d)} blocked in 30 days`} />
          </section>
          <section aria-label="Transfers" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Transfers awaiting DNS" value={n(d.transfers.pendingVerification)} />
            <StatCard label="Awaiting review" value={n(d.transfers.pendingAdmin)} />
            <StatCard label="Approved" value={n(d.transfers.approved)} />
            <StatCard label="Rejected" value={n(d.transfers.rejected)} />
            <StatCard label="Cancelled" value={n(d.transfers.cancelled)} />
          </section>
          <Card>
            <CardHeader><CardTitle>Registrations per day</CardTitle><CardDescription>Last 30 days</CardDescription></CardHeader>
            <CardContent>
              <div className="h-64" role="img" aria-label="Accepted registrations, duplicate attempts and verifications per day over the last 30 days">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={d.daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
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
