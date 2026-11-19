"use client";
import { X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Button, cn } from "./primitives";

// ---------------------------------------------------------------- Dialog (native <dialog>: focus trap, Esc, inert background)
export function Dialog({
  open, onOpenChange, title, description, children, footer, className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => onOpenChange(false)}
      onClick={(e) => { if (e.target === ref.current) onOpenChange(false); }}
      className={cn("m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-card p-0 text-foreground shadow-lg", className)}
    >
      {open && (
        <div className="grid gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <h2 id={titleId} className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-8 w-8 text-muted-foreground" aria-label="Close" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
          </div>
          {children}
          {footer && <div className="-mx-5 -mb-5 mt-1 flex flex-wrap justify-end gap-2 rounded-b-lg px-5 pb-5">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, loading, confirmDisabled, onConfirm, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
          <Button variant={destructive ? "danger" : "primary"} loading={loading} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------- DropdownMenu
/**
 * Menu button. The menu is portalled to <body> with fixed positioning so cards with overflow-hidden and
 * scrolling tables can't clip it; it opens upwards when there isn't room below and stays inside the viewport.
 */
export function DropdownMenu({ trigger, children, align = "end", label, triggerClassName }: { trigger: React.ReactNode; children: React.ReactNode; align?: "start" | "end"; label: string; triggerClassName?: string }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<React.CSSProperties | null>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const place = React.useCallback(() => {
    const t = button.current?.getBoundingClientRect();
    const m = menu.current;
    if (!t || !m) return;
    const gap = 6, pad = 8, w = m.offsetWidth, h = m.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = align === "end" ? t.right - w : t.left;
    left = Math.min(Math.max(pad, left), vw - w - pad);
    const below = vh - t.bottom - gap - pad, above = t.top - gap - pad;
    const up = h > below && above > below;
    const top = up ? Math.max(pad, t.top - gap - h) : t.bottom + gap;
    setPos({ position: "fixed", top, left, maxHeight: Math.max(120, up ? above : below) });
  }, [align]);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!menu.current?.contains(n) && !button.current?.contains(n)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    // A fixed menu would drift from its trigger: close on outside scroll, re-place on resize.
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  React.useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [open, pos]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className="relative">
      <button ref={button} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((o) => !o)} className={cn("rounded-md", triggerClassName)}>
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          onClick={() => setOpen(false)}
          style={pos ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" }}
          className="z-[60] min-w-56 overflow-y-auto rounded-lg border border-border bg-card p-1 text-foreground shadow-md"
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function DropdownItem({ className, danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn("flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px] text-foreground hover:bg-muted focus:bg-muted focus:outline-none [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground", danger && "text-danger-text [&_svg]:text-danger-text", className)}
      {...props}
    />
  );
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 text-xs text-muted-foreground">{children}</div>;
}
export function DropdownSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

// ---------------------------------------------------------------- Tabs
/**
 * Tabs. `variant="underline"` is the page-section style (Overview · Issues · Pages …: ink underline under the active tab);
 * the default "segmented" style suits small in-card choices (e.g. billing interval). Arrow keys move between tabs.
 */
export function Tabs<T extends string>({ value, onChange, items, label, variant = "segmented", className }: {
  value: T; onChange: (v: T) => void; items: Array<{ value: T; label: React.ReactNode; count?: React.ReactNode }>; label: string; variant?: "segmented" | "underline"; className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    onChange(items[next]!.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const underline = variant === "underline";
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cn(
      underline ? "flex max-w-full gap-5 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "inline-flex max-w-full overflow-x-auto rounded-md bg-muted p-0.5",
      className,
    )}>
      {items.map((it, i) => {
        const on = value === it.value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn("inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap transition-colors",
              underline
                ? cn("-mb-px border-b-2 pb-2.5 pt-1 text-sm", on ? "border-ink font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")
                : cn("rounded-[6px] px-3 py-1 text-[13px]", on ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"))}
          >
            {it.label}
            {it.count !== undefined && it.count !== null && <span className="rounded-[5px] bg-muted px-1 text-[10.5px] font-medium tabular-nums text-muted-foreground">{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Drawer (side sheet on native <dialog>)
export function Drawer({
  open, onOpenChange, title, description, children, footer, side = "right", className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  side?: "left" | "right";
  className?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => onOpenChange(false)}
      onClick={(e) => { if (e.target === ref.current) onOpenChange(false); }}
      className={cn(
        "m-0 h-dvh max-h-dvh w-[min(28rem,100vw)] max-w-none border-border bg-card p-0 text-foreground shadow-lg",
        side === "right" ? "ml-auto border-l" : "mr-auto border-r",
        className,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="grid gap-1">
              <h2 id={titleId} className="text-base font-semibold tracking-tight">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
