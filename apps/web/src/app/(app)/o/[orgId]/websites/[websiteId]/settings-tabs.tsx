"use client";
import { Badge, Card, cn, StatusPill } from "@wim/ui";
import { Activity, AlertTriangle, Bell, Code2, History, Settings2, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { WebsiteDetailDto } from "@wim/contracts";
import type { Permission } from "@wim/core";
import { QueryState, Section } from "@/components/monitoring";
import { useNotificationPrefs } from "@/lib/monitoring";
import { AuditTab, HistoryTab } from "./history-tabs";
import { InstallationTab } from "./installation-tab";
import { MonitoringSettingsTab } from "./monitoring-settings-tab";
import { DangerZone, WebsiteDetailsForm } from "./settings-tab";
import { VerificationTab } from "./verification-tab";
import { tabHref, type SettingsSection } from "./website-data";

const NAV: Array<{ id: SettingsSection; label: string; icon: LucideIcon; danger?: boolean }> = [
  { id: "monitoring", label: "Monitoring", icon: Activity },
  { id: "general", label: "Website details", icon: Settings2 },
  { id: "ownership", label: "Ownership", icon: ShieldCheck },
  { id: "script", label: "Monitoring script", icon: Code2 },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "activity", label: "Activity log", icon: History },
  { id: "danger", label: "Danger zone", icon: AlertTriangle, danger: true },
];

export function SettingsTabs({ w, orgId, section, can }: { w: WebsiteDetailDto; orgId: string; section: string | null; can: (p: Permission) => boolean }) {
  const canWrite = can("website:write");
  const canDelete = can("website:delete");
  const items = NAV.filter((n) => (n.id !== "general" || canWrite) && (n.id !== "danger" || canWrite || canDelete));
  const s: SettingsSection = items.some((n) => n.id === section) ? (section as SettingsSection) : "monitoring";
  return (
    <div className="grid gap-5 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
      <nav aria-label="Website settings">
        <ul className="flex flex-wrap gap-1 lg:flex-col">
          {items.map((n) => {
            const on = n.id === s;
            const Icon = n.icon;
            return (
              <li key={n.id}>
                <Link href={tabHref(orgId, w.id, "settings", n.id)} scroll={false} aria-current={on ? "page" : undefined}
                  className={cn("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors lg:w-full",
                    on ? "border-border bg-card font-medium shadow-xs" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                    n.danger && "text-danger-text hover:text-danger-text")}>
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />{n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">
        {s === "monitoring" && <MonitoringSettingsTab orgId={orgId} websiteId={w.id} canWrite={can("monitoring:write")} />}
        {s === "general" && <div className="max-w-2xl"><WebsiteDetailsForm w={w} orgId={orgId} /></div>}
        {s === "ownership" && <VerificationTab w={w} orgId={orgId} canWrite={canWrite} />}
        {s === "script" && <InstallationTab w={w} orgId={orgId} canWrite={canWrite} />}
        {s === "alerts" && <AlertsSection orgId={orgId} websiteId={w.id} />}
        {s === "activity" && (
          <div className="grid gap-5">
            <HistoryTab w={w} orgId={orgId} />
            {can("audit:read") && <AuditTab w={w} orgId={orgId} />}
            <p className="text-xs text-muted-foreground">Checks, incidents and configuration changes of this website: <Link className="text-primary hover:underline" href={`/o/${orgId}/history?websiteId=${w.id}`}>monitoring history</Link>.</p>
          </div>
        )}
        {s === "danger" && <div className="max-w-3xl"><DangerZone w={w} orgId={orgId} canWrite={canWrite} canDelete={canDelete} /></div>}
      </div>
    </div>
  );
}

const SEV: Record<string, string> = { CRITICAL: "critical", HIGH: "high and above", MEDIUM: "medium and above", LOW: "low and above", INFO: "everything" };

/** Alerts are set per person (channels, severity, websites); this shows what applies to this website for you. */
function AlertsSection({ orgId, websiteId }: { orgId: string; websiteId: string }) {
  const q = useNotificationPrefs(orgId);
  return (
    <div className="grid gap-5">
      <Section title="Your alerts for this website" icon={<Bell />} description="Who is notified is set per person under Notification preferences — there are no separate alert settings per website.">
        <QueryState q={q} skeleton="h-24">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(q.data ?? []).map((p) => {
              const included = !p.websiteIds.length || p.websiteIds.includes(websiteId);
              return (
                <li key={p.channel} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{p.channel === "EMAIL" ? "Email" : "In the app"}</p>
                    <p className="text-xs text-muted-foreground">{p.enabled ? `Severity: ${SEV[p.minSeverity] ?? p.minSeverity}${p.eventTypes.length ? ` · ${p.eventTypes.length} event type${p.eventTypes.length === 1 ? "" : "s"}` : " · all events"}` : "Turned off"}{p.isDefault ? " · default" : ""}</p>
                  </div>
                  <StatusPill tone={p.enabled && included ? "success" : "neutral"}>{!p.enabled ? "Off" : included ? (p.websiteIds.length ? "This website included" : "All websites") : "This website excluded"}</StatusPill>
                </li>
              );
            })}
            {!q.data?.length && <li className="px-4 py-3 text-sm text-muted-foreground">No preferences saved yet — the defaults apply.</li>}
          </ul>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <Link className="font-medium text-primary hover:underline" href={`/o/${orgId}/notifications/preferences`}>Change notification preferences</Link>
            <Link className="text-primary hover:underline" href={tabHref(orgId, websiteId, "performance", "speed")}>When a page counts as slow (performance thresholds)</Link>
            <Link className="text-primary hover:underline" href={tabHref(orgId, websiteId, "settings", "monitoring")}>Failures in a row before an incident (monitoring)</Link>
          </div>
        </QueryState>
      </Section>
      <Card className="px-4 py-3 text-xs text-muted-foreground">Incidents open after the configured number of failed checks and close on recovery; each opening, reopening and recovery is notified according to the preferences above. <Badge className="ml-1">per person</Badge></Card>
    </div>
  );
}
