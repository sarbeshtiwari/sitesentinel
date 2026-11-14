import { Controller, Get, Global, Inject, Injectable, Module, Param, Query } from "@nestjs/common";
import { withTenant, withUser, type Db, type Tx } from "@wim/db";
import { PageQuery, type AuditEntryDto, type ListEnvelope } from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { CurrentSession, parse, RequirePermission, type ClientInfo, type SessionContext } from "../common/context.js";

export type ActorType = "USER" | "ADMIN" | "SYSTEM";

export interface AuditEntry {
  /** "org:<id>", "user:<id>" or "platform" — each stream is its own hash chain (040_audit.sql). */
  stream: string;
  orgId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  changes?: Record<string, unknown> | null;
  reason?: string | null;
  client?: Pick<ClientInfo, "ipPrefix" | "requestId"> | null;
}

export const orgStream = (orgId: string) => `org:${orgId}`;
export const userStream = (userId: string) => `user:${userId}`;
export const PLATFORM_STREAM = "platform";

/**
 * Append-only, hash-chained audit trail. Pass the surrounding transaction so the
 * audit row commits atomically with the change it describes. seq/prev_hash/hash
 * are assigned by the database trigger, never by application code.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async record(entry: AuditEntry, tx?: Tx | Db): Promise<void> {
    // createMany issues INSERT without RETURNING: the audit_read_own SELECT policy must not
    // apply to the row being written (auth events happen before any user/org context).
    await (tx ?? this.db).auditLog.createMany({
      data: {
        stream: entry.stream,
        orgId: entry.orgId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        changes: (entry.changes ?? undefined) as never,
        reason: entry.reason ?? null,
        ipPrefix: entry.client?.ipPrefix ?? null,
        requestId: entry.client?.requestId ?? null,
      },
    });
  }

  /** Read a stream inside the matching RLS context (audit_read_own policy, 060_identity.sql). */
  async list(
    scope: { orgId: string } | { userId: string },
    q: { limit: number; cursor?: string },
  ): Promise<ListEnvelope<AuditEntryDto>> {
    const cursor = q.cursor && /^\d+$/.test(q.cursor) ? BigInt(q.cursor) : undefined;
    const stream = "orgId" in scope ? orgStream(scope.orgId) : userStream(scope.userId);
    const query = (tx: Tx) => tx.auditLog.findMany({
      where: { stream, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: "desc" },
      take: q.limit + 1,
    });
    const rows = "orgId" in scope ? await withTenant(this.db, scope.orgId, query) : await withUser(this.db, scope.userId, query);
    const page = rows.slice(0, q.limit);
    return {
      data: page.map(toAuditDto),
      nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
    };
  }
}

export function toAuditDto(r: {
  id: bigint; seq: bigint; occurredAt: Date; actorType: string; actorLabel: string | null; action: string;
  targetType: string | null; targetId: string | null; ipPrefix: string | null; changes: unknown; reason: string | null;
}): AuditEntryDto {
  return {
    id: String(r.id), seq: String(r.seq), occurredAt: r.occurredAt.toISOString(), actorType: r.actorType,
    actorLabel: r.actorLabel, action: r.action, targetType: r.targetType, targetId: r.targetId,
    ipPrefix: r.ipPrefix, changes: r.changes ?? null, reason: r.reason,
  };
}

@Controller("api/v1")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Organization audit trail (audit:read). */
  @Get("orgs/:orgId/audit-logs")
  @RequirePermission("audit:read")
  orgLog(@Param("orgId") orgId: string, @Query() query: unknown) {
    return this.audit.list({ orgId }, parse(PageQuery, query));
  }

  /** The signed-in user's own security activity (logins, 2FA, password changes). */
  @Get("me/activity")
  myActivity(@CurrentSession() s: SessionContext, @Query() query: unknown) {
    return this.audit.list({ userId: s.userId }, parse(PageQuery, query));
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
