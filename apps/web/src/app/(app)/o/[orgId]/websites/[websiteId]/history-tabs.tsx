"use client";
import { Alert, Badge, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { DataEnvelope, WebsiteDetailDto } from "@wim/contracts";
import { useQuery } from "@tanstack/react-query";
import { ListPlus, ScrollText, ShieldCheck } from "lucide-react";
import { Section } from "@/components/monitoring";
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
  if (q.isLoading) return <div role="status" aria-label="Loading"><Skeleton className="h-40" /></div>;
  if (q.isError || !q.data) return <Alert tone="danger" title={errorMessage(q.error)} />;
  return (
    <div className="grid gap-5">
      <Section title="Ownership claims" icon={<ShieldCheck />} flush>
        <Table>
          <THead><TR><TH>Claimed</TH><TH>Status</TH><TH className="hidden sm:table-cell">Verified</TH><TH className="hidden md:table-cell">Ended</TH></TR></THead>
          <TBody>
            {q.data.claims.map((c) => (
              <TR key={c.id}>
                <TD className="whitespace-nowrap text-muted-foreground">{fmt(c.createdAt)}</TD>
                <TD><Badge tone={VERIFICATION_STATE[c.status]?.tone ?? "neutral"}>{VERIFICATION_STATE[c.status]?.label ?? c.status}</Badge>{c.scope === "ROOT" && <span className="ml-2 text-xs text-muted-foreground">incl. subdomains</span>}</TD>
                <TD className="hidden sm:table-cell">{c.verifiedAt ? `${fmt(c.verifiedAt)} · ${METHOD_LABEL[c.verifiedMethod ?? ""] ?? ""}` : "—"}</TD>
                <TD className="hidden md:table-cell">{c.releasedAt ? `${fmt(c.releasedAt)} (${(c.releaseReason ?? "").toLowerCase().replace(/_/g, " ")})` : "—"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Section>
      <Section title="Registration attempts by your organization" icon={<ListPlus />} flush>
        <div>
          <Table>
            <THead><TR><TH>When</TH><TH>Address entered</TH><TH>Result</TH></TR></THead>
            <TBody>
              {q.data.attempts.map((a, i) => (
                <TR key={i}><TD className="whitespace-nowrap text-muted-foreground">{fmt(a.createdAt)}</TD><TD className="break-all font-mono text-xs">{a.inputHost}</TD><TD>{OUTCOME[a.outcome] ?? a.outcome}</TD></TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Section>
    </div>
  );
}

export function AuditTab({ w, orgId }: { w: WebsiteDetailDto; orgId: string }) {
  const q = useQuery({
    queryKey: wk.audit(orgId, w.id),
    queryFn: () => get<DataEnvelope<Array<{ id: string; occurredAt: string; actorType: string; actorLabel: string | null; action: string; changes: unknown }>>>(`/orgs/${orgId}/websites/${w.id}/audit`).then((r) => r.data),
  });
  if (q.isLoading) return <div role="status" aria-label="Loading"><Skeleton className="h-40" /></div>;
  if (q.isError || !q.data) return <Alert tone="danger" title={errorMessage(q.error)} />;
  return (
    <Section title="Audit history" icon={<ScrollText />} flush>
      {!q.data.length ? <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">Nothing recorded yet.</p> : <Table>
        <THead><TR><TH>When</TH><TH>Who</TH><TH>Action</TH><TH className="hidden md:table-cell">Details</TH></TR></THead>
        <TBody>
          {q.data.map((a) => (
            <TR key={a.id}>
              <TD className="whitespace-nowrap text-muted-foreground">{fmt(a.occurredAt)}</TD>
              <TD className="font-medium">{a.actorLabel ?? a.actorType.toLowerCase()}</TD>
              <TD><code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs ring-1 ring-border">{a.action}</code></TD>
              <TD className="hidden max-w-md truncate text-xs text-muted-foreground md:table-cell">{a.changes ? JSON.stringify(a.changes) : ""}</TD>
            </TR>
          ))}
        </TBody>
      </Table>}
    </Section>
  );
}
