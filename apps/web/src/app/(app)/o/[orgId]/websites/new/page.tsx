"use client";
import { Alert, Badge, Button, Card, CardContent, CardFooter, FormField, Input, PageHeader, Select, Textarea, toast } from "@wim/ui";
import { CreateWebsiteInput, type DataEnvelope, type WebsiteDetailDto, type WebsitePreviewDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, errorMessage, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { useOrg } from "@/lib/hooks";
import { CATEGORIES, wk } from "@/lib/websites";

const AVAILABILITY: Record<WebsitePreviewDto["availability"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  AVAILABLE: { label: "Available", tone: "success" },
  YOURS: { label: "Already in your organization", tone: "neutral" },
  CLAIMED_ELSEWHERE: { label: "Registered by another organization", tone: "danger" },
  PENDING_ELSEWHERE: { label: "Claimed by another organization (unverified)", tone: "warning" },
  BLOCKED: { label: "Blocked", tone: "danger" },
};

export default function NewWebsitePage() {
  const { orgId, data: org, can } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const form = useZodForm(CreateWebsiteInput, { category: "OTHER" });
  const url = form.watch("url");
  const [preview, setPreview] = useState<WebsitePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string; websiteId?: string } | null>(null);

  useEffect(() => {
    if (org && !form.getValues("monitoringTimezone")) form.setValue("monitoringTimezone", org.timezone);
  }, [org, form]);

  // Debounced normalization preview (no claim is created).
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!url || url.trim().length < 4 || !orgId) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await post<DataEnvelope<WebsitePreviewDto>>(`/orgs/${orgId}/websites/preview`, { url }, { signal: ctl.signal });
        setPreview(r.data);
      } catch (e) {
        if (!ctl.signal.aborted) setPreviewError(errorMessage(e));
      }
    }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [url, orgId]);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await post<DataEnvelope<WebsiteDetailDto>>(`/orgs/${orgId}/websites`, v);
      await qc.invalidateQueries({ queryKey: wk.list(orgId) });
      toast.success(`${r.data.displayHost} added`);
      router.push(`/o/${orgId}/websites/${r.data.id}?tab=${r.data.verification === "VERIFIED" ? "installation" : "verification"}`);
    } catch (e) {
      if (applyServerErrors(form, e)) return;
      const websiteId = e instanceof ApiError ? (e.details?.websiteId as string | undefined) : undefined;
      setError({ message: errorMessage(e), code: e instanceof ApiError ? e.code : undefined, websiteId });
    }
  });

  if (org && !can("website:write")) return <Alert tone="warning" title="Your role can't add websites." />;
  const errs = form.formState.errors;

  return (
    <>
      <PageHeader title="Add website" description="We'll normalize the address and reserve it for your organization while you verify ownership (72 hours)." />
      <Card className="max-w-2xl">
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="grid gap-4">
            {error && (
              <Alert tone="danger" title={error.message}>
                {error.code === "DOMAIN_ALREADY_REGISTERED" && (
                  <p className="mt-1">If you own this domain, you can <Link className="underline" href={`/o/${orgId}/websites/transfers?url=${encodeURIComponent(url ?? "")}`}>request an ownership transfer</Link>.</p>
                )}
                {error.websiteId && <p className="mt-1"><Link className="underline" href={`/o/${orgId}/websites/${error.websiteId}`}>Open the existing website</Link></p>}
              </Alert>
            )}
            <FormField label="Website name" htmlFor="name" error={errs.name?.message}>
              <Input id="name" placeholder="Main store" {...form.register("name")} />
            </FormField>
            <FormField label="Website URL" htmlFor="url" error={errs.url?.message ?? previewError ?? undefined} hint="For example https://www.example.co.in — paths and query strings are ignored.">
              <Input id="url" inputMode="url" autoComplete="url" placeholder="https://www.example.co.in" {...form.register("url")} />
            </FormField>
            {preview && (
              <div className="rounded-md border border-border bg-muted p-3 text-sm" data-testid="website-preview">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Registered as <strong>{preview.displayHost}</strong>{preview.displayHost !== preview.hostKey && <span className="text-muted-foreground"> ({preview.hostKey})</span>}</span>
                  <Badge tone={AVAILABILITY[preview.availability].tone}>{AVAILABILITY[preview.availability].label}</Badge>
                </div>
                {preview.notes.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              </div>
            )}
            <FormField label="Description (optional)" htmlFor="description" error={errs.description?.message}>
              <Textarea id="description" rows={2} {...form.register("description")} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Category" htmlFor="category" error={errs.category?.message}>
                <Select id="category" {...form.register("category")}>
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </FormField>
              <FormField label="Monitoring timezone" htmlFor="monitoringTimezone" error={errs.monitoringTimezone?.message} hint="IANA name, e.g. Asia/Kolkata">
                <Input id="monitoringTimezone" {...form.register("monitoringTimezone")} />
              </FormField>
            </div>
          </CardContent>
          <CardFooter className="gap-2">
            <Button type="submit" loading={form.formState.isSubmitting}>Add website</Button>
            <Link href={`/o/${orgId}/websites`} className="text-sm text-muted-foreground hover:underline">Cancel</Link>
          </CardFooter>
        </form>
      </Card>
    </>
  );
}
