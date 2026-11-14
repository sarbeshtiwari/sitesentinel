"use client";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, toast } from "@wim/ui";
import type { WebsiteDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HealthBadge, KeyValue, QueryState } from "@/components/monitoring";
import { fmtPct, fmtUtc, presetRange, SCAN_STATUS, useOverview } from "@/lib/monitoring";
import { Field } from "@/components/copy";
import { errorMessage, post } from "@/lib/api";
import { categoryLabel, fmt, fmtDate, INSTALL_STATE, TRIAL_OUTCOME, VERIFICATION_STATE, wk } from "@/lib/websites";

type Nav = (t: "verification" | "installation" | "availability" | "browser" | "deep-scan" | "monitoring-settings") => void;

export function OverviewTab({ w, orgId, canWrite, onNavigate }: { w: WebsiteDetailDto; orgId: string; canWrite: boolean; onNavigate: Nav }) {
  const qc = useQueryClient();
  const contest = async () => {
    try {
      await post(`/orgs/${orgId}/domain-transfers/incoming/${w.pendingTransfer!.id}/contest`);
      await qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) });
      toast.success("Transfer contested. A platform administrator will review it.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const verified = w.verification === "VERIFIED";
  return (
    <div className="grid gap-6">
      {w.pendingTransfer && (
        <Alert tone="warning" title="Another organization requested ownership of this domain">
          <p>They proved DNS control of {w.displayHost}. A platform administrator will review the request
            {w.pendingTransfer.ownerRespondBy ? `; respond before ${fmt(w.pendingTransfer.ownerRespondBy)}` : ""}. Your data is never shared.</p>
          {w.pendingTransfer.ownerResponse === "CONTESTED" ? <p className="mt-1 font-medium">You have contested this request.</p>
            : canWrite && <Button className="mt-2" size="sm" variant="outline" onClick={contest}>Contest the transfer</Button>}
        </Alert>
      )}
      {w.status === "LAPSED" && (
        <Alert tone="danger" title="Monitoring paused: ownership verification lapsed">
          <button type="button" className="underline" onClick={() => onNavigate("verification")}>Restore verification</button> to resume monitoring.
        </Alert>
      )}
      {!verified && w.status !== "LAPSED" && (
        <Alert tone="warning" title="Ownership not verified yet">
          Verify that you control {w.displayHost} to activate the website.{" "}
          <button type="button" className="underline" onClick={() => onNavigate("verification")}>Go to verification</button>
        </Alert>
      )}
      {verified && w.installation === "NOT_INSTALLED" && (
        <Alert title="Install the monitoring script">
          <button type="button" className="underline" onClick={() => onNavigate("installation")}>Get the installation snippet</button> to start collecting browser telemetry.
        </Alert>
      )}
      <Card>
        <CardHeader><CardTitle>Website</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Domain">{w.displayHost}{w.displayHost !== w.hostKey && <span className="text-muted-foreground"> ({w.hostKey})</span>}</Field>
            <Field label="Registrable domain">{w.registrableDomain}</Field>
            <Field label="Category">{categoryLabel(w.category)}</Field>
            <Field label="Verification">{VERIFICATION_STATE[w.verification]?.label ?? w.verification}{w.claim.verifiedMethod ? ` (${w.claim.verifiedMethod.replace("_", " ").toLowerCase()})` : ""}</Field>
            <Field label="Verified at">{fmt(w.verifiedAt)}</Field>
            <Field label="SDK installation">{INSTALL_STATE[w.installation].label}</Field>
            <Field label="Monitoring timezone">{w.monitoringTimezone}</Field>
            <Field label="Created">{fmtDate(w.createdAt)}</Field>
            <Field label="Description">{w.description || "—"}</Field>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Free trial</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {w.trialOutcome ? <p>{TRIAL_OUTCOME[w.trialOutcome] ?? w.trialOutcome}</p> : <p className="text-muted-foreground">The trial is evaluated when the website's ownership is first verified.</p>}
          {w.orgTrial && <p className="text-muted-foreground">Organization trial: {w.orgTrial.status.toLowerCase()}, {fmtDate(w.orgTrial.startsAt)} – {fmtDate(w.orgTrial.endsAt)} (started by {w.orgTrial.registrableDomain}).</p>}
        </CardContent>
      </Card>
      <MonitoringHealthCard orgId={orgId} websiteId={w.id} onNavigate={onNavigate} />
    </div>
  );
}

/** This website's health, from the same organisation overview endpoint (24 h, UTC). */
function MonitoringHealthCard({ orgId, websiteId, onNavigate }: { orgId: string; websiteId: string; onNavigate: Nav }) {
  const [range] = useState(() => presetRange("24h"));
  const q = useOverview(orgId, range);
  const m = q.data?.websites.find((x) => x.id === websiteId);
  return (
    <Card>
      <CardHeader><CardTitle>Monitoring (last 24 hours)</CardTitle></CardHeader>
      <CardContent>
        <QueryState q={q}>
          {m ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-2"><HealthBadge state={m.health} />{m.reasons.map((r) => <span key={r} className="text-xs text-muted-foreground">{r}</span>)}</div>
              <KeyValue items={[
                ["HTTP availability", <button key="h" type="button" className="hover:underline" onClick={() => onNavigate("availability")}><HealthBadge state={m.http.state} /></button>],
                ["Uptime", `${fmtPct(m.http.uptime.uptimePercent)} · coverage ${fmtPct(m.http.uptime.coveragePercent, 1)}`],
                ["Last successful check", fmtUtc(m.http.lastSuccessAt)], ["Last failed check", fmtUtc(m.http.lastFailureAt)],
                ["Browser monitoring", <button key="b" type="button" className="hover:underline" onClick={() => onNavigate("browser")}><HealthBadge state={m.browser.state} /></button>],
                ["Deep scan", <button key="d" type="button" className="hover:underline" onClick={() => onNavigate("deep-scan")}>{m.deepScan.lastStatus ? `${SCAN_STATUS[m.deepScan.lastStatus]?.label ?? m.deepScan.lastStatus} · ${m.deepScan.openFindings} open findings` : <HealthBadge state={m.deepScan.state} />}</button>],
                ["Last completed deep scan", fmtUtc(m.deepScan.lastCompletedAt)], ["Active incidents", m.activeIncidents],
              ]} />
              <p className="text-xs text-muted-foreground"><button type="button" className="underline" onClick={() => onNavigate("monitoring-settings")}>Monitoring settings</button></p>
            </div>
          ) : <p className="text-sm text-muted-foreground">No monitoring data for this website.</p>}
        </QueryState>
      </CardContent>
    </Card>
  );
}
