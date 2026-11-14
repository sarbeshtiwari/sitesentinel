"use client";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, FormField, Input, Skeleton, toast } from "@wim/ui";
import { Building2, Check, Mail } from "lucide-react";
import { CreateOrgInput, type DataEnvelope, type OrgMembershipDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useMe } from "@/lib/hooks";

/** First-run steps, in the order the product actually walks through them. Status comes from the signed-in user. */
function Steps({ verified }: { verified: boolean }) {
  const steps = [
    { label: "Create account", state: "done" },
    { label: "Verify email", state: verified ? "done" : "current" },
    { label: "Create organization", state: verified ? "current" : "upcoming" },
    { label: "Add a website", state: "upcoming" },
  ] as const;
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Setup progress">
      {steps.map((s, i) => (
        <li key={s.label} className="grid gap-2" aria-current={s.state === "current" ? "step" : undefined}>
          <span className={cn("h-1 rounded-full", s.state === "done" ? "bg-primary" : s.state === "current" ? "bg-[color-mix(in_srgb,var(--primary)_45%,transparent)]" : "bg-muted")} />
          <span className={cn("flex items-center gap-1.5 text-xs", s.state === "upcoming" ? "text-subtle-foreground" : s.state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
            {s.state === "done" ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> : <span aria-hidden className="tabular-nums">{i + 1}.</span>}
            <span className="truncate">{s.label}</span>
            {s.state === "done" && <span className="sr-only">(done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

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
    <div className="mx-auto grid max-w-xl gap-6 py-2 sm:py-6">
      <div className="grid gap-5">
        {me.data && me.data.orgs.length === 0 && <Steps verified={!!verified} />}
        <div>
          {me.data && me.data.orgs.length === 0 && <p className="mb-1 text-sm font-medium text-primary">Welcome{me.data.name ? `, ${me.data.name.split(" ")[0]}` : ""}</p>}
          <h1 className="text-2xl font-semibold tracking-tight">Set up your organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">Organizations hold your websites, team and subscription.</p>
        </div>
      </div>
      {(invites.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="flex-row items-start gap-3"><span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"><Mail className="h-4 w-4" /></span><div className="grid gap-1"><CardTitle>Pending invitations</CardTitle><CardDescription>Join an existing organization.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-3">
            {invites.data!.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
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
        <CardHeader className="flex-row items-start gap-3">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"><Building2 className="h-4 w-4" /></span>
          <div className="grid gap-1"><CardTitle>Create an organization</CardTitle><CardDescription>Use your company or team name. You can change it later in settings.</CardDescription></div>
        </CardHeader>
        <CardContent className="py-5">
          {me.isLoading ? <Skeleton className="h-24" /> : (
            <form onSubmit={onSubmit} className="grid gap-4" noValidate>
              {!verified && <Alert tone="warning" title="Verify your email first">Use the link we emailed you, then refresh this page.</Alert>}
              {error && <Alert tone="danger" title={error} />}
              <FormField label="Organization name" htmlFor="name" error={form.formState.errors.name?.message}>
                <Input id="name" placeholder="Acme Inc." autoFocus disabled={!verified} {...form.register("name")} />
              </FormField>
              <Button type="submit" size="lg" className="mt-1 w-full" loading={form.formState.isSubmitting} disabled={!verified}>Create organization</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
