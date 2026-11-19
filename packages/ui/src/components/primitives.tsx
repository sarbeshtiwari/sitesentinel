"use client";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, XCircle } from "lucide-react";
import { twMerge } from "tailwind-merge";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------- Button
export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13.5px] font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /* ink: the one main action on a screen */
        primary: "bg-ink text-ink-foreground hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--background))] active:bg-[color-mix(in_srgb,var(--ink)_78%,var(--background))]",
        /* bordered surface button (Open site, Show the URLs) */
        secondary: "border border-border bg-card text-foreground hover:border-border-strong hover:bg-sunken",
        outline: "border border-border bg-card text-foreground hover:border-border-strong hover:bg-sunken",
        ghost: "text-foreground hover:bg-muted",
        danger: "bg-danger-solid text-danger-foreground hover:bg-[color-mix(in_srgb,var(--danger-solid)_88%,black)]",
        /* brand indigo: upgrade and brand accents only */
        brand: "bg-primary-solid text-primary-foreground hover:bg-[color-mix(in_srgb,var(--primary-solid)_88%,black)]",
        link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
      },
      size: { sm: "h-8 px-3 text-[13px] [&_svg]:h-3.5 [&_svg]:w-3.5", md: "h-9 px-3.5 [&_svg]:h-4 [&_svg]:w-4", lg: "h-10 px-5 text-sm [&_svg]:h-4 [&_svg]:w-4", icon: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, disabled, children, type = "button", ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------- Inputs
const field =
  "w-full rounded-md border border-input bg-card text-sm text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-subtle-foreground hover:border-[color-mix(in_srgb,var(--input)_60%,var(--foreground))] focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[color-mix(in_srgb,var(--ring)_22%,transparent)] disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-[color-mix(in_srgb,var(--danger)_20%,transparent)]";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, "flex h-9 px-3 py-1", className)} {...props} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        field,
        "h-9 cursor-pointer appearance-none bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat pl-3 pr-8",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b6b73' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(field, "px-3 py-2", className)} {...props} />;
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium leading-none text-foreground", className)} {...props} />;
}

export function Checkbox({ className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" className={cn("h-4 w-4 cursor-pointer rounded border-input accent-[var(--ink)]", className)} {...props} />;
}

/** Label + control + hint + error, wired with aria attributes. */
export function FormField({
  label, htmlFor, error, hint, children, className,
}: { label: React.ReactNode; htmlFor: string; error?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="flex items-center gap-1 text-xs text-danger">
          <XCircle className="h-3.5 w-3.5" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Surfaces
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-border px-5 py-4", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-[15px] font-semibold tracking-[-0.01em]", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 rounded-b-lg border-t border-border bg-sunken px-5 py-3", className)} {...props} />;
}

// ---------------------------------------------------------------- Badge / status
// Soft pill: tinted fill + darker label of the same hue (no outline). Colour = status only; brand/info for neutral accents.
const badgeVariants = cva("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      brand: "bg-primary-soft text-primary",
      success: "bg-success-soft text-success-text",
      warning: "bg-warning-soft text-warning-text",
      danger: "bg-danger-soft text-danger-text",
      info: "bg-info-soft text-info-text",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const dotTone: Record<BadgeTone, string> = {
  neutral: "bg-faint", brand: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info",
};
/** Coloured dot + text label. Colour is never the only signal: the label always carries the meaning. */
export function StatusIndicator({ tone = "neutral", label, pulse, className }: { tone?: BadgeTone; label: React.ReactNode; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
        {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dotTone[tone])} />}
        <span className={cn("relative h-2 w-2 rounded-full", dotTone[tone])} />
      </span>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------- Alert
// Callout: soft status fill, title in the status colour, body in ink. No border (fewer boxes).
const alertVariants = cva("flex gap-3 rounded-lg border border-transparent px-4 py-3 text-sm", {
  variants: {
    tone: {
      info: "bg-info-soft",
      success: "bg-success-soft",
      warning: "bg-warning-soft",
      danger: "bg-danger-soft",
    },
  },
  defaultVariants: { tone: "info" },
});
const alertIcon = { info: [Info, "text-info-text"], success: [CheckCircle2, "text-success-text"], warning: [AlertTriangle, "text-warning-text"], danger: [XCircle, "text-danger-text"] } as const;
const alertTitle = { info: "text-info-text", success: "text-success-text", warning: "text-warning-text", danger: "text-danger-text" } as const;
export function Alert({ className, tone, title, children, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & VariantProps<typeof alertVariants> & { title?: React.ReactNode }) {
  const [Icon, color] = alertIcon[tone ?? "info"];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} aria-hidden />
      <div className="grid min-w-0 gap-1">
        {title && <p className={cn("font-medium", alertTitle[tone ?? "info"])}>{title}</p>}
        {children && <div className="text-foreground/80 [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline">{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Loading / empty / error
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-6 py-12 text-center", className)}>
      {icon && (
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden>
          {icon}
        </div>
      )}
      <p className="font-semibold tracking-[-0.01em]">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Failed request: says what failed and offers a retry when the caller can retry. */
export function ErrorState({ title = "Something went wrong", description, onRetry, className }: { title?: string; description?: React.ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 py-10 text-center", className)}>
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-danger-soft text-danger-text" aria-hidden>
        <AlertTriangle className="h-5 w-5" />
      </div>
      <p className="font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {onRetry && <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- Page structure
export function PageHeader({ title, description, actions, className, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string; eyebrow?: React.ReactNode }) {
  return (
    <div className={cn("mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="grid min-w-0 gap-1.5">
        {eyebrow && <div className="text-[13px] text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-balance break-words text-[24px] font-semibold leading-[1.15] tracking-[-0.022em] sm:text-[28px]">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return <MetricCard label={label} value={value} hint={hint} />;
}

/** Headline number with an optional icon, status tone and supporting line. Values must come from real data. */
export function MetricCard({
  label, value, hint, icon, tone = "neutral", href, LinkComponent, className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: BadgeTone;
  href?: string;
  LinkComponent?: React.ElementType;
  className?: string;
}) {
  // Colour means status only: the value takes the status colour; brand/info/neutral metrics stay ink.
  const valueTone: Record<BadgeTone, string> = { neutral: "", brand: "", info: "", success: "text-success-text", warning: "text-warning-text", danger: "text-danger-text" };
  const iconTone: Record<BadgeTone, string> = { neutral: "text-faint", brand: "text-faint", info: "text-faint", success: "text-success", warning: "text-warning", danger: "text-danger" };
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        {icon && <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4", iconTone[tone])} aria-hidden>{icon}</span>}
      </div>
      <p data-metric-value className={cn("mt-1.5 text-[26px] font-medium leading-none tracking-[-0.02em] tabular-nums", valueTone[tone])}>{value}</p>
      {hint && <div className="mt-2 text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const cls = cn("block rounded-lg border border-border bg-card px-5 py-4", className);
  // Stable hook for tests and automation: [data-metric="<label>"] [data-metric-value]
  const metric = typeof label === "string" ? label : undefined;
  if (href && LinkComponent) {
    return <LinkComponent href={href} data-metric={metric} className={cn(cls, "transition-[border-color] duration-150 hover:border-border-strong")}>{body}</LinkComponent>;
  }
  return <div data-metric={metric} className={cls}>{body}</div>;
}

/** Breadcrumb trail; the last item is the current page. */
export function Breadcrumbs({ items, LinkComponent, className }: { items: Array<{ label: React.ReactNode; href?: string }>; LinkComponent: React.ElementType; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className={cn("flex min-w-0 items-center gap-1", !last && "hidden sm:flex")}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />}
              {it.href && !last ? (
                <LinkComponent href={it.href} className="truncate rounded px-1 hover:text-foreground">{it.label}</LinkComponent>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate px-1", last && "font-medium text-foreground")}>{it.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Lightweight CSS tooltip: shown on hover and keyboard focus; the trigger keeps its own accessible name. */
export function Tooltip({ content, children, side = "top", className }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "right" | "bottom"; className?: string }) {
  const id = React.useId();
  const pos = { top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2", bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2", right: "left-full top-1/2 ml-2 -translate-y-1/2" }[side];
  return (
    <span className={cn("group/tt relative inline-flex", className)} aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute z-50 w-max max-w-64 rounded-md bg-navy px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity duration-100",
          "group-hover/tt:visible group-hover/tt:opacity-100 group-focus-within/tt:visible group-focus-within/tt:opacity-100",
          pos,
        )}
      >
        {content}
      </span>
    </span>
  );
}

export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  const initials = (name ?? "?").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("") || "?";
  return (
    <span aria-hidden className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-ink-foreground", className)}>
      {initials}
    </span>
  );
}

/** Row of filters above a list; wraps on small screens. */
export function FilterBar({ children, className, trailing }: { children: React.ReactNode; className?: string; trailing?: React.ReactNode }) {
  return (
    <div className={cn("mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between", className)}>
      <div className="flex flex-wrap items-end gap-2 [&>*]:min-w-36">{children}</div>
      {trailing && <div className="flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

/**
 * Pagination. Cursor mode: previous/next with an optional position label. Numbered mode (pass `page`, `pages` and
 * `onPage`): previous / numbered pages (first, last and a window around the current one, gaps shown as …) / next.
 * `trailing` sits before the buttons (e.g. a page-size select).
 */
export function Pagination({ onPrev, onNext, hasPrev, hasNext, label, className, page, pages, onPage, trailing }: {
  onPrev?: () => void; onNext?: () => void; hasPrev?: boolean; hasNext?: boolean; label?: React.ReactNode; className?: string;
  page?: number; pages?: number; onPage?: (page: number) => void; trailing?: React.ReactNode;
}) {
  const numbered = page !== undefined && pages !== undefined && onPage !== undefined;
  const prev = numbered ? () => onPage!(page! - 1) : onPrev;
  const next = numbered ? () => onPage!(page! + 1) : onNext;
  const canPrev = numbered ? page! > 1 : hasPrev;
  const canNext = numbered ? page! < pages! : hasNext;
  const items: Array<number | "gap"> = [];
  if (numbered) {
    for (let i = 1; i <= pages!; i++) {
      if (i === 1 || i === pages || Math.abs(i - page!) <= 1) items.push(i);
      else if (items[items.length - 1] !== "gap") items.push("gap");
    }
  }
  return (
    <nav aria-label="Pagination" className={cn("flex flex-wrap items-center justify-between gap-2 pt-3", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {trailing}
        <Button variant="outline" size="sm" className={numbered ? "h-8 min-w-8 px-2" : undefined} disabled={!canPrev} onClick={prev} aria-label={numbered ? "Previous page" : undefined}><ChevronLeft /> <span className={numbered ? "sr-only" : undefined}>Previous</span></Button>
        {numbered && items.map((it, i) => it === "gap"
          ? <span key={`g${i}`} aria-hidden className="px-1 text-xs text-muted-foreground">…</span>
          : <Button key={it} variant={it === page ? "primary" : "ghost"} size="sm" className={cn("h-8 min-w-8 px-2 tabular-nums", Math.abs(it - page!) > 0 && it !== 1 && it !== pages && "hidden sm:inline-flex")} aria-label={`Page ${it}`} aria-current={it === page ? "page" : undefined} onClick={() => it !== page && onPage!(it)}>{it}</Button>)}
        <Button variant="outline" size="sm" className={numbered ? "h-8 min-w-8 px-2" : undefined} disabled={!canNext} onClick={next} aria-label={numbered ? "Next page" : undefined}><span className={numbered ? "sr-only" : undefined}>Next</span> <ChevronRight /></Button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- Table
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} className={cn("border-b border-border bg-sunken", p.className)} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} className={cn("[&_tr:last-child]:border-0", p.className)} />;
export const TR = (p: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn("border-b border-border transition-colors hover:bg-sunken/60", p.className)} />;
export const TH = (p: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" {...p} className={cn("relative h-9 whitespace-nowrap px-3 text-left align-middle text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground first:pl-4 last:pr-4", p.className)} />;
export const TD = (p: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn("px-3 py-3 align-middle first:pl-4 last:pr-4", p.className)} />;

// ---------------------------------------------------------------- Redesign additions (additive; design/reference u5bjS)

/** Status pill: dot + label on a soft fill. Colour only means status: success = fine, warning = needs attention, danger = broken. */
export function StatusPill({ tone = "neutral", children, className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <Badge tone={tone} className={className} {...props}>
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotTone[tone])} />
      {children}
    </Badge>
  );
}

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
const severityCls: Record<Severity, string> = {
  CRITICAL: "bg-danger-solid text-danger-foreground",
  HIGH: "bg-danger-soft text-danger-text",
  MEDIUM: "bg-warning-soft text-warning-text",
  LOW: "bg-muted text-muted-foreground",
  INFO: "bg-info-soft text-info-text",
};
/** Compact severity chip (radius 6). Unknown values render neutral. */
export function SeverityBadge({ severity, children, className }: { severity: string; children?: React.ReactNode; className?: string }) {
  const key = severity.toUpperCase() as Severity;
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-px text-[11px] font-medium", severityCls[key] ?? severityCls.LOW, className)}>
      {children ?? key.charAt(0) + key.slice(1).toLowerCase()}
    </span>
  );
}

/** On/off switch (button role="switch"). Label it with aria-label or aria-labelledby. */
export const Switch = React.forwardRef<HTMLButtonElement, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked: boolean; onCheckedChange?: (checked: boolean) => void }>(
  function Switch({ checked, onCheckedChange, className, disabled, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-success" : "bg-border-strong",
          className,
        )}
        {...props}
      >
        <span aria-hidden className={cn("inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
    );
  },
);

/** Segmented control (range pickers, view switches): a sunken track with the selected segment raised. */
export function SegmentedControl<T extends string>({ value, onChange, items, label, className, size = "md" }: {
  value: T; onChange: (v: T) => void; items: Array<{ value: T; label: React.ReactNode }>; label: string; className?: string; size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full overflow-x-auto rounded-md bg-muted p-0.5", className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button key={it.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(it.value)}
            className={cn("cursor-pointer whitespace-nowrap rounded-[6px] font-medium transition-colors", size === "sm" ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-[13px]",
              on ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** Filter chip: pill toggle with an optional count. Selected chips are ink. */
export function FilterChip({ selected, count, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; count?: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} className={cn(
      "inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors",
      selected ? "border-ink bg-ink text-ink-foreground" : "border-border bg-card text-foreground hover:border-border-strong",
      className,
    )} {...props}>
      {children}
      {count !== undefined && count !== null && <span className={cn("tabular-nums text-[11px]", selected ? "opacity-70" : "text-muted-foreground")}>{count}</span>}
    </button>
  );
}

/** Small count next to a tab or nav label. */
export function CountBadge({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: "neutral" | "warning" | "danger"; className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 text-[10.5px] font-medium tabular-nums",
      tone === "warning" ? "bg-warning-soft text-warning-text" : tone === "danger" ? "bg-danger-soft text-danger-text" : "bg-muted text-muted-foreground", className)}>
      {children}
    </span>
  );
}

/** Wizard steps: done steps get a check, the current step is ink, later steps are muted. */
export function Stepper({ steps, current, className }: { steps: React.ReactNode[]; current: number; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]", className)}>
      {steps.map((s, i) => {
        const done = i < current, now = i === current;
        return (
          <li key={i} aria-current={now ? "step" : undefined} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="h-px w-6 bg-border-strong sm:w-10" />}
            <span aria-hidden className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
              done ? "bg-success text-white" : now ? "bg-ink text-ink-foreground" : "bg-muted text-muted-foreground")}>
              {done ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
            </span>
            <span className={cn(now ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground")}>{s}{done && <span className="sr-only"> (done)</span>}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Dark code panel for snippets (monospace); `action` sits in the header (e.g. a copy button). */
export function CodeBlock({ title, action, children, className }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg bg-[#16161a] text-[#ededf0] ring-1 ring-inset ring-white/10", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 text-[11px] text-[#a1a1aa]">
          <span className="truncate">{title}</span>{action}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed">{children}</pre>
    </div>
  );
}
