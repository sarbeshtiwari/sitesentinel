import { isUuid, withTenant, type Db, type Tx } from "@wim/db";
import { applyEventToOrg, BillingConflict, BillingRetryLater, type ProcessPolicy } from "./process.js";
import { RAZORPAY_MAX_EVENT_AGE_SEC, verifyRazorpaySignature, verifyStripeSignature } from "./signature.js";
import type { GatewayCredentials, GatewayKind, NormalizedEvent, PaymentGateway } from "./types.js";

export interface WebhookInput {
  db: Db;
  gateway: PaymentGateway;
  credentials: GatewayCredentials;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  now: Date;
  toleranceSec: number;
  policy: ProcessPolicy;
}

export type WebhookOutcome =
  | { httpStatus: 400; result: "REJECTED"; reason: string }
  | { httpStatus: 200; result: "PROCESSED" | "IGNORED" | "DUPLICATE" | "FAILED"; reason?: string; eventId: string }
  | { httpStatus: 500; result: "RETRY"; reason: string; eventId: string };

/** What we keep of a verified event: identifiers only (no names, emails, addresses — data minimisation). */
function summary(ev: NormalizedEvent) {
  return {
    type: ev.type, at: ev.at.toISOString(), subscriptionId: ev.subscriptionId, customerId: ev.customerId,
    status: ev.subscription?.status ?? null, outcome: ev.outcome, paymentId: ev.payment?.id ?? null, invoiceId: ev.invoice?.id ?? null,
  };
}

async function recordOutside(db: Db, ev: NormalizedEvent, status: "IGNORED" | "FAILED", error: string | null) {
  await db.$executeRaw`
    INSERT INTO payment_webhook_events (gateway, event_id, event_type, signature_valid, payload, status, attempts, error, processed_at)
    VALUES (${ev.gateway}::"GatewayKind", ${ev.eventId}, ${ev.type}, true, ${JSON.stringify(summary(ev))}::jsonb, ${status}::"WebhookProcessingStatus", 1, ${error}, now())
    ON CONFLICT (gateway, event_id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, attempts = payment_webhook_events.attempts + 1,
      processed_at = now()
    WHERE payment_webhook_events.status NOT IN ('PROCESSED', 'IGNORED')`;
}

/** Claim the event in the ledger (UNIQUE(gateway, event_id)). false = already processed (replay / re-delivery). */
async function claim(tx: Tx, ev: NormalizedEvent): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO payment_webhook_events (gateway, event_id, event_type, signature_valid, payload, status, attempts)
    VALUES (${ev.gateway}::"GatewayKind", ${ev.eventId}, ${ev.type}, true, ${JSON.stringify(summary(ev))}::jsonb, 'RECEIVED', 1)
    ON CONFLICT (gateway, event_id) DO UPDATE SET attempts = payment_webhook_events.attempts + 1, status = 'RECEIVED', error = NULL
    WHERE payment_webhook_events.status = 'FAILED'
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Receive one webhook delivery:
 *  1. signature over the RAW body (Stripe: timestamped, tolerance window; Razorpay: HMAC, event age window)
 *  2. parse + normalise (only after the signature is valid)
 *  3. find the organisation (subscription/customer we already know, else the org id we attached at checkout)
 *  4. ONE transaction under that organisation's RLS context: claim the event id (UNIQUE — replays and re-deliveries
 *     become no-ops), apply the state machine, payments, invoices, mark the event PROCESSED
 * Failures roll everything back and are recorded as FAILED so a later re-delivery can retry.
 */
export async function handleWebhook(i: WebhookInput): Promise<WebhookOutcome> {
  const kind: GatewayKind = i.gateway.kind;
  const sig = kind === "STRIPE"
    ? verifyStripeSignature(i.rawBody, i.headers["stripe-signature"], i.credentials.webhookSecret, i.now.getTime(), i.toleranceSec)
    : verifyRazorpaySignature(i.rawBody, i.headers["x-razorpay-signature"], i.credentials.webhookSecret);
  if (!sig.ok) return { httpStatus: 400, result: "REJECTED", reason: sig.reason };

  let ev: NormalizedEvent;
  try {
    ev = i.gateway.parseEvent(JSON.parse(i.rawBody.toString("utf8")), i.headers);
  } catch {
    return { httpStatus: 400, result: "REJECTED", reason: "MALFORMED_EVENT" };
  }
  if (kind === "RAZORPAY") {
    const age = (i.now.getTime() - ev.at.getTime()) / 1000;
    if (age > RAZORPAY_MAX_EVENT_AGE_SEC || age < -i.toleranceSec) return { httpStatus: 400, result: "REJECTED", reason: "EVENT_TOO_OLD" };
  }
  if (ev.ignored) {
    await recordOutside(i.db, ev, "IGNORED", `event type not used`);
    return { httpStatus: 200, result: "IGNORED", eventId: ev.eventId };
  }

  const [r] = await i.db.$queryRaw<Array<{ org_id: string | null }>>`SELECT billing_resolve_org(${kind}, ${ev.subscriptionId}, ${ev.customerId}) AS org_id`;
  const known = r?.org_id ?? null;
  const hint = ev.orgIdHint && isUuid(ev.orgIdHint) ? ev.orgIdHint : null;
  if (known && hint && known !== hint) {
    await recordOutside(i.db, ev, "FAILED", "organisation mismatch between gateway object and metadata");
    return { httpStatus: 200, result: "FAILED", reason: "ORG_MISMATCH", eventId: ev.eventId };
  }
  const orgId = known ?? hint;
  if (!orgId) {
    await recordOutside(i.db, ev, "IGNORED", "no organisation for this gateway object");
    return { httpStatus: 200, result: "IGNORED", eventId: ev.eventId };
  }

  try {
    const out = await withTenant(i.db, orgId, async (tx) => {
      if (!(await claim(tx, ev))) return { duplicate: true as const };
      const res = await applyEventToOrg(tx, orgId, ev, i.policy);
      await tx.$executeRaw`
        UPDATE payment_webhook_events SET status = ${res.status}::"WebhookProcessingStatus", processed_at = now(), error = ${res.status === "IGNORED" ? res.note.slice(0, 300) : null}
         WHERE gateway = ${kind}::"GatewayKind" AND event_id = ${ev.eventId}`;
      return { duplicate: false as const, res };
    });
    if (out.duplicate) return { httpStatus: 200, result: "DUPLICATE", eventId: ev.eventId };
    return { httpStatus: 200, result: out.res.status, reason: out.res.note, eventId: ev.eventId };
  } catch (e) {
    const msg = e instanceof BillingConflict || e instanceof BillingRetryLater ? e.message : "processing error";
    await recordOutside(i.db, ev, "FAILED", msg).catch(() => undefined);
    if (e instanceof BillingConflict) return { httpStatus: 200, result: "FAILED", reason: msg, eventId: ev.eventId };
    return { httpStatus: 500, result: "RETRY", reason: msg, eventId: ev.eventId };
  }
}
