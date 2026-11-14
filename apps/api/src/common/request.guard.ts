import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { isPermission, type Permission } from "@wim/core";
import { safeEqual } from "@wim/crypto";
import { isUuid, MembershipError, withMember, type Db } from "@wim/db";
import { APP_DB } from "../infra/infra.module.js";
import { ENV, type Env } from "../config/env.js";
import { cookieNames, SessionService } from "../auth/session.service.js";
import { AdminSessionService } from "../admin/admin-session.service.js";
import { Errors } from "./errors.js";
import { ADMIN_API, ADMIN_PERMISSION, ALLOW_PARTIAL, ANY_MEMBER, INFRA, ORG_PERMISSION, PUBLIC } from "./context.js";
import { adminHas, type AdminPermission } from "@wim/core";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The single authorization pipeline for every HTTP route (backend layer of the
 * defence in depth; RLS is the database layer):
 *   1. Origin check on state-changing requests (customer vs admin origin)
 *   2. Session resolution (customer or admin cookie — never both)
 *   3. CSRF: X-CSRF-Token must match the session's secret (or the pre-session cookie)
 *   4. Authentication / second-factor requirement
 *   5. Org scope: membership of :orgId (404 for non-members) and required permission
 *   6. Admin permission for admin routes
 * A route that declares none of @Public, @RequirePermission, @AnyMember is
 * session-only and must not carry :orgId (enforced below).
 */
@Injectable()
export class RequestGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly adminSessions: AdminSessionService,
    @Inject(APP_DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
    if (meta<boolean>(INFRA)) return true;

    const isAdmin = Boolean(meta<boolean>(ADMIN_API));
    const unsafe = !SAFE_METHODS.has(req.method);
    if (unsafe) this.checkOrigin(req, isAdmin ? this.env.ADMIN_URL : this.env.APP_URL);

    return isAdmin ? this.admin(req, unsafe, meta) : this.customer(req, unsafe, meta);
  }

  private async customer(req: FastifyRequest, unsafe: boolean, meta: <T>(key: string) => T | undefined): Promise<boolean> {
    const names = cookieNames(this.env);
    const token = req.cookies[names.session];
    const session = token ? await this.sessions.resolve(token) : null;
    if (session) req.session = session;

    if (unsafe) {
      const header = headerValue(req, "x-csrf-token");
      const expected = session ? session.csrfSecret : req.cookies[names.csrf];
      if (!header || !expected || !safeEqual(header, expected)) throw Errors.csrf();
    }

    if (meta<boolean>(PUBLIC)) return true;
    if (!session) throw Errors.unauthenticated();
    if (!session.mfaVerified && !meta<boolean>(ALLOW_PARTIAL)) throw Errors.secondFactorRequired();

    const permission = meta<Permission>(ORG_PERMISSION);
    const anyMember = meta<boolean>(ANY_MEMBER);
    const orgId = (req.params as Record<string, string> | undefined)?.orgId;
    if (!permission && !anyMember) {
      if (orgId !== undefined) throw new Error(`Route ${req.routeOptions.url} has :orgId but no org permission declared`);
      return true;
    }
    if (permission && !isPermission(permission)) throw new Error(`Unknown permission ${permission}`);
    if (!orgId || !isUuid(orgId)) throw Errors.notFound();

    // Membership and permission are verified by the database (app_enter_org), not only here.
    let membership;
    try {
      membership = await withMember(this.db, { orgId, userId: session.userId, permission }, (tx) =>
        tx.organizationMember.findFirstOrThrow({
          where: { orgId, userId: session.userId },
          select: {
            id: true,
            organization: { select: { status: true } },
            role: { select: { id: true, key: true, permissions: { select: { permissionKey: true } } } },
          },
        }),
      );
    } catch (e) {
      // Not a member (or the org doesn't exist): indistinguishable 404.
      if (e instanceof MembershipError) throw e.reason === "not_member" ? Errors.notFound() : Errors.forbidden();
      throw e;
    }
    if (membership.organization.status === "SUSPENDED") throw Errors.suspended();
    const permissions = new Set(membership.role.permissions.map((p) => p.permissionKey).filter(isPermission));
    req.org = { orgId, memberId: membership.id, roleId: membership.role.id, roleKey: membership.role.key, permissions };
    return true;
  }

  private async admin(req: FastifyRequest, unsafe: boolean, meta: <T>(key: string) => T | undefined): Promise<boolean> {
    const names = cookieNames(this.env);
    const token = req.cookies[names.adminSession];
    const admin = token ? await this.adminSessions.resolve(token) : null;
    if (admin) req.admin = admin;

    if (unsafe) {
      const header = headerValue(req, "x-csrf-token");
      const expected = admin ? admin.csrfSecret : req.cookies[names.adminCsrf];
      if (!header || !expected || !safeEqual(header, expected)) throw Errors.csrf();
    }
    if (meta<boolean>(PUBLIC)) return true;
    if (!admin) throw Errors.unauthenticated();
    const perm = meta<AdminPermission>(ADMIN_PERMISSION);
    if (perm && !adminHas(admin.role, perm)) throw Errors.forbidden();
    return true;
  }

  private checkOrigin(req: FastifyRequest, expectedUrl: string) {
    const expected = new URL(expectedUrl).origin;
    const origin = headerValue(req, "origin");
    if (origin) {
      if (origin !== expected) throw Errors.csrf();
      return;
    }
    // Browsers send Origin on every cross-site and same-origin POST; fall back to Referer for old clients.
    const referer = headerValue(req, "referer");
    if (!referer) throw Errors.csrf();
    try {
      if (new URL(referer).origin !== expected) throw Errors.csrf();
    } catch {
      throw Errors.csrf();
    }
  }
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
