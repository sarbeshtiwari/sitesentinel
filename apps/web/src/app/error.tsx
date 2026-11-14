"use client";
import { Button, LogoSymbol } from "@wim/ui";

/** Route error boundary: no stack traces or internals are shown, only a retry. */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <LogoSymbol variant="brand" className="h-12 w-12" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">An unexpected error stopped this page from loading. Try again; if it keeps happening, contact support.</p>
      <Button className="mt-6" onClick={reset}>Try again</Button>
    </main>
  );
}
