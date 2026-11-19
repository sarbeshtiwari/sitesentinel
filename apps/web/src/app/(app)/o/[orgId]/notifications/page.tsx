"use client";
import { Button, buttonVariants, Card, cn, EmptyState, FilterChip, PageHeader, SeverityBadge, toast } from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck, ChevronRight, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LoadMore, QueryState } from "@/components/monitoring";
import { ago } from "@/components/org-ui";
import { errorMessage, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { DesktopNotificationControl } from "@/components/notification-bell";
import { fmtTime, useNotifications } from "@/lib/monitoring";

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
      <PageHeader title="Notifications" description={`Alerts we sent you in this organisation. Click one to jump to the problem. ${unread} unread.`}
        actions={<>
          <Link href={`/o/${orgId}/notifications/preferences`} className={buttonVariants({ variant: "outline", size: "sm" })}><Settings2 />Preferences</Link>
          {unread > 0 && <Button size="sm" onClick={markAll}><CheckCheck />Mark all read</Button>}
        </>} />
      <DesktopNotificationControl banner className="mb-4" />
      <div role="radiogroup" aria-label="Show" className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip role="radio" aria-checked={unreadOnly} aria-pressed={undefined} selected={unreadOnly} count={unread} onClick={() => setUnreadOnly(true)}>Unread</FilterChip>
        <FilterChip role="radio" aria-checked={!unreadOnly} aria-pressed={undefined} selected={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</FilterChip>
      </div>
      <QueryState q={q}>
        {!rows.length ? <EmptyState icon={unreadOnly ? <BellOff /> : <Bell />} title={unreadOnly ? "No unread notifications" : "No notifications yet"} description="You'll be notified here about incidents and monitoring problems, according to your preferences." /> : (
          <Card className="divide-y divide-border overflow-hidden">
            {rows.map((n) => (
              <div key={n.id} className={cn("relative flex items-start gap-3 py-3.5 pl-7 pr-3 sm:pr-4", !n.read && "bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]")}>
                {!n.read && <span aria-hidden className="absolute left-3 top-[22px] h-2 w-2 rounded-full bg-primary" />}
                <div className="grid min-w-0 flex-1 gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {!n.read && <span className="sr-only">Unread:</span>}
                    {n.severity && <SeverityBadge severity={n.severity} />}
                    <span className="text-xs text-muted-foreground">{TYPE[n.type] ?? n.type}</span>
                    {n.websiteName && <span className="text-xs text-muted-foreground">· {n.websiteName}</span>}
                    <time dateTime={n.createdAt} title={fmtTime(n.createdAt)} className="text-xs tabular-nums text-muted-foreground sm:hidden">· {ago(n.createdAt)}</time>
                  </div>
                  {n.link ? <Link href={n.link} onClick={() => open(n.id, n.read)} className={cn("text-sm hover:text-primary", n.read ? "text-foreground" : "font-semibold")}>{n.title}</Link> : <span className={cn("text-sm", !n.read && "font-semibold")}>{n.title}</span>}
                  <p className="text-[13px] text-muted-foreground">{n.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <time dateTime={n.createdAt} title={fmtTime(n.createdAt)} className="hidden tabular-nums sm:inline">{ago(n.createdAt)}</time>
                  {!n.read && <Button size="sm" variant="ghost" onClick={() => open(n.id, false)}>Mark read</Button>}
                  {n.link && <ChevronRight aria-hidden className="hidden h-4 w-4 text-faint sm:block" />}
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
