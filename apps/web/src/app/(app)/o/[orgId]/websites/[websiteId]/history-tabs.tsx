"use client";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { DataEnvelope, WebsiteDetailDto } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { errorMessage, get } from "@/lib/api";
import { fmt, METHOD_LABEL, VERIFICATION_STATE, wk } from "@/lib/websites";

interface History {
  claims: Array<{ id: string; status: string; scope: string; createdAt: string; verifiedAt: string | null; verifiedMethod: string | null; pendingExpiresAt: string | null; releasedAt: string | null; releaseReason: string | null }>;
  attempts: Array<{ outcome: string; createdAt: string; inputHost: string }>;
}

const OUTCOME: Record<string, string> = {
  ACCEPTED: "Registered", INHERITED_VERIFIED: "Registered (verified via your domain)", DUPLICATE_OWN: "Already registered by you",
  TRANSFER_REQUESTED: "Transfer requested", LIMIT: "Refused: too many unverified websites", BLOCKED: "Refused: blocked",
};

export function HistoryTab({ w, orgId }: { w: WebsiteDetailDto; orgId: string }) {
  const q = useQuery({
    queryKey: wk.history(orgId, w.id),
    queryFn: () => get<DataEnvelope<History>>(`/orgs/${orgId}/websites/${w.id}/registration-history`).then((r) => r.data),
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError || !q.data) return <Alert tone="danger" title={errorMessage(q.error)} />;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>Ownership claims</CardTitle></CardHeader>
        <Table>
          <THead><TR><TH>Claimed</TH><TH>Status</TH><TH className="hidden sm:table-cell">Verified</TH><TH className="hidden md:table-cell">Ended</TH></TR></THead>
          <TBody>
            {q.data.claims.map((c) => (
              <TR key={c.id}>
                <TD className="whitespace-nowrap">{fmt(c.createdAt)}</TD>
                <TD><Badge tone={VERIFICATION_STATE[c.status]?.tone ?? "neutral"}>{VERIFICATION_STATE[c.status]?.label ?? c.status}</Badge>{c.scope === "ROOT" && <span className="ml-2 text-xs text-muted-foreground">incl. subdomains</span>}</TD>
                <TD className="hidden sm:table-cell">{c.verifiedAt ? `${fmt(c.verifiedAt)} · ${METHOD_LABEL[c.verifiedMethod ?? ""] ?? ""}` : "—"}</TD>
                <TD className="hidden md:table-cell">{c.releasedAt ? `${fmt(c.releasedAt)} (${(c.releaseReason ?? "").toLowerCase().replace(/_/g, " ")})` : "—"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader><CardTitle>Registration attempts by your organization</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead><TR><TH>When</TH><TH>Address entered</TH><TH>Result</TH></TR></THead>
            <TBody>
              {q.data.attempts.map((a, i) => (
                <TR key={i}><TD className="whitespace-nowrap">{fmt(a.createdAt)}</TD><TD>{a.inputHost}</TD><TD>{OUTCOME[a.outcome] ?? a.outcome}</TD></TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function AuditTab({ w, orgId }: { w: WebsiteDetailDto; orgId: string }) {
  const q = useQuery({
    queryKey: wk.audit(orgId, w.id),
    queryFn: () => get<DataEnvelope<Array<{ id: string; occurredAt: string; actorType: string; actorLabel: string | null; action: string; changes: unknown }>>>(`/orgs/${orgId}/websites/${w.id}/audit`).then((r) => r.data),
  });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError || !q.data) return <Alert tone="danger" title={errorMessage(q.error)} />;
  return (
    <Card>
      <CardHeader><CardTitle>Audit history</CardTitle></CardHeader>
      <Table>
        <THead><TR><TH>When</TH><TH>Who</TH><TH>Action</TH><TH className="hidden md:table-cell">Details</TH></TR></THead>
        <TBody>
          {q.data.map((a) => (
            <TR key={a.id}>
              <TD className="whitespace-nowrap">{fmt(a.occurredAt)}</TD>
              <TD>{a.actorLabel ?? a.actorType.toLowerCase()}</TD>
              <TD><code className="text-xs">{a.action}</code></TD>
              <TD className="hidden max-w-md truncate text-xs text-muted-foreground md:table-cell">{a.changes ? JSON.stringify(a.changes) : ""}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}
