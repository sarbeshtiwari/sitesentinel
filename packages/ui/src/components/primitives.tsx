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
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary-solid text-primary-foreground shadow-xs hover:bg-[color-mix(in_srgb,var(--primary-solid)_88%,black)] active:bg-[color-mix(in_srgb,var(--primary-solid)_80%,black)]",
        secondary: "bg-muted text-foreground hover:bg-[color-mix(in_srgb,var(--muted)_70%,var(--border-strong))]",
        outline: "border border-border-strong bg-card text-foreground shadow-xs hover:bg-sunken",
        ghost: "text-foreground hover:bg-muted",
        danger: "bg-danger-solid text-danger-foreground shadow-xs hover:bg-[color-mix(in_srgb,var(--danger-solid)_88%,black)]",
        link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
      },
      size: { sm: "h-8 px-3 text-[13px] [&_svg]:h-3.5 [&_svg]:w-3.5", md: "h-9 px-4 [&_svg]:h-4 [&_svg]:w-4", lg: "h-10 px-5 [&_svg]:h-4 [&_svg]:w-4", icon: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4" },
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
  "w-full rounded-md border border-input bg-card text-sm text-foreground shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-subtle-foreground hover:border-[color-mix(in_srgb,var(--input)_60%,var(--foreground))] focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[color-mix(in_srgb,var(--ring)_22%,transparent)] disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-[color-mix(in_srgb,var(--danger)_20%,transparent)]";

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
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23667085' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E\")]",
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
  return <input type="checkbox" className={cn("h-4 w-4 cursor-pointer rounded border-input accent-[var(--primary)]", className)} {...props} />;
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
  return <div className={cn("rounded-lg border border-border bg-card shadow-xs", className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-border px-5 py-4", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 rounded-b-lg border-t border-border bg-sunken/60 px-5 py-3", className)} {...props} />;
}

// ---------------------------------------------------------------- Badge / status
const badgeVariants = cva("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground ring-border",
      brand: "bg-primary-soft text-primary ring-[color-mix(in_srgb,var(--primary)_22%,transparent)]",
      success: "bg-[color-mix(in_srgb,var(--success)_11%,transparent)] text-success-text ring-[color-mix(in_srgb,var(--success)_24%,transparent)]",
      warning: "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-warning-text ring-[color-mix(in_srgb,var(--warning)_26%,transparent)]",
      danger: "bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger-text ring-[color-mix(in_srgb,var(--danger)_24%,transparent)]",
      info: "bg-[color-mix(in_srgb,var(--info)_11%,transparent)] text-info-text ring-[color-mix(in_srgb,var(--info)_24%,transparent)]",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const dotTone: Record<BadgeTone, string> = {
  neutral: "bg-subtle-foreground", brand: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info",
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
const alertVariants = cva("flex gap-3 rounded-lg border px-4 py-3 text-sm", {
  variants: {
    tone: {
      info: "border-border bg-sunken",
      success: "border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_7%,transparent)]",
      warning: "border-[color-mix(in_srgb,var(--warning)_32%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)]",
      danger: "border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)]",
    },
  },
  defaultVariants: { tone: "info" },
});
const alertIcon = { info: [Info, "text-info"], success: [CheckCircle2, "text-success"], warning: [AlertTriangle, "text-warning"], danger: [XCircle, "text-danger"] } as const;
export function Alert({ className, tone, title, children, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & VariantProps<typeof alertVariants> & { title?: React.ReactNode }) {
  const [Icon, color] = alertIcon[tone ?? "info"];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} aria-hidden />
      <div className="grid min-w-0 gap-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className="text-muted-foreground [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline">{children}</div>}
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
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-card/60 px-6 py-12 text-center", className)}>
      {icon && (
        <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary ring-8 ring-[color-mix(in_srgb,var(--primary)_5%,transparent)] [&_svg]:h-5 [&_svg]:w-5" aria-hidden>
          {icon}
        </div>
      )}
      <p className="font-semibold tracking-tight">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Failed request: says what failed and offers a retry when the caller can retry. */
export function ErrorState({ title = "Something went wrong", description, onRetry, className }: { title?: string; description?: React.ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_4%,transparent)] px-6 py-10 text-center", className)}>
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger" aria-hidden>
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
    <div className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="grid min-w-0 gap-1">
        {eyebrow && <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-balance break-words text-[22px] font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
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
  const iconTone: Record<BadgeTone, string> = {
    neutral: "bg-muted text-muted-foreground", brand: "bg-primary-soft text-primary", info: "bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-info",
    success: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-success", warning: "bg-[color-mix(in_srgb,var(--warning)_13%,transparent)] text-warning",
    danger: "bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-danger",
  };
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        {icon && <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md [&_svg]:h-4 [&_svg]:w-4", iconTone[tone])} aria-hidden>{icon}</span>}
      </div>
      <p data-metric-value className="mt-1 text-[26px] font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      {hint && <div className="mt-2 text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const cls = cn("block rounded-lg border border-border bg-card px-4 py-4 shadow-xs", className);
  // Stable hook for tests and automation: [data-metric="<label>"] [data-metric-value]
  const metric = typeof label === "string" ? label : undefined;
  if (href && LinkComponent) {
    return <LinkComponent href={href} data-metric={metric} className={cn(cls, "transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-sm")}>{body}</LinkComponent>;
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
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle-foreground" aria-hidden />}
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
    <span aria-hidden className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--brand),color-mix(in_srgb,var(--brand)_55%,var(--brand-accent)))] text-xs font-semibold text-white", className)}>
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

/** Cursor pagination: previous/next with an optional position label. */
export function Pagination({ onPrev, onNext, hasPrev, hasNext, label, className }: { onPrev?: () => void; onNext?: () => void; hasPrev?: boolean; hasNext?: boolean; label?: React.ReactNode; className?: string }) {
  return (
    <nav aria-label="Pagination" className={cn("flex items-center justify-between gap-2 pt-3", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}><ChevronLeft /> Previous</Button>
        <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>Next <ChevronRight /></Button>
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
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} className={cn("border-b border-border bg-sunken/70", p.className)} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} className={cn("[&_tr:last-child]:border-0", p.className)} />;
export const TR = (p: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn("border-b border-border transition-colors hover:bg-sunken/70", p.className)} />;
export const TH = (p: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" {...p} className={cn("relative h-10 whitespace-nowrap px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:pl-4 last:pr-4", p.className)} />;
export const TD = (p: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn("px-3 py-3 align-middle first:pl-4 last:pr-4", p.className)} />;
