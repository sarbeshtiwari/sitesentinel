import { Body, Controller, Get, Inject, Injectable, Patch } from "@nestjs/common";
import type { Db } from "@wim/db";
import { UpdateMeInput, type DataEnvelope, type MeDto } from "@wim/contracts";
import { APP_DB } from "../infra/infra.module.js";
import { Client, CurrentSession, parse, type ClientInfo, type SessionContext } from "../common/context.js";
import { AuditService, userStream } from "../audit/audit.service.js";
import { MfaService } from "../auth/mfa.service.js";
@Injectable()
export class MeService {
  constructor(@Inject(APP_DB) private readonly db: Db, private readonly mfa: MfaService) {}

  async get(userId: string): Promise<MeDto> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true, timezone: true, locale: true, totpEnabledAt: true },
    });
    const orgs = await this.db.$queryRaw<Array<{ org_id: string; org_name: string; org_slug: string; role_id: string; role_key: string; role_name: string }>>`
      SELECT * FROM user_memberships(${userId}::uuid)`;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
      timezone: user.timezone,
      locale: user.locale,
      twoFactor: { enabled: user.totpEnabledAt !== null, recoveryCodesRemaining: user.totpEnabledAt ? await this.mfa.recoveryCodesRemaining(userId) : 0 },
      orgs: orgs.map((o) => ({ id: o.org_id, name: o.org_name, slug: o.org_slug, role: { id: o.role_id, key: o.role_key, name: o.role_name } })),
    };
  }
}

@Controller("api/v1/me")
export class MeController {
  constructor(private readonly me: MeService, @Inject(APP_DB) private readonly db: Db, private readonly audit: AuditService) {}

  @Get()
  async get(@CurrentSession() s: SessionContext): Promise<DataEnvelope<MeDto>> {
    return { data: await this.me.get(s.userId) };
  }

  @Patch()
  async update(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() client: ClientInfo): Promise<DataEnvelope<MeDto>> {
    const input = parse(UpdateMeInput, body);
    await this.db.user.update({ where: { id: s.userId }, data: input, select: { id: true } });
    await this.audit.record({ stream: userStream(s.userId), actorType: "USER", actorId: s.userId, action: "user.profile_updated", changes: { fields: Object.keys(input) }, client });
    return { data: await this.me.get(s.userId) };
  }

  @Get("invitations")
  async invitations(@CurrentSession() s: SessionContext) {
    if (!s.emailVerified) return { data: [] };
    const rows = await this.db.$queryRaw<Array<{ id: string; org_id: string; org_name: string; role_name: string; expires_at: Date }>>`
      SELECT * FROM pending_invitations_for_email(${s.email}::citext)`;
    return { data: rows.map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.org_name, roleName: r.role_name, expiresAt: r.expires_at.toISOString() })) };
  }
}
