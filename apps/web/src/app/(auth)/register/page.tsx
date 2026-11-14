"use client";
import { Alert, Button, Checkbox, FormField, Input } from "@wim/ui";
import { RegisterInput } from "@wim/contracts";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { useConfig } from "@/lib/hooks";

function RegisterForm() {
  const { config, isLoading } = useConfig();
  const params = useSearchParams();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useZodForm(RegisterInput);
  useEffect(() => { form.setValue("termsVersion", config.termsVersion); }, [form, config.termsVersion]);
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    if (values.password.length < config.passwordMinLength) {
      form.setError("password", { message: `Use at least ${config.passwordMinLength} characters` });
      return;
    }
    try {
      await post("/auth/register", {
        ...values,
        termsVersion: config.termsVersion,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, { noAuthRedirect: true });
      setSentTo(values.email);
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const { errors, isSubmitting } = form.formState;
  const loginHref = `/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`;

  if (sentTo) {
    return (
      <AuthCard title="Check your email" footer={<Link className="text-primary hover:underline" href={loginHref}>Back to sign in</Link>}>
        <div className="grid gap-3 text-sm">
          <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary"><MailCheck className="h-5 w-5" /></span>
          <p>If <strong>{sentTo}</strong> can be used for a new account, we've sent a verification link to it. The link expires in 24 hours.</p>
          <p className="text-muted-foreground">Already have an account with this address? We've emailed you instead.</p>
        </div>
      </AuthCard>
    );
  }
  if (!isLoading && config.registration === "CLOSED") {
    return <AuthCard title="Registration is closed"><p className="text-sm text-muted-foreground">New accounts can't be created right now.</p></AuthCard>;
  }
  return (
    <AuthCard
      title="Create your account"
      description={config.registration === "INVITE_ONLY" ? "Registration is by invitation only. Use the email address you were invited with." : `Start monitoring with ${config.productName}.`}
      footer={<>Already have an account? <Link className="text-primary hover:underline" href={loginHref}>Sign in</Link></>}
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error && <Alert tone="danger" title={error} />}
        <FormField label="Full name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" autoFocus aria-invalid={!!errors.name} {...form.register("name")} />
        </FormField>
        <FormField label="Work email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register("email")} />
        </FormField>
        <FormField label="Password" htmlFor="password" error={errors.password?.message} hint={`At least ${config.passwordMinLength} characters. A long passphrase works well.`}>
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby="password-hint" {...form.register("password")} />
        </FormField>
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <Checkbox className="mt-0.5" {...form.register("acceptTerms")} />
            <span>
              I agree to the {config.termsUrl ? <a href={config.termsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">terms of service</a> : "terms of service"}
              {config.privacyUrl && <> and <a href={config.privacyUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">privacy policy</a></>}.
            </span>
          </label>
          {errors.acceptTerms && <p role="alert" className="text-xs text-danger">Please accept the terms to continue</p>}
        </div>
        <Button type="submit" size="lg" loading={isSubmitting} disabled={isLoading} className="mt-1 w-full">Create account</Button>
      </form>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return <Suspense><RegisterForm /></Suspense>;
}
