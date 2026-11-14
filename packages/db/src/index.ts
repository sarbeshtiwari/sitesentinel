import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/client.js";

export * from "./generated/client.js";
export type { Prisma };

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export interface CreateDbOptions {
  url: string;
  /** Pool size per process. */
  max?: number;
  /** Hide write-only secret columns from every query (required for the wim_app role, D-12). */
  omitSecrets?: boolean;
}

/**
 * Columns the API role may write but never read (050_grants.sql column grants).
 * Omitting them globally means `SELECT *`-style Prisma queries and `RETURNING`
 * clauses stay within the granted column set.
 */
const SECRET_OMIT = {
  apiCredential: { secretEnc: true },
  authRecipe: { credentialsEnc: true },
  notificationChannel: { configEnc: true },
} as const;

export function createDb(opts: CreateDbOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: opts.url, max: opts.max ?? 10 });
  return new PrismaClient(opts.omitSecrets ? { adapter, omit: SECRET_OMIT } : { adapter });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Run `fn` in a transaction whose RLS context is `orgId` (020_rls.sql).
 * Every tenant-scoped query MUST go through this (or withSystem in workers);
 * application-level `where: { orgId }` filters are kept as the first layer.
 */
export async function withTenant<T>(
  db: PrismaClient,
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  if (!isUuid(orgId)) throw new Error("withTenant: orgId must be a uuid");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return fn(tx);
  }, { timeout: opts?.timeout ?? 15_000, isolationLevel: opts?.isolationLevel });
}

export class MembershipError extends Error {
  constructor(readonly reason: "not_member" | "missing_permission") {
    super(reason);
    this.name = "MembershipError";
  }
}

/**
 * The customer API's way into a tenant: the database verifies (app_enter_org,
 * 060_identity.sql) that `userId` is a member of `orgId` holding `permission`
 * before setting the RLS context. Throws MembershipError otherwise.
 */
export async function withMember<T>(
  db: PrismaClient,
  scope: { orgId: string; userId: string; permission?: string },
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  if (!isUuid(scope.orgId) || !isUuid(scope.userId)) throw new MembershipError("not_member");
  return db.$transaction(async (tx) => {
    try {
      await tx.$queryRaw`SELECT app_enter_org(${scope.orgId}::uuid, ${scope.userId}::uuid, ${scope.permission ?? null}::text)`;
    } catch (e) {
      const msg = String((e as Error).message ?? "");
      if (msg.includes("wim:not_member")) throw new MembershipError("not_member");
      if (msg.includes("wim:missing_permission")) throw new MembershipError("missing_permission");
      throw e;
    }
    return fn(tx);
  }, { timeout: opts?.timeout ?? 15_000, isolationLevel: opts?.isolationLevel });
}

/**
 * Run `fn` with a user context (user-scoped RLS on sessions, recovery codes,
 * recovery requests, audit user streams — 060_identity.sql). `orgId` may be
 * added for statements that are both user- and org-scoped (notifications).
 */
export async function withUser<T>(
  db: PrismaClient,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  opts?: { orgId?: string },
): Promise<T> {
  if (!isUuid(userId)) throw new Error("withUser: userId must be a uuid");
  if (opts?.orgId !== undefined && !isUuid(opts.orgId)) throw new Error("withUser: orgId must be a uuid");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    if (opts?.orgId) await tx.$queryRaw`SELECT set_config('app.current_org_id', ${opts.orgId}, true)`;
    return fn(tx);
  }, { timeout: 15_000 });
}

/**
 * Cross-tenant system context. Only effective for the wim_worker role (the
 * system_access policies are TO wim_worker); for any other role it grants nothing.
 */
export async function withSystem<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.system', 'on', true)`;
    return fn(tx);
  }, { timeout: 30_000 });
}

import { resolveSettings, type SettingsSnapshot } from "@wim/core";

/** Read platform settings merged over registry defaults (invalid rows fall back to defaults). */
export async function loadSettings(
  db: PrismaClient | Tx,
  onInvalid?: (key: string, error: unknown) => void,
): Promise<SettingsSnapshot> {
  const rows = await db.platformSetting.findMany({ select: { key: true, value: true } });
  return resolveSettings(rows, onInvalid);
}

/**
 * Release readiness (blockers 3 and 6): startup validation of a worker's database credentials. Refuses to start when
 * the connection is not the expected least-privilege role, when that role can bypass RLS or is a superuser, or — in
 * production — when the development password still works for it. Never logs the URL or the password.
 */
export async function assertDatabaseRole(
  db: PrismaClient,
  expected: string,
  o: { production: boolean; log?: { info: (o: object, m: string) => void }; devPassword?: string; url?: string },
): Promise<void> {
  const [r] = await db.$queryRaw<Array<{ who: string; super: boolean; bypass: boolean }>>`
    SELECT current_user AS who, r.rolsuper AS super, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`;
  if (!r) throw new Error("database role check failed");
  if (r.who !== expected) throw new Error(`database role must be ${expected} (connected as ${r.who})`);
  if (r.super || r.bypass) throw new Error(`database role ${expected} must not be superuser or BYPASSRLS`);
  if (o.production && o.url) {
    const u = new URL(o.url);
    const dev = o.devPassword ?? `${expected}_dev_password`;
    if (decodeURIComponent(u.password) === dev) throw new Error(`development credentials for ${expected} are not accepted in production`);
    if (!/^(require|verify-ca|verify-full)$/.test(u.searchParams.get("sslmode") ?? "")) throw new Error(`production database connections for ${expected} must use sslmode=require or stricter`);
  }
  o.log?.info({ role: expected }, "database role verified");
}
