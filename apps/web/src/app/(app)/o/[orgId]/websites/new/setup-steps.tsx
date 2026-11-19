"use client";
/**
 * Steps 2–4 of the Add website wizard for a website that already exists (created in step 1). Same API calls as the
 * website's Settings → Ownership / Monitoring script / Alerts sections; nothing here is simulated.
 */
import { Alert, Badge, Button, buttonVariants, Card, cn, ConfirmDialog, Label, Select, StatusPill, Stepper, toast } from "@wim/ui";
import type { DataEnvelope, VerificationAttemptDto, WebsiteDetailDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Code2, FileText, Globe, RefreshCw, Server, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CodeBlock } from "@/components/copy";
import { errorMessage, get, post } from "@/lib/api";
import { useNotificationPrefs } from "@/lib/monitoring";
import { failureText, fmt, FRAMEWORK_LABEL, FRAMEWORKS, frameworkInstructions, INSTALL_STATE, relative, snippetParts, wk, type Framework } from "@/lib/websites";
import { tabHref } from "../[websiteId]/website-data";

type Method = "DNS_TXT" | "WELL_KNOWN_FILE" | "HTML_META" | "ANY";

function MethodCard({ id, icon: Icon, title, text, selected, onSelect, children }: {
  id: Method; icon: LucideIcon; title: string; text: React.ReactNode; selected: boolean; onSelect: (m: Method) => void; children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border bg-card transition-colors", selected ? "border-ink ring-1 ring-ink" : "border-border hover:border-border-strong")}>
      <label className="flex cursor-pointer items-start gap-3 px-4 py-3.5">
        <input type="radio" name="verify-method" value={id} checked={selected} onChange={() => onSelect(id)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--ink)]" />
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-[13px] text-muted-foreground">{text}</span>
        </span>
      </label>
      <div hidden={!selected} className="grid min-w-0 gap-2 px-4 pb-4 [&>*]:min-w-0">{children}</div>
    </div>
  );
}

function VerifyStep({ w, orgId, onVerified }: { w: WebsiteDetailDto; orgId: string; onVerified: () => void }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>("DNS_TXT");
  const [checking, setChecking] = useState(false);
  const [confirmToken, setConfirmToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const history = useQuery({
    queryKey: wk.verifications(orgId, w.id),
    queryFn: () => get<DataEnvelope<VerificationAttemptDto[]>>(`/orgs/${orgId}/websites/${w.id}/verifications`).then((r) => r.data),
  });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) }),
    qc.invalidateQueries({ queryKey: wk.verifications(orgId, w.id) }),
    qc.invalidateQueries({ queryKey: wk.list(orgId) }),
  ]);
  // Same flow as Settings → Ownership: start the check, then poll for a new history row or a status change (≤ 60 s).
  const verify = async () => {
    setChecking(true);
    setLastError(null);
    try {
      const before = history.data?.[0]?.id;
      await post(`/orgs/${orgId}/websites/${w.id}/verify`, { method });
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const [d, h] = await Promise.all([
          get<DataEnvelope<WebsiteDetailDto>>(`/orgs/${orgId}/websites/${w.id}`),
          get<DataEnvelope<VerificationAttemptDto[]>>(`/orgs/${orgId}/websites/${w.id}/verifications`),
        ]);
        if (d.data.verification === "VERIFIED") { toast.success("Ownership verified"); await refresh(); onVerified(); return; }
        if (h.data[0] && h.data[0].id !== before) { const m = failureText(h.data[0].failureReason) || "Verification failed"; setLastError(m); toast.error(m); break; }
      }
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  const action = async (path: string, ok: string) => {
    setBusy(true);
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/${path}`);
      await refresh();
      toast.success(ok);
      setConfirmToken(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const ins = w.instructions;

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div>
        <h1 className="break-words text-[24px] font-medium leading-tight tracking-[-0.02em] sm:text-[28px]">Prove you own {w.displayHost}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pick the easiest way. We only monitor websites you control.</p>
      </div>
      {w.claim.status === "EXPIRED" && (
        <Alert tone="danger" title="The verification window expired">
          <p>Unverified claims are released after 72 hours. If nobody else has registered the domain since, you can start again with a new token.</p>
          <Button className="mt-2" size="sm" loading={busy} onClick={() => action("verification/restart", "Verification restarted")}>Restart verification</Button>
        </Alert>
      )}
      {lastError && <Alert tone="danger" title="Not verified yet">{lastError}</Alert>}
      {ins ? (
        <fieldset className="grid min-w-0 gap-2.5 [&>*]:min-w-0">
          <legend className="sr-only">Verification method</legend>
          <MethodCard id="DNS_TXT" icon={Server} title="Add a DNS record" selected={method === "DNS_TXT"} onSelect={setMethod}
            text={<>Add a TXT record at your domain provider (Cloudflare, GoDaddy…). <Badge tone="success" className="ml-1 align-middle">Recommended</Badge></>}>
            <p className="text-xs text-muted-foreground">Some providers want only the part before your domain as the name.</p>
            <dl className="grid min-w-0 gap-2 [&>*]:min-w-0">
              <div><dt className="mb-1 text-xs text-muted-foreground">Name</dt><dd><CodeBlock testId="dns-record-name" value={ins.dns.hostRecord.name} label="Copy name" /></dd></div>
              <div><dt className="mb-1 text-xs text-muted-foreground">Value</dt><dd><CodeBlock testId="dns-record-value" value={ins.dns.hostRecord.value} label="Copy value" /></dd></div>
            </dl>
            {w.hostKey !== w.registrableDomain
              ? <p className="text-xs text-muted-foreground">Publishing it at <code>{ins.dns.rootRecord.name}</code> instead also works.</p>
              : <p className="text-xs text-muted-foreground">DNS verification of the registrable domain also reserves its subdomains for your organization.</p>}
          </MethodCard>
          <MethodCard id="HTML_META" icon={Code2} title="Add a meta tag" selected={method === "HTML_META"} onSelect={setMethod}
            text={<>Paste one tag into your home page <code>&lt;head&gt;</code>. Best if you edit the site&apos;s code.</>}>
            <CodeBlock value={ins.meta.tag} label="Copy tag" />
          </MethodCard>
          <MethodCard id="WELL_KNOWN_FILE" icon={FileText} title="Upload a file" selected={method === "WELL_KNOWN_FILE"} onSelect={setMethod}
            text="Serve a plain-text file at this exact URL (HTTP 200) containing the value on its own line.">
            <CodeBlock value={ins.file.url} label="Copy URL" />
            <CodeBlock value={ins.file.content} label="Copy content" />
          </MethodCard>
          <label className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={method === "ANY"} onChange={(e) => setMethod(e.currentTarget.checked ? "ANY" : "DNS_TXT")} className="h-4 w-4 accent-[var(--ink)]" />
            Check all three methods
          </label>
        </fieldset>
      ) : w.claim.status !== "EXPIRED" && <Alert tone="warning" title="No verification token">Open the website&apos;s ownership settings to continue.</Alert>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {w.claim.status === "PENDING" && <>The window closes {relative(w.claim.pendingExpiresAt)} ({fmt(w.claim.pendingExpiresAt)}) · checks used {w.claim.attemptsUsed} of {w.claim.attemptsAllowed} · you can come back later.</>}
        </p>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Link href={`/o/${orgId}/websites/${w.id}`} className={buttonVariants({ variant: "outline" })}>Finish later</Link>
          {w.claim.status === "PENDING" && <Button variant="outline" onClick={() => setConfirmToken(true)}><RefreshCw /> New token</Button>}
          {ins && <Button onClick={verify} loading={checking}>{!checking && <ShieldCheck />}{checking ? "Checking…" : "Verify now"}</Button>}
        </div>
      </div>
      <ConfirmDialog
        open={confirmToken}
        onOpenChange={setConfirmToken}
        title="Generate a new verification token?"
        description="The current token stops working immediately; update any record or file you already published. The verification window is not extended."
        confirmLabel="Generate new token"
        loading={busy}
        onConfirm={() => action("verification/token", "New token generated")}
      />
    </div>
  );
}

function InstallStep({ w, orgId, onBack, onNext }: { w: WebsiteDetailDto; orgId: string; onBack?: () => void; onNext: () => void }) {
  const [fw, setFw] = useState<Framework>("html");
  const i = w.install;
  const state = INSTALL_STATE[i.state];
  const parts = i.snippet && i.siteKey ? snippetParts(i.snippet, i.scriptUrl, i.siteKey) : null;
  const instr = parts && i.snippet ? frameworkInstructions(fw, parts, i.snippet) : null;
  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div>
        <h1 className="flex flex-wrap items-center gap-3 break-words text-[24px] font-medium leading-tight tracking-[-0.02em] sm:text-[28px]">Install the monitoring script {w.verification === "VERIFIED" && <StatusPill tone="success">Verified</StatusPill>}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Optional for uptime checks — the script adds real-visitor errors and speed from {w.displayHost}.</p>
      </div>
      {w.claim.status === "VERIFIED" && <Alert tone="success" title={`Verified ${relative(w.claim.verifiedAt)}`}>{w.claim.inherited ? `Verified through your organization's DNS verification of ${w.registrableDomain}.` : "Monitoring starts automatically."}</Alert>}
      <Card className="grid min-w-0 gap-4 px-5 py-4 [&>*]:min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm">Status <Badge tone={state.tone} data-testid="install-state">{state.label}</Badge><span className="text-xs text-muted-foreground">from heartbeats sent by the script on your pages</span></p>
        {i.revoked || !i.snippet ? (
          <Alert tone="danger" title="Site key revoked">No key is active. Generate a new key under the website&apos;s monitoring script settings.</Alert>
        ) : (
          <>
            <CodeBlock testId="install-snippet" value={i.snippet} label="Copy snippet" />
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="framework">Framework</Label>
              <Select id="framework" value={fw} onChange={(e) => setFw(e.target.value as Framework)}>
                {FRAMEWORKS.map((f) => <option key={f} value={f}>{FRAMEWORK_LABEL[f]}</option>)}
              </Select>
            </div>
            {instr && (
              <div className="grid min-w-0 gap-2 [&>*]:min-w-0">
                <p className="text-sm">{instr.where}</p>
                <CodeBlock value={instr.code} />
                {instr.note && <p className="text-xs text-muted-foreground">{instr.note}</p>}
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">Installation checks, key rotation and privacy options: <Link className="text-primary hover:underline" href={tabHref(orgId, w.id, "settings", "script")}>monitoring script settings</Link>.</p>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        {onBack && <Button variant="outline" onClick={onBack}>Back</Button>}
        <Button variant="outline" onClick={onNext}>Skip for now</Button>
        <Button onClick={onNext}>Next <ArrowRight /></Button>
      </div>
    </div>
  );
}

const SEV: Record<string, string> = { CRITICAL: "critical only", HIGH: "high and above", MEDIUM: "medium and above", LOW: "low and above", INFO: "everything" };

function AlertsStep({ w, orgId, onBack }: { w: WebsiteDetailDto; orgId: string; onBack: () => void }) {
  const q = useNotificationPrefs(orgId);
  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div>
        <h1 className="break-words text-[24px] font-medium leading-tight tracking-[-0.02em] sm:text-[28px]">Where should alerts go?</h1>
        <p className="mt-1 text-sm text-muted-foreground">Alerts are set per person. These are your current preferences for {w.displayHost}.</p>
      </div>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {(q.data ?? []).map((p) => {
            const included = !p.websiteIds.length || p.websiteIds.includes(w.id);
            return (
              <li key={p.channel} className="flex flex-col gap-1.5 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{p.channel === "EMAIL" ? "Email" : "In the app"}</p>
                  <p className="text-xs text-muted-foreground">{p.enabled ? `Severity: ${SEV[p.minSeverity] ?? p.minSeverity}` : "Turned off"}{p.isDefault ? " · default" : ""}</p>
                </div>
                <StatusPill tone={p.enabled && included ? "success" : "neutral"}>{!p.enabled ? "Off" : included ? "This website included" : "This website excluded"}</StatusPill>
              </li>
            );
          })}
          {q.isLoading && <li className="px-5 py-3.5 text-sm text-muted-foreground">Loading your preferences…</li>}
          {q.data && !q.data.length && <li className="px-5 py-3.5 text-sm text-muted-foreground">No preferences saved yet — the defaults apply.</li>}
        </ul>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Link href={`/o/${orgId}/notifications/preferences`} className={buttonVariants({ variant: "outline" })}>Change preferences</Link>
        <Link href={`/o/${orgId}/websites/${w.id}`} className={buttonVariants()}><Globe /> Go to website</Link>
      </div>
    </div>
  );
}

export const WIZARD_STEPS = ["Address", "Verify ownership", "Install script", "Alerts"];
export type SetupStep = "verify" | "install" | "alerts";

/** Breadcrumb + stepper shared by step 1 (the form) and steps 2–4. */
export function WizardHeader({ orgId, current }: { orgId: string; current: number }) {
  return (
    <div className="mb-6 grid gap-4">
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1 text-sm text-muted-foreground">
          <li><Link href={`/o/${orgId}/websites`} className="rounded px-0.5 hover:text-foreground">Websites</Link></li>
          <li aria-hidden><ChevronRight className="h-3.5 w-3.5 text-faint" /></li>
          <li aria-current="page" className="font-medium text-foreground">Add website</li>
        </ol>
      </nav>
      <Stepper steps={WIZARD_STEPS} current={current} />
    </div>
  );
}

/** Steps 2–4 for a website created in step 1 (`?setup=verify|install|alerts` on the website URL). */
export function SetupWizard({ w, orgId, step, onStep }: { w: WebsiteDetailDto; orgId: string; step: SetupStep; onStep: (s: SetupStep) => void }) {
  const verified = w.verification === "VERIFIED";
  const s: SetupStep = !verified && step !== "verify" ? "verify" : verified && step === "verify" ? "install" : step;
  return (
    <div className="min-w-0 max-w-3xl">
      <WizardHeader orgId={orgId} current={s === "verify" ? 1 : s === "install" ? 2 : 3} />
      {s === "verify" && <VerifyStep w={w} orgId={orgId} onVerified={() => onStep("install")} />}
      {s === "install" && <InstallStep w={w} orgId={orgId} onNext={() => onStep("alerts")} />}
      {s === "alerts" && <AlertsStep w={w} orgId={orgId} onBack={() => onStep("install")} />}
    </div>
  );
}
