import type { SubStatus } from "@wim/core";
import {
  GatewayError, type CheckoutRequest, type CheckoutSession, type FetchLike, type GatewayCredentials, type GatewaySubscriptionSnapshot,
  type NormalizedEvent, type PaymentGateway,
} from "./types.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const date = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);

/**
 * Razorpay subscription states → ours. `created`/`authenticated` (mandate set, not charged yet) are not acted on;
 * `pending` (a charge failed, Razorpay is retrying) and `halted` (retries exhausted) are PAST_DUE — our grace period
 * decides when service stops; `completed` (all billing cycles done) ends the subscription like a cancellation.
 */
const STATUS: Record<string, SubStatus | null> = {
  created: null, authenticated: null, active: "ACTIVE", pending: "PAST_DUE", halted: "PAST_DUE", paused: "PAST_DUE",
  cancelled: "CANCELED", completed: "CANCELED", expired: "EXPIRED",
};

export function razorpaySnapshot(sub: Obj): GatewaySubscriptionSnapshot {
  return {
    id: String(sub.id),
    customerId: str(sub.customer_id),
    status: STATUS[String(sub.status)] ?? null,
    currentPeriodStart: date(sub.current_start),
    currentPeriodEnd: date(sub.current_end),
    // Razorpay's entity has no cancel-at-cycle-end flag: keep ours (set when we requested it)
    cancelAtPeriodEnd: undefined,
    canceledAt: date(sub.ended_at),
    priceRef: str(sub.plan_id),
    orgIdHint: str(o(sub.notes).org_id),
  };
}

/** Razorpay adapter over the REST API (JSON, Basic auth key id : key secret). No SDK dependency. */
export class RazorpayGateway implements PaymentGateway {
  readonly kind = "RAZORPAY" as const;
  readonly supports = { resume: false, scheduledDowngrade: true };
  constructor(private readonly creds: GatewayCredentials, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly baseUrl = "https://api.razorpay.com") {}

  private async call(method: "GET" | "POST" | "PATCH", path: string, body?: Obj): Promise<Obj> {
    if (!this.creds.publicKey) throw new GatewayError("RAZORPAY", 500, "key_id_missing");
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${this.creds.publicKey}:${this.creds.secretKey}`).toString("base64")}` };
    if (body) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const json = o(await res.json().catch(() => ({})));
    if (res.status >= 300) throw new GatewayError("RAZORPAY", res.status, str(o(json.error).code) ?? "");
    return json;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutSession> {
    // Razorpay subscriptions need a fixed number of cycles: ten years either way
    const s = await this.call("POST", "/v1/subscriptions", {
      plan_id: r.priceRef, total_count: r.interval === "YEAR" ? 10 : 120, customer_notify: 1, quantity: 1,
      notes: { org_id: r.orgId, checkout: r.idempotencyKey.slice(0, 64) },
    });
    const url = str(s.short_url);
    if (!url) throw new GatewayError("RAZORPAY", 502, "no_short_url");
    return { url, sessionId: String(s.id), subscriptionId: String(s.id) };
  }

  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    if (!cancel) throw new GatewayError("RAZORPAY", 409, "resume_not_supported");
    const snap = razorpaySnapshot(await this.call("POST", `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 }));
    return { ...snap, cancelAtPeriodEnd: true };
  }

  async changePrice(id: string, priceRef: string, when: "now" | "period_end") {
    const snap = razorpaySnapshot(await this.call("PATCH", `/v1/subscriptions/${encodeURIComponent(id)}`, {
      plan_id: priceRef, schedule_change_at: when === "now" ? "now" : "cycle_end", customer_notify: 1,
    }));
    return when === "period_end" ? { ...snap, pendingPriceRef: priceRef } : snap;
  }

  async getSubscription(id: string) {
    return razorpaySnapshot(await this.call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`));
  }

  parseEvent(payload: unknown, headers: Record<string, string | undefined>): NormalizedEvent {
    const e = o(payload);
    const eventId = headers["x-razorpay-event-id"];
    if (e.entity !== "event" || typeof e.event !== "string") throw new Error("not a Razorpay event");
    if (!eventId || !/^[A-Za-z0-9_-]{6,100}$/.test(eventId)) throw new Error("missing X-Razorpay-Event-Id");
    const at = date(e.created_at) ?? new Date();
    const p = o(e.payload);
    const subEntity = o(o(p.subscription).entity);
    const payEntity = o(o(p.payment).entity);
    const snap = subEntity.id ? razorpaySnapshot(subEntity) : null;
    const base: NormalizedEvent = {
      gateway: "RAZORPAY", eventId, type: e.event, at, orgIdHint: snap?.orgIdHint ?? str(o(payEntity.notes).org_id),
      subscriptionId: snap?.id ?? str(payEntity.subscription_id), customerId: snap?.customerId ?? str(payEntity.customer_id),
      subscription: snap, outcome: null, payment: null, invoice: null, ignored: false,
    };
    const payment = payEntity.id ? {
      id: String(payEntity.id), amountMinor: int(payEntity.amount), currency: String(payEntity.currency ?? "").toUpperCase(),
      status: (payEntity.status === "captured" || payEntity.status === "authorized" ? "SUCCEEDED" : "FAILED") as "SUCCEEDED" | "FAILED",
      failureCode: str(payEntity.error_code), failureMessage: str(payEntity.error_description)?.slice(0, 200) ?? null,
      paidAt: date(payEntity.created_at), invoiceRef: str(payEntity.invoice_id),
    } : null;
    switch (e.event) {
      case "subscription.activated":
      case "subscription.updated":
      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.paused":
      case "subscription.resumed":
      case "subscription.halted":
        return { ...base, ignored: !snap };
      case "subscription.charged":
        return { ...base, outcome: "PAYMENT_SUCCEEDED", payment, ignored: !snap };
      case "subscription.pending":
        return { ...base, outcome: "PAYMENT_FAILED", payment: payment ? { ...payment, status: "FAILED" } : null, ignored: !snap };
      case "payment.failed":
        // only payments of a subscription concern billing; one-off payments are not ours
        return { ...base, outcome: base.subscriptionId ? "PAYMENT_FAILED" : null, payment, ignored: !base.subscriptionId };
      default:
        return { ...base, ignored: true };
    }
  }
}
