"use client";
import { Alert, buttonVariants, Spinner } from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, post } from "@/lib/api";
import { qk } from "@/lib/hooks";

function Verify() {
  const token = useSearchParams().get("token");
  const qc = useQueryClient();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [error, setError] = useState("");
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) { setState("error"); setError("This link is missing its token."); return; }
    post("/auth/verify-email", { token }, { noAuthRedirect: true })
      .then(() => { setState("ok"); void qc.invalidateQueries({ queryKey: qk.me }); })
      .catch((e) => { setState("error"); setError(errorMessage(e)); });
  }, [token, qc]);
  return (
    <AuthCard title="Email verification">
      {state === "working" && <Spinner label="Verifying your email…" />}
      {state === "ok" && (
        <div className="grid gap-4">
          <Alert tone="success" title="Your email address is verified." />
          <Link href="/" className={buttonVariants({ size: "lg", className: "w-full" })}>Continue</Link>
        </div>
      )}
      {state === "error" && (
        <div className="grid gap-4">
          <Alert tone="danger" title="We couldn't verify your email">{error} Sign in to request a new link.</Alert>
          <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}>Sign in</Link>
        </div>
      )}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return <Suspense><Verify /></Suspense>;
}
