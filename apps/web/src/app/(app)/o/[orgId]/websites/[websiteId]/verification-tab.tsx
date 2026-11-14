"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Select, Skeleton, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope, VerificationAttemptDto, WebsiteDetailDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { History, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { Section } from "@/components/monitoring";
import { CodeBlock } from "@/components/copy";
import { errorMessage, get, post } from "@/lib/api";
import { failureText, fmt, METHOD_LABEL, relative, wk } from "@/lib/websites";

type Method = "DNS_TXT" | "WELL_KNOWN_FILE" | "HTML_META" | "ANY";

function MethodNumber({ n }: { n: number }) {
  return <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">{n}</span>;
}

export function VerificationTab({ w, orgId, canWrite }: { w: WebsiteDetailDto; orgId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>("DNS_TXT");
  const [checking, setChecking] = useState(false);
  const [confirmToken, setConfirmToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const history = useQuery({
    queryKey: wk.verifications(orgId, w.id),
    queryFn: () => get<DataEnvelope<VerificationAttemptDto[]>>(`/orgs/${orgId}/websites/${w.id}/verifications`).then((r) => r.data),
  });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) }),
    qc.invalidateQueries({ queryKey: wk.verifications(orgId, w.id) }),
    qc.invalidateQueries({ queryKey: wk.list(orgId) }),
  ]);

  const verify = async () => {
    setChecking(true);
    try {
      const before = history.data?.[0]?.id;
      const revalidating = Boolean(w.claim.revalidation && w.claim.revalidation.state !== "OK");
      await post(`/orgs/${orgId}/websites/${w.id}/verify`, { method });
      // The check runs in the background; poll until a new history row or a status change appears (≤ 60 s).
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const [d, h] = await Promise.all([
          get<DataEnvelope<WebsiteDetailDto>>(`/orgs/${orgId}/websites/${w.id}`),
          get<DataEnvelope<VerificationAttemptDto[]>>(`/orgs/${orgId}/websites/${w.id}/verifications`),
        ]);
        if (revalidating) {
          if (h.data[0] && h.data[0].id !== before) {
            if (h.data[0].status === "SUCCEEDED") toast.success("Ownership confirmed — monitoring is active");
            else toast.error(failureText(h.data[0].failureReason) || "Ownership check failed");
            break;
          }
          continue;
        }
        if (d.data.verification === "VERIFIED") { toast.success("Ownership verified"); break; }
        if (h.data[0] && h.data[0].id !== before) { toast.error(failureText(h.data[0].failureReason) || "Verification failed"); break; }
      }
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const action = async (path: string, ok: string) => {
    setBusy(true);
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/${path}`);
      await refresh();
      toast.success(ok);
      setConfirmToken(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ins = w.instructions;
  return (
    <div className="grid gap-5">
      {w.claim.revalidation?.state === "FAILING" && (
        <Alert tone="warning" title="We couldn't confirm you still own this domain">
          Our periodic check couldn't find your {METHOD_LABEL[w.claim.verifiedMethod ?? ""]?.toLowerCase() ?? "verification"} (last check {relative(w.claim.revalidation.lastCheckedAt)}).
          Monitoring continues until {fmt(w.claim.revalidation.lapsesAt)}; restore it below and run a check. Temporary DNS or hosting outages don't count against you.
        </Alert>
      )}
      {w.claim.status === "LAPSED" && (
        <Alert tone="danger" title="Ownership verification lapsed — monitoring is paused">
          Restore the verification record below and run a check to resume monitoring. If ownership can't be confirmed by {fmt(w.claim.revalidation?.releaseAt)}, the domain is released from your organization.
        </Alert>
      )}
      {w.claim.status === "VERIFIED" && w.claim.revalidation?.state !== "FAILING" && (
        <Alert tone="success" title={`Verified ${relative(w.claim.verifiedAt)}`}>
          {w.claim.inherited ? `Verified through your organization's DNS verification of ${w.registrableDomain}.` : `Method: ${METHOD_LABEL[w.claim.verifiedMethod ?? ""] ?? w.claim.verifiedMethod}.`}
          {w.claim.scope === "ROOT" && ` Subdomains of ${w.registrableDomain} are reserved for your organization.`}
          {w.claim.revalidation?.nextCheckAt && ` Ownership is re-checked automatically; next check ${relative(w.claim.revalidation.nextCheckAt)}.`}
        </Alert>
      )}
      {w.claim.status === "EXPIRED" && (
        <Alert tone="danger" title="The verification window expired">
          <p>Unverified claims are released after 72 hours. If nobody else has registered the domain since, you can start again with a new token.</p>
          {canWrite && <Button className="mt-2" size="sm" loading={busy} onClick={() => action("verification/restart", "Verification restarted")}>Restart verification</Button>}
        </Alert>
      )}
      {ins && (
        <>
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />Prove that you control {w.displayHost}</CardTitle>
              <CardDescription>
                {w.claim.status === "PENDING"
                  ? <>Publish the token using one method below, then run the check. The window closes {relative(w.claim.pendingExpiresAt)} ({fmt(w.claim.pendingExpiresAt)}). Checks used with this token: {w.claim.attemptsUsed} of {w.claim.attemptsAllowed}.</>
                  : <>Make sure this record is still published (it was used to verify the website originally), then run a check.</>}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-0 divide-y divide-border p-0">
              <section className="grid gap-2 px-5 py-4" aria-labelledby="m-dns">
                <h3 id="m-dns" className="flex items-center gap-2 text-sm font-semibold"><MethodNumber n={1} />DNS TXT record <Badge tone="success">Recommended</Badge></h3>
                <p className="text-xs text-muted-foreground">Add a TXT record at your DNS provider. Some providers want only the part before your domain as the name.</p>
                <dl className="grid gap-2">
                  <div><dt className="mb-1 text-xs text-muted-foreground">Name</dt><dd><CodeBlock testId="dns-record-name" value={ins.dns.hostRecord.name} /></dd></div>
                  <div><dt className="mb-1 text-xs text-muted-foreground">Value</dt><dd><CodeBlock testId="dns-record-value" value={ins.dns.hostRecord.value} /></dd></div>
                </dl>
                {w.hostKey !== w.registrableDomain && <p className="text-xs text-muted-foreground">Publishing it at <code>{ins.dns.rootRecord.name}</code> instead also works.</p>}
                {w.hostKey === w.registrableDomain && <p className="text-xs text-muted-foreground">DNS verification of the registrable domain also reserves its subdomains for your organization.</p>}
              </section>
              <section className="grid gap-2 px-5 py-4" aria-labelledby="m-file">
                <h3 id="m-file" className="flex items-center gap-2 text-sm font-semibold"><MethodNumber n={2} />HTML verification file</h3>
                <p className="text-xs text-muted-foreground">Serve a plain-text file at this exact URL (HTTP 200) containing the value on its own line.</p>
                <CodeBlock value={ins.file.url} label="Copy URL" />
                <CodeBlock value={ins.file.content} label="Copy content" />
              </section>
              <section className="grid gap-2 px-5 py-4" aria-labelledby="m-meta">
                <h3 id="m-meta" className="flex items-center gap-2 text-sm font-semibold"><MethodNumber n={3} />HTML meta tag</h3>
                <p className="text-xs text-muted-foreground">Add this tag inside the <code>&lt;head&gt;</code> of your home page.</p>
                <CodeBlock value={ins.meta.tag} />
              </section>
            </CardContent>
            {canWrite && (
              <div className="flex flex-col gap-3 border-t border-border bg-sunken/50 px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="grid gap-1.5 sm:min-w-64">
                  <label htmlFor="method" className="text-sm font-medium">Method to check</label>
                  <Select id="method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                    {(["DNS_TXT", "WELL_KNOWN_FILE", "HTML_META", "ANY"] as const).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                  </Select>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {w.claim.status === "PENDING" && <Button variant="outline" onClick={() => setConfirmToken(true)}><RefreshCw /> Generate new token</Button>}
                  <Button onClick={verify} loading={checking}>{!checking && <ShieldCheck />}{checking ? "Checking…" : "Verify now"}</Button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
      <Section title="Verification history" icon={<History />} flush>
        {history.isLoading ? <div className="p-4"><Skeleton className="h-24" /></div> : !history.data?.length ? (
          <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No checks yet.</p>
        ) : (
          <Table>
            <THead><TR><TH>When</TH><TH>Method</TH><TH>Result</TH><TH className="hidden sm:table-cell">Details</TH></TR></THead>
            <TBody>
              {history.data.map((h) => (
                <TR key={h.id}>
                  <TD className="whitespace-nowrap text-muted-foreground">{fmt(h.requestedAt)}</TD>
                  <TD>{METHOD_LABEL[h.method] ?? h.method}</TD>
                  <TD><Badge tone={h.status === "SUCCEEDED" ? "success" : "danger"}>{h.status === "SUCCEEDED" ? "Verified" : "Failed"}</Badge></TD>
                  <TD className="hidden text-xs text-muted-foreground sm:table-cell">{h.status === "SUCCEEDED" ? (h.scopeGranted === "ROOT" ? "Domain and subdomains" : "This website") : failureText(h.failureReason)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <ConfirmDialog
        open={confirmToken}
        onOpenChange={setConfirmToken}
        title="Generate a new verification token?"
        description="The current token stops working immediately; update any record or file you already published. The verification window is not extended."
        confirmLabel="Generate new token"
        loading={busy}
        onConfirm={() => action("verification/token", "New token generated")}
      />
    </div>
  );
}
