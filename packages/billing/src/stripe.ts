import type { SubStatus } from "@wim/core";
import {
  GatewayError, type CheckoutRequest, type CheckoutSession, type FetchLike, type GatewayCredentials, type GatewaySubscriptionSnapshot,
  type NormalizedEvent, type NormalizedInvoice, type PaymentGateway,
} from "./types.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const date = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);
/** an expandable field is either an id string or an object with an id */
const ref = (v: unknown): string | null => str(v) ?? str(o(v).id);

/** Pinned REST API version: the payload shapes parsed below are those of this version (and older ones are tolerated). */
export const STRIPE_API_VERSION = "2025-03-31.basil";

const STATUS: Record<string, SubStatus | null> = {
  trialing: "TRIALING", active: "ACTIVE", past_due: "PAST_DUE", unpaid: "PAST_DUE", paused: "PAST_DUE",
  canceled: "CANCELED", incomplete_expired: "EXPIRED", incomplete: null,
};

function form(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.append(k, String(v));
  return u.toString();
}

export function stripeSnapshot(sub: Obj): GatewaySubscriptionSnapshot {
  const item = o((o(sub.items).data as unknown[] | undefined)?.[0]);
  return {
    id: String(sub.id),
    customerId: ref(sub.customer),
    status: STATUS[String(sub.status)] ?? null,
    // basil moved the period onto the subscription item; older versions have it on the subscription
    currentPeriodStart: date(item.current_period_start) ?? date(sub.current_period_start),
    currentPeriodEnd: date(item.current_period_end) ?? date(sub.current_period_end),
    cancelAtPeriodEnd: typeof sub.cancel_at_period_end === "boolean" ? sub.cancel_at_period_end : undefined,
    canceledAt: date(sub.canceled_at) ?? date(sub.ended_at),
    priceRef: ref(item.price),
    orgIdHint: str(o(sub.metadata).org_id),
  };
}

function stripeInvoice(inv: Obj): NormalizedInvoice {
  const statusMap: Record<string, NormalizedInvoice["status"]> = { draft: "DRAFT", open: "OPEN", paid: "PAID", void: "VOID", uncollectible: "UNCOLLECTIBLE" };
  const taxes = Array.isArray(inv.total_taxes) ? (inv.total_taxes as unknown[]).reduce<number>((s, t) => s + int(o(t).amount), 0) : int(inv.tax);
  const line = o((o(inv.lines).data as unknown[] | undefined)?.[0]);
  return {
    id: String(inv.id), number: str(inv.number), status: statusMap[String(inv.status)] ?? "OPEN", currency: String(inv.currency ?? "").toUpperCase(),
    subtotalMinor: int(inv.subtotal), taxMinor: taxes, totalMinor: int(inv.total),
    periodStart: date(o(line.period).start) ?? date(inv.period_start), periodEnd: date(o(line.period).end) ?? date(inv.period_end),
    issuedAt: date(inv.created) ?? new Date(), paidAt: date(o(inv.status_transitions).paid_at),
  };
}

function invoiceSubscription(inv: Obj): { id: string | null; orgId: string | null } {
  const details = o(o(inv.parent).subscription_details);
  const legacy = o(inv.subscription_details);
  return {
    id: ref(details.subscription) ?? ref(inv.subscription),
    orgId: str(o(details.metadata).org_id) ?? str(o(legacy.metadata).org_id),
  };
}

/** Stripe adapter over the REST API (form-encoded requests, Bearer secret key). No SDK dependency. */
export class StripeGateway implements PaymentGateway {
  readonly kind = "STRIPE" as const;
  readonly supports = { resume: true, scheduledDowngrade: false };
  constructor(private readonly creds: GatewayCredentials, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly baseUrl = "https://api.stripe.com") {}

  private async call(method: "GET" | "POST", path: string, body?: string, idempotencyKey?: string): Promise<Obj> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.creds.secretKey}`, "stripe-version": STRIPE_API_VERSION };
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    const json = o(await res.json().catch(() => ({})));
    if (res.status >= 300) throw new GatewayError("STRIPE", res.status, str(o(json.error).code) ?? str(o(json.error).type) ?? "");
    return json;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutSession> {
    const s = await this.call("POST", "/v1/checkout/sessions", form({
      mode: "subscription",
      "line_items[0][price]": r.priceRef, "line_items[0][quantity]": 1,
      success_url: r.successUrl, cancel_url: r.cancelUrl,
      client_reference_id: r.orgId,
      "metadata[org_id]": r.orgId,
      "subscription_data[metadata][org_id]": r.orgId,
      customer: r.customerId ?? undefined,
      "automatic_tax[enabled]": r.automaticTax ? true : undefined,
    }), r.idempotencyKey);
    const url = str(s.url);
    if (!url) throw new GatewayError("STRIPE", 502, "no_checkout_url");
    return { url, sessionId: String(s.id), subscriptionId: ref(s.subscription) };
  }

  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    return stripeSnapshot(await this.call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, form({ cancel_at_period_end: cancel })));
  }

  async changePrice(id: string, priceRef: string, _when: "now" | "period_end") {
    const current = await this.call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
    const itemId = ref((o(current.items).data as unknown[] | undefined)?.[0]);
    if (!itemId) throw new GatewayError("STRIPE", 409, "no_subscription_item");
    // proration is Stripe's (create_prorations); downgrades also apply immediately with a credit (no schedules)
    return stripeSnapshot(await this.call("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, form({
      "items[0][id]": itemId, "items[0][price]": priceRef, proration_behavior: "create_prorations", cancel_at_period_end: false,
    })));
  }

  async getSubscription(id: string) {
    return stripeSnapshot(await this.call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`));
  }

  parseEvent(payload: unknown): NormalizedEvent {
    const e = o(payload);
    if (e.object !== "event" || typeof e.id !== "string" || typeof e.type !== "string") throw new Error("not a Stripe event");
    const obj = o(o(e.data).object);
    const at = date(e.created) ?? new Date();
    const base: NormalizedEvent = {
      gateway: "STRIPE", eventId: e.id, type: e.type, at, orgIdHint: null, subscriptionId: null, customerId: null,
      subscription: null, outcome: null, payment: null, invoice: null, ignored: false,
    };
    switch (e.type) {
      case "checkout.session.completed":
        return { ...base, orgIdHint: str(obj.client_reference_id) ?? str(o(obj.metadata).org_id), subscriptionId: ref(obj.subscription), customerId: ref(obj.customer) };
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        const snap = stripeSnapshot(obj);
        return { ...base, orgIdHint: snap.orgIdHint, subscriptionId: snap.id, customerId: snap.customerId, subscription: snap };
      }
      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const sub = invoiceSubscription(obj);
        const inv = stripeInvoice(obj);
        const failed = e.type === "invoice.payment_failed";
        const paymentId = ref(obj.payment_intent) ?? ref(obj.charge) ?? `inv:${inv.id}:${failed ? "failed" : "paid"}`;
        return {
          ...base, orgIdHint: sub.orgId, subscriptionId: sub.id, customerId: ref(obj.customer), invoice: inv,
          outcome: failed ? "PAYMENT_FAILED" : "PAYMENT_SUCCEEDED",
          payment: {
            id: paymentId, amountMinor: failed ? int(obj.amount_due) : int(obj.amount_paid), currency: inv.currency, status: failed ? "FAILED" : "SUCCEEDED",
            failureCode: failed ? str(o(obj.last_finalization_error).code) ?? "payment_failed" : null, failureMessage: null, paidAt: failed ? null : inv.paidAt ?? at, invoiceRef: inv.id,
          },
          ignored: !sub.id,
        };
      }
      default:
        return { ...base, ignored: true };
    }
  }
}
