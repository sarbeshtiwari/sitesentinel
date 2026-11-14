"use client";
import { X } from "lucide-react";
import * as React from "react";
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
      className={cn("m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-border bg-card p-0 text-foreground shadow-xl", className)}
    >
      {open && (
        <div className="grid gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <h2 id={titleId} className="text-base font-semibold">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" aria-label="Close" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
          </div>
          {children}
          {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
          <Button variant={destructive ? "danger" : "primary"} loading={loading} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------- DropdownMenu
export function DropdownMenu({ trigger, children, align = "end", label }: { trigger: React.ReactNode; children: React.ReactNode; align?: "start" | "end"; label: string }) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)} className="rounded-md">
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          onKeyDown={onMenuKey}
          onClick={() => setOpen(false)}
          className={cn("absolute z-50 mt-1 min-w-52 rounded-md border border-border bg-card p-1 shadow-lg", align === "end" ? "right-0" : "left-0")}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DropdownItem({ className, danger, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none", danger && "text-danger", className)}
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
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: React.ReactNode }>; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-md border border-border bg-muted p-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn("rounded px-3 py-1 text-sm", value === it.value ? "bg-card font-medium shadow-xs" : "text-muted-foreground hover:text-foreground")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
