import * as React from "react";
import { cn } from "./primitives";

const TILE = "M7 1.5h18A5.5 5.5 0 0 1 30.5 7v9.6c0 6.3-5.6 11.6-13.4 14.1a3.6 3.6 0 0 1-2.2 0C7.1 28.2 1.5 22.9 1.5 16.6V7A5.5 5.5 0 0 1 7 1.5Z";
const EYE = "M6 14.4C9.6 8.9 22.4 8.9 26 14.4C22.4 19.9 9.6 19.9 6 14.4Z";

/**
 * SiteSentinel symbol: a sentinel shield-tile holding a watching aperture with a signal core.
 * variant "brand" follows --brand (runtime branding), "admin" is the navy control-plane mark,
 * "mono" uses currentColor only.
 */
export function LogoSymbol({ variant = "brand", className, title }: { variant?: "brand" | "admin" | "mono"; className?: string; title?: string }) {
  const id = React.useId();
  if (variant === "mono") {
    return (
      <svg viewBox="0 0 32 32" className={cn("h-7 w-7 shrink-0", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
        <mask id={id}><rect width="32" height="32" fill="#fff" /><path d={EYE} fill="#000" /><circle cx="16" cy="14.4" r="4" fill="#fff" /><circle cx="16" cy="14.4" r="1.7" fill="#000" /></mask>
        <path d={TILE} fill="currentColor" mask={`url(#${id})`} />
      </svg>
    );
  }
  const admin = variant === "admin";
  return (
    <svg viewBox="0 0 32 32" className={cn("h-7 w-7 shrink-0", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path d={TILE} style={{ fill: admin ? "#1d2639" : "var(--brand)" }} stroke={admin ? "rgb(255 255 255 / 0.12)" : "none"} />
      <path d={EYE} fill="#fff" />
      <circle cx="16" cy="14.4" r="4" style={{ fill: admin ? "var(--brand)" : "#0b1222" }} />
      <circle cx="16" cy="14.4" r="1.7" fill="#22d3ee" />
    </svg>
  );
}

/** Symbol + product name. The name comes from branding.productName so a renamed platform still reads correctly. */
export function Logo({ name = "SiteSentinel", variant = "brand", className, suffix }: { name?: string; variant?: "brand" | "admin" | "mono"; className?: string; suffix?: React.ReactNode }) {
  const split = name === "SiteSentinel";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <LogoSymbol variant={variant} />
      <span className="truncate text-[17px] leading-none tracking-[-0.02em]">
        {split ? (<><span className="font-medium">Site</span><span className="font-bold">Sentinel</span></>) : <span className="font-semibold">{name}</span>}
      </span>
      {suffix}
    </span>
  );
}
