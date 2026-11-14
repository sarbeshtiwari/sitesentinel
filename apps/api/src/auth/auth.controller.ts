import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomToken } from "@wim/crypto";
import { withUser, type Db } from "@wim/db";
import {
  ChangePasswordInput, ForgotPasswordInput, LoginInput, RegenerateRecoveryCodesInput, RegisterInput, ResetPasswordInput,
  SecondFactorInput, TokenInput, TotpConfirmInput, TwoFactorDisableInput,
  type DataEnvelope, type LoginResultDto, type MfaResetStatusDto, type RecoveryCodesDto, type SessionDto, type TotpEnrollmentDto,
} from "@wim/contracts";
import { z } from "zod";
import { APP_DB } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { AllowPartialSession, Client, CurrentSession, parse, Public, type ClientInfo, type SessionContext } from "../common/context.js";
import { Errors } from "../common/errors.js";
import { AuditService, userStream } from "../audit/audit.service.js";
import { AuthService } from "./auth.service.js";
import { MfaService } from "./mfa.service.js";
import { cookieNames, SessionService } from "./session.service.js";
import { MeService } from "../me/me.service.js";

@Controller("api/v1/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly me: MeService,
    private readonly audit: AuditService,
    @Inject(APP_DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Issue the pre-session CSRF cookie used by login/register/forgot forms. */
  @Public()
  @Get("csrf")
  csrf(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): DataEnvelope<{ csrfToken: string }> {
    const names = cookieNames(this.env);
    const existing = req.session?.csrfSecret ?? req.cookies[names.csrf];
    const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken(32);
    reply.setCookie(names.csrf, token, { path: "/", secure: this.env.COOKIE_SECURE, sameSite: "lax", httpOnly: false, maxAge: 86_400 });
    return { data: { csrfToken: token } };
  }

  @Public()
  @Post("register")
  @HttpCode(202)
  async register(@Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<{ status: "VERIFICATION_SENT" }>> {
    await this.auth.register(parse(RegisterInput, body), client);
    return { data: { status: "VERIFICATION_SENT" } };
  }

  @Public()
  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<{ verified: true }>> {
    await this.auth.verifyEmail(parse(TokenInput, body).token, client);
    return { data: { verified: true } };
  }

  @Post("verify-email/resend")
  @HttpCode(202)
  async resend(@CurrentSession() s: SessionContext): Promise<DataEnvelope<{ status: "SENT" }>> {
    await this.auth.resendVerification(s);
    return { data: { status: "SENT" } };
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<DataEnvelope<LoginResultDto>> {
    const out = await this.auth.login(parse(LoginInput, body), client);
    this.sessions.setCookies(reply, out.issued);
    if (out.secondFactorRequired) {
      const mfaReset = await this.mfa.resetStatus({ userId: out.userId } as SessionContext);
      return { data: { status: "SECOND_FACTOR_REQUIRED", mfaReset } };
    }
    return { data: { status: "AUTHENTICATED", me: await this.me.get(out.userId) } };
  }

  @AllowPartialSession()
  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentSession() s: SessionContext, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(s, client);
    this.sessions.clearCookies(reply);
  }

  // ---------------------------------------------------------------- two-factor
  @AllowPartialSession()
  @Post("2fa/verify")
  @HttpCode(200)
  async verifySecondFactor(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<DataEnvelope<LoginResultDto>> {
    const issued = await this.mfa.verifyLogin(s, parse(SecondFactorInput, body), client);
    this.sessions.setCookies(reply, issued);
    return { data: { status: "AUTHENTICATED", me: await this.me.get(s.userId) } };
  }

  @Post("2fa/totp/enroll")
  @HttpCode(200)
  async enroll(@CurrentSession() s: SessionContext): Promise<DataEnvelope<TotpEnrollmentDto>> {
    return { data: await this.mfa.enroll(s) };
  }

  @Post("2fa/totp/confirm")
  @HttpCode(200)
  async confirm(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<DataEnvelope<RecoveryCodesDto>> {
    const { codes, issued } = await this.mfa.confirm(s, parse(TotpConfirmInput, body).code, client);
    this.sessions.setCookies(reply, issued);
    return { data: { recoveryCodes: codes } };
  }

  @Post("2fa/disable")
  @HttpCode(204)
  async disable(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const input = parse(TwoFactorDisableInput, body);
    this.sessions.setCookies(reply, await this.mfa.disable(s, input.password, input.code, client));
  }

  @Post("2fa/recovery-codes/regenerate")
  @HttpCode(200)
  async regenerate(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<RecoveryCodesDto>> {
    return { data: { recoveryCodes: await this.mfa.regenerateRecoveryCodes(s, parse(RegenerateRecoveryCodesInput, body).code, client) } };
  }

  @AllowPartialSession()
  @Get("2fa/reset")
  async resetStatus(@CurrentSession() s: SessionContext): Promise<DataEnvelope<MfaResetStatusDto | null>> {
    return { data: await this.mfa.resetStatus(s) };
  }

  /** Lost authenticator and recovery codes: start the delayed reset (requires the password step). */
  @AllowPartialSession()
  @Post("2fa/reset/request")
  @HttpCode(202)
  async resetRequest(@CurrentSession() s: SessionContext, @Client() client: ClientInfo): Promise<DataEnvelope<MfaResetStatusDto>> {
    if (s.mfaVerified) throw Errors.conflict("You are signed in with two-factor authentication; disable it from security settings instead");
    return { data: await this.mfa.requestReset(s, client) };
  }

  @Public()
  @Post("2fa/reset/confirm")
  @HttpCode(200)
  async resetConfirm(@Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<{ eligibleAt: string }>> {
    return { data: await this.mfa.confirmReset(parse(TokenInput, body).token, client) };
  }

  /** Cancel with the emailed token, or (when signed in) without one. */
  @Public()
  @Post("2fa/reset/cancel")
  @HttpCode(204)
  async resetCancel(@Req() req: FastifyRequest, @Body() body: unknown, @Client() client: ClientInfo): Promise<void> {
    const input = parse(z.object({ token: z.string().min(20).max(200).optional() }), body);
    if (input.token) return this.mfa.cancelResetByToken(input.token, client);
    if (!req.session) throw Errors.unauthenticated();
    return this.mfa.cancelResetForSession(req.session, client);
  }

  @AllowPartialSession()
  @Post("2fa/reset/complete")
  @HttpCode(200)
  async resetComplete(@CurrentSession() s: SessionContext, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<DataEnvelope<LoginResultDto>> {
    this.sessions.setCookies(reply, await this.mfa.completeReset(s, client));
    return { data: { status: "AUTHENTICATED", me: await this.me.get(s.userId) } };
  }

  // ---------------------------------------------------------------- passwords
  @Public()
  @Post("password/forgot")
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<{ status: "SENT_IF_EXISTS" }>> {
    await this.auth.forgotPassword(parse(ForgotPasswordInput, body).email, client);
    return { data: { status: "SENT_IF_EXISTS" } };
  }

  @Public()
  @Post("password/reset")
  @HttpCode(204)
  async reset(@Body() body: unknown, @Client() client: ClientInfo): Promise<void> {
    const input = parse(ResetPasswordInput, body);
    await this.auth.resetPassword(input.token, input.password, client);
  }

  @Post("password/change")
  @HttpCode(204)
  async change(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const input = parse(ChangePasswordInput, body);
    this.sessions.setCookies(reply, await this.auth.changePassword(s, input.currentPassword, input.newPassword, client));
  }

  // ---------------------------------------------------------------- sessions
  @Get("sessions")
  async listSessions(@CurrentSession() s: SessionContext): Promise<DataEnvelope<SessionDto[]>> {
    const rows = await withUser(this.db, s.userId, (tx) =>
      tx.userSession.findMany({
        where: { userId: s.userId, revokedAt: null, expiresAt: { gt: new Date() }, mfaVerified: true },
        orderBy: { lastSeenAt: "desc" },
        select: { id: true, userAgent: true, ipPrefix: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      }),
    );
    return {
      data: rows.map((r) => ({
        id: r.id, current: r.id === s.sessionId, userAgent: r.userAgent, ipPrefix: r.ipPrefix,
        createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      })),
    };
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  async revokeOne(@CurrentSession() s: SessionContext, @Param("sessionId") id: string, @Client() client: ClientInfo): Promise<void> {
    if (!z.uuid().safeParse(id).success || !(await this.sessions.revokeById(s.userId, id))) throw Errors.notFound();
    await this.audit.record({ stream: userStream(s.userId), actorType: "USER", actorId: s.userId, action: "auth.session_revoked", targetType: "session", targetId: id, client });
  }

  @Delete("sessions")
  @HttpCode(200)
  async revokeOthers(@CurrentSession() s: SessionContext, @Client() client: ClientInfo): Promise<DataEnvelope<{ revoked: number }>> {
    const revoked = await this.sessions.revokeAll(s.userId, s.sessionId);
    await this.audit.record({ stream: userStream(s.userId), actorType: "USER", actorId: s.userId, action: "auth.sessions_revoked_others", changes: { revoked }, client });
    return { data: { revoked } };
  }
}
