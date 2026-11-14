import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  canAssignRole, canDefineCustomRole, canManageMember, isPermission, PERMISSIONS, wouldRemoveLastOwner,
  type Actor, type Permission,
} from "@wim/core";
import { randomToken, sha256Hex } from "@wim/crypto";
import { isUuid, withMember, withTenant, type Db, type Tx } from "@wim/db";
import type {
  InvitationDto, InvitationPreviewDto, MemberDto, OrgDto, OrgMembershipDto, PermissionDto, RoleDto,
} from "@wim/contracts";
import { APP_DB, EmailQueue } from "../infra/infra.module.js";
import { KeysService } from "../crypto/keys.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { AuditService, orgStream, userStream } from "../audit/audit.service.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { Errors } from "../common/errors.js";
import type { ClientInfo, OrgContext, SessionContext } from "../common/context.js";

const actorOf = (o: OrgContext): Actor => ({ roleKey: o.roleKey, permissions: o.permissions });

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "org";
}

@Injectable()
export class OrgsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly keys: KeysService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailQueue,
  ) {}

  /** Enter the org as the acting member; the database re-verifies membership (app_enter_org). */
  private member<T>(s: SessionContext, o: OrgContext, fn: (tx: Tx) => Promise<T>) {
    return withMember(this.db, { orgId: o.orgId, userId: s.userId }, fn);
  }

  // ---------------------------------------------------------------- organizations
  async create(s: SessionContext, input: { name: string; timezone?: string }, client: ClientInfo): Promise<OrgMembershipDto> {
    if (!s.emailVerified) throw Errors.emailNotVerified();
    await this.rateLimit.hit("org-create", s.userId, 10, 86_400);
    const settings = await this.settings.get();
    const owner = await this.db.role.findFirstOrThrow({ where: { key: "OWNER", orgId: null }, select: { id: true, name: true } });
    const orgId = randomUUID();
    // The only use of withTenant in the customer API: the org doesn't exist yet, so there is no
    // membership to verify. RLS WITH CHECK still requires every row to carry this new org id.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? slugify(input.name) : `${slugify(input.name)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      try {
        return await withTenant(this.db, orgId, async (tx) => {
          const org = await tx.organization.create({
            data: {
              id: orgId, name: input.name, slug,
              timezone: input.timezone ?? settings["platform.defaultTimezone"],
              currency: settings["platform.defaultCurrency"],
            },
            select: { id: true, name: true, slug: true },
          });
          await tx.organizationMember.create({ data: { orgId, userId: s.userId, roleId: owner.id } });
          await this.keys.createOrgKey(tx, orgId);
          await this.audit.record({ stream: orgStream(orgId), orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "org.created", targetType: "organization", targetId: orgId, changes: { name: input.name }, client }, tx);
          return { ...org, role: { id: owner.id, key: "OWNER", name: owner.name } };
        });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e; // slug collision → retry with suffix
      }
    }
    throw Errors.conflict("Could not allocate an organization URL; try a different name");
  }

  async list(userId: string): Promise<OrgMembershipDto[]> {
    const rows = await this.db.$queryRaw<Array<{ org_id: string; org_name: string; org_slug: string; role_id: string; role_key: string; role_name: string }>>`
      SELECT * FROM user_memberships(${userId}::uuid)`;
    return rows.map((r) => ({ id: r.org_id, name: r.org_name, slug: r.org_slug, role: { id: r.role_id, key: r.role_key, name: r.role_name } }));
  }

  async get(s: SessionContext, o: OrgContext): Promise<OrgDto> {
    return this.member(s, o, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: o.orgId } });
      const role = await tx.role.findUniqueOrThrow({ where: { id: o.roleId }, select: { id: true, key: true, name: true } });
      return {
        id: org.id, name: org.name, slug: org.slug, status: org.status, timezone: org.timezone, currency: org.currency,
        supportAccess: org.supportAccess, createdAt: org.createdAt.toISOString(),
        myRole: { ...role, permissions: [...o.permissions] },
      };
    });
  }

  async update(s: SessionContext, o: OrgContext, input: { name?: string; timezone?: string; supportAccess?: string }, client: ClientInfo): Promise<OrgDto> {
    await this.member(s, o, async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: o.orgId }, select: { name: true, timezone: true, supportAccess: true } });
      await tx.organization.update({ where: { id: o.orgId }, data: input, select: { id: true } });
      const changes = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "org.updated", targetType: "organization", targetId: o.orgId, changes, client }, tx);
    });
    return this.get(s, o);
  }

  /** Schedule deletion after a 14-day grace period (purge runs in the maintenance worker, Phase 10). */
  async requestDeletion(s: SessionContext, o: OrgContext, client: ClientInfo): Promise<{ scheduledFor: string }> {
    const scheduledFor = new Date(Date.now() + 14 * 86_400_000);
    await this.member(s, o, async (tx) => {
      await tx.organization.update({ where: { id: o.orgId }, data: { status: "PENDING_DELETION", deletionRequestedAt: new Date() }, select: { id: true } });
      await tx.dataRequest.create({ data: { kind: "DELETE_ORG", orgId: o.orgId, userId: s.userId, scheduledFor } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "org.deletion_requested", changes: { scheduledFor: scheduledFor.toISOString() }, client }, tx);
    });
    return { scheduledFor: scheduledFor.toISOString() };
  }

  async cancelDeletion(s: SessionContext, o: OrgContext, client: ClientInfo): Promise<void> {
    await this.member(s, o, async (tx) => {
      await tx.organization.update({ where: { id: o.orgId }, data: { status: "ACTIVE", deletionRequestedAt: null }, select: { id: true } });
      await tx.dataRequest.updateMany({ where: { orgId: o.orgId, kind: "DELETE_ORG", state: "QUEUED", cancelledAt: null }, data: { cancelledAt: new Date() } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "org.deletion_cancelled", client }, tx);
    });
  }

  // ---------------------------------------------------------------- members
  async members(s: SessionContext, o: OrgContext): Promise<MemberDto[]> {
    const rows = await this.member(s, o, (tx) =>
      tx.organizationMember.findMany({
        where: { orgId: o.orgId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, userId: true, createdAt: true,
          user: { select: { name: true, email: true, totpEnabledAt: true } },
          role: { select: { id: true, key: true, name: true } },
        },
      }),
    );
    return rows.map((m) => ({
      id: m.id, userId: m.userId, name: m.user.name, email: m.user.email, twoFactorEnabled: m.user.totpEnabledAt !== null,
      role: m.role, joinedAt: m.createdAt.toISOString(), isMe: m.userId === s.userId,
    }));
  }

  async changeMemberRole(s: SessionContext, o: OrgContext, memberId: string, roleId: string, client: ClientInfo): Promise<MemberDto[]> {
    await this.member(s, o, async (tx) => {
      const target = await this.loadMember(tx, o.orgId, memberId);
      const newRole = await this.loadRole(tx, o.orgId, roleId);
      this.allow(canManageMember(actorOf(o), target.role, target.userId === s.userId));
      this.allow(canAssignRole(actorOf(o), newRole));
      if (target.role.key === "OWNER" && wouldRemoveLastOwner(await this.ownerCount(tx, o.orgId), true)) throw Errors.lastOwner();
      await tx.organizationMember.update({ where: { id: target.id }, data: { roleId: newRole.id }, select: { id: true } });
      await this.audit.record({
        stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email,
        action: "member.role_changed", targetType: "member", targetId: target.id,
        changes: { userId: target.userId, from: target.role.key, to: newRole.key }, client,
      }, tx);
    });
    return this.members(s, o);
  }

  async removeMember(s: SessionContext, o: OrgContext, memberId: string, client: ClientInfo): Promise<void> {
    await this.member(s, o, async (tx) => {
      const target = await this.loadMember(tx, o.orgId, memberId);
      this.allow(canManageMember(actorOf(o), target.role, target.userId === s.userId));
      if (wouldRemoveLastOwner(await this.ownerCount(tx, o.orgId), target.role.key === "OWNER")) throw Errors.lastOwner();
      await tx.organizationMember.delete({ where: { id: target.id } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "member.removed", targetType: "member", targetId: target.id, changes: { userId: target.userId, role: target.role.key }, client }, tx);
    });
  }

  async leave(s: SessionContext, o: OrgContext, client: ClientInfo): Promise<void> {
    await this.member(s, o, async (tx) => {
      if (wouldRemoveLastOwner(await this.ownerCount(tx, o.orgId), o.roleKey === "OWNER")) throw Errors.lastOwner();
      await tx.organizationMember.delete({ where: { id: o.memberId } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "member.left", targetType: "member", targetId: o.memberId, client }, tx);
    });
  }

  /** Make another member an owner; the current owner becomes an admin. */
  async transferOwnership(s: SessionContext, o: OrgContext, memberId: string, client: ClientInfo): Promise<MemberDto[]> {
    await this.member(s, o, async (tx) => {
      const target = await this.loadMember(tx, o.orgId, memberId);
      if (target.userId === s.userId) throw Errors.conflict("You already own this organization");
      const [owner, admin] = await Promise.all([
        tx.role.findFirstOrThrow({ where: { key: "OWNER", orgId: null }, select: { id: true } }),
        tx.role.findFirstOrThrow({ where: { key: "ADMIN", orgId: null }, select: { id: true } }),
      ]);
      await tx.organizationMember.update({ where: { id: target.id }, data: { roleId: owner.id }, select: { id: true } });
      await tx.organizationMember.update({ where: { id: o.memberId }, data: { roleId: admin.id }, select: { id: true } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "org.ownership_transferred", targetType: "member", targetId: target.id, changes: { fromUserId: s.userId, toUserId: target.userId }, client }, tx);
    });
    return this.members(s, o);
  }

  // ---------------------------------------------------------------- invitations
  async invitations(s: SessionContext, o: OrgContext): Promise<InvitationDto[]> {
    const rows = await this.member(s, o, (tx) =>
      tx.invitation.findMany({
        where: { orgId: o.orgId, status: "PENDING", expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, status: true, expiresAt: true, createdAt: true, roleId: true },
      }),
    );
    const roles = await this.rolesById(s, o, rows.map((r) => r.roleId));
    return rows.map((r) => ({ id: r.id, email: r.email, role: roles.get(r.roleId)!, status: r.status, expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString() }));
  }

  async invite(s: SessionContext, o: OrgContext, input: { email: string; roleId: string }, client: ClientInfo): Promise<InvitationDto> {
    await this.rateLimit.hit("invite", o.orgId, 50, 86_400);
    const ttlDays = (await this.settings.get())["auth.invitation.ttlDays"];
    const inv = await this.member(s, o, async (tx) => {
      const role = await this.loadRole(tx, o.orgId, input.roleId);
      this.allow(canAssignRole(actorOf(o), role));
      const existingMember = await tx.organizationMember.findFirst({ where: { orgId: o.orgId, user: { email: input.email } }, select: { id: true } });
      if (existingMember) throw Errors.conflict("This person is already a member");
      const pending = await tx.invitation.findFirst({ where: { orgId: o.orgId, email: input.email, status: "PENDING", expiresAt: { gt: new Date() } }, select: { id: true } });
      if (pending) throw Errors.conflict("An invitation is already pending for this email");
      const created = await tx.invitation.create({
        // The real token is issued by the email worker at send time; this placeholder hash matches no token.
        data: { orgId: o.orgId, email: input.email, roleId: role.id, tokenHash: sha256Hex(randomToken(32)), invitedById: s.userId, expiresAt: new Date(Date.now() + ttlDays * 86_400_000) },
        select: { id: true, email: true, status: true, expiresAt: true, createdAt: true },
      });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "invitation.created", targetType: "invitation", targetId: created.id, changes: { email: input.email, role: role.key }, client }, tx);
      return { ...created, role: { id: role.id, key: role.key, name: role.name } };
    });
    await this.email.enqueue({ kind: "INVITATION", orgId: o.orgId, invitationId: inv.id }, `invite:${inv.id}:${Date.now()}`);
    return { ...inv, expiresAt: inv.expiresAt.toISOString(), createdAt: inv.createdAt.toISOString() };
  }

  async resendInvitation(s: SessionContext, o: OrgContext, id: string, client: ClientInfo): Promise<void> {
    await this.rateLimit.hit("invite-resend", id, 5, 86_400);
    await this.member(s, o, async (tx) => {
      const inv = await tx.invitation.findFirst({ where: { id, orgId: o.orgId, status: "PENDING", expiresAt: { gt: new Date() } }, select: { id: true } });
      if (!inv) throw Errors.notFound();
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "invitation.resent", targetType: "invitation", targetId: id, client }, tx);
    });
    await this.email.enqueue({ kind: "INVITATION", orgId: o.orgId, invitationId: id }, `invite:${id}:${Date.now()}`);
  }

  async revokeInvitation(s: SessionContext, o: OrgContext, id: string, client: ClientInfo): Promise<void> {
    await this.member(s, o, async (tx) => {
      const r = await tx.invitation.updateMany({ where: { id, orgId: o.orgId, status: "PENDING" }, data: { status: "REVOKED" } });
      if (r.count !== 1) throw Errors.notFound();
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "invitation.revoked", targetType: "invitation", targetId: id, client }, tx);
    });
  }

  async previewInvitation(token: string): Promise<InvitationPreviewDto> {
    const inv = await this.findInvitation({ token });
    return { orgName: inv.org_name, roleName: inv.role_name, email: inv.email, expiresAt: inv.expires_at.toISOString() };
  }

  /**
   * Accept with the emailed token, or by id from "my invitations" — in both cases
   * the invitation must be addressed to the session's VERIFIED email.
   */
  async acceptInvitation(s: SessionContext, ref: { token?: string; invitationId?: string }, client: ClientInfo): Promise<OrgMembershipDto> {
    if (!s.emailVerified) throw Errors.emailNotVerified();
    const inv = await this.findInvitation(ref, s.email);
    if (inv.email.toLowerCase() !== s.email.toLowerCase()) throw Errors.forbidden("This invitation was sent to a different email address");
    // No membership exists yet, so membership can't be the gate: the validated invitation is.
    return withTenant(this.db, inv.org_id, async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: s.userId },
      });
      if (claimed.count !== 1) throw Errors.invalidToken();
      const already = await tx.organizationMember.findFirst({ where: { orgId: inv.org_id, userId: s.userId }, select: { id: true } });
      if (!already) await tx.organizationMember.create({ data: { orgId: inv.org_id, userId: s.userId, roleId: inv.role_id } });
      const role = await tx.role.findUniqueOrThrow({ where: { id: inv.role_id }, select: { id: true, key: true, name: true } });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: inv.org_id }, select: { id: true, name: true, slug: true } });
      await this.audit.record({ stream: orgStream(inv.org_id), orgId: inv.org_id, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "invitation.accepted", targetType: "invitation", targetId: inv.id, changes: { role: role.key }, client }, tx);
      return { ...org, role };
    });
  }

  async declineInvitation(s: SessionContext, ref: { token?: string; invitationId?: string }, client: ClientInfo): Promise<void> {
    const inv = await this.findInvitation(ref, s.email);
    if (inv.email.toLowerCase() !== s.email.toLowerCase()) throw Errors.forbidden("This invitation was sent to a different email address");
    await withTenant(this.db, inv.org_id, async (tx) => {
      await tx.invitation.updateMany({ where: { id: inv.id, status: "PENDING" }, data: { status: "REVOKED" } });
      await this.audit.record({ stream: orgStream(inv.org_id), orgId: inv.org_id, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "invitation.declined", targetType: "invitation", targetId: inv.id, client }, tx);
    });
    await this.audit.record({ stream: userStream(s.userId), actorType: "USER", actorId: s.userId, action: "invitation.declined", targetType: "invitation", targetId: inv.id, client });
  }

  private async findInvitation(ref: { token?: string; invitationId?: string }, inviteeEmail?: string) {
    type Row = { id: string; org_id: string; org_name: string; email: string; role_id: string; role_name: string; status: string; expires_at: Date };
    let row: Row | undefined;
    if (ref.token) {
      row = (await this.db.$queryRaw<Row[]>`SELECT * FROM invitation_by_token_hash(${sha256Hex(ref.token)})`)[0];
    } else if (ref.invitationId && inviteeEmail && isUuid(ref.invitationId)) {
      row = (await this.db.$queryRaw<Row[]>`SELECT * FROM invitation_for_invitee(${ref.invitationId}::uuid, ${inviteeEmail}::citext)`)[0];
    }
    if (!row || row.status !== "PENDING" || row.expires_at < new Date()) throw Errors.invalidToken();
    return row;
  }

  // ---------------------------------------------------------------- roles
  permissions(): PermissionDto[] {
    return (Object.entries(PERMISSIONS) as Array<[Permission, string]>).map(([key, description]) => ({ key, description }));
  }

  async roles(s: SessionContext, o: OrgContext): Promise<RoleDto[]> {
    const rows = await this.member(s, o, (tx) =>
      tx.role.findMany({
        where: { OR: [{ orgId: null }, { orgId: o.orgId }] },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
        select: {
          id: true, key: true, name: true, description: true, isSystem: true,
          permissions: { select: { permissionKey: true } },
          _count: { select: { members: { where: { orgId: o.orgId } } } },
        },
      }),
    );
    const order = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
    return rows
      .sort((a, b) => (a.isSystem && b.isSystem ? order.indexOf(a.key) - order.indexOf(b.key) : 0))
      .map((r) => ({
        id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem,
        permissions: r.permissions.map((p) => p.permissionKey).filter(isPermission), memberCount: r._count.members,
      }));
  }

  async createRole(s: SessionContext, o: OrgContext, input: { name: string; description?: string; permissions: Permission[] }, client: ClientInfo): Promise<RoleDto> {
    this.allow(canDefineCustomRole(actorOf(o), input.permissions));
    const key = `custom:${slugify(input.name)}`;
    const id = await this.member(s, o, async (tx) => {
      if (await tx.role.findFirst({ where: { orgId: o.orgId, key }, select: { id: true } })) throw Errors.conflict("A role with this name already exists");
      const role = await tx.role.create({ data: { orgId: o.orgId, key, name: input.name, description: input.description ?? null, isSystem: false }, select: { id: true } });
      await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((p) => ({ roleId: role.id, permissionKey: p })) });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "role.created", targetType: "role", targetId: role.id, changes: { name: input.name, permissions: input.permissions }, client }, tx);
      return role.id;
    });
    return (await this.roles(s, o)).find((r) => r.id === id)!;
  }

  async updateRole(s: SessionContext, o: OrgContext, roleId: string, input: { name?: string; description?: string; permissions?: Permission[] }, client: ClientInfo): Promise<RoleDto> {
    if (input.permissions) this.allow(canDefineCustomRole(actorOf(o), input.permissions));
    await this.member(s, o, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, orgId: o.orgId }, select: { id: true, permissions: { select: { permissionKey: true } } } });
      if (!role) throw Errors.notFound(); // system roles have org_id NULL → not editable
      await tx.role.update({ where: { id: roleId }, data: { name: input.name, description: input.description }, select: { id: true } });
      if (input.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((p) => ({ roleId, permissionKey: p })) });
      }
      await this.audit.record({
        stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "role.updated", targetType: "role", targetId: roleId,
        changes: { ...input, previousPermissions: input.permissions ? role.permissions.map((p) => p.permissionKey) : undefined }, client,
      }, tx);
    });
    return (await this.roles(s, o)).find((r) => r.id === roleId)!;
  }

  async deleteRole(s: SessionContext, o: OrgContext, roleId: string, client: ClientInfo): Promise<void> {
    await this.member(s, o, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, orgId: o.orgId }, select: { id: true, key: true } });
      if (!role) throw Errors.notFound();
      const inUse = await tx.organizationMember.count({ where: { roleId } }) + await tx.invitation.count({ where: { roleId, status: "PENDING" } });
      if (inUse) throw Errors.conflict("Reassign members and pending invitations before deleting this role");
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record({ stream: orgStream(o.orgId), orgId: o.orgId, actorType: "USER", actorId: s.userId, actorLabel: s.email, action: "role.deleted", targetType: "role", targetId: roleId, changes: { key: role.key }, client }, tx);
    });
  }

  // ---------------------------------------------------------------- helpers
  private allow(d: { ok: true } | { ok: false; reason: string }) {
    if (!d.ok) throw Errors.forbidden(d.reason);
  }

  private async loadMember(tx: Tx, orgId: string, memberId: string) {
    const m = await tx.organizationMember.findFirst({
      where: { id: memberId, orgId },
      select: { id: true, userId: true, role: { select: { id: true, key: true, permissions: { select: { permissionKey: true } } } } },
    });
    if (!m) throw Errors.notFound();
    return { id: m.id, userId: m.userId, role: { key: m.role.key, permissions: m.role.permissions.map((p) => p.permissionKey).filter(isPermission) } };
  }

  private async loadRole(tx: Tx, orgId: string, roleId: string) {
    const r = await tx.role.findFirst({
      where: { id: roleId, OR: [{ orgId: null }, { orgId }] },
      select: { id: true, key: true, name: true, permissions: { select: { permissionKey: true } } },
    });
    if (!r) throw Errors.notFound();
    return { id: r.id, key: r.key, name: r.name, permissions: r.permissions.map((p) => p.permissionKey).filter(isPermission) };
  }

  private ownerCount(tx: Tx, orgId: string) {
    return tx.organizationMember.count({ where: { orgId, role: { key: "OWNER", orgId: null } } });
  }

  private async rolesById(s: SessionContext, o: OrgContext, ids: string[]) {
    const rows = await this.member(s, o, (tx) => tx.role.findMany({ where: { id: { in: ids } }, select: { id: true, key: true, name: true } }));
    return new Map(rows.map((r) => [r.id, r]));
  }
}
