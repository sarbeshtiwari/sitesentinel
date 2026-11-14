"use client";
import { Alert, Button, Card, CardContent, CardFooter, EmptyState, FormField, Input, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR, toast } from "@wim/ui";
import type { AuditEntryDto, DataEnvelope, ListEnvelope } from "@wim/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckCircle2, ScrollText, XCircle } from "lucide-react";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { qk } from "@/lib/hooks";

interface ChainResult { stream: string; valid: boolean; checked: number; firstBrokenSeq: string | null; reason: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AuditPage() {
  const [kind, setKind] = useState<"platform" | "org" | "user">("platform");
  const [id, setId] = useState("");
  const [stream, setStream] = useState("platform");
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const idValid = kind === "platform" || UUID.test(id.trim());

  const q = useInfiniteQuery({
    queryKey: qk.audit(stream),
    initialPageParam: "",
    queryFn: ({ pageParam }) => get<ListEnvelope<AuditEntryDto>>(`/audit-logs?stream=${encodeURIComponent(stream)}&limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!idValid) return;
    setChain(null);
    setStream(kind === "platform" ? "platform" : `${kind}:${id.trim().toLowerCase()}`);
  };
  const verify = async () => {
    setVerifying(true);
    try {
      setChain((await post<DataEnvelope<ChainResult>>("/audit-logs/verify-chain", { stream })).data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <PageHeader title="Audit log" description="Append-only, hash-chained records. Each stream is an independent chain." actions={<Button variant="outline" loading={verifying} onClick={verify}>Verify chain</Button>} />
      <form onSubmit={apply} className="mb-4 grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
        <FormField label="Stream" htmlFor="kind">
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="platform">Platform</option>
            <option value="org">Organization</option>
            <option value="user">User</option>
          </Select>
        </FormField>
        <FormField label={kind === "org" ? "Organization ID" : kind === "user" ? "User ID" : "ID"} htmlFor="stream-id" error={!idValid && id ? "Enter a UUID" : undefined}>
          <Input id="stream-id" disabled={kind === "platform"} placeholder="00000000-0000-0000-0000-000000000000" value={kind === "platform" ? "" : id} onChange={(e) => setId(e.target.value)} className="font-mono" />
        </FormField>
        <Button type="submit" disabled={!idValid}>Show</Button>
      </form>
      {chain && (
        <Alert tone={chain.valid ? "success" : "danger"} className="mb-4" title={<span className="flex items-center gap-2">{chain.valid ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{chain.valid ? `Chain intact — ${chain.checked} entries verified` : `Chain broken at seq ${chain.firstBrokenSeq}`}</span>}>
          Stream <code>{chain.stream}</code>{chain.reason ? `: ${chain.reason}` : ""}
        </Alert>
      )}
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : q.isError ? <div className="p-5"><Alert tone="danger" title={errorMessage(q.error)} /></div> : rows.length === 0 ? <div className="p-5"><EmptyState icon={<ScrollText />} title="No entries in this stream" /></div> : (
            <Table>
              <THead><TR><TH>Seq</TH><TH>When</TH><TH>Actor</TH><TH>Action</TH><TH>Target</TH><TH>Reason</TH><TH>Network</TH></TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono text-xs">{r.seq}</TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{new Date(r.occurredAt).toLocaleString()}</TD>
                    <TD className="max-w-[12rem] truncate">{r.actorLabel ?? r.actorType}</TD>
                    <TD className="font-mono text-xs">{r.action}</TD>
                    <TD className="max-w-[14rem] truncate font-mono text-xs">{r.targetType ? `${r.targetType}:${r.targetId ?? ""}` : "—"}</TD>
                    <TD className="max-w-xs truncate text-xs" title={r.reason ?? ""}>{r.reason ?? "—"}</TD>
                    <TD className="font-mono text-xs">{r.ipPrefix ?? "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
        {q.hasNextPage && <CardFooter><Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></CardFooter>}
      </Card>
    </>
  );
}
