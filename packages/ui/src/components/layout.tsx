"use client";
import { ChevronDown, ChevronLeft, ChevronRight, Menu, Moon, Sun, X } from "lucide-react";
import * as React from "react";
import { DropdownItem, DropdownMenu } from "./overlays";
import { Button, cn } from "./primitives";

// ---------------------------------------------------------------- Shell
const COLLAPSE_KEY = "wim-sidebar-collapsed";
const ShellContext = React.createContext<{ collapsed: boolean }>({ collapsed: false });
/** True when the desktop sidebar is in icon-only mode (labels move into tooltips). */
export const useSidebarCollapsed = () => React.useContext(ShellContext).collapsed;
const ShellNavContext = React.createContext<{ openNav: () => void }>({ openNav: () => {} });
/** Opens the mobile navigation sheet (sidebar + account), e.g. from the "You" tab of the bottom bar. */
export const useShellNav = () => React.useContext(ShellNavContext);

/**
 * App frame: a fixed sidebar on desktop (collapsible to icons, preference kept per viewer),
 * a slide-over drawer on mobile, a sticky topbar and the page content.
 */
export function AppShell({
  sidebar, topbar, children, banner, sidebarFooter, surface, wide, mobileNav,
}: {
  sidebar: React.ReactNode;
  topbar: React.ReactNode;
  children: React.ReactNode;
  banner?: React.ReactNode;
  /** Pinned under the navigation (e.g. plan or environment info). */
  sidebarFooter?: React.ReactNode;
  /** "admin" switches the chrome to the control-plane palette. */
  surface?: "customer" | "admin";
  /** Let the content use the full width (dense data screens). */
  wide?: boolean;
  /** Phone bottom tab bar (< md). Its items can open the navigation sheet through useShellNav(). */
  mobileNav?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const drawer = React.useRef<HTMLElement>(null);
  const opener = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch { /* storage unavailable */ }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* ignore */ }
      return !c;
    });
  };
  // Mobile drawer: Esc closes, focus moves in and returns to the opener, page behind does not scroll.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); opener.current?.focus(); };
  }, [open]);

  const admin = surface === "admin";
  const nav = React.useMemo(() => ({ openNav: () => setOpen(true) }), []);
  return (
    <ShellNavContext.Provider value={nav}>
    <div className="min-h-dvh" data-surface={surface}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-md">Skip to content</a>
      <ShellContext.Provider value={{ collapsed }}>
        <aside
          className={cn(
            "group/aside fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-line bg-sidebar transition-[width] duration-200 ease-[var(--ease)] lg:flex",
            collapsed ? "w-[72px]" : "w-[248px]",
          )}
        >
          <div className="min-h-0 flex-1">{sidebar}</div>
          {sidebarFooter && <div className={cn("p-3", collapsed && "px-2")}>{sidebarFooter}</div>}
          {/* Edge toggle: always reachable by keyboard, visible on hover/focus of the sidebar */}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "absolute -right-3 top-[22px] z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border shadow-sm transition-[opacity,background-color] duration-150",
              "opacity-0 focus-visible:opacity-100 group-hover/aside:opacity-100",
              admin ? "border-white/15 bg-[#1b1b20] text-[#9898a3] hover:text-white" : "border-border-strong bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronLeft className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </aside>
      </ShellContext.Provider>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-[rgb(22_22_26/0.45)] backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside
            ref={drawer}
            className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r border-sidebar-line bg-sidebar shadow-lg"
            onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}
          >
            <div className="absolute right-2 top-3 z-10">
              <Button variant="ghost" size="icon" className={cn("h-8 w-8", admin && "text-white hover:bg-white/10")} aria-label="Close navigation" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="min-h-0 flex-1">{sidebar}</div>
            {sidebarFooter && <div className="border-t border-sidebar-line p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{sidebarFooter}</div>}
          </aside>
        </div>
      )}

      <div className={cn("min-w-0 transition-[padding] duration-200 ease-[var(--ease)]", collapsed ? "lg:pl-[72px]" : "lg:pl-[248px]")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] px-3 backdrop-blur-md sm:px-5 lg:border-transparent lg:px-8">
          <Button ref={opener} variant="ghost" size="icon" className={cn("-ml-1 lg:hidden", mobileNav && "hidden md:inline-flex")} aria-label="Open navigation" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></Button>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{topbar}</div>
        </header>
        {banner}
        <main id="main" className={cn("mx-auto w-full px-4 pt-6 sm:px-6 lg:px-12 lg:pt-4", mobileNav ? "pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-16" : "pb-16", wide ? "max-w-[1600px]" : "max-w-[1320px]")}>{children}</main>
      </div>
      {mobileNav && (
        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-[color-mix(in_srgb,var(--card)_94%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
          <ul className="mx-auto grid max-w-lg auto-cols-fr grid-flow-col">{mobileNav}</ul>
        </nav>
      )}
    </div>
    </ShellNavContext.Provider>
  );
}

/** One tab of the phone bottom bar: icon over a short label. Renders a link when `href` is given, otherwise a button. */
export function MobileTab({ href, icon, label, active, badge, onClick, LinkComponent, ariaLabel }: {
  href?: string; icon: React.ReactNode; label: React.ReactNode; active?: boolean; badge?: React.ReactNode; onClick?: () => void; LinkComponent?: React.ElementType; ariaLabel?: string;
}) {
  const cls = cn(
    "relative flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] leading-none transition-colors [&_svg]:h-5 [&_svg]:w-5",
    active ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
  );
  const inner = <>{icon}<span className="max-w-full truncate px-1">{label}{badge}</span></>;
  return (
    <li className="min-w-0">
      {href && LinkComponent
        ? <LinkComponent href={href} className={cls} aria-current={active ? "page" : undefined} aria-label={ariaLabel}>{inner}</LinkComponent>
        : <button type="button" onClick={onClick} className={cn(cls, "cursor-pointer")} aria-label={ariaLabel}>{inner}</button>}
    </li>
  );
}

export function SidebarBrand({ children, collapsedChildren, href, LinkComponent }: { children: React.ReactNode; collapsedChildren?: React.ReactNode; href?: string; LinkComponent?: React.ElementType }) {
  const collapsed = useSidebarCollapsed();
  const content = collapsed && collapsedChildren ? collapsedChildren : children;
  const cls = cn("flex h-16 shrink-0 items-center gap-2 font-semibold text-sidebar-strong", collapsed ? "justify-center px-0" : "px-5");
  if (href && LinkComponent) return <LinkComponent href={href} className={cn(cls, "rounded-md")}>{content}</LinkComponent>;
  return <div className={cls}>{content}</div>;
}

/**
 * A group of navigation items. `collapsible` groups remember their open state per viewer and always open when they
 * contain the current page; in the icon rail every group is shown flat.
 */
export function SidebarSection({ title, children, collapsible, id, containsActive, defaultOpen = true }: {
  title?: string; children: React.ReactNode; collapsible?: boolean; id?: string; containsActive?: boolean; defaultOpen?: boolean;
}) {
  const collapsed = useSidebarCollapsed();
  const key = `wim-nav-${id ?? title ?? ""}`;
  const [open, setOpen] = React.useState(defaultOpen);
  const listId = React.useId();
  React.useEffect(() => {
    if (!collapsible) return;
    try { const v = localStorage.getItem(key); if (v !== null) setOpen(v === "1"); } catch { /* storage unavailable */ }
  }, [collapsible, key]);
  const shown = !collapsible || collapsed || open || containsActive;
  const toggle = () => setOpen((o) => { try { localStorage.setItem(key, o ? "0" : "1"); } catch { /* ignore */ } return !o; });
  const label = "text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground [[data-surface=admin]_&]:text-sidebar-foreground";
  return (
    <div className="px-3 pt-4">
      {title && !collapsed && (collapsible ? (
        <button type="button" onClick={toggle} aria-expanded={shown} aria-controls={listId} disabled={containsActive}
          className={cn("group/sec mb-1 flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1 disabled:cursor-default", label, "hover:text-sidebar-strong")}>
          <span>{title}</span>
          {!containsActive && <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 transition-transform duration-150", !shown && "-rotate-90")} />}
        </button>
      ) : <p className={cn("mb-1 px-2.5 py-1", label)}>{title}</p>)}
      {title && collapsed && <div className="mx-auto mb-2 h-px w-8 bg-sidebar-line" aria-hidden />}
      {shown && <ul id={listId} className="grid gap-px">{children}</ul>}
    </div>
  );
}

export function SidebarItem({
  href, icon, active, disabled, children, badge, LinkComponent, ariaLabel, compact,
}: {
  href: string;
  icon?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
  LinkComponent: React.ElementType;
  /** Accessible name when the visible text plus badge would read ambiguously (e.g. "Notifications, 3 unread"). */
  ariaLabel?: string;
  /** Smaller row for secondary lists (e.g. websites under the main navigation). */
  compact?: boolean;
}) {
  const collapsed = useSidebarCollapsed();
  const cls = cn(
    "group/si relative flex items-center gap-2.5 rounded-md px-2.5 outline-none transition-colors duration-150",
    compact ? "h-8 text-[13px]" : "h-[34px] text-sm",
    "[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:transition-colors",
    active
      ? "bg-sidebar-active font-medium text-sidebar-strong ring-1 ring-inset ring-sidebar-line [&_svg]:text-sidebar-strong"
      : "text-sidebar-foreground [&_svg]:opacity-80 hover:bg-sidebar-hover hover:text-sidebar-strong",
    "focus-visible:ring-2 focus-visible:ring-ring",
    disabled && "pointer-events-none opacity-50",
    collapsed && "mx-auto w-10 justify-center px-0",
  );
  return (
    <li>
      <LinkComponent href={href} className={cls} aria-current={active ? "page" : undefined} aria-label={ariaLabel ?? (collapsed && typeof children === "string" ? children : undefined)}>
        {icon}
        {collapsed ? (
          <>
            {badge && <span aria-hidden className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" />}
            <span role="tooltip" className="pointer-events-none invisible absolute left-full top-1/2 z-50 ml-3 w-max -translate-y-1/2 rounded-md bg-[#16161a] px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity group-hover/si:visible group-hover/si:opacity-100 group-focus-visible/si:visible group-focus-visible/si:opacity-100">
              {children}
            </span>
          </>
        ) : (
          <>
            <span className="flex-1 truncate">{children}</span>
            {badge}
          </>
        )}
      </LinkComponent>
    </li>
  );
}

/** Signed-in person at the foot of the sidebar; `menu` is the account DropdownMenu content (opens upwards). */
export function SidebarAccount({ name, detail, badge, menu, menuLabel = "Account menu", avatar }: {
  name: React.ReactNode; detail?: React.ReactNode; badge?: React.ReactNode; menu: React.ReactNode; menuLabel?: string; avatar: React.ReactNode;
}) {
  const collapsed = useSidebarCollapsed();
  return (
    <DropdownMenu label={menuLabel} align="start" triggerClassName="block w-full"
      trigger={
        <span className={cn(
          "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-hover",
          collapsed && "justify-center",
        )}>
          {avatar}
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium text-sidebar-strong">{name}</span>{badge}</span>
              {detail && <span className="block truncate text-[11.5px] text-sidebar-foreground">{detail}</span>}
            </span>
          )}
          {!collapsed && <ChevronsUpDownIcon />}
        </span>
      }
    >
      {menu}
    </DropdownMenu>
  );
}
function ChevronsUpDownIcon() {
  return <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>;
}

// ---------------------------------------------------------------- Theme
type Theme = "light" | "dark" | "system";
const THEME_KEY = "wim-theme";

/** Theme preference is a per-viewer convenience (localStorage), never a secret. */
export function applyStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY) as Theme | null;
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  } catch { /* storage unavailable */ }
}

/** Flips between light and dark (an explicit choice overrides the system preference from then on). */
export function toggleTheme() {
  let stored: Theme = "system";
  try { stored = (localStorage.getItem(THEME_KEY) as Theme | null) ?? "system"; } catch { /* ignore */ }
  const dark = document.documentElement.dataset.theme === "dark" || (stored === "system" && !document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const t: Theme = dark ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  document.documentElement.dataset.theme = t;
}

/** Theme switch as an account-menu item. */
export function ThemeMenuItem() {
  return (
    <DropdownItem onClick={toggleTheme}>
      <Moon className="[:root[data-theme=dark]_&]:hidden" /><Sun className="hidden [:root[data-theme=dark]_&]:block" />
      <span className="[:root[data-theme=dark]_&]:hidden">Dark mode</span><span className="hidden [:root[data-theme=dark]_&]:inline">Light mode</span>
    </DropdownItem>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const next = toggleTheme;
  return (
    <Button variant="ghost" size="icon" className={className} aria-label="Toggle dark mode" onClick={next}>
      <Sun className="hidden h-4 w-4 [:root[data-theme=dark]_&]:block" />
      <Moon className="h-4 w-4 [:root[data-theme=dark]_&]:hidden" />
    </Button>
  );
}

/** Sets --brand from the configured primary colour (validated hex only). */
export function useBrandColor(color: string | undefined) {
  React.useEffect(() => {
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) document.documentElement.style.setProperty("--brand", color);
  }, [color]);
}

/** Auth pages: form column plus a brand panel on large screens (panel content is supplied by the app). */
export function AuthLayout({ brand, children, footer, aside }: { brand: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-4 py-8 sm:px-8">
        <div className="flex items-center gap-2 text-lg font-semibold">{brand}</div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
        {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
      {aside && <div className="relative hidden overflow-hidden bg-[#16161a] lg:block">{aside}</div>}
    </div>
  );
}
