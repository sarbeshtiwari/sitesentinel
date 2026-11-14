"use client";
import { Alert, Button, buttonVariants, FormField, Input } from "@wim/ui";
import { Password } from "@wim/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { z } from "zod";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";

const Schema = z.object({ password: Password, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

function Reset() {
  const token = useSearchParams().get("token") ?? "";
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useZodForm(Schema);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await post("/auth/password/reset", { token, password: v.password }, { noAuthRedirect: true });
      setDone(true);
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const { errors } = form.formState;
  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <div className="grid gap-4">
          <Alert tone="success" title="Password updated">You've been signed out of all sessions. Sign in with your new password.</Alert>
          <Link href="/login" className={buttonVariants({ size: "lg", className: "w-full" })}>Sign in</Link>
        </div>
      ) : !token ? (
        <div className="grid gap-4"><Alert tone="danger" title="This link is missing its token." /><Link href="/forgot-password" className="text-sm text-primary hover:underline">Request a new link</Link></div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {error && <Alert tone="danger" title={error}><Link href="/forgot-password" className="text-primary hover:underline">Request a new link</Link></Alert>}
          <FormField label="New password" htmlFor="password" error={errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" autoFocus {...form.register("password")} />
          </FormField>
          <FormField label="Confirm password" htmlFor="confirm" error={errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
          </FormField>
          <Button type="submit" size="lg" loading={form.formState.isSubmitting} className="mt-1 w-full">Update password</Button>
        </form>
      )}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><Reset /></Suspense>;
}
