import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { generateDek, LocalKeyProvider, open, openString, seal, sealedKeyVersion, type KeyProvider } from "@wim/crypto";
import type { Db, Tx } from "@wim/db";
import { isPrismaUniqueViolation } from "../common/error.filter.js";

export const KEY_PROVIDER = Symbol("KEY_PROVIDER");

export type PlatformKeyPurpose = "user-secrets" | "admin-secrets" | "platform-config";

interface CachedKey { dek: Buffer; version: number; expires: number }
const CACHE_MS = 10 * 60_000;

/**
 * Envelope-encryption service (ARCHITECTURE.md D-11).
 *  - KEKs live in the KeyProvider (key ring file / KMS), never in the database.
 *  - Data keys (DEKs) are stored wrapped in platform_data_keys / org_encryption_keys.
 *  - Unwrapped DEKs are cached in memory briefly; they are never logged or persisted.
 */
@Injectable()
export class KeysService {
  private readonly platform = new Map<string, CachedKey>();
  private readonly org = new Map<string, CachedKey>();

  constructor(@Inject(KEY_PROVIDER) readonly provider: KeyProvider) {}

  hmacKey(purpose: string): Buffer {
    return this.provider.hmacKey(purpose);
  }

  // ---------------------------------------------------------------- platform keys
  async sealPlatform(db: Db | Tx, purpose: PlatformKeyPurpose, plaintext: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
    const k = await this.activePlatformKey(db, purpose);
    return bytes(seal(k.dek, k.version, plaintext, aad));
  }

  async openPlatform(db: Db | Tx, purpose: PlatformKeyPurpose, blob: Buffer | Uint8Array, aad: string): Promise<string> {
    const buf = Buffer.from(blob);
    const dek = await this.platformKeyVersion(db, purpose, sealedKeyVersion(buf));
    return openString(dek, buf, aad);
  }

  private async activePlatformKey(db: Db | Tx, purpose: PlatformKeyPurpose): Promise<{ dek: Buffer; version: number }> {
    const cacheKey = `${purpose}:active`;
    const hit = this.platform.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit;
    let row = await db.platformDataKey.findFirst({ where: { purpose, active: true }, orderBy: { version: "desc" } });
    if (!row) {
      const dek = generateDek();
      const { kekId, wrapped } = await this.provider.wrapKey(dek, platformContext(purpose, 1));
      try {
        row = await db.platformDataKey.create({ data: { purpose, version: 1, kekId, wrappedDek: bytes(wrapped) } });
      } catch (e) {
        if (!isPrismaUniqueViolation(e)) throw e; // another process created it first
        row = await db.platformDataKey.findFirstOrThrow({ where: { purpose, active: true }, orderBy: { version: "desc" } });
      }
    }
    const dek = await this.provider.unwrapKey(row.kekId, Buffer.from(row.wrappedDek), platformContext(purpose, row.version));
    const entry = { dek, version: row.version, expires: Date.now() + CACHE_MS };
    this.platform.set(cacheKey, entry);
    this.platform.set(`${purpose}:${row.version}`, entry);
    return entry;
  }

  private async platformKeyVersion(db: Db | Tx, purpose: PlatformKeyPurpose, version: number): Promise<Buffer> {
    const hit = this.platform.get(`${purpose}:${version}`);
    if (hit && hit.expires > Date.now()) return hit.dek;
    const row = await db.platformDataKey.findUniqueOrThrow({ where: { purpose_version: { purpose, version } } });
    const dek = await this.provider.unwrapKey(row.kekId, Buffer.from(row.wrappedDek), platformContext(purpose, version));
    this.platform.set(`${purpose}:${version}`, { dek, version, expires: Date.now() + CACHE_MS });
    return dek;
  }

  // ---------------------------------------------------------------- org keys
  /** Create the first data key for a new org (inside the org-creation tenant transaction). */
  async createOrgKey(tx: Tx, orgId: string): Promise<void> {
    const dek = generateDek();
    const { kekId, wrapped } = await this.provider.wrapKey(dek, orgContext(orgId, 1));
    await tx.orgEncryptionKey.create({ data: { orgId, version: 1, kekId, wrappedDek: bytes(wrapped) } });
    dek.fill(0);
  }

  /** Seal an org-scoped secret. `tx` must be a tenant transaction for orgId (RLS). */
  async sealOrg(tx: Tx, orgId: string, plaintext: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
    const row = await tx.orgEncryptionKey.findFirstOrThrow({ where: { orgId, active: true }, orderBy: { version: "desc" } });
    const dek = await this.orgKey(orgId, row);
    return bytes(seal(dek, row.version, plaintext, aad));
  }

  async openOrg(tx: Tx, orgId: string, blob: Buffer, aad: string): Promise<Buffer> {
    const version = sealedKeyVersion(blob);
    const row = await tx.orgEncryptionKey.findUniqueOrThrow({ where: { orgId_version: { orgId, version } } });
    return open(await this.orgKey(orgId, row), blob, aad);
  }

  private async orgKey(orgId: string, row: { version: number; kekId: string; wrappedDek: Uint8Array }): Promise<Buffer> {
    const key = `${orgId}:${row.version}`;
    const hit = this.org.get(key);
    if (hit && hit.expires > Date.now()) return hit.dek;
    const dek = await this.provider.unwrapKey(row.kekId, Buffer.from(row.wrappedDek), orgContext(orgId, row.version));
    this.org.set(key, { dek, version: row.version, expires: Date.now() + CACHE_MS });
    return dek;
  }

  /** Drop cached DEKs (after rotation or crypto-shredding). */
  clearCache(): void {
    for (const c of [...this.platform.values(), ...this.org.values()]) c.dek.fill(0);
    this.platform.clear();
    this.org.clear();
  }
}

/** Copy into a plain ArrayBuffer-backed Uint8Array (the type Prisma uses for Bytes columns). */
function bytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

export const platformContext = (purpose: string, version: number) => `platform:${purpose}:v${version}`;
export const orgContext = (orgId: string, version: number) => `org:${orgId}:v${version}`;

@Global()
@Module({
  providers: [{ provide: KEY_PROVIDER, useFactory: () => LocalKeyProvider.fromEnv() }, KeysService],
  exports: [KeysService, KEY_PROVIDER],
})
export class KeysModule {}
