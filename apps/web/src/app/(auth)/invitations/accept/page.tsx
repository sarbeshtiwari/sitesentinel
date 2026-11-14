"use client";
import { Alert, Button, buttonVariants, Skeleton } from "@wim/ui";
import type { DataEnvelope, InvitationPreviewDto, OrgMembershipDto } from "@wim/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/brand";
import { errorMessage, get, post } from "@/lib/api";
import { qk, useMe } from "@/lib/hooks";

function Accept() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const qc = useQueryClient();
  const here = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: () => get<DataEnvelope<InvitationPreviewDto>>(`/invitations/preview?token=${encodeURIComponent(token)}`, { noAuthRedirect: true }).then((r) => r.data),
    enabled: token.length >= 20,
  });
  const me = useMe({ noAuthRedirect: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: "accept" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "accept") {
        const r = await post<DataEnvelope<OrgMembershipDto>>("/invitations/accept", { token }, { noAuthRedirect: true });
        await qc.invalidateQueries({ queryKey: qk.me });
        router.push(`/o/${r.data.id}/overview`);
      } else {
        await post("/invitations/decline", { token }, { noAuthRedirect: true });
        router.push("/");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!token || preview.isError) {
    return <AuthCard title="Invitation"><Alert tone="danger" title="This invitation link is invalid or has expired.">Ask the person who invited you to send a new one.</Alert></AuthCard>;
  }
  if (preview.isLoading || me.isLoading) {
    return <AuthCard title="Invitation"><div className="grid gap-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div></AuthCard>;
  }
  const inv = preview.data!;
  const signedIn = me.isSuccess;
  const wrongUser = signedIn && me.data.email.toLowerCase() !== inv.email.toLowerCase();
  return (
    <AuthCard title={`Join ${inv.orgName}`} description={<>You've been invited as <strong>{inv.roleName}</strong>. This invitation was sent to <strong>{inv.email}</strong>.</>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger" title={error} />}
        {!signedIn && (
          <>
            <p className="text-sm text-muted-foreground">Sign in or create an account with <strong>{inv.email}</strong> to accept.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Link href={`/login?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: "lg", className: "w-full" })}>Sign in</Link>
              <Link href={`/register?next=${encodeURIComponent(here)}`} className={buttonVariants({ variant: "outline", size: "lg", className: "w-full" })}>Create account</Link>
            </div>
          </>
        )}
        {wrongUser && <Alert tone="warning" title="You're signed in with a different email">You're signed in as {me.data!.email}. Sign out and sign in as {inv.email} to accept.</Alert>}
        {signedIn && !wrongUser && !me.data.emailVerified && <Alert tone="warning" title="Verify your email first">Open the verification link we emailed to {me.data.email}, then come back to this page.</Alert>}
        {signedIn && !wrongUser && (
          <div className="mt-1 flex gap-2">
            <Button size="lg" className="flex-1" loading={busy} disabled={!me.data.emailVerified} onClick={() => act("accept")}>Accept invitation</Button>
            <Button variant="outline" size="lg" disabled={busy} onClick={() => act("decline")}>Decline</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Expires {new Date(inv.expiresAt).toLocaleDateString()}.</p>
      </div>
    </AuthCard>
  );
}

export default function AcceptInvitationPage() {
  return <Suspense><Accept /></Suspense>;
}
