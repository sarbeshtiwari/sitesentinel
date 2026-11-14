"use client";
import { Alert, Badge, Button, buttonVariants, Card, CardContent, CardFooter, FormField, Input, PageHeader, Select, Textarea, toast } from "@wim/ui";
import { CreateWebsiteInput, type DataEnvelope, type WebsiteDetailDto, type WebsitePreviewDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronLeft, Code2, Globe, ShieldCheck, type LucideIcon } from "lucide-react";
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

// Summarises the flow this page starts (claim → verification → installation → monitoring); no data involved.
const NEXT: Array<[LucideIcon, string, string]> = [
  [Globe, "Reserve the address", "The normalized host is reserved for your organization for 72 hours."],
  [ShieldCheck, "Verify ownership", "Publish a DNS TXT record, a verification file or a meta tag, then run the check."],
  [Code2, "Install the monitoring script", "Add the snippet to your pages; heartbeats confirm the installation."],
  [Activity, "Monitoring starts", "HTTP availability checks begin once the website is verified."],
];

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
      <div className="mb-3"><Link href={`/o/${orgId}/websites`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden /> Websites</Link></div>
      <PageHeader title="Add website" description="We'll normalize the address and reserve it for your organization while you verify ownership (72 hours)." />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
      <Card className="overflow-hidden">
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="grid gap-4 py-5">
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
              <div className="rounded-lg border border-border bg-sunken p-3.5 text-sm" data-testid="website-preview">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2"><Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 break-all">Registered as <strong>{preview.displayHost}</strong>{preview.displayHost !== preview.hostKey && <span className="text-muted-foreground"> ({preview.hostKey})</span>}</span></span>
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
          <CardFooter>
            <Link href={`/o/${orgId}/websites`} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
            <Button type="submit" loading={form.formState.isSubmitting}>Add website</Button>
          </CardFooter>
        </form>
      </Card>
      <Card className="px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight">What happens next</h2>
        <ol className="mt-3 grid gap-3.5 text-sm">
          {NEXT.map(([Icon, title, text], n) => (
            <li key={title} className="flex gap-3">
              <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"><Icon className="h-4 w-4" /></span>
              <span className="min-w-0"><span className="font-medium"><span className="sr-only">Step {n + 1}: </span>{title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{text}</span></span>
            </li>
          ))}
        </ol>
      </Card>
      </div>
    </>
  );
}
