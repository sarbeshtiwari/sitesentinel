"use client";
import { Alert, Badge, Button, Card, CardDescription, CardHeader, CardTitle, ConfirmDialog, FilterBar, FormField, Input, PageHeader, Skeleton, Table, TBody, TD, Textarea, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { useAdminMe } from "@/lib/hooks";

interface Usage { from: string; to: string; totals: Array<{ key: string; value: number; kind: string; label: string; unit: string }>; billable: Record<string, number>; organisations: Array<{ orgId: string; name: string | null; billable: Record<string, number> }>; policy: string }
interface Run { id: string; day: string; status: string; requestedAt: string; finishedAt: string | null; discrepancies: number; error: string | null; stats: { ms?: number; orgs?: number } | null }
interface RunDetail { id: string; day: string; status: string; discrepancies: Array<{ id: string; orgId: string; orgName: string | null; check: string; key: string | null; recorded: number; expected: number; difference: number; status: string; resolution: string | null }> }
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const v = (n: number | undefined) => (n ?? 0).toLocaleString("en");
const COLS = ["http.checks", "browser.executions", "browser.screenshots", "browser.functional_tests", "deepscan.scans", "deepscan.pages"];

/** Usage accounting: totals, billable quantities per organisation (counts only) and reconciliation against the ledger. */
export default function UsagePage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | { kind: "reconcile" } | { kind: "adjust"; d: RunDetail["discrepancies"][number]; day: string } | { kind: "accept"; d: RunDetail["discrepancies"][number] }>(null);
  const [reason, setReason] = useState("");
  const [day, setDay] = useState(daysAgo(1));
  const [busy, setBusy] = useState(false);
  const u = useQuery({ queryKey: ["ops", "usage", range], queryFn: ({ signal }) => get<DataEnvelope<Usage>>(`/ops/usage?from=${range.from}&to=${range.to}`, { signal }).then((r) => r.data) });
  const runs = useQuery({ queryKey: ["ops", "recon"], queryFn: ({ signal }) => get<DataEnvelope<Run[]>>("/ops/usage/reconciliations", { signal }).then((r) => r.data), refetchInterval: 15_000 });
  const run = useQuery({ queryKey: ["ops", "recon", sel], enabled: Boolean(sel), queryFn: ({ signal }) => get<DataEnvelope<RunDetail>>(`/ops/usage/reconciliations/${sel}`, { signal }).then((r) => r.data) });
  const act = async () => {
    if (!dlg) return;
    setBusy(true);
    try {
      if (dlg.kind === "reconcile") await post("/ops/usage/reconciliations", { day, reason: reason.trim() });
      else if (dlg.kind === "adjust") await post("/ops/usage/adjustments", { orgId: dlg.d.orgId, day: dlg.day, key: dlg.d.key, delta: -dlg.d.difference, reason: reason.trim(), discrepancyId: dlg.d.id });
      else await post(`/ops/usage/discrepancies/${dlg.d.id}/accept`, { reason: reason.trim() });
      toast.success(dlg.kind === "reconcile" ? "Reconciliation requested — runs within a minute" : "Recorded in the audit log");
      setDlg(null); setReason("");
      await qc.invalidateQueries({ queryKey: ["ops"] });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const minReason = dlg?.kind === "reconcile" ? 5 : 10;
  return (
    <>
      <PageHeader title="Usage accounting" description="Recorded usage, billable quantities and reconciliation against the execution ledger. Counts only — no customer content." />
      <FilterBar trailing={<span className="text-xs tabular-nums text-muted-foreground">{range.from} → {range.to} (UTC)</span>}>
        <FormField label="From" htmlFor="from"><Input id="from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></FormField>
        <FormField label="To" htmlFor="to"><Input id="to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></FormField>
      </FilterBar>
      {u.isLoading ? <Skeleton className="h-64" /> : u.isError ? <Alert tone="danger" title={errorMessage(u.error)} /> : u.data && (
        <div className="grid gap-6">
          <Alert title="Accounting rules">{u.data.policy}</Alert>
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Billable usage by organisation (top 100)</CardTitle><CardDescription>Billable counts per organisation for the selected range</CardDescription></CardHeader>
            <Table>
              <THead><TR><TH>Organisation</TH>{COLS.map((c) => <TH key={c} className="text-right font-mono normal-case tracking-normal">{c}</TH>)}</TR></THead>
              <TBody>{u.data.organisations.length ? u.data.organisations.map((o) => (
                <TR key={o.orgId}><TD className={o.name ? "font-medium" : "font-mono text-xs"}>{o.name ?? o.orgId.slice(0, 8)}</TD>{COLS.map((c) => <TD key={c} className="text-right tabular-nums text-xs">{v(o.billable[c])}</TD>)}</TR>
              )) : <TR><TD colSpan={COLS.length + 1} className="py-8 text-center text-sm text-muted-foreground">No usage in this range.</TD></TR>}</TBody>
            </Table>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader><CardTitle>All recorded counters</CardTitle><CardDescription>Totals for the selected range, by counter kind</CardDescription></CardHeader>
            <Table>
              <THead><TR><TH>Counter</TH><TH>Kind</TH><TH className="text-right">Total</TH></TR></THead>
              <TBody>{u.data.totals.map((x) => <TR key={x.key}><TD className="text-xs"><span className="font-mono font-medium">{x.key}</span> <span className="text-muted-foreground">{x.label}</span></TD><TD><Badge tone={x.kind === "work" ? "brand" : x.kind === "overhead" ? "warning" : "neutral"}>{x.kind}</Badge></TD><TD className="text-right tabular-nums text-xs">{v(x.value)}</TD></TR>)}</TBody>
            </Table>
          </Card>
        </div>
      )}
      <Card className="mt-6 overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-2"><div className="grid gap-1"><CardTitle>Reconciliation</CardTitle><CardDescription>Daily comparison of recorded usage with the execution ledger</CardDescription></div>
          <Button size="sm" variant="outline" onClick={() => setDlg({ kind: "reconcile" })}>Reconcile a day…</Button></CardHeader>
        <div>
          <Table>
            <THead><TR><TH>Day</TH><TH>Status</TH><TH className="text-right">Discrepancies</TH><TH>Finished</TH></TR></THead>
            <TBody>{(runs.data ?? []).map((r) => (
              <TR key={r.id} className={sel === r.id ? "bg-sunken/70" : undefined}><TD><button type="button" className="font-medium tabular-nums text-primary underline-offset-2 hover:underline" onClick={() => setSel(r.id)}>{r.day}</button></TD><TD><Badge tone={r.status === "DONE" ? (r.discrepancies ? "warning" : "success") : r.status === "FAILED" ? "danger" : "neutral"}>{r.status.toLowerCase()}</Badge>{r.error && <div className="text-xs text-danger">{r.error}</div>}</TD>
                <TD className="text-right tabular-nums">{r.discrepancies}</TD><TD className="text-xs tabular-nums text-muted-foreground">{r.finishedAt?.slice(0, 19).replace("T", " ") ?? "—"}{r.stats?.ms != null ? ` · ${r.stats.ms} ms, ${r.stats.orgs} orgs` : ""}</TD></TR>
            ))}{runs.data && !runs.data.length && <TR><TD colSpan={4} className="py-8 text-center text-sm text-muted-foreground">No reconciliation runs yet.</TD></TR>}</TBody>
          </Table>
          {sel && run.data && (
            <div className="border-t border-border">
              <p className="bg-sunken/50 px-4 py-2.5 text-sm font-medium">Discrepancies for <span className="tabular-nums">{run.data.day}</span> <span className="font-normal text-muted-foreground">— nothing is corrected automatically</span></p>
              <Table>
                <THead><TR><TH>Organisation</TH><TH>Check</TH><TH className="text-right">Recorded</TH><TH className="text-right">Expected</TH><TH>Status</TH><TH className="relative"><span className="sr-only">Actions</span></TH></TR></THead>
                <TBody>{run.data.discrepancies.length ? run.data.discrepancies.map((x) => (
                  <TR key={x.id}><TD className={x.orgName ? "text-xs" : "font-mono text-xs"}>{x.orgName ?? x.orgId.slice(0, 8)}</TD><TD className="font-mono text-xs">{x.check}</TD><TD className="text-right tabular-nums text-xs">{v(x.recorded)}</TD><TD className="text-right tabular-nums text-xs">{v(x.expected)}</TD>
                    <TD className="text-xs"><Badge tone={x.status === "OPEN" ? "warning" : "neutral"}>{x.status.toLowerCase()}</Badge>{x.resolution ? <span className="text-muted-foreground"> — {x.resolution}</span> : ""}</TD>
                    <TD className="text-right">{x.status === "OPEN" && me.can("admin:usage:adjust") && <div className="flex justify-end gap-1">{x.key && <Button size="sm" variant="outline" onClick={() => setDlg({ kind: "adjust", d: x, day: run.data!.day })}>Adjust</Button>}<Button size="sm" variant="ghost" onClick={() => setDlg({ kind: "accept", d: x })}>Accept</Button></div>}</TD></TR>
                )) : <TR><TD colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Usage matches the ledger for this day.</TD></TR>}</TBody>
              </Table>
            </div>
          )}
        </div>
      </Card>
      <ConfirmDialog open={Boolean(dlg)} onOpenChange={(o) => !o && setDlg(null)} loading={busy} confirmDisabled={reason.trim().length < minReason} onConfirm={act}
        title={dlg?.kind === "reconcile" ? "Reconcile a day" : dlg?.kind === "adjust" ? "Adjust usage counter" : "Accept discrepancy"}
        description={dlg?.kind === "adjust" ? `Changes ${dlg.d.key} by ${-dlg.d.difference} for this organisation. Recorded with your reason in the audit log.` : dlg?.kind === "accept" ? "Marks the difference as explained without changing usage." : "Compares the day's usage with the ledger, stored results and artifacts."}
        confirmLabel={dlg?.kind === "reconcile" ? "Request" : "Confirm"}>
        <div className="grid gap-3">
          {dlg?.kind === "reconcile" && <FormField label="Day (UTC)" htmlFor="rday"><Input id="rday" type="date" max={daysAgo(1)} value={day} onChange={(e) => setDay(e.target.value)} /></FormField>}
          <FormField label={`Reason (at least ${minReason} characters)`} htmlFor="ureason"><Textarea id="ureason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}
