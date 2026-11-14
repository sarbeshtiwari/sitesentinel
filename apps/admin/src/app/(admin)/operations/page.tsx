"use client";
import { Alert, Badge, Button, Card, CardDescription, CardHeader, CardTitle, Checkbox, ConfirmDialog, FormField, Input, PageHeader, Skeleton, Table, TBody, TD, Textarea, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import { isSettingKey, SETTINGS } from "@wim/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage, get, patch } from "@/lib/api";
import { useAdminMe } from "@/lib/hooks";

interface Setting { key: string; description: string; value: unknown; defaultValue: unknown; isDefault: boolean; version: number | null; updatedAt: string | null; protected: boolean; apply: "live" | "restart"; scope: string }
interface Config { sections: Array<{ section: string; settings: Setting[] }>; retention: Array<{ table: string; granularity: string; retainDays: number; minimumDays: number }>; alertRules: string[]; notes: string[] }
const TITLE: Record<string, string> = {
  features: "Feature availability & kill switches", scheduling: "Scheduling limits", queues: "Queues: concurrency, retries, timeouts", limits: "Resource limits",
  performance: "Performance defaults", alerts: "Alert thresholds & noise protection", health: "Health evaluation", cooldowns: "Operational cooldowns",
  retention: "Retention (feature data)", security: "Protected security policies",
};
const show = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

/**
 * Operational configuration: grouped, with what is protected, what needs a restart and what is global. Every change is
 * validated by the server (single values and the combination), audited with before/after and hot-reloaded.
 */
export default function OperationsConfigPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const canWrite = me.can("admin:settings:write");
  const canProtected = me.can("admin:settings:protected");
  const q = useQuery({ queryKey: ["ops", "config"], queryFn: ({ signal }) => get<DataEnvelope<Config>>("/ops/config", { signal }).then((r) => r.data) });
  const [edit, setEdit] = useState<{ s: Setting; raw: string } | null>(null);
  const [ret, setRet] = useState<{ table: string; days: string; min: number } | null>(null);
  const [reason, setReason] = useState("");
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = (() => {
    if (!edit) return { ok: false, value: null as unknown, error: "" };
    let value: unknown;
    const def = edit.s.defaultValue;
    try { value = typeof def === "string" ? edit.raw : JSON.parse(edit.raw); } catch { return { ok: false, value: null, error: "Not valid JSON" }; }
    if (!isSettingKey(edit.s.key)) return { ok: false, value, error: "Unknown setting" };
    const r = SETTINGS[edit.s.key].schema.safeParse(value);
    return r.success ? { ok: true, value: r.data, error: "" } : { ok: false, value, error: r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") };
  })();
  const save = async () => {
    setBusy(true);
    try {
      if (edit) await patch("/settings", { changes: [{ key: edit.s.key, value: parsed.value }], reason: reason.trim(), ...(edit.s.protected ? { confirmProtected } : {}) });
      if (ret) await api("PUT", `/ops/config/retention/${ret.table}`, { days: Number(ret.days), reason: reason.trim() });
      toast.success(edit?.s.apply === "restart" ? "Saved — takes effect when the workers restart" : "Saved — applies within seconds");
      setEdit(null); setRet(null); setReason(""); setConfirmProtected(false);
      await qc.invalidateQueries({ queryKey: ["ops", "config"] });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const d = q.data;
  return (
    <>
      <PageHeader title="Operations configuration" description="Global operational settings. Validated, combination-checked, audited with previous and new values." />
      {!canWrite && me.data && <Alert className="mb-4" title="Read-only">Your role can view but not change operational settings.</Alert>}
      {q.isLoading ? <Skeleton className="h-96" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : d && (
        <div className="grid gap-6">
          <Alert title="Scope">{d.notes.join(" ")} <Link className="underline" href="/settings">All settings</Link></Alert>
          {d.sections.filter((s) => s.settings.length).map((sec) => (
            <Card key={sec.section} className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3"><CardTitle>{TITLE[sec.section] ?? sec.section}</CardTitle><span className="text-xs tabular-nums text-muted-foreground">{sec.settings.length} setting{sec.settings.length === 1 ? "" : "s"}{sec.settings.some((x) => !x.isDefault) ? ` · ${sec.settings.filter((x) => !x.isDefault).length} changed` : ""}</span></CardHeader>
              <Table>
                <THead><TR><TH>Setting</TH><TH>Value</TH><TH>Default</TH><TH className="relative"><span className="sr-only">Actions</span></TH></TR></THead>
                <TBody>{sec.settings.map((s) => (
                  <TR key={s.key}>
                    <TD className="max-w-96"><div className="flex flex-wrap items-center gap-1"><span className="font-mono text-xs font-medium">{s.key}</span>{s.protected && <Badge tone="danger" className="text-[10px]">protected</Badge>}{s.apply === "restart" && <Badge tone="warning" className="text-[10px]">restart required</Badge>}<Badge className="text-[10px]">{s.scope}</Badge></div><div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div></TD>
                    <TD className="max-w-72 break-all font-mono text-xs"><span className={s.isDefault ? undefined : "font-semibold text-foreground"}>{show(s.value)}</span>{!s.isDefault && <div className="font-sans tabular-nums text-muted-foreground">v{s.version} · {s.updatedAt?.slice(0, 16).replace("T", " ")}</div>}</TD>
                    <TD className="max-w-48 break-all font-mono text-xs text-muted-foreground">{show(s.defaultValue)}</TD>
                    <TD className="text-right">{canWrite && (!s.protected || canProtected) && <Button size="sm" variant="outline" onClick={() => { setReason(""); setEdit({ s, raw: show(s.value) }); }}>Change</Button>}</TD>
                  </TR>
                ))}</TBody>
              </Table>
            </Card>
          ))}
          <Card className="overflow-hidden">
            <CardHeader className="py-3"><CardTitle>History retention (partitioned tables)</CardTitle><CardDescription className="text-xs">Older partitions are dropped by the hourly maintenance job. Minimums protect audit, security and reconciliation needs.</CardDescription></CardHeader>
            <Table>
              <THead><TR><TH>Table</TH><TH className="text-right">Kept (days)</TH><TH className="text-right">Minimum</TH><TH className="relative"><span className="sr-only">Actions</span></TH></TR></THead>
              <TBody>{d.retention.map((r) => (
                <TR key={r.table}><TD className="font-mono text-xs font-medium">{r.table}</TD><TD className="text-right tabular-nums">{r.retainDays}</TD><TD className="text-right tabular-nums text-muted-foreground">{r.minimumDays}</TD>
                  <TD className="text-right">{canWrite && <Button size="sm" variant="outline" onClick={() => { setReason(""); setRet({ table: r.table, days: String(r.retainDays), min: r.minimumDays }); }}>Change</Button>}</TD></TR>
              ))}</TBody>
            </Table>
          </Card>
        </div>
      )}
      <ConfirmDialog open={Boolean(edit || ret)} onOpenChange={(o) => { if (!o) { setEdit(null); setRet(null); } }} loading={busy}
        title={edit ? `Change ${edit.s.key}` : `Retention of ${ret?.table}`} confirmLabel="Save"
        description={edit?.s.apply === "restart" ? "Takes effect when the workers of this queue restart." : "Applies within about 30 seconds on every process."}
        confirmDisabled={reason.trim().length < 5 || (edit ? !parsed.ok || (edit.s.protected && !confirmProtected) : !ret || Number(ret.days) < ret.min)} onConfirm={save}>
        <div className="grid gap-3">
          {edit && <FormField label="Value" htmlFor="ops-value" error={parsed.ok ? undefined : parsed.error}><Textarea id="ops-value" rows={edit.raw.length > 60 ? 6 : 2} className="font-mono text-xs" value={edit.raw} onChange={(e) => setEdit({ ...edit, raw: e.target.value })} /></FormField>}
          {ret && <FormField label={`Days (minimum ${ret.min})`} htmlFor="ret-days"><Input id="ret-days" type="number" min={ret.min} max={1095} value={ret.days} onChange={(e) => setRet({ ...ret, days: e.target.value })} /></FormField>}
          {edit?.s.protected && <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmProtected} onChange={(e) => setConfirmProtected(e.target.checked)} /> This is a protected security policy. I confirm the change.</label>}
          <FormField label="Reason (recorded in the audit log)" htmlFor="ops-reason"><Textarea id="ops-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}
