"use client";
import { Alert, Button, FormField, Input } from "@wim/ui";
import { ForgotPasswordInput } from "@wim/contracts";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";
import { useZodForm } from "@/lib/form";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useZodForm(ForgotPasswordInput);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await post("/auth/password/forgot", v, { noAuthRedirect: true });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  return (
    <AuthCard title="Reset your password" description="We'll email you a link to choose a new password." footer={<Link className="text-primary hover:underline" href="/login">Back to sign in</Link>}>
      {sent ? (
        <Alert tone="success" title="Check your email">If an account exists for that address, a reset link is on its way. It expires in 30 minutes.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          {error && <Alert tone="danger" title={error} />}
          <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" autoFocus {...form.register("email")} />
          </FormField>
          <Button type="submit" loading={form.formState.isSubmitting} className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}
