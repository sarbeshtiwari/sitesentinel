"use client";
import { Menu, Moon, Sun, X } from "lucide-react";
import * as React from "react";
import { Button, cn } from "./primitives";

/** App frame: fixed sidebar on desktop, slide-over on mobile. */
export function AppShell({ sidebar, topbar, children, banner }: { sidebar: React.ReactNode; topbar: React.ReactNode; children: React.ReactNode; banner?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">Skip to content</a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-sidebar lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-sidebar" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
            <div className="absolute right-2 top-2"><Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button></div>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></Button>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">{topbar}</div>
        </header>
        {banner}
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

export function SidebarBrand({ children }: { children: React.ReactNode }) {
  return <div className="flex h-14 items-center gap-2 border-b border-border px-4 font-semibold">{children}</div>;
}

export function SidebarSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="px-2 py-2">
      {title && <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>}
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
  const cls = cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm [&_svg]:h-4 [&_svg]:w-4",
    active ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    disabled && "opacity-60",
  );
  return (
    <li>
      <LinkComponent href={href} className={cls} aria-current={active ? "page" : undefined}>
        {icon}
        <span className="flex-1 truncate">{children}</span>
        {badge}
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

export function ThemeToggle() {
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
    <Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={next}>
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

/** Centered card layout for auth pages. */
export function AuthLayout({ brand, children, footer }: { brand: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">{brand}</div>
      <div className="w-full max-w-md">{children}</div>
      {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}
