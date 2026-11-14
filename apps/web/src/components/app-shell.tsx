"use client";
import {
  Activity, Bell, Building2, Check, ChevronsUpDown, Gauge, Globe, History, LayoutDashboard, LogOut, Plus, ScrollText,
  Settings, ShieldCheck, Siren, User, Users, Webhook, KeyRound,
} from "lucide-react";
import {
  AppShell, Badge, Button, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, SidebarBrand, SidebarItem,
  SidebarSection, Skeleton, ThemeToggle, toast,
} from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, post } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { useLiveUpdates } from "@/lib/monitoring";
import { BrandMark } from "./brand";

function VerifyBanner() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      await post("/auth/verify-email/resend");
      setSent(true);
      toast.success("Verification email sent");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-2 text-sm">
      <span>Verify your email address to create organizations and accept invitations.</span>
      <Button size="sm" variant="outline" loading={busy} disabled={sent} onClick={resend}>{sent ? "Email sent" : "Resend email"}</Button>
    </div>
  );
}

export function CustomerShell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useParams<{ orgId?: string }>();
  const orgs = me.data?.orgs ?? [];
  const orgId = params.orgId ?? orgs[0]?.id;
  // Live updates only inside an organisation the user is viewing (membership is enforced by the API).
  const unread = useLiveUpdates(params.orgId);
  const current = orgs.find((o) => o.id === orgId);

  const signOut = async () => {
    try {
      await post("/auth/logout");
    } catch { /* session may already be gone */ }
    qc.clear();
    router.push("/login");
  };

  const base = `/o/${orgId}`;
  // Without an organization every org section leads to onboarding.
  const at = (section: string) => (orgId ? `${base}/${section}` : "/onboarding");
  const is = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const later = <Badge tone="neutral" className="text-[10px]">Soon</Badge>;

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto">
      <SidebarBrand><BrandMark /></SidebarBrand>
      <SidebarSection title="Monitoring">
        <SidebarItem LinkComponent={Link} href={at("overview")} icon={<LayoutDashboard />} active={Boolean(orgId) && is(at("overview"))}>Overview</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("websites")} icon={<Globe />} active={Boolean(orgId) && is(at("websites"))}>Websites</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("incidents")} icon={<Siren />} active={Boolean(orgId) && is(at("incidents"))}>Incidents</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("history")} icon={<History />} active={Boolean(orgId) && is(at("history"))}>History</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("notifications")} icon={<Bell />} active={Boolean(orgId) && is(at("notifications"))} badge={unread ? <Badge tone="brand" className="text-[10px]">{unread > 99 ? "99+" : unread}</Badge> : undefined}>Notifications</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("usage")} icon={<Gauge />} active={Boolean(orgId) && is(at("usage"))}>Usage & limits</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("api-monitoring")} icon={<Webhook />} active={Boolean(orgId) && is(at("api-monitoring"))} badge={later}>API monitoring</SidebarItem>
      </SidebarSection>
      {orgId && (
        <SidebarSection title="Organization">
          <SidebarItem LinkComponent={Link} href={`${base}/settings/general`} icon={<Settings />} active={is(`${base}/settings/general`)}>General</SidebarItem>
          <SidebarItem LinkComponent={Link} href={`${base}/settings/team`} icon={<Users />} active={is(`${base}/settings/team`)}>Team</SidebarItem>
          <SidebarItem LinkComponent={Link} href={`${base}/settings/roles`} icon={<KeyRound />} active={is(`${base}/settings/roles`)}>Roles</SidebarItem>
          <SidebarItem LinkComponent={Link} href={`${base}/settings/audit`} icon={<ScrollText />} active={is(`${base}/settings/audit`)}>Audit log</SidebarItem>
        </SidebarSection>
      )}
      <SidebarSection title="Account">
        <SidebarItem LinkComponent={Link} href="/account/profile" icon={<User />} active={is("/account/profile")}>Profile</SidebarItem>
        <SidebarItem LinkComponent={Link} href="/account/security" icon={<ShieldCheck />} active={is("/account/security")}>Security</SidebarItem>
      </SidebarSection>
    </nav>
  );

  const topbar = (
    <>
      {me.isLoading ? <Skeleton className="h-8 w-40" /> : (
        <DropdownMenu
          align="start"
          label="Switch organization"
          trigger={
            <span className="flex max-w-[60vw] items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted">
              <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="truncate">{current?.name ?? "No organization"}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </span>
          }
        >
          <DropdownLabel>Organizations</DropdownLabel>
          {orgs.map((o) => (
            <DropdownItem key={o.id} onClick={() => router.push(`/o/${o.id}/overview`)}>
              <span className="flex-1 truncate">{o.name}</span>
              <span className="text-xs text-muted-foreground">{o.role.name}</span>
              {o.id === orgId && <Check className="h-4 w-4" aria-label="current" />}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onClick={() => router.push("/onboarding?new=1")}><Plus className="h-4 w-4" /> Create organization</DropdownItem>
        </DropdownMenu>
      )}
      <div className="flex items-center gap-1">
        {orgId && (
          <Link href={`/o/${orgId}/notifications`} className="relative inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Bell className="h-4 w-4" aria-hidden />
            {unread > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
          </Link>
        )}
        <ThemeToggle />
        <DropdownMenu
          label="Account menu"
          trigger={
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {(me.data?.name ?? me.data?.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
          }
        >
          {me.data && <DropdownLabel><span className="block truncate font-medium text-foreground">{me.data.name}</span>{me.data.email}</DropdownLabel>}
          <DropdownSeparator />
          <DropdownItem onClick={() => router.push("/account/profile")}><User className="h-4 w-4" /> Profile</DropdownItem>
          <DropdownItem onClick={() => router.push("/account/security")}><ShieldCheck className="h-4 w-4" /> Security</DropdownItem>
          <DropdownItem onClick={() => router.push("/account/security#activity")}><Activity className="h-4 w-4" /> Activity</DropdownItem>
          <DropdownSeparator />
          <DropdownItem danger onClick={signOut}><LogOut className="h-4 w-4" /> Sign out</DropdownItem>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <AppShell sidebar={sidebar} topbar={topbar} banner={me.data && !me.data.emailVerified ? <VerifyBanner /> : undefined}>
      {children}
    </AppShell>
  );
}
