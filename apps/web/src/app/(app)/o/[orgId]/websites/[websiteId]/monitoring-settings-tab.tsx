"use client";
import { Alert, Badge, Button, Checkbox, FormField, Input, Select, Textarea, toast } from "@wim/ui";
import { Globe, MonitorSmartphone, ScanSearch } from "lucide-react";
import { cloneElement, isValidElement, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DataEnvelope, HttpMonitoringSummaryDto, BrowserMonitoringSummaryDto } from "@wim/contracts";
import { Hint, QueryState, Section } from "@/components/monitoring";
import { ApiError, api, errorMessage, get } from "@/lib/api";
import { mk, useSchedule } from "@/lib/monitoring";
import { VIEWPORTS } from "./browser-tab";

const put = <T,>(path: string, body: unknown) => api<T>("PUT", path, body);
const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const minutes = (sec: number | null | undefined) => (sec ? String(Math.round(sec / 60)) : "");

/** FormField with a generated id wired to its single control (label, hint and error stay associated). */
function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }> }) {
  const id = useId();
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={error}>
      {isValidElement(children) ? cloneElement(children, { id, "aria-invalid": Boolean(error), "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined }) : children}
    </FormField>
  );
}

/** Saves one section; field errors from the API are shown inline, never swallowed. */
function useSave(onDone: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErrors({});
    try { await fn(); toast.success(ok); await onDone(); }
    catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors()); toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return { busy, errors, save };
}

function PlanBadge({ available }: { available: boolean }) {
  return <Badge tone={available ? "success" : "neutral"}>{available ? "Included in plan" : "Unavailable"}</Badge>;
}

/** Bottom row of a settings form: optional note on the left, actions right-aligned. */
function FormFooter({ note, children }: { note?: string; children?: React.ReactNode }) {
  if (!note && !children) return null;
  return (
    <div className="-mx-4 -mb-4 mt-1 flex flex-col gap-3 border-t border-border bg-sunken/50 px-4 py-3 sm:col-span-2 sm:-mx-5 sm:-mb-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p className="text-xs text-muted-foreground">{note}</p>
      {children && <div className="flex shrink-0 justify-end gap-2">{children}</div>}
    </div>
  );
}

export function MonitoringSettingsTab({ orgId, websiteId, canWrite }: { orgId: string; websiteId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const sched = useSchedule(orgId, websiteId);
  const http = useQuery({ queryKey: mk.http(orgId, websiteId), queryFn: () => get<DataEnvelope<HttpMonitoringSummaryDto>>(`/orgs/${orgId}/websites/${websiteId}/monitoring/http`).then((r) => r.data) });
  const browser = useQuery({ queryKey: mk.browser(orgId, websiteId), queryFn: () => get<DataEnvelope<BrowserMonitoringSummaryDto>>(`/orgs/${orgId}/websites/${websiteId}/monitoring/browser`).then((r) => r.data) });
  const deep = useQuery({ queryKey: [...mk.deep(orgId, websiteId), "summary-config"], queryFn: () => get<DataEnvelope<{ config: Record<string, any>; effectiveLimits: Record<string, any> }>>(`/orgs/${orgId}/websites/${websiteId}/deep-scan`).then((r) => r.data) });
  const refresh = () => qc.invalidateQueries({ queryKey: mk.site(orgId, websiteId) });
  const ent = sched.data?.entitlements;
  const base = `/orgs/${orgId}/websites/${websiteId}`;

  // ---- form state, initialised from the server
  // Server data initialises each section once and again only after a save. Background refetches (live updates,
  // new check results) must never overwrite what the user is typing.
  const dirty = useRef({ h: false, b: false, d: false });
  const [h, setHRaw] = useState({ interval: "", path: "/", timeoutSec: "15", expected: "200-299, 401, 403", failureThreshold: "", recoveryThreshold: "" });
  const [b, setBRaw] = useState({ enabled: true, interval: "", path: "/", viewports: ["desktop"] as string[], strategy: "load", selector: "", timeoutSec: "30", lcpCritMs: "", clsCrit: "", onSuccess: false, fullPage: false, fnEnabled: false, fnSearch: true, fnNav: true, fnForms: true, fnButtons: true, fnPaths: "", fnAcked: false, fnAck: false, popDismiss: true, popSelector: "" });
  const [d, setDRaw] = useState({ interval: "", maxPages: "", maxDepth: "", include: "", exclude: "", browserDiscovery: false, checkExternalLinks: false, respectRobots: true });
  const setH = (v: typeof h) => { dirty.current.h = true; setHRaw(v); };
  const setB = (v: typeof b) => { dirty.current.b = true; setBRaw(v); };
  const setD = (v: typeof d) => { dirty.current.d = true; setDRaw(v); };
  useEffect(() => {
    if (dirty.current.h) return;
    const c = http.data?.config as Record<string, any> | undefined;
    if (c) setHRaw((x) => ({ ...x, path: c.path ?? "/", timeoutSec: String(Math.round((c.timeoutMs ?? 15000) / 1000)), expected: (c.expectedStatus ?? []).join(", "), failureThreshold: c.failureThreshold ? String(c.failureThreshold) : "", recoveryThreshold: c.recoveryThreshold ? String(c.recoveryThreshold) : "" }));
  }, [http.data]);
  useEffect(() => {
    if (dirty.current.b) return;
    const c = browser.data?.config as Record<string, any> | undefined;
    if (c) setBRaw((x) => ({ ...x, enabled: c.enabled ?? true, path: c.path ?? "/", viewports: c.viewports ?? ["desktop"], strategy: c.readiness?.strategy ?? "load", selector: c.readiness?.selector ?? "", timeoutSec: String(Math.round((c.navigationTimeoutMs ?? 30000) / 1000)), lcpCritMs: c.performance?.lcpCritMs ? String(c.performance.lcpCritMs) : "", clsCrit: c.performance?.clsCrit != null ? String(c.performance.clsCrit) : "", onSuccess: Boolean(c.screenshots?.onSuccess), fullPage: Boolean(c.screenshots?.fullPage),
      fnEnabled: Boolean(c.functional?.enabled), fnSearch: c.functional?.search !== false, fnNav: c.functional?.navigation !== false, fnForms: c.functional?.forms !== false, fnButtons: c.functional?.buttons !== false,
      fnPaths: (c.functional?.allowedPaths ?? []).join(", "), fnAcked: Boolean(c.functional?.riskAcknowledgement), fnAck: false,
      popDismiss: c.popups?.dismiss !== false, popSelector: c.popups?.closeSelector ?? "" }));
  }, [browser.data]);
  useEffect(() => {
    if (dirty.current.d) return;
    const c = deep.data?.config;
    if (c) setDRaw((x) => ({ ...x, maxPages: c.maxPages ? String(c.maxPages) : "", maxDepth: c.maxDepth != null ? String(c.maxDepth) : "", include: (c.includePatterns ?? []).join("\n"), exclude: (c.excludePatterns ?? []).join("\n"), browserDiscovery: Boolean(c.browserDiscovery), checkExternalLinks: Boolean(c.checkExternalLinks), respectRobots: c.respectRobots !== false }));
  }, [deep.data]);
  useEffect(() => {
    const r = sched.data?.requested;
    if (!r) return;
    if (!dirty.current.h) setHRaw((x) => ({ ...x, interval: minutes(r.httpIntervalSec) }));
    if (!dirty.current.b) setBRaw((x) => ({ ...x, interval: minutes(r.browserIntervalSec) }));
    if (!dirty.current.d) setDRaw((x) => ({ ...x, interval: r.deepScanIntervalSec ? String(Math.round(r.deepScanIntervalSec / 3600)) : "" }));
  }, [sched.data]);

  const saved = (k: "h" | "b" | "d") => async () => { dirty.current[k] = false; await refresh(); await qc.invalidateQueries({ queryKey: mk.schedule(orgId, websiteId) }); };
  const hs = useSave(saved("h")), bs = useSave(saved("b")), ds = useSave(saved("d"));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const ro = !canWrite;

  return (
    <QueryState q={sched} skeleton="h-96">
      {ent && (
        <div className="grid gap-5">
          {ro && <Alert title="Read-only">You need the "monitoring:write" permission to change monitoring settings.</Alert>}
          <Hint>Your plan sets the limits; settings here can only make monitoring less frequent or narrower. Every change is recorded in the audit log.</Hint>

          <Section title="HTTP availability" icon={<Globe />} actions={<PlanBadge available={ent.HTTP.available} />} description={ent.HTTP.available ? `Checks every ${minutes(ent.HTTP.minIntervalSec) || "<1"} min by default (your plan's fastest).` : ent.HTTP.reason ?? undefined}>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void hs.save(async () => {
              await put(`${base}/monitoring/schedule`, { httpIntervalSec: num(h.interval) == null ? null : Number(h.interval) * 60 });
              await put(`${base}/monitoring/http/config`, { path: h.path, timeoutMs: Number(h.timeoutSec) * 1000, expectedStatus: lines(h.expected), failureThreshold: num(h.failureThreshold), recoveryThreshold: num(h.recoveryThreshold) });
            }, "HTTP settings saved"); }}>
              <Field label="Check interval (minutes)" hint="Empty = plan default" error={hs.errors.httpIntervalSec}><Input type="number" min={1} disabled={ro} value={h.interval} onChange={(e) => setH({ ...h, interval: e.target.value })} /></Field>
              <Field label="Path" hint="On your verified domain" error={hs.errors.path}><Input disabled={ro} value={h.path} onChange={(e) => setH({ ...h, path: e.target.value })} /></Field>
              <Field label="Expected status codes" hint="e.g. 200-299, 301" error={hs.errors.expectedStatus}><Input disabled={ro} value={h.expected} onChange={(e) => setH({ ...h, expected: e.target.value })} /></Field>
              <Field label="Timeout (seconds)" error={hs.errors.timeoutMs}><Input type="number" min={1} max={60} disabled={ro} value={h.timeoutSec} onChange={(e) => setH({ ...h, timeoutSec: e.target.value })} /></Field>
              <Field label="Failures before an incident" hint="Empty = default" error={hs.errors.failureThreshold}><Input type="number" min={1} max={20} disabled={ro} value={h.failureThreshold} onChange={(e) => setH({ ...h, failureThreshold: e.target.value })} /></Field>
              <Field label="Passes before recovery" hint="Empty = default" error={hs.errors.recoveryThreshold}><Input type="number" min={1} max={20} disabled={ro} value={h.recoveryThreshold} onChange={(e) => setH({ ...h, recoveryThreshold: e.target.value })} /></Field>
              <FormFooter note="Alerts: who is notified is set per person under Notifications.">{!ro && <Button type="submit" disabled={hs.busy}>{hs.busy ? "Saving…" : "Save HTTP settings"}</Button>}</FormFooter>
            </form>
          </Section>

          <Section title="Browser monitoring" icon={<MonitorSmartphone />} actions={<PlanBadge available={ent.BROWSER.available} />} description={ent.BROWSER.available ? "Synthetic checks in real Chromium from our runners — not real-user data." : `Unavailable: ${ent.BROWSER.reason}.`}>
            {!ent.BROWSER.available ? <Hint>Contact your account owner to upgrade. Settings can't be changed while the feature isn't available to your organisation.</Hint> : (
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void bs.save(async () => {
                await put(`${base}/monitoring/schedule`, { browserIntervalSec: num(b.interval) == null ? null : Number(b.interval) * 60 });
                await put(`${base}/monitoring/browser/config`, {
                  enabled: b.enabled, path: b.path, viewports: b.viewports, navigationTimeoutMs: Number(b.timeoutSec) * 1000,
                  readiness: { strategy: b.strategy, selector: b.strategy === "selector" ? b.selector : null },
                  screenshots: { onSuccess: b.onSuccess, fullPage: b.fullPage },
                  functional: { enabled: b.fnEnabled, search: b.fnSearch, navigation: b.fnNav, forms: b.fnForms, buttons: b.fnButtons,
                    allowedPaths: String(b.fnPaths ?? "").split(",").map((x: string) => x.trim()).filter(Boolean) },
                  ...(b.fnEnabled && b.fnAck ? { acknowledgeFunctionalRisk: true } : {}),
                  popups: { dismiss: b.popDismiss, closeSelector: b.popSelector.trim() ? b.popSelector.trim() : null },
                  performance: { ...(b.lcpCritMs ? { lcpCritMs: Number(b.lcpCritMs) } : {}), ...(b.clsCrit ? { clsCrit: Number(b.clsCrit) } : {}) },
                });
              }, "Browser settings saved"); }}>
                <label className="flex items-center gap-2.5 rounded-lg border border-border bg-sunken/50 px-3.5 py-3 text-sm font-medium sm:col-span-2"><Checkbox disabled={ro} checked={b.enabled} onChange={(e) => setB({ ...b, enabled: e.currentTarget.checked })} /> Browser monitoring enabled for this website</label>
                <Field label="Frequency (minutes)" hint={`Fastest your plan allows: ${minutes(ent.BROWSER.minIntervalSec)} min`} error={bs.errors.browserIntervalSec}><Input type="number" min={1} disabled={ro} value={b.interval} onChange={(e) => setB({ ...b, interval: e.target.value })} /></Field>
                <Field label="Page path" error={bs.errors.path}><Input disabled={ro} value={b.path} onChange={(e) => setB({ ...b, path: e.target.value })} /></Field>
                <Field label="Readiness" error={bs.errors["readiness.strategy"]}>
                  <Select disabled={ro} value={b.strategy} onChange={(e) => setB({ ...b, strategy: e.target.value })}>
                    <option value="load">Page load event</option><option value="domcontentloaded">DOM ready</option><option value="networkquiet">Network quiet</option><option value="selector">Element appears</option><option value="fixed">Fixed wait</option>
                  </Select>
                </Field>
                {b.strategy === "selector" && <Field label="Wait for selector" error={bs.errors["readiness.selector"]}><Input disabled={ro} value={b.selector} onChange={(e) => setB({ ...b, selector: e.target.value })} placeholder="#app" /></Field>}
                <Field label="Timeout (seconds)" error={bs.errors.navigationTimeoutMs}><Input type="number" min={5} max={120} disabled={ro} value={b.timeoutSec} onChange={(e) => setB({ ...b, timeoutSec: e.target.value })} /></Field>
                <fieldset className="grid gap-1 text-sm sm:col-span-2"><legend className="mb-1.5 text-sm font-medium">Viewports</legend>
                  <div className="flex flex-wrap gap-2">{VIEWPORTS.filter(([v]) => v).map(([v, l]) => (
                    <label key={v} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 has-[:checked]:border-primary has-[:checked]:bg-primary-soft"><Checkbox disabled={ro} checked={b.viewports.includes(v)} onChange={(e) => setB({ ...b, viewports: e.currentTarget.checked ? [...b.viewports, v] : b.viewports.filter((x) => x !== v) })} />{l}</label>
                  ))}</div>
                  {bs.errors.viewports && <p className="text-xs text-danger">{bs.errors.viewports}</p>}
                </fieldset>
                <Field label="LCP critical threshold (ms)" hint="Empty = platform default" error={bs.errors["performance.lcpCritMs"]}><Input type="number" disabled={ro} value={b.lcpCritMs} onChange={(e) => setB({ ...b, lcpCritMs: e.target.value })} /></Field>
                <Field label="CLS critical threshold" hint="Empty = platform default" error={bs.errors["performance.clsCrit"]}><Input type="number" step="0.01" disabled={ro} value={b.clsCrit} onChange={(e) => setB({ ...b, clsCrit: e.target.value })} /></Field>
                <label className="flex items-center gap-2 text-sm"><Checkbox disabled={ro} checked={b.onSuccess} onChange={(e) => setB({ ...b, onSuccess: e.currentTarget.checked })} /> Screenshot on success too</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox disabled={ro} checked={b.fullPage} onChange={(e) => setB({ ...b, fullPage: e.currentTarget.checked })} /> Full-page screenshots</label>
                <fieldset className="grid gap-3 border-t border-border pt-4 text-sm sm:col-span-2"><legend className="sr-only">Popups and cookie banners</legend>
                  <p aria-hidden className="text-sm font-medium">Popups and cookie banners</p>
                  <label className="flex items-center gap-2"><Checkbox disabled={ro} checked={b.popDismiss} onChange={(e) => setB({ ...b, popDismiss: e.currentTarget.checked })} /> Close popups and cookie banners before checking</label>
                  <p className="text-xs text-muted-foreground">Performance is measured on the untouched page load first. Then a covering popup is closed with your close button (below), the Escape key, a "Reject" / "Necessary only" button on cookie banners — never "Accept" — or a close button. Nothing that could accept, subscribe, sign up, buy or log in is ever clicked, and no request leaves the browser while closing. A popup that can't be closed fails the check, because it blocks your visitors too.</p>
                  <Field label="Popup close button (CSS selector)" hint="Optional, e.g. #newsletter .close — tried first. Found with document.querySelector on your page; max 200 characters." error={bs.errors["popups.closeSelector"]}>
                    <Input disabled={ro} value={b.popSelector} maxLength={200} placeholder="#newsletter .close" onChange={(e) => setB({ ...b, popSelector: e.target.value })} />
                  </Field>
                </fieldset>
                <fieldset className="grid gap-2 border-t border-border pt-4 text-sm sm:col-span-2"><legend className="sr-only">Safe functional tests</legend>
                  <p aria-hidden className="text-sm font-medium">Safe functional tests</p>
                  <label className="flex items-center gap-2"><Checkbox disabled={ro} checked={b.fnEnabled} onChange={(e) => setB({ ...b, fnEnabled: e.currentTarget.checked })} /> Interact with the page (off by default)</label>
                  <div className="flex flex-wrap gap-4 pl-6">
                    {([["fnSearch", "Search"], ["fnNav", "Navigation links"], ["fnForms", "Form validation"], ["fnButtons", "Safe buttons"]] as const).map(([k, l]) => (
                      <label key={k} className="flex items-center gap-1.5"><Checkbox disabled={ro || !b.fnEnabled} checked={b[k]} onChange={(e) => setB({ ...b, [k]: e.currentTarget.checked })} />{l}</label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Forms are never submitted and nothing is sent: purchases, checkout, account deletion, logout, password changes and any button that could change data are never clicked. Anything not clearly safe is skipped and shown as skipped.</p>
                  {b.fnEnabled && (
                    <div className="grid gap-3 rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] p-3.5 sm:col-span-2">
                      <Field label="Allowed paths (required)" hint="Comma-separated, e.g. /search, /products. Links outside these paths are not clicked; the search box and ordinary buttons are used; while testing, requests to any other part of your site are blocked unless the page already loaded them." error={bs.errors["functional.allowedPaths"]}>
                        <Input disabled={ro} value={b.fnPaths} placeholder="/search, /products" onChange={(e) => setB({ ...b, fnPaths: e.target.value })} />
                      </Field>
                      <p className="text-xs" data-testid="functional-risk">These tests run against your live website. We only make GET requests, never submit forms, skip anything that looks destructive and block risky or third-party destinations — but a page can still change data when it receives a GET request, and we cannot detect that. Enable this only where opening links and pressing ordinary buttons is harmless.</p>
                      {b.fnAcked && !b.fnAck ? <p className="text-xs text-muted-foreground">Risk acknowledged for this website.</p> : (
                        <label className="flex items-start gap-2 text-sm"><Checkbox disabled={ro} checked={Boolean(b.fnAck)} onChange={(e) => setB({ ...b, fnAck: e.currentTarget.checked })} /> I understand and accept this risk for this website</label>
                      )}
                    </div>
                  )}
                </fieldset>
                <FormFooter>{!ro && <Button type="submit" disabled={bs.busy}>{bs.busy ? "Saving…" : "Save browser settings"}</Button>}</FormFooter>
              </form>
            )}
          </Section>

          <Section title="Deep scans" icon={<ScanSearch />} actions={<PlanBadge available={ent.DEEPSCAN.available} />} description={ent.DEEPSCAN.available ? `Up to ${deep.data?.effectiveLimits.maxPages ?? "—"} pages and depth ${deep.data?.effectiveLimits.maxDepth ?? "—"} with your current settings and plan.` : `Unavailable: ${ent.DEEPSCAN.reason}.`}>
            {!ent.DEEPSCAN.available ? <Hint>Deep scans need a plan that includes them.</Hint> : (
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void ds.save(async () => {
                await put(`${base}/monitoring/schedule`, { deepScanIntervalSec: num(d.interval) == null ? null : Number(d.interval) * 3600 });
                await put(`${base}/deep-scan/config`, {
                  ...(d.maxPages ? { maxPages: Number(d.maxPages) } : {}), ...(d.maxDepth ? { maxDepth: Number(d.maxDepth) } : {}),
                  includePatterns: lines(d.include), excludePatterns: lines(d.exclude), respectRobots: d.respectRobots,
                  browserDiscovery: d.browserDiscovery && ent.DEEPSCAN.browserDiscovery, checkExternalLinks: d.checkExternalLinks && ent.DEEPSCAN.externalLinks,
                });
              }, "Deep-scan settings saved"); }}>
                <Field label="Scan frequency (hours)" hint={`Most frequent your plan allows: every ${Math.round(ent.DEEPSCAN.minIntervalSec / 3600)} h`} error={ds.errors.deepScanIntervalSec}><Input type="number" min={1} disabled={ro} value={d.interval} onChange={(e) => setD({ ...d, interval: e.target.value })} /></Field>
                <Field label="Maximum pages" hint="Capped by your plan" error={ds.errors.maxPages}><Input type="number" min={1} disabled={ro} value={d.maxPages} onChange={(e) => setD({ ...d, maxPages: e.target.value })} /></Field>
                <Field label="Maximum depth" error={ds.errors.maxDepth}><Input type="number" min={0} disabled={ro} value={d.maxDepth} onChange={(e) => setD({ ...d, maxDepth: e.target.value })} /></Field>
                <div />
                <Field label="Included paths" hint="One pattern per line, e.g. /blog/*" error={ds.errors.includePatterns}><Textarea className="min-h-20 font-mono text-xs" disabled={ro} value={d.include} onChange={(e) => setD({ ...d, include: e.target.value })} /></Field>
                <Field label="Excluded paths" hint="One pattern per line" error={ds.errors.excludePatterns}><Textarea className="min-h-20 font-mono text-xs" disabled={ro} value={d.exclude} onChange={(e) => setD({ ...d, exclude: e.target.value })} /></Field>
                <label className="flex items-center gap-2 text-sm"><Checkbox disabled={ro} checked={d.respectRobots} onChange={(e) => setD({ ...d, respectRobots: e.currentTarget.checked })} /> Respect robots.txt</label>
                <label className="flex items-center gap-2 text-sm" title={ent.DEEPSCAN.browserDiscovery ? "" : "Not included in your plan"}><Checkbox disabled={ro || !ent.DEEPSCAN.browserDiscovery} checked={d.browserDiscovery} onChange={(e) => setD({ ...d, browserDiscovery: e.currentTarget.checked })} /> Browser-assisted discovery{!ent.DEEPSCAN.browserDiscovery && <span className="text-xs text-muted-foreground">(not in your plan)</span>}</label>
                <label className="flex items-center gap-2 text-sm" title={ent.DEEPSCAN.externalLinks ? "" : "Not included in your plan"}><Checkbox disabled={ro || !ent.DEEPSCAN.externalLinks} checked={d.checkExternalLinks} onChange={(e) => setD({ ...d, checkExternalLinks: e.currentTarget.checked })} /> Check external links{!ent.DEEPSCAN.externalLinks && <span className="text-xs text-muted-foreground">(not in your plan)</span>}</label>
                <FormFooter note="Pause, resume and start scans from the Deep scan tab. Logout, delete, cart, checkout and account routes are never requested.">{!ro && <Button type="submit" disabled={ds.busy}>{ds.busy ? "Saving…" : "Save deep-scan settings"}</Button>}</FormFooter>
              </form>
            )}
          </Section>
        </div>
      )}
    </QueryState>
  );
}
