"use client";
import { Alert, AuthLayout, Button, FormField, Input, Logo } from "@wim/ui";
import type { AdminMeDto, DataEnvelope } from "@wim/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound, ScrollText } from "lucide-react";
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
    <AuthLayout
      brand={<Logo variant="admin" suffix={<span className="rounded-md bg-navy px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white">Admin</span>} />}
      aside={<ControlPlanePanel />}
      footer="Restricted to authorized platform administrators. All activity is audited."
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Administrator sign in</h1>
        <p className="text-sm text-muted-foreground">Two-factor authentication is required for every session.</p>
      </div>
      <form onSubmit={submit} className="mt-7 grid gap-4">
        {error && <Alert tone="danger" title={error} />}
        <FormField label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        <FormField label="Password" htmlFor="password"><Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></FormField>
        <FormField label="Authenticator code" htmlFor="code" hint="6-digit code from your authenticator app"><Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="font-mono text-base tracking-[0.4em]" /></FormField>
        <Button type="submit" size="lg" loading={busy} disabled={!email || !password || code.length !== 6} className="mt-1 w-full">Sign in</Button>
      </form>
    </AuthLayout>
  );
}

const PRINCIPLES = [
  { icon: Eye, title: "Aggregate visibility", text: "Platform health, queues and usage — never customer content, credentials or telemetry." },
  { icon: KeyRound, title: "Scoped roles", text: "Each administrator sees only what their role permits." },
  { icon: ScrollText, title: "Audited changes", text: "Every configuration change requires a reason and is recorded." },
];

function ControlPlanePanel() {
  return (
    <div className="relative flex h-full flex-col justify-center overflow-hidden p-12 text-white">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:32px_32px]" />
      <div className="relative max-w-md">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Control plane</p>
        <h2 className="mt-3 text-[28px] font-semibold leading-tight tracking-tight">Operate the platform without touching customer data.</h2>
        <ul className="mt-8 grid gap-5">
          {PRINCIPLES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.07] ring-1 ring-white/10"><Icon className="h-4 w-4 text-cyan-300" aria-hidden /></span>
              <span><span className="block text-sm font-medium">{title}</span><span className="block text-sm text-slate-300">{text}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><Login /></Suspense>;
}
