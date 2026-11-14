import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * A KeyProvider holds key-encryption keys (KEKs) OUTSIDE the database and only
 * ever wraps/unwraps data keys (DEKs). Rows in the DB hold wrapped DEKs; without
 * the provider they are useless (ARCHITECTURE.md D-11).
 *
 * Implementations: LocalKeyProvider (key file / env, for VPS & dev). A KMS-backed
 * provider (AWS KMS ap-south-1) implements the same interface in Phase 10.
 */
export interface KeyProvider {
  readonly currentKekId: string;
  wrapKey(dek: Buffer, context: string): Promise<{ kekId: string; wrapped: Buffer }>;
  unwrapKey(kekId: string, wrapped: Buffer, context: string): Promise<Buffer>;
  /** Keyed-hash secret used for HMAC signals (emails in logs, recovery codes). Never stored in the DB. */
  hmacKey(purpose: string): Buffer;
}

export interface KeyRingFile {
  /** id of the KEK used for new wraps, e.g. "local-2" */
  current: string;
  /** kekId → base64 32-byte key. Old keys stay until every DEK is re-wrapped. */
  keys: Record<string, string>;
  /** base64 ≥32-byte pepper for HMACs */
  hmacPepper: string;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export class LocalKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private readonly pepper: Buffer;
  readonly currentKekId: string;

  constructor(ring: KeyRingFile) {
    for (const [id, b64] of Object.entries(ring.keys)) {
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new Error(`KEK ${id} must be 32 bytes`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(ring.current)) throw new Error(`current KEK ${ring.current} not in key ring`);
    this.currentKekId = ring.current;
    this.pepper = Buffer.from(ring.hmacPepper, "base64");
    if (this.pepper.length < 32) throw new Error("hmacPepper must be at least 32 bytes");
  }

  /** Load from KEK_RING_FILE (path) or KEK_RING_JSON (base64-encoded JSON). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalKeyProvider {
    if (env.KEK_RING_FILE) {
      return new LocalKeyProvider(JSON.parse(readFileSync(resolveRingPath(env.KEK_RING_FILE), "utf8")) as KeyRingFile);
    }
    if (env.KEK_RING_JSON) {
      return new LocalKeyProvider(JSON.parse(Buffer.from(env.KEK_RING_JSON, "base64").toString("utf8")) as KeyRingFile);
    }
    throw new Error("No key ring configured: set KEK_RING_FILE or KEK_RING_JSON");
  }

  async wrapKey(dek: Buffer, context: string) {
    const kekId = this.currentKekId;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.kek(kekId), iv);
    cipher.setAAD(Buffer.from(`wim-kek:${kekId}:${context}`));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { kekId, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]) };
  }

  async unwrapKey(kekId: string, wrapped: Buffer, context: string) {
    const iv = wrapped.subarray(0, IV_LEN);
    const tag = wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.kek(kekId), iv);
    decipher.setAAD(Buffer.from(`wim-kek:${kekId}:${context}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(wrapped.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  }

  hmacKey(purpose: string): Buffer {
    // Domain-separated sub-keys so one purpose's HMACs can't be replayed for another.
    return Buffer.from(hkdfSync("sha256", this.pepper, Buffer.alloc(0), `wim-hmac:${purpose}`, 32));
  }

  private kek(id: string): Buffer {
    const key = this.keys.get(id);
    if (!key) throw new Error(`Unknown KEK ${id}`);
    return key;
  }
}

/** Generate a fresh random 256-bit data key. */
export function generateDek(): Buffer {
  return randomBytes(32);
}

/** Generate a new key ring file content (used by scripts/init-dev-keys.mjs and rotation). */
export function newKeyRing(id = "local-1"): KeyRingFile {
  return {
    current: id,
    keys: { [id]: randomBytes(32).toString("base64") },
    hmacPepper: randomBytes(32).toString("base64"),
  };
}

/** Re-wrap a DEK under the provider's current KEK (KEK rotation). */
export async function rewrapDek(
  provider: KeyProvider,
  rec: { kekId: string; wrapped: Buffer },
  context: string,
): Promise<{ kekId: string; wrapped: Buffer }> {
  if (rec.kekId === provider.currentKekId) return rec;
  const dek = await provider.unwrapKey(rec.kekId, rec.wrapped, context);
  try {
    return await provider.wrapKey(dek, context);
  } finally {
    dek.fill(0);
  }
}

/**
 * A relative KEK_RING_FILE (e.g. ".keys/kek.json" in the repository .env) is resolved against the working directory and
 * then its parents, so services and CLIs started from apps/<name> find the repository's key ring. Absolute paths are
 * used as given.
 */
function resolveRingPath(p: string): string {
  if (isAbsolute(p)) return p;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, p);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return p; // not found anywhere: let readFileSync report the original path
  }
}
