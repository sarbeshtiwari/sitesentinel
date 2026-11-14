"use client";
import { Alert, Button, Card, CardFooter, EmptyState, ErrorState, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { AuditEntryDto, ListEnvelope } from "@wim/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Lock, ScrollText } from "lucide-react";
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
      {org && !allowed ? <EmptyState icon={<Lock />} title="You don't have access to the audit log." description="Ask an owner or admin if you need to review changes in this organization." /> : (
        <Card className="overflow-hidden">
          {q.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : q.isError ? <div className="p-5"><ErrorState title="Couldn't load the audit log" description={errorMessage(q.error)} onRetry={() => void q.refetch()} /></div> : rows.length === 0 ? <div className="p-5"><EmptyState icon={<ScrollText />} title="No events yet" description="Changes made in this organization will be recorded here." /></div> : (
            <>
              {/* Cards on small screens */}
              <ul className="divide-y divide-border md:hidden">
                {rows.map((r) => (
                  <li key={r.id} className="grid gap-1 px-4 py-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-medium">{describeAction(r.action)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(r.occurredAt).toLocaleString()}</span>
                    </div>
                    <span className="truncate text-xs text-muted-foreground">{r.actorLabel ?? r.actorType}{r.ipPrefix ? <> · <span className="font-mono">{r.ipPrefix}</span></> : ""}</span>
                    {summarize(r.changes) && <span className="break-all text-xs text-muted-foreground">{summarize(r.changes)}</span>}
                  </li>
                ))}
              </ul>
              {/* Table from md up */}
              <div className="hidden md:block">
                <Table>
                  <THead><TR><TH>When</TH><TH>Actor</TH><TH>Event</TH><TH>Details</TH><TH>Network</TH></TR></THead>
                  <TBody>
                    {rows.map((r) => (
                      <TR key={r.id}>
                        <TD className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{new Date(r.occurredAt).toLocaleString()}</TD>
                        <TD className="max-w-[12rem] truncate">{r.actorLabel ?? r.actorType}</TD>
                        <TD className="whitespace-nowrap font-medium">{describeAction(r.action)}</TD>
                        <TD className="max-w-xs truncate text-xs text-muted-foreground" title={summarize(r.changes)}>{summarize(r.changes)}</TD>
                        <TD className="font-mono text-xs text-muted-foreground">{r.ipPrefix ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </>
          )}
          {q.hasNextPage && <CardFooter className="justify-center"><Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></CardFooter>}
        </Card>
      )}
    </>
  );
}
