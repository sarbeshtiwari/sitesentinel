"use client";
import {
  Alert, Avatar, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, FormField,
  Input, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR, toast,
} from "@wim/ui";
import { InviteInput, type DataEnvelope, type InvitationDto, type MemberDto, type RoleDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Mail, MailPlus, ShieldCheck, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useOrg } from "@/lib/hooks";

type Pending =
  | { kind: "remove"; member: MemberDto }
  | { kind: "transfer"; member: MemberDto }
  | { kind: "leave" }
  | { kind: "revoke"; invitation: InvitationDto };

export default function TeamPage() {
  const { orgId, can, data: org } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const manage = can("member:manage");
  const members = useQuery({ queryKey: qk.members(orgId), queryFn: () => get<DataEnvelope<MemberDto[]>>(`/orgs/${orgId}/members`).then((r) => r.data) });
  const roles = useQuery({ queryKey: qk.roles(orgId), queryFn: () => get<DataEnvelope<RoleDto[]>>(`/orgs/${orgId}/roles`).then((r) => r.data) });
  const invitations = useQuery({
    queryKey: qk.invitations(orgId),
    queryFn: () => get<DataEnvelope<InvitationDto[]>>(`/orgs/${orgId}/invitations`).then((r) => r.data),
    enabled: manage,
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Roles the current user may assign: never OWNER (ownership is transferred), and only subsets of own permissions.
  const mine = new Set(org?.myRole.permissions ?? []);
  const assignable = (roles.data ?? []).filter((r) => r.key !== "OWNER" && r.permissions.every((p) => mine.has(p)));
  const isOwner = org?.myRole.key === "OWNER";

  const form = useZodForm(InviteInput);
  const invite = form.handleSubmit(async (v) => {
    setInviteError(null);
    try {
      await post(`/orgs/${orgId}/invitations`, v);
      form.reset({ email: "", roleId: v.roleId });
      toast.success(`Invitation sent to ${v.email}`);
      await qc.invalidateQueries({ queryKey: qk.invitations(orgId) });
    } catch (e) {
      if (!applyServerErrors(form, e)) setInviteError(errorMessage(e));
    }
  });

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: qk.members(orgId) }),
    qc.invalidateQueries({ queryKey: qk.org(orgId) }),
    qc.invalidateQueries({ queryKey: qk.invitations(orgId) }),
  ]);

  const changeRole = async (m: MemberDto, roleId: string) => {
    try {
      await patch(`/orgs/${orgId}/members/${m.id}`, { roleId });
      toast.success(`${m.name ?? m.email} is now ${roles.data?.find((r) => r.id === roleId)?.name}`);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      await refresh();
    }
  };

  const resend = async (inv: InvitationDto) => {
    try {
      await post(`/orgs/${orgId}/invitations/${inv.id}/resend`);
      toast.success("Invitation resent");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "remove") await del(`/orgs/${orgId}/members/${pending.member.id}`);
      if (pending.kind === "transfer") await post(`/orgs/${orgId}/transfer-ownership`, { memberId: pending.member.id });
      if (pending.kind === "revoke") await del(`/orgs/${orgId}/invitations/${pending.invitation.id}`);
      if (pending.kind === "leave") {
        await post(`/orgs/${orgId}/leave`);
        await qc.invalidateQueries({ queryKey: qk.me });
        router.push("/");
        return;
      }
      toast.success("Done");
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const dialog = pending && {
    remove: { title: `Remove ${"member" in pending ? pending.member.name ?? pending.member.email : ""}?`, description: "They lose access to this organization immediately.", label: "Remove", destructive: true },
    transfer: { title: `Transfer ownership to ${"member" in pending ? pending.member.name ?? pending.member.email : ""}?`, description: "They become an owner and your role changes to Admin.", label: "Transfer ownership", destructive: true },
    leave: { title: "Leave this organization?", description: "You'll lose access until someone invites you again.", label: "Leave", destructive: true },
    revoke: { title: "Revoke invitation?", description: "The invitation link will stop working.", label: "Revoke", destructive: true },
  }[pending.kind];

  return (
    <>
      <PageHeader title="Team" description="Members of this organization and their roles." actions={<Button variant="outline" size="sm" onClick={() => setPending({ kind: "leave" })}><LogOut />Leave organization</Button>} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {manage && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MailPlus className="h-4 w-4 text-primary" aria-hidden />Invite a teammate</CardTitle><CardDescription>They'll receive an email with a link to join.</CardDescription></CardHeader>
            <CardContent>
              <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end" noValidate>
                <FormField label="Email" htmlFor="invite-email" error={form.formState.errors.email?.message}>
                  <Input id="invite-email" type="email" placeholder="teammate@company.com" {...form.register("email")} />
                </FormField>
                <FormField label="Role" htmlFor="invite-role" error={form.formState.errors.roleId?.message}>
                  <Select id="invite-role" defaultValue="" {...form.register("roleId")}>
                    <option value="" disabled>Choose a role</option>
                    {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                </FormField>
                <Button type="submit" loading={form.formState.isSubmitting}><Mail /> Send invite</Button>
              </form>
              {inviteError && <Alert tone="danger" title={inviteError} className="mt-3" />}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between"><CardTitle>Members</CardTitle>{members.data && <span className="text-xs text-muted-foreground tabular-nums">{members.data.length} member{members.data.length === 1 ? "" : "s"}</span>}</CardHeader>
          <CardContent className="p-0">
            {members.isLoading ? <div className="p-5"><Skeleton className="h-32" /></div> : members.isError ? <div className="p-5"><ErrorState title="Couldn't load members" description={errorMessage(members.error)} onRetry={() => void members.refetch()} /></div> : (
              <Table>
                <THead><TR><TH>Member</TH><TH>Role</TH><TH className="hidden sm:table-cell">2FA</TH><TH className="hidden md:table-cell">Joined</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
                <TBody>
                  {members.data!.map((m) => {
                    const memberIsOwner = m.role.key === "OWNER";
                    const canEdit = manage && !m.isMe && (!memberIsOwner || isOwner);
                    return (
                      <TR key={m.id}>
                        <TD>
                          <div className="flex items-center gap-3">
                            <Avatar name={m.name ?? m.email} className="hidden sm:flex" />
                            <div className="min-w-0">
                              <div className="font-medium">{m.name ?? m.email}{m.isMe && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}</div>
                              <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                            </div>
                          </div>
                        </TD>
                        <TD>
                          {canEdit && !memberIsOwner ? (
                            <Select aria-label={`Role for ${m.email}`} value={m.role.id} onChange={(e) => changeRole(m, e.target.value)} className="w-32 sm:w-40">
                              {!assignable.some((r) => r.id === m.role.id) && <option value={m.role.id}>{m.role.name}</option>}
                              {assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </Select>
                          ) : <Badge tone={memberIsOwner ? "brand" : "neutral"}>{m.role.name}</Badge>}
                        </TD>
                        <TD className="hidden sm:table-cell">{m.twoFactorEnabled ? <Badge tone="success"><ShieldCheck className="h-3 w-3" /> On</Badge> : <Badge>Off</Badge>}</TD>
                        <TD className="hidden text-xs text-muted-foreground tabular-nums md:table-cell">{new Date(m.joinedAt).toLocaleDateString()}</TD>
                        <TD className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            {isOwner && !m.isMe && !memberIsOwner && can("org:transfer_ownership") && <Button size="sm" variant="ghost" onClick={() => setPending({ kind: "transfer", member: m })}>Make owner</Button>}
                            {canEdit && <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPending({ kind: "remove", member: m })}>Remove</Button>}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {manage && (
          <Card>
            <CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader>
            <CardContent className={invitations.data?.length ? "p-0" : undefined}>
              {invitations.isLoading ? <Skeleton className="h-16" /> : !invitations.data?.length ? <EmptyState icon={<Users />} title="No pending invitations" description="Invitations you send appear here until they are accepted or expire." className="py-8" /> : (
                <Table>
                  <THead><TR><TH>Email</TH><TH className="hidden sm:table-cell">Role</TH><TH className="hidden sm:table-cell">Expires</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
                  <TBody>
                    {invitations.data.map((inv) => (
                      <TR key={inv.id}>
                        <TD className="max-w-[14rem] truncate">{inv.email}<div className="text-xs text-muted-foreground sm:hidden">{inv.role.name} · expires {new Date(inv.expiresAt).toLocaleDateString()}</div></TD>
                        <TD className="hidden sm:table-cell"><Badge>{inv.role.name}</Badge></TD>
                        <TD className="hidden text-xs text-muted-foreground tabular-nums sm:table-cell">{new Date(inv.expiresAt).toLocaleDateString()}</TD>
                        <TD className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => resend(inv)}>Resend</Button>
                            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setPending({ kind: "revoke", invitation: inv })}>Revoke</Button>
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      {dialog && (
        <ConfirmDialog open onOpenChange={(o) => !o && setPending(null)} title={dialog.title} description={dialog.description} confirmLabel={dialog.label} destructive={dialog.destructive} loading={busy} onConfirm={run} />
      )}
    </>
  );
}
