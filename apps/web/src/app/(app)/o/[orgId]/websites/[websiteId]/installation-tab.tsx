"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, ConfirmDialog, EmptyState, Input, Label, Select, toast } from "@wim/ui";
import { Activity, CheckCircle2, Code2, KeyRound, Lock, RefreshCw, ShieldCheck, Stethoscope, XCircle } from "lucide-react";
import type { DataEnvelope, InstallationDto, WebsiteDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/copy";
import { errorMessage, get, patch, post } from "@/lib/api";
import { fmt, FRAMEWORK_LABEL, FRAMEWORKS, frameworkInstructions, INSTALL_STATE, INVALID_REASON, relative, snippetParts, wk, type Framework } from "@/lib/websites";

type Config = InstallationDto["sdkConfig"];
const CHECKS: Array<[string, string]> = [
  ["pageReachable", "Home page reachable"],
  ["scriptTagFound", "Monitoring script tag found"],
  ["siteKeyMatches", "Site key matches this website"],
  ["scriptReachable", "Script URL loads"],
];

export function InstallationTab({ w, orgId, canWrite }: { w: WebsiteDetailDto; orgId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const i = w.install;
  const [fw, setFw] = useState<Framework>("html");
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cfg, setCfg] = useState<Config>(i.sdkConfig);
  const [masks, setMasks] = useState(i.sdkConfig.maskPatterns.join("\n"));
  useEffect(() => { setCfg(i.sdkConfig); setMasks(i.sdkConfig.maskPatterns.join("\n")); }, [i.sdkConfig]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) }), qc.invalidateQueries({ queryKey: wk.list(orgId) })]);

  const act = async (path: string, ok: string) => {
    setBusy(true);
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/${path}`);
      await refresh();
      toast.success(ok);
      setConfirm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      const before = i.lastCheckedAt;
      await post(`/orgs/${orgId}/websites/${w.id}/installation/check`);
      for (let n = 0; n < 20; n++) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await get<DataEnvelope<WebsiteDetailDto>>(`/orgs/${orgId}/websites/${w.id}`);
        if (d.data.install.lastCheckedAt !== before) break;
      }
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const saveConfig = async () => {
    setBusy(true);
    try {
      await patch(`/orgs/${orgId}/websites/${w.id}/sdk-config`, { ...cfg, maskPatterns: masks.split("\n").map((m) => m.trim()).filter(Boolean) });
      await refresh();
      toast.success("SDK settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (w.verification !== "VERIFIED") {
    return <Card><EmptyState icon={<ShieldCheck />} title="Verify ownership first" description="The monitoring script only reports data for verified websites. Complete verification, then come back here." /></Card>;
  }
  const state = INSTALL_STATE[i.state];
  const last = i.lastCheck as Record<string, unknown> | null;
  const parts = i.snippet && i.siteKey ? snippetParts(i.snippet, i.scriptUrl, i.siteKey) : null;
  const instr = parts && i.snippet ? frameworkInstructions(fw, parts, i.snippet) : null;
  const toggle = (k: keyof Config, label: string, hint: string) => (
    <label className="flex items-start gap-2.5 px-5 py-3 text-sm">
      <Checkbox className="mt-0.5" checked={Boolean(cfg[k])} disabled={!canWrite} onChange={(e) => setCfg({ ...cfg, [k]: (e.target as HTMLInputElement).checked })} />
      <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );

  return (
    <div className="grid gap-5">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2"><Activity className="h-4 w-4 text-muted-foreground" aria-hidden />Installation status <Badge tone={state.tone} data-testid="install-state">{state.label}</Badge></CardTitle>
          <CardDescription>Status comes only from heartbeats sent by the script running on {w.displayHost}. Downloading the script file doesn't count.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
            {([["Last heartbeat", i.lastSeenAt ? `${relative(i.lastSeenAt)}` : "Never"], ["First seen", fmt(i.firstSeenAt)], ["Page loads seen", i.pageLoads], ["SDK version", i.sdkVersion ?? "—"]] as const).map(([k, v]) => (
              <div key={k} className="min-w-0 bg-card px-3.5 py-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{v}</dd></div>
            ))}
          </dl>
          {i.lastInvalidReason && (
            <Alert tone={i.state === "INVALID_CONFIGURATION" ? "danger" : "warning"} title={`Rejected traffic ${relative(i.lastInvalidAt)}`}>
              {INVALID_REASON[i.lastInvalidReason] ?? i.lastInvalidReason}
            </Alert>
          )}
          {i.state === "INACTIVE" && <Alert tone="warning" title="No recent heartbeats">The script hasn't reported in the last 24 hours. Check that it's still on your pages and not blocked.</Alert>}
          {canWrite && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button variant="outline" className="self-start" onClick={check} loading={checking}>{!checking && <Stethoscope />}Check installation</Button>
              <p className="text-xs text-muted-foreground">Fetches your home page from our servers and looks for the snippet. This is a diagnostic: only a real heartbeat from a visitor's browser marks the script as installed.</p>
            </div>
          )}
          {last && (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm" data-testid="install-check">
              {CHECKS.filter(([k]) => k in last).map(([k, label]) => (
                <li key={k} className="flex items-center gap-2.5 px-3.5 py-2.5">{last[k] ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <XCircle className="h-4 w-4 text-danger" aria-hidden />}<span className="flex-1">{label}</span><Badge tone={last[k] ? "success" : "danger"}>{last[k] ? "Pass" : "Fail"}</Badge></li>
              ))}
              <li className="bg-sunken/50 px-3.5 py-2 text-xs text-muted-foreground">Checked {fmt(i.lastCheckedAt)}</li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Code2 className="h-4 w-4 text-muted-foreground" aria-hidden />Install the script</CardTitle>
          <CardDescription>The site key is a public identifier, not a password — it's safe in your page source and only lets browsers report telemetry for this website.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {i.revoked || !i.snippet ? (
            <Alert tone="danger" title="Site key revoked">No key is active, so the script reports nothing. Generate a new key to get a working snippet.</Alert>
          ) : (
            <>
              <CodeBlock testId="install-snippet" value={i.snippet} label="Copy snippet" />
              {i.previousKeyValidUntil && <p className="text-xs text-muted-foreground">The previous key keeps working until {fmt(i.previousKeyValidUntil)} so you can update your pages.</p>}
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="framework">Framework</Label>
                <Select id="framework" value={fw} onChange={(e) => setFw(e.target.value as Framework)}>
                  {FRAMEWORKS.map((f) => <option key={f} value={f}>{FRAMEWORK_LABEL[f]}</option>)}
                </Select>
              </div>
              {instr && (
                <div className="grid gap-2">
                  <p className="text-sm">{instr.where}</p>
                  <CodeBlock value={instr.code} />
                  {instr.note && <p className="text-xs text-muted-foreground">{instr.note}</p>}
                </div>
              )}
              <details className="rounded-lg border border-border text-sm [&[open]>summary]:border-b">
                <summary className="cursor-pointer border-border px-3.5 py-2.5 font-medium hover:bg-sunken/70">Troubleshooting</summary>
                <ul className="list-disc space-y-1 py-3 pl-8 pr-3.5 text-muted-foreground">
                  <li>Content-Security-Policy: allow <code>{new URL(i.scriptUrl).origin}</code> in <code>script-src</code> and <code>connect-src</code>.</li>
                  <li>Install the snippet on {w.displayHost} itself (www is fine). Other subdomains are separate websites.</li>
                  <li>Clear page and CDN caches after adding the snippet, then load a page in a normal browser window.</li>
                  <li>Ad and tracking blockers can block the script for some visitors; that's expected.</li>
                  <li>Visitors with Global Privacy Control enabled send nothing while "Respect GPC" is on.</li>
                </ul>
              </details>
            </>
          )}
        </CardContent>
        {canWrite && (
          <CardFooter className="flex-wrap justify-start gap-2">
            <Button variant="outline" onClick={() => setConfirm("regenerate")}><RefreshCw />{i.revoked ? "Generate new key" : "Regenerate key"}</Button>
            <Button variant="outline" loading={busy} onClick={() => act(i.telemetryPaused ? "telemetry/resume" : "telemetry/pause", i.telemetryPaused ? "Telemetry resumed" : "Telemetry paused")}>
              {i.telemetryPaused ? "Resume telemetry" : "Pause telemetry"}
            </Button>
            {!i.revoked && <Button variant="danger" className="sm:ml-auto" onClick={() => setConfirm("revoke")}><KeyRound /> Revoke key</Button>}
            {i.telemetryPaused && <Badge tone="warning" className="whitespace-normal">Telemetry paused — heartbeats still update the installation status</Badge>}
          </CardFooter>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4 text-muted-foreground" aria-hidden />Privacy and data collection</CardTitle>
          <CardDescription>The script never collects form fields or their values, passwords, payment details, cookies, local storage, request or response bodies, query strings or keystrokes. Emails, ids and long numbers in paths and messages are masked in the browser and again on our servers.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-0 p-0">
          <div className="grid divide-y divide-border border-b border-border sm:grid-cols-2 sm:divide-y-0 sm:[&>label]:border-b sm:[&>label]:border-border sm:[&>label:nth-child(odd)]:border-r">
          {toggle("captureErrors", "JavaScript errors", "Uncaught errors and unhandled promise rejections")}
          {toggle("captureResourceErrors", "Failed resources", "Images, scripts and stylesheets that fail to load (URL path only)")}
          {toggle("captureVitals", "Web Vitals", "LCP, CLS, INP, FCP, TTFB")}
          {toggle("captureApiFailures", "Failed API calls", "fetch() calls that fail or return 5xx (method, path, status — never bodies)")}
          {toggle("requireConsent", "Wait for consent", 'Send nothing until your consent banner calls window.SiteSentinel("consent", true)')}
          {toggle("respectGlobalPrivacyControl", "Respect Global Privacy Control", "Send nothing for visitors whose browser signals GPC")}
          </div>
          <div className="grid gap-4 px-5 pt-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="esr">Error sample rate ({Math.round(cfg.errorSampleRate * 100)}%)</Label>
              <Input id="esr" type="range" min={0} max={1} step={0.05} disabled={!canWrite} value={cfg.errorSampleRate} onChange={(e) => setCfg({ ...cfg, errorSampleRate: Number(e.target.value) })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vsr">Web Vitals sample rate ({Math.round(cfg.vitalsSampleRate * 100)}%)</Label>
              <Input id="vsr" type="range" min={0} max={1} step={0.05} disabled={!canWrite} value={cfg.vitalsSampleRate} onChange={(e) => setCfg({ ...cfg, vitalsSampleRate: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid gap-1.5 px-5 py-4">
            <Label htmlFor="masks">Extra path masks (one regular expression per line)</Label>
            <textarea id="masks" rows={3} disabled={!canWrite} value={masks} onChange={(e) => setMasks(e.target.value)} className="rounded-md border border-input bg-card px-3 py-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-60" placeholder={"^/orders/\\d+"} />
          </div>
        </CardContent>
        {canWrite && <CardFooter><Button onClick={saveConfig} loading={busy}>Save settings</Button></CardFooter>}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "revoke" ? "Revoke the site key?" : "Generate a new site key?"}
        description={confirm === "revoke"
          ? "Pages using this key stop reporting immediately and the installation shows as invalid until you install a new key."
          : i.revoked ? "A new key and snippet will be created." : "The current key keeps working for 24 hours so you can update your pages, then stops."}
        destructive={confirm === "revoke"}
        confirmLabel={confirm === "revoke" ? "Revoke key" : "Generate key"}
        loading={busy}
        onConfirm={() => act(confirm === "revoke" ? "site-key/revoke" : "site-key/regenerate", confirm === "revoke" ? "Site key revoked" : "New site key generated")}
      />
    </div>
  );
}
