import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, countEmails, PASSWORD, startHarness, tokenFrom, uniqueEmail, verifiedUser, waitForEmail, type Harness } from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.stop(); });

const reg = (email: string, extra: Record<string, unknown> = {}) => ({
  email, password: PASSWORD, name: "Ana", acceptTerms: true, termsVersion: "2026-11-13", ...extra,
});

describe("registration and email verification", () => {
  it("registers, emails a single-use verification link, and verifies", async () => {
    const c = Client.customer(h.app);
    const email = uniqueEmail("reg");
    const r = await c.post("/api/v1/auth/register", reg(email));
    expect(r.status).toBe(202);
    const mail = await waitForEmail(email, "Verify your email");
    expect(mail.subject).toContain("SiteSentinel");
    const token = tokenFrom(mail.text);
    expect((await c.post("/api/v1/auth/verify-email", { token })).status).toBe(200);
    const again = await c.post("/api/v1/auth/verify-email", { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_TOKEN");
    const { rows } = await h.owner.query("SELECT email_verified_at FROM users WHERE email = $1", [email]);
    expect(rows[0].email_verified_at).not.toBeNull();
    // Only the SHA-256 of the token is stored.
    const t = await h.owner.query("SELECT token_hash FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1", [email]);
    expect(t.rows[0].token_hash).not.toContain(token);
  });

  it("does not reveal whether an email is registered (identical response; owner gets a notice)", async () => {
    const { email } = await verifiedUser(h.app, "dupe");
    const c = Client.customer(h.app);
    const r = await c.post("/api/v1/auth/register", reg(email));
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ data: { status: "VERIFICATION_SENT" } });
    await waitForEmail(email, "Sign-up attempt");
    const { rows } = await h.owner.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [email]);
    expect(rows[0].n).toBe(1);
  });

  it("enforces the password policy and the current terms version", async () => {
    const c = Client.customer(h.app);
    const short = await c.post("/api/v1/auth/register", reg(uniqueEmail("pw"), { password: "short" }));
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("VALIDATION_FAILED");
    const email = uniqueEmail("containsemail");
    const containsEmail = await c.post("/api/v1/auth/register", reg(email, { password: `${email.split("@")[0]}-and-more` }));
    expect(containsEmail.body.error.code).toBe("WEAK_PASSWORD");
    const common = await c.post("/api/v1/auth/register", reg(uniqueEmail("common"), { password: "passwordpassword" }));
    expect(common.body.error.code).toBe("WEAK_PASSWORD");
    const oldTerms = await c.post("/api/v1/auth/register", reg(uniqueEmail("terms"), { termsVersion: "2020-01-01" }));
    expect(oldTerms.status).toBe(409);
  });

  it("rejects state-changing requests without a CSRF token or from a foreign origin", async () => {
    const c = Client.customer(h.app);
    const noCsrf = await c.post("/api/v1/auth/login", { email: "x@example.test", password: "x" }, { noCsrf: true });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("CSRF_INVALID");
    const evil = await c.post("/api/v1/auth/login", { email: "x@example.test", password: "x" }, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("CSRF_INVALID");
    const adminOrigin = await c.post("/api/v1/auth/login", { email: "x@example.test", password: "x" }, { headers: { origin: process.env.ADMIN_URL! } });
    expect(adminOrigin.status).toBe(403);
  });
});

describe("login and sessions", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie and never returns the token in the body", async () => {
    const { email } = await verifiedUser(h.app, "cookie");
    const c = Client.customer(h.app);
    const r = await c.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect(r.status).toBe(200);
    const setCookie = ([] as string[]).concat(r.headers["set-cookie"] as string[]);
    const sid = setCookie.find((v) => v.startsWith("wim_sid="))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).toMatch(/Path=\//);
    expect(JSON.stringify(r.body)).not.toContain(c.cookies.get("wim_sid"));
    const stored = await h.owner.query("SELECT token_hash FROM user_sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')", [Buffer.from(c.cookies.get("wim_sid")!)]);
    expect(stored.rowCount).toBe(1);
  });

  it("uses one generic error for unknown email and wrong password", async () => {
    const { email } = await verifiedUser(h.app, "generic");
    const c = Client.customer(h.app);
    const wrong = await c.post("/api/v1/auth/login", { email, password: "wrong-password-123456" });
    const unknown = await c.post("/api/v1/auth/login", { email: uniqueEmail("nobody"), password: "wrong-password-123456" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
  });

  it("applies a progressive delay after repeated failures and records attempts", async () => {
    const { email, userId } = await verifiedUser(h.app, "brute");
    const c = Client.customer(h.app);
    for (let i = 0; i < 5; i++) {
      expect((await c.post("/api/v1/auth/login", { email, password: `wrong-${i}-xxxxxxxxxx` })).status).toBe(401);
    }
    const blocked = await c.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    const { rows } = await h.owner.query("SELECT count(*)::int AS n FROM login_attempts WHERE user_id = $1 AND success = false", [userId]);
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it("logout revokes the session server-side (a copied cookie stops working)", async () => {
    const { client } = await verifiedUser(h.app, "logout");
    const stolen = client.clone();
    expect((await client.post("/api/v1/auth/logout")).status).toBe(204);
    expect((await stolen.get("/api/v1/me")).status).toBe(401);
  });

  it("lists sessions and revokes another device immediately", async () => {
    const { client: a, email } = await verifiedUser(h.app, "devices");
    const b = Client.customer(h.app);
    await b.post("/api/v1/auth/login", { email, password: PASSWORD });
    expect((await b.get("/api/v1/me")).status).toBe(200);
    const list = await a.get("/api/v1/auth/sessions");
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await a.del(`/api/v1/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await b.get("/api/v1/me")).status).toBe(401); // no waiting for cache expiry
    expect((await a.get("/api/v1/me")).status).toBe(200);
  });

  it("'sign out other sessions' keeps only the current one", async () => {
    const { client: a, email } = await verifiedUser(h.app, "others");
    const b = Client.customer(h.app);
    const c = Client.customer(h.app);
    await b.post("/api/v1/auth/login", { email, password: PASSWORD });
    await c.post("/api/v1/auth/login", { email, password: PASSWORD });
    const r = await a.del("/api/v1/auth/sessions");
    expect(r.body.data.revoked).toBe(2);
    expect((await b.get("/api/v1/me")).status).toBe(401);
    expect((await c.get("/api/v1/me")).status).toBe(401);
    expect((await a.get("/api/v1/me")).status).toBe(200);
  });

  it("rejects unauthenticated access to session routes", async () => {
    const c = Client.customer(h.app);
    for (const url of ["/api/v1/me", "/api/v1/orgs", "/api/v1/auth/sessions", "/api/v1/me/activity"]) {
      const r = await c.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code).toBe("UNAUTHENTICATED");
    }
  });
});

describe("password recovery", () => {
  it("resets via a single-use emailed link, revokes all sessions and notifies", async () => {
    const { client, email } = await verifiedUser(h.app, "reset");
    const anon = Client.customer(h.app);
    const r = await anon.post("/api/v1/auth/password/forgot", { email });
    expect(r.status).toBe(202);
    const mail = await waitForEmail(email, "Reset your password");
    const token = tokenFrom(mail.text);
    const newPassword = "an-entirely-new-passphrase-77";
    expect((await anon.post("/api/v1/auth/password/reset", { token, password: newPassword })).status).toBe(204);
    expect((await anon.post("/api/v1/auth/password/reset", { token, password: "yet-another-passphrase-88" })).body.error.code).toBe("INVALID_TOKEN");
    expect((await client.get("/api/v1/me")).status).toBe(401); // existing session revoked
    expect((await anon.post("/api/v1/auth/login", { email, password: PASSWORD })).status).toBe(401);
    expect((await anon.post("/api/v1/auth/login", { email, password: newPassword })).status).toBe(200);
    await waitForEmail(email, "Your password was changed");
  });

  it("answers 202 for unknown emails without sending anything", async () => {
    const email = uniqueEmail("ghost");
    const r = await Client.customer(h.app).post("/api/v1/auth/password/forgot", { email });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 1500));
    expect(await countEmails(email, "Reset")).toBe(0);
  });

  it("change password requires the current password, revokes other sessions and rotates the current one", async () => {
    const { client: a, email } = await verifiedUser(h.app, "change");
    const b = Client.customer(h.app);
    await b.post("/api/v1/auth/login", { email, password: PASSWORD });
    const oldA = a.clone();
    const bad = await a.post("/api/v1/auth/password/change", { currentPassword: "not-my-password-123", newPassword: "fresh-passphrase-for-me-1" });
    expect(bad.status).toBe(401);
    const ok = await a.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: "fresh-passphrase-for-me-1" });
    expect(ok.status).toBe(204);
    expect((await b.get("/api/v1/me")).status).toBe(401);
    expect((await oldA.get("/api/v1/me")).status).toBe(401); // pre-rotation token no longer valid
    expect((await a.get("/api/v1/me")).status).toBe(200);
  });
});

describe("audit trail for authentication", () => {
  it("records security events in the user's hash-chained stream", async () => {
    const { client, userId, email } = await verifiedUser(h.app, "audited");
    await Client.customer(h.app).post("/api/v1/auth/login", { email, password: "wrong-password-xyz-1" });
    await client.post("/api/v1/auth/password/change", { currentPassword: PASSWORD, newPassword: "rotated-passphrase-99x" });
    const activity = await client.get("/api/v1/me/activity");
    const actions = activity.body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.registered", "auth.email_verified", "auth.login", "auth.password_changed"]));
    const chain = await h.owner.query("SELECT * FROM audit_verify($1)", [`user:${userId}`]);
    expect(chain.rowCount).toBe(0);
  });
});
