"use client";
import { Alert, Badge, Button, Card, ConfirmDialog, FormField, PageHeader, Select, Skeleton, Table, TBody, TD, Textarea, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { useAdminMe } from "@/lib/hooks";

interface AlertRow { id: string; rule: string; component: string; severity: string; state: string; reason: string; openedAt: string; lastSeenAt: string; occurrences: number; reopenCount: number; acknowledgedAt: string | null; recoveredAt: string | null; suppressedBy: string | null; notifyState: string }
interface Detail extends AlertRow { events: Array<{ id: string; at: string; type: string; actorId: string | null; details: Record<string, unknown> }> }
const SEV: Record<string, "danger" | "warning" | "neutral"> = { CRITICAL: "danger", WARNING: "warning", INFO: "neutral" };
const STATE: Record<string, "danger" | "warning" | "success"> = { OPEN: "danger", ACKNOWLEDGED: "warning", RECOVERED: "success" };
const t = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : "—");

/** Platform self-alerts (separate from customer incidents). Acknowledging stops repeat notifications; recovery is automatic. */
export default function AlertsPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const [state, setState] = useState("ACTIVE");
  const [sel, setSel] = useState<string | null>(null);
  const [ack, setAck] = useState<AlertRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["ops", "alerts", state], queryFn: ({ signal }) => get<DataEnvelope<AlertRow[]>>(`/ops/alerts?state=${state}&limit=200`, { signal }).then((r) => r.data), refetchInterval: 30_000 });
  const d = useQuery({ queryKey: ["ops", "alert", sel], enabled: Boolean(sel), queryFn: ({ signal }) => get<DataEnvelope<Detail>>(`/ops/alerts/${sel}`, { signal }).then((r) => r.data) });
  const doAck = async () => {
    if (!ack) return;
    setBusy(true);
    try {
      await post(`/ops/alerts/${ack.id}/acknowledge`, { reason: reason.trim() });
      toast.success("Alert acknowledged");
      setAck(null); setReason("");
      await qc.invalidateQueries({ queryKey: ["ops"] });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Platform alerts" description="Infrastructure alerts for operators. Never customer incidents; never customer data." />
      <div className="mb-4 flex gap-2"><Select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="w-48">
        {[["ACTIVE", "Active"], ["OPEN", "Open"], ["ACKNOWLEDGED", "Acknowledged"], ["RECOVERED", "Recovered"], ["ALL", "All"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select></div>
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : (
        <Card className="overflow-hidden">
          <Table>
            <THead><TR><TH>Alert</TH><TH>Severity</TH><TH>State</TH><TH>Opened</TH><TH>Last seen</TH><TH className="text-right">Seen</TH><TH>Notification</TH><TH /></TR></THead>
            <TBody>{q.data?.length ? q.data.map((a) => (
              <TR key={a.id}>
                <TD className="max-w-96"><button type="button" className="text-left hover:underline" onClick={() => setSel(a.id)}><span className="font-mono text-xs">{a.rule}</span> <span className="text-xs text-muted-foreground">{a.component}</span></button><div className="text-xs">{a.reason}</div>{a.suppressedBy && <div className="text-xs text-muted-foreground">recorded, not sent: a shared dependency is failing</div>}</TD>
                <TD><Badge tone={SEV[a.severity]}>{a.severity.toLowerCase()}</Badge></TD>
                <TD><Badge tone={STATE[a.state]}>{a.state.toLowerCase()}</Badge>{a.reopenCount > 0 && <div className="text-xs text-muted-foreground">reopened {a.reopenCount}×</div>}</TD>
                <TD className="text-xs">{t(a.openedAt)}</TD><TD className="text-xs">{t(a.recoveredAt ?? a.lastSeenAt)}</TD>
                <TD className="text-right tabular-nums text-xs">{a.occurrences}</TD>
                <TD className="text-xs">{a.notifyState.toLowerCase()}</TD>
                <TD>{a.state === "OPEN" && me.can("admin:ops:alerts") && <Button size="sm" variant="outline" onClick={() => setAck(a)}>Acknowledge</Button>}</TD>
              </TR>
            )) : <TR><TD colSpan={8} className="text-sm text-muted-foreground">No alerts.</TD></TR>}</TBody>
          </Table>
        </Card>
      )}
      {sel && d.data && (
        <Card className="mt-6 p-4">
          <p className="mb-2 font-medium"><span className="font-mono text-sm">{d.data.rule}</span> · {d.data.component}</p>
          <ol className="grid gap-1 text-xs">{d.data.events.map((e) => <li key={e.id}><span className="text-muted-foreground">{t(e.at)}</span> <Badge>{e.type.toLowerCase()}</Badge> {Object.keys(e.details).length ? JSON.stringify(e.details).slice(0, 200) : ""}</li>)}</ol>
        </Card>
      )}
      <ConfirmDialog open={Boolean(ack)} onOpenChange={(o) => !o && setAck(null)} title="Acknowledge alert?" description="Stops repeat notifications. The alert still recovers automatically; recorded in the audit log." confirmLabel="Acknowledge" loading={busy} confirmDisabled={reason.trim().length < 5} onConfirm={doAck}>
        <FormField label="Reason" htmlFor="ack-reason"><Textarea id="ack-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Investigating in OPS-42" /></FormField>
      </ConfirmDialog>
    </>
  );
}
