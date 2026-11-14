import { Inject, Injectable } from "@nestjs/common";
import QRCode from "qrcode";
import {
  generateRecoveryCode, generateTotpSecret, hmacHex, normalizeRecoveryCode, otpauthUrl, sha256Hex, verifyPassword, verifyTotp,
} from "@wim/crypto";
import { withUser, type Db, type Tx } from "@wim/db";
import type { MfaResetStatusDto, SecondFactorInput, TotpEnrollmentDto } from "@wim/contracts";
import { APP_DB, EmailQueue } from "../infra/infra.module.js";
import { KeysService } from "../crypto/keys.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, userStream } from "../audit/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { Errors } from "../common/errors.js";
import type { ClientInfo, SessionContext } from "../common/context.js";
import { SessionService, type IssuedSession } from "./session.service.js";
import { AuthService } from "./auth.service.js";

const RECOVERY_CODE_COUNT = 10;
const MAX_SECOND_FACTOR_FAILURES = 10; // per account, per 15 minutes
const totpAad = (userId: string) => `users.totp:${userId}`;
const pendingAad = (userId: string) => `users.totp_pending:${userId}`;

@Injectable()
export class MfaService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly keys: KeysService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailQueue,
  ) {}

  // ---------------------------------------------------------------- enrollment
  async enroll(session: SessionContext): Promise<TotpEnrollmentDto> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: session.userId }, select: { email: true, totpEnabledAt: true } });
    if (user.totpEnabledAt) throw Errors.conflict("Two-factor authentication is already enabled");
    const secret = generateTotpSecret();
    const sealed = await this.keys.sealPlatform(this.db, "user-secrets", secret, pendingAad(session.userId));
    await this.db.user.update({ where: { id: session.userId }, data: { totpPendingSecretEnc: sealed }, select: { id: true } });
    const issuer = (await this.settings.get())["branding.productName"];
    const url = otpauthUrl({ issuer, account: user.email, secret });
    return { otpauthUrl: url, secret, qrSvg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) };
  }

  /** Confirm enrollment with a code from the app; returns one-time recovery codes. */
  async confirm(session: SessionContext, code: string, client: ClientInfo): Promise<{ codes: string[]; issued: IssuedSession }> {
    await this.rateLimit.hit("2fa", session.sessionId, 5, 900);
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: session.userId },
      select: { totpPendingSecretEnc: true, totpEnabledAt: true },
    });
    if (user.totpEnabledAt) throw Errors.conflict("Two-factor authentication is already enabled");
    if (!user.totpPendingSecretEnc) throw Errors.conflict("Start enrollment first");
    const secret = await this.keys.openPlatform(this.db, "user-secrets", user.totpPendingSecretEnc, pendingAad(session.userId));
    const step = verifyTotp(secret, code);
    if (step === null) throw Errors.invalidCode();
    const sealed = await this.keys.sealPlatform(this.db, "user-secrets", secret, totpAad(session.userId));
    const codes = await withUser(this.db, session.userId, async (tx) => {
      await tx.user.update({
        where: { id: session.userId },
        data: { totpSecretEnc: sealed, totpPendingSecretEnc: null, totpEnabledAt: new Date(), totpLastUsedStep: step },
        select: { id: true },
      });
      const c = await this.replaceRecoveryCodes(tx, session.userId);
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.2fa_enabled", client }, tx);
      return c;
    });
    // Privilege change: sign out other sessions and rotate this one.
    await this.sessions.revokeAll(session.userId, session.sessionId);
    const issued = await this.sessions.rotate(session, { mfaVerified: true, client });
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: session.userId, notice: "TWO_FACTOR_ENABLED" }, `2fa-on:${session.userId}:${Date.now()}`);
    return { codes, issued };
  }

  // ---------------------------------------------------------------- login challenge
  async verifyLogin(session: SessionContext, input: SecondFactorInput, client: ClientInfo): Promise<IssuedSession> {
    if (session.mfaVerified) throw Errors.conflict("Already verified");
    await this.rateLimit.hit("2fa", session.sessionId, 5, 900);
    // Per-account cap as well: otherwise someone holding the password could open many
    // partial sessions and get 5 guesses in each.
    if ((await this.rateLimit.count("2fa-fail-user", session.userId)) >= MAX_SECOND_FACTOR_FAILURES) {
      throw Errors.rateLimited(900, "Too many failed codes. Try again in 15 minutes");
    }
    const method = "code" in input ? "totp" : "recovery_code";
    const ok = "code" in input
      ? await this.checkTotp(session.userId, input.code)
      : await this.consumeRecoveryCode(session.userId, input.recoveryCode, client);
    if (!ok) {
      await this.rateLimit.increment("2fa-fail-user", session.userId, 900);
      await this.auth.recordAttempt(session.userId, this.auth.emailHash(session.email), client, false, "SECOND_FACTOR_FAILED");
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.2fa_failed", changes: { method }, client });
      throw Errors.invalidCode();
    }
    await this.rateLimit.reset("2fa-fail-user", session.userId);
    const issued = await this.sessions.rotate(session, { mfaVerified: true, client });
    await this.auth.completeLogin(session.userId, method, client);
    return issued;
  }

  async disable(session: SessionContext, password: string, code: string, client: ClientInfo): Promise<IssuedSession> {
    await this.rateLimit.hit("2fa", session.sessionId, 5, 900);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: session.userId }, select: { passwordHash: true, totpEnabledAt: true } });
    if (!user.totpEnabledAt) throw Errors.conflict("Two-factor authentication is not enabled");
    if (!(await verifyPassword(user.passwordHash, password))) throw Errors.invalidCredentials();
    if (!(await this.checkTotp(session.userId, code))) throw Errors.invalidCode();
    await withUser(this.db, session.userId, async (tx) => {
      await this.clearSecondFactor(tx, session.userId);
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.2fa_disabled", client }, tx);
    });
    await this.sessions.revokeAll(session.userId, session.sessionId);
    const issued = await this.sessions.rotate(session, { mfaVerified: true, client });
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: session.userId, notice: "TWO_FACTOR_DISABLED" }, `2fa-off:${session.userId}:${Date.now()}`);
    return issued;
  }

  async regenerateRecoveryCodes(session: SessionContext, code: string, client: ClientInfo): Promise<string[]> {
    await this.rateLimit.hit("2fa", session.sessionId, 5, 900);
    if (!(await this.checkTotp(session.userId, code))) throw Errors.invalidCode();
    const codes = await withUser(this.db, session.userId, async (tx) => {
      const c = await this.replaceRecoveryCodes(tx, session.userId);
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.recovery_codes_regenerated", client }, tx);
      return c;
    });
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: session.userId, notice: "RECOVERY_CODES_REGENERATED" }, `rc-regen:${session.userId}:${Date.now()}`);
    return codes;
  }

  async recoveryCodesRemaining(userId: string): Promise<number> {
    return withUser(this.db, userId, (tx) => tx.recoveryCode.count({ where: { userId, usedAt: null } }));
  }

  // ---------------------------------------------------------------- lost-device reset
  /**
   * Lost authenticator AND recovery codes. Requires the password (partial session),
   * then email confirmation, then a waiting period with a cancel link, then the
   * user completes it at their next sign-in. All steps are audited and notified.
   */
  async requestReset(session: SessionContext, client: ClientInfo): Promise<MfaResetStatusDto> {
    await this.rateLimit.hit("mfa-reset", session.userId, 3, 86_400);
    const id = await withUser(this.db, session.userId, async (tx) => {
      await tx.accountRecoveryRequest.updateMany({
        where: { userId: session.userId, status: { in: ["PENDING_EMAIL", "WAITING"] } },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      const r = await tx.accountRecoveryRequest.create({
        data: { userId: session.userId, confirmExpiresAt: new Date(Date.now() + 3_600_000), ipPrefix: client.ipPrefix },
        select: { id: true },
      });
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.2fa_reset_requested", client }, tx);
      return r.id;
    });
    await this.email.enqueue({ kind: "MFA_RESET_CONFIRM", requestId: id }, `mfa-reset-confirm:${id}`);
    return { id, status: "PENDING_EMAIL", eligibleAt: null };
  }

  async confirmReset(token: string, client: ClientInfo): Promise<{ eligibleAt: string }> {
    const ref = await this.lookupRecoveryToken(token, "CONFIRM");
    const delayHours = (await this.settings.get())["auth.mfaReset.delayHours"];
    const eligibleAt = new Date(Date.now() + delayHours * 3_600_000);
    await withUser(this.db, ref.userId, async (tx) => {
      const updated = await tx.accountRecoveryRequest.updateMany({
        where: { id: ref.id, status: "PENDING_EMAIL", confirmExpiresAt: { gt: new Date() } },
        data: { status: "WAITING", confirmedAt: new Date(), eligibleAt, confirmTokenHash: null },
      });
      if (updated.count !== 1) throw Errors.invalidToken();
      await this.audit.record({ stream: userStream(ref.userId), actorType: "USER", actorId: ref.userId, action: "auth.2fa_reset_confirmed", changes: { eligibleAt: eligibleAt.toISOString() }, client }, tx);
    });
    await this.email.enqueue({ kind: "MFA_RESET_SCHEDULED", requestId: ref.id }, `mfa-reset-scheduled:${ref.id}`);
    return { eligibleAt: eligibleAt.toISOString() };
  }

  /** Cancel via the emailed cancel link (no session needed: the link is the authority). */
  async cancelResetByToken(token: string, client: ClientInfo): Promise<void> {
    const ref = await this.lookupRecoveryToken(token, "CANCEL");
    await this.cancel(ref.userId, ref.id, client);
  }

  /** Cancel from a signed-in session. */
  async cancelResetForSession(session: SessionContext, client: ClientInfo): Promise<void> {
    const active = await this.activeReset(session.userId);
    if (!active) throw Errors.notFound();
    await this.cancel(session.userId, active.id, client);
  }

  async resetStatus(session: SessionContext): Promise<MfaResetStatusDto | null> {
    const r = await this.activeReset(session.userId);
    if (!r) return null;
    const ready = r.status === "WAITING" && r.eligibleAt !== null && r.eligibleAt <= new Date();
    return { id: r.id, status: ready ? "READY" : (r.status as "PENDING_EMAIL" | "WAITING"), eligibleAt: r.eligibleAt?.toISOString() ?? null };
  }

  /** Finish an eligible reset from the partial session: removes the second factor and signs in. */
  async completeReset(session: SessionContext, client: ClientInfo): Promise<IssuedSession> {
    await withUser(this.db, session.userId, async (tx) => {
      const done = await tx.accountRecoveryRequest.updateMany({
        where: { userId: session.userId, status: "WAITING", eligibleAt: { lte: new Date() } },
        data: { status: "COMPLETED", completedAt: new Date(), cancelTokenHash: null },
      });
      if (done.count !== 1) throw Errors.conflict("No reset is ready to complete");
      await this.clearSecondFactor(tx, session.userId);
      await this.audit.record({ stream: userStream(session.userId), actorType: "USER", actorId: session.userId, action: "auth.2fa_reset_completed", client }, tx);
    });
    await this.sessions.revokeAll(session.userId, session.sessionId);
    const issued = await this.sessions.rotate(session, { mfaVerified: true, client });
    await this.auth.completeLogin(session.userId, "2fa_reset", client);
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId: session.userId, notice: "MFA_RESET_COMPLETED" }, `mfa-reset-done:${session.userId}:${Date.now()}`);
    return issued;
  }

  // ---------------------------------------------------------------- internals
  private async checkTotp(userId: string, code: string): Promise<boolean> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEnc: true, totpLastUsedStep: true } });
    if (!user.totpSecretEnc) return false;
    const secret = await this.keys.openPlatform(this.db, "user-secrets", user.totpSecretEnc, totpAad(userId));
    const step = verifyTotp(secret, code, { lastUsedStep: user.totpLastUsedStep });
    if (step === null) return false;
    // Conditional update: a concurrent request with the same code loses the race (replay protection).
    const updated = await this.db.user.updateMany({
      where: { id: userId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
      data: { totpLastUsedStep: step },
    });
    return updated.count === 1;
  }

  private recoveryHash(userId: string, code: string): string {
    return hmacHex(this.keys.hmacKey("recovery-code"), `${userId}:${normalizeRecoveryCode(code)}`);
  }

  private async replaceRecoveryCodes(tx: Tx, userId: string): Promise<string[]> {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: this.recoveryHash(userId, c) })) });
    return codes;
  }

  private async consumeRecoveryCode(userId: string, code: string, client: ClientInfo): Promise<boolean> {
    const hash = this.recoveryHash(userId, code);
    const remaining = await withUser(this.db, userId, async (tx) => {
      const used = await tx.recoveryCode.updateMany({ where: { userId, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) return null;
      await this.audit.record({ stream: userStream(userId), actorType: "USER", actorId: userId, action: "auth.recovery_code_used", client }, tx);
      return tx.recoveryCode.count({ where: { userId, usedAt: null } });
    });
    if (remaining === null) return false;
    await this.email.enqueue({ kind: "SECURITY_NOTICE", userId, notice: "RECOVERY_CODE_USED", data: { remaining } }, `rc-used:${userId}:${Date.now()}`);
    return true;
  }

  private async clearSecondFactor(tx: Tx, userId: string) {
    await tx.user.update({
      where: { id: userId },
      data: { totpSecretEnc: null, totpPendingSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null },
      select: { id: true },
    });
    await tx.recoveryCode.deleteMany({ where: { userId } });
  }

  private async activeReset(userId: string) {
    return withUser(this.db, userId, (tx) =>
      tx.accountRecoveryRequest.findFirst({
        where: { userId, status: { in: ["PENDING_EMAIL", "WAITING"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, eligibleAt: true },
      }),
    );
  }

  private async lookupRecoveryToken(token: string, kind: "CONFIRM" | "CANCEL") {
    if (token.length < 20 || token.length > 200) throw Errors.invalidToken();
    const rows = await this.db.$queryRaw<Array<{ id: string; user_id: string; token_kind: string }>>`
      SELECT * FROM recovery_request_by_token(${sha256Hex(token)})`;
    const r = rows[0];
    if (!r || r.token_kind !== kind) throw Errors.invalidToken();
    return { id: r.id, userId: r.user_id };
  }

  private async cancel(userId: string, requestId: string, client: ClientInfo) {
    await withUser(this.db, userId, async (tx) => {
      const c = await tx.accountRecoveryRequest.updateMany({
        where: { id: requestId, userId, status: { in: ["PENDING_EMAIL", "WAITING"] } },
        data: { status: "CANCELLED", cancelledAt: new Date(), confirmTokenHash: null, cancelTokenHash: null },
      });
      if (c.count !== 1) throw Errors.invalidToken();
      await this.audit.record({ stream: userStream(userId), actorType: "USER", actorId: userId, action: "auth.2fa_reset_cancelled", client }, tx);
    });
  }
}
