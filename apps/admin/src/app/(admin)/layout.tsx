"use client";
import { ArrowLeftRight } from "lucide-react";
import {
  AppShell, Avatar, Badge, Breadcrumbs, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, Logo, LogoSymbol, SidebarBrand,
  SidebarItem, SidebarSection, Skeleton, ThemeToggle, useBrandColor,
} from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, Bell, Building2, CreditCard, Gauge, Globe, Layers, LayoutDashboard, LogOut, ScrollText, Server, Settings, SlidersHorizontal, User,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { post } from "@/lib/api";
import { useAdminMe, useProductName } from "@/lib/hooks";

const LABELS: Record<string, string> = {
  overview: "Overview", customers: "Customers", websites: "Websites & domains", transfers: "Domain transfers", audit: "Audit log",
  settings: "Settings", platform: "Platform health", alerts: "Platform alerts", monitoring: "Queues & executions", usage: "Usage accounting",
  operations: "Operations config", account: "My account", plans: "Plans", gateways: "Payment gateways",
};

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
  const section = pathname.split("/").filter(Boolean);
  const crumbs = section.map((p, i) => ({ label: LABELS[p] ?? (i > 0 ? "Details" : p), href: `/${section.slice(0, i + 1).join("/")}` }));
  const sidebar = (
    <nav aria-label="Admin" className="flex h-full flex-col overflow-y-auto">
      <SidebarBrand href="/overview" LinkComponent={Link} collapsedChildren={<LogoSymbol variant="admin" title="Admin console" />}>
        <span className="text-white"><Logo variant="admin" name={brand.name ?? "SiteSentinel"} suffix={<Badge className="bg-white/10 text-[10px] uppercase tracking-wider text-cyan-200 ring-white/15">Admin</Badge>} /></span>
      </SidebarBrand>
      <SidebarSection title="Platform">
        {me.can("admin:overview:read") && <SidebarItem LinkComponent={Link} href="/overview" icon={<LayoutDashboard />} active={is("/overview")}>Overview</SidebarItem>}
        {me.can("admin:customers:read") && <SidebarItem LinkComponent={Link} href="/customers" icon={<Building2 />} active={is("/customers")}>Customers</SidebarItem>}
        {me.can("admin:overview:read") && <SidebarItem LinkComponent={Link} href="/websites" icon={<Globe />} active={is("/websites")}>Websites & domains</SidebarItem>}
        {me.can("admin:customers:read") && <SidebarItem LinkComponent={Link} href="/transfers" icon={<ArrowLeftRight />} active={is("/transfers")}>Domain transfers</SidebarItem>}
        {me.can("admin:audit:read") && <SidebarItem LinkComponent={Link} href="/audit" icon={<ScrollText />} active={is("/audit")}>Audit log</SidebarItem>}
        {me.can("admin:settings:read") && <SidebarItem LinkComponent={Link} href="/settings" icon={<Settings />} active={is("/settings")}>Settings</SidebarItem>}
      </SidebarSection>
      {me.can("admin:billing:read") && (
        <SidebarSection title="Billing">
          <SidebarItem LinkComponent={Link} href="/plans" icon={<Layers />} active={is("/plans")}>Plans</SidebarItem>
          <SidebarItem LinkComponent={Link} href="/gateways" icon={<CreditCard />} active={is("/gateways")}>Payment gateways</SidebarItem>
        </SidebarSection>
      )}
      <SidebarSection title="Operations">
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/platform" icon={<Gauge />} active={is("/platform")}>Platform health</SidebarItem>}
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/alerts" icon={<Bell />} active={is("/alerts")}>Platform alerts</SidebarItem>}
        {me.can("admin:monitoring:read") && <SidebarItem LinkComponent={Link} href="/monitoring" icon={<Server />} active={is("/monitoring")}>Queues & executions</SidebarItem>}
        {me.can("admin:usage:read") && <SidebarItem LinkComponent={Link} href="/usage" icon={<BarChart3 />} active={is("/usage")}>Usage accounting</SidebarItem>}
        {me.can("admin:settings:read") && <SidebarItem LinkComponent={Link} href="/operations" icon={<SlidersHorizontal />} active={is("/operations")}>Operations config</SidebarItem>}
      </SidebarSection>
    </nav>
  );
  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <Badge tone="info" className="hidden sm:inline-flex">Super Admin</Badge>
        {crumbs.length > 0 && <Breadcrumbs LinkComponent={Link} items={crumbs} />}
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle className="text-muted-foreground" />
        {me.isLoading ? <Skeleton className="h-8 w-8 rounded-full" /> : (
          <DropdownMenu label="Admin account menu" triggerClassName="ml-1" trigger={<Avatar name={me.data?.name ?? "Admin"} />}>
            {me.data && <DropdownLabel><span className="block text-sm font-medium text-foreground">{me.data.name}</span><span className="block truncate">{me.data.email}</span><Badge tone="info" className="mt-1.5">{me.data.role}</Badge></DropdownLabel>}
            <DropdownSeparator />
            <DropdownItem onClick={() => router.push("/account")}><User /> My account</DropdownItem>
            <DropdownItem danger onClick={signOut}><LogOut /> Sign out</DropdownItem>
          </DropdownMenu>
        )}
      </div>
    </>
  );
  return <AppShell sidebar={sidebar} topbar={topbar} surface="admin" wide>{children}</AppShell>;
}
