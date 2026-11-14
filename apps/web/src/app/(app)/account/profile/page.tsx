"use client";
import { Alert, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, FormField, Input, PageHeader, Skeleton, toast } from "@wim/ui";
import { UpdateMeInput, type DataEnvelope, type MeDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorMessage, patch } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useMe } from "@/lib/hooks";

export default function ProfilePage() {
  const me = useMe();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useZodForm(UpdateMeInput);
  useEffect(() => {
    if (me.data) form.reset({ name: me.data.name ?? "", timezone: me.data.timezone, locale: me.data.locale });
  }, [me.data, form]);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await patch<DataEnvelope<MeDto>>("/me", v);
      qc.setQueryData(qk.me, r.data);
      toast.success("Profile saved");
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const { errors } = form.formState;
  return (
    <>
      <PageHeader title="Profile" description="Your personal details." />
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Personal information</CardTitle></CardHeader>
        {me.isLoading ? <CardContent><Skeleton className="h-32" /></CardContent> : (
          <form onSubmit={onSubmit} noValidate>
            <CardContent className="grid gap-4">
              {error && <Alert tone="danger" title={error} />}
              <FormField label="Email" htmlFor="email" hint={me.data?.emailVerified ? "Verified" : "Not verified yet"}>
                <Input id="email" value={me.data?.email ?? ""} readOnly disabled />
              </FormField>
              <FormField label="Name" htmlFor="name" error={errors.name?.message}>
                <Input id="name" autoComplete="name" {...form.register("name")} />
              </FormField>
              <FormField label="Timezone" htmlFor="timezone" error={errors.timezone?.message} hint="IANA name, e.g. Asia/Kolkata">
                <Input id="timezone" list="tz-list" {...form.register("timezone")} />
              </FormField>
              <datalist id="tz-list">
                {(Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone").map((tz) => <option key={tz} value={tz} />)}
              </datalist>
            </CardContent>
            <CardFooter><Button type="submit" loading={form.formState.isSubmitting}>Save</Button></CardFooter>
          </form>
        )}
      </Card>
    </>
  );
}
