import type { SubStatus } from "@wim/core";

export type GatewayKind = "STRIPE" | "RAZORPAY";

/** Decrypted gateway configuration. Lives only in memory; never logged, never returned by an API. */
export interface GatewayCredentials {
  /** Stripe secret key (sk_…) / Razorpay key secret */
  secretKey: string;
  webhookSecret: string;
  /** Stripe publishable key / Razorpay key id (rzp_…): Razorpay needs it for Basic auth */
  publicKey: string | null;
  mode: "test" | "live";
}

/** The gateway's current view of a subscription, normalised. `status: null` = a state we don't act on (incomplete, created). */
export interface GatewaySubscriptionSnapshot {
  id: string;
  customerId: string | null;
  status: SubStatus | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** undefined = the gateway's payload does not say (keep our value) */
  cancelAtPeriodEnd?: boolean;
  canceledAt: Date | null;
  /** Stripe price id / Razorpay plan id of the current item */
  priceRef: string | null;
  /** a scheduled plan change (Razorpay schedule_change_at=cycle_end) */
  pendingPriceRef?: string | null;
  /** org id we attached at checkout (Stripe metadata.org_id / Razorpay notes.org_id) */
  orgIdHint: string | null;
}

export interface NormalizedPayment {
  id: string; amountMinor: number; currency: string; status: "SUCCEEDED" | "FAILED";
  failureCode: string | null; failureMessage: string | null; paidAt: Date | null; invoiceRef: string | null;
}

export interface NormalizedInvoice {
  id: string; number: string | null; status: "DRAFT" | "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE"; currency: string;
  subtotalMinor: number; taxMinor: number; totalMinor: number; periodStart: Date | null; periodEnd: Date | null; issuedAt: Date; paidAt: Date | null;
}

/** A verified webhook event in gateway-neutral form. */
export interface NormalizedEvent {
  gateway: GatewayKind;
  eventId: string;
  type: string;
  /** the gateway's event creation time (out-of-order guard) */
  at: Date;
  orgIdHint: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  subscription: GatewaySubscriptionSnapshot | null;
  outcome: "PAYMENT_SUCCEEDED" | "PAYMENT_FAILED" | null;
  payment: NormalizedPayment | null;
  invoice: NormalizedInvoice | null;
  /** true when we don't act on this event type at all */
  ignored: boolean;
}

export interface CheckoutRequest {
  orgId: string;
  priceRef: string;
  interval: "MONTH" | "YEAR";
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
  /** stable key so a double-click does not create two sessions */
  idempotencyKey: string;
  automaticTax: boolean;
}

export interface CheckoutSession { url: string; sessionId: string; subscriptionId: string | null }

export class GatewayError extends Error {
  constructor(readonly gateway: GatewayKind, readonly status: number, readonly code: string) {
    // never include response bodies (could echo request data) — status and gateway error code only
    super(`${gateway} request failed (${status}${code ? `, ${code}` : ""})`);
    this.name = "GatewayError";
  }
}

export interface PaymentGateway {
  readonly kind: GatewayKind;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** cancel at period end (true) or undo it (false) */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<GatewaySubscriptionSnapshot>;
  /** switch the subscription to another price; proration is left to the gateway */
  changePrice(subscriptionId: string, priceRef: string, when: "now" | "period_end"): Promise<GatewaySubscriptionSnapshot>;
  getSubscription(subscriptionId: string): Promise<GatewaySubscriptionSnapshot>;
  /** Signature must already be verified. Throws on a payload that isn't an event. */
  parseEvent(payload: unknown, headers: Record<string, string | undefined>): NormalizedEvent;
  /** Which gateway features exist (UI/API refuse what the gateway can't do) */
  readonly supports: { resume: boolean; scheduledDowngrade: boolean };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
