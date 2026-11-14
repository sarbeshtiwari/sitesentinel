"use client";
import { Alert, Button, Spinner } from "@wim/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";

function Cancel() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const run = async () => {
    setState("working");
    try {
      await post("/auth/2fa/reset/cancel", { token }, { noAuthRedirect: true });
      setState("ok");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    }
  };
  return (
    <AuthCard title="Cancel two-factor reset">
      {state === "idle" && (
        <div className="grid gap-4 text-sm">
          <p>Cancelling keeps two-factor authentication on for your account.</p>
          <Button variant="danger" onClick={run} disabled={!token}>Cancel the reset</Button>
        </div>
      )}
      {state === "working" && <Spinner />}
      {state === "ok" && <Alert tone="success" title="Reset cancelled">Two-factor authentication stays on. If you didn't start this request, change your password.</Alert>}
      {state === "error" && <Alert tone="danger" title="We couldn't cancel with this link">{error}</Alert>}
      <p className="mt-4 text-center text-sm"><Link className="text-primary hover:underline" href="/login">Back to sign in</Link></p>
    </AuthCard>
  );
}

export default function CancelResetPage() {
  return <Suspense><Cancel /></Suspense>;
}
