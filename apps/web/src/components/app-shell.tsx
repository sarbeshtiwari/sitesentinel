"use client";
import type { Permission } from "@wim/core";
import {
  Activity, Bell, Building2, Check, ChevronsUpDown, Gauge, Globe, History, KeyRound, LayoutDashboard, LifeBuoy, LogOut, MailWarning,
  CreditCard, Plus, ScrollText, Settings, ShieldCheck, Siren, User, Users,
} from "lucide-react";
import {
  AppShell, Avatar, Badge, Breadcrumbs, Button, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, Logo, LogoSymbol,
  SidebarAccount, SidebarBrand, SidebarItem, SidebarSection, Skeleton, ThemeToggle, Tooltip, toast,
} from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, post } from "@/lib/api";
import { useConfig, useMe, useOrg } from "@/lib/hooks";
import { useLiveUpdates } from "@/lib/monitoring";
import { useRealtimeNotifications } from "@/lib/realtime-notifications";
import { NotificationBell } from "./notification-bell";
import { NotificationToasts } from "./notification-toasts";

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
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--warning)_25%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-4 py-2 text-sm">
      <MailWarning className="h-4 w-4 text-warning" aria-hidden />
      <span>Verify your email address to create organizations and accept invitations.</span>
      <Button size="sm" variant="outline" loading={busy} disabled={sent} onClick={resend}>{sent ? "Email sent" : "Resend email"}</Button>
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABELS: Record<string, string> = {
  overview: "Overview", websites: "Websites", new: "Add website", transfers: "Transfers", incidents: "Incidents", history: "History",
  notifications: "Notifications", preferences: "Preferences", usage: "Usage & limits", settings: "Settings", general: "General",
  team: "Team", roles: "Roles", audit: "Audit log", billing: "Billing", account: "Account", profile: "Profile", security: "Security", onboarding: "Get started",
  "api-monitoring": "API monitoring", browser: "Browser run", "deep-scan": "Deep scan", scans: "Scans", findings: "Findings",
};
// Website sub-paths without an index page → the website tab that lists them.
const WEBSITE_TAB_SEGMENT: Record<string, string> = { browser: "browser", "deep-scan": "deep-scan", pages: "pages" };
// The record type each id-segment refers to, by the segment before it.
const ID_LABEL: Record<string, string> = { websites: "Website", incidents: "Incident", browser: "Run", scans: "Scan", findings: "Finding", pages: "Page" };

/** Breadcrumbs derived from the URL only (no extra requests); ids are shown by record type. */
function useCrumbs(pathname: string, orgName?: string) {
  const parts = pathname.split("/").filter(Boolean);
  const items: Array<{ label: string; href?: string }> = [];
  let href = "";
  parts.forEach((p, i) => {
    href += `/${p}`;
    if (p === "o") return;
    if (i === 1 && parts[0] === "o") { items.push({ label: orgName ?? "Organization", href: `${href}/overview` }); return; }
    if (p === "settings" || p === "account") return; // section groups without their own page
    // Sub-records of a website have no index page of their own; their list lives on a tab of the website page.
    if (parts[i - 2] === "websites" && UUID.test(parts[i - 1] ?? "") && WEBSITE_TAB_SEGMENT[p]) {
      items.push({ label: LABELS[p] ?? p, href: `${href.slice(0, -(p.length + 1))}?tab=${WEBSITE_TAB_SEGMENT[p]}` });
      return;
    }
    if (parts[i - 3] === "websites" && parts[i - 1] === "deep-scan") return; // "scans" / "findings": no page; the Deep scan crumb covers it
    const label = UUID.test(p) || (parts[i - 1] === "pages" && /^url-[0-9a-f]{64}$/.test(p)) ? (ID_LABEL[parts[i - 1] ?? ""] ?? "Details") : (LABELS[p] ?? p);
    items.push({ label, href });
  });
  return items;
}

export function CustomerShell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const { config } = useConfig();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const params = useParams<{ orgId?: string }>();
  const orgs = me.data?.orgs ?? [];
  const orgId = params.orgId ?? orgs[0]?.id;
  // Live updates only inside an organisation the user is viewing (membership is enforced by the API).
  const unread = useLiveUpdates(params.orgId);
  // New in-app notifications → toast, desktop notification and sound (leader tab polls; see realtime-notifications).
  useRealtimeNotifications(params.orgId);
  const org = useOrg();
  const current = orgs.find((o) => o.id === orgId);
  // Hide sections the member's role cannot open; the API enforces the same permissions.
  const can = (p: Permission) => !org.data || org.can(p);

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
  const on = (section: string) => Boolean(orgId) && is(at(section));
  const count = (n: number) => <Badge tone="brand" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">{n > 99 ? "99+" : n}</Badge>;

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto overflow-x-hidden pb-2">
      <SidebarBrand href={orgId ? at("overview") : "/"} LinkComponent={Link} collapsedChildren={<LogoSymbol title={config.productName} />}>
        {config.logoUrl && /^https:\/\//.test(config.logoUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt={config.productName} className="h-7 w-auto" />
        ) : <Logo name={config.productName} />}
      </SidebarBrand>
      <SidebarSection title="Monitor">
        <SidebarItem LinkComponent={Link} href={at("overview")} icon={<LayoutDashboard />} active={on("overview")}>Overview</SidebarItem>
        {can("website:read") && <SidebarItem LinkComponent={Link} href={at("websites")} icon={<Globe />} active={on("websites")}>Websites</SidebarItem>}
        {can("incident:read") && <SidebarItem LinkComponent={Link} href={at("incidents")} icon={<Siren />} active={on("incidents")}>Incidents</SidebarItem>}
        {can("website:read") && <SidebarItem LinkComponent={Link} href={at("history")} icon={<History />} active={on("history")}>History</SidebarItem>}
      </SidebarSection>
      <SidebarSection title="Workspace">
        <SidebarItem LinkComponent={Link} href={at("notifications")} icon={<Bell />} active={on("notifications")} badge={unread ? count(unread) : undefined}>Notifications</SidebarItem>
        <SidebarItem LinkComponent={Link} href={at("usage")} icon={<Gauge />} active={on("usage")}>Usage & limits</SidebarItem>
      </SidebarSection>
      {orgId && (
        <SidebarSection title="Settings" id="org-settings" collapsible containsActive={is(`${base}/settings`)}>
          {can("org:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/general`} icon={<Settings />} active={is(`${base}/settings/general`)}>General</SidebarItem>}
          {can("member:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/team`} icon={<Users />} active={is(`${base}/settings/team`)}>Team</SidebarItem>}
          {can("member:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/roles`} icon={<KeyRound />} active={is(`${base}/settings/roles`)}>Roles</SidebarItem>}
          {can("billing:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/billing`} icon={<CreditCard />} active={is(`${base}/settings/billing`)}>Billing</SidebarItem>}
          {can("audit:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/audit`} icon={<ScrollText />} active={is(`${base}/settings/audit`)}>Audit log</SidebarItem>}
        </SidebarSection>
      )}
      {!orgId && (
        <SidebarSection title="Account">
          <SidebarItem LinkComponent={Link} href="/account/profile" icon={<User />} active={is("/account/profile")}>Profile</SidebarItem>
          <SidebarItem LinkComponent={Link} href="/account/security" icon={<ShieldCheck />} active={is("/account/security")}>Security</SidebarItem>
        </SidebarSection>
      )}
    </nav>
  );

  const workspace = me.isLoading ? <Skeleton className="h-8 w-44" /> : (
    <DropdownMenu
      align="start"
      label="Switch organization"
      trigger={
        <span className="flex max-w-[52vw] items-center gap-2 rounded-md border border-border bg-card py-1 pl-1 pr-2 text-sm font-medium shadow-xs hover:border-border-strong sm:max-w-64">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary-soft text-[11px] font-semibold text-primary" aria-hidden>
            {current ? current.name.slice(0, 1).toUpperCase() : <Building2 className="h-3.5 w-3.5" />}
          </span>
          <span className="truncate">{current?.name ?? "No organization"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </span>
      }
    >
      <DropdownLabel>Organizations</DropdownLabel>
      {orgs.map((o) => (
        <DropdownItem key={o.id} onClick={() => router.push(`/o/${o.id}/overview`)}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold" aria-hidden>{o.name.slice(0, 1).toUpperCase()}</span>
          <span className="flex-1 truncate">{o.name}</span>
          <span className="text-xs text-muted-foreground">{o.role.name}</span>
          {o.id === orgId ? <Check className="h-4 w-4 !text-primary" aria-label="current" /> : <span className="w-4" />}
        </DropdownItem>
      ))}
      <DropdownSeparator />
      <DropdownItem onClick={() => router.push("/onboarding?new=1")}><Plus /> Create organization</DropdownItem>
    </DropdownMenu>
  );

  const crumbs = useCrumbs(pathname, current?.name);
  const iconBtn = "relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground";
  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        {workspace}
        {crumbs.length > 1 && <span className="hidden h-5 w-px bg-border md:block" aria-hidden />}
        {crumbs.length > 1 && <Breadcrumbs className="hidden md:block" LinkComponent={Link} items={crumbs.slice(1)} />}
      </div>
      <div className="flex items-center gap-0.5">
        {config.supportEmail && (
          <Tooltip content="Contact support" side="bottom">
            <a href={`mailto:${config.supportEmail}`} className={iconBtn} aria-label="Help and support"><LifeBuoy className="h-[18px] w-[18px]" aria-hidden /></a>
          </Tooltip>
        )}
        {params.orgId && <NotificationBell orgId={params.orgId} unread={unread} className={iconBtn} />}
        <ThemeToggle className="text-muted-foreground" />
      </div>
    </>
  );

  return (
    <AppShell
      sidebar={sidebar}
      topbar={topbar}
      surface="customer"
      banner={me.data && !me.data.emailVerified ? <VerifyBanner /> : undefined}
      sidebarFooter={me.data ? (
        <SidebarAccount
          avatar={<Avatar name={me.data.name ?? me.data.email} className="h-8 w-8" />}
          name={me.data.name ?? me.data.email}
          detail={current ? `${current.role.name} · ${current.name}` : me.data.email}
          menu={<>
            <DropdownLabel>
              <span className="block truncate text-sm font-medium text-foreground">{me.data.name}</span>
              <span className="block truncate">{me.data.email}</span>
            </DropdownLabel>
            <DropdownSeparator />
            <DropdownItem onClick={() => router.push("/account/profile")}><User /> Profile</DropdownItem>
            <DropdownItem onClick={() => router.push("/account/security")}><ShieldCheck /> Security</DropdownItem>
            <DropdownItem onClick={() => router.push("/account/security#activity")}><Activity /> Sign-in activity</DropdownItem>
            <DropdownSeparator />
            <DropdownItem danger onClick={signOut}><LogOut /> Sign out</DropdownItem>
          </>}
        />
      ) : undefined}
    >
      {children}
      <NotificationToasts orgId={params.orgId} />
    </AppShell>
  );
}
