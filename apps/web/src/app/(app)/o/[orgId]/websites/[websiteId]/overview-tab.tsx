"use client";
import { Alert, Button, cn, EmptyState, toast } from "@wim/ui";
import { Activity, Gauge, Gift, Globe, MonitorSmartphone, ScanSearch, ShieldCheck, Siren, SlidersHorizontal, Code2, type LucideIcon } from "lucide-react";
import type { WebsiteDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HealthBadge, KeyValue, QueryState, Section } from "@/components/monitoring";
import { fmtPct, fmtUtc, presetRange, SCAN_STATUS, useOverview } from "@/lib/monitoring";
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
    <div className="grid gap-5">
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
          <p>Restore verification to resume monitoring.</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => onNavigate("verification")}><ShieldCheck /> Restore verification</Button>
        </Alert>
      )}
      {!verified && w.status !== "LAPSED" && (
        <Alert tone="warning" title="Ownership not verified yet">
          <p>Verify that you control {w.displayHost} to activate the website.</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => onNavigate("verification")}><ShieldCheck /> Go to verification</Button>
        </Alert>
      )}
      {verified && w.installation === "NOT_INSTALLED" && (
        <Alert title="Install the monitoring script">
          <p>Add the snippet to your pages to start collecting browser telemetry.</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => onNavigate("installation")}><Code2 /> Get the installation snippet</Button>
        </Alert>
      )}
      <MonitoringHealthCard orgId={orgId} websiteId={w.id} onNavigate={onNavigate} />
      <div className="grid gap-5 xl:grid-cols-3">
        <Section title="Website" icon={<Globe />} className="xl:col-span-2">
          <KeyValue items={[
            ["Domain", <>{w.displayHost}{w.displayHost !== w.hostKey && <span className="text-muted-foreground"> ({w.hostKey})</span>}</>],
            ["Registrable domain", w.registrableDomain],
            ["Category", categoryLabel(w.category)],
            ["Verification", <>{VERIFICATION_STATE[w.verification]?.label ?? w.verification}{w.claim.verifiedMethod ? ` (${w.claim.verifiedMethod.replace("_", " ").toLowerCase()})` : ""}</>],
            ["Verified at", fmt(w.verifiedAt)],
            ["SDK installation", INSTALL_STATE[w.installation].label],
            ["Monitoring timezone", w.monitoringTimezone],
            ["Created", fmtDate(w.createdAt)],
            ["Description", w.description || "—"],
          ]} />
        </Section>
        <Section title="Free trial" icon={<Gift />}>
          <div className="grid gap-2 text-sm">
            {w.trialOutcome ? <p>{TRIAL_OUTCOME[w.trialOutcome] ?? w.trialOutcome}</p> : <p className="text-muted-foreground">The trial is evaluated when the website's ownership is first verified.</p>}
            {w.orgTrial && <p className="text-muted-foreground">Organization trial: {w.orgTrial.status.toLowerCase()}, {fmtDate(w.orgTrial.startsAt)} – {fmtDate(w.orgTrial.endsAt)} (started by {w.orgTrial.registrableDomain}).</p>}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** One monitoring dimension in the health grid; the whole tile opens the matching tab. */
function Tile({ label, icon: Icon, onClick, children, sub }: { label: string; icon: LucideIcon; onClick?: () => void; children: React.ReactNode; sub?: React.ReactNode }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden />{label}</span>
      <span className="mt-1.5 block text-sm font-medium">{children}</span>
      {sub && <span className="mt-1 block text-xs text-muted-foreground">{sub}</span>}
    </>
  );
  const cls = "block h-full w-full min-w-0 rounded-lg border border-border bg-card px-3.5 py-3 text-left";
  return onClick
    ? <button type="button" className={cn(cls, "cursor-pointer transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-xs")} onClick={onClick}>{body}</button>
    : <div className={cls}>{body}</div>;
}

/** This website's health, from the same organisation overview endpoint (24 h, UTC). */
function MonitoringHealthCard({ orgId, websiteId, onNavigate }: { orgId: string; websiteId: string; onNavigate: Nav }) {
  const [range] = useState(() => presetRange("24h"));
  const q = useOverview(orgId, range);
  const m = q.data?.websites.find((x) => x.id === websiteId);
  return (
    <Section title="Monitoring (last 24 hours)" icon={<Activity />}
      actions={<Button size="sm" variant="ghost" onClick={() => onNavigate("monitoring-settings")}><SlidersHorizontal /> Monitoring settings</Button>}>
      <QueryState q={q} skeleton="h-40">
        {m ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><HealthBadge state={m.health} />{m.reasons.map((r) => <span key={r} className="text-xs text-muted-foreground">{r}</span>)}</div>
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              <li><Tile label="HTTP availability" icon={Globe} onClick={() => onNavigate("availability")}
                sub={<>Last success {fmtUtc(m.http.lastSuccessAt)}<br />Last failure {fmtUtc(m.http.lastFailureAt)}</>}><HealthBadge state={m.http.state} /></Tile></li>
              <li><Tile label="Uptime" icon={Gauge} onClick={() => onNavigate("availability")} sub={`Coverage ${fmtPct(m.http.uptime.coveragePercent, 1)}`}>
                <span className="text-xl font-semibold tracking-tight tabular-nums">{fmtPct(m.http.uptime.uptimePercent)}</span></Tile></li>
              <li><Tile label="Browser monitoring" icon={MonitorSmartphone} onClick={() => onNavigate("browser")} sub="Synthetic checks from our Chromium runners"><HealthBadge state={m.browser.state} /></Tile></li>
              <li><Tile label="Deep scan" icon={ScanSearch} onClick={() => onNavigate("deep-scan")} sub={`Last completed ${fmtUtc(m.deepScan.lastCompletedAt)}`}>
                {m.deepScan.lastStatus ? `${SCAN_STATUS[m.deepScan.lastStatus]?.label ?? m.deepScan.lastStatus} · ${m.deepScan.openFindings} open findings` : <HealthBadge state={m.deepScan.state} />}</Tile></li>
            </ul>
            <p className="flex items-center gap-1.5 text-sm"><Siren className={cn("h-4 w-4", m.activeIncidents ? "text-danger" : "text-muted-foreground")} aria-hidden />
              <span className="text-muted-foreground">Active incidents:</span><span className={cn("font-medium tabular-nums", m.activeIncidents > 0 && "text-danger")}>{m.activeIncidents}</span></p>
          </div>
        ) : <EmptyState icon={<Activity />} title="No monitoring data for this website." description="Results appear here once ownership is verified and the first checks have run." />}
      </QueryState>
    </Section>
  );
}
