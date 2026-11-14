import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ModulesContainer } from "@nestjs/core";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { ADMIN_API, INFRA, PUBLIC } from "../../src/common/context.js";
import { Client, inviteAndAccept, startHarness, userWithOrg, verifiedUser, type Harness } from "../helpers/harness.js";

let h: Harness;
let A: Awaited<ReturnType<typeof userWithOrg>>;
let B: Awaited<ReturnType<typeof userWithOrg>>;

interface Route { method: string; path: string; public: boolean; admin: boolean; infra: boolean }

/** Every HTTP route registered in the application, read from Nest metadata. */
function discoverRoutes(): Route[] {
  const routes: Route[] = [];
  for (const mod of h.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!ctrl) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? "");
      const ctrlAdmin = Boolean(Reflect.getMetadata(ADMIN_API, ctrl));
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (method === undefined || sub === undefined) continue;
        const path = `/${[base, sub].map((p) => p.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
        routes.push({
          method: RequestMethod[method],
          path,
          public: Boolean(Reflect.getMetadata(PUBLIC, handler)),
          admin: ctrlAdmin,
          infra: Boolean(Reflect.getMetadata(INFRA, handler)),
        });
      }
    }
  }
  return routes;
}

function fill(path: string, orgId: string) {
  return path.replace(":orgId", orgId).replace(/:[A-Za-z]+/g, () => randomUUID());
}

beforeAll(async () => {
  h = await startHarness();
  A = await userWithOrg(h.app, "tenantA");
  B = await userWithOrg(h.app, "tenantB");
});
afterAll(async () => { await h.stop(); });

describe("route-level tenant isolation (automatically covers every org-scoped route)", () => {
  it("discovers the org-scoped surface", () => {
    const orgRoutes = discoverRoutes().filter((r) => r.path.includes(":orgId"));
    expect(orgRoutes.length).toBeGreaterThanOrEqual(42); // 18 in Phase 2 + 24 website/transfer routes in Phase 3
  });

  it("every :orgId route returns 404 to a non-member — indistinguishable from a missing org", async () => {
    const orgRoutes = discoverRoutes().filter((r) => r.path.includes(":orgId") && !r.admin);
    const failures: string[] = [];
    for (const r of orgRoutes) {
      for (const [actor, foreignOrg] of [[B.client, A.orgId], [A.client, B.orgId], [A.client, randomUUID()]] as const) {
        const res = await actor.request(r.method, fill(r.path, foreignOrg), r.method === "GET" ? undefined : {});
        if (res.status !== 404 || res.body?.error?.code !== "NOT_FOUND") failures.push(`${r.method} ${r.path} → ${res.status} ${res.body?.error?.code}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("a malformed org id is a 404, never a 500", async () => {
    const r = await A.client.get("/api/v1/orgs/not-a-uuid/members");
    expect(r.status).toBe(404);
  });

  it("every non-public customer route requires a session", async () => {
    const anon = Client.customer(h.app);
    const failures: string[] = [];
    for (const r of discoverRoutes().filter((x) => !x.public && !x.admin && !x.infra)) {
      const res = await anon.request(r.method, fill(r.path, A.orgId), r.method === "GET" ? undefined : {});
      if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("the set of public routes is exactly the reviewed allow-list", () => {
    const pub = discoverRoutes().filter((r) => r.public).map((r) => `${r.method} ${r.path}`).sort();
    expect(pub).toEqual([
      "GET /api/admin/v1/auth/csrf",
      "GET /api/v1/artifact-downloads", // Phase 4D: bearer link — 5-min HMAC token bound to artifact + org, re-checked under that org's RLS
      "GET /api/v1/auth/csrf",
      "GET /api/v1/invitations/preview",
      "GET /api/v1/public/config",
      "POST /api/admin/v1/auth/login",
      "POST /api/v1/auth/2fa/reset/cancel",
      "POST /api/v1/auth/2fa/reset/confirm",
      "POST /api/v1/auth/login",
      "POST /api/v1/auth/password/forgot",
      "POST /api/v1/auth/password/reset",
      "POST /api/v1/auth/register",
      "POST /api/v1/auth/verify-email",
    ]);
  });

  it("admin routes reject customer sessions", async () => {
    const failures: string[] = [];
    // A customer session cookie presented to the admin API, from the admin origin.
    const imposter = Client.admin(h.app);
    imposter.cookies.set("wim_sid", A.client.cookies.get("wim_sid")!);
    for (const r of discoverRoutes().filter((x) => x.admin && !x.public)) {
      const res = await imposter.request(r.method, fill(r.path, A.orgId), r.method === "GET" ? undefined : {});
      if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("resource-level isolation inside an org route", () => {
  it("ids belonging to another tenant are 404 even under the caller's own org", async () => {
    const bMembers = (await B.client.get(`/api/v1/orgs/${B.orgId}/members`)).body.data;
    const bRole = await B.client.post(`/api/v1/orgs/${B.orgId}/roles`, { name: "B only", permissions: ["org:read"] });
    const viewerB = (await B.client.get(`/api/v1/orgs/${B.orgId}/roles`)).body.data.find((r: { key: string }) => r.key === "VIEWER").id;
    const bInvite = await B.client.post(`/api/v1/orgs/${B.orgId}/invitations`, { email: "someone@example.test", roleId: viewerB });
    const checks = [
      await A.client.patch(`/api/v1/orgs/${A.orgId}/members/${bMembers[0].id}`, { roleId: viewerB }),
      await A.client.del(`/api/v1/orgs/${A.orgId}/members/${bMembers[0].id}`),
      await A.client.patch(`/api/v1/orgs/${A.orgId}/roles/${bRole.body.data.id}`, { name: "pwned" }),
      await A.client.del(`/api/v1/orgs/${A.orgId}/roles/${bRole.body.data.id}`),
      await A.client.del(`/api/v1/orgs/${A.orgId}/invitations/${bInvite.body.data.id}`),
      await A.client.post(`/api/v1/orgs/${A.orgId}/invitations/${bInvite.body.data.id}/resend`),
      await A.client.post(`/api/v1/orgs/${A.orgId}/transfer-ownership`, { memberId: bMembers[0].id }),
    ];
    expect(checks.map((c) => c.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    // Assigning org B's custom role inside org A is refused.
    const aMember = await verifiedUser(h.app, "tenantAmember");
    const m = await inviteAndAccept(A.client, A.orgId, aMember, "VIEWER");
    expect((await A.client.patch(`/api/v1/orgs/${A.orgId}/members/${m.id}`, { roleId: bRole.body.data.id })).status).toBe(404);
    expect((await B.client.get(`/api/v1/orgs/${B.orgId}/roles`)).body.data.find((r: { id: string }) => r.id === bRole.body.data.id).name).toBe("B only");
  });

  it("audit logs never mix tenants", async () => {
    const aLog = (await A.client.get(`/api/v1/orgs/${A.orgId}/audit-logs`)).body.data;
    expect(aLog.length).toBeGreaterThan(0);
    const { rows } = await h.owner.query("SELECT id::text FROM audit_logs WHERE org_id = $1", [B.orgId]);
    const bIds = new Set(rows.map((r) => r.id));
    expect(aLog.filter((e: { id: string }) => bIds.has(e.id))).toEqual([]);
  });
});

describe("database-level isolation (RLS, as the API's own role)", () => {
  let app: pg.Client;
  beforeAll(async () => {
    app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  });
  afterAll(async () => { await app.end(); });

  async function asTenant<T>(orgId: string, userId: string | null, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      if (userId) await app.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      return await app.query(sql, params);
    } finally {
      await app.query("ROLLBACK");
    }
  }

  it("with org A's context, org B's rows are invisible in every tenant table", async () => {
    for (const table of ["organizations", "organization_members", "invitations", "org_encryption_keys", "roles"]) {
      const col = table === "organizations" ? "id" : "org_id";
      const r = await asTenant(A.orgId, null, `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [B.orgId]);
      expect(r.rows[0].n, table).toBe(0);
    }
    const audit = await asTenant(A.orgId, A.userId, "SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1", [B.orgId]);
    expect(audit.rows[0].n).toBe(0);
  });

  it("without any context the API role sees no tenant rows at all", async () => {
    const r = await app.query("SELECT (SELECT count(*) FROM organization_members)::int AS m, (SELECT count(*) FROM organizations)::int AS o, (SELECT count(*) FROM user_sessions)::int AS s, (SELECT count(*) FROM audit_logs)::int AS a");
    expect(r.rows[0]).toEqual({ m: 0, o: 0, s: 0, a: 0 });
  });

  it("cannot write into another tenant", async () => {
    await expect(asTenant(A.orgId, null, "UPDATE organizations SET name = 'x' WHERE id = $1 RETURNING id", [B.orgId]).then((r) => r.rowCount)).resolves.toBe(0);
    await expect(asTenant(A.orgId, null, "INSERT INTO invitations (org_id, email, role_id, token_hash, invited_by_id, expires_at) SELECT $1, 'x@example.test', id, md5(random()::text), $2, now() + interval '1 day' FROM roles WHERE key = 'VIEWER' AND org_id IS NULL", [B.orgId, A.userId]))
      .rejects.toThrow(/row-level security/);
  });

  it("system role permissions cannot be altered by the API role", async () => {
    const r = await asTenant(A.orgId, null, "DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE key = 'VIEWER' AND org_id IS NULL)");
    expect(r.rowCount).toBe(0);
    await expect(asTenant(A.orgId, null, "INSERT INTO role_permissions SELECT id, 'billing:manage' FROM roles WHERE key = 'VIEWER' AND org_id IS NULL"))
      .rejects.toThrow(/row-level security/);
  });

  it("app_enter_org refuses non-members and missing permissions", async () => {
    await expect(app.query("SELECT app_enter_org($1, $2, NULL)", [B.orgId, A.userId])).rejects.toThrow(/wim:not_member/);
    const viewer = await verifiedUser(h.app, "dbviewer");
    await inviteAndAccept(A.client, A.orgId, viewer, "VIEWER");
    await expect(app.query("SELECT app_enter_org($1, $2, 'member:manage')", [A.orgId, viewer.userId])).rejects.toThrow(/wim:missing_permission/);
    await app.query("BEGIN");
    expect((await app.query("SELECT app_enter_org($1, $2, 'member:read') AS role", [A.orgId, viewer.userId])).rows[0].role).toBe("VIEWER");
    await app.query("ROLLBACK");
  });

  it("user-scoped rows (sessions, recovery codes) are isolated per user", async () => {
    const r = await asTenant(A.orgId, A.userId, "SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1", [B.userId]);
    expect(r.rows[0].n).toBe(0);
    const own = await asTenant(A.orgId, A.userId, "SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1", [A.userId]);
    expect(own.rows[0].n).toBeGreaterThan(0);
  });
});
