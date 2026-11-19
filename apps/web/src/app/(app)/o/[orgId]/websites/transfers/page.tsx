"use client";
import { Alert, Button, Card, ConfirmDialog, Dialog, EmptyState, FilterChip, FormField, Input, PageHeader, Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import type { DataEnvelope, TransferDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, ChevronLeft } from "lucide-react";
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
  const [view, setView] = useState<"incoming" | "outgoing" | "completed">(params.get("url") ? "outgoing" : "incoming");
  const [requestOpen, setRequestOpen] = useState(Boolean(params.get("url")));
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

  const DONE = ["APPROVED", "REJECTED", "CANCELLED"];
  const inOpen = (incoming.data ?? []).filter((t) => !DONE.includes(t.status));
  const outOpen = (mine.data ?? []).filter((t) => !DONE.includes(t.status));
  const completed = [
    ...(mine.data ?? []).filter((t) => DONE.includes(t.status)).map((t) => ({ id: t.id, host: t.displayHost, websiteId: null as string | null, dir: "Outgoing request" as const, status: t.status, at: t.decidedAt ?? t.createdAt })),
    ...(incoming.data ?? []).filter((t) => DONE.includes(t.status)).map((t) => ({ id: t.id, host: t.displayHost, websiteId: t.websiteId, dir: "Against your domain" as const, status: t.status, at: t.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const loading = mine.isLoading || incoming.isLoading;

  return (
    <>
      <div className="mb-3"><Link href={`/o/${orgId}/websites`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Websites</Link></div>
      <PageHeader title="Domain ownership transfers" description="Take over a domain another organization registered, after proving you control its DNS. A platform administrator reviews every request; no data is moved between organizations."
        actions={write ? <Button size="sm" onClick={() => setRequestOpen(true)}><ArrowLeftRight /> Request a transfer</Button> : undefined} />
      <div role="group" aria-label="Show transfers" className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip selected={view === "incoming"} count={incoming.data ? inOpen.length : undefined} onClick={() => setView("incoming")}>Against your domains</FilterChip>
        <FilterChip selected={view === "outgoing"} count={mine.data ? outOpen.length : undefined} onClick={() => setView("outgoing")}>Your requests</FilterChip>
        <FilterChip selected={view === "completed"} count={loading ? undefined : completed.length} onClick={() => setView("completed")}>Completed</FilterChip>
      </div>

      {view === "incoming" && (
        <section aria-labelledby="t-in" className="grid gap-3">
          <h2 id="t-in" className="sr-only">Requests against your domains</h2>
          <p className="text-sm text-muted-foreground">Another organization proved DNS control of one of your domains. You won&apos;t see who; contest it if you still own the domain.</p>
          {incoming.isLoading ? <Skeleton className="h-24" /> : incoming.isError ? <Alert tone="danger" title={errorMessage(incoming.error)} /> : !inOpen.length ? (
            <Card className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />None.</Card>
          ) : inOpen.map((t) => (
            <Card key={t.id} className="grid gap-3 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all font-semibold">{t.websiteId ? <Link className="hover:text-primary" href={`/o/${orgId}/websites/${t.websiteId}`}>{t.displayHost}</Link> : t.displayHost}</p>
                  <p className="text-xs text-muted-foreground">Requested {fmt(t.createdAt)}{t.ownerRespondBy ? ` · respond by ${fmt(t.ownerRespondBy)}` : ""}</p>
                </div>
                <StatusPill tone={STATUS[t.status]?.tone ?? "neutral"}>{STATUS[t.status]?.label ?? t.status}</StatusPill>
              </div>
              {t.ownerResponse === "CONTESTED" ? <p className="text-sm text-muted-foreground">Contested — a platform administrator will review it.</p>
                : write && ["PENDING_VERIFICATION", "PENDING_ADMIN"].includes(t.status) && (
                  <div><Button size="sm" variant="outline" loading={busy === `contest-${t.id}`} onClick={() => run(`contest-${t.id}`, () => post(`/orgs/${orgId}/domain-transfers/incoming/${t.id}/contest`), "Transfer contested")}>Contest</Button></div>
                )}
            </Card>
          ))}
        </section>
      )}

      {view === "outgoing" && (
        <section aria-labelledby="t-out" className="grid gap-3">
          <h2 id="t-out" className="sr-only">Your requests</h2>
          {mine.isLoading ? <Skeleton className="h-24" /> : mine.isError ? <Alert tone="danger" title={errorMessage(mine.error)} /> : !outOpen.length ? (
            <EmptyState icon={<ArrowLeftRight />} title="No transfer requests." description="Requests you make to take over a domain appear here." className="py-8"
              action={write ? <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}>Request a transfer</Button> : undefined} />
          ) : outOpen.map((t) => (
            <Card key={t.id} className="grid gap-3 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all font-semibold">{t.displayHost}</p>
                  <p className="text-xs text-muted-foreground">Requested {fmt(t.createdAt)}{t.verifiedAt ? ` · DNS verified ${fmt(t.verifiedAt)}` : ""}{t.decidedAt ? ` · decided ${fmt(t.decidedAt)}` : ""}</p>
                </div>
                <StatusPill tone={STATUS[t.status]?.tone ?? "neutral"}>{STATUS[t.status]?.label ?? t.status}</StatusPill>
              </div>
              {t.record && (
                <div className="grid gap-2 rounded-md bg-sunken p-3">
                  <p className="text-sm">Add this TXT record to {t.displayHost}&apos;s DNS (valid until {fmt(t.tokenExpiresAt)}):</p>
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
            </Card>
          ))}
        </section>
      )}

      {view === "completed" && (
        <section aria-labelledby="t-done">
          <h2 id="t-done" className="mb-2.5 text-[15px] font-semibold tracking-tight">Completed</h2>
          {loading ? <Skeleton className="h-24" /> : !completed.length ? (
            <EmptyState icon={<ArrowLeftRight />} title="Nothing completed yet" description="Approved, rejected and cancelled requests appear here." className="py-8" />
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <THead><TR><TH>Domain</TH><TH>Direction</TH><TH>Outcome</TH><TH className="hidden sm:table-cell">Date</TH></TR></THead>
                <TBody>
                  {completed.map((t) => (
                    <TR key={`${t.dir}-${t.id}`}>
                      <TD className="max-w-56 break-all font-medium">{t.websiteId ? <Link className="hover:text-primary" href={`/o/${orgId}/websites/${t.websiteId}`}>{t.host}</Link> : t.host}</TD>
                      <TD className="text-muted-foreground">{t.dir}</TD>
                      <TD><StatusPill tone={STATUS[t.status]?.tone ?? "neutral"}>{STATUS[t.status]?.label ?? t.status}</StatusPill></TD>
                      <TD className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{fmt(t.at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </section>
      )}

      <Dialog open={requestOpen} onOpenChange={setRequestOpen} title="Request a transfer" description="You'll get a DNS TXT record to publish on the domain to prove you control it.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void run("request", async () => { await post(`/orgs/${orgId}/domain-transfers`, { url }); setUrl(""); setRequestOpen(false); setView("outgoing"); }, "Transfer requested — publish the DNS record below"); }}>
          <FormField label="Domain" htmlFor="tr-url"><Input id="tr-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.co.in" /></FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRequestOpen(false)}>Close</Button>
            <Button type="submit" loading={busy === "request"} disabled={!url.trim()}>Request transfer</Button>
          </div>
        </form>
      </Dialog>
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
