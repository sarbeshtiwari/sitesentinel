"use client";
import {
  Alert, Badge, Button, Card, cn, ConfirmDialog, EmptyState, PageHeader, Select, Table, Tabs, TBody, TD, TH, THead, TR, toast, type BadgeTone,
} from "@wim/ui";
import { CreditCard, Globe, MonitorSmartphone, Receipt, ScanSearch, Sparkles } from "lucide-react";
import type {
  BillingOverviewDto, BillingSubscriptionDto, DataEnvelope, InvoiceDto, PlanDto, PlanPriceDto,
} from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { QueryState, Section } from "@/components/monitoring";
import { errorMessage, get, post } from "@/lib/api";
import { useOrg } from "@/lib/hooks";

type Interval = "MONTH" | "YEAR";

const billingKeys = {
  overview: (orgId: string) => ["org", orgId, "billing"] as const,
  plans: (orgId: string) => ["org", orgId, "billing", "plans"] as const,
  invoices: (orgId: string) => ["org", orgId, "billing", "invoices"] as const,
};

function formatMoney(amountMinor: number, currency: string): string {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: digits }).format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

const STATUS: Record<BillingSubscriptionDto["status"], { label: string; tone: BadgeTone }> = {
  TRIALING: { label: "Trial", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  PAST_DUE: { label: "Payment overdue", tone: "danger" },
  CANCELING: { label: "Cancels at period end", tone: "warning" },
  CANCELED: { label: "Canceled", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};
const SOURCE_LABEL: Record<BillingOverviewDto["entitlement"]["source"], string> = {
  SUBSCRIPTION: "your subscription", TRIAL: "your free trial", FREE: "the free plan", PLATFORM_DEFAULTS: "platform default limits",
};
const INVOICE_TONE: Record<string, BadgeTone> = { PAID: "success", OPEN: "warning", UNCOLLECTIBLE: "danger", VOID: "neutral", DRAFT: "neutral" };

function Meter({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="mt-3" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={`${used} of ${cap}`}>
      <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function LimitTile({ label, icon, used, cap, enabled = true }: { label: string; icon: React.ReactNode; used: number; cap: number; enabled?: boolean }) {
  return (
    <Card className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <span aria-hidden className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md [&_svg]:h-4 [&_svg]:w-4", enabled ? "bg-primary-soft text-primary" : "bg-muted text-subtle-foreground")}>{icon}</span>
      </div>
      {enabled ? <>
        <p className="mt-1 text-[22px] font-semibold leading-none tracking-tight tabular-nums">{used}<span className="text-base font-medium text-muted-foreground"> / {cap}</span></p>
        <Meter used={used} cap={cap} />
      </> : <>
        <p className="mt-1 text-[22px] font-semibold leading-none tracking-tight text-subtle-foreground">—</p>
        <p className="mt-3 text-xs text-muted-foreground">Not included</p>
      </>}
    </Card>
  );
}

/** Short, human summary of the entitlements that matter to customers. */
function planHighlights(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  const n = (k: string) => (typeof e[k] === "number" ? (e[k] as number) : null);
  const b = (k: string) => (typeof e[k] === "boolean" ? (e[k] as boolean) : null);
  if (n("monitoring.maxWebsites") !== null) out.push(`${n("monitoring.maxWebsites")} website${n("monitoring.maxWebsites") === 1 ? "" : "s"}`);
  const http = n("monitoring.http.minIntervalSec");
  if (http !== null) out.push(`Uptime checks every ${http >= 60 ? `${Math.round(http / 60)} min` : `${http} s`}`);
  if (b("monitoring.browser.entitled")) out.push(`Browser monitoring${n("monitoring.browser.maxWebsites") !== null ? ` (${n("monitoring.browser.maxWebsites")} sites)` : ""}`);
  if (b("monitoring.deepscan.entitled")) out.push(`Deep scans${n("monitoring.deepscan.maxPages") !== null ? ` (up to ${n("monitoring.deepscan.maxPages")} pages)` : ""}`);
  return out;
}

export default function BillingPage() {
  const { data: org, orgId, can } = useOrg();
  const qc = useQueryClient();
  const canRead = can("billing:read");
  const canManage = can("billing:manage");
  const overview = useQuery({
    queryKey: billingKeys.overview(orgId),
    queryFn: () => get<DataEnvelope<BillingOverviewDto>>(`/orgs/${orgId}/billing`).then((r) => r.data),
    enabled: Boolean(orgId && org && canRead),
  });
  const plans = useQuery({
    queryKey: billingKeys.plans(orgId),
    queryFn: () => get<DataEnvelope<PlanDto[]>>(`/orgs/${orgId}/billing/plans`).then((r) => r.data),
    enabled: Boolean(orgId && org && canRead),
  });
  const invoices = useQuery({
    queryKey: billingKeys.invoices(orgId),
    queryFn: () => get<DataEnvelope<InvoiceDto[]>>(`/orgs/${orgId}/billing/invoices`).then((r) => r.data),
    enabled: Boolean(orgId && org && canRead),
  });

  const d = overview.data;
  const sub = d?.subscription ?? null;
  const [interval, setInterval] = useState<Interval>("MONTH");
  const [currency, setCurrency] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | { planKey: string; planName: string } | null>(null);

  useEffect(() => {
    if (!d) return;
    if (sub?.interval) setInterval(sub.interval);
    else if (!d.intervals.includes("MONTH") && d.intervals[0]) setInterval(d.intervals[0]);
    const currencies = d.checkoutCurrencies.map((c) => c.currency);
    setCurrency((cur) => (cur && currencies.includes(cur) ? cur : sub?.currency && currencies.includes(sub.currency) ? sub.currency
      : org?.currency && currencies.includes(org.currency) ? org.currency : currencies[0] ?? sub?.currency ?? org?.currency ?? "INR"));
  }, [d, sub, org?.currency]);

  const gatewayFor = useMemo(() => new Map(d?.checkoutCurrencies.map((c) => [c.currency, c.gateway]) ?? []), [d]);

  if (!org) return null;
  if (!canRead) {
    return <>
      <PageHeader title="Billing" description="Plan, payment and invoices." />
      <Alert tone="warning" title="You don't have access to billing">Ask an organization owner for the billing permission.</Alert>
    </>;
  }

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: billingKeys.overview(orgId) }),
    qc.invalidateQueries({ queryKey: billingKeys.invoices(orgId) }),
  ]);

  // An existing gateway subscription is changed in place (proration by the gateway); otherwise a new checkout starts.
  const hasGatewaySub = Boolean(sub && sub.gateway && (sub.status === "ACTIVE" || sub.status === "PAST_DUE" || sub.status === "CANCELING"));
  const purchasable = Boolean(d?.billingEnabled && d.gatewaysAvailable.length > 0);
  const gateway = hasGatewaySub ? sub!.gateway! : gatewayFor.get(currency) ?? null;
  const effectiveCurrency = hasGatewaySub && sub!.currency ? sub!.currency : currency;

  const priceFor = (p: PlanDto): PlanPriceDto | undefined =>
    p.prices.filter((x) => x.active && x.interval === interval && x.currency === effectiveCurrency).sort((a, b) => b.version - a.version)[0];
  const linked = (price: PlanPriceDto | undefined) => Boolean(price && gateway && (gateway === "STRIPE" ? price.stripeLinked : price.razorpayLinked));

  const choose = async (p: PlanDto) => {
    if (hasGatewaySub) { setConfirm({ planKey: p.key, planName: p.name }); return; }
    setBusy(p.key);
    try {
      const r = await post<DataEnvelope<{ url: string }>>(`/orgs/${orgId}/billing/checkout`, { planKey: p.key, interval, currency });
      if (!/^https:\/\//.test(r.data.url)) throw new Error("The payment page address was rejected");
      window.location.assign(r.data.url);
    } catch (e) {
      toast.error(e instanceof Error && !("status" in e) ? e.message : errorMessage(e));
      setBusy(null);
    }
  };
  const act = async (path: "cancel" | "resume" | "change-plan", body: object = {}, done = "") => {
    setBusy(path);
    try {
      await post<DataEnvelope<BillingSubscriptionDto>>(`/orgs/${orgId}/billing/${path}`, body);
      await refresh();
      if (done) toast.success(done);
      setConfirm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const example = (plans.data ?? []).some((p) => /example/i.test(p.description));

  return (
    <>
      <PageHeader title="Billing" description="Your plan, usage against its limits, and invoices." />
      <QueryState q={overview} skeleton="h-96">
        {d && (
          <div className="grid gap-5">
            {!d.billingEnabled && (
              <Alert tone="info" title="Billing is not enabled on this platform yet">
                Paid plans can't be purchased right now. Your current access and limits are shown below; nothing will be charged.
              </Alert>
            )}
            {d.billingEnabled && d.gatewaysAvailable.length === 0 && (
              <Alert tone="warning" title="Payments are not available yet">
                No payment provider is configured, so plans can't be purchased at the moment. Please try again later or contact support.
              </Alert>
            )}
            {sub?.status === "PAST_DUE" && (
              <Alert tone="danger" title="Your last payment failed">
                Update your payment method with the payment provider{sub.graceEndsAt ? ` before ${fmtDate(sub.graceEndsAt)}` : ""} to keep monitoring running.
              </Alert>
            )}
            {sub?.status === "CANCELING" && (
              <Alert tone="warning" title="Your subscription is set to cancel">
                You keep your plan until {fmtDate(sub.currentPeriodEnd)}.{sub.gateway === "RAZORPAY" ? "" : " Resume to keep it renewing."}
              </Alert>
            )}
            {!d.entitlement.entitled && (
              <Alert tone="warning" title="Monitoring is paused for this organization">
                {d.trial && d.trial.status !== "ACTIVE" ? "Your free trial has ended." : "There is no active plan or trial."} {purchasable ? "Choose a plan below to resume monitoring." : ""}
              </Alert>
            )}

            <Section title="Current plan" icon={<CreditCard />}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Plan</p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-base font-semibold">
                    {sub?.planName ?? d.entitlement.planKey ?? (d.trial?.status === "ACTIVE" ? "Free trial" : "No plan")}
                    {sub && <Badge tone={STATUS[sub.status].tone}>{STATUS[sub.status].label}</Badge>}
                    {!sub && d.trial?.status === "ACTIVE" && <Badge tone="info">Trial</Badge>}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{sub ? "Price" : "Trial"}</p>
                  <p className="mt-1 text-sm tabular-nums">
                    {sub && sub.amountMinor !== null && sub.currency ? `${formatMoney(sub.amountMinor, sub.currency)} / ${sub.interval === "YEAR" ? "year" : "month"}`
                      : d.trial ? (d.trial.status === "ACTIVE" ? `${d.trial.daysLeft} day${d.trial.daysLeft === 1 ? "" : "s"} left (ends ${fmtDate(d.trial.endsAt)})` : `Ended ${fmtDate(d.trial.endsAt)}`) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{sub?.status === "CANCELING" ? "Access until" : "Renews"}</p>
                  <p className="mt-1 text-sm">{sub ? fmtDate(sub.currentPeriodEnd) : "—"}</p>
                  {sub?.pendingPlanKey && <p className="mt-1 text-xs text-muted-foreground">Changes to {sub.pendingPlanKey} at renewal</p>}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Limits come from</p>
                  <p className="mt-1 text-sm">{SOURCE_LABEL[d.entitlement.source]}</p>
                </div>
              </div>
              {canManage && sub && sub.gateway && d.billingEnabled && (sub.status === "ACTIVE" || sub.status === "PAST_DUE" || sub.status === "CANCELING") && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                  {sub.status === "CANCELING"
                    ? sub.gateway === "RAZORPAY"
                      // Razorpay cannot undo a cancel-at-cycle-end: say so instead of offering a button that would fail
                      ? <p className="text-sm text-muted-foreground">This payment provider can&apos;t undo a cancellation. Subscribe again after {fmtDate(sub.currentPeriodEnd)}.</p>
                      : <Button variant="outline" loading={busy === "resume"} onClick={() => act("resume", {}, "Subscription resumed")}>Resume subscription</Button>
                    : <Button variant="outline" onClick={() => setConfirm("cancel")}>Cancel subscription</Button>}
                </div>
              )}
            </Section>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <LimitTile label="Websites" icon={<Globe />} used={d.usage.websites} cap={d.limits.maxWebsites} />
              <LimitTile label="Browser-monitored" icon={<MonitorSmartphone />} used={d.usage.browserWebsites} cap={d.limits.browser.maxWebsites} enabled={d.limits.browser.enabled && d.limits.browser.entitled} />
              <LimitTile label="Deep-scanned" icon={<ScanSearch />} used={d.usage.deepscanWebsites} cap={d.limits.deepscan.maxWebsites} enabled={d.limits.deepscan.enabled && d.limits.deepscan.entitled} />
            </div>

            <Section
              title="Plans"
              icon={<Sparkles />}
              description={d.taxMode === "NONE" ? "Prices exclude tax." : d.taxMode === "GST" ? "GST is added at checkout where applicable." : "Applicable taxes are calculated at checkout."}
              actions={<>
                {d.intervals.length > 1 && (
                  <Tabs label="Billing interval" value={interval} onChange={setInterval} items={d.intervals.map((i) => ({ value: i, label: i === "MONTH" ? "Monthly" : "Annual" }))} />
                )}
                {!hasGatewaySub && d.checkoutCurrencies.length > 1 && (
                  <Select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-28">
                    {d.checkoutCurrencies.map((c) => <option key={c.currency} value={c.currency}>{c.currency}</option>)}
                  </Select>
                )}
              </>}
            >
              {example && <p className="mb-3 text-xs text-muted-foreground">Example prices: final pricing has not been published yet.</p>}
              <QueryState q={plans} skeleton="h-48">
                {plans.data && plans.data.length === 0 && <EmptyState title="No plans are available" description="Plans haven't been published yet." />}
                {plans.data && plans.data.length > 0 && (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {plans.data.map((p) => {
                      const price = priceFor(p);
                      const current = sub && sub.planKey === p.key && (!sub.interval || sub.interval === interval) && sub.status !== "CANCELED" && sub.status !== "EXPIRED";
                      const ok = purchasable && linked(price);
                      let why: string | null = null;
                      if (!d.billingEnabled) why = null; // covered by the page notice
                      else if (!purchasable) why = null;
                      else if (!price) why = `Not offered ${interval === "YEAR" ? "annually" : "monthly"} in ${effectiveCurrency}`;
                      else if (!gateway) why = `Payments in ${effectiveCurrency} aren't available`;
                      else if (!linked(price)) why = "Not yet available for purchase";
                      return (
                        <Card key={p.id} className={cn("flex flex-col px-4 py-4", current && "ring-2 ring-primary")}>
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-[15px] font-semibold">{p.name}</h3>
                            {current && <Badge tone="brand">Current</Badge>}
                          </div>
                          {p.description && <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>}
                          <p className="mt-3 text-2xl font-semibold tabular-nums">
                            {price ? <>{formatMoney(price.amountMinor, price.currency)}<span className="text-sm font-normal text-muted-foreground"> / {interval === "YEAR" ? "year" : "month"}</span></> : <span className="text-base text-muted-foreground">—</span>}
                          </p>
                          <ul className="mt-3 grid gap-1 text-sm text-muted-foreground">
                            {planHighlights(p.entitlements).map((h) => <li key={h}>· {h}</li>)}
                          </ul>
                          <div className="mt-auto pt-4">
                            {canManage && ok && !current && (
                              <Button className="w-full" loading={busy === p.key} disabled={busy !== null} onClick={() => choose(p)}>
                                {hasGatewaySub ? "Switch to this plan" : "Choose plan"}
                              </Button>
                            )}
                            {canManage && !ok && why && <p className="text-xs text-muted-foreground">{why}</p>}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </QueryState>
              {!canManage && purchasable && <p className="mt-3 text-xs text-muted-foreground">Only organization owners can change the plan.</p>}
            </Section>

            <Section title="Invoices" icon={<Receipt />} flush>
              <QueryState q={invoices} skeleton="h-24">
                {invoices.data && invoices.data.length === 0 && <EmptyState title="No invoices yet" description="Invoices appear here after your first payment." className="py-8" />}
                {invoices.data && invoices.data.length > 0 && (
                  <Table>
                    <THead><TR><TH>Number</TH><TH>Issued</TH><TH>Period</TH><TH>Status</TH><TH className="text-right">Tax</TH><TH className="text-right">Total</TH></TR></THead>
                    <TBody>
                      {invoices.data.map((i) => (
                        <TR key={i.id}>
                          <TD className="font-mono text-xs">{i.number}</TD>
                          <TD>{fmtDate(i.issuedAt)}</TD>
                          <TD className="text-xs text-muted-foreground">{i.periodStart ? `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` : "—"}</TD>
                          <TD><Badge tone={INVOICE_TONE[i.status] ?? "neutral"}>{i.status.toLowerCase()}</Badge></TD>
                          <TD className="text-right tabular-nums">{formatMoney(i.taxMinor, i.currency)}</TD>
                          <TD className="text-right font-medium tabular-nums">{formatMoney(i.totalMinor, i.currency)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </QueryState>
            </Section>
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "cancel" ? "Cancel subscription?" : confirm ? `Switch to ${confirm.planName}?` : ""}
        description={confirm === "cancel"
          ? `Your plan stays active until ${fmtDate(sub?.currentPeriodEnd)}. After that, monitoring stops unless you resume.`
          : `Your subscription changes to ${interval === "YEAR" ? "annual" : "monthly"} billing on this plan. Any proration is calculated by the payment provider.`}
        destructive={confirm === "cancel"}
        confirmLabel={confirm === "cancel" ? "Cancel at period end" : "Switch plan"}
        loading={busy === "cancel" || busy === "change-plan"}
        onConfirm={() => confirm === "cancel" ? act("cancel", {}, "Subscription will cancel at period end")
          : confirm && act("change-plan", { planKey: confirm.planKey, interval }, "Plan changed")}
      />
    </>
  );
}
