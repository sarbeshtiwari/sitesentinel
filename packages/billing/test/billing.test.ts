import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGateway, GatewayError, RAZORPAY_MAX_EVENT_AGE_SEC, secretHint, signRazorpayPayload, signStripePayload, verifyRazorpaySignature, verifyStripeSignature,
  type FetchLike,
} from "../src/index.js";

// generated per run: no secret material in the repository
const SECRET = `whsec_${randomBytes(18).toString("hex")}`;
const NOW = Date.UTC(2026, 10, 15, 0, 0, 0);
const body = Buffer.from(JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.updated" }));

describe("Stripe signature (t=…,v1=HMAC-SHA256(t.rawBody))", () => {
  const t = Math.floor(NOW / 1000);
  it("accepts a valid signature", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t), SECRET, NOW, 300)).toEqual({ ok: true, timestamp: t });
  });
  it("accepts any matching v1 (secret rotation)", () => {
    const good = signStripePayload(body, SECRET, t).split(",")[1];
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},${good}`, SECRET, NOW, 300).ok).toBe(true);
  });
  it("rejects a tampered body (one byte)", () => {
    const sig = signStripePayload(body, SECRET, t);
    const tampered = Buffer.from(body); tampered[5] ^= 1;
    expect(verifyStripeSignature(tampered, sig, SECRET, NOW, 300)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rejects a re-serialised body (whitespace differs)", () => {
    const sig = signStripePayload(body, SECRET, t);
    expect(verifyStripeSignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1)), sig, SECRET, NOW, 300).ok).toBe(false);
  });
  it("rejects the wrong secret", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, `${SECRET}x`, t), SECRET, NOW, 300)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rejects an expired timestamp (replay outside the window) and one from the future", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t - 301), SECRET, NOW, 300)).toEqual({ ok: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" });
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t + 301), SECRET, NOW, 300)).toEqual({ ok: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" });
  });
  it("rejects a changed timestamp with the old signature", () => {
    const v1 = signStripePayload(body, SECRET, t).split(",")[1];
    expect(verifyStripeSignature(body, `t=${t + 1},${v1}`, SECRET, NOW, 300)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("rejects missing and malformed headers", () => {
    expect(verifyStripeSignature(body, undefined, SECRET, NOW, 300)).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    expect(verifyStripeSignature(body, "v1=abc", SECRET, NOW, 300)).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE" });
    expect(verifyStripeSignature(body, `t=${t},v0=${"a".repeat(64)}`, SECRET, NOW, 300)).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE" });
    expect(verifyStripeSignature(body, `t=${t},v1=zz`, SECRET, NOW, 300)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
});

describe("Razorpay signature (hex HMAC-SHA256(rawBody))", () => {
  it("accepts a valid signature", () => {
    expect(verifyRazorpaySignature(body, signRazorpayPayload(body, SECRET), SECRET).ok).toBe(true);
  });
  it("rejects tampered body, wrong secret, malformed and missing", () => {
    const sig = signRazorpayPayload(body, SECRET);
    const tampered = Buffer.from(body); tampered[body.length - 2] ^= 1;
    expect(verifyRazorpaySignature(tampered, sig, SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyRazorpaySignature(body, signRazorpayPayload(body, "other-secret"), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyRazorpaySignature(body, "nothex", SECRET)).toEqual({ ok: false, reason: "MALFORMED_SIGNATURE" });
    expect(verifyRazorpaySignature(body, undefined, SECRET)).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });
  it("event age window is wider than Razorpay's 24 h retry period", () => {
    expect(RAZORPAY_MAX_EVENT_AGE_SEC).toBeGreaterThan(24 * 3600);
  });
});

/** In-memory fake gateway: records requests, never touches the network. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses.shift() ?? { status: 500, body: {} };
    return { status: r.status, json: async () => r.body };
  };
  return { f, calls };
}
const creds = { secretKey: `sk_test_${randomBytes(8).toString("hex")}`, webhookSecret: SECRET, publicKey: "rzp_test_key", mode: "test" as const };

describe("Stripe adapter (REST via fetch, fake transport)", () => {
  it("creates a subscription checkout session bound to the organisation, with an idempotency key", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: "cs_1", url: "https://checkout.stripe.test/cs_1", subscription: null } }]);
    const gw = createGateway("STRIPE", creds, { fetchImpl: f, stripeBaseUrl: "http://fake.local" });
    const s = await gw.createCheckout({ orgId: "00000000-0000-0000-0000-000000000001", priceRef: "price_abc123", interval: "MONTH", customerId: null, successUrl: "http://a/s", cancelUrl: "http://a/c", idempotencyKey: "k1", automaticTax: true });
    expect(s.url).toBe("https://checkout.stripe.test/cs_1");
    expect(calls[0]!.url).toBe("http://fake.local/v1/checkout/sessions");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${creds.secretKey}`);
    expect(calls[0]!.headers["idempotency-key"]).toBe("k1");
    const p = new URLSearchParams(calls[0]!.body);
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("client_reference_id")).toBe("00000000-0000-0000-0000-000000000001");
    expect(p.get("subscription_data[metadata][org_id]")).toBe("00000000-0000-0000-0000-000000000001");
    expect(p.get("automatic_tax[enabled]")).toBe("true");
  });
  it("errors carry status and gateway code only (no response body, no key)", async () => {
    const { f } = fakeFetch([{ status: 402, body: { error: { code: "card_declined", message: `secret ${creds.secretKey}` } } }]);
    const gw = createGateway("STRIPE", creds, { fetchImpl: f, stripeBaseUrl: "http://fake.local" });
    const e = await gw.getSubscription("sub_1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect(String((e as Error).message)).not.toContain(creds.secretKey);
    expect((e as GatewayError).code).toBe("card_declined");
  });
  it("normalises subscription and invoice events (basil and legacy shapes)", () => {
    const gw = createGateway("STRIPE", creds);
    const sub = gw.parseEvent({ id: "evt_s", object: "event", type: "customer.subscription.updated", created: 1_800_000_000, data: { object: {
      id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: true, metadata: { org_id: "o1" },
      items: { data: [{ price: { id: "price_x" }, current_period_start: 1_800_000_000, current_period_end: 1_802_592_000 }] },
    } } }, {});
    expect(sub.subscription).toMatchObject({ id: "sub_1", status: "ACTIVE", cancelAtPeriodEnd: true, priceRef: "price_x", orgIdHint: "o1" });
    expect(sub.subscription!.currentPeriodEnd!.getTime()).toBe(1_802_592_000_000);
    const inv = gw.parseEvent({ id: "evt_i", object: "event", type: "invoice.payment_failed", created: 1_800_000_100, data: { object: {
      id: "in_1", number: "ABC-0001", customer: "cus_1", status: "open", currency: "usd", subtotal: 3900, total: 3900, amount_due: 3900, created: 1_800_000_000,
      parent: { subscription_details: { subscription: "sub_1", metadata: { org_id: "o1" } } }, payment_intent: "pi_1",
    } } }, {});
    expect(inv).toMatchObject({ outcome: "PAYMENT_FAILED", subscriptionId: "sub_1", orgIdHint: "o1", ignored: false });
    expect(inv.payment).toMatchObject({ id: "pi_1", status: "FAILED", currency: "USD", amountMinor: 3900 });
    const legacy = gw.parseEvent({ id: "evt_l", object: "event", type: "invoice.paid", created: 1, data: { object: { id: "in_2", subscription: "sub_9", currency: "inr", amount_paid: 100, tax: 18, total: 100, subtotal: 82 } } }, {});
    expect(legacy).toMatchObject({ subscriptionId: "sub_9", outcome: "PAYMENT_SUCCEEDED" });
    expect(legacy.invoice!.taxMinor).toBe(18);
    expect(gw.parseEvent({ id: "evt_x", object: "event", type: "charge.refunded", created: 1, data: { object: {} } }, {}).ignored).toBe(true);
    expect(() => gw.parseEvent({ id: "x" }, {})).toThrow();
  });
});

describe("Razorpay adapter (REST via fetch, fake transport)", () => {
  it("creates a subscription with Basic auth and the org in notes; resume is not supported", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: "sub_R1", short_url: "https://rzp.test/i/x", status: "created" } }]);
    const gw = createGateway("RAZORPAY", creds, { fetchImpl: f, razorpayBaseUrl: "http://fake.local" });
    const s = await gw.createCheckout({ orgId: "o1", priceRef: "plan_abcdef", interval: "YEAR", customerId: null, successUrl: "", cancelUrl: "", idempotencyKey: "k", automaticTax: false });
    expect(s).toMatchObject({ url: "https://rzp.test/i/x", subscriptionId: "sub_R1" });
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`rzp_test_key:${creds.secretKey}`).toString("base64")}`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ plan_id: "plan_abcdef", total_count: 10, notes: { org_id: "o1" } });
    await expect(gw.setCancelAtPeriodEnd("sub_R1", false)).rejects.toBeInstanceOf(GatewayError);
    expect(gw.supports.resume).toBe(false);
  });
  it("normalises charged / pending events and requires the event id header", () => {
    const gw = createGateway("RAZORPAY", creds);
    const ev = {
      entity: "event", event: "subscription.charged", created_at: 1_800_000_000,
      payload: {
        subscription: { entity: { id: "sub_R1", plan_id: "plan_abcdef", customer_id: "cust_1", status: "active", current_start: 1_800_000_000, current_end: 1_802_592_000, notes: { org_id: "o1" } } },
        payment: { entity: { id: "pay_1", amount: 249900, currency: "INR", status: "captured", created_at: 1_800_000_000 } },
      },
    };
    const n = gw.parseEvent(ev, { "x-razorpay-event-id": "evt_rzp_1" });
    expect(n).toMatchObject({ eventId: "evt_rzp_1", outcome: "PAYMENT_SUCCEEDED", subscriptionId: "sub_R1", orgIdHint: "o1" });
    expect(n.subscription).toMatchObject({ status: "ACTIVE", priceRef: "plan_abcdef" });
    expect(n.payment).toMatchObject({ id: "pay_1", status: "SUCCEEDED", amountMinor: 249900 });
    const pending = gw.parseEvent({ ...ev, event: "subscription.pending", payload: { subscription: { entity: { ...ev.payload.subscription.entity, status: "pending" } } } }, { "x-razorpay-event-id": "evt_rzp_2" });
    expect(pending).toMatchObject({ outcome: "PAYMENT_FAILED" });
    expect(pending.subscription!.status).toBe("PAST_DUE");
    expect(() => gw.parseEvent(ev, {})).toThrow(/Event-Id/);
  });
});

describe("secret hints", () => {
  it("never reveal more than the prefix and last four characters", () => {
    const k = `sk_test_${"a".repeat(20)}WXYZ`;
    expect(secretHint(k)).toBe("sk_test_…WXYZ");
    expect(secretHint(k)).not.toContain("aaaa");
  });
});
