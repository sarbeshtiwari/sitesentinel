import { hash, verify } from "@node-rs/argon2";

/** Argon2id, m = 64 MiB, t = 3, p = 1 (SECURITY.md §7.1). Parameters live in the encoded hash. */
export const ARGON2_PARAMS = {
  algorithm: 2, // Algorithm.Argon2id (const enum; inlined for isolatedModules)
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than current policy (rehash on next login). */
export function needsRehash(encoded: string): boolean {
  const m = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  if (!m) return true;
  return Number(m[1]) < ARGON2_PARAMS.memoryCost || Number(m[2]) < ARGON2_PARAMS.timeCost;
}

let dummyHash: Promise<string> | undefined;
/**
 * Verify against a fixed dummy hash when the account doesn't exist, so response
 * time does not reveal whether an email is registered.
 */
export async function burnPasswordVerification(password: string): Promise<void> {
  dummyHash ??= hashPassword("wim-dummy-password-for-timing-equalization");
  await verifyPassword(await dummyHash, password);
}
