"use client";
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, ConfirmDialog, Dialog,
  ErrorState, FormField, Input, PageHeader, Skeleton, toast,
} from "@wim/ui";
import type { DataEnvelope, PermissionDto, RoleDto } from "@wim/contracts";
import { OWNER_ONLY, type Permission } from "@wim/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { qk, useOrg } from "@/lib/hooks";

interface Draft { id?: string; name: string; description: string; permissions: Set<Permission> }

export default function RolesPage() {
  const { orgId, can, data: org } = useOrg();
  const qc = useQueryClient();
  const manage = can("role:manage");
  const roles = useQuery({ queryKey: qk.roles(orgId), queryFn: () => get<DataEnvelope<RoleDto[]>>(`/orgs/${orgId}/roles`).then((r) => r.data) });
  const perms = useQuery({ queryKey: qk.permissions, queryFn: () => get<DataEnvelope<PermissionDto[]>>("/permissions").then((r) => r.data), staleTime: Infinity });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = new Set(org?.myRole.permissions ?? []);
  // Custom roles can only hold permissions you hold, and never owner-only ones.
  const grantable = (perms.data ?? []).filter((p) => !OWNER_ONLY.includes(p.key) && mine.has(p.key));
  const describe = new Map((perms.data ?? []).map((p) => [p.key, p.description]));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name.trim(), description: draft.description.trim() || undefined, permissions: [...draft.permissions] };
      if (draft.id) await patch(`/orgs/${orgId}/roles/${draft.id}`, body);
      else await post(`/orgs/${orgId}/roles`, body);
      toast.success(draft.id ? "Role updated" : "Role created");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: qk.roles(orgId) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/orgs/${orgId}/roles/${deleting.id}`);
      toast.success("Role deleted");
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: qk.roles(orgId) });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: Permission) => setDraft((d) => {
    if (!d) return d;
    const next = new Set(d.permissions);
    if (next.has(p)) next.delete(p); else next.add(p);
    return { ...d, permissions: next };
  });

  return (
    <>
      <PageHeader
        title="Roles"
        description="System roles are fixed. Custom roles let you grant a specific set of permissions."
        actions={manage && <Button onClick={() => { setError(null); setDraft({ name: "", description: "", permissions: new Set() }); }}><Plus /> New role</Button>}
      />
      {roles.isLoading ? <Skeleton className="h-48" /> : roles.isError ? <ErrorState title="Couldn't load roles" description={errorMessage(roles.error)} onRetry={() => void roles.refetch()} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {roles.data!.map((r) => (
            <Card key={r.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {r.name}
                    {r.isSystem ? <Badge><Lock className="h-3 w-3" /> System</Badge> : <Badge tone="brand">Custom</Badge>}
                  </CardTitle>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"><Users className="h-3.5 w-3.5" aria-hidden />{r.memberCount} member{r.memberCount === 1 ? "" : "s"}</span>
                </div>
                {r.description && <CardDescription>{r.description}</CardDescription>}
              </CardHeader>
              <CardContent className="flex-1">
                <p className="mb-2 text-xs text-muted-foreground">{r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"}</p>
                <ul className="flex flex-wrap gap-1.5" aria-label={`${r.name} permissions`}>
                  {r.permissions.map((p) => <li key={p}><Badge title={describe.get(p)} className="font-mono text-[11px]">{p}</Badge></li>)}
                </ul>
              </CardContent>
              {!r.isSystem && manage && (
                <CardFooter className="justify-start">
                  <Button size="sm" variant="outline" onClick={() => { setError(null); setDraft({ id: r.id, name: r.name, description: r.description ?? "", permissions: new Set(r.permissions) }); }}><Pencil />Edit</Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(r)}><Trash2 />Delete</Button>
                </CardFooter>
              )}
            </Card>
          ))}
        </div>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? "Edit role" : "New custom role"}
        description="You can only grant permissions that you hold. Billing, deletion, ownership transfer and full data export stay with owners."
        footer={<><Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button><Button loading={busy} disabled={!draft?.name.trim() || draft.permissions.size === 0} onClick={save}>Save role</Button></>}
      >
        {draft && (
          <div className="grid gap-4">
            {error && <Alert tone="danger" title={error} />}
            <FormField label="Name" htmlFor="role-name"><Input id="role-name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></FormField>
            <FormField label="Description" htmlFor="role-desc"><Input id="role-desc" value={draft.description} maxLength={200} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></FormField>
            <fieldset className="grid max-h-72 gap-2 overflow-y-auto rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">Permissions <span className="font-normal text-muted-foreground tabular-nums">({draft.permissions.size} selected)</span></legend>
              {grantable.map((p) => (
                <label key={p.key} className="flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-sunken">
                  <Checkbox className="mt-0.5" checked={draft.permissions.has(p.key)} onChange={() => toggle(p.key)} />
                  <span><span className="font-mono text-xs">{p.key}</span><span className="block text-xs text-muted-foreground">{p.description}</span></span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name}?`} description="Roles that are assigned to members or pending invitations can't be deleted." destructive confirmLabel="Delete role" loading={busy} onConfirm={remove} />
    </>
  );
}
