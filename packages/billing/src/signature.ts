import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification over the RAW request body (never a re-serialised object: any byte difference
 * must fail). Constant-time comparison. Secrets are never logged or included in a reason.
 */
export type SignatureResult = { ok: true; timestamp: number | null } | { ok: false; reason: "MISSING_SIGNATURE" | "MALFORMED_SIGNATURE" | "BAD_SIGNATURE" | "TIMESTAMP_OUT_OF_TOLERANCE" };

function hmacHex(secret: string, payload: Buffer | string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), "hex"), Buffer.from(b.toLowerCase(), "hex"));
}

/**
 * Stripe: `Stripe-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=…][,v0=…]` where the HMAC-SHA256 is computed with
 * the endpoint secret over `${t}.${rawBody}`. Any matching v1 is accepted (secret rotation); v0 is ignored.
 * The timestamp must be within `toleranceSec` of now (replay window) — in both directions.
 */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, nowMs: number, toleranceSec: number): SignatureResult {
  if (!header) return { ok: false, reason: "MISSING_SIGNATURE" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (t === null || !v1.length) return { ok: false, reason: "MALFORMED_SIGNATURE" };
  const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]));
  if (!v1.some((s) => equalHex(s, expected))) return { ok: false, reason: "BAD_SIGNATURE" };
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" };
  return { ok: true, timestamp: t };
}

/**
 * Razorpay: `X-Razorpay-Signature: <hex hmac>` = HMAC-SHA256(rawBody, webhook secret). Razorpay does not sign a
 * delivery timestamp; replay protection is the permanent UNIQUE(gateway, event_id) ledger plus a maximum event age
 * checked on the signed `created_at` (see RAZORPAY_MAX_EVENT_AGE_SEC).
 */
export function verifyRazorpaySignature(rawBody: Buffer, header: string | undefined, secret: string): SignatureResult {
  if (!header) return { ok: false, reason: "MISSING_SIGNATURE" };
  const sig = header.trim();
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "MALFORMED_SIGNATURE" };
  return equalHex(sig, hmacHex(secret, rawBody)) ? { ok: true, timestamp: null } : { ok: false, reason: "BAD_SIGNATURE" };
}

/** Razorpay retries failed deliveries for ~24 h with the ORIGINAL created_at, so its age window is wider than Stripe's. */
export const RAZORPAY_MAX_EVENT_AGE_SEC = 3 * 24 * 3600;

/** Test helper / documentation of the scheme: build a valid Stripe-Signature header. */
export function signStripePayload(rawBody: Buffer | string, secret: string, timestampSec: number): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return `t=${timestampSec},v1=${hmacHex(secret, Buffer.concat([Buffer.from(`${timestampSec}.`, "utf8"), body]))}`;
}

export function signRazorpayPayload(rawBody: Buffer | string, secret: string): string {
  return hmacHex(secret, rawBody);
}
