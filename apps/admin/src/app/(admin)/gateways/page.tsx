"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, FormField, Input, PageHeader, Select, Skeleton, Textarea, toast } from "@wim/ui";
import type { AdminGatewayConfigDto, DataEnvelope } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage, get, put } from "@/lib/api";
import { useAdminMe } from "@/lib/hooks";

const gatewaysKey = ["billing", "gateways"] as const;
const NAMES: Record<AdminGatewayConfigDto["gateway"], string> = { STRIPE: "Stripe", RAZORPAY: "Razorpay" };

function GatewayCard({ g, canWrite }: { g: AdminGatewayConfigDto; canWrite: boolean }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(g.enabled);
  const [mode, setMode] = useState<"test" | "live">(g.mode);
  const [publicKey, setPublicKey] = useState(g.publicKey ?? "");
  const [currencies, setCurrencies] = useState(g.currencies.join(", "));
  // Write-only: never pre-filled, never read back. Cleared after every save.
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(g.enabled); setMode(g.mode); setPublicKey(g.publicKey ?? ""); setCurrencies(g.currencies.join(", "));
  }, [g]);

  const id = g.gateway.toLowerCase();
  const curList = currencies.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const needsSecrets = !g.secretsConfigured && (!secretKey || !webhookSecret);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (curList.some((c) => !/^[A-Z]{3}$/.test(c))) throw new Error("Currencies must be 3-letter codes, e.g. INR, USD");
      await put<DataEnvelope<AdminGatewayConfigDto>>(`/billing/gateways/${id}`, {
        enabled, mode, publicKey: publicKey.trim() || null, currencies: curList,
        ...(secretKey ? { secretKey } : {}), ...(webhookSecret ? { webhookSecret } : {}),
        reason: reason.trim(),
      });
      setSecretKey(""); setWebhookSecret(""); setReason("");
      toast.success(`${NAMES[g.gateway]} configuration saved`);
      await qc.invalidateQueries({ queryKey: gatewaysKey });
    } catch (e) {
      setError(e instanceof Error && !("status" in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {NAMES[g.gateway]}
          {g.enabled ? <Badge tone="success">enabled</Badge> : <Badge>disabled</Badge>}
          <Badge tone={g.mode === "live" ? "danger" : "info"}>{g.mode} mode</Badge>
        </CardTitle>
        <CardDescription>
          Secrets: {g.secretsConfigured ? <>configured{g.secretHint ? <> (hint <span className="font-mono">{g.secretHint}</span>)</> : null}</> : "not configured"}
          {g.updatedAt && <> · updated {new Date(g.updatedAt).toLocaleString()}</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Alert tone="danger" title={error} />}
        <div className="grid gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Webhook endpoint (register at {NAMES[g.gateway]}, prefixed with the public API origin)</span>
          <code className="break-all rounded-md bg-sunken px-2 py-1 font-mono text-xs">{g.webhookPath}</code>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><Checkbox disabled={!canWrite} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enabled</label>
          <FormField label="Mode" htmlFor={`${id}-mode`} className="w-36">
            <Select id={`${id}-mode`} disabled={!canWrite} value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}><option value="test">test</option><option value="live">live</option></Select>
          </FormField>
        </div>
        {mode === "live" && g.mode !== "live" && <Alert tone="warning" title="Switching to live mode">Real customers will be charged once billing is enabled. Make sure the live keys and live webhook secret are entered.</Alert>}
        <FormField label={g.gateway === "STRIPE" ? "Publishable key" : "Key id"} htmlFor={`${id}-pk`} hint="Not secret; shown to the browser where needed.">
          <Input id={`${id}-pk`} disabled={!canWrite} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} autoComplete="off" />
        </FormField>
        <FormField label="Currencies routed to this gateway" htmlFor={`${id}-cur`} hint="Comma-separated ISO codes, e.g. INR or USD, EUR.">
          <Input id={`${id}-cur`} disabled={!canWrite} value={currencies} onChange={(e) => setCurrencies(e.target.value)} />
        </FormField>
        {canWrite && <>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={g.gateway === "STRIPE" ? "Secret key" : "Key secret"} htmlFor={`${id}-sk`} hint={g.secretsConfigured ? "Leave blank to keep the stored value." : "Required."}>
              <Input id={`${id}-sk`} type="password" autoComplete="new-password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={g.secretsConfigured ? "•••••• (stored)" : ""} />
            </FormField>
            <FormField label="Webhook signing secret" htmlFor={`${id}-wh`} hint={g.secretsConfigured ? "Leave blank to keep the stored value." : "Required."}>
              <Input id={`${id}-wh`} type="password" autoComplete="new-password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={g.secretsConfigured ? "•••••• (stored)" : ""} />
            </FormField>
          </div>
          <p className="text-xs text-muted-foreground">Secrets are encrypted at rest and are write-only: they are never displayed or returned by the API.</p>
          <FormField label="Reason (recorded in the audit log)" htmlFor={`${id}-reason`} hint="Required, at least 5 characters.">
            <Textarea id={`${id}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        </>}
      </CardContent>
      {canWrite && (
        <CardFooter className="flex flex-wrap items-center gap-3">
          <Button loading={busy} disabled={reason.trim().length < 5 || (enabled && needsSecrets)} onClick={save}>Save {NAMES[g.gateway]}</Button>
          {enabled && needsSecrets && <span className="text-xs text-muted-foreground">Enter both secrets to enable this gateway.</span>}
        </CardFooter>
      )}
    </Card>
  );
}

export default function GatewaysPage() {
  const me = useAdminMe();
  const canRead = me.can("admin:billing:read");
  const canWrite = me.can("admin:gateways:write");
  const q = useQuery({ queryKey: gatewaysKey, queryFn: () => get<DataEnvelope<AdminGatewayConfigDto[]>>("/billing/gateways").then((r) => r.data), enabled: canRead });
  if (me.isLoading) return <Skeleton className="h-40" />;
  if (!canRead) return <><PageHeader title="Payment gateways" /><Alert tone="warning" title="You don't have access to payment gateways" /></>;
  return (
    <>
      <PageHeader title="Payment gateways" description="Stripe and Razorpay configuration. Checkout and gateway calls also require the platform setting billing.enabled." />
      {!canWrite && <Alert className="mb-5" title="Read-only">Only a Super Admin can change gateway configuration.</Alert>}
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <Alert tone="danger" title={errorMessage(q.error)} /> : (
        <div className="grid gap-5 xl:grid-cols-2">
          {(q.data ?? []).map((g) => <GatewayCard key={g.gateway} g={g} canWrite={canWrite} />)}
        </div>
      )}
    </>
  );
}
