import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client, inviteAndAccept, PASSWORD, startHarness, tokenFrom, uniqueEmail, userWithOrg, verifiedUser, waitForEmail, type Harness,
} from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.stop(); });

const roleId = async (c: Client, orgId: string, key: string) =>
  (await c.get(`/api/v1/orgs/${orgId}/roles`)).body.data.find((r: { key: string }) => r.key === key).id as string;

describe("organizations", () => {
  it("requires a verified email to create an organization", async () => {
    const c = Client.customer(h.app);
    const email = uniqueEmail("unverified");
    await c.post("/api/v1/auth/register", { email, password: PASSWORD, name: "U", acceptTerms: true, termsVersion: "2026-11-13" });
    await c.post("/api/v1/auth/login", { email, password: PASSWORD });
    const r = await c.post("/api/v1/orgs", { name: "Nope Inc" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("creates an org with the caller as OWNER, a wrapped data key and an audit entry", async () => {
    const o = await userWithOrg(h.app, "creator");
    const org = await o.client.get(`/api/v1/orgs/${o.orgId}`);
    expect(org.body.data.myRole.key).toBe("OWNER");
    expect(org.body.data.myRole.permissions).toContain("billing:manage");
    expect(org.body.data.timezone).toBe("Asia/Kolkata");
    expect(org.body.data.currency).toBe("INR");
    const key = await h.owner.query("SELECT kek_id, length(wrapped_dek) AS len FROM org_encryption_keys WHERE org_id = $1", [o.orgId]);
    expect(key.rowCount).toBe(1);
    expect(key.rows[0].len).toBe(12 + 16 + 32); // iv + tag + wrapped 256-bit key
    const audit = await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`);
    expect(audit.body.data[0].action).toBe("org.created");
  });

  it("updates settings with an audited before/after diff", async () => {
    const o = await userWithOrg(h.app, "updater");
    const r = await o.client.patch(`/api/v1/orgs/${o.orgId}`, { name: "Renamed Co" });
    expect(r.body.data.name).toBe("Renamed Co");
    const audit = await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`);
    expect(audit.body.data[0]).toMatchObject({ action: "org.updated", changes: { name: { from: "updater org", to: "Renamed Co" } } });
  });
});

describe("invitations", () => {
  it("invites by email; the invitee accepts with the emailed token (single use)", async () => {
    const o = await userWithOrg(h.app, "inviter");
    const invitee = await verifiedUser(h.app, "invitee");
    const member = await inviteAndAccept(o.client, o.orgId, invitee, "MEMBER");
    expect(member).toBeDefined();
    const orgs = await invitee.client.get("/api/v1/orgs");
    expect(orgs.body.data.map((x: { id: string }) => x.id)).toContain(o.orgId);
    const audit = await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`);
    expect(audit.body.data.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["invitation.created", "invitation.accepted"]));
  });

  it("only the addressed (verified) email can accept", async () => {
    const o = await userWithOrg(h.app, "inv2");
    const intended = uniqueEmail("intended");
    const intruder = await verifiedUser(h.app, "intruder");
    await o.client.post(`/api/v1/orgs/${o.orgId}/invitations`, { email: intended, roleId: await roleId(o.client, o.orgId, "VIEWER") });
    const mail = await waitForEmail(intended, "invited");
    const r = await intruder.client.post("/api/v1/invitations/accept", { token: tokenFrom(mail.text) });
    expect(r.status).toBe(403);
    // Accept-by-id is bound to the invitee's email in the database function.
    const inv = await o.client.get(`/api/v1/orgs/${o.orgId}/invitations`);
    const byId = await intruder.client.post("/api/v1/invitations/accept", { invitationId: inv.body.data[0].id });
    expect(byId.body.error.code).toBe("INVALID_TOKEN");
  });

  it("re-sending rotates the token so earlier links stop working; revoked invitations can't be used", async () => {
    const o = await userWithOrg(h.app, "inv3");
    const invitee = await verifiedUser(h.app, "invitee3");
    const created = await o.client.post(`/api/v1/orgs/${o.orgId}/invitations`, { email: invitee.email, roleId: await roleId(o.client, o.orgId, "VIEWER") });
    const first = tokenFrom((await waitForEmail(invitee.email, "invited")).text);
    const after = new Date();
    await o.client.post(`/api/v1/orgs/${o.orgId}/invitations/${created.body.data.id}/resend`);
    const second = tokenFrom((await waitForEmail(invitee.email, "invited", { after })).text);
    expect(second).not.toBe(first);
    expect((await invitee.client.post("/api/v1/invitations/accept", { token: first })).body.error.code).toBe("INVALID_TOKEN");
    expect((await o.client.del(`/api/v1/orgs/${o.orgId}/invitations/${created.body.data.id}`)).status).toBe(204);
    expect((await invitee.client.post("/api/v1/invitations/accept", { token: second })).body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("role-based access control", () => {
  it("viewers can read but not manage; members cannot manage members", async () => {
    const o = await userWithOrg(h.app, "rbac");
    const viewer = await verifiedUser(h.app, "viewer");
    const member = await verifiedUser(h.app, "member");
    await inviteAndAccept(o.client, o.orgId, viewer, "VIEWER");
    await inviteAndAccept(o.client, o.orgId, member, "MEMBER");
    expect((await viewer.client.get(`/api/v1/orgs/${o.orgId}/members`)).status).toBe(200);
    const vInvite = await viewer.client.post(`/api/v1/orgs/${o.orgId}/invitations`, { email: uniqueEmail("x"), roleId: await roleId(o.client, o.orgId, "VIEWER") });
    expect(vInvite.status).toBe(403);
    expect(vInvite.body.error.code).toBe("FORBIDDEN");
    expect((await viewer.client.patch(`/api/v1/orgs/${o.orgId}`, { name: "hijack" })).status).toBe(403);
    expect((await member.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`)).status).toBe(403);
    const members = (await o.client.get(`/api/v1/orgs/${o.orgId}/members`)).body.data;
    const viewerRow = members.find((m: { email: string }) => m.email === viewer.email);
    expect((await member.client.patch(`/api/v1/orgs/${o.orgId}/members/${viewerRow.id}`, { roleId: await roleId(o.client, o.orgId, "ADMIN") })).status).toBe(403);
  });

  it("prevents privilege escalation: no assigning OWNER, admins can't touch owners, nobody edits themselves", async () => {
    const o = await userWithOrg(h.app, "esc");
    const admin = await verifiedUser(h.app, "escadmin");
    const adminMember = await inviteAndAccept(o.client, o.orgId, admin, "ADMIN");
    const ownerRole = await roleId(o.client, o.orgId, "OWNER");
    const members = (await o.client.get(`/api/v1/orgs/${o.orgId}/members`)).body.data;
    const ownerRow = members.find((m: { email: string }) => m.email === o.email);
    // Admin tries to make themself owner, demote the owner, remove the owner.
    expect((await admin.client.patch(`/api/v1/orgs/${o.orgId}/members/${adminMember.id}`, { roleId: ownerRole })).status).toBe(403);
    expect((await admin.client.patch(`/api/v1/orgs/${o.orgId}/members/${ownerRow.id}`, { roleId: await roleId(o.client, o.orgId, "VIEWER") })).status).toBe(403);
    expect((await admin.client.del(`/api/v1/orgs/${o.orgId}/members/${ownerRow.id}`)).status).toBe(403);
    // Admin can't invite someone as OWNER either.
    expect((await admin.client.post(`/api/v1/orgs/${o.orgId}/invitations`, { email: uniqueEmail("o"), roleId: ownerRole })).status).toBe(403);
    // Admin lacks owner-only permissions.
    expect((await admin.client.post(`/api/v1/orgs/${o.orgId}/deletion`)).status).toBe(403);
  });

  it("an organization always keeps an owner (API and database)", async () => {
    const o = await userWithOrg(h.app, "lastowner");
    const leave = await o.client.post(`/api/v1/orgs/${o.orgId}/leave`);
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe("LAST_OWNER");
    // Even the schema owner cannot leave an org without an owner (deferred constraint trigger).
    await expect(h.owner.query("DELETE FROM organization_members WHERE org_id = $1", [o.orgId])).rejects.toThrow(/must keep at least one owner/);
  });

  it("transfers ownership; the previous owner becomes admin", async () => {
    const o = await userWithOrg(h.app, "transfer");
    const next = await verifiedUser(h.app, "nextowner");
    const m = await inviteAndAccept(o.client, o.orgId, next, "ADMIN");
    const r = await o.client.post(`/api/v1/orgs/${o.orgId}/transfer-ownership`, { memberId: m.id });
    expect(r.status).toBe(200);
    const roles = Object.fromEntries(r.body.data.map((x: { email: string; role: { key: string } }) => [x.email, x.role.key]));
    expect(roles[next.email]).toBe("OWNER");
    expect(roles[o.email]).toBe("ADMIN");
    expect((await o.client.post(`/api/v1/orgs/${o.orgId}/transfer-ownership`, { memberId: m.id })).status).toBe(403);
  });

  it("custom roles: subset of the creator's permissions, never owner-only, enforced on use", async () => {
    const o = await userWithOrg(h.app, "custom");
    const bad = await o.client.post(`/api/v1/orgs/${o.orgId}/roles`, { name: "Billing bot", permissions: ["billing:manage"] });
    expect(bad.status).toBe(403);
    const created = await o.client.post(`/api/v1/orgs/${o.orgId}/roles`, { name: "Auditor", permissions: ["org:read", "member:read", "audit:read"] });
    expect(created.status).toBe(201);
    const auditor = await verifiedUser(h.app, "auditor");
    await inviteAndAccept(o.client, o.orgId, auditor, "custom:auditor");
    expect((await auditor.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`)).status).toBe(200);
    expect((await auditor.client.patch(`/api/v1/orgs/${o.orgId}`, { name: "x" })).status).toBe(403);
    // Narrowing the role takes effect on the next request.
    await o.client.patch(`/api/v1/orgs/${o.orgId}/roles/${created.body.data.id}`, { permissions: ["org:read", "member:read"] });
    expect((await auditor.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`)).status).toBe(403);
    // System roles are immutable through the API.
    const viewerRole = await roleId(o.client, o.orgId, "VIEWER");
    expect((await o.client.patch(`/api/v1/orgs/${o.orgId}/roles/${viewerRole}`, { permissions: ["org:read", "billing:read"] })).status).toBe(404);
    // In-use roles can't be deleted.
    expect((await o.client.del(`/api/v1/orgs/${o.orgId}/roles/${created.body.data.id}`)).status).toBe(409);
    const audit = (await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["role.created", "role.updated"]));
  });

  it("the database refuses owner-only permissions on custom roles and foreign-org roles on members", async () => {
    const a = await userWithOrg(h.app, "dbroleA");
    const b = await userWithOrg(h.app, "dbroleB");
    const role = await a.client.post(`/api/v1/orgs/${a.orgId}/roles`, { name: "Ops", permissions: ["org:read"] });
    await expect(h.owner.query("INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'billing:manage')", [role.body.data.id]))
      .rejects.toThrow(/owner-only permission/);
    const bMember = await h.owner.query("SELECT id FROM organization_members WHERE org_id = $1", [b.orgId]);
    await expect(h.owner.query("UPDATE organization_members SET role_id = $1 WHERE id = $2", [role.body.data.id, bMember.rows[0].id]))
      .rejects.toThrow(/does not belong to organization/);
  });

  it("role changes are audited with from/to", async () => {
    const o = await userWithOrg(h.app, "auditrole");
    const u = await verifiedUser(h.app, "promoted");
    const m = await inviteAndAccept(o.client, o.orgId, u, "VIEWER");
    await o.client.patch(`/api/v1/orgs/${o.orgId}/members/${m.id}`, { roleId: await roleId(o.client, o.orgId, "MEMBER") });
    const entry = (await o.client.get(`/api/v1/orgs/${o.orgId}/audit-logs`)).body.data.find((a: { action: string }) => a.action === "member.role_changed");
    expect(entry.changes).toMatchObject({ from: "VIEWER", to: "MEMBER", userId: m.userId });
  });
});
