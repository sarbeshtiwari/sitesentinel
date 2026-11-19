"use client";
import { Badge, Button, Checkbox, FormField, Input, PageHeader, Select, Switch, toast } from "@wim/ui";
import { ArrowLeft, Bell, Check, FlaskConical, Mail } from "lucide-react";
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
  const sel = "h-8 w-auto min-w-0 py-0 pr-8 text-[13px]";
  const iIn = prefs.findIndex((p) => p.channel === "IN_APP");
  const inApp = iIn >= 0 ? prefs[iIn] : undefined;
  const saveBtn = (cls?: string) => <Button className={cls} onClick={save} loading={busy} disabled={!prefs.length}>{!busy && <Check />}{busy ? "Saving…" : "Save preferences"}</Button>;
  const card = "overflow-hidden rounded-lg border border-border bg-card";

  return (
    <>
      <div className="mb-3 text-sm"><Link href={`/o/${orgId}/notifications`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Notifications</Link></div>
      <PageHeader title="Notification preferences" description="Choose where alerts go and how loud they are. These settings are yours — teammates set their own. Each notification is sent once per incident change, however often you reload." actions={saveBtn()} />
      <QueryState q={q}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid min-w-0 content-start gap-5">
            <section aria-labelledby="where" className={card}>
              <h2 id="where" className="border-b border-border px-5 py-3.5 text-[15px] font-semibold tracking-tight">Where should alerts go?</h2>
              <ul className="divide-y divide-border">
                {prefs.map((p, i) => (
                  <li key={p.channel} className="grid gap-2 px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sunken text-muted-foreground ring-1 ring-border">{p.channel === "EMAIL" ? <Mail className="h-4 w-4" /> : <Bell className="h-4 w-4" />}</span>
                      <div className="min-w-0 flex-1 basis-48">
                        <p id={`ch-${p.channel}`} className="text-sm font-medium">{p.channel === "EMAIL" ? "Email" : "In the app"}{!p.enabled && <Badge className="ml-2">Off</Badge>}</p>
                        <p className="text-xs text-muted-foreground">{p.channel === "EMAIL" ? "To your account email address" : "Toasts and the bell, with sound"}</p>
                      </div>
                      <div className="flex items-center gap-3 pl-11 sm:pl-0">
                      <label className="sr-only" htmlFor={`sev-${p.channel}`}>Minimum severity ({CHANNEL[p.channel]})</label>
                      <Select id={`sev-${p.channel}`} className={sel} value={p.minSeverity} disabled={!p.enabled} onChange={(e) => upd(i, { minSeverity: e.target.value as NotificationPreferenceDto["minSeverity"] })}>
                        {SEVERITIES.map((s) => <option key={s} value={s}>{s === "INFO" ? "All" : s === "CRITICAL" ? "Critical only" : `${s[0] + s.slice(1).toLowerCase()} and above`}</option>)}
                      </Select>
                      <Switch checked={p.enabled} onCheckedChange={(v) => upd(i, { enabled: v })} aria-label={`${CHANNEL[p.channel]} notifications enabled`} />
                      </div>
                    </div>
                    {p.isDefault && <Hint>Using the default: {p.enabled ? "owners and admins get medium severity and above" : "off for your role"}. Saving makes it your own setting.</Hint>}
                  </li>
                ))}
                <li className="px-5 py-3.5"><DesktopNotificationControl /></li>
              </ul>
            </section>

            <section aria-labelledby="what" className={card}>
              <div className="border-b border-border px-5 py-3.5">
                <h2 id="what" className="text-[15px] font-semibold tracking-tight">What to notify me about</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Per channel. Everything is included until you untick something.</p>
              </div>
              <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                {prefs.map((p, i) => (
                  <fieldset key={p.channel} className="grid content-start gap-2 px-5 py-4 text-sm disabled:opacity-60" disabled={!p.enabled}>
                    <legend className="float-left mb-1 w-full text-sm font-medium">{CHANNEL[p.channel]} {p.eventTypes.length ? "" : <span className="font-normal text-muted-foreground">(everything)</span>}</legend>
                    {EVENTS.map(([k, l]) => (
                      <label key={k} className="flex items-start gap-2"><Checkbox className="mt-0.5" checked={!p.eventTypes.length || p.eventTypes.includes(k)}
                        onChange={(e) => {
                          const all = p.eventTypes.length ? p.eventTypes : EVENTS.map(([x]) => x);
                          const next = e.currentTarget.checked ? [...new Set([...all, k])] : all.filter((x) => x !== k);
                          upd(i, { eventTypes: next.length === EVENTS.length ? [] : next });
                        }} />{l}</label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </section>

            {inApp && (
              <section aria-labelledby="sound" className={card}>
                <h2 id="sound" className="px-5 pt-4 text-[15px] font-semibold tracking-tight">Sound</h2>
                <fieldset className="grid gap-4 px-5 py-4 text-sm disabled:opacity-60" disabled={!inApp.enabled}>
                  <legend className="sr-only">In-app sound</legend>
                  <div className="flex items-start justify-between gap-4">
                    <div><p id="snd" className="font-medium">Play a sound for new notifications</p><p className="text-xs text-muted-foreground">A short chime; critical alerts use a stronger sound. Saved with your in-app preference.</p></div>
                    <Switch checked={inApp.soundEnabled} disabled={!inApp.enabled} onCheckedChange={(v) => upd(iIn, { soundEnabled: v })} aria-labelledby="snd" />
                  </div>
                  <FormField label="Play the sound for" htmlFor="sound-sev">
                    <Select id="sound-sev" className="sm:max-w-xs" value={inApp.soundMinSeverity} disabled={!inApp.enabled || !inApp.soundEnabled} onChange={(e) => upd(iIn, { soundMinSeverity: e.target.value as NotificationPreferenceDto["soundMinSeverity"] })}>
                      {SEVERITIES.map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()} and above</option>)}
                    </Select>
                  </FormField>
                </fieldset>
                <BrowserSettings orgId={orgId} inApp={inApp} />
              </section>
            )}
          </div>

          <div className="grid min-w-0 content-start gap-5">
            {inApp && (
              <section aria-labelledby="quiet" className={card}>
                <div className="flex items-center justify-between gap-3 px-5 pt-4">
                  <h2 id="quiet" className="text-[15px] font-semibold tracking-tight">Quiet hours</h2>
                  <Switch checked={Boolean(inApp.quietHours)} disabled={!inApp.enabled} aria-label="No sound or desktop popups during quiet hours (notifications still appear here)"
                    onCheckedChange={(v) => upd(iIn, { quietHours: v ? { start: "22:00", end: "07:00", tz: localZone(), exceptCritical: true } : null })} />
                </div>
                <fieldset className="grid gap-3 px-5 pb-4 pt-2 text-sm disabled:opacity-60" disabled={!inApp.enabled}>
                  <legend className="sr-only">Quiet hours</legend>
                  <p className="text-xs text-muted-foreground">No sound or desktop popups during these hours. Alerts still appear in the list.</p>
                  {inApp.quietHours && <>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="From" htmlFor="qh-start"><Input id="qh-start" type="time" required value={inApp.quietHours.start} onChange={(e) => upd(iIn, { quietHours: { ...inApp.quietHours!, start: e.target.value } })} /></FormField>
                      <FormField label="Until" htmlFor="qh-end"><Input id="qh-end" type="time" required value={inApp.quietHours.end} onChange={(e) => upd(iIn, { quietHours: { ...inApp.quietHours!, end: e.target.value } })} /></FormField>
                    </div>
                    <FormField label="Time zone" htmlFor="qh-tz"><Input id="qh-tz" value={inApp.quietHours.tz} maxLength={64} onChange={(e) => upd(iIn, { quietHours: { ...inApp.quietHours!, tz: e.target.value } })} /></FormField>
                    <label className="flex items-center gap-2"><Checkbox checked={inApp.quietHours.exceptCritical} onChange={(e) => upd(iIn, { quietHours: { ...inApp.quietHours!, exceptCritical: e.currentTarget.checked } })} />Still alert me for critical notifications</label>
                  </>}
                </fieldset>
              </section>
            )}
            <section aria-labelledby="which" className={card}>
              <h2 id="which" className="px-5 pt-4 text-[15px] font-semibold tracking-tight">Which websites</h2>
              <div className="grid divide-y divide-border">
                {prefs.map((p, i) => (
                  <fieldset key={p.channel} className="grid gap-2 px-5 py-3.5 text-sm disabled:opacity-60" disabled={!p.enabled}>
                    <legend className="float-left mb-1 w-full text-[13px] font-medium text-muted-foreground">{CHANNEL[p.channel]} · websites {p.websiteIds.length ? "" : "(all)"}</legend>
                    {(sites.data ?? []).map((w) => (
                      <label key={w.id} className="flex items-center gap-2"><Checkbox checked={!p.websiteIds.length || p.websiteIds.includes(w.id)}
                        onChange={(e) => {
                          const all = p.websiteIds.length ? p.websiteIds : (sites.data ?? []).map((x) => x.id);
                          const next = e.currentTarget.checked ? [...new Set([...all, w.id])] : all.filter((x) => x !== w.id);
                          upd(i, { websiteIds: next.length === (sites.data ?? []).length ? [] : next });
                        }} /><span className="min-w-0 truncate">{w.name}</span></label>
                    ))}
                    {sites.data && !sites.data.length && <p className="text-xs text-muted-foreground">No websites yet — all future websites are included.</p>}
                  </fieldset>
                ))}
              </div>
            </section>
          </div>
        </div>
        <div className="mt-5 flex justify-end">{saveBtn()}</div>
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
    <div className="grid gap-4 border-t border-border bg-sunken/40 px-5 py-4 text-sm">
      <div><p className="font-medium">This browser</p><p className="text-xs text-muted-foreground">Real-time alerts while the app is open in a tab. Saved in this browser only. Nothing arrives while every tab is closed.</p></div>
      <div className="flex items-start justify-between gap-4">
        <span id="mute" className="text-sm">Mute notification sounds in this browser</span>
        <Switch checked={muted} onCheckedChange={setMuted} aria-labelledby="mute" />
      </div>
      <div className="flex items-start justify-between gap-4">
        <span id="osf" className="text-sm">Also show desktop notifications while the app is in front <span className="block text-xs text-muted-foreground">Off by default — the in-app toast is usually enough.</span></span>
        <Switch checked={osFocused} onCheckedChange={setOsFocused} aria-labelledby="osf" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => test("HIGH")}><FlaskConical />Test notification</Button>
        <Button variant="outline" size="sm" onClick={() => test("CRITICAL")}><FlaskConical />Test critical</Button>
        <span className="text-xs text-muted-foreground">Shows a toast, a desktop notification (if enabled) and plays the sound ({muted ? "muted here" : inApp?.soundEnabled === false ? "sound is off in your in-app preference" : "on"}). Local only.</span>
      </div>
    </div>
  );
}
