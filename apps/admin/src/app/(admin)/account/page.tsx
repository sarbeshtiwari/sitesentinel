"use client";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Skeleton } from "@wim/ui";
import { useAdminMe } from "@/lib/hooks";

export default function AccountPage() {
  const me = useAdminMe();
  return (
    <>
      <PageHeader title="My account" description="Admin accounts are managed by Super Admins. Two-factor authentication is mandatory and can't be disabled here." />
      <Card className="max-w-xl">
        <CardHeader><CardTitle>{me.data?.name ?? <Skeleton className="h-5 w-40" />}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {me.data && (
            <>
              <p>Email: {me.data.email}</p>
              <p>Role: <Badge tone="brand">{me.data.role}</Badge></p>
              <div>
                <p className="mb-1">Permissions:</p>
                <ul className="flex flex-wrap gap-1.5">{me.data.permissions.map((p) => <li key={p}><Badge className="font-mono text-[11px]">{p}</Badge></li>)}</ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
