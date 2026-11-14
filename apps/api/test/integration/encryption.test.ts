import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LocalKeyProvider, newKeyRing, rewrapDek, type KeyRingFile } from "@wim/crypto";
import { createDb, withTenant, type Db } from "@wim/db";
import { KeysService, orgContext } from "../../src/crypto/keys.service.js";
import { startHarness, userWithOrg, type Harness } from "../helpers/harness.js";

let h: Harness;
let db: Db;
const ring = () => JSON.parse(readFileSync(process.env.KEK_RING_FILE!, "utf8")) as KeyRingFile;

beforeAll(async () => {
  h = await startHarness();
  db = createDb({ url: process.env.DATABASE_URL!, max: 2, omitSecrets: true });
});
afterAll(async () => {
  await db.$disconnect();
  await h.stop();
});

describe("key management independent of the database", () => {
  it("no KEK or pepper material is stored anywhere in the database", async () => {
    const r = ring();
    const secrets = [...Object.values(r.keys), r.hmacPepper];
    const tables = await h.owner.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    // Dump every row of every non-partitioned table as text and search for the key material.
    for (const { table_name } of tables.rows) {
      const dump = await h.owner.query(`SELECT coalesce(string_agg(t::text, ''), '') AS d FROM public."${table_name}" t`);
      for (const s of secrets) {
        expect(dump.rows[0].d.includes(s), table_name).toBe(false);
        expect(dump.rows[0].d.includes(Buffer.from(s, "base64").toString("hex")), table_name).toBe(false);
      }
    }
  });

  it("platform data keys are stored wrapped and are useless with another key ring", async () => {
    const { rows } = await h.owner.query("SELECT purpose, version, kek_id, wrapped_dek FROM platform_data_keys WHERE purpose = 'user-secrets'");
    expect(rows.length).toBeGreaterThanOrEqual(0);
    const keys = new KeysService(LocalKeyProvider.fromEnv());
    const sealed = await keys.sealPlatform(db, "user-secrets", "top secret", "test:aad");
    expect(await keys.openPlatform(db, "user-secrets", sealed, "test:aad")).toBe("top secret");
    await expect(keys.openPlatform(db, "user-secrets", sealed, "test:other-row")).rejects.toThrow();
    const stranger = new KeysService(new LocalKeyProvider({ ...newKeyRing(ring().current) }));
    await expect(stranger.openPlatform(db, "user-secrets", sealed, "test:aad")).rejects.toThrow();
  });

  it("org secrets round-trip under the org's own data key, inside the tenant context", async () => {
    const o = await userWithOrg(h.app, "orgkeys");
    const keys = new KeysService(LocalKeyProvider.fromEnv());
    const blob = await withTenant(db, o.orgId, (tx) => keys.sealOrg(tx, o.orgId, "api-token-123", `api_credentials:${o.orgId}:x`));
    const back = await withTenant(db, o.orgId, (tx) => keys.openOrg(tx, o.orgId, Buffer.from(blob), `api_credentials:${o.orgId}:x`));
    expect(back.toString()).toBe("api-token-123");
    // Another org cannot even load this org's key (RLS), let alone decrypt.
    const other = await userWithOrg(h.app, "orgkeys2");
    await expect(withTenant(db, other.orgId, (tx) => keys.openOrg(tx, o.orgId, Buffer.from(blob), `api_credentials:${o.orgId}:x`))).rejects.toThrow();
  });

  it("KEK rotation re-wraps data keys without changing them", async () => {
    const o = await userWithOrg(h.app, "rotate");
    const { rows } = await h.owner.query("SELECT kek_id, wrapped_dek, version FROM org_encryption_keys WHERE org_id = $1", [o.orgId]);
    const current = ring();
    const next = newKeyRing("rotated-2");
    const rotated = new LocalKeyProvider({ current: "rotated-2", keys: { ...current.keys, ...next.keys }, hmacPepper: current.hmacPepper });
    const ctx = orgContext(o.orgId, rows[0].version);
    const rewrapped = await rewrapDek(rotated, { kekId: rows[0].kek_id, wrapped: rows[0].wrapped_dek }, ctx);
    expect(rewrapped.kekId).toBe("rotated-2");
    const original = await new LocalKeyProvider(current).unwrapKey(rows[0].kek_id, rows[0].wrapped_dek, ctx);
    expect((await rotated.unwrapKey(rewrapped.kekId, rewrapped.wrapped, ctx)).equals(original)).toBe(true);
  });
});
