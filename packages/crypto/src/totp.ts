import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 TOTP: SHA-1, 30 s step, 6 digits by default (authenticator-app compatible). */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 (RFC 4226 recommends ≥ 128 bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export function totpStep(nowMs: number, periodSec = 30): bigint {
  return BigInt(Math.floor(nowMs / 1000 / periodSec));
}

export function totp(secretB32: string, nowMs = Date.now(), digits = 6): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs), digits);
}

/**
 * Verify a code within ±window steps. Returns the matched step, or null.
 * Replay protection: codes at or before `lastUsedStep` are rejected.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { nowMs?: number; window?: number; lastUsedStep?: bigint | null; digits?: number } = {},
): bigint | null {
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = totpStep(opts.nowMs ?? Date.now());
  const window = BigInt(opts.window ?? 1);
  let matched: bigint | null = null;
  // Check every step in the window (no early exit) to keep timing independent of which step matched.
  for (let s = current - window; s <= current + window; s++) {
    if (hotp(secret, s, digits) === code) matched = s;
  }
  if (matched === null) return null;
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
  return matched;
}

export function otpauthUrl(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({ secret: opts.secret, issuer: opts.issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
