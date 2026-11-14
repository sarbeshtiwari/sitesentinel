"use client";
import { Alert, Button, Spinner } from "@wim/ui";
import type { DataEnvelope } from "@wim/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";

function Confirm() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [eligibleAt, setEligibleAt] = useState("");
  const [error, setError] = useState("");
  const run = async () => {
    setState("working");
    try {
      const r = await post<DataEnvelope<{ eligibleAt: string }>>("/auth/2fa/reset/confirm", { token }, { noAuthRedirect: true });
      setEligibleAt(r.data.eligibleAt);
      setState("ok");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    }
  };
  return (
    <AuthCard title="Confirm two-factor reset">
      {state === "idle" && (
        <div className="grid gap-4 text-sm">
          <p>Confirming starts a security waiting period. After it ends you can sign in with your password only and set up two-factor authentication again.</p>
          <p className="text-muted-foreground">If you didn't request this, don't confirm. Change your password instead.</p>
          <Button onClick={run} disabled={!token}>Confirm reset request</Button>
        </div>
      )}
      {state === "working" && <Spinner />}
      {state === "ok" && <Alert tone="success" title="Reset scheduled">Two-factor authentication can be removed after {new Date(eligibleAt).toLocaleString()}. Sign in then to complete it. We emailed you a link to cancel.</Alert>}
      {state === "error" && <Alert tone="danger" title="We couldn't confirm this request">{error}</Alert>}
      <p className="mt-4 text-center text-sm"><Link className="text-primary hover:underline" href="/login">Back to sign in</Link></p>
    </AuthCard>
  );
}

export default function ConfirmResetPage() {
  return <Suspense><Confirm /></Suspense>;
}
