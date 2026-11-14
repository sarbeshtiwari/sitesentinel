import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { totp } from "@wim/crypto";
import { Client, createAdmin, startHarness, totpCode, userWithOrg, type Harness } from "../helpers/harness.js";

let h: Harness;
let superAdmin: Awaited<ReturnType<typeof createAdmin>>;
let sa: Client;

async function adminLogin(admin: { email: string; password: string; secret: string }, fresh = false) {
  const c = Client.admin(h.app);
  const r = await c.post("/api/admin/v1/auth/login", { email: admin.email, password: admin.password, code: await totpCode(admin.secret, fresh) });
  if (r.status !== 200 && !fresh) console.error("admin login failed", r.status, JSON.stringify(r.body));
  return { c, r };
}

beforeAll(async () => {
  h = await startHarness();
  superAdmin = await createAdmin("SUPER_ADMIN");
  const { c, r } = await adminLogin(superAdmin);
  expect(r.status).toBe(200);
  sa = c;
});
afterAll(async () => { await h.stop(); });

describe("admin authentication", () => {
  it("requires password AND a valid TOTP code; replayed codes are rejected", async () => {
    const a = await createAdmin("ADMIN_SUPPORT");
    const noCode = await Client.admin(h.app).post("/api/admin/v1/auth/login", { email: a.email, password: a.password });
    expect(noCode.status).toBe(400);
    const wrong = await Client.admin(h.app).post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code: "000000" });
    expect(wrong.status).toBe(401);
    const badPw = await Client.admin(h.app).post("/api/admin/v1/auth/login", { email: a.email, password: "nope-nope-nope-nope", code: totp(a.secret) });
    expect(badPw.status).toBe(401);
    const code = totp(a.secret);
    const ok = await Client.admin(h.app).post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.role).toBe("ADMIN_SUPPORT");
    const replay = await Client.admin(h.app).post("/api/admin/v1/auth/login", { email: a.email, password: a.password, code });
    expect(replay.status).toBe(401);
    const { rows } = await h.owner.query("SELECT count(*)::int AS n FROM security_events WHERE kind = 'ADMIN_LOGIN_FAILED' AND actor_ref = $1", [a.id]);
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it("admin sessions use a separate SameSite=Strict cookie and cannot call customer routes", async () => {
    const setCookie = (await Client.admin(h.app).get("/api/admin/v1/auth/csrf")).headers["set-cookie"];
    expect(String(setCookie)).toMatch(/wim_admin_csrf=.*SameSite=Strict/i);
    const imposter = Client.customer(h.app);
    imposter.cookies.set("wim_admin_sid", sa.cookies.get("wim_admin_sid")!);
    expect((await imposter.get("/api/v1/me")).status).toBe(401);
    expect((await imposter.get("/api/v1/orgs")).status).toBe(401);
  });

  it("admin mutations need the admin origin (CSRF/origin separation)", async () => {
    const r = await sa.patch("/api/admin/v1/settings", { changes: [{ key: "branding.productName", value: "X" }], reason: "test reason" });
    expect(r.status).toBe(200); // control
    const cross = await sa.request("PATCH", "/api/admin/v1/settings", { changes: [{ key: "branding.productName", value: "SiteSentinel" }], reason: "restore it" }, { headers: { origin: process.env.APP_URL! } });
    expect(cross.status).toBe(403);
    await sa.patch("/api/admin/v1/settings", { changes: [{ key: "branding.productName", value: "SiteSentinel" }], reason: "restore it" });
  });

  it("logout revokes the admin session", async () => {
    const { c } = await adminLogin(await createAdmin("ADMIN_AUDITOR"));
    const copy = c.clone();
    expect((await c.post("/api/admin/v1/auth/logout")).status).toBe(204);
    expect((await copy.get("/api/admin/v1/me")).status).toBe(401);
  });
});

describe("platform statistics without customer content", () => {
  it("overview returns aggregate counts that match the database", async () => {
    await userWithOrg(h.app, "statsorg");
    const r = await sa.get("/api/admin/v1/overview");
    expect(r.status).toBe(200);
    const { rows } = await h.owner.query("SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM organizations)::int AS orgs");
    expect(r.body.data.users.total).toBe(rows[0].users);
    expect(r.body.data.organizations.total).toBe(rows[0].orgs);
    expect(r.body.data.signupsDaily).toHaveLength(30);
    // Only numbers: no emails, names or ids anywhere in the payload.
    const text = JSON.stringify(r.body.data);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("customer list shows metadata with masked owner emails", async () => {
    const o = await userWithOrg(h.app, "maskme");
    const r = await sa.get(`/api/admin/v1/customers?q=maskme`);
    const row = r.body.data.find((x: { id: string }) => x.id === o.orgId);
    expect(row.memberCount).toBe(1);
    expect(row.ownerEmailMasked).toMatch(/^m\*\*\*@e\*\*\*\.test$/);
    expect(JSON.stringify(r.body)).not.toContain(o.email);
  });

  it("the admin database role cannot read customer content tables", async () => {
    const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await admin.connect();
    try {
      for (const table of ["users", "organization_members", "incidents", "api_credentials", "user_sessions", "recovery_codes", "sdk_events", "page_test_results", "invitations"]) {
        await expect(admin.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toThrow(/permission denied/);
      }
      const stats = await admin.query("SELECT users_total FROM admin_v_platform_stats");
      expect(stats.rowCount).toBe(1);
    } finally {
      await admin.end();
    }
  });

  it("permissions are enforced per admin role", async () => {
    const auditor = await adminLogin(await createAdmin("ADMIN_AUDITOR"));
    expect((await auditor.c.get("/api/admin/v1/overview")).status).toBe(403);
    expect((await auditor.c.get("/api/admin/v1/customers")).status).toBe(403);
    expect((await auditor.c.get("/api/admin/v1/audit-logs")).status).toBe(200);
    const support = await adminLogin(await createAdmin("ADMIN_SUPPORT"));
    expect((await support.c.get("/api/admin/v1/settings")).status).toBe(200);
    expect((await support.c.patch("/api/admin/v1/settings", { changes: [{ key: "trial.days", value: 45 }], reason: "should be denied" })).status).toBe(403);
  });
});

describe("operational settings (database-backed, audited, hot-reloaded)", () => {
  it("rebrands globally without code changes; the change is visible immediately and audited with a reason", async () => {
    const customer = Client.customer(h.app);
    expect((await customer.get("/api/v1/public/config")).body.data.productName).toBe("SiteSentinel");
    const r = await sa.patch("/api/admin/v1/settings", { changes: [{ key: "branding.productName", value: "Acme Watch" }, { key: "branding.primaryColor", value: "#0f766e" }], reason: "Rebrand for pilot customer" });
    expect(r.status).toBe(200);
    const cfg = (await customer.get("/api/v1/public/config")).body.data;
    expect(cfg).toMatchObject({ productName: "Acme Watch", primaryColor: "#0f766e" });
    const audit = (await sa.get("/api/admin/v1/audit-logs?stream=platform")).body.data;
    const entry = audit.find((a: { action: string; targetId: string }) => a.action === "admin.setting_changed" && a.targetId === "branding.productName");
    expect(entry).toMatchObject({ reason: "Rebrand for pilot customer", changes: { from: "SiteSentinel", to: "Acme Watch" } });
    const history = await h.owner.query("SELECT count(*)::int AS n FROM platform_setting_history WHERE key = 'branding.productName'");
    expect(history.rows[0].n).toBeGreaterThanOrEqual(1);
    await sa.patch("/api/admin/v1/settings", { changes: [{ key: "branding.productName", value: "SiteSentinel" }, { key: "branding.primaryColor", value: "#4f46e5" }], reason: "Restore default branding" });
  });

  it("validates values, requires a reason, and rejects unknown keys", async () => {
    expect((await sa.patch("/api/admin/v1/settings", { changes: [{ key: "trial.days", value: 0 }], reason: "invalid value" })).status).toBe(400);
    expect((await sa.patch("/api/admin/v1/settings", { changes: [{ key: "trial.days", value: 30 }] })).status).toBe(400);
    expect((await sa.patch("/api/admin/v1/settings", { changes: [{ key: "nope.key", value: 1 }], reason: "unknown key" })).status).toBe(400);
    expect((await sa.patch("/api/admin/v1/settings", { changes: [{ key: "auth.password.minLength", value: 8 }], reason: "below the floor" })).status).toBe(400);
  });

  it("verifies the platform audit chain", async () => {
    const r = await sa.post("/api/admin/v1/audit-logs/verify-chain", { stream: "platform" });
    expect(r.body.data).toMatchObject({ valid: true, firstBrokenSeq: null });
    expect(r.body.data.checked).toBeGreaterThan(0);
  });
});
