import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  CreateOrgInput, CreateRoleInput, InviteInput, UpdateMemberInput, UpdateOrgInput, UpdateRoleInput, Uuid,
  type DataEnvelope, type InvitationDto, type InvitationPreviewDto, type MemberDto, type OrgDto, type OrgMembershipDto,
  type PermissionDto, type RoleDto,
} from "@wim/contracts";
import {
  AnyMember, Client, CurrentOrg, CurrentSession, parse, Public, RequirePermission,
  type ClientInfo, type OrgContext, type SessionContext,
} from "../common/context.js";
import { OrgsService } from "./orgs.service.js";

const id = (v: string) => parse(Uuid, v);
const InvitationRef = z.union([z.object({ token: z.string().min(20).max(200) }), z.object({ invitationId: Uuid })]);

@Controller("api/v1/orgs")
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Post()
  async create(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<OrgMembershipDto>> {
    return { data: await this.orgs.create(s, parse(CreateOrgInput, body), c) };
  }

  @Get()
  async list(@CurrentSession() s: SessionContext): Promise<DataEnvelope<OrgMembershipDto[]>> {
    return { data: await this.orgs.list(s.userId) };
  }

  @Get(":orgId")
  @RequirePermission("org:read")
  async get(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext): Promise<DataEnvelope<OrgDto>> {
    return { data: await this.orgs.get(s, o) };
  }

  @Patch(":orgId")
  @RequirePermission("org:update")
  async update(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<OrgDto>> {
    return { data: await this.orgs.update(s, o, parse(UpdateOrgInput, body), c) };
  }

  @Post(":orgId/deletion")
  @RequirePermission("org:delete")
  @HttpCode(202)
  async requestDeletion(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Client() c: ClientInfo) {
    return { data: await this.orgs.requestDeletion(s, o, c) };
  }

  @Delete(":orgId/deletion")
  @RequirePermission("org:delete")
  @HttpCode(204)
  async cancelDeletion(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Client() c: ClientInfo) {
    await this.orgs.cancelDeletion(s, o, c);
  }

  @Post(":orgId/transfer-ownership")
  @RequirePermission("org:transfer_ownership")
  @HttpCode(200)
  async transfer(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<MemberDto[]>> {
    return { data: await this.orgs.transferOwnership(s, o, parse(z.object({ memberId: Uuid }), body).memberId, c) };
  }

  // ---------------------------------------------------------------- members
  @Get(":orgId/members")
  @RequirePermission("member:read")
  async members(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext): Promise<DataEnvelope<MemberDto[]>> {
    return { data: await this.orgs.members(s, o) };
  }

  @Patch(":orgId/members/:memberId")
  @RequirePermission("member:manage")
  async changeRole(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("memberId") memberId: string, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<MemberDto[]>> {
    return { data: await this.orgs.changeMemberRole(s, o, id(memberId), parse(UpdateMemberInput, body).roleId, c) };
  }

  @Delete(":orgId/members/:memberId")
  @RequirePermission("member:manage")
  @HttpCode(204)
  async remove(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("memberId") memberId: string, @Client() c: ClientInfo) {
    await this.orgs.removeMember(s, o, id(memberId), c);
  }

  @Post(":orgId/leave")
  @AnyMember()
  @HttpCode(204)
  async leave(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Client() c: ClientInfo) {
    await this.orgs.leave(s, o, c);
  }

  // ---------------------------------------------------------------- invitations
  @Get(":orgId/invitations")
  @RequirePermission("member:manage")
  async invitations(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext): Promise<DataEnvelope<InvitationDto[]>> {
    return { data: await this.orgs.invitations(s, o) };
  }

  @Post(":orgId/invitations")
  @RequirePermission("member:manage")
  async invite(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<InvitationDto>> {
    return { data: await this.orgs.invite(s, o, parse(InviteInput, body), c) };
  }

  @Post(":orgId/invitations/:invitationId/resend")
  @RequirePermission("member:manage")
  @HttpCode(202)
  async resend(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("invitationId") invitationId: string, @Client() c: ClientInfo) {
    await this.orgs.resendInvitation(s, o, id(invitationId), c);
    return { data: { status: "SENT" } };
  }

  @Delete(":orgId/invitations/:invitationId")
  @RequirePermission("member:manage")
  @HttpCode(204)
  async revoke(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("invitationId") invitationId: string, @Client() c: ClientInfo) {
    await this.orgs.revokeInvitation(s, o, id(invitationId), c);
  }

  // ---------------------------------------------------------------- roles
  @Get(":orgId/roles")
  @RequirePermission("member:read")
  async roles(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext): Promise<DataEnvelope<RoleDto[]>> {
    return { data: await this.orgs.roles(s, o) };
  }

  @Post(":orgId/roles")
  @RequirePermission("role:manage")
  async createRole(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<RoleDto>> {
    return { data: await this.orgs.createRole(s, o, parse(CreateRoleInput, body), c) };
  }

  @Patch(":orgId/roles/:roleId")
  @RequirePermission("role:manage")
  async updateRole(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("roleId") roleId: string, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<RoleDto>> {
    return { data: await this.orgs.updateRole(s, o, id(roleId), parse(UpdateRoleInput, body), c) };
  }

  @Delete(":orgId/roles/:roleId")
  @RequirePermission("role:manage")
  @HttpCode(204)
  async deleteRole(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("roleId") roleId: string, @Client() c: ClientInfo) {
    await this.orgs.deleteRole(s, o, id(roleId), c);
  }
}

@Controller("api/v1")
export class InvitationsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get("permissions")
  permissions(): DataEnvelope<PermissionDto[]> {
    return { data: this.orgs.permissions() };
  }

  /** What an invitation link is for (org and role names only), before signing in. */
  @Public()
  @Get("invitations/preview")
  async preview(@Query("token") token: string): Promise<DataEnvelope<InvitationPreviewDto>> {
    return { data: await this.orgs.previewInvitation(parse(z.string().min(20).max(200), token)) };
  }

  @Post("invitations/accept")
  @HttpCode(200)
  async accept(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() c: ClientInfo): Promise<DataEnvelope<OrgMembershipDto>> {
    return { data: await this.orgs.acceptInvitation(s, parse(InvitationRef, body), c) };
  }

  @Post("invitations/decline")
  @HttpCode(204)
  async decline(@CurrentSession() s: SessionContext, @Body() body: unknown, @Client() c: ClientInfo) {
    await this.orgs.declineInvitation(s, parse(InvitationRef, body), c);
  }
}
