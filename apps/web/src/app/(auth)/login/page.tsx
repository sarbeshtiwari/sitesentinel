"use client";
import { Alert, Button, FormField, Input } from "@wim/ui";
import { LoginInput, type DataEnvelope, type LoginResultDto } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post, safeNext } from "@/lib/api";
import { useZodForm } from "@/lib/form";
import { qk, useConfig } from "@/lib/hooks";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { config } = useConfig();
  const next = safeNext(params.get("next"), "/");
  const [error, setError] = useState<string | null>(null);
  const form = useZodForm(LoginInput);
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const r = await post<DataEnvelope<LoginResultDto>>("/auth/login", values, { noAuthRedirect: true });
      if (r.data.status === "SECOND_FACTOR_REQUIRED") {
        router.push(`/2fa?next=${encodeURIComponent(next)}`);
        return;
      }
      qc.setQueryData(qk.me, r.data.me);
      router.push(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <AuthCard
      title="Sign in"
      description={`Welcome back to ${config.productName}.`}
      footer={config.registration !== "CLOSED" && <>New here? <Link className="text-primary hover:underline" href={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></>}
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        {error && <Alert tone="danger" title={error} />}
        <FormField label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus aria-invalid={!!errors.email} {...form.register("email")} />
        </FormField>
        <FormField label={<span className="flex w-full justify-between">Password <Link href="/forgot-password" className="text-xs font-normal text-primary hover:underline">Forgot password?</Link></span>} htmlFor="password" error={errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...form.register("password")} />
        </FormField>
        <Button type="submit" loading={isSubmitting} className="w-full">Sign in</Button>
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
