"use client";
import { Alert, Button, Card, CardContent, CardFooter, EmptyState, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { AuditEntryDto, ListEnvelope } from "@wim/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { errorMessage, get } from "@/lib/api";
import { describeAction } from "@/lib/audit";
import { qk, useOrg } from "@/lib/hooks";

function summarize(changes: unknown): string {
  if (!changes || typeof changes !== "object") return "";
  return Object.entries(changes as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ")
    .slice(0, 160);
}

export default function AuditPage() {
  const { orgId, can, data: org } = useOrg();
  const allowed = can("audit:read");
  const q = useInfiniteQuery({
    queryKey: qk.audit(orgId),
    initialPageParam: "",
    queryFn: ({ pageParam }) => get<ListEnvelope<AuditEntryDto>>(`/orgs/${orgId}/audit-logs?limit=25${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader title="Audit log" description="Tamper-evident record of changes made in this organization." />
      {org && !allowed ? <Alert title="You don't have access to the audit log." /> : (
        <Card>
          <CardContent className="p-0">
            {q.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : q.isError ? <div className="p-5"><Alert tone="danger" title={errorMessage(q.error)} /></div> : rows.length === 0 ? <div className="p-5"><EmptyState icon={<ScrollText />} title="No events yet" /></div> : (
              <Table>
                <THead><TR><TH>When</TH><TH>Actor</TH><TH>Event</TH><TH>Details</TH><TH>Network</TH></TR></THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id}>
                      <TD className="whitespace-nowrap text-muted-foreground">{new Date(r.occurredAt).toLocaleString()}</TD>
                      <TD className="max-w-[12rem] truncate">{r.actorLabel ?? r.actorType}</TD>
                      <TD className="whitespace-nowrap font-medium">{describeAction(r.action)}</TD>
                      <TD className="max-w-xs truncate text-xs text-muted-foreground" title={summarize(r.changes)}>{summarize(r.changes)}</TD>
                      <TD className="font-mono text-xs">{r.ipPrefix ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
          {q.hasNextPage && <CardFooter><Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></CardFooter>}
        </Card>
      )}
    </>
  );
}
