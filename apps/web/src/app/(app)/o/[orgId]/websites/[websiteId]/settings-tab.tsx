"use client";
import { Alert, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ConfirmDialog, FormField, Input, Select, Textarea, toast } from "@wim/ui";
import { UpdateWebsiteInput, type WebsiteDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { errorMessage, patch, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { CATEGORIES, wk } from "@/lib/websites";

export function SettingsTab({ w, orgId, canWrite, canDelete }: { w: WebsiteDetailDto; orgId: string; canWrite: boolean; canDelete: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const form = useZodForm(UpdateWebsiteInput);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    form.reset({ name: w.name, description: w.description ?? "", category: w.category, monitoringTimezone: w.monitoringTimezone });
  }, [w, form]);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await patch(`/orgs/${orgId}/websites/${w.id}`, { ...v, description: v.description ? v.description : null });
      await Promise.all([qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) }), qc.invalidateQueries({ queryKey: wk.list(orgId) })]);
      toast.success("Website updated");
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });

  const remove = async () => {
    setBusy(true);
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/delete`, { confirmHost: typed.trim() });
      await qc.invalidateQueries({ queryKey: wk.list(orgId) });
      toast.success(`${w.displayHost} deleted`);
      router.push(`/o/${orgId}/websites`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const errs = form.formState.errors;
  return (
    <div className="grid max-w-2xl gap-6">
      {canWrite && (
        <Card>
          <CardHeader><CardTitle>Website details</CardTitle><CardDescription>The domain itself can't be changed; add a new website for a different domain.</CardDescription></CardHeader>
          <form onSubmit={onSubmit} noValidate>
            <CardContent className="grid gap-4">
              {error && <Alert tone="danger" title={error} />}
              <FormField label="Website name" htmlFor="ws-name" error={errs.name?.message}><Input id="ws-name" {...form.register("name")} /></FormField>
              <FormField label="Description" htmlFor="ws-desc" error={errs.description?.message}><Textarea id="ws-desc" rows={2} {...form.register("description")} /></FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Category" htmlFor="ws-cat" error={errs.category?.message}>
                  <Select id="ws-cat" {...form.register("category")}>{CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
                </FormField>
                <FormField label="Monitoring timezone" htmlFor="ws-tz" error={errs.monitoringTimezone?.message}><Input id="ws-tz" {...form.register("monitoringTimezone")} /></FormField>
              </div>
            </CardContent>
            <CardFooter><Button type="submit" loading={form.formState.isSubmitting}>Save changes</Button></CardFooter>
          </form>
        </Card>
      )}
      {canDelete && (
        <Card className="border-[color-mix(in_srgb,var(--danger)_40%,transparent)]">
          <CardHeader>
            <CardTitle>Delete website</CardTitle>
            <CardDescription>Removes the website from your organization, revokes its site key and releases the domain so it can be registered again. Registration history is kept; a domain that already received a free trial never receives another.</CardDescription>
          </CardHeader>
          <CardContent><Button variant="danger" onClick={() => { setTyped(""); setConfirmDelete(true); }}>Delete website</Button></CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${w.displayHost}?`}
        description="This can't be undone."
        destructive
        confirmLabel="Delete website"
        confirmDisabled={typed.trim().toLowerCase() !== w.hostKey && typed.trim() !== w.displayHost}
        loading={busy}
        onConfirm={remove}
      >
        <FormField label={`Type ${w.displayHost} to confirm`} htmlFor="confirm-host">
          <Input id="confirm-host" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}
