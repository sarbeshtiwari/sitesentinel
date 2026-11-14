import { applyBillingFact, TERMINAL_STATUSES, type BillingFact, type SubStatus, type SubscriptionState } from "@wim/core";
import type { Tx } from "@wim/db";
import type { GatewayKind, NormalizedEvent, NormalizedInvoice } from "./types.js";

export interface ProcessPolicy {
  graceDays: number;
  taxMode: "NONE" | "GATEWAY" | "GST";
  gstRatePct: number;
}

/** Retryable: the event refers to something we haven't seen yet (e.g. an invoice before its subscription). */
export class BillingRetryLater extends Error {
  constructor(message: string) { super(message); this.name = "BillingRetryLater"; }
}
/** Not retryable without operator action (recorded as FAILED with this message; never contains secrets or card data). */
export class BillingConflict extends Error {
  constructor(message: string) { super(message); this.name = "BillingConflict"; }
}

export interface ProcessResult { status: "PROCESSED" | "IGNORED"; note: string; subscriptionId?: string; transition?: string }

const priceColumn = (g: GatewayKind) => (g === "STRIPE" ? "stripePriceId" : "razorpayPlanId");

async function priceByRef(tx: Tx, gateway: GatewayKind, ref: string | null | undefined) {
  if (!ref) return null;
  return tx.planPrice.findFirst({ where: { [priceColumn(gateway)]: ref }, select: { id: true, planId: true } });
}

function toState(row: {
  status: string; planId: string; planPriceId: string | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean;
  canceledAt: Date | null; graceEndsAt: Date | null; pendingPlanPriceId: string | null; gatewayUpdatedAt: Date | null;
}): SubscriptionState {
  return {
    status: row.status as SubStatus, planId: row.planId, planPriceId: row.planPriceId, currentPeriodStart: row.currentPeriodStart, currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd, canceledAt: row.canceledAt, graceEndsAt: row.graceEndsAt, pendingPlanPriceId: row.pendingPlanPriceId, gatewayUpdatedAt: row.gatewayUpdatedAt,
  };
}

/**
 * Apply one verified, normalised gateway event to ONE organisation's billing rows. Must run inside the caller's
 * transaction with the organisation's RLS context (withTenant) — or system context in the reconciliation job — so
 * the event ledger row, the subscription change, payments and invoices commit or roll back together.
 */
export async function applyEventToOrg(tx: Tx, orgId: string, ev: NormalizedEvent, policy: ProcessPolicy): Promise<ProcessResult> {
  // serialise all billing work for this organisation (concurrent deliveries of related events)
  const org = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
  if (!org.length) return { status: "IGNORED", note: "organisation not found" };
  if (ev.ignored) return { status: "IGNORED", note: `event type ${ev.type} not used` };

  if (ev.customerId) {
    const existing = await tx.gatewayCustomer.findUnique({ where: { orgId_gateway: { orgId, gateway: ev.gateway } } });
    if (!existing) await tx.gatewayCustomer.create({ data: { orgId, gateway: ev.gateway, gatewayCustomerId: ev.customerId } });
    else if (existing.gatewayCustomerId !== ev.customerId) throw new BillingConflict("organisation already has a different gateway customer");
  }
  if (!ev.subscriptionId) return { status: "PROCESSED", note: "customer recorded" };

  const snap = ev.subscription;
  const price = await priceByRef(tx, ev.gateway, snap?.priceRef);
  const pending = snap?.pendingPriceRef !== undefined ? await priceByRef(tx, ev.gateway, snap.pendingPriceRef) : undefined;
  if (snap?.priceRef && !price) throw new BillingConflict("gateway price is not linked to any plan price");

  let row = await tx.subscription.findUnique({ where: { gatewaySubscriptionId: ev.subscriptionId } });
  if (row) await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${row.id}::uuid FOR UPDATE`;
  let transition: string | undefined;

  if (!row) {
    if (!snap || snap.status === null) {
      if (ev.outcome) throw new BillingRetryLater("subscription not known yet");
      return { status: "PROCESSED", note: "subscription not active yet" };
    }
    if (snap.status !== null && TERMINAL_STATUSES.has(snap.status)) return { status: "IGNORED", note: "unknown subscription already ended" };
    if (!price) throw new BillingConflict("subscription has no price");
    const current = await tx.subscription.findFirst({ where: { orgId, status: { notIn: ["CANCELED", "EXPIRED"] } }, select: { id: true } });
    if (current) throw new BillingConflict("organisation already has a current subscription");
    let status: SubStatus = snap.status;
    if (snap.cancelAtPeriodEnd && (status === "ACTIVE" || status === "TRIALING")) status = "CANCELING";
    row = await tx.subscription.create({
      data: {
        orgId, gateway: ev.gateway, gatewaySubscriptionId: ev.subscriptionId, planId: price.planId, planPriceId: price.id, status,
        currentPeriodStart: snap.currentPeriodStart, currentPeriodEnd: snap.currentPeriodEnd, cancelAtPeriodEnd: Boolean(snap.cancelAtPeriodEnd),
        graceEndsAt: status === "PAST_DUE" ? new Date(ev.at.getTime() + policy.graceDays * 86_400_000) : null,
        pendingPlanPriceId: pending?.id ?? null, gatewayUpdatedAt: ev.at,
      },
    });
    transition = `NEW→${status}`;
    if (ev.outcome) {
      // the creating event also carries a payment outcome (Razorpay subscription.charged)
      const r = applyBillingFact(toState(row), { kind: ev.outcome, at: ev.at } as BillingFact, { graceDays: policy.graceDays });
      if (r.applied && r.to !== row.status) {
        row = await tx.subscription.update({ where: { id: row.id }, data: persistable(r.state) });
        transition += `→${r.to}`;
      }
    }
  } else {
    let state = toState(row);
    const facts: BillingFact[] = [];
    if (snap && snap.status !== null) {
      facts.push({
        kind: "SNAPSHOT", at: ev.at, status: snap.status, currentPeriodStart: snap.currentPeriodStart, currentPeriodEnd: snap.currentPeriodEnd,
        cancelAtPeriodEnd: snap.cancelAtPeriodEnd, planId: price?.planId, planPriceId: price ? price.id : undefined,
        pendingPlanPriceId: pending === undefined ? undefined : pending?.id ?? null, canceledAt: snap.canceledAt,
      });
    }
    if (ev.outcome) facts.push({ kind: ev.outcome, at: ev.at });
    const notes: string[] = [];
    let changed = false;
    for (const f of facts) {
      const r = applyBillingFact(state, f, { graceDays: policy.graceDays });
      if (r.applied) { if (r.from !== r.to) notes.push(`${r.from}→${r.to}`); state = r.state; changed = true; }
      else notes.push(r.reason);
    }
    if (changed) row = await tx.subscription.update({ where: { id: row.id }, data: persistable(state) });
    transition = notes.join(",") || "no change";
  }

  if (ev.payment) {
    const p = ev.payment;
    await tx.payment.upsert({
      where: { gateway_gatewayPaymentId: { gateway: ev.gateway, gatewayPaymentId: p.id } },
      create: {
        orgId, subscriptionId: row.id, gateway: ev.gateway, gatewayPaymentId: p.id, amountMinor: p.amountMinor, currency: p.currency, status: p.status,
        failureCode: p.failureCode, failureMessage: p.failureMessage, paidAt: p.paidAt,
      },
      update: p.status === "SUCCEEDED" ? { status: "SUCCEEDED", paidAt: p.paidAt, failureCode: null, failureMessage: null } : {},
    });
  }
  const invoice = ev.invoice ?? (ev.gateway === "RAZORPAY" && ev.payment?.status === "SUCCEEDED" ? razorpayInvoice(ev, policy) : null);
  if (invoice) await upsertInvoice(tx, orgId, row.id, ev.gateway, invoice, policy);

  return { status: "PROCESSED", note: transition ?? "", subscriptionId: row.id, transition };
}

function persistable(s: SubscriptionState) {
  return {
    status: s.status, planId: s.planId, planPriceId: s.planPriceId, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd, canceledAt: s.canceledAt, graceEndsAt: s.graceEndsAt, pendingPlanPriceId: s.pendingPlanPriceId, gatewayUpdatedAt: s.gatewayUpdatedAt,
  };
}

/** Razorpay doesn't issue subscription invoices with a number we can use: record a paid invoice ourselves. */
function razorpayInvoice(ev: NormalizedEvent, policy: ProcessPolicy): NormalizedInvoice {
  const p = ev.payment!;
  // plan amounts are tax-inclusive; GST is shown as the included share (place-of-supply split: decision B4b)
  const tax = policy.taxMode === "GST" ? Math.round((p.amountMinor * policy.gstRatePct) / (100 + policy.gstRatePct)) : 0;
  return {
    id: p.invoiceRef ?? p.id, number: null, status: "PAID", currency: p.currency, subtotalMinor: p.amountMinor - tax, taxMinor: tax, totalMinor: p.amountMinor,
    periodStart: ev.subscription?.currentPeriodStart ?? null, periodEnd: ev.subscription?.currentPeriodEnd ?? null, issuedAt: p.paidAt ?? ev.at, paidAt: p.paidAt ?? ev.at,
  };
}

async function upsertInvoice(tx: Tx, orgId: string, subscriptionId: string, gateway: GatewayKind, inv: NormalizedInvoice, policy: ProcessPolicy) {
  const existing = await tx.invoice.findFirst({ where: { orgId, gateway, gatewayInvoiceId: inv.id }, select: { id: true, status: true } });
  const taxDetails = { mode: policy.taxMode, ...(policy.taxMode === "GST" ? { ratePct: policy.gstRatePct, inclusive: gateway === "RAZORPAY" } : {}) };
  if (existing) {
    // a PAID invoice never goes back to OPEN (late failure event for an invoice that was paid meanwhile)
    if (existing.status === "PAID" && inv.status !== "PAID" && inv.status !== "VOID") return;
    await tx.invoice.update({ where: { id: existing.id }, data: { status: inv.status, paidAt: inv.paidAt, subtotalMinor: inv.subtotalMinor, taxMinor: inv.taxMinor, totalMinor: inv.totalMinor } });
    return;
  }
  let number = inv.number ? `${gateway === "STRIPE" ? "S" : "R"}-${inv.number}` : null;
  if (!number) {
    const [{ n }] = (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`) as [{ n: bigint }];
    number = `INV-${inv.issuedAt.getUTCFullYear()}-${String(n).padStart(6, "0")}`;
  }
  await tx.invoice.create({
    data: {
      orgId, subscriptionId, number, gateway, gatewayInvoiceId: inv.id, status: inv.status, currency: inv.currency, subtotalMinor: inv.subtotalMinor,
      taxMinor: inv.taxMinor, totalMinor: inv.totalMinor, taxDetails, periodStart: inv.periodStart, periodEnd: inv.periodEnd, issuedAt: inv.issuedAt, paidAt: inv.paidAt,
    },
  });
}
