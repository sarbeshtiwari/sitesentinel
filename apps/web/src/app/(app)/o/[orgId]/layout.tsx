"use client";
import { EmptyState, Skeleton } from "@wim/ui";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { useOrg } from "@/lib/hooks";

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const org = useOrg();
  if (org.isLoading) return <div className="grid gap-3"><Skeleton className="h-7 w-56" /><Skeleton className="h-32 w-full" /></div>;
  if (org.isError || !org.data) {
    return <EmptyState icon={<Building2 />} title="Organization not found" description="It doesn't exist or you're not a member." action={<Link className="text-sm text-primary hover:underline" href="/">Go to your organizations</Link>} />;
  }
  return <>{children}</>;
}
