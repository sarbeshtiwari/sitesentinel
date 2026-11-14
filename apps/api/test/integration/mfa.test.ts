import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totp } from "@wim/crypto";
import { Client, PASSWORD, startHarness, tokenFrom, totpCode, verifiedUser, waitForEmail, type Harness } from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.stop(); });

/** Verified user with 2FA enabled. Returns the secret and recovery codes. */
async function userWith2fa(tag: string) {
  const u = await verifiedUser(h.app, tag);
  const enroll = await u.client.post("/api/v1/auth/2fa/totp/enroll");
  expect(enroll.status).toBe(200);
  const secret: string = enroll.body.data.secret;
  expect(enroll.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\/SiteSentinel/);
  expect(enroll.body.data.qrSvg).toMatch(/^<svg/);
  const confirm = await u.client.post("/api/v1/auth/2fa/totp/confirm", { code: totp(secret) });
  expect(confirm.status).toBe(200);
  const codes: string[] = confirm.body.data.recoveryCodes;
  return { ...u, secret, codes };
}

async function partialLogin(email: string, password = PASSWORD) {
  const c = Client.customer(h.app);
  const r = await c.post("/api/v1/auth/login", { email, password });
  expect(r.status).toBe(200);
  expect(r.body.data.status).toBe("SECOND_FACTOR_REQUIRED");
  return c;
}

describe("TOTP enrollment", () => {
  it("confirms with a valid code, returns 10 recovery codes, stores the secret encrypted, and notifies", async () => {
    const u = await userWith2fa("enroll");
    expect(u.codes).toHaveLength(10);
    expect(new Set(u.codes).size).toBe(10);
    const { rows } = await h.owner.query("SELECT totp_secret_enc, totp_pending_secret_enc, totp_enabled_at FROM users WHERE id = $1", [u.userId]);
    expect(rows[0].totp_enabled_at).not.toBeNull();
    expect(rows[0].totp_pending_secret_enc).toBeNull();
    const blob: Buffer = rows[0].totp_secret_enc;
    expect(blob.toString("latin1")).not.toContain(u.secret); // ciphertext, not plaintext
    expect(blob[0]).toBe(0x01); // envelope format v1
    const rc = await h.owner.query("SELECT code_hash FROM recovery_codes WHERE user_id = $1", [u.userId]);
    expect(rc.rowCount).toBe(10);
    for (const code of u.codes) expect(rc.rows.map((r) => r.code_hash)).not.toContain(code);
    await waitForEmail(u.email, "Two-factor authentication enabled");
    const me = await u.client.get("/api/v1/me");
    expect(me.body.data.twoFactor).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
  });

  it("rejects a wrong confirmation code", async () => {
    const u = await verifiedUser(h.app, "badconfirm");
    await u.client.post("/api/v1/auth/2fa/totp/enroll");
    const r = await u.client.post("/api/v1/auth/2fa/totp/confirm", { code: "000000" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_CODE");
  });
});

describe("second factor at login", () => {
  it("partial sessions can reach only the second-factor endpoints", async () => {
    const u = await userWith2fa("partial");
    const c = await partialLogin(u.email);
    for (const url of ["/api/v1/me", "/api/v1/orgs", "/api/v1/auth/sessions"]) {
      const r = await c.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code).toBe("SECOND_FACTOR_REQUIRED");
    }
    expect((await c.post("/api/v1/orgs", { name: "nope" })).body.error.code).toBe("SECOND_FACTOR_REQUIRED");
  });

  it("completes with TOTP, rotates the session token, and rejects code replay", async () => {
    const u = await userWith2fa("verify");
    const c = await partialLogin(u.email);
    const partialCookie = c.clone();
    expect((await c.post("/api/v1/auth/2fa/verify", { code: "123456" })).body.error.code).toBe("INVALID_CODE");
    const code = await totpCode(u.secret, true);
    const ok = await c.post("/api/v1/auth/2fa/verify", { code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("AUTHENTICATED");
    expect((await c.get("/api/v1/me")).status).toBe(200);
    expect((await partialCookie.get("/api/v1/me")).status).toBe(401); // fixation defence: old token dead
    // The same code cannot be used again (RFC 6238 §5.2).
    const c2 = await partialLogin(u.email);
    expect((await c2.post("/api/v1/auth/2fa/verify", { code })).body.error.code).toBe("INVALID_CODE");
  });

  it("rate-limits second-factor guesses per session", async () => {
    const u = await userWith2fa("guess");
    const c = await partialLogin(u.email);
    for (let i = 0; i < 5; i++) await c.post("/api/v1/auth/2fa/verify", { code: String(100000 + i) });
    const r = await c.post("/api/v1/auth/2fa/verify", { code: totp(u.secret) });
    expect(r.status).toBe(429);
  });

  it("caps second-factor failures per account across many partial sessions", async () => {
    const u = await userWith2fa("spray");
    for (let session = 0; session < 3; session++) {
      const c = await partialLogin(u.email);
      for (let i = 0; i < 4; i++) await c.post("/api/v1/auth/2fa/verify", { code: String(200000 + session * 10 + i) });
    }
    // 12 failures spread over 3 sessions: a fresh session with the right code is still refused.
    const c = await partialLogin(u.email);
    const r = await c.post("/api/v1/auth/2fa/verify", { code: totp(u.secret) });
    expect(r.status).toBe(429);
  });

  it("accepts each recovery code exactly once and emails a notice", async () => {
    const u = await userWith2fa("recovery");
    const c = await partialLogin(u.email);
    const ok = await c.post("/api/v1/auth/2fa/verify", { recoveryCode: u.codes[0]!.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.me.twoFactor.recoveryCodesRemaining).toBe(9);
    await waitForEmail(u.email, "A recovery code was used");
    const c2 = await partialLogin(u.email);
    expect((await c2.post("/api/v1/auth/2fa/verify", { recoveryCode: u.codes[0] })).body.error.code).toBe("INVALID_CODE");
  });

  it("regenerating recovery codes invalidates the old set", async () => {
    const u = await userWith2fa("regen");
    const r = await u.client.post("/api/v1/auth/2fa/recovery-codes/regenerate", { code: await totpCode(u.secret, true) });
    expect(r.status).toBe(200);
    const fresh: string[] = r.body.data.recoveryCodes;
    const c = await partialLogin(u.email);
    expect((await c.post("/api/v1/auth/2fa/verify", { recoveryCode: u.codes[1] })).body.error.code).toBe("INVALID_CODE");
    expect((await c.post("/api/v1/auth/2fa/verify", { recoveryCode: fresh[0] })).status).toBe(200);
  });

  it("disabling requires password and a current code", async () => {
    const u = await userWith2fa("disable");
    const code = await totpCode(u.secret, true);
    expect((await u.client.post("/api/v1/auth/2fa/disable", { password: "wrong-password-0000", code })).status).toBe(401);
    expect((await u.client.post("/api/v1/auth/2fa/disable", { password: PASSWORD, code })).status).toBe(204);
    await waitForEmail(u.email, "Two-factor authentication disabled");
    const login = await Client.customer(h.app).post("/api/v1/auth/login", { email: u.email, password: PASSWORD });
    expect(login.body.data.status).toBe("AUTHENTICATED");
    const rc = await h.owner.query("SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1", [u.userId]);
    expect(rc.rows[0].n).toBe(0);
  });

  it("a password reset does not remove the second factor", async () => {
    const u = await userWith2fa("resetkeeps");
    await Client.customer(h.app).post("/api/v1/auth/password/forgot", { email: u.email });
    const mail = await waitForEmail(u.email, "Reset your password");
    await Client.customer(h.app).post("/api/v1/auth/password/reset", { token: tokenFrom(mail.text), password: "after-reset-passphrase-1" });
    const login = await Client.customer(h.app).post("/api/v1/auth/login", { email: u.email, password: "after-reset-passphrase-1" });
    expect(login.body.data.status).toBe("SECOND_FACTOR_REQUIRED");
  });
});

describe("lost authenticator: delayed, notified, cancellable reset", () => {
  it("requires password + email confirmation + waiting period, and can be cancelled", async () => {
    const u = await userWith2fa("lost");
    const c = await partialLogin(u.email);
    const req = await c.post("/api/v1/auth/2fa/reset/request");
    expect(req.status).toBe(202);
    expect(req.body.data.status).toBe("PENDING_EMAIL");
    const confirmMail = await waitForEmail(u.email, "Confirm two-factor reset");
    const conf = await Client.customer(h.app).post("/api/v1/auth/2fa/reset/confirm", { token: tokenFrom(confirmMail.text) });
    expect(conf.status).toBe(200);
    const eligibleAt = new Date(conf.body.data.eligibleAt).getTime();
    expect(eligibleAt - Date.now()).toBeGreaterThan(71 * 3_600_000); // 72 h default
    // Cannot complete early.
    const early = await c.post("/api/v1/auth/2fa/reset/complete");
    expect(early.status).toBe(409);
    // The scheduled notice carries a cancel link that works without signing in.
    const scheduled = await waitForEmail(u.email, "Two-factor reset scheduled");
    expect((await Client.customer(h.app).post("/api/v1/auth/2fa/reset/cancel", { token: tokenFrom(scheduled.text) })).status).toBe(204);
    expect((await c.get("/api/v1/auth/2fa/reset")).body.data).toBeNull();
  });

  it("completes after the waiting period: removes the factor, signs out elsewhere, notifies", async () => {
    const u = await userWith2fa("lostdone");
    const other = u.client.clone();
    const c = await partialLogin(u.email);
    await c.post("/api/v1/auth/2fa/reset/request");
    const confirmMail = await waitForEmail(u.email, "Confirm two-factor reset");
    await Client.customer(h.app).post("/api/v1/auth/2fa/reset/confirm", { token: tokenFrom(confirmMail.text) });
    // Simulate the waiting period elapsing.
    await h.owner.query("UPDATE account_recovery_requests SET eligible_at = now() - interval '1 minute' WHERE user_id = $1 AND status = 'WAITING'", [u.userId]);
    expect((await c.get("/api/v1/auth/2fa/reset")).body.data.status).toBe("READY");
    const done = await c.post("/api/v1/auth/2fa/reset/complete");
    expect(done.status).toBe(200);
    expect(done.body.data.me.twoFactor.enabled).toBe(false);
    expect((await other.get("/api/v1/me")).status).toBe(401);
    await waitForEmail(u.email, "Two-factor authentication removed");
    const audit = await h.owner.query("SELECT action FROM audit_logs WHERE stream = $1 ORDER BY seq", [`user:${u.userId}`]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["auth.2fa_reset_requested", "auth.2fa_reset_confirmed", "auth.2fa_reset_completed"]));
  });

  it("a fully signed-in user cannot use the lost-device flow (must disable normally)", async () => {
    const u = await userWith2fa("signedin");
    const c = await partialLogin(u.email);
    await c.post("/api/v1/auth/2fa/verify", { code: await totpCode(u.secret, true) });
    expect((await c.post("/api/v1/auth/2fa/reset/request")).status).toBe(409);
  });
});
