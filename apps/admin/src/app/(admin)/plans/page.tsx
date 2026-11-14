"use client";
import {
  Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, FormField, Input, Label, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR, Textarea, toast,
} from "@wim/ui";
import type { DataEnvelope, PlanDto, PlanPriceDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import { errorMessage, get, patch, post, put } from "@/lib/api";
import { useAdminMe } from "@/lib/hooks";

type EntitlementKey = { key: string; type: "number" | "boolean" };
const plansKey = ["billing", "plans"] as const;
const keysKey = ["billing", "entitlement-keys"] as const;

function money(amountMinor: number, currency: string) {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor} ${currency} (minor units)`;
  }
}
const minorDigits = (currency: string) => {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
};

type Mode =
  | { kind: "create" }
  | { kind: "details"; plan: PlanDto }
  | { kind: "entitlements"; plan: PlanDto }
  | { kind: "price"; plan: PlanDto }
  | { kind: "editPrice"; plan: PlanDto; price: PlanPriceDto; raw: { stripePriceId?: string; razorpayPlanId?: string } };

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <FormField label="Reason (recorded in the audit log)" htmlFor="reason" hint="Required, at least 5 characters.">
      <Textarea id="reason" rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}

export default function PlansPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const canRead = me.can("admin:billing:read");
  const canWrite = me.can("admin:billing:write");
  const plans = useQuery({ queryKey: plansKey, queryFn: () => get<DataEnvelope<PlanDto[]>>("/billing/plans").then((r) => r.data), enabled: canRead });
  const keys = useQuery({ queryKey: keysKey, queryFn: () => get<DataEnvelope<EntitlementKey[]>>("/billing/entitlement-keys").then((r) => r.data), enabled: canRead });
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // form state shared by the dialogs (reset when a dialog opens)
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [ents, setEnts] = useState<Record<string, string | boolean>>({});

  const open = (m: Mode) => {
    setReason(""); setError(null);
    if (m.kind === "create") setForm({ key: "", name: "", description: "", visible: true, trialEligible: true, sortOrder: "0" });
    if (m.kind === "details") setForm({ name: m.plan.name, description: m.plan.description, visible: m.plan.visible, active: m.plan.active, trialEligible: m.plan.trialEligible, sortOrder: String(m.plan.sortOrder) });
    if (m.kind === "entitlements") setEnts(Object.fromEntries(Object.entries(m.plan.entitlements).map(([k, v]) => [k, typeof v === "boolean" ? v : String(v)])));
    if (m.kind === "price") setForm({ interval: "MONTH", currency: "INR", amount: "", stripePriceId: "", razorpayPlanId: "" });
    if (m.kind === "editPrice") setForm({ stripePriceId: "", razorpayPlanId: "" });
    setMode(m);
  };

  const submit = async () => {
    if (!mode) return;
    setBusy(true); setError(null);
    const r = reason.trim();
    const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    try {
      if (mode.kind === "create") {
        await post("/billing/plans", { key: String(form.key).trim(), name: String(form.name).trim(), description: String(form.description).trim(), visible: form.visible, trialEligible: form.trialEligible, sortOrder: Number(form.sortOrder) || 0, reason: r });
      } else if (mode.kind === "details") {
        await patch(`/billing/plans/${mode.plan.id}`, { name: String(form.name).trim(), description: String(form.description).trim(), visible: form.visible, active: form.active, trialEligible: form.trialEligible, sortOrder: Number(form.sortOrder) || 0, reason: r });
      } else if (mode.kind === "entitlements") {
        const types = new Map((keys.data ?? []).map((k) => [k.key, k.type]));
        const out: Record<string, number | boolean> = {};
        for (const [k, v] of Object.entries(ents)) {
          if (types.get(k) === "boolean") out[k] = Boolean(v);
          else {
            if (v === "" ) continue; // blank number = not set (platform default applies)
            const n = Number(v);
            if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
            out[k] = n;
          }
        }
        await put(`/billing/plans/${mode.plan.id}/entitlements`, { entitlements: out, reason: r });
      } else if (mode.kind === "price") {
        const cur = String(form.currency).trim().toUpperCase();
        const amount = Number(form.amount);
        if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter a valid amount");
        await post(`/billing/plans/${mode.plan.id}/prices`, {
          interval: form.interval, currency: cur, amountMinor: Math.round(amount * 10 ** minorDigits(cur)),
          stripePriceId: opt(form.stripePriceId), razorpayPlanId: opt(form.razorpayPlanId), reason: r,
        });
      } else if (mode.kind === "editPrice") {
        await patch(`/billing/prices/${mode.price.id}`, { stripePriceId: opt(form.stripePriceId), razorpayPlanId: opt(form.razorpayPlanId), reason: r });
      }
      toast.success("Saved");
      setMode(null);
      await qc.invalidateQueries({ queryKey: plansKey });
    } catch (e) {
      setError(e instanceof Error && !("status" in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const [toggle, setToggle] = useState<{ price: PlanPriceDto } | null>(null);
  const togglePrice = async () => {
    if (!toggle) return;
    setBusy(true); setError(null);
    try {
      await patch(`/billing/prices/${toggle.price.id}`, { active: !toggle.price.active, reason: reason.trim() });
      toast.success(toggle.price.active ? "Price deactivated" : "Price activated");
      setToggle(null);
      await qc.invalidateQueries({ queryKey: plansKey });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (me.isLoading) return <Skeleton className="h-40" />;
  if (!canRead) return <><PageHeader title="Plans" /><Alert tone="warning" title="You don't have access to plans" /></>;

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const reasonOk = reason.trim().length >= 5;

  return (
    <>
      <PageHeader
        title="Plans"
        description="Plans, immutable price versions and entitlements. Entitlement changes apply to every organization on the plan within about a minute, without a redeploy."
        actions={canWrite ? <Button onClick={() => open({ kind: "create" })}><Plus className="h-4 w-4" aria-hidden />New plan</Button> : undefined}
      />
      {plans.isLoading ? <Skeleton className="h-64" /> : plans.isError ? <Alert tone="danger" title={errorMessage(plans.error)} /> : !plans.data?.length ? (
        <EmptyState icon={<Layers />} title="No plans yet" description="Run the database seed for the example plans, or create one." />
      ) : (
        <div className="grid gap-5">
          {plans.data.some((p) => /example/i.test(p.description)) && (
            <Alert tone="warning" title="Example prices">Seeded plans carry placeholder prices (decision B2). Review and replace them before enabling billing.</Alert>
          )}
          {plans.data.map((p) => (
            <Card key={p.id} className="overflow-hidden">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-semibold">{p.name}</h2>
                    <Badge className="font-mono">{p.key}</Badge>
                    {!p.active && <Badge tone="danger">inactive</Badge>}
                    {!p.visible && <Badge>hidden</Badge>}
                    {p.trialEligible && <Badge tone="info">trial eligible</Badge>}
                  </div>
                  {p.description && <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>}
                </div>
                {canWrite && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => open({ kind: "details", plan: p })}>Edit details</Button>
                    <Button size="sm" variant="outline" onClick={() => open({ kind: "entitlements", plan: p })}>Entitlements</Button>
                    <Button size="sm" variant="outline" onClick={() => open({ kind: "price", plan: p })}>Add price</Button>
                  </div>
                )}
              </div>
              <div className="grid gap-0 lg:grid-cols-[3fr_2fr]">
                <div className="overflow-x-auto">
                  {p.prices.length === 0 ? <p className="px-4 py-4 text-sm text-muted-foreground">No prices.</p> : (
                    <Table>
                      <THead><TR><TH>Interval</TH><TH>Amount</TH><TH>Version</TH><TH>Status</TH><TH>Gateways</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
                      <TBody>
                        {[...p.prices].sort((a, b) => a.currency.localeCompare(b.currency) || a.interval.localeCompare(b.interval) || b.version - a.version).map((pr) => (
                          <TR key={pr.id}>
                            <TD>{pr.interval === "YEAR" ? "Annual" : "Monthly"}</TD>
                            <TD className="tabular-nums">{money(pr.amountMinor, pr.currency)}</TD>
                            <TD className="tabular-nums">v{pr.version}</TD>
                            <TD>{pr.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}</TD>
                            <TD className="text-xs">
                              <span className={pr.stripeLinked ? "" : "text-muted-foreground"}>Stripe {pr.stripeLinked ? "linked" : "—"}</span>
                              {" · "}
                              <span className={pr.razorpayLinked ? "" : "text-muted-foreground"}>Razorpay {pr.razorpayLinked ? "linked" : "—"}</span>
                            </TD>
                            <TD className="text-right">
                              {canWrite && (
                                <div className="flex justify-end gap-2">
                                  {(!pr.stripeLinked || !pr.razorpayLinked) && <Button size="sm" variant="ghost" onClick={() => open({ kind: "editPrice", plan: p, price: pr, raw: {} })}>Link</Button>}
                                  <Button size="sm" variant="ghost" onClick={() => { setReason(""); setError(null); setToggle({ price: pr }); }}>{pr.active ? "Deactivate" : "Activate"}</Button>
                                </div>
                              )}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </div>
                <div className="border-t border-border px-4 py-3 lg:border-l lg:border-t-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Entitlements</p>
                  {Object.keys(p.entitlements).length === 0 ? <p className="mt-2 text-sm text-muted-foreground">None: platform defaults apply.</p> : (
                    <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                      {Object.entries(p.entitlements).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
                        <div key={k} className="contents"><dt className="truncate font-mono text-muted-foreground">{k}</dt><dd className="text-right tabular-nums">{String(v)}</dd></div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        className="max-w-2xl"
        title={mode?.kind === "create" ? "New plan" : mode?.kind === "details" ? `Edit ${mode.plan.name}` : mode?.kind === "entitlements" ? `Entitlements: ${mode.plan.name}`
          : mode?.kind === "price" ? `New price version: ${mode.plan.name}` : mode?.kind === "editPrice" ? "Link gateway ids" : ""}
        description={mode?.kind === "price" ? "Prices are immutable. A new version deactivates the previous active version for the same interval and currency; existing subscriptions keep their price."
          : mode?.kind === "entitlements" ? "Replaces the plan's full entitlement set. Leave a number blank to use the platform default."
          : mode?.kind === "editPrice" ? "A gateway id can only be linked once. To change it, create a new price version." : undefined}
        footer={<>
          <Button variant="outline" onClick={() => setMode(null)}>Cancel</Button>
          <Button loading={busy} disabled={!reasonOk} onClick={submit}>Save</Button>
        </>}
      >
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
          {error && <Alert tone="danger" title={error} />}
          {(mode?.kind === "create" || mode?.kind === "details") && <>
            {mode.kind === "create" && (
              <FormField label="Key" htmlFor="pkey" hint="Lowercase, e.g. starter. Cannot be changed later.">
                <Input id="pkey" value={String(form.key ?? "")} onChange={(e) => set("key", e.target.value)} />
              </FormField>
            )}
            <FormField label="Name" htmlFor="pname"><Input id="pname" value={String(form.name ?? "")} onChange={(e) => set("name", e.target.value)} /></FormField>
            <FormField label="Description" htmlFor="pdesc"><Textarea id="pdesc" rows={2} value={String(form.description ?? "")} onChange={(e) => set("description", e.target.value)} /></FormField>
            <FormField label="Sort order" htmlFor="psort"><Input id="psort" type="number" min={0} max={1000} value={String(form.sortOrder ?? "0")} onChange={(e) => set("sortOrder", e.target.value)} /></FormField>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><Checkbox checked={Boolean(form.visible)} onChange={(e) => set("visible", e.target.checked)} />Visible to customers</label>
              <label className="flex items-center gap-2"><Checkbox checked={Boolean(form.trialEligible)} onChange={(e) => set("trialEligible", e.target.checked)} />Trial eligible</label>
              {mode.kind === "details" && <label className="flex items-center gap-2"><Checkbox checked={Boolean(form.active)} onChange={(e) => set("active", e.target.checked)} />Active</label>}
            </div>
          </>}
          {mode?.kind === "entitlements" && (
            keys.isLoading ? <Skeleton className="h-40" /> : keys.isError ? <Alert tone="danger" title={errorMessage(keys.error)} /> : (
              <Table>
                <THead><TR><TH>Key</TH><TH>Value</TH></TR></THead>
                <TBody>
                  {(keys.data ?? []).map((k) => (
                    <TR key={k.key}>
                      <TD className="font-mono text-xs"><Label htmlFor={`ent-${k.key}`}>{k.key}</Label></TD>
                      <TD>
                        {k.type === "boolean" ? (
                          <Select id={`ent-${k.key}`} className="w-36" value={k.key in ents ? String(ents[k.key]) : ""} onChange={(e) => setEnts((s) => {
                            const n = { ...s };
                            if (e.target.value === "") delete n[k.key]; else n[k.key] = e.target.value === "true";
                            return n;
                          })}>
                            <option value="">default</option><option value="true">yes</option><option value="false">no</option>
                          </Select>
                        ) : (
                          <Input id={`ent-${k.key}`} className="w-36" type="number" placeholder="default" value={typeof ents[k.key] === "string" ? String(ents[k.key]) : ""} onChange={(e) => setEnts((s) => ({ ...s, [k.key]: e.target.value }))} />
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )
          )}
          {mode?.kind === "price" && <>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Interval" htmlFor="pint">
                <Select id="pint" value={String(form.interval)} onChange={(e) => set("interval", e.target.value)}><option value="MONTH">Monthly</option><option value="YEAR">Annual</option></Select>
              </FormField>
              <FormField label="Currency" htmlFor="pcur"><Input id="pcur" maxLength={3} value={String(form.currency ?? "")} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></FormField>
              <FormField label="Amount" htmlFor="pamt" hint="In major units, e.g. 999.00"><Input id="pamt" inputMode="decimal" value={String(form.amount ?? "")} onChange={(e) => set("amount", e.target.value)} /></FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Stripe price id (optional)" htmlFor="pstripe"><Input id="pstripe" placeholder="price_…" value={String(form.stripePriceId ?? "")} onChange={(e) => set("stripePriceId", e.target.value)} /></FormField>
              <FormField label="Razorpay plan id (optional)" htmlFor="przp"><Input id="przp" placeholder="plan_…" value={String(form.razorpayPlanId ?? "")} onChange={(e) => set("razorpayPlanId", e.target.value)} /></FormField>
            </div>
          </>}
          {mode?.kind === "editPrice" && (
            <div className="grid gap-4 sm:grid-cols-2">
              {!mode.price.stripeLinked && <FormField label="Stripe price id" htmlFor="estripe"><Input id="estripe" placeholder="price_…" value={String(form.stripePriceId ?? "")} onChange={(e) => set("stripePriceId", e.target.value)} /></FormField>}
              {!mode.price.razorpayLinked && <FormField label="Razorpay plan id" htmlFor="erzp"><Input id="erzp" placeholder="plan_…" value={String(form.razorpayPlanId ?? "")} onChange={(e) => set("razorpayPlanId", e.target.value)} /></FormField>}
            </div>
          )}
          <ReasonField value={reason} onChange={setReason} />
        </div>
      </Dialog>

      <Dialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.price.active ? "Deactivate price?" : "Activate price?"}
        description={toggle?.price.active ? "New checkouts can no longer use this price. Existing subscriptions are unaffected." : "This price becomes available for new checkouts."}
        footer={<>
          <Button variant="outline" onClick={() => setToggle(null)}>Cancel</Button>
          <Button loading={busy} disabled={!reasonOk} onClick={togglePrice}>{toggle?.price.active ? "Deactivate" : "Activate"}</Button>
        </>}
      >
        {error && <Alert tone="danger" title={error} />}
        <ReasonField value={reason} onChange={setReason} />
      </Dialog>
    </>
  );
}
