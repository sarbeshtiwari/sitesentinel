"use client";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Skeleton, toast } from "@wim/ui";
import { CreateOrgInput, type DataEnvelope, type OrgMembershipDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useMe } from "@/lib/hooks";

interface MyInvitation { id: string; orgId: string; orgName: string; roleName: string; expiresAt: string }

export default function OnboardingPage() {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const invites = useQuery({
    queryKey: qk.myInvitations,
    queryFn: () => get<DataEnvelope<MyInvitation[]>>("/me/invitations").then((r) => r.data),
  });
  const form = useZodForm(CreateOrgInput);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await post<DataEnvelope<OrgMembershipDto>>("/orgs", { ...v, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await qc.invalidateQueries({ queryKey: qk.me });
      router.push(`/o/${r.data.id}/overview`);
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const respond = async (inv: MyInvitation, accept: boolean) => {
    setBusyId(inv.id);
    try {
      if (accept) {
        const r = await post<DataEnvelope<OrgMembershipDto>>("/invitations/accept", { invitationId: inv.id });
        await qc.invalidateQueries({ queryKey: qk.me });
        router.push(`/o/${r.data.id}/overview`);
      } else {
        await post("/invitations/decline", { invitationId: inv.id });
        toast.success(`Declined invitation to ${inv.orgName}`);
        await invites.refetch();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  const verified = me.data?.emailVerified;
  return (
    <div className="mx-auto grid max-w-xl gap-6">
      <div>
        <h1 className="text-xl font-semibold">Set up your organization</h1>
        <p className="text-sm text-muted-foreground">Organizations hold your websites, team and subscription.</p>
      </div>
      {(invites.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Pending invitations</CardTitle><CardDescription>Join an existing organization.</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {invites.data!.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div>
                  <p className="font-medium">{inv.orgName}</p>
                  <p className="text-xs text-muted-foreground">as {inv.roleName} · expires {new Date(inv.expiresAt).toLocaleDateString()}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" loading={busyId === inv.id} onClick={() => respond(inv, true)}>Accept</Button>
                  <Button size="sm" variant="outline" disabled={busyId === inv.id} onClick={() => respond(inv, false)}>Decline</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Create an organization</CardTitle></CardHeader>
        <CardContent>
          {me.isLoading ? <Skeleton className="h-24" /> : (
            <form onSubmit={onSubmit} className="grid gap-4" noValidate>
              {!verified && <Alert tone="warning" title="Verify your email first">Use the link we emailed you, then refresh this page.</Alert>}
              {error && <Alert tone="danger" title={error} />}
              <FormField label="Organization name" htmlFor="name" error={form.formState.errors.name?.message}>
                <Input id="name" placeholder="Acme Inc." autoFocus disabled={!verified} {...form.register("name")} />
              </FormField>
              <Button type="submit" loading={form.formState.isSubmitting} disabled={!verified}>Create organization</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
