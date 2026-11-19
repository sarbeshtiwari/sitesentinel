"use client";
import { Alert, Button, Card, ConfirmDialog, FormField, Input, Select, Textarea, toast } from "@wim/ui";
import { UpdateWebsiteInput, type WebsiteDetailDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Settings2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Section } from "@/components/monitoring";
import { useEffect, useState } from "react";
import { errorMessage, patch, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { mk } from "@/lib/monitoring";
import { CATEGORIES, wk } from "@/lib/websites";

/** Name, description, category and monitoring time zone. */
export function WebsiteDetailsForm({ w, orgId }: { w: WebsiteDetailDto; orgId: string }) {
  const qc = useQueryClient();
  const form = useZodForm(UpdateWebsiteInput);
  const [error, setError] = useState<string | null>(null);
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
  const errs = form.formState.errors;
  return (
    <Section title="Website details" icon={<Settings2 />} description="The domain itself can't be changed; add a new website for a different domain." flush>
      <form onSubmit={onSubmit} noValidate>
        <div className="grid gap-4 px-4 py-5 sm:px-5">
          {error && <Alert tone="danger" title={error} />}
          <FormField label="Website name" htmlFor="ws-name" error={errs.name?.message}><Input id="ws-name" {...form.register("name")} /></FormField>
          <FormField label="Description" htmlFor="ws-desc" error={errs.description?.message}><Textarea id="ws-desc" rows={2} {...form.register("description")} /></FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Category" htmlFor="ws-cat" error={errs.category?.message}>
              <Select id="ws-cat" {...form.register("category")}>{CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
            </FormField>
            <FormField label="Monitoring timezone" htmlFor="ws-tz" error={errs.monitoringTimezone?.message}><Input id="ws-tz" {...form.register("monitoringTimezone")} /></FormField>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-sunken/50 px-4 py-3 sm:px-5"><Button type="submit" loading={form.formState.isSubmitting}>Save changes</Button></div>
      </form>
    </Section>
  );
}

/** Pause / resume monitoring (existing endpoint) and delete the website (typed confirmation). */
export function DangerZone({ w, orgId, canWrite, canDelete }: { w: WebsiteDetailDto; orgId: string; canWrite: boolean; canDelete: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<null | "delete" | "pause">(null);
  const paused = w.status === "PAUSED";
  const canPause = w.status === "ACTIVE" || paused;

  const setPaused = async (p: boolean) => {
    setBusy("pause");
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/monitoring/pause`, { paused: p });
      await Promise.all([qc.invalidateQueries({ queryKey: wk.detail(orgId, w.id) }), qc.invalidateQueries({ queryKey: wk.list(orgId) }), qc.invalidateQueries({ queryKey: mk.all(orgId) })]);
      toast.success(p ? "Monitoring paused" : "Monitoring resumed");
      setConfirmPause(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("delete");
    try {
      await post(`/orgs/${orgId}/websites/${w.id}/delete`, { confirmHost: typed.trim() });
      await qc.invalidateQueries({ queryKey: wk.list(orgId) });
      toast.success(`${w.displayHost} deleted`);
      router.push(`/o/${orgId}/websites`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card className="divide-y divide-[color-mix(in_srgb,var(--danger)_18%,var(--border))] overflow-hidden border-[color-mix(in_srgb,var(--danger)_30%,transparent)]">
        <h2 className="sr-only">Danger zone</h2>
        {canWrite && (
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{paused ? "Resume monitoring" : "Pause monitoring"}</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {paused ? "Monitoring is paused. Resume to start the scheduled checks again." : canPause ? "Stops all checks for this website and cancels pending ones. History is kept. Resume any time." : "Only active, verified websites can be paused."}
              </p>
            </div>
            <Button variant="secondary" className="shrink-0" disabled={!canPause} loading={busy === "pause" && paused} onClick={() => (paused ? void setPaused(false) : setConfirmPause(true))}>
              {paused ? <><Play /> Resume</> : <><Pause /> Pause</>}
            </Button>
          </div>
        )}
        {canDelete && (
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Delete website</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">Removes the website from your organization, revokes its site key and releases the domain so it can be registered again. Registration history is kept; a domain that already received a free trial never receives another.</p>
            </div>
            <Button variant="danger" className="shrink-0" onClick={() => { setTyped(""); setConfirmDelete(true); }}><Trash2 /> Delete website</Button>
          </div>
        )}
      </Card>
      <ConfirmDialog open={confirmPause} onOpenChange={setConfirmPause} title={`Pause monitoring of ${w.displayHost}?`}
        description="All checks stop and pending ones are cancelled. History is kept, and you can resume any time." confirmLabel="Pause monitoring"
        loading={busy === "pause"} onConfirm={() => void setPaused(true)} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${w.displayHost}?`}
        description="This can't be undone."
        destructive
        confirmLabel="Delete website"
        confirmDisabled={typed.trim().toLowerCase() !== w.hostKey && typed.trim() !== w.displayHost}
        loading={busy === "delete"}
        onConfirm={remove}
      >
        <FormField label={`Type ${w.displayHost} to confirm`} htmlFor="confirm-host">
          <Input id="confirm-host" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </FormField>
      </ConfirmDialog>
    </>
  );
}
