"use client";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, FormField, Input, PageHeader, Select, toast } from "@wim/ui";
import { ArrowLeft, FlaskConical, Mail, MonitorSmartphone } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { NotificationPreferenceDto } from "@wim/contracts";
import { Hint, QueryState } from "@/components/monitoring";
import { api, errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { mk, useNotificationPrefs } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";
import { DesktopNotificationControl } from "@/components/notification-bell";
import { presentNotification, useOpenNotification, useOsWhenFocused, useSoundMuted } from "@/lib/realtime-notifications";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

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
      <div className="mb-3 text-sm"><Link href={`/o/${orgId}/notifications`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Notifications</Link></div>
      <PageHeader title="Notification preferences" description="Your own preferences for this organisation. Each notification is sent once per incident change, however often you reload." />
      <QueryState q={q}>
        <div className="grid gap-5 lg:grid-cols-2">
          {prefs.map((p, i) => (
            <Card key={p.channel}>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-soft text-primary">{p.channel === "EMAIL" ? <Mail className="h-4 w-4" /> : <MonitorSmartphone className="h-4 w-4" />}</span>
                  <CardTitle>{CHANNEL[p.channel]}</CardTitle>
                  {!p.enabled && <Badge>Off</Badge>}
                </div>
                <label className="flex items-center gap-2 text-sm font-medium"><Checkbox checked={p.enabled} onChange={(e) => upd(i, { enabled: e.currentTarget.checked })} /> Enabled</label>
              </CardHeader>
              <CardContent className="grid gap-5">
              {p.isDefault && <Hint>Using the default: {p.enabled ? "owners and admins get medium severity and above" : "off for your role"}. Saving makes it your own setting.</Hint>}
              <FormField label="Minimum severity" htmlFor={`sev-${p.channel}`}>
                <Select id={`sev-${p.channel}`} value={p.minSeverity} disabled={!p.enabled} onChange={(e) => upd(i, { minSeverity: e.target.value as NotificationPreferenceDto["minSeverity"] })}>
                  {["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()} and above</option>)}
                </Select>
              </FormField>
              <fieldset className="grid gap-2 text-sm disabled:opacity-60" disabled={!p.enabled}>
                <legend className="mb-2 text-sm font-medium">Notify me about {p.eventTypes.length ? "" : "(everything)"}</legend>
                {EVENTS.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-2"><Checkbox checked={!p.eventTypes.length || p.eventTypes.includes(k)}
                    onChange={(e) => {
                      const all = p.eventTypes.length ? p.eventTypes : EVENTS.map(([x]) => x);
                      const next = e.currentTarget.checked ? [...new Set([...all, k])] : all.filter((x) => x !== k);
                      upd(i, { eventTypes: next.length === EVENTS.length ? [] : next });
                    }} />{l}</label>
                ))}
              </fieldset>
              {p.channel === "IN_APP" && <>
                <fieldset className="grid gap-3 text-sm disabled:opacity-60" disabled={!p.enabled}>
                  <legend className="mb-2 text-sm font-medium">Sound</legend>
                  <label className="flex items-center gap-2"><Checkbox checked={p.soundEnabled} onChange={(e) => upd(i, { soundEnabled: e.currentTarget.checked })} />Play a sound for new notifications</label>
                  <FormField label="Play the sound for" htmlFor="sound-sev">
                    <Select id="sound-sev" value={p.soundMinSeverity} disabled={!p.enabled || !p.soundEnabled} onChange={(e) => upd(i, { soundMinSeverity: e.target.value as NotificationPreferenceDto["soundMinSeverity"] })}>
                      {SEVERITIES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()} and above</option>)}
                    </Select>
                  </FormField>
                </fieldset>
                <fieldset className="grid gap-3 text-sm disabled:opacity-60" disabled={!p.enabled}>
                  <legend className="mb-2 text-sm font-medium">Quiet hours</legend>
                  <label className="flex items-center gap-2"><Checkbox checked={Boolean(p.quietHours)} onChange={(e) => upd(i, { quietHours: e.currentTarget.checked ? { start: "22:00", end: "07:00", tz: localZone(), exceptCritical: true } : null })} />No sound or desktop popups during quiet hours (notifications still appear here)</label>
                  {p.quietHours && <>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="From" htmlFor="qh-start"><Input id="qh-start" type="time" required value={p.quietHours.start} onChange={(e) => upd(i, { quietHours: { ...p.quietHours!, start: e.target.value } })} /></FormField>
                      <FormField label="Until" htmlFor="qh-end"><Input id="qh-end" type="time" required value={p.quietHours.end} onChange={(e) => upd(i, { quietHours: { ...p.quietHours!, end: e.target.value } })} /></FormField>
                    </div>
                    <FormField label="Time zone" htmlFor="qh-tz"><Input id="qh-tz" value={p.quietHours.tz} maxLength={64} onChange={(e) => upd(i, { quietHours: { ...p.quietHours!, tz: e.target.value } })} /></FormField>
                    <label className="flex items-center gap-2"><Checkbox checked={p.quietHours.exceptCritical} onChange={(e) => upd(i, { quietHours: { ...p.quietHours!, exceptCritical: e.currentTarget.checked } })} />Still alert me for critical notifications</label>
                  </>}
                </fieldset>
              </>}
              <fieldset className="grid gap-2 text-sm disabled:opacity-60" disabled={!p.enabled}>
                <legend className="mb-2 text-sm font-medium">Websites {p.websiteIds.length ? "" : "(all)"}</legend>
                {(sites.data ?? []).map((w) => (
                  <label key={w.id} className="flex items-center gap-2"><Checkbox checked={!p.websiteIds.length || p.websiteIds.includes(w.id)}
                    onChange={(e) => {
                      const all = p.websiteIds.length ? p.websiteIds : (sites.data ?? []).map((x) => x.id);
                      const next = e.currentTarget.checked ? [...new Set([...all, w.id])] : all.filter((x) => x !== w.id);
                      upd(i, { websiteIds: next.length === (sites.data ?? []).length ? [] : next });
                    }} />{w.name}</label>
                ))}
              </fieldset>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-5 flex justify-end"><Button onClick={save} loading={busy}>{busy ? "Saving…" : "Save preferences"}</Button></div>
        <BrowserSettings orgId={orgId} inApp={prefs.find((p) => p.channel === "IN_APP")} />
      </QueryState>
    </>
  );
}

/** Settings that live in this browser only (permission, mute, popups while focused) and a local test. */
function BrowserSettings({ orgId, inApp }: { orgId: string; inApp: NotificationPreferenceDto | undefined }) {
  const [muted, setMuted] = useSoundMuted();
  const [osFocused, setOsFocused] = useOsWhenFocused();
  const open = useOpenNotification(orgId);
  const test = (severity: "HIGH" | "CRITICAL") => {
    const id = `test-${Date.now().toString(36)}`;
    presentNotification(orgId, {
      id, type: "TEST", severity, title: severity === "CRITICAL" ? "Test: critical alert" : "Test notification",
      body: "This is how new notifications will look. Nothing was sent or saved.", link: null, incidentId: null, read: false,
      createdAt: new Date().toISOString(), websiteName: null,
    }, { prefs: inApp, leader: true, open, test: true });
  };
  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>This browser</CardTitle>
        <CardDescription>Real-time alerts while the app is open in a tab. Saved in this browser only. Nothing arrives while every tab is closed.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <DesktopNotificationControl />
        <div className="grid gap-2 text-sm">
          <label className="flex items-center gap-2"><Checkbox checked={muted} onChange={(e) => setMuted(e.currentTarget.checked)} />Mute notification sounds in this browser</label>
          <label className="flex items-center gap-2"><Checkbox checked={osFocused} onChange={(e) => setOsFocused(e.currentTarget.checked)} />Also show desktop notifications while the app is in front (otherwise the in-app toast is enough)</label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => test("HIGH")}><FlaskConical />Test notification</Button>
          <Button variant="outline" size="sm" onClick={() => test("CRITICAL")}><FlaskConical />Test critical</Button>
          <span className="text-xs text-muted-foreground">Shows a toast, a desktop notification (if enabled) and plays the sound ({muted ? "muted here" : inApp?.soundEnabled === false ? "sound is off in your in-app preference" : "on"}). Local only.</span>
        </div>
      </CardContent>
    </Card>
  );
}
