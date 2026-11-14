"use client";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ConfirmDialog, FormField, Input, PageHeader, toast } from "@wim/ui";
import { Building2, Trash2 } from "lucide-react";
import { UpdateOrgInput, type DataEnvelope, type OrgDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { del, errorMessage, patch, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useOrg } from "@/lib/hooks";

export default function GeneralSettingsPage() {
  const { data: org, orgId, can } = useOrg();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useZodForm(UpdateOrgInput);
  useEffect(() => { if (org) form.reset({ name: org.name, timezone: org.timezone }); }, [org, form]);
  if (!org) return null;
  const editable = can("org:update");
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await patch<DataEnvelope<OrgDto>>(`/orgs/${orgId}`, v);
      qc.setQueryData(qk.org(orgId), r.data);
      await qc.invalidateQueries({ queryKey: qk.me });
      toast.success("Organization updated");
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const deletion = async () => {
    setBusy(true);
    try {
      if (confirm === "delete") {
        const r = await post<DataEnvelope<{ scheduledFor: string }>>(`/orgs/${orgId}/deletion`);
        toast.success(`Deletion scheduled for ${new Date(r.data.scheduledFor).toLocaleDateString()}`);
      } else {
        await del(`/orgs/${orgId}/deletion`);
        toast.success("Deletion cancelled");
      }
      await qc.invalidateQueries({ queryKey: qk.org(orgId) });
      setConfirm(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = org.status === "PENDING_DELETION";
  return (
    <>
      <PageHeader title="General" description="Organization name and preferences." />
      <div className="grid max-w-2xl gap-5">
        <Card>
          <CardHeader className="flex-row items-start gap-3">
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"><Building2 className="h-4 w-4" /></span>
            <div className="grid gap-1"><CardTitle>Organization</CardTitle><CardDescription>How your organization appears to members and in notifications.</CardDescription></div>
          </CardHeader>
          <form onSubmit={onSubmit} noValidate>
            <CardContent className="grid gap-4">
              {!editable && <Alert title="Read-only">Your role can't change organization settings.</Alert>}
              {error && <Alert tone="danger" title={error} />}
              <FormField label="Name" htmlFor="name" error={form.formState.errors.name?.message}>
                <Input id="name" disabled={!editable} {...form.register("name")} />
              </FormField>
              <FormField label="Timezone" htmlFor="timezone" error={form.formState.errors.timezone?.message} hint="Used for reports and schedules (IANA name).">
                <Input id="timezone" disabled={!editable} {...form.register("timezone")} />
              </FormField>
              <p className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground"><Badge>{org.currency}</Badge>Currency: {org.currency} · Created {new Date(org.createdAt).toLocaleDateString()}</p>
            </CardContent>
            {editable && <CardFooter><Button type="submit" loading={form.formState.isSubmitting}>Save changes</Button></CardFooter>}
          </form>
        </Card>
        {can("org:delete") && (
          <Card className="border-[color-mix(in_srgb,var(--danger)_40%,transparent)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-danger"><Trash2 className="h-4 w-4" aria-hidden />Delete organization</CardTitle>
              <CardDescription>Deletion happens after a 14-day grace period, during which it can be cancelled. Minimal domain registration history is retained to prevent trial abuse, as described in the privacy policy.</CardDescription>
            </CardHeader>
            <CardContent>
              {pending ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Alert tone="warning" title="Deletion is scheduled" className="flex-1" />
                  <Button variant="outline" onClick={() => setConfirm("cancel")}>Cancel deletion</Button>
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirm("delete")}>Delete organization</Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "delete" ? `Delete ${org.name}?` : "Cancel deletion?"}
        description={confirm === "delete" ? "The organization and its data will be permanently deleted after 14 days." : "The organization will stay active."}
        destructive={confirm === "delete"}
        confirmLabel={confirm === "delete" ? "Schedule deletion" : "Keep organization"}
        loading={busy}
        onConfirm={deletion}
      />
    </>
  );
}
