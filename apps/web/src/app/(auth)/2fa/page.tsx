"use client";
import { Alert, Button, ConfirmDialog, FormField, Input, Spinner, Tabs } from "@wim/ui";
import type { DataEnvelope, LoginResultDto, MfaResetStatusDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/brand";
import { ApiError, errorMessage, get, post, safeNext } from "@/lib/api";
import { qk } from "@/lib/hooks";

function SecondFactor() {
  const router = useRouter();
  const qc = useQueryClient();
  const next = safeNext(useSearchParams().get("next"), "/");
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const reset = useQuery({
    queryKey: ["2fa-reset"],
    queryFn: () => get<DataEnvelope<MfaResetStatusDto | null>>("/auth/2fa/reset", { noAuthRedirect: true }).then((r) => r.data),
    retry: false,
  });
  const expired = reset.error instanceof ApiError && reset.error.code === "UNAUTHENTICATED";

  const finish = (r: DataEnvelope<LoginResultDto>) => {
    qc.setQueryData(qk.me, r.data.me);
    router.push(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = mode === "code" ? { code: value.trim() } : { recoveryCode: value.trim() };
      finish(await post<DataEnvelope<LoginResultDto>>("/auth/2fa/verify", body, { noAuthRedirect: true }));
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") return router.push(next);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    setBusy(true);
    try {
      await post("/auth/2fa/reset/request", {}, { noAuthRedirect: true });
      await reset.refetch();
      setConfirmReset(false);
    } catch (err) {
      setError(errorMessage(err));
      setConfirmReset(false);
    } finally {
      setBusy(false);
    }
  };

  const completeReset = async () => {
    setBusy(true);
    try {
      finish(await post<DataEnvelope<LoginResultDto>>("/auth/2fa/reset/complete", {}, { noAuthRedirect: true }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <AuthCard title="Two-factor authentication">
        <div className="grid gap-4">
          <Alert tone="warning" title="Your sign-in timed out">Sign in again with your email and password.</Alert>
          <Link href={`/login?next=${encodeURIComponent(next)}`}><Button className="w-full">Sign in</Button></Link>
        </div>
      </AuthCard>
    );
  }

  const r = reset.data;
  return (
    <AuthCard title="Two-factor authentication" description="Enter the code from your authenticator app, or one of your recovery codes.">
      <div className="grid gap-4">
        {r?.status === "READY" && (
          <Alert tone="warning" title="Your two-factor reset is ready">
            <p className="mb-2">The waiting period has passed. Completing the reset removes two-factor authentication and signs out your other sessions.</p>
            <Button size="sm" loading={busy} onClick={completeReset}>Remove two-factor and continue</Button>
          </Alert>
        )}
        {r?.status === "PENDING_EMAIL" && <Alert title="Check your email">We sent a link to confirm the two-factor reset. It expires in 1 hour.</Alert>}
        {r?.status === "WAITING" && r.eligibleAt && (
          <Alert title="Reset scheduled">You can remove two-factor authentication after {new Date(r.eligibleAt).toLocaleString()}. Sign in again then.</Alert>
        )}
        <Tabs label="Verification method" value={mode} onChange={(m) => { setMode(m); setValue(""); setError(null); }} items={[{ value: "code", label: "Authenticator code" }, { value: "recovery", label: "Recovery code" }]} />
        <form onSubmit={submit} className="grid gap-4" noValidate>
          {error && <Alert tone="danger" title={error} />}
          {mode === "code" ? (
            <FormField label="6-digit code" htmlFor="code">
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} className="font-mono tracking-widest" />
            </FormField>
          ) : (
            <FormField label="Recovery code" htmlFor="recovery" hint="Format XXXX-XXXX-XXXX. Each code works once.">
              <Input id="recovery" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="font-mono uppercase" />
            </FormField>
          )}
          <Button type="submit" loading={busy} disabled={mode === "code" ? value.length !== 6 : value.length < 12} className="w-full">Verify</Button>
        </form>
        {reset.isLoading ? <Spinner /> : !r && (
          <Button variant="link" className="justify-self-center text-sm" onClick={() => setConfirmReset(true)}>Lost access to your authenticator and recovery codes?</Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset two-factor authentication?"
        description="We'll email you a confirmation link. After you confirm, there is a security waiting period (72 hours by default) before two-factor authentication can be removed. You'll be notified and can cancel at any time."
        confirmLabel="Send confirmation email"
        loading={busy}
        onConfirm={requestReset}
      />
    </AuthCard>
  );
}

export default function TwoFactorPage() {
  return <Suspense><SecondFactor /></Suspense>;
}
