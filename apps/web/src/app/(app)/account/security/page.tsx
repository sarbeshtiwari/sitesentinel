"use client";
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ConfirmDialog, Dialog,
  EmptyState, FormField, Input, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR, toast,
} from "@wim/ui";
import {
  ChangePasswordInput,
  type AuditEntryDto, type DataEnvelope, type ListEnvelope, type RecoveryCodesDto, type SessionDto, type TotpEnrollmentDto,
} from "@wim/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Monitor, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { del, errorMessage, get, post } from "@/lib/api";
import { applyServerErrors, useZodForm } from "@/lib/form";
import { qk, useMe } from "@/lib/hooks";
import { describeAction } from "@/lib/audit";

const PasswordForm = ChangePasswordInput.extend({ confirm: z.string() }).refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

function ChangePassword() {
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const form = useZodForm(PasswordForm);
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await post("/auth/password/change", { currentPassword: v.currentPassword, newPassword: v.newPassword });
      form.reset({ currentPassword: "", newPassword: "", confirm: "" });
      await qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success("Password changed. Other sessions were signed out.");
    } catch (e) {
      if (!applyServerErrors(form, e)) setError(errorMessage(e));
    }
  });
  const { errors } = form.formState;
  return (
    <Card>
      <CardHeader><CardTitle>Password</CardTitle><CardDescription>Changing your password signs you out everywhere else.</CardDescription></CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {error && <Alert tone="danger" title={error} className="sm:col-span-3" />}
          <FormField label="Current password" htmlFor="currentPassword" error={errors.currentPassword?.message}>
            <Input id="currentPassword" type="password" autoComplete="current-password" {...form.register("currentPassword")} />
          </FormField>
          <FormField label="New password" htmlFor="newPassword" error={errors.newPassword?.message}>
            <Input id="newPassword" type="password" autoComplete="new-password" {...form.register("newPassword")} />
          </FormField>
          <FormField label="Confirm new password" htmlFor="confirm" error={errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" {...form.register("confirm")} />
          </FormField>
        </CardContent>
        <CardFooter><Button type="submit" loading={form.formState.isSubmitting}>Change password</Button></CardFooter>
      </form>
    </Card>
  );
}

function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const text = codes?.join("\n") ?? "";
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Two-factor recovery codes (each works once)\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open={codes !== null}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title="Save your recovery codes"
      description="Each code can be used once if you lose your authenticator. They won't be shown again."
      footer={<Button onClick={onClose}>I've saved them</Button>}
    >
      <ul className="grid grid-cols-2 gap-2 rounded-md bg-muted p-3 font-mono text-sm" aria-label="Recovery codes">
        {codes?.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}><Copy className="h-4 w-4" /> Copy</Button>
        <Button variant="outline" size="sm" onClick={download}><Download className="h-4 w-4" /> Download</Button>
      </div>
    </Dialog>
  );
}

function TwoFactor() {
  const me = useMe();
  const qc = useQueryClient();
  const [enrollment, setEnrollment] = useState<TotpEnrollmentDto | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [password, setPasswordValue] = useState("");

  const enabled = me.data?.twoFactor.enabled;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const start = () => run(async () => {
    const r = await post<DataEnvelope<TotpEnrollmentDto>>("/auth/2fa/totp/enroll");
    setEnrollment(r.data);
    setCode("");
  });
  const confirm = () => run(async () => {
    const r = await post<DataEnvelope<RecoveryCodesDto>>("/auth/2fa/totp/confirm", { code });
    setEnrollment(null);
    setCodes(r.data.recoveryCodes);
    setCode("");
    await qc.invalidateQueries({ queryKey: qk.me });
    await qc.invalidateQueries({ queryKey: qk.sessions });
    toast.success("Two-factor authentication enabled");
  });
  const disable = () => run(async () => {
    await post("/auth/2fa/disable", { password, code });
    setDisableOpen(false);
    setPasswordValue("");
    setCode("");
    await qc.invalidateQueries({ queryKey: qk.me });
    toast.success("Two-factor authentication disabled");
  });
  const regenerate = () => run(async () => {
    const r = await post<DataEnvelope<RecoveryCodesDto>>("/auth/2fa/recovery-codes/regenerate", { code });
    setRegenOpen(false);
    setCode("");
    setCodes(r.data.recoveryCodes);
    await qc.invalidateQueries({ queryKey: qk.me });
  });

  const codeInput = (id: string) => (
    <FormField label="Authenticator code" htmlFor={id}>
      <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="font-mono tracking-widest" />
    </FormField>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {me.data && (enabled ? <Badge tone="success"><ShieldCheck className="h-3 w-3" /> On</Badge> : <Badge tone="warning"><ShieldOff className="h-3 w-3" /> Off</Badge>)}
        </CardTitle>
        <CardDescription>Require a code from an authenticator app when signing in.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && !disableOpen && !regenOpen && <Alert tone="danger" title={error} />}
        {me.isLoading && <Skeleton className="h-16" />}
        {me.data && enabled && (
          <p className="text-sm">Recovery codes remaining: <strong>{me.data.twoFactor.recoveryCodesRemaining}</strong> of 10.</p>
        )}
        {me.data && !enabled && !enrollment && <Button className="justify-self-start" loading={busy} onClick={start}>Set up two-factor authentication</Button>}
        {enrollment && (
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            {/* qrSvg is rendered as an image, never injected into the DOM as markup */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(enrollment.qrSvg)}`} alt="QR code for your authenticator app" className="h-48 w-48 rounded-md bg-white p-2" />
            <div className="grid content-start gap-3 text-sm">
              <p>Scan the QR code with an authenticator app (1Password, Google Authenticator, Authy…), or enter this key manually:</p>
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs" data-testid="totp-secret">{enrollment.secret}</code>
              {codeInput("enroll-code")}
              <div className="flex gap-2">
                <Button loading={busy} disabled={code.length !== 6} onClick={confirm}>Verify and enable</Button>
                <Button variant="outline" onClick={() => setEnrollment(null)}>Cancel</Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
      {me.data && enabled && (
        <CardFooter className="justify-start">
          <Button variant="outline" onClick={() => { setCode(""); setError(null); setRegenOpen(true); }}>Regenerate recovery codes</Button>
          <Button variant="danger" onClick={() => { setCode(""); setError(null); setDisableOpen(true); }}>Disable</Button>
        </CardFooter>
      )}
      <ConfirmDialog open={disableOpen} onOpenChange={setDisableOpen} title="Disable two-factor authentication?" description="Your account will be protected by your password only." destructive confirmLabel="Disable" loading={busy} onConfirm={disable}>
        <div className="grid gap-3">
          {error && <Alert tone="danger" title={error} />}
          <FormField label="Password" htmlFor="disable-password">
            <Input id="disable-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPasswordValue(e.target.value)} />
          </FormField>
          {codeInput("disable-code")}
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={regenOpen} onOpenChange={setRegenOpen} title="Regenerate recovery codes?" description="Your existing recovery codes will stop working." confirmLabel="Regenerate" loading={busy} onConfirm={regenerate}>
        <div className="grid gap-3">
          {error && <Alert tone="danger" title={error} />}
          {codeInput("regen-code")}
        </div>
      </ConfirmDialog>
      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />
    </Card>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: qk.sessions, queryFn: () => get<DataEnvelope<SessionDto[]>>("/auth/sessions").then((r) => r.data) });
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (id: string | "others") => {
    setBusy(id);
    try {
      if (id === "others") {
        const r = await del<DataEnvelope<{ revoked: number }>>("/auth/sessions");
        toast.success(`Signed out ${r.data.revoked} other session${r.data.revoked === 1 ? "" : "s"}`);
        setConfirmAll(false);
      } else {
        await del(`/auth/sessions/${id}`);
        toast.success("Session signed out");
      }
      await qc.invalidateQueries({ queryKey: qk.sessions });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const others = (sessions.data ?? []).filter((s) => !s.current).length;
  return (
    <Card>
      <CardHeader><CardTitle>Active sessions</CardTitle><CardDescription>Devices currently signed in to your account.</CardDescription></CardHeader>
      <CardContent>
        {sessions.isLoading ? <Skeleton className="h-24" /> : sessions.isError ? <Alert tone="danger" title={errorMessage(sessions.error)} /> : (
          <Table>
            <THead><TR><TH>Device</TH><TH>Network</TH><TH>Last active</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {sessions.data!.map((s) => (
                <TR key={s.id}>
                  <TD><span className="flex items-center gap-2"><Monitor className="h-4 w-4 text-muted-foreground" aria-hidden /><span className="max-w-xs truncate" title={s.userAgent ?? ""}>{summarizeUa(s.userAgent)}</span>{s.current && <Badge tone="brand">This device</Badge>}</span></TD>
                  <TD className="font-mono text-xs">{s.ipPrefix ?? "—"}</TD>
                  <TD className="text-muted-foreground">{new Date(s.lastSeenAt).toLocaleString()}</TD>
                  <TD className="text-right">{!s.current && <Button size="sm" variant="ghost" loading={busy === s.id} onClick={() => revoke(s.id)}>Sign out</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="justify-start">
        <Button variant="outline" disabled={others === 0} onClick={() => setConfirmAll(true)}>Sign out all other sessions</Button>
      </CardFooter>
      <ConfirmDialog open={confirmAll} onOpenChange={setConfirmAll} title="Sign out all other sessions?" description={`${others} other session${others === 1 ? "" : "s"} will be signed out immediately.`} confirmLabel="Sign out others" destructive loading={busy === "others"} onConfirm={() => revoke("others")} />
    </Card>
  );
}

function summarizeUa(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua.split(" ")[0];
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser ?? "Unknown device";
}

function ActivityLog() {
  const q = useInfiniteQuery({
    queryKey: qk.activity,
    initialPageParam: "",
    queryFn: ({ pageParam }) => get<ListEnvelope<AuditEntryDto>>(`/me/activity?limit=20${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card id="activity">
      <CardHeader><CardTitle>Security activity</CardTitle><CardDescription>Sign-ins and security changes on your account.</CardDescription></CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-24" /> : rows.length === 0 ? <EmptyState title="No activity yet" /> : (
          <Table>
            <THead><TR><TH>Event</TH><TH>Network</TH><TH>When</TH></TR></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}><TD>{describeAction(r.action)}</TD><TD className="font-mono text-xs">{r.ipPrefix ?? "—"}</TD><TD className="text-muted-foreground">{new Date(r.occurredAt).toLocaleString()}</TD></TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      {q.hasNextPage && <CardFooter><Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></CardFooter>}
    </Card>
  );
}

export default function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" description="Password, two-factor authentication and sessions." />
      <div className="grid gap-6">
        <TwoFactor />
        <ChangePassword />
        <Sessions />
        <ActivityLog />
      </div>
    </>
  );
}
