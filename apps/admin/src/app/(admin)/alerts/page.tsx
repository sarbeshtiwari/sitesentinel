"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, FormField, PageHeader, Select, Skeleton, Table, TBody, TD, Textarea, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
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
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <Select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="h-8 w-44">
              {[["ACTIVE", "Active"], ["OPEN", "Open"], ["ACKNOWLEDGED", "Acknowledged"], ["RECOVERED", "Recovered"], ["ALL", "All"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            {q.data && q.data.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums">{q.data.length} alert{q.data.length === 1 ? "" : "s"}</span>
                {(["CRITICAL", "WARNING", "INFO"] as const).map((sv) => { const c = q.data.filter((a) => a.severity === sv).length; return c ? <Badge key={sv} tone={SEV[sv]} className="tabular-nums">{c} {sv.toLowerCase()}</Badge> : null; })}
              </div>
            )}
          </div>
          <Table>
            <THead><TR><TH>Alert</TH><TH>Severity</TH><TH>State</TH><TH>Opened</TH><TH>Last seen</TH><TH className="text-right">Seen</TH><TH>Notification</TH><TH className="relative"><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>{q.data?.length ? q.data.map((a) => (
              <TR key={a.id}>
                <TD className="max-w-96"><button type="button" aria-expanded={sel === a.id} className="text-left underline-offset-2 hover:underline" onClick={() => setSel(a.id)}><span className="font-mono text-xs font-medium">{a.rule}</span> <span className="font-mono text-xs text-muted-foreground">{a.component}</span></button><div className="mt-0.5 text-xs">{a.reason}</div>{a.suppressedBy && <div className="text-xs text-muted-foreground">recorded, not sent: a shared dependency is failing</div>}</TD>
                <TD><Badge tone={SEV[a.severity]}>{a.severity.toLowerCase()}</Badge></TD>
                <TD><Badge tone={STATE[a.state]}>{a.state.toLowerCase()}</Badge>{a.reopenCount > 0 && <div className="text-xs text-muted-foreground">reopened {a.reopenCount}×</div>}</TD>
                <TD className="whitespace-nowrap text-xs tabular-nums">{t(a.openedAt)}</TD><TD className="whitespace-nowrap text-xs tabular-nums">{t(a.recoveredAt ?? a.lastSeenAt)}</TD>
                <TD className="text-right tabular-nums text-xs">{a.occurrences}</TD>
                <TD className="text-xs">{a.notifyState.toLowerCase()}</TD>
                <TD className="text-right">{a.state === "OPEN" && me.can("admin:ops:alerts") && <Button size="sm" variant="outline" onClick={() => setAck(a)}>Acknowledge</Button>}</TD>
              </TR>
            )) : <TR><TD colSpan={8} className="py-10 text-center text-sm text-muted-foreground"><CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-success" aria-hidden />No alerts.</TD></TR>}</TBody>
          </Table>
        </Card>
      )}
      {sel && d.data && (
        <Card className="mt-6 overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div className="grid gap-1"><CardTitle className="font-mono text-sm">{d.data.rule}</CardTitle><CardDescription className="font-mono text-xs">{d.data.component}</CardDescription></div>
            <div className="flex gap-1.5"><Badge tone={SEV[d.data.severity]}>{d.data.severity.toLowerCase()}</Badge><Badge tone={STATE[d.data.state]}>{d.data.state.toLowerCase()}</Badge></div>
          </CardHeader>
          <CardContent>
            <ol className="relative grid gap-2.5 border-l border-border pl-4 text-xs">{d.data.events.map((e) => (
              <li key={e.id} className="relative"><span aria-hidden className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-border-strong ring-2 ring-card" />
                <span className="tabular-nums text-muted-foreground">{t(e.at)}</span> <Badge>{e.type.toLowerCase()}</Badge> <span className="break-all font-mono text-[11px]">{Object.keys(e.details).length ? JSON.stringify(e.details).slice(0, 200) : ""}</span></li>
            ))}</ol>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={Boolean(ack)} onOpenChange={(o) => !o && setAck(null)} title="Acknowledge alert?" description="Stops repeat notifications. The alert still recovers automatically; recorded in the audit log." confirmLabel="Acknowledge" loading={busy} confirmDisabled={reason.trim().length < 5} onConfirm={doAck}>
        <FormField label="Reason" htmlFor="ack-reason"><Textarea id="ack-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Investigating in OPS-42" /></FormField>
      </ConfirmDialog>
    </>
  );
}
