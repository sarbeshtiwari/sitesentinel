import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ZodType, z } from "zod";
import type { AdminPermission, AdminRoleKey, Permission } from "@wim/core";
import { ipPrefix } from "@wim/crypto";

// ---------------------------------------------------------------- request context
export interface SessionContext {
  sessionId: string;
  userId: string;
  mfaVerified: boolean;
  csrfSecret: string;
  email: string;
  emailVerified: boolean;
  tokenHash: string;
}

export interface OrgContext {
  orgId: string;
  memberId: string;
  roleId: string;
  roleKey: string;
  permissions: ReadonlySet<Permission>;
}

export interface AdminContext {
  sessionId: string;
  adminId: string;
  email: string;
  role: AdminRoleKey;
  csrfSecret: string;
  tokenHash: string;
}

export interface ClientInfo { ip: string | null; ipPrefix: string | null; userAgent: string | null; requestId: string }

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionContext;
    org?: OrgContext;
    admin?: AdminContext;
  }
}

// ---------------------------------------------------------------- route metadata
/** Customer route reachable without a session (login, register, public config, …). */
export const PUBLIC = "wim:public";
export const Public = () => SetMetadata(PUBLIC, true);

/** Customer route usable with a partial (second factor pending) session. */
export const ALLOW_PARTIAL = "wim:allowPartial";
export const AllowPartialSession = () => SetMetadata(ALLOW_PARTIAL, true);

/** Org-scoped route: requires membership of :orgId and the given permission. */
export const ORG_PERMISSION = "wim:orgPermission";
export const RequirePermission = (p: Permission) => SetMetadata(ORG_PERMISSION, p);
/** Org-scoped route where any member may act (e.g. leaving an org); checks happen in the handler. */
export const ANY_MEMBER = "wim:anyMember";
export const AnyMember = () => SetMetadata(ANY_MEMBER, true);

/** Super Admin API controller (separate cookie, CSRF origin and DB role). */
export const ADMIN_API = "wim:adminApi";
export const AdminApi = () => SetMetadata(ADMIN_API, true);
export const ADMIN_PERMISSION = "wim:adminPermission";
export const RequireAdminPermission = (p: AdminPermission) => SetMetadata(ADMIN_PERMISSION, p);

/** Liveness/readiness probes (no auth, no CSRF). */
export const INFRA = "wim:infra";
export const Infra = () => SetMetadata(INFRA, true);

// ---------------------------------------------------------------- param decorators
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const s = ctx.switchToHttp().getRequest<FastifyRequest>().session;
  if (!s) throw new Error("CurrentSession used on a route without a session");
  return s;
});

export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const o = ctx.switchToHttp().getRequest<FastifyRequest>().org;
  if (!o) throw new Error("CurrentOrg used on a route without org scope");
  return o;
});

export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const a = ctx.switchToHttp().getRequest<FastifyRequest>().admin;
  if (!a) throw new Error("CurrentAdmin used on a non-admin route");
  return a;
});

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  return clientInfo(req);
});

export function clientInfo(req: FastifyRequest): ClientInfo {
  const ua = req.headers["user-agent"];
  return {
    ip: req.ip ?? null,
    ipPrefix: ipPrefix(req.ip),
    userAgent: typeof ua === "string" ? ua.slice(0, 300) : null,
    requestId: String(req.id),
  };
}

/** Validate input with a shared @wim/contracts schema (ZodError → VALIDATION_FAILED). */
export function parse<S extends ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input ?? {});
}
