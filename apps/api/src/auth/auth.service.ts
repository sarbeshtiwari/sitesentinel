import { Inject, Injectable } from "@nestjs/common";
import {
  burnPasswordVerification, hashPassword, hmacHex, needsRehash, normalizeEmailForHash, sha256Hex, verifyPassword,
} from "@wim/crypto";
import type { Db } from "@wim/db";
import type { LoginInput, RegisterInput } from "@wim/contracts";
import { APP_DB, EmailQueue } from "../infra/infra.module.js";
import { SettingsService } from "../settings/settings.service.js";
import { KeysService } from "../crypto/keys.service.js";
import { AuditService, userStream } from "../audit/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { Errors } from "../common/errors.js";
import type { ClientInfo, SessionContext } from "../common/context.js";
import { SessionService, type IssuedSession } from "./session.service.js";
import { PasswordPolicy } from "./password-policy.js";

export interface LoginOutcome {
  issued: IssuedSession;
  userId: string;
  secondFactorRequired: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly keys: KeysService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailQueue,
    private readonly policy: PasswordPolicy,
  ) {}

  /** Keyed hash used to correlate attempts per email without storing the address. */
  emailHash(email: string): string {
    return hmacHex(this.keys.hmacKey("email"), normalizeEmailForHash(email));
  }

  // ---------------------------------------------------------------- registration
  /**
   * Enumeration-safe: the response is identical whether or not the email is
   * registered. An existing account owner gets an "account exists" email instead.
   */
  async register(input: RegisterInput, client: ClientInfo): Promise<void> {
    const s = await this.settings.get();
    if (s["auth.registration"] === "CLOSED") throw Errors.registrationClosed();
    if (s["auth.registration"] === "INVITE_ONLY") {
      const invites = await this.db.$queryRaw<unknown[]>`SELECT 1 FROM pending_invitations_for_email(${input.email}::citext)`;
      if (invites.length === 0) throw Errors.registrationClosed();
    }
    await this.rateLimit.hit("register-ip", client.ip ?? "unknown", s["auth.register.perIpPerHour"], 3600);
    if (input.termsVersion !== s["legal.termsVersion"]) {
      throw Errors.conflict("The terms of service were updated. Reload the page and accept the current version", { termsVersion: s["legal.termsVersion"] });
    }
    await this.policy.assertAcceptable(input.password, input.email);
    // Hash before the existence check so both paths cost the same.
    const passwordHash = await hashPassword(input.password);
    const existing = await this.db.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) {
      await this.audit.record({ stream: userStream(existing.id), actorType: "SYSTEM", action: "auth.register_existing_email", client });
      await this.email.enqueue({ kind: "ACCOUNT_EXISTS", userId: existing.id }, `account-exists:${existing.id}:${hourBucket()}`);
      return;
    }
    let userId: string;
    try {
      const user = await this.db.user.create({
        data: {
          email: input.email,
          passwordHash,
          name: input.name,
          timezone: input.timezone ?? s["platform.defaultTimezone"],
          passwordChangedAt: new Date(),
        },
        select: { id: true },
      });
      userId = user.id;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return; // concurrent registration of the same email
      throw e;
    }
    await this.audit.record({
      stream: userStream(userId), actorType: "USER", actorId: userId, action: "auth.registered",
      changes: { termsVersion: input.termsVersion }, client,
    });
    await this.email.enqueue({ kind: "VERIFY_EMAIL", userId }, `verify:${userId}:${Date.now()}`);
  }

  async verifyEmail(token: string, client: ClientInfo): Promise<void> {
    const row = await this.db.emailVerificationToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, userId: true, email: true, usedAt: true, expiresAt: true, user: { select: { email: true } } },
    });
    if (!row || row.usedAt || row.expiresAt < new Date() || row.email !== row.user.email) throw Errors.invalidToken();
    await this.db.$transaction(async (tx) => {
      const used = await tx.emailVerificationToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw Errors.invalidToken();
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() }, select: { id: true } });
      await this.audit.record({ stream: userStream(row.userId), actorType: "USER", actorId: row.userId, action: "auth.email_verified", client }, tx);
    });
    await this.sessions.refreshUser(row.userId);
  }

  async resendVerification(session: SessionContext): Promise<void> {
    if (session.emailVerified) return;
    await this.rateLimit.hit("verify-resend", session.userId, 3, 3600);
    await this.email.enqueue({ kind: "VERIFY_EMAIL", userId: session.userId }, `verify:${session.userId}:${Date.now()}`);
  }

  // ---------------------------------------------------------------- login
  async login(input: LoginInput, client: ClientInfo): Promise<LoginOutcome> {
    const s = await this.settings.get();
    await this.rateLimit.hit("login-ip", client.ip ?? "unknown", s["auth.login.perIpPer15Min"], 900);
    const eh = this.emailHash(input.email);

    // Progressive delay per email, applied identically to unknown emails (no enumeration).
    const failures = await this.rateLimit.count("login-fail", eh);
    if (failures >= s["auth.login.failuresBeforeDelay"]) {
      const delaySec = Math.min(900, 30 * 2 ** (failures - s["auth.login.failuresBeforeDelay"]));
      const lastFailure = (await this.rateLimit.markedAt("login-last", eh)) ?? 0;
      const waitSec = lastFailure + delaySec - Math.floor(Date.now() / 1000);
      if (waitSec > 0) throw Errors.rateLimited(waitSec);
    }

    const user = await this.db.user.findUnique({
      where: { email: input.email },
      select: { id: true, passwordHash: true, status: true, lockedUntil: true, totpEnabledAt: true },
    });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordAttempt(user.id, eh, client, false, "LOCKED");
      throw Errors.rateLimited((user.lockedUntil.getTime() - Date.now()) / 1000);
    }

    const ok = user ? await verifyPassword(user.passwordHash, input.password) : (await burnPasswordVerification(input.password), false);
    if (!user || !ok) {
      await this.rateLimit.increment("login-fail", eh, 900);
      await this.rateLimit.mark("login-last", eh, 900);
      if (user) await this.maybeLock(user.id, client);
      await this.recordAttempt(user?.id ?? null, eh, client, false, "BAD_CREDENTIALS");
      throw Errors.invalidCredentials();
    }
    if (user.status !== "ACTIVE") {
      await this.recordAttempt(user.id, eh, client, false, "SUSPENDED");
      throw Errors.suspended();
    }

    await this.rateLimit.reset("login-fail", eh);
    if (needsRehash(user.passwordHash)) {
      await this.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.password) }, select: { id: true } });
    }
    const secondFactorRequired = user.totpEnabledAt !== null;
    const issued = await this.sessions.create(user.id, { mfaVerified: !secondFactorRequired, client });
    await this.recordAttempt(user.id, eh, client, true, secondFactorRequired ? "SECOND_FACTOR_PENDING" : null);
    if (!secondFactorRequired) await this.completeLogin(user.id, "password", client);
    return { issued, userId: user.id, secondFactorRequired };
  }

  /** Bookkeeping once a login is fully authenticated (password, plus second factor if enabled). */
  async completeLogin(userId: string, method: string, client: ClientInfo): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), failedLoginCount: 0 }, select: { id: true } });
    await this.rateLimit.reset("login-fail24", userId);
    await this.audit.record({ stream: userStream(userId), actorType: "USER", actorId: userId, action: "auth.login", changes: { method }, client });
  }

  async logout(session: SessionContext, client: ClientInfo): Promise<void> {
    await this.sessions.revokeById(session.userId, session.sessionId);
    await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.logout", client });
  }

  private async maybeLock(userId: string, client: ClientInfo) {
    const s = await this.settings.get();
    const count = await this.rateLimit.increment("login-fail24", userId, 86_400);
    await this.db.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } }, select: { id: true } });
    if (count >= s["auth.login.lockThreshold24h"]) {
      const minutes = s["auth.login.lockMinutes"];
      await this.db.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() + minutes * 60_000) }, select: { id: true } });
      await this.rateLimit.reset("login-fail24", userId);
      await this.audit.record({ stream: userStream(userId), actorType: "SYSTEM", action: "auth.account_locked", changes: { minutes }, client });
      await this.db.securityEvent.create({ data: { kind: "ACCOUNT_LOCKED", severity: "MEDIUM", actorRef: userId, ipPrefix: client.ipPrefix, details: { minutes } } });
      await this.email.enqueue({ kind: "SECURITY_NOTICE", userId, notice: "ACCOUNT_LOCKED", data: { minutes } }, `locked:${userId}:${Date.now()}`);
    }
  }

  async recordAttempt(userId: string | null, emailHash: string, client: ClientInfo, success: boolean, reason: string | null) {
    await this.db.loginAttempt.create({
      data: { actorType: "USER", userId, emailHash, ipPrefix: client.ipPrefix, success, reason },
    });
  }

  // ---------------------------------------------------------------- passwords
  async forgotPassword(email: string, client: ClientInfo): Promise<void> {
    const s = await this.settings.get();
    await this.rateLimit.hit("forgot-ip", client.ip ?? "unknown", s["auth.register.perIpPerHour"], 3600);
    const eh = this.emailHash(email);
    if ((await this.rateLimit.increment("forgot-email", eh, 3600)) > 3) return; // silently drop, still 202
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true, status: true } });
    if (!user || user.status !== "ACTIVE") return;
    await this.audit.record({ stream: userStream(user.id), actorType: "SYSTEM", action: "auth.password_reset_requested", client });
    await this.email.enqueue({ kind: "PASSWORD_RESET", userId: user.id }, `reset:${user.id}:${Date.now()}`);
  }

  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    const row = await this.db.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, userId: true, usedAt: true, expiresAt: true, user: { select: { email: true, status: true } } },
    });
    if (!row || row.usedAt || row.expiresAt < new Date() || row.user.status !== "ACTIVE") throw Errors.invalidToken();
    await this.policy.assertAcceptable(password, row.user.email);
    const passwordHash = await hashPassword(password);
    await this.db.$transaction(async (tx) => {
      const used = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw Errors.invalidToken();
      await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
        select: { id: true },
      });
      await this.audit.record({ stream: userStream(row.userId), actorType: "USER", actorId: row.userId, action: "auth.password_reset", client }, tx);
    });
    await this.sessions.revokeAll(row.userId);
    await this.rateLimit.reset("login-fail", this.emailHash(row.user.email));
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: row.userId, notice: "PASSWORD_CHANGED" }, `pwchanged:${row.userId}:${Date.now()}`);
  }

  async changePassword(session: SessionContext, current: string, next: string, client: ClientInfo): Promise<IssuedSession> {
    await this.rateLimit.hit("password-change", session.userId, 5, 900);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: session.userId }, select: { passwordHash: true, email: true } });
    if (!(await verifyPassword(user.passwordHash, current))) throw Errors.invalidCredentials();
    await this.policy.assertAcceptable(next, user.email);
    await this.db.user.update({
      where: { id: session.userId },
      data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() },
      select: { id: true },
    });
    await this.db.passwordResetToken.updateMany({ where: { userId: session.userId, usedAt: null }, data: { usedAt: new Date() } });
    await this.sessions.revokeAll(session.userId, session.sessionId);
    const issued = await this.sessions.rotate(session, { mfaVerified: true, client });
    await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.password_changed", client });
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: session.userId, notice: "PASSWORD_CHANGED" }, `pwchanged:${session.userId}:${Date.now()}`);
    return issued;
  }
}

function hourBucket(): number {
  return Math.floor(Date.now() / 3_600_000);
}
