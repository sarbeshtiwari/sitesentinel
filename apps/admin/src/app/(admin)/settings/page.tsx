"use client";
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, cn, ConfirmDialog, FormField, Input, PageHeader,
  Select, Skeleton, Textarea, toast,
} from "@wim/ui";
import type { AdminSettingDto, DataEnvelope } from "@wim/contracts";
import { isSettingKey, SETTINGS } from "@wim/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { errorMessage, get, patch } from "@/lib/api";
import { qk, useAdminMe } from "@/lib/hooks";
import { friendlyZodError } from "@/lib/zod-messages";

type Kind = "boolean" | "number" | "enum" | "array" | "json" | "text";

function kindOf(s: AdminSettingDto): { kind: Kind; options?: string[]; nullable: boolean } {
  const schema = isSettingKey(s.key) ? (SETTINGS[s.key].schema as unknown as { options?: unknown }) : undefined;
  const nullable = s.defaultValue === null || s.value === null || (isSettingKey(s.key) && SETTINGS[s.key].schema.safeParse(null).success);
  if (schema && Array.isArray(schema.options) && schema.options.every((o) => typeof o === "string")) return { kind: "enum", options: schema.options as string[], nullable };
  const sample = s.value ?? s.defaultValue;
  if (typeof sample === "boolean") return { kind: "boolean", nullable };
  if (typeof sample === "number") return { kind: "number", nullable };
  if (Array.isArray(sample)) return { kind: "array", nullable };
  if (sample && typeof sample === "object") return { kind: "json", nullable };
  return { kind: "text", nullable };
}

/** Convert the edited control value back to a typed setting value. */
function toValue(kind: Kind, raw: string | boolean, nullable: boolean): unknown {
  if (kind === "boolean") return raw === true;
  const str = String(raw);
  if (nullable && str.trim() === "") return null;
  if (kind === "number") return str.trim() === "" ? NaN : Number(str);
  if (kind === "array" || kind === "json") {
    try { return JSON.parse(str); } catch { return str; }
  }
  return str;
}

function display(kind: Kind, v: unknown): string | boolean {
  if (kind === "boolean") return v === true;
  if (v === null || v === undefined) return "";
  if (kind === "array" || kind === "json") return JSON.stringify(v);
  return String(v);
}

const GROUP_LABELS: Record<string, string> = {
  branding: "Branding", legal: "Legal", auth: "Authentication", admin: "Admin sessions", trial: "Free trial", billing: "Billing & tax", platform: "Platform",
};

export default function SettingsPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const canWrite = me.can("admin:settings:write");
  const q = useQuery({ queryKey: qk.settings, queryFn: () => get<DataEnvelope<AdminSettingDto[]>>("/settings").then((r) => r.data) });
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = useMemo(() => new Map((q.data ?? []).map((s) => [s.key, kindOf(s)])), [q.data]);
  const groups = useMemo(() => {
    const m = new Map<string, AdminSettingDto[]>();
    for (const s of q.data ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [q.data]);

  const changes = Object.entries(edits).map(([key, raw]) => {
    const k = meta.get(key)!;
    return { key, value: toValue(k.kind, raw, k.nullable) };
  });
  // Client-side validation with the same registry schemas the API uses.
  const invalid = new Map<string, string>();
  for (const c of changes) {
    if (!isSettingKey(c.key)) continue;
    const r = SETTINGS[c.key].schema.safeParse(c.value, { error: friendlyZodError });
    if (!r.success) invalid.set(c.key, r.error.issues[0]?.message ?? "Invalid value");
  }
  const protectedChanges = changes.filter((c) => q.data?.find((x) => x.key === c.key)?.protected);
  const restartChanges = changes.filter((c) => q.data?.find((x) => x.key === c.key)?.apply === "restart");
  const reasonOk = reason.trim().length >= 5 && reason.trim().length <= 500 && (!protectedChanges.length || confirmProtected);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await patch<DataEnvelope<AdminSettingDto[]>>("/settings", { changes, reason: reason.trim(), ...(protectedChanges.length ? { confirmProtected } : {}) });
      qc.setQueryData(qk.settings, r.data);
      setEdits({});
      setReason("");
      setConfirm(false);
      toast.success(`${changes.length} setting${changes.length === 1 ? "" : "s"} updated. Changes apply within seconds.`);
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Platform settings" description="Validated, versioned and audited. Changes take effect without a redeploy." />
      {!canWrite && me.data && <Alert className="mb-4" title="Read-only">Only Super Admins can change settings.</Alert>}
      {q.isLoading ? <Skeleton className="h-96" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : (
        <div className="grid gap-6">
          {groups.map(([group, settings]) => (
            <Card key={group} className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between gap-2 py-3"><CardTitle>{GROUP_LABELS[group] ?? group}</CardTitle>
                <span className="text-xs tabular-nums text-muted-foreground">{settings.length} setting{settings.length === 1 ? "" : "s"}{settings.some((x) => x.key in edits) ? ` · ${settings.filter((x) => x.key in edits).length} modified` : ""}</span></CardHeader>
              <CardContent className="grid divide-y divide-border py-0">
                {settings.map((s) => {
                  const k = meta.get(s.key)!;
                  const current = s.key in edits ? edits[s.key]! : display(k.kind, s.value);
                  const set = (v: string | boolean) => setEdits((e) => {
                    const next = { ...e };
                    if (v === display(k.kind, s.value)) delete next[s.key]; else next[s.key] = v;
                    return next;
                  });
                  const id = `setting-${s.key}`;
                  const label = (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{s.key}</span>
                      {s.public && <Badge className="text-[10px]">public</Badge>}
                      {s.protected && <Badge tone="danger" className="text-[10px]">protected</Badge>}
                      {s.apply === "restart" && <Badge tone="warning" className="text-[10px]">restart required</Badge>}
                      {s.key in edits && <Badge tone="warning" className="text-[10px]">modified</Badge>}
                      {s.version !== null && <span className="text-[11px] font-normal text-muted-foreground">v{s.version}</span>}
                    </span>
                  );
                  return (
                    <FormField key={s.key} className={cn("py-4", s.key in edits && "-mx-5 border-l-2 border-l-warning bg-[color-mix(in_srgb,var(--warning)_4%,transparent)] px-5")} label={label} htmlFor={id} error={invalid.get(s.key)} hint={`${s.description}. Default: ${JSON.stringify(s.defaultValue)}`}>
                      {k.kind === "boolean" ? (
                        <label className="flex items-center gap-2 text-sm"><Checkbox id={id} disabled={!canWrite} checked={current === true} onChange={(e) => set(e.target.checked)} /> Enabled</label>
                      ) : k.kind === "enum" ? (
                        <Select id={id} disabled={!canWrite} value={String(current)} onChange={(e) => set(e.target.value)} className="max-w-xs">
                          {k.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      ) : (
                        <Input id={id} disabled={!canWrite} type={k.kind === "number" ? "number" : "text"} placeholder={k.nullable ? "Not set" : undefined} value={String(current)} onChange={(e) => set(e.target.value)} className={cn("max-w-2xl", (k.kind === "array" || k.kind === "json") && "font-mono text-xs", k.kind === "number" && "max-w-xs tabular-nums")} aria-invalid={invalid.has(s.key)} />
                      )}
                    </FormField>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canWrite && changes.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-6 rounded-lg border border-border-strong bg-card/95 px-4 py-3 shadow-md backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm"><span aria-hidden className="h-2 w-2 rounded-full bg-warning" /><span className="tabular-nums">{changes.length}</span> unsaved change{changes.length === 1 ? "" : "s"}{invalid.size > 0 && <span className="text-xs text-danger">· {invalid.size} invalid</span>}</span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEdits({})}>Discard</Button>
              <Button disabled={invalid.size > 0} onClick={() => { setError(null); setConfirm(true); }}>Review & save</Button>
            </div>
          </div>
        </div>
      )}
      {error && <Alert tone="danger" className="fixed bottom-20 right-4 z-30 max-w-md" title={error} />}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Save setting changes?" description="A reason is required. It is recorded in the platform audit log with each change." confirmLabel="Save changes" loading={busy} confirmDisabled={!reasonOk} onConfirm={save}>
        <div className="grid gap-3">
          <ul className="grid gap-1 rounded-md border border-border bg-sunken p-3 font-mono text-xs">
            {changes.map((c) => <li key={c.key}>{c.key} → {JSON.stringify(c.value)}</li>)}
          </ul>
          {restartChanges.length > 0 && <Alert tone="warning" title="Restart required">{restartChanges.map((c) => c.key).join(", ")} take effect when the workers of that queue restart.</Alert>}
          {protectedChanges.length > 0 && (
            <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmProtected} onChange={(e) => setConfirmProtected(e.target.checked)} />
              <span>I confirm the change to protected security policies: {protectedChanges.map((c) => c.key).join(", ")}</span></label>
          )}
          <FormField label="Reason" htmlFor="reason" error={reason && !reasonOk ? "5 to 500 characters" : undefined}>
            <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rebranding approved in ticket OPS-123" />
          </FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}
