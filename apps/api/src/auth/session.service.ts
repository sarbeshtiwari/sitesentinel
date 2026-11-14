import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import { randomToken, sha256Hex } from "@wim/crypto";
import { withUser, type Db } from "@wim/db";
import { APP_DB, REDIS } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { SettingsService } from "../settings/settings.service.js";
import type { ClientInfo, SessionContext } from "../common/context.js";

const CACHE_TTL_SEC = 60;
const TOUCH_INTERVAL_MS = 5 * 60_000;

interface CachedSession extends SessionContext {
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface IssuedSession { token: string; csrfSecret: string; sessionId: string; expiresAt: Date }

export function cookieNames(env: Env) {
  // __Host- prefix requires Secure + Path=/ + no Domain: binds the cookie to the exact origin.
  const p = env.COOKIE_SECURE ? "__Host-" : "";
  return { session: `${p}wim_sid`, csrf: `${p}wim_csrf`, adminSession: `${p}wim_admin_sid`, adminCsrf: `${p}wim_admin_csrf` };
}

/**
 * Opaque server-side sessions (D-09). The cookie holds a random 256-bit token;
 * the database holds only its SHA-256. Redis caches lookups for 60 s and is
 * purged on revocation, so revocation takes effect on the next request.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  async create(userId: string, opts: { mfaVerified: boolean; client: ClientInfo }): Promise<IssuedSession> {
    const s = await this.settings.get();
    const token = randomToken(32);
    const csrfSecret = randomToken(32);
    const ttlMs = opts.mfaVerified
      ? s["auth.session.absoluteDays"] * 86_400_000
      : s["auth.partialSessionMinutes"] * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const row = await withUser(this.db, userId, (tx) =>
      tx.userSession.create({
        data: {
          userId,
          tokenHash: sha256Hex(token),
          csrfSecret,
          mfaVerified: opts.mfaVerified,
          ipPrefix: opts.client.ipPrefix,
          userAgent: opts.client.userAgent,
          expiresAt,
        },
        select: { id: true },
      }),
    );
    return { token, csrfSecret, sessionId: row.id, expiresAt };
  }

  /** Resolve a cookie token to a live session, or null (expired, idle, revoked, user not active). */
  async resolve(token: string): Promise<SessionContext | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = sha256Hex(token);
    const cacheKey = `sess:${tokenHash}`;
    let s: CachedSession | null = null;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      s = JSON.parse(cached) as CachedSession;
    } else {
      const rows = await this.db.$queryRaw<Array<{
        session_id: string; user_id: string; mfa_verified: boolean; csrf_secret: string; created_at: Date;
        last_seen_at: Date; expires_at: Date; revoked_at: Date | null; user_status: string; email: string; email_verified: boolean;
      }>>`SELECT * FROM session_lookup(${tokenHash})`;
      const r = rows[0];
      if (!r || r.revoked_at || r.user_status !== "ACTIVE") return null;
      s = {
        sessionId: r.session_id, userId: r.user_id, mfaVerified: r.mfa_verified, csrfSecret: r.csrf_secret,
        email: r.email, emailVerified: r.email_verified, tokenHash,
        createdAt: r.created_at.getTime(), lastSeenAt: r.last_seen_at.getTime(), expiresAt: r.expires_at.getTime(),
      };
      await this.redis.set(cacheKey, JSON.stringify(s), "EX", CACHE_TTL_SEC);
      await this.redis.sadd(`usess:${s.userId}`, tokenHash);
      await this.redis.expire(`usess:${s.userId}`, 7 * 86_400);
    }
    const now = Date.now();
    const settings = await this.settings.get();
    const idleMs = s.mfaVerified ? settings["auth.session.idleHours"] * 3_600_000 : Number.POSITIVE_INFINITY;
    if (now >= s.expiresAt || now - s.lastSeenAt > idleMs) {
      await this.revokeById(s.userId, s.sessionId);
      return null;
    }
    if (now - s.lastSeenAt > TOUCH_INTERVAL_MS) {
      await withUser(this.db, s.userId, (tx) =>
        tx.userSession.update({ where: { id: s.sessionId }, data: { lastSeenAt: new Date(now) }, select: { id: true } }),
      );
      s.lastSeenAt = now;
      await this.redis.set(cacheKey, JSON.stringify(s), "EX", CACHE_TTL_SEC);
    }
    const { createdAt: _c, lastSeenAt: _l, expiresAt: _e, ...ctx } = s;
    return ctx;
  }

  async revokeById(userId: string, sessionId: string): Promise<boolean> {
    const row = await withUser(this.db, userId, async (tx) => {
      const found = await tx.userSession.findFirst({ where: { id: sessionId, userId, revokedAt: null }, select: { tokenHash: true } });
      if (!found) return null;
      await tx.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() }, select: { id: true } });
      return found;
    });
    if (!row) return false;
    await this.redis.del(`sess:${row.tokenHash}`);
    await this.redis.srem(`usess:${userId}`, row.tokenHash);
    return true;
  }

  /** Revoke every session of a user except (optionally) one. Returns the number revoked. */
  async revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    const hashes = await withUser(this.db, userId, async (tx) => {
      const rows = await tx.userSession.findMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        select: { id: true, tokenHash: true },
      });
      if (rows.length) {
        await tx.userSession.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { revokedAt: new Date() } });
      }
      return rows.map((r) => r.tokenHash);
    });
    if (hashes.length) {
      await this.redis.del(...hashes.map((h) => `sess:${h}`));
      await this.redis.srem(`usess:${userId}`, ...hashes);
    }
    return hashes.length;
  }

  /** Replace a session with a fresh token (fixation defence on privilege change). */
  async rotate(current: SessionContext, opts: { mfaVerified: boolean; client: ClientInfo }): Promise<IssuedSession> {
    await this.revokeById(current.userId, current.sessionId);
    return this.create(current.userId, opts);
  }

  /** Purge cached user fields (email verified, status) for all of a user's sessions. */
  async refreshUser(userId: string): Promise<void> {
    const hashes = await this.redis.smembers(`usess:${userId}`);
    if (hashes.length) await this.redis.del(...hashes.map((h) => `sess:${h}`));
  }

  setCookies(reply: FastifyReply, issued: IssuedSession) {
    const names = cookieNames(this.env);
    const common = { path: "/", secure: this.env.COOKIE_SECURE, sameSite: "lax" as const, expires: issued.expiresAt };
    reply.setCookie(names.session, issued.token, { ...common, httpOnly: true });
    reply.setCookie(names.csrf, issued.csrfSecret, { ...common, httpOnly: false });
  }

  clearCookies(reply: FastifyReply) {
    const names = cookieNames(this.env);
    reply.clearCookie(names.session, { path: "/" });
    reply.clearCookie(names.csrf, { path: "/" });
  }
}
