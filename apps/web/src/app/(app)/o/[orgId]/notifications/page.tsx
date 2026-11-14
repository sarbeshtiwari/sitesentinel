"use client";
import { Badge, Button, buttonVariants, Card, cn, EmptyState, PageHeader, toast } from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck, ListFilter, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LoadMore, QueryState } from "@/components/monitoring";
import { errorMessage, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { fmtUtc, SEVERITY_TONE, useNotifications } from "@/lib/monitoring";

const TYPE: Record<string, string> = { INCIDENT_CREATED: "Incident opened", INCIDENT_RESOLVED: "Recovered", SSL_EXPIRING: "Certificate", MONITORING_INTERRUPTED: "Monitoring interrupted" };

export default function NotificationsPage() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications(orgId, unreadOnly);
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const unread = q.data?.pages[0]?.unread ?? 0;
  const refresh = () => qc.invalidateQueries({ queryKey: ["org", orgId, "notifications"] });
  const markAll = async () => { try { const r = await post<{ data: { marked: number } }>(`/orgs/${orgId}/notifications/read-all`); toast.success(`${r.data.marked} marked as read`); await refresh(); } catch (e) { toast.error(errorMessage(e)); } };
  const open = async (id: string, read: boolean) => { if (!read) { try { await post(`/orgs/${orgId}/notifications/${id}/read`); await refresh(); } catch { /* navigation still works */ } } };

  return (
    <>
      <PageHeader title="Notifications" description={`Your in-app notifications for this organisation. ${unread} unread.`}
        actions={<>
          <Link href={`/o/${orgId}/notifications/preferences`} className={buttonVariants({ variant: "outline", size: "sm" })}><Settings2 />Preferences</Link>
          <Button variant="outline" size="sm" onClick={() => setUnreadOnly(!unreadOnly)} aria-pressed={unreadOnly}><ListFilter />{unreadOnly ? "Show all" : "Unread only"}</Button>
          {unread > 0 && <Button size="sm" onClick={markAll}><CheckCheck />Mark all read</Button>}
        </>} />
      <QueryState q={q}>
        {!rows.length ? <EmptyState icon={unreadOnly ? <BellOff /> : <Bell />} title={unreadOnly ? "No unread notifications" : "No notifications yet"} description="You'll be notified here about incidents and monitoring problems, according to your preferences." /> : (
          <Card className="divide-y divide-border overflow-hidden">
            {rows.map((n) => (
              <div key={n.id} className={cn("relative flex flex-col gap-2 py-3.5 pl-7 pr-4 sm:flex-row sm:items-start sm:justify-between sm:pr-5", !n.read && "bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]")}>
                {!n.read && <span aria-hidden className="absolute left-3 top-5 h-2 w-2 rounded-full bg-primary" />}
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {!n.read && <span className="sr-only">Unread:</span>}
                    <Badge>{TYPE[n.type] ?? n.type}</Badge>
                    {n.severity && <Badge tone={SEVERITY_TONE[n.severity]}>{n.severity}</Badge>}
                  </div>
                  {n.link ? <Link href={n.link} onClick={() => open(n.id, n.read)} className={cn("text-sm hover:text-primary", n.read ? "text-foreground" : "font-semibold")}>{n.title}</Link> : <span className={cn("text-sm", !n.read && "font-semibold")}>{n.title}</span>}
                  <p className="text-sm text-muted-foreground">{n.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{fmtUtc(n.createdAt)}</span>
                  {!n.read && <Button size="sm" variant="ghost" onClick={() => open(n.id, false)}>Mark read</Button>}
                </div>
              </div>
            ))}
            <LoadMore q={q} />
          </Card>
        )}
      </QueryState>
    </>
  );
}
