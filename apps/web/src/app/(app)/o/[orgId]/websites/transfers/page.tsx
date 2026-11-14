"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, FormField, Input, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope, TransferDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CodeBlock } from "@/components/copy";
import { errorMessage, get, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmt, wk } from "@/lib/websites";

const STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "brand" }> = {
  PENDING_VERIFICATION: { label: "Waiting for your DNS record", tone: "warning" },
  PENDING_ADMIN: { label: "Under review", tone: "brand" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

interface Incoming { id: string; websiteId: string | null; displayHost: string; status: string; ownerResponse: string | null; ownerRespondBy: string | null; createdAt: string }

export default function TransfersPage() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const write = can("website:write");
  const mine = useQuery({ queryKey: wk.transfers(orgId), queryFn: () => get<DataEnvelope<TransferDto[]>>(`/orgs/${orgId}/domain-transfers`).then((r) => r.data), enabled: Boolean(orgId) });
  const incoming = useQuery({ queryKey: wk.incoming(orgId), queryFn: () => get<DataEnvelope<Incoming[]>>(`/orgs/${orgId}/domain-transfers/incoming`).then((r) => r.data), enabled: Boolean(orgId) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: wk.transfers(orgId) }), qc.invalidateQueries({ queryKey: wk.incoming(orgId) })]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const checkDns = (t: TransferDto) => run(`verify-${t.id}`, async () => {
    await post(`/orgs/${orgId}/domain-transfers/${t.id}/verify`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const list = await get<DataEnvelope<TransferDto[]>>(`/orgs/${orgId}/domain-transfers`);
      const cur = list.data.find((x) => x.id === t.id);
      if (cur && (cur.status !== t.status || JSON.stringify(cur.lastCheckDetail) !== JSON.stringify(t.lastCheckDetail))) {
        if (cur.status === t.status) throw new Error("The DNS record wasn't found yet. Check the name and value and try again in a few minutes.");
        return;
      }
    }
  }, "DNS record verified — the request is now under review");

  return (
    <>
      <div className="mb-2 text-sm"><Link href={`/o/${orgId}/websites`} className="text-muted-foreground hover:underline">← Websites</Link></div>
      <PageHeader title="Domain ownership transfers" description="Take over a domain another organization registered, after proving you control its DNS. A platform administrator reviews every request; no data is moved between organizations." />
      <div className="grid gap-6">
        {write && (
          <Card>
            <CardHeader><CardTitle>Request a transfer</CardTitle></CardHeader>
            <CardContent>
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run("request", async () => { await post(`/orgs/${orgId}/domain-transfers`, { url }); setUrl(""); }, "Transfer requested — publish the DNS record below"); }}>
                <FormField label="Domain" htmlFor="tr-url" className="min-w-64 flex-1"><Input id="tr-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.co.in" /></FormField>
                <Button type="submit" loading={busy === "request"} disabled={!url.trim()}>Request transfer</Button>
              </form>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader><CardTitle>Your requests</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            {mine.isLoading ? <Skeleton className="h-24" /> : mine.isError ? <Alert tone="danger" title={errorMessage(mine.error)} /> : !mine.data?.length ? (
              <p className="text-sm text-muted-foreground">No transfer requests.</p>
            ) : mine.data.map((t) => (
              <div key={t.id} className="grid gap-3 rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t.displayHost}</span>
                  <Badge tone={STATUS[t.status]?.tone ?? "neutral"}>{STATUS[t.status]?.label ?? t.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Requested {fmt(t.createdAt)}{t.verifiedAt ? ` · DNS verified ${fmt(t.verifiedAt)}` : ""}{t.decidedAt ? ` · decided ${fmt(t.decidedAt)}` : ""}</p>
                {t.record && (
                  <div className="grid gap-2">
                    <p className="text-sm">Add this TXT record to {t.displayHost}'s DNS (valid until {fmt(t.tokenExpiresAt)}):</p>
                    <CodeBlock value={t.record.name} label="Copy name" />
                    <CodeBlock value={t.record.value} label="Copy value" />
                  </div>
                )}
                {write && t.status === "PENDING_VERIFICATION" && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => checkDns(t)} loading={busy === `verify-${t.id}`}>Check DNS</Button>
                    <Button size="sm" variant="outline" onClick={() => setCancelId(t.id)}>Cancel request</Button>
                  </div>
                )}
                {write && t.status === "PENDING_ADMIN" && <div><Button size="sm" variant="outline" onClick={() => setCancelId(t.id)}>Cancel request</Button></div>}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Requests against your domains</CardTitle>
            <CardDescription>Another organization proved DNS control of one of your domains. You won't see who; contest it if you still own the domain.</CardDescription>
          </CardHeader>
          {incoming.isLoading ? <CardContent><Skeleton className="h-16" /></CardContent> : !incoming.data?.length ? (
            <CardContent><p className="text-sm text-muted-foreground">None.</p></CardContent>
          ) : (
            <Table>
              <THead><TR><TH>Domain</TH><TH>Status</TH><TH className="hidden sm:table-cell">Respond by</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
              <TBody>
                {incoming.data.map((t) => (
                  <TR key={t.id}>
                    <TD>{t.websiteId ? <Link className="hover:underline" href={`/o/${orgId}/websites/${t.websiteId}`}>{t.displayHost}</Link> : t.displayHost}</TD>
                    <TD><Badge tone={STATUS[t.status]?.tone ?? "neutral"}>{STATUS[t.status]?.label ?? t.status}</Badge></TD>
                    <TD className="hidden sm:table-cell">{fmt(t.ownerRespondBy)}</TD>
                    <TD className="text-right">
                      {t.ownerResponse === "CONTESTED" ? <span className="text-xs text-muted-foreground">Contested</span>
                        : write && ["PENDING_VERIFICATION", "PENDING_ADMIN"].includes(t.status) && (
                          <Button size="sm" variant="outline" loading={busy === `contest-${t.id}`} onClick={() => run(`contest-${t.id}`, () => post(`/orgs/${orgId}/domain-transfers/incoming/${t.id}/contest`), "Transfer contested")}>Contest</Button>
                        )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
      <ConfirmDialog
        open={cancelId !== null}
        onOpenChange={(o) => !o && setCancelId(null)}
        title="Cancel this transfer request?"
        description="You can request again later; a new DNS token will be issued."
        confirmLabel="Cancel request"
        destructive
        loading={busy === "cancel"}
        onConfirm={() => run("cancel", async () => { await post(`/orgs/${orgId}/domain-transfers/${cancelId}/cancel`); setCancelId(null); }, "Transfer request cancelled")}
      />
    </>
  );
}
