"use client";
import type { Permission } from "@wim/core";
import {
  Activity, BarChart3, Bell, Building2, Check, ChevronsUpDown, CircleUserRound, Gauge, Globe, History, House, KeyRound, LifeBuoy, LogOut, MailWarning,
  CreditCard, Plus, ScrollText, Settings, ShieldCheck, TriangleAlert, User, Users, Webhook,
} from "lucide-react";
import {
  AppShell, Avatar, Breadcrumbs, Button, CountBadge, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, Logo, LogoSymbol, MobileTab,
  SidebarAccount, SidebarBrand, SidebarItem, SidebarSection, Skeleton, ThemeMenuItem, ThemeToggle, Tooltip, cn, toast, useShellNav, useSidebarCollapsed,
} from "@wim/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, post } from "@/lib/api";
import { useConfig, useMe, useOrg } from "@/lib/hooks";
import { health, presetRange, useLiveUpdates, useOverview } from "@/lib/monitoring";
import { useWebsites } from "@/lib/websites";
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
  overview: "Home", websites: "Websites", new: "Add website", transfers: "Transfers", incidents: "Issues", history: "History",
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

const DOT: Record<string, string> = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", brand: "bg-primary", neutral: "bg-faint" };
const SIDEBAR_WEBSITES = 8;

/** "You" tab: opens the navigation sheet (sidebar with Settings and the account menu). */
function YouTab() {
  const { openNav } = useShellNav();
  return <MobileTab icon={<CircleUserRound />} label="You" onClick={openNav} ariaLabel="Account and more" />;
}

/** Organization switcher (sidebar on desktop, top bar on smaller screens). */
function OrgSwitcher({ compact }: { compact?: boolean }) {
  const me = useMe();
  const router = useRouter();
  const params = useParams<{ orgId?: string }>();
  const collapsed = useSidebarCollapsed();
  const orgs = me.data?.orgs ?? [];
  const orgId = params.orgId ?? orgs[0]?.id;
  const current = orgs.find((o) => o.id === orgId);
  if (me.isLoading) return <Skeleton className={compact ? "h-8 w-36" : "h-10 w-full"} />;
  const initial = (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-primary-soft text-[11px] font-semibold text-primary" aria-hidden>
      {current ? current.name.slice(0, 1).toUpperCase() : <Building2 className="h-3.5 w-3.5" />}
    </span>
  );
  return (
    <DropdownMenu
      align="start"
      label="Switch organization"
      triggerClassName={compact ? undefined : "block w-full"}
      trigger={collapsed && !compact ? <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card">{initial}</span> : (
        <span className={cn("flex items-center gap-2 rounded-lg border border-border bg-card text-left text-sm font-medium hover:border-border-strong",
          compact ? "max-w-[52vw] py-1 pl-1 pr-2 sm:max-w-64" : "w-full py-2 pl-2 pr-2.5")}>
          {initial}
          <span className="min-w-0 flex-1 truncate">{current?.name ?? "No organization"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        </span>
      )}
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
  // Sidebar website list + open-issue count: the same queries the pages use (kept fresh by the change feed).
  const [range] = useState(() => presetRange("24h"));
  const readSites = Boolean(params.orgId) && can("website:read");
  const websites = useWebsites(readSites ? params.orgId! : "");
  const overview = useOverview(readSites ? params.orgId! : "", range);
  const healthOf = new Map((overview.data?.websites ?? []).map((w) => [w.id, w.health]));
  const openIssues = overview.data?.totals.activeIncidents ?? 0;

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
  const count = (n: number, tone: "neutral" | "warning" = "neutral") => <CountBadge tone={tone}>{n > 99 ? "99+" : n}</CountBadge>;
  const notificationsLabel = unread ? `Notifications (${unread} new)` : undefined;
  const issuesLabel = openIssues ? `Issues, ${openIssues} open` : undefined;
  const siteList = (websites.data ?? []).slice(0, SIDEBAR_WEBSITES);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto overflow-x-hidden pb-2">
      <SidebarBrand href={orgId ? at("overview") : "/"} LinkComponent={Link} collapsedChildren={<LogoSymbol title={config.productName} />}>
        {config.logoUrl && /^https:\/\//.test(config.logoUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt={config.productName} className="h-7 w-auto" />
        ) : <Logo name={config.productName} />}
      </SidebarBrand>
      <div className="px-3"><OrgSwitcher /></div>
      <SidebarSection>
        <SidebarItem LinkComponent={Link} href={at("overview")} icon={<House />} active={on("overview")}>Home</SidebarItem>
        {can("website:read") && <SidebarItem LinkComponent={Link} href={at("websites")} icon={<Globe />} active={on("websites") && !siteList.some((w) => is(`${base}/websites/${w.id}`))}>Websites</SidebarItem>}
        {can("incident:read") && <SidebarItem LinkComponent={Link} href={at("incidents")} icon={<TriangleAlert />} active={on("incidents")} ariaLabel={issuesLabel} badge={openIssues ? count(openIssues, "warning") : undefined}>Issues</SidebarItem>}
        <SidebarItem LinkComponent={Link} href={at("notifications")} icon={<Bell />} active={on("notifications")} ariaLabel={notificationsLabel} badge={unread ? count(unread) : undefined}>Notifications</SidebarItem>
      </SidebarSection>
      {readSites && siteList.length > 0 && (
        <SidebarSection title="Websites" id="websites">
          {siteList.map((w) => {
            const h = health(healthOf.get(w.id) ?? (w.verification === "VERIFIED" ? "NO_DATA" : "NOT_VERIFIED"));
            return (
              <SidebarItem key={w.id} compact LinkComponent={Link} href={`${base}/websites/${w.id}`} active={is(`${base}/websites/${w.id}`)} ariaLabel={`${w.displayHost}, ${h.label}`}
                icon={<span aria-hidden className="flex h-4 w-4 items-center justify-center"><span className={cn("h-2 w-2 rounded-full", DOT[h.tone])} /></span>}>
                <span className="font-normal">{w.displayHost}</span>
              </SidebarItem>
            );
          })}
          {(websites.data?.length ?? 0) > SIDEBAR_WEBSITES && (
            <SidebarItem compact LinkComponent={Link} href={at("websites")} icon={<span className="h-4 w-4" aria-hidden />}><span className="text-muted-foreground">All websites ({websites.data!.length})</span></SidebarItem>
          )}
        </SidebarSection>
      )}
      {orgId && (
        <SidebarSection title="Settings" id="org-settings" collapsible containsActive={is(`${base}/settings`)}>
          {can("org:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/general`} icon={<Settings />} active={is(`${base}/settings/general`)}>General</SidebarItem>}
          {can("member:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/team`} icon={<Users />} active={is(`${base}/settings/team`)}>Team</SidebarItem>}
          {can("member:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/roles`} icon={<KeyRound />} active={is(`${base}/settings/roles`)}>Roles</SidebarItem>}
          {can("billing:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/billing`} icon={<CreditCard />} active={is(`${base}/settings/billing`)}>Billing</SidebarItem>}
          {can("audit:read") && <SidebarItem LinkComponent={Link} href={`${base}/settings/audit`} icon={<ScrollText />} active={is(`${base}/settings/audit`)}>Audit log</SidebarItem>}
        </SidebarSection>
      )}
      <SidebarSection title="More" id="more" collapsible defaultOpen={false} containsActive={on("history") || on("usage") || is("/account")}>
        {can("website:read") && <SidebarItem LinkComponent={Link} href={at("history")} icon={<History />} active={on("history")}>History</SidebarItem>}
        <SidebarItem LinkComponent={Link} href={at("usage")} icon={<Gauge />} active={on("usage")}>Usage & limits</SidebarItem>
        <SidebarItem LinkComponent={Link} href="/account/profile" icon={<User />} active={is("/account/profile")}>Profile</SidebarItem>
        <SidebarItem LinkComponent={Link} href="/account/security" icon={<ShieldCheck />} active={is("/account/security")}>Security</SidebarItem>
      </SidebarSection>
    </nav>
  );

  const crumbs = useCrumbs(pathname, current?.name);
  const iconBtn = "relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground";
  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <div className="lg:hidden"><OrgSwitcher compact /></div>
        {crumbs.length > 1 && <Breadcrumbs className="hidden lg:block" LinkComponent={Link} items={crumbs.slice(1)} />}
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

  const mobileNav = (
    <>
      <MobileTab LinkComponent={Link} href={at("overview")} icon={<House />} label="Home" active={on("overview")} />
      {can("website:read") && <MobileTab LinkComponent={Link} href={at("websites")} icon={<Globe />} label="Websites" active={on("websites")} />}
      {can("incident:read") && <MobileTab LinkComponent={Link} href={at("incidents")} icon={<TriangleAlert />} active={on("incidents")} ariaLabel={issuesLabel}
        label={<>Issues{openIssues ? <span className="tabular-nums"> · {openIssues > 99 ? "99+" : openIssues}</span> : null}</>} />}
      <MobileTab LinkComponent={Link} href={at("notifications")} icon={<Bell />} active={on("notifications")} ariaLabel={notificationsLabel}
        label={<>Alerts{unread ? <span className="tabular-nums"> · {unread > 99 ? "99+" : unread}</span> : null}</>} />
      <YouTab />
    </>
  );

  const go = (href: string) => () => router.push(href);
  return (
    <AppShell
      sidebar={sidebar}
      topbar={topbar}
      surface="customer"
      mobileNav={mobileNav}
      banner={me.data && !me.data.emailVerified ? <VerifyBanner /> : undefined}
      sidebarFooter={me.data ? (
        <SidebarAccount
          avatar={<Avatar name={me.data.name ?? me.data.email} className="h-8 w-8" />}
          name={me.data.name ?? me.data.email}
          detail={current ? current.role.name : me.data.email}
          menu={<>
            <DropdownLabel>
              <span className="block truncate text-sm font-medium text-foreground">{me.data.name}</span>
              <span className="block truncate">{me.data.email}</span>
            </DropdownLabel>
            <DropdownSeparator />
            {orgId && <>
              <DropdownLabel>Settings{current ? ` · ${current.name}` : ""}</DropdownLabel>
              {can("org:read") && <DropdownItem onClick={go(`${base}/settings/general`)}><Settings /> General</DropdownItem>}
              {can("member:read") && <DropdownItem onClick={go(`${base}/settings/team`)}><Users /> Team</DropdownItem>}
              {can("member:read") && <DropdownItem onClick={go(`${base}/settings/roles`)}><KeyRound /> Roles</DropdownItem>}
              {can("billing:read") && <DropdownItem onClick={go(`${base}/settings/billing`)}><CreditCard /> Billing</DropdownItem>}
              {can("audit:read") && <DropdownItem onClick={go(`${base}/settings/audit`)}><ScrollText /> Audit log</DropdownItem>}
              <DropdownSeparator />
              <DropdownItem onClick={go(at("usage"))}><Gauge /> Usage & limits</DropdownItem>
              {can("website:read") && <DropdownItem onClick={go(at("history"))}><History /> History</DropdownItem>}
              <DropdownItem onClick={go(at("analytics"))}><BarChart3 /> Analytics</DropdownItem>
              <DropdownItem onClick={go(at("api-monitoring"))}><Webhook /> API monitoring</DropdownItem>
              <DropdownSeparator />
            </>}
            <DropdownItem onClick={go("/account/profile")}><User /> Profile</DropdownItem>
            <DropdownItem onClick={go("/account/security")}><ShieldCheck /> Security</DropdownItem>
            <DropdownItem onClick={go("/account/security#activity")}><Activity /> Sign-in activity</DropdownItem>
            <ThemeMenuItem />
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
