"use client";
import { buttonVariants, LogoSymbol } from "@wim/ui";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <LogoSymbol variant="admin" className="h-12 w-12" />
      <p className="mt-6 font-mono text-sm font-medium text-primary">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">The page you're looking for doesn't exist or has moved.</p>
      <Link href="/overview" className={buttonVariants({ className: "mt-6" })}>Go to dashboard</Link>
    </main>
  );
}
