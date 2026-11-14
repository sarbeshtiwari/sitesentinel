"use client";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { Loader2 } from "lucide-react";
import { twMerge } from "tailwind-merge";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------- Button
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-muted text-foreground hover:bg-border",
        outline: "border border-border bg-card hover:bg-muted",
        ghost: "hover:bg-muted",
        danger: "bg-danger text-danger-foreground hover:opacity-90",
        link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-10 px-5", icon: "h-9 w-9" },
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
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs placeholder:text-muted-foreground disabled:opacity-50 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn("h-9 w-full rounded-md border border-input bg-card px-2 text-sm disabled:opacity-50", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn("w-full rounded-md border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground", className)} {...props} />;
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium leading-none", className)} {...props} />;
}

export function Checkbox({ className, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" className={cn("h-4 w-4 rounded border-input accent-[var(--primary)]", className)} {...props} />;
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
      {error && <p id={`${htmlFor}-error`} role="alert" className="text-xs text-danger">{error}</p>}
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
  return <h2 className={cn("text-base font-semibold", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 border-t border-border px-5 py-3", className)} {...props} />;
}

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      brand: "bg-[color-mix(in_srgb,var(--primary)_14%,transparent)] text-primary",
      success: "bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-success",
      warning: "bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-warning",
      danger: "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-danger",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const alertVariants = cva("flex gap-3 rounded-md border px-4 py-3 text-sm", {
  variants: {
    tone: {
      info: "border-border bg-muted",
      success: "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)]",
      warning: "border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]",
      danger: "border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]",
    },
  },
  defaultVariants: { tone: "info" },
});
export function Alert({ className, tone, title, children, ...props }: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & VariantProps<typeof alertVariants> & { title?: React.ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props}>
      <div className="grid gap-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-muted-foreground [&_a]:text-primary">{children}</div>}
      </div>
    </div>
  );
}

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
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center", className)}>
      {icon && <div className="mb-1 text-muted-foreground [&_svg]:h-8 [&_svg]:w-8" aria-hidden>{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
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
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} className={cn("border-b border-border", p.className)} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} className={cn("[&_tr:last-child]:border-0", p.className)} />;
export const TR = (p: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} className={cn("border-b border-border hover:bg-muted/50", p.className)} />;
export const TH = (p: React.ThHTMLAttributes<HTMLTableCellElement>) => <th scope="col" {...p} className={cn("h-10 px-3 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground", p.className)} />;
export const TD = (p: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cn("px-3 py-2.5 align-middle", p.className)} />;
