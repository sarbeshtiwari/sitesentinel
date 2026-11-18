"use client";
import type { NotificationDto } from "@wim/contracts";
import { truncate } from "@wim/core";
import { Button, cn, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, toast } from "@wim/ui";
import { Bell, BellOff, BellRing, CheckCheck, MonitorSmartphone, Volume2, VolumeX } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { errorMessage, get, post } from "@/lib/api";
import { useDesktopPermission, useOpenNotification, useSoundMuted, type DesktopPermission } from "@/lib/realtime-notifications";
import { severityStyle, shortTime } from "./notification-toasts";

const PERMISSION_TEXT: Record<DesktopPermission, string> = {
  granted: "Desktop notifications are on for this browser.",
  default: "Get a desktop notification when this tab is in the background.",
  denied: "Desktop notifications are blocked. Allow them in your browser's site settings (the icon left of the address bar → Notifications), then reload.",
  unsupported: "This browser doesn't support desktop notifications from web pages (or the page isn't served over HTTPS).",
};

// DropdownItem greys its icons; severity colours need the important modifier (literal classes for Tailwind).
const MENU_ICON: Record<string, string> = { "text-danger": "!text-danger", "text-warning": "!text-warning", "text-info": "!text-info", "text-success": "!text-success" };

/** "Enable desktop notifications" with the current state. Asks for permission only on click. */
export function DesktopNotificationControl({ className }: { className?: string }) {
  const { permission, request } = useDesktopPermission();
  const ask = async () => {
    const p = await request();
    if (p === "granted") toast.success("Desktop notifications enabled");
    else if (p === "denied") toast.error("Desktop notifications were blocked by the browser");
  };
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        <MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Desktop notifications: {permission === "granted" ? "on" : permission === "denied" ? "blocked" : permission === "unsupported" ? "not supported" : "off"}</span>
          <span className="text-sm text-muted-foreground">{PERMISSION_TEXT[permission]}</span>
        </div>
      </div>
      {permission === "default" && <Button size="sm" variant="outline" onClick={ask}><BellRing />Enable desktop notifications</Button>}
    </div>
  );
}

/** Bell in the top bar: live unread badge, latest five, mark all read, mute, desktop notifications, link to the page. */
export function NotificationBell({ orgId, unread, className }: { orgId: string; unread: number; className?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const open = useOpenNotification(orgId);
  const [muted, setMuted] = useSoundMuted();
  const { permission, request } = useDesktopPermission();
  const latest = useQuery({
    queryKey: ["org", orgId, "notifications", "latest"],
    queryFn: ({ signal }) => get<{ data: NotificationDto[]; unread: number }>(`/orgs/${orgId}/notifications?limit=5`, { signal }),
  });
  const count = unread; // live, from the change feed
  const markAll = async () => {
    try {
      await post(`/orgs/${orgId}/notifications/read-all`);
      await qc.invalidateQueries({ queryKey: ["org", orgId, "notifications"] });
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const rows = latest.data?.data ?? [];
  return (
    <DropdownMenu
      label={count ? `Notifications, ${count} unread` : "Notifications"}
      triggerClassName={className}
      trigger={<>
        <Bell className="h-[18px] w-[18px]" aria-hidden />
        {count > 0 && <span aria-hidden className="absolute right-1 top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-background">{count > 99 ? "99+" : count}</span>}
      </>}
    >
      <div className="w-[min(22rem,calc(100vw-2rem))]">
        <DropdownLabel><span className="flex items-center justify-between"><span className="font-medium text-foreground">Notifications</span><span>{count ? `${count} unread` : "All caught up"}</span></span></DropdownLabel>
        <DropdownSeparator />
        {latest.isLoading && <div className="px-2 py-3 text-sm text-muted-foreground">Loading…</div>}
        {!latest.isLoading && !rows.length && <div className="px-2 py-3 text-sm text-muted-foreground">No notifications yet.</div>}
        {rows.map((n) => {
          const s = severityStyle(n);
          const Icon = s.icon;
          return (
            <DropdownItem key={n.id} onClick={() => open(n)} className="items-start py-2">
              <Icon className={cn("mt-0.5 shrink-0", MENU_ICON[s.icon_])} aria-hidden />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className={cn("truncate", !n.read && "font-semibold")}>{!n.read && <span className="sr-only">Unread: </span>}{truncate(n.title, 80)}</span>
                <span className="truncate text-xs text-muted-foreground">{[s.label, n.websiteName, shortTime(n.createdAt)].filter(Boolean).join(" · ")}</span>
              </span>
              {!n.read && <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
            </DropdownItem>
          );
        })}
        <DropdownSeparator />
        {count > 0 && <DropdownItem onClick={markAll}><CheckCheck /> Mark all as read</DropdownItem>}
        <DropdownItem onClick={() => { setMuted(!muted); toast.success(muted ? "Notification sounds on" : "Notification sounds muted in this browser"); }} aria-pressed={muted}>
          {muted ? <VolumeX /> : <Volume2 />} {muted ? "Unmute sounds" : "Mute sounds"}
        </DropdownItem>
        {permission === "default" && (
          <DropdownItem onClick={async () => { const p = await request(); if (p === "granted") toast.success("Desktop notifications enabled"); else if (p === "denied") toast.error("Desktop notifications were blocked by the browser"); }}>
            <BellRing /> Enable desktop notifications
          </DropdownItem>
        )}
        {permission === "denied" && <DropdownItem onClick={() => router.push(`/o/${orgId}/notifications/preferences`)}><BellOff /> Desktop notifications blocked — how to fix</DropdownItem>}
        <DropdownItem onClick={() => router.push(`/o/${orgId}/notifications`)}><Bell /> View all notifications</DropdownItem>
      </div>
    </DropdownMenu>
  );
}
