import { describe, expect, it } from "vitest";
import {
  LocalKeyProvider, newKeyRing, generateDek, rewrapDek, seal, open, openString, sealedKeyVersion,
  hotp, verifyTotp, totp, base32Encode, base32Decode, generateTotpSecret,
  generateRecoveryCode, normalizeRecoveryCode, safeEqual, ipPrefix,
  hashPassword, verifyPassword, needsRehash,
} from "../src/index.js";

describe("envelope encryption", () => {
  it("round-trips and records the DEK version", () => {
    const dek = generateDek();
    const blob = seal(dek, 7, "s3cret", "users.totp:u1");
    expect(sealedKeyVersion(blob)).toBe(7);
    expect(openString(dek, blob, "users.totp:u1")).toBe("s3cret");
  });

  it("rejects tampered ciphertext", () => {
    const dek = generateDek();
    const blob = seal(dek, 1, "s3cret", "ctx");
    blob[blob.length - 1]! ^= 0x01;
    expect(() => open(dek, blob, "ctx")).toThrow();
  });

  it("rejects ciphertext moved to another row (AAD binding)", () => {
    const dek = generateDek();
    const blob = seal(dek, 1, "s3cret", "users.totp:u1");
    expect(() => open(dek, blob, "users.totp:u2")).toThrow();
  });

  it("rejects the wrong key", () => {
    const blob = seal(generateDek(), 1, "s3cret", "ctx");
    expect(() => open(generateDek(), blob, "ctx")).toThrow();
  });
});

describe("LocalKeyProvider", () => {
  it("wraps/unwraps DEKs with context binding", async () => {
    const kp = new LocalKeyProvider(newKeyRing());
    const dek = generateDek();
    const { kekId, wrapped } = await kp.wrapKey(dek, "org:1");
    expect((await kp.unwrapKey(kekId, wrapped, "org:1")).equals(dek)).toBe(true);
    await expect(kp.unwrapKey(kekId, wrapped, "org:2")).rejects.toThrow();
  });

  it("rotates: re-wraps a DEK from an old KEK to the current one", async () => {
    const r1 = newKeyRing("local-1");
    const old = new LocalKeyProvider(r1);
    const dek = generateDek();
    const rec = await old.wrapKey(dek, "org:1");
    const r2 = newKeyRing("local-2");
    const rotated = new LocalKeyProvider({ current: "local-2", keys: { ...r1.keys, ...r2.keys }, hmacPepper: r1.hmacPepper });
    const re = await rewrapDek(rotated, rec, "org:1");
    expect(re.kekId).toBe("local-2");
    expect((await rotated.unwrapKey(re.kekId, re.wrapped, "org:1")).equals(dek)).toBe(true);
  });

  it("derives distinct HMAC keys per purpose", () => {
    const kp = new LocalKeyProvider(newKeyRing());
    expect(kp.hmacKey("email").equals(kp.hmacKey("recovery-code"))).toBe(false);
    expect(kp.hmacKey("email").equals(kp.hmacKey("email"))).toBe(true);
  });

  it("rejects malformed key rings", () => {
    expect(() => new LocalKeyProvider({ current: "x", keys: { x: "c2hvcnQ=" }, hmacPepper: newKeyRing().hmacPepper })).toThrow();
    expect(() => new LocalKeyProvider({ ...newKeyRing(), current: "missing" })).toThrow();
  });
});

describe("TOTP (RFC 6238 vectors)", () => {
  // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890", 8 digits.
  const secret = Buffer.from("12345678901234567890");
  const vectors: Array<[number, string]> = [
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ];
  it.each(vectors)("t=%i → %s", (t, expected) => {
    expect(hotp(secret, BigInt(Math.floor(t / 30)), 8)).toBe(expected);
  });

  it("base32 round-trips", () => {
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it("verifies within ±1 step and prevents replay", () => {
    const s = generateTotpSecret();
    const now = 1_800_000_000_000;
    const code = totp(s, now);
    const step = verifyTotp(s, code, { nowMs: now });
    expect(step).not.toBeNull();
    expect(verifyTotp(s, code, { nowMs: now + 30_000 })).toBe(step); // previous step still in window
    expect(verifyTotp(s, code, { nowMs: now + 90_000 })).toBeNull(); // out of window
    expect(verifyTotp(s, code, { nowMs: now, lastUsedStep: step })).toBeNull(); // replay
    expect(verifyTotp(s, "12345", { nowMs: now })).toBeNull();
  });
});

describe("tokens", () => {
  it("recovery codes have the expected shape and normalize", () => {
    const c = generateRecoveryCode();
    expect(c).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizeRecoveryCode(c.toLowerCase())).toBe(c.replace(/-/g, ""));
  });
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("ipPrefix keeps only the network prefix", () => {
    expect(ipPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(ipPrefix(undefined)).toBeNull();
  });
});

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe(true);
  });
});
