"use client";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, FormField, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR, Textarea, toast } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { qk, useAdminMe } from "@/lib/hooks";

interface Row {
  id: string; displayHost: string; registrableDomain: string; status: string; ownerResponse: string | null; ownerRespondBy: string | null;
  createdAt: string; verifiedAt: string | null; decidedAt: string | null; decisionReason: string | null;
  fromOrg: { id: string; name: string } | null; toOrg: { id: string; name: string } | null; currentClaimStatus: string | null; currentClaimVerifiedAt: string | null;
}

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");
const TONE: Record<string, "warning" | "brand" | "success" | "danger" | "neutral"> = { PENDING_VERIFICATION: "warning", PENDING_ADMIN: "brand", APPROVED: "success", REJECTED: "danger", CANCELLED: "neutral" };

export default function TransfersPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.transfers, queryFn: () => get<DataEnvelope<Row[]>>("/domain-transfers").then((r) => r.data) });
  const [decide, setDecide] = useState<{ row: Row; decision: "APPROVE" | "REJECT" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const canDecide = me.can("admin:transfers:decide");

  const submit = async () => {
    if (!decide) return;
    setBusy(true);
    try {
      await post(`/domain-transfers/${decide.row.id}/decision`, { decision: decide.decision, reason: reason.trim() });
      toast.success(decide.decision === "APPROVE" ? "Transfer approved — it will be applied shortly" : "Transfer rejected");
      setDecide(null);
      await qc.invalidateQueries({ queryKey: qk.transfers });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Domain transfers" description="Requests where another organization proved DNS control of a registered domain. Approving moves the domain registration only — no customer data moves." />
      {q.isLoading ? <Skeleton className="h-40" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : !q.data?.length ? (
        <EmptyState icon={<ArrowLeftRight />} title="No transfer requests" description="Requests appear here when another organization proves DNS control of a registered domain." />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{q.data.length} request{q.data.length === 1 ? "" : "s"}</span>
            {q.data.some((r) => r.status === "PENDING_ADMIN") && <Badge tone="brand" className="tabular-nums">{q.data.filter((r) => r.status === "PENDING_ADMIN").length} awaiting review</Badge>}
          </div>
          <Table>
            <THead><TR><TH>Domain</TH><TH>Status</TH><TH>Current owner</TH><TH>Requester</TH><TH className="hidden lg:table-cell">Owner response</TH><TH className="hidden lg:table-cell">Requested</TH><TH className="relative"><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {q.data.map((r) => (
                <TR key={r.id}>
                  <TD><div className="font-mono text-[13px] font-medium">{r.displayHost}</div><div className="text-xs tabular-nums text-muted-foreground">DNS verified {fmt(r.verifiedAt)}</div></TD>
                  <TD><Badge tone={TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge>{r.decisionReason && <div className="mt-1 max-w-48 text-xs text-muted-foreground">{r.decisionReason}</div>}</TD>
                  <TD>{r.fromOrg?.name ?? "—"}<div className="text-xs text-muted-foreground">claim {r.currentClaimStatus?.toLowerCase() ?? "—"}</div></TD>
                  <TD>{r.toOrg?.name ?? "—"}</TD>
                  <TD className="hidden lg:table-cell">{r.ownerResponse === "CONTESTED" ? <Badge tone="danger">Contested</Badge> : r.ownerResponse ? r.ownerResponse.toLowerCase() : "—"}<div className="text-xs tabular-nums text-muted-foreground">by {fmt(r.ownerRespondBy)}</div></TD>
                  <TD className="hidden whitespace-nowrap text-xs tabular-nums text-muted-foreground lg:table-cell">{fmt(r.createdAt)}</TD>
                  <TD className="text-right">
                    {canDecide && r.status === "PENDING_ADMIN" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => { setReason(""); setDecide({ row: r, decision: "APPROVE" }); }}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => { setReason(""); setDecide({ row: r, decision: "REJECT" }); }}>Reject</Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <ConfirmDialog
        open={decide !== null}
        onOpenChange={(o) => !o && setDecide(null)}
        title={decide?.decision === "APPROVE" ? `Approve transfer of ${decide.row.displayHost}?` : `Reject transfer of ${decide?.row.displayHost ?? ""}?`}
        description={decide?.decision === "APPROVE" ? "The current owner's website is archived and its site key revoked; the requester receives a new verified website. Both sides are notified." : "The current owner keeps the domain. Both sides are notified."}
        destructive={decide?.decision === "APPROVE"}
        confirmLabel={decide?.decision === "APPROVE" ? "Approve transfer" : "Reject transfer"}
        confirmDisabled={reason.trim().length < 5}
        loading={busy}
        onConfirm={submit}
      >
        <FormField label="Reason (recorded in the audit log)" htmlFor="reason" hint="At least 5 characters.">
          <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </ConfirmDialog>
    </>
  );
}
