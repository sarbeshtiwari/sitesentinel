"use client";
import { Alert, Badge, Button, Card, CardContent, CardFooter, EmptyState, Input, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import type { AdminCustomerRowDto, ListEnvelope } from "@wim/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, get } from "@/lib/api";
import { qk } from "@/lib/hooks";

const tone = (s: string) => (s === "ACTIVE" ? "success" : s === "SUSPENDED" ? "danger" : "warning") as "success" | "danger" | "warning";

export default function CustomersPage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(input.trim()), 300); return () => clearTimeout(t); }, [input]);
  const q = useInfiniteQuery({
    queryKey: qk.customers(query),
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "25" });
      if (pageParam) p.set("cursor", pageParam);
      if (query) p.set("q", query);
      return get<ListEnvelope<AdminCustomerRowDto>>(`/customers?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader title="Customers" description="Organization metadata only. Owner emails are masked." />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search organizations" placeholder="Search by name or slug" className="pl-8" value={input} onChange={(e) => setInput(e.target.value)} />
          </div>
          {rows.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{rows.length}{q.hasNextPage ? "+" : ""} organization{rows.length === 1 && !q.hasNextPage ? "" : "s"}{query ? " matching" : ""}</span>}
        </div>
        <CardContent className="p-0">
          {q.isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : q.isError ? <div className="p-5"><Alert tone="danger" title={errorMessage(q.error)} /></div> : rows.length === 0 ? <div className="p-5"><EmptyState icon={<Building2 />} title={query ? "No organizations match" : "No organizations yet"} /></div> : (
            <Table>
              <THead><TR><TH>Organization</TH><TH>Status</TH><TH>Plan</TH><TH>Trial</TH><TH className="text-right">Members</TH><TH className="text-right">Websites</TH><TH>Owner</TH><TH>Created</TH></TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD><div className="font-medium">{r.name}</div><div className="font-mono text-[11px] text-muted-foreground">{r.slug}</div></TD>
                    <TD><Badge tone={tone(r.status)}>{r.status.toLowerCase().replace(/_/g, " ")}</Badge></TD>
                    <TD>{r.planKey ? <span className="font-mono text-xs">{r.planKey}</span> : <span className="text-muted-foreground">—</span>}{r.subscriptionStatus && <div className="text-xs text-muted-foreground">{r.subscriptionStatus}</div>}</TD>
                    <TD>{r.trialStatus ? <>{r.trialStatus}{r.trialEndsAt && <div className="text-xs tabular-nums text-muted-foreground">ends {new Date(r.trialEndsAt).toLocaleDateString()}</div>}</> : <span className="text-muted-foreground">—</span>}</TD>
                    <TD className="text-right tabular-nums">{r.memberCount}</TD>
                    <TD className="text-right tabular-nums">{r.websiteCount}</TD>
                    <TD className="font-mono text-xs">{r.ownerEmailMasked ?? "—"}</TD>
                    <TD className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
        {q.hasNextPage && <CardFooter className="justify-center"><Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></CardFooter>}
      </Card>
    </>
  );
}
