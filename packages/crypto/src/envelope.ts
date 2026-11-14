import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Ciphertext layout (all *_enc columns):
 *   [0]      format version (0x01)
 *   [1..4]   DEK version, uint32 BE (selects the data key used)
 *   [5..16]  IV (12 bytes)
 *   [17..32] GCM auth tag (16 bytes)
 *   [33..]   ciphertext
 * AAD binds the ciphertext to its location (e.g. "users.totp:<userId>") so a value
 * copied into another row or column fails authentication.
 */
const FORMAT_V1 = 0x01;
const HEADER = 1 + 4 + 12 + 16;

export function seal(dek: Buffer, dekVersion: number, plaintext: Buffer | string, aad: string): Buffer {
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  const header = Buffer.alloc(5);
  header.writeUInt8(FORMAT_V1, 0);
  header.writeUInt32BE(dekVersion, 1);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

/** The DEK version a ciphertext was sealed with (to look up the right key). */
export function sealedKeyVersion(blob: Buffer): number {
  if (blob.length < HEADER || blob.readUInt8(0) !== FORMAT_V1) throw new Error("Unsupported ciphertext format");
  return blob.readUInt32BE(1);
}

export function open(dek: Buffer, blob: Buffer, aad: string): Buffer {
  sealedKeyVersion(blob);
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(HEADER)), decipher.final()]);
}

export function openString(dek: Buffer, blob: Buffer, aad: string): string {
  return open(dek, blob, aad).toString("utf8");
}
