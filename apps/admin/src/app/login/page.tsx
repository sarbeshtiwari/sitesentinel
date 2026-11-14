"use client";
import { Alert, AuthLayout, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from "@wim/ui";
import type { AdminMeDto, DataEnvelope } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { errorMessage, post, safeNext } from "@/lib/api";
import { qk } from "@/lib/hooks";

function Login() {
  const router = useRouter();
  const qc = useQueryClient();
  const next = safeNext(useSearchParams().get("next"), "/overview");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<DataEnvelope<AdminMeDto>>("/auth/login", { email, password, code }, { noAuthRedirect: true });
      qc.setQueryData(qk.me, r.data);
      router.push(next);
    } catch (err) {
      setError(errorMessage(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout brand={<><ShieldAlert className="h-5 w-5 text-primary" aria-hidden /> Admin console</>} footer="Restricted to authorized platform administrators. All activity is audited.">
      <Card>
        <CardHeader><CardTitle>Administrator sign in</CardTitle><CardDescription>Two-factor authentication is required.</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            {error && <Alert tone="danger" title={error} />}
            <FormField label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
            <FormField label="Password" htmlFor="password"><Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></FormField>
            <FormField label="Authenticator code" htmlFor="code"><Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="font-mono tracking-widest" /></FormField>
            <Button type="submit" loading={busy} disabled={!email || !password || code.length !== 6} className="w-full">Sign in</Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return <Suspense><Login /></Suspense>;
}
