"use client";
import { Menu, Moon, PanelLeftClose, PanelLeftOpen, Sun, X } from "lucide-react";
import * as React from "react";
import { Button, cn } from "./primitives";

// ---------------------------------------------------------------- Shell
const COLLAPSE_KEY = "wim-sidebar-collapsed";
const ShellContext = React.createContext<{ collapsed: boolean }>({ collapsed: false });
/** True when the desktop sidebar is in icon-only mode (labels move into tooltips). */
export const useSidebarCollapsed = () => React.useContext(ShellContext).collapsed;

/**
 * App frame: a fixed sidebar on desktop (collapsible to icons, preference kept per viewer),
 * a slide-over drawer on mobile, a sticky topbar and the page content.
 */
export function AppShell({
  sidebar, topbar, children, banner, sidebarFooter, surface, wide,
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
  return (
    <div className="min-h-dvh" data-surface={surface}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-md">Skip to content</a>
      <ShellContext.Provider value={{ collapsed }}>
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-sidebar transition-[width] duration-200 ease-[var(--ease)] lg:flex",
            admin ? "border-white/5" : "border-border",
            collapsed ? "w-[68px]" : "w-64",
          )}
        >
          <div className="min-h-0 flex-1">{sidebar}</div>
          {sidebarFooter && !collapsed && <div className={cn("border-t px-3 py-3", admin ? "border-white/10" : "border-border")}>{sidebarFooter}</div>}
          <div className={cn("border-t p-2", admin ? "border-white/10" : "border-border")}>
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-pressed={collapsed}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-sidebar-foreground transition-colors",
                admin ? "hover:bg-white/5 hover:text-white" : "hover:bg-muted hover:text-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden /> : <PanelLeftClose className="h-4 w-4" aria-hidden />}
              {!collapsed && <span>Collapse</span>}
            </button>
          </div>
        </aside>
      </ShellContext.Provider>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-navy/50 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside
            ref={drawer}
            className={cn("absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col border-r bg-sidebar shadow-lg", admin ? "border-white/5" : "border-border")}
            onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}
          >
            <div className="absolute right-2 top-3 z-10">
              <Button variant="ghost" size="icon" className={cn("h-8 w-8", admin && "text-white hover:bg-white/10")} aria-label="Close navigation" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="min-h-0 flex-1">{sidebar}</div>
            {sidebarFooter && <div className={cn("border-t px-3 py-3", admin ? "border-white/10" : "border-border")}>{sidebarFooter}</div>}
          </aside>
        </div>
      )}

      <div className={cn("transition-[padding] duration-200 ease-[var(--ease)]", collapsed ? "lg:pl-[68px]" : "lg:pl-64")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--background)_85%,transparent)] px-3 backdrop-blur-md sm:px-5">
          <Button ref={opener} variant="ghost" size="icon" className="-ml-1 lg:hidden" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></Button>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{topbar}</div>
        </header>
        {banner}
        <main id="main" className={cn("mx-auto w-full px-4 pb-16 pt-6 sm:px-6 lg:px-8", wide ? "max-w-[1600px]" : "max-w-[1320px]")}>{children}</main>
      </div>
    </div>
  );
}

export function SidebarBrand({ children, collapsedChildren, href, LinkComponent }: { children: React.ReactNode; collapsedChildren?: React.ReactNode; href?: string; LinkComponent?: React.ElementType }) {
  const collapsed = useSidebarCollapsed();
  const content = collapsed && collapsedChildren ? collapsedChildren : children;
  const cls = cn("flex h-14 shrink-0 items-center gap-2 font-semibold", collapsed ? "justify-center px-0" : "px-4");
  if (href && LinkComponent) return <LinkComponent href={href} className={cn(cls, "rounded-md")}>{content}</LinkComponent>;
  return <div className={cls}>{content}</div>;
}

export function SidebarSection({ title, children }: { title?: string; children: React.ReactNode }) {
  const collapsed = useSidebarCollapsed();
  return (
    <div className={cn("py-2", collapsed ? "px-2" : "px-3")}>
      {title && !collapsed && <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-sidebar-foreground/70">{title}</p>}
      {title && collapsed && <div className="mx-auto mb-2 mt-1 h-px w-6 bg-border [[data-surface=admin]_&]:bg-white/10" aria-hidden />}
      <ul className="grid gap-0.5">{children}</ul>
    </div>
  );
}

export function SidebarItem({
  href, icon, active, disabled, children, badge, LinkComponent,
}: {
  href: string;
  icon?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
  LinkComponent: React.ElementType;
}) {
  const collapsed = useSidebarCollapsed();
  const cls = cn(
    "group/si relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:shrink-0",
    active
      ? "bg-sidebar-active font-medium text-primary [[data-surface=admin]_&]:text-white"
      : "text-sidebar-foreground hover:bg-muted hover:text-foreground [[data-surface=admin]_&]:hover:bg-white/5 [[data-surface=admin]_&]:hover:text-white",
    disabled && "opacity-60",
    collapsed && "justify-center px-0",
  );
  return (
    <li>
      <LinkComponent href={href} className={cls} aria-current={active ? "page" : undefined} aria-label={collapsed && typeof children === "string" ? children : undefined}>
        {active && <span aria-hidden className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary [[data-surface=admin]_&]:bg-accent" />}
        {icon}
        {collapsed ? (
          <>
            {badge && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" />}
            <span role="tooltip" className="pointer-events-none invisible absolute left-full top-1/2 z-50 ml-3 w-max -translate-y-1/2 rounded-md bg-navy px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity group-hover/si:visible group-hover/si:opacity-100 group-focus-visible/si:visible group-focus-visible/si:opacity-100">
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

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = React.useState<Theme>("system");
  React.useEffect(() => {
    try { setTheme((localStorage.getItem(THEME_KEY) as Theme | null) ?? "system"); } catch { /* ignore */ }
  }, []);
  const next = () => {
    const dark = document.documentElement.dataset.theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const t: Theme = dark ? "light" : "dark";
    setTheme(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
    document.documentElement.dataset.theme = t;
  };
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
      {aside && <div className="relative hidden overflow-hidden bg-navy lg:block">{aside}</div>}
    </div>
  );
}
