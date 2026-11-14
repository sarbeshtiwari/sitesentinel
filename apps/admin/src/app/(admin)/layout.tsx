"use client";
import { ArrowLeftRight } from "lucide-react";
import {
  AppShell, Badge, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, SidebarBrand, SidebarItem, SidebarSection,
  Skeleton, ThemeToggle, useBrandColor,
} from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, BarChart3, Bell, Building2, CreditCard, Gauge, Globe, LayoutDashboard, LogOut, ScrollText, Server, Settings, ShieldAlert, SlidersHorizontal, User, Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { post } from "@/lib/api";
import { useAdminMe, useProductName } from "@/lib/hooks";

/** Non-navigating stand-in for links to sections that ship in later phases. */
function Disabled({ children, className }: { children: React.ReactNode; className?: string; href?: string }) {
  return <span aria-disabled="true" className={`${className ?? ""} pointer-events-none`}>{children}</span>;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = useAdminMe();
  const brand = useProductName(me.can("admin:settings:read"));
  useBrandColor(brand.color);
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const signOut = async () => {
    try { await post("/auth/logout"); } catch { /* already signed out */ }
    qc.clear();
    router.push("/login");
  };
  const is = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const soon = <Badge className="text-[10px]">Soon</Badge>;
  const sidebar = (
    <nav aria-label="Admin" className="flex h-full flex-col overflow-y-auto">
      <SidebarBrand><ShieldAlert className="h-5 w-5 text-primary" aria-hidden /><span className="truncate">{brand.name ?? "Platform"} Admin</span></SidebarBrand>
      <SidebarSection title="Platform">
        {me.can("admin:overview:read") && <SidebarItem LinkComponent={Link} href="/overview" icon={<LayoutDashboard />} active={is("/overview")}>Overview</SidebarItem>}
        {me.can("admin:customers:read") && <SidebarItem LinkComponent={Link} href="/customers" icon={<Building2 />} active={is("/customers")}>Customers</SidebarItem>}
        {me.can("admin:overview:read") && <SidebarItem LinkComponent={Link} href="/websites" icon={<Globe />} active={is("/websites")}>Websites & domains</SidebarItem>}
        {me.can("admin:customers:read") && <SidebarItem LinkComponent={Link} href="/transfers" icon={<ArrowLeftRight />} active={is("/transfers")}>Domain transfers</SidebarItem>}
        {me.can("admin:audit:read") && <SidebarItem LinkComponent={Link} href="/audit" icon={<ScrollText />} active={is("/audit")}>Audit log</SidebarItem>}
        {me.can("admin:settings:read") && <SidebarItem LinkComponent={Link} href="/settings" icon={<Settings />} active={is("/settings")}>Settings</SidebarItem>}
      </SidebarSection>
      <SidebarSection title="Operations">
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/platform" icon={<Gauge />} active={is("/platform")}>Platform health</SidebarItem>}
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/alerts" icon={<Bell />} active={is("/alerts")}>Platform alerts</SidebarItem>}
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/monitoring" icon={<Server />} active={is("/monitoring")}>Queues & executions</SidebarItem>}
        {me.can("admin:usage:read") && <SidebarItem LinkComponent={Link} href="/usage" icon={<BarChart3 />} active={is("/usage")}>Usage accounting</SidebarItem>}
        {me.can("admin:settings:read") && <SidebarItem LinkComponent={Link} href="/operations" icon={<SlidersHorizontal />} active={is("/operations")}>Operations config</SidebarItem>}
      </SidebarSection>
      <SidebarSection title="Later phases">
        <SidebarItem LinkComponent={Disabled} href="#" icon={<Wallet />} disabled badge={soon}>Plans & pricing</SidebarItem>
        <SidebarItem LinkComponent={Disabled} href="#" icon={<CreditCard />} disabled badge={soon}>Payment gateways</SidebarItem>
        <SidebarItem LinkComponent={Disabled} href="#" icon={<Activity />} disabled badge={soon}>Security events</SidebarItem>
      </SidebarSection>
    </nav>
  );
  const topbar = (
    <>
      <span className="text-sm text-muted-foreground">Super Admin console</span>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        {me.isLoading ? <Skeleton className="h-8 w-8 rounded-full" /> : (
          <DropdownMenu label="Admin account menu" trigger={<span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{(me.data?.name ?? "A").slice(0, 1).toUpperCase()}</span>}>
            {me.data && <DropdownLabel><span className="block font-medium text-foreground">{me.data.name}</span>{me.data.email}<span className="block">{me.data.role}</span></DropdownLabel>}
            <DropdownSeparator />
            <DropdownItem onClick={() => router.push("/account")}><User className="h-4 w-4" /> My account</DropdownItem>
            <DropdownItem danger onClick={signOut}><LogOut className="h-4 w-4" /> Sign out</DropdownItem>
          </DropdownMenu>
        )}
      </div>
    </>
  );
  return <AppShell sidebar={sidebar} topbar={topbar}>{children}</AppShell>;
}
