import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import { randomToken, sha256Hex } from "@wim/crypto";
import type { Db } from "@wim/db";
import type { AdminRoleKey } from "@wim/core";
import { ADMIN_DB, REDIS } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { SettingsService } from "../settings/settings.service.js";
import { cookieNames, type IssuedSession } from "../auth/session.service.js";
import type { AdminContext, ClientInfo } from "../common/context.js";

const CACHE_TTL_SEC = 30;

interface Cached extends AdminContext { lastSeenAt: number; expiresAt: number; createdAt: number }

/**
 * Super Admin sessions: separate table, separate cookie, separate DB role,
 * short idle/absolute limits (settings admin.session.*). Only created after
 * password + TOTP, so there is no partial admin session state.
 */
@Injectable()
export class AdminSessionService {
  constructor(
    @Inject(ADMIN_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  async create(adminId: string, client: ClientInfo): Promise<IssuedSession> {
    const s = await this.settings.get();
    const token = randomToken(32);
    const csrfSecret = randomToken(32);
    const expiresAt = new Date(Date.now() + s["admin.session.absoluteHours"] * 3_600_000);
    const row = await this.db.adminSession.create({
      data: { adminUserId: adminId, tokenHash: sha256Hex(token), csrfSecret, ipPrefix: client.ipPrefix, expiresAt },
      select: { id: true },
    });
    return { token, csrfSecret, sessionId: row.id, expiresAt };
  }

  async resolve(token: string): Promise<AdminContext | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = sha256Hex(token);
    const key = `asess:${tokenHash}`;
    let c: Cached | null = null;
    const hit = await this.redis.get(key);
    if (hit) c = JSON.parse(hit) as Cached;
    else {
      const row = await this.db.adminSession.findUnique({
        where: { tokenHash },
        select: { id: true, csrfSecret: true, revokedAt: true, expiresAt: true, lastSeenAt: true, createdAt: true, adminUser: { select: { id: true, email: true, role: true, active: true } } },
      });
      if (!row || row.revokedAt || !row.adminUser.active) return null;
      c = {
        sessionId: row.id, adminId: row.adminUser.id, email: row.adminUser.email, role: row.adminUser.role as AdminRoleKey,
        csrfSecret: row.csrfSecret, tokenHash, lastSeenAt: row.lastSeenAt.getTime(), expiresAt: row.expiresAt.getTime(), createdAt: row.createdAt.getTime(),
      };
    }
    const idleMs = (await this.settings.get())["admin.session.idleMinutes"] * 60_000;
    const now = Date.now();
    if (now >= c.expiresAt || now - c.lastSeenAt > idleMs) {
      await this.revoke(c.sessionId, tokenHash);
      return null;
    }
    // Admin idle timeout is short, so last-seen is refreshed on every request (cheap: a few admins).
    c.lastSeenAt = now;
    await this.db.adminSession.update({ where: { id: c.sessionId }, data: { lastSeenAt: new Date(now) }, select: { id: true } });
    await this.redis.set(key, JSON.stringify(c), "EX", CACHE_TTL_SEC);
    const { lastSeenAt: _l, expiresAt: _e, createdAt: _c, ...ctx } = c;
    return ctx;
  }

  async revoke(sessionId: string, tokenHash: string): Promise<void> {
    await this.db.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.redis.del(`asess:${tokenHash}`);
  }

  setCookies(reply: FastifyReply, issued: IssuedSession) {
    const n = cookieNames(this.env);
    // SameSite=Strict for the admin origin: no cross-site navigation ever carries the admin session.
    const common = { path: "/", secure: this.env.COOKIE_SECURE, sameSite: "strict" as const, expires: issued.expiresAt };
    reply.setCookie(n.adminSession, issued.token, { ...common, httpOnly: true });
    reply.setCookie(n.adminCsrf, issued.csrfSecret, { ...common, httpOnly: false });
  }

  clearCookies(reply: FastifyReply) {
    const n = cookieNames(this.env);
    reply.clearCookie(n.adminSession, { path: "/" });
    reply.clearCookie(n.adminCsrf, { path: "/" });
  }
}
