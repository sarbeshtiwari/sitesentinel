"use client";
import { Button, cn, toast } from "@wim/ui";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the text and copy it manually");
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} className={className} aria-label={`${label} to clipboard`}>
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {done ? "Copied" : label}
    </Button>
  );
}

/** Read-only code/value block with a copy button. */
export function CodeBlock({ value, label, className, testId }: { value: string; label?: string; className?: string; testId?: string }) {
  return (
    <div className={cn("relative rounded-md border border-border bg-muted", className)}>
      <pre data-testid={testId} className="overflow-x-auto whitespace-pre p-3 pr-24 font-mono text-xs leading-relaxed"><code>{value}</code></pre>
      <div className="absolute right-2 top-2"><CopyButton value={value} label={label} /></div>
    </div>
  );
}

/** Label/value row used in definition-style panels. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}
