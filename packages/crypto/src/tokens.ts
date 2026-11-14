import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe random token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

/** Constant-time string comparison (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Crockford-style alphabet without I, L, O, U to avoid transcription errors.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Recovery codes: 12 symbols from a 32-symbol alphabet = 60 bits of entropy,
 * formatted XXXX-XXXX-XXXX. High entropy is why a keyed HMAC (not a slow hash)
 * is the appropriate storage transform (SECURITY.md §7.5).
 */
export function generateRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Normalize user input of a recovery code: uppercase, strip separators/spaces, map look-alikes. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Normalize an email for keyed hashing in abuse signals and login logs. */
export function normalizeEmailForHash(email: string): string {
  return email.trim().toLowerCase();
}

/** IP prefix stored instead of full addresses: /24 for IPv4, /48 for IPv6. */
export function ipPrefix(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) {
    const parts = ip.split("::")[0]!.split(":").filter(Boolean);
    return [...parts.slice(0, 3), ...Array(Math.max(0, 3 - parts.length)).fill("0")].join(":") + "::/48";
  }
  return null;
}
