"use client";
import { Button, Card, Checkbox, PageHeader, Select, toast } from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { NotificationPreferenceDto } from "@wim/contracts";
import { Hint, QueryState } from "@/components/monitoring";
import { api, errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { mk, useNotificationPrefs } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";

const EVENTS: Array<[NotificationPreferenceDto["eventTypes"][number], string]> = [
  ["INCIDENT_OPENED", "Website outages and HTTP incidents"], ["INCIDENT_RESOLVED", "Recoveries"], ["SSL_EXPIRING", "Certificate expiry warnings"],
  ["BROWSER_FAILURE", "Browser monitoring failures"], ["DEEP_SCAN_FINDINGS", "Deep-scan findings (broken pages / resources)"], ["MONITORING_INTERRUPTED", "Monitoring infrastructure interruptions"],
];
const CHANNEL: Record<string, string> = { EMAIL: "Email", IN_APP: "In-app" };

export default function PreferencesPage() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const q = useNotificationPrefs(orgId);
  const sites = useWebsites(orgId);
  const [prefs, setPrefs] = useState<NotificationPreferenceDto[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setPrefs(q.data); }, [q.data]);
  const upd = (i: number, patch: Partial<NotificationPreferenceDto>) => setPrefs(prefs.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const save = async () => {
    setBusy(true);
    try {
      await api("PUT", `/orgs/${orgId}/notification-preferences`, { preferences: prefs.map(({ isDefault: _d, ...p }) => p) });
      toast.success("Preferences saved");
      await qc.invalidateQueries({ queryKey: mk.prefs(orgId) });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="mb-2 text-sm"><Link href={`/o/${orgId}/notifications`} className="text-muted-foreground hover:underline">← Notifications</Link></div>
      <PageHeader title="Notification preferences" description="Your own preferences for this organisation. Each notification is sent once per incident change, however often you reload." />
      <QueryState q={q}>
        <div className="grid gap-6 lg:grid-cols-2">
          {prefs.map((p, i) => (
            <Card key={p.channel} className="grid gap-4 p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{CHANNEL[p.channel]}</h2>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={p.enabled} onChange={(e) => upd(i, { enabled: e.currentTarget.checked })} /> Enabled</label>
              </div>
              {p.isDefault && <Hint>Using the default: {p.enabled ? "owners and admins get medium severity and above" : "off for your role"}. Saving makes it your own setting.</Hint>}
              <label className="grid gap-1 text-sm">Minimum severity
                <Select value={p.minSeverity} disabled={!p.enabled} onChange={(e) => upd(i, { minSeverity: e.target.value as NotificationPreferenceDto["minSeverity"] })}>
                  {["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()} and above</option>)}
                </Select>
              </label>
              <fieldset className="grid gap-1.5 text-sm" disabled={!p.enabled}>
                <legend className="mb-1 font-medium">Notify me about {p.eventTypes.length ? "" : "(everything)"}</legend>
                {EVENTS.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-2"><Checkbox checked={!p.eventTypes.length || p.eventTypes.includes(k)}
                    onChange={(e) => {
                      const all = p.eventTypes.length ? p.eventTypes : EVENTS.map(([x]) => x);
                      const next = e.currentTarget.checked ? [...new Set([...all, k])] : all.filter((x) => x !== k);
                      upd(i, { eventTypes: next.length === EVENTS.length ? [] : next });
                    }} />{l}</label>
                ))}
              </fieldset>
              <fieldset className="grid gap-1.5 text-sm" disabled={!p.enabled}>
                <legend className="mb-1 font-medium">Websites {p.websiteIds.length ? "" : "(all)"}</legend>
                {(sites.data ?? []).map((w) => (
                  <label key={w.id} className="flex items-center gap-2"><Checkbox checked={!p.websiteIds.length || p.websiteIds.includes(w.id)}
                    onChange={(e) => {
                      const all = p.websiteIds.length ? p.websiteIds : (sites.data ?? []).map((x) => x.id);
                      const next = e.currentTarget.checked ? [...new Set([...all, w.id])] : all.filter((x) => x !== w.id);
                      upd(i, { websiteIds: next.length === (sites.data ?? []).length ? [] : next });
                    }} />{w.name}</label>
                ))}
              </fieldset>
            </Card>
          ))}
        </div>
        <div className="mt-6"><Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save preferences"}</Button></div>
      </QueryState>
    </>
  );
}
