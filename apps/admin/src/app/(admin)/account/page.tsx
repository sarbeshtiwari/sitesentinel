"use client";
import { Avatar, Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Skeleton } from "@wim/ui";
import { useAdminMe } from "@/lib/hooks";

export default function AccountPage() {
  const me = useAdminMe();
  return (
    <>
      <PageHeader title="My account" description="Admin accounts are managed by Super Admins. Two-factor authentication is mandatory and can't be disabled here." />
      <Card className="max-w-2xl overflow-hidden">
        <CardHeader className="flex flex-row items-center gap-3">
          {me.data ? <Avatar name={me.data.name} className="h-10 w-10" /> : <Skeleton className="h-10 w-10 rounded-full" />}
          <div className="grid min-w-0 gap-0.5"><CardTitle>{me.data?.name ?? <Skeleton className="h-5 w-40" />}</CardTitle></div>
        </CardHeader>
        <CardContent className="p-0 text-sm">
          {me.data && (
            <dl className="divide-y divide-border">
              <div className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_1fr] sm:items-center"><dt className="text-xs text-muted-foreground">Email</dt><dd>{me.data.email}</dd></div>
              <div className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_1fr] sm:items-center"><dt className="text-xs text-muted-foreground">Role</dt><dd><Badge tone="brand">{me.data.role}</Badge></dd></div>
              <div className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_1fr]"><dt className="text-xs text-muted-foreground">Permissions <span className="tabular-nums">({me.data.permissions.length})</span></dt>
                <dd><ul className="flex flex-wrap gap-1.5">{me.data.permissions.map((p) => <li key={p}><Badge className="font-mono text-[11px]">{p}</Badge></li>)}</ul></dd></div>
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}
