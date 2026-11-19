"use client";
import type { NotificationDto } from "@wim/contracts";
import { toastPolicy, truncate, visibleToasts } from "@wim/core";
import { cn } from "@wim/ui";
import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toastStore, useOpenNotification, type ToastItem } from "@/lib/realtime-notifications";

const EMPTY: ToastItem[] = [];

const STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; bar: string; icon_: string; label: string }> = {
  CRITICAL: { icon: OctagonAlert, bar: "bg-danger", icon_: "text-danger", label: "Critical" },
  HIGH: { icon: TriangleAlert, bar: "bg-danger", icon_: "text-danger", label: "High" },
  MEDIUM: { icon: CircleAlert, bar: "bg-warning", icon_: "text-warning", label: "Medium" },
  LOW: { icon: Info, bar: "bg-info", icon_: "text-info", label: "Low" },
  INFO: { icon: Info, bar: "bg-info", icon_: "text-info", label: "Info" },
};
const RESOLVED = { icon: CircleCheck, bar: "bg-success", icon_: "text-success", label: "Resolved" };
export function severityStyle(n: Pick<NotificationDto, "severity" | "type">) {
  if (n.type === "INCIDENT_RESOLVED") return RESOLVED;
  return STYLE[n.severity ?? "INFO"] ?? STYLE.INFO!;
}
export const shortTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

function Toast({ t, onOpen }: { t: ToastItem; onOpen: (n: NotificationDto) => void }) {
  const { n } = t;
  const policy = toastPolicy(n.severity);
  const s = severityStyle(n);
  const Icon = s.icon;
  const [shown, setShown] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(policy.durationMs ?? 0);
  const started = useRef(0);

  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  // Auto-close (non-critical): counts down only while not hovered / focused.
  useEffect(() => {
    if (policy.sticky || paused) return;
    started.current = Date.now();
    const id = setTimeout(() => toastStore.dismiss(n.id), Math.max(0, remaining.current));
    return () => { clearTimeout(id); remaining.current -= Date.now() - started.current; };
  }, [paused, policy.sticky, n.id]);

  return (
    <li
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}
      className={cn(
        "pointer-events-auto relative flex w-full overflow-hidden rounded-lg bg-[#16161a] text-white shadow-lg ring-1 ring-white/10 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
      )}
    >
      <span aria-hidden className={cn("w-1 shrink-0", s.bar)} />
      <button type="button" onClick={() => onOpen(n)} className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-3 pr-1 text-left hover:bg-white/[0.04] focus-visible:outline-offset-[-2px]">
        <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-white/75" aria-hidden />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex items-center gap-2 text-xs text-[#a1a1aa]">
            <span className="font-medium">{s.label}{t.test ? " · Test" : ""}</span>
            {n.websiteName && <><span aria-hidden>·</span><span className="truncate">{n.websiteName}</span></>}
            <span aria-hidden>·</span><time dateTime={n.createdAt} className="shrink-0 tabular-nums">{shortTime(n.createdAt)}</time>
          </span>
          <span className="text-sm font-semibold leading-snug">{truncate(n.title, 120)}</span>
          {n.body && <span className="line-clamp-2 text-[13px] text-[#c4c4cc]">{truncate(n.body, 200)}</span>}
        </span>
      </button>
      <button type="button" onClick={() => toastStore.dismiss(n.id)} aria-label={`Dismiss notification: ${truncate(n.title, 60)}`}
        className="m-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#a1a1aa] hover:bg-white/10 hover:text-white">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Real-time notification toasts: top-right on wide screens, bottom on phones; newest first, max 3 visible with a
 * "+N more" link. Announced through persistent live regions (polite; assertive for CRITICAL).
 */
export function NotificationToasts({ orgId }: { orgId: string | undefined }) {
  const all = useSyncExternalStore(toastStore.subscribe, toastStore.snapshot, () => EMPTY);
  const open = useOpenNotification(orgId);
  const items = all.filter((t) => t.orgId === orgId);
  const { visible, overflow } = visibleToasts(items);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const t of items) {
      if (announced.current.has(t.n.id)) continue;
      announced.current.add(t.n.id);
      const text = `${severityStyle(t.n).label} notification: ${truncate(t.n.title, 120)}${t.n.websiteName ? `, ${t.n.websiteName}` : ""}`;
      if (toastPolicy(t.n.severity).assertive) setAssertive(text); else setPolite(text);
    }
  }, [items]);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{polite}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">{assertive}</div>
      {orgId && visible.length > 0 && (
        <section aria-label="New notifications" className="pointer-events-none fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[70] sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-16 sm:w-96">
          <ol className="flex flex-col-reverse gap-2 sm:flex-col">
            {visible.map((t) => <Toast key={t.key} t={t} onOpen={open} />)}
          </ol>
          {overflow > 0 && (
            <Link href={`/o/${orgId}/notifications`} onClick={() => toastStore.clear()}
              className="pointer-events-auto mt-2 block rounded-md border border-border bg-card px-3 py-1.5 text-center text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground">
              +{overflow} more — view all notifications
            </Link>
          )}
        </section>
      )}
    </>
  );
}
