"use client";
/**
 * Real-time notification delivery in the open web app: in-app toasts, browser (OS) notifications through the Web
 * Notifications API and a Web Audio alert sound. No push service, no service worker, no third-party network calls —
 * so nothing is delivered while every tab of the app is closed (that would need Web Push, intentionally not used).
 *
 * One tab per organisation is elected leader (Web Locks, else a localStorage lease). Only the leader polls
 * `GET /orgs/:orgId/notifications?since=…&unread=true` (5 s visible / 15 s hidden, plus an immediate poll when the
 * change feed reports a notification); it hands new items to the other tabs over a BroadcastChannel. Every tab
 * shows the toast; the sound is played by the focused tab (or by the leader when no tab is focused); the OS
 * notification is shown by the leader only when no tab is focused. Rules: @wim/core notifications/realtime.
 */
import type { NotificationDto, NotificationPreferenceDto } from "@wim/contracts";
import {
  baselineCursor, deliveryDecision, leaseDecision, notificationHref, osNotificationPolicy, parseCursor, parseLease, resumableCursor,
  selectFresh, soundKind, truncate, LEADER_LEASE_MS, type NotificationCursor,
} from "@wim/core";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { get, post } from "./api";
import { useNotificationPrefs } from "./monitoring";

/** Fired by the change feed (useLiveUpdates) when it sees new notifications: the leader polls right away. */
export const NOTIFICATIONS_CHANGED_EVENT = "wim:notifications-changed";

// ---------------------------------------------------------------- safe browser storage
const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* private mode / blocked */ } },
  del(k: string) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- per-browser settings (mute, popups while focused)
const SETTINGS_EVENT = "wim:notification-settings";
const MUTE_KEY = "wim:notif:muted";
const OS_FOCUSED_KEY = "wim:notif:os-when-focused";
function subscribeSettings(cb: () => void) {
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith("wim:notif:")) cb(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SETTINGS_EVENT, cb);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(SETTINGS_EVENT, cb); };
}
function useFlag(key: string): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore(subscribeSettings, () => store.get(key) === "1", () => false);
  const set = useCallback((on: boolean) => { if (on) store.set(key, "1"); else store.del(key); window.dispatchEvent(new Event(SETTINGS_EVENT)); }, [key]);
  return [v, set];
}
/** Quick mute of notification sounds in this browser only. */
export const useSoundMuted = () => useFlag(MUTE_KEY);
/** Also show desktop notifications while the app is focused (default: the toast is enough). */
export const useOsWhenFocused = () => useFlag(OS_FOCUSED_KEY);
const flag = (key: string) => typeof window !== "undefined" && store.get(key) === "1";

// ---------------------------------------------------------------- desktop notification permission
export type DesktopPermission = "granted" | "denied" | "default" | "unsupported";
const PERMISSION_EVENT = "wim:notification-permission";
export function desktopPermission(): DesktopPermission {
  if (typeof window === "undefined" || !("Notification" in window) || !window.isSecureContext) return "unsupported";
  return Notification.permission;
}
function subscribePermission(cb: () => void) {
  window.addEventListener(PERMISSION_EVENT, cb);
  window.addEventListener("focus", cb); // changed in the browser's site settings
  let status: PermissionStatus | null = null;
  navigator.permissions?.query({ name: "notifications" as PermissionName }).then((s) => { status = s; s.addEventListener("change", cb); }).catch(() => { /* unsupported */ });
  return () => { window.removeEventListener(PERMISSION_EVENT, cb); window.removeEventListener("focus", cb); status?.removeEventListener("change", cb); };
}
/** Current permission plus a request function — call `request` only from a click (never on page load). */
export function useDesktopPermission(): { permission: DesktopPermission; request: () => Promise<DesktopPermission> } {
  const permission = useSyncExternalStore(subscribePermission, desktopPermission, () => "unsupported" as DesktopPermission);
  const request = useCallback(async () => {
    if (desktopPermission() !== "default") return desktopPermission();
    try { await Notification.requestPermission(); } catch { /* old callback-only browsers */ }
    window.dispatchEvent(new Event(PERMISSION_EVENT));
    return desktopPermission();
  }, []);
  return { permission, request };
}

// ---------------------------------------------------------------- sound (Web Audio, generated — no audio file)
let audio: AudioContext | null = null;
function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { audio ??= new Ctor(); } catch { return null; }
  return audio;
}
/** Browsers allow audio only after a user gesture: resume the context on the first interaction. */
export function installAudioUnlock(): () => void {
  const unlock = () => { const c = audioContext(); if (c && c.state !== "running") void c.resume().catch(() => {}); if (c?.state === "running") remove(); };
  const remove = () => { window.removeEventListener("pointerdown", unlock, true); window.removeEventListener("keydown", unlock, true); };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return remove;
}
/** A short two-note chime; CRITICAL gets a distinct, more insistent three-pulse tone. Silently skipped if blocked. */
export function playAlertSound(severity: string | null | undefined) {
  const c = audioContext();
  if (!c) return;
  if (c.state !== "running") {
    // Autoplay policy: only play if the context resumes promptly (never a stale chime once unlocked later).
    const asked = Date.now();
    void c.resume().then(() => { if (c.state === "running" && Date.now() - asked < 500) chime(c, severity); }).catch(() => {});
    return;
  }
  chime(c, severity);
}
function chime(c: AudioContext, severity: string | null | undefined) {
  const notes = soundKind(severity) === "critical"
    ? [{ f: 987.77, t: 0, d: 0.14 }, { f: 739.99, t: 0.18, d: 0.14 }, { f: 987.77, t: 0.36, d: 0.22 }]
    : [{ f: 880, t: 0, d: 0.12 }, { f: 1318.51, t: 0.13, d: 0.2 }];
  const peak = soundKind(severity) === "critical" ? 0.16 : 0.09;
  const t0 = c.currentTime + 0.01;
  try {
    for (const n of notes) {
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = soundKind(severity) === "critical" ? "triangle" : "sine";
      osc.frequency.setValueAtTime(n.f, t0 + n.t);
      gain.gain.setValueAtTime(0.0001, t0 + n.t);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + n.t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
      osc.connect(gain).connect(c.destination);
      osc.start(t0 + n.t);
      osc.stop(t0 + n.t + n.d + 0.02);
    }
  } catch { /* audio unavailable */ }
}

// ---------------------------------------------------------------- toast store (rendered by <NotificationToasts/>)
export interface ToastItem { key: string; orgId: string; n: NotificationDto; test?: boolean }
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
const emitToasts = () => { for (const l of toastListeners) l(); };
export const toastStore = {
  subscribe(l: () => void) { toastListeners.add(l); return () => { toastListeners.delete(l); }; },
  snapshot: () => toasts,
  push(t: ToastItem) { if (toasts.some((x) => x.n.id === t.n.id)) return; toasts = [t, ...toasts].slice(0, 50); emitToasts(); },
  dismiss(id: string) { if (!toasts.some((x) => x.n.id === id)) return; toasts = toasts.filter((x) => x.n.id !== id); emitToasts(); },
  clear() { toasts = []; emitToasts(); },
};

// ---------------------------------------------------------------- OS notification
const ICON = "/icons/icon-192.png";
const UUID_RE = /^[0-9a-f-]{36}$/i;
/** Marks a notification read (ignored for local test notifications); failures don't block navigation. */
export async function markNotificationRead(orgId: string, id: string) {
  if (!UUID_RE.test(id)) return;
  try { await post(`/orgs/${orgId}/notifications/${id}/read`); } catch { /* still navigates */ }
}
function showOsNotification(n: NotificationDto, open: (n: NotificationDto) => void) {
  if (desktopPermission() !== "granted") return;
  const p = osNotificationPolicy(n.severity);
  try {
    const os = new Notification(truncate(n.title, 120), {
      body: truncate([n.websiteName, n.body].filter(Boolean).join(" — "), 180),
      tag: n.id, icon: ICON, badge: ICON, requireInteraction: p.requireInteraction, silent: p.silent,
    });
    os.onclick = (e) => { e.preventDefault(); try { window.focus(); } catch { /* ignore */ } open(n); os.close(); };
    if (p.autoCloseMs) setTimeout(() => os.close(), p.autoCloseMs);
  } catch { /* e.g. mobile browsers that only allow notifications through a service worker */ }
}

// ---------------------------------------------------------------- focus tracking across tabs
const FOCUS_KEY = "wim:notif:focus";
const FOCUS_TTL_MS = 15_000;
const focusedHere = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
function anyTabFocused(): boolean {
  if (focusedHere()) return true;
  try {
    const v = JSON.parse(store.get(FOCUS_KEY) ?? "null") as { at?: number } | null;
    return typeof v?.at === "number" && Date.now() - v.at < FOCUS_TTL_MS;
  } catch { return false; }
}

// ---------------------------------------------------------------- the hook (mounted once in the app shell)
type Msg = { type: "new"; items: NotificationDto[] } | { type: "poke" } | { type: "dismiss"; id: string };
const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 15_000;

/** Navigate to a notification's validated link (else the notifications page), mark it read and close its toast everywhere. */
export function useOpenNotification(orgId: string | undefined) {
  const router = useRouter();
  const qc = useQueryClient();
  return useCallback((n: NotificationDto) => {
    if (!orgId) return;
    toastStore.dismiss(n.id);
    try { const ch = new BroadcastChannel(`wim-notifications:${orgId}`); ch.postMessage({ type: "dismiss", id: n.id } satisfies Msg); ch.close(); } catch { /* unsupported */ }
    router.push(notificationHref(n.link, orgId));
    void markNotificationRead(orgId, n.id).then(() => qc.invalidateQueries({ queryKey: ["org", orgId, "notifications"] }));
  }, [orgId, router, qc]);
}

/** Presents a notification in this tab according to the delivery rules (also used by "Test notification"). */
export function presentNotification(orgId: string, n: NotificationDto, opts: {
  prefs: Pick<NotificationPreferenceDto, "soundEnabled" | "soundMinSeverity" | "quietHours"> | null | undefined;
  leader: boolean; open: (n: NotificationDto) => void; test?: boolean;
}) {
  const d = opts.test
    ? { toast: true, sound: !flag(MUTE_KEY) && Boolean(opts.prefs?.soundEnabled ?? true), os: desktopPermission() === "granted" }
    : deliveryDecision({
        severity: n.severity, prefs: opts.prefs, muted: flag(MUTE_KEY), permission: desktopPermission(), focusedHere: focusedHere(),
        anyTabFocused: anyTabFocused(), leader: opts.leader, osWhenFocused: flag(OS_FOCUSED_KEY), now: new Date(),
      });
  toastStore.push({ key: `${n.id}`, orgId, n, test: opts.test });
  if (d.sound) playAlertSound(n.severity);
  if (d.os) showOsNotification(n, opts.open);
}

export function useRealtimeNotifications(orgId: string | undefined) {
  const qc = useQueryClient();
  const prefsQ = useNotificationPrefs(orgId ?? "");
  const prefs = useRef<NotificationPreferenceDto | undefined>(undefined);
  prefs.current = prefsQ.data?.find((p) => p.channel === "IN_APP");
  const open = useOpenNotification(orgId);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => installAudioUnlock(), []);

  useEffect(() => {
    if (!orgId) return;
    toastStore.clear(); // switching organisation: never show another organisation's toasts
    const tab = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const cursorKey = `wim:notif:cursor:${orgId}`;
    const leaseKey = `wim:notif:leader:${orgId}`;
    let stopped = false, leader = false, polling = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: NotificationCursor | null = null;
    const ctl = new AbortController();
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel(`wim-notifications:${orgId}`); } catch { ch = null; }

    const deliver = (items: NotificationDto[]) => {
      // Until the preferences have loaded, use the server defaults (sound on, HIGH and above, no quiet hours).
      const p = prefs.current ?? { soundEnabled: true, soundMinSeverity: "HIGH" as const, quietHours: null };
      for (const n of items) presentNotification(orgId, n, { prefs: p, leader, open: (x) => openRef.current(x) });
      if (items.length) void qc.invalidateQueries({ queryKey: ["org", orgId, "notifications"] });
    };

    const poll = async () => {
      if (stopped || !leader || polling) return;
      polling = true;
      clearTimeout(timer);
      try {
        if (!cursor) {
          // Fresh start: never replay what already exists — resume a recent shared cursor, else baseline at the newest.
          cursor = resumableCursor(parseCursor(store.get(cursorKey)), Date.now());
          if (!cursor) {
            const r = await get<{ data: NotificationDto[] }>(`/orgs/${orgId}/notifications?limit=20`, { signal: ctl.signal, noAuthRedirect: true });
            cursor = baselineCursor(r.data, Date.now());
            store.set(cursorKey, JSON.stringify(cursor));
          }
        }
        // Re-read the shared cursor: another tab may have been leader in between.
        const shared = parseCursor(store.get(cursorKey));
        if (shared && Date.parse(shared.since) >= Date.parse(cursor.since)) cursor = { ...shared, seen: [...new Set([...cursor.seen, ...shared.seen])].slice(-100) };
        const qs = new URLSearchParams({ since: cursor.since, unread: "true", limit: "20" });
        const r = await get<{ data: NotificationDto[] }>(`/orgs/${orgId}/notifications?${qs}`, { signal: ctl.signal, noAuthRedirect: true });
        const { fresh, cursor: next } = selectFresh(r.data, cursor, Date.now());
        cursor = next;
        store.set(cursorKey, JSON.stringify(cursor));
        if (fresh.length) {
          ch?.postMessage({ type: "new", items: fresh } satisfies Msg);
          deliver(fresh);
        }
        failures = 0;
      } catch {
        if (stopped) return;
        failures++;
      } finally {
        polling = false;
      }
      if (stopped || !leader) return;
      const base = document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
      timer = setTimeout(() => void poll(), failures ? Math.min(120_000, base * 2 ** failures) : base);
    };

    const becomeLeader = () => { if (stopped || leader) return; leader = true; void poll(); };
    const loseLeader = () => { leader = false; clearTimeout(timer); };

    // Leadership: Web Locks hold exactly one leader per browser profile; fallback: a renewed localStorage lease.
    let release: (() => void) | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      navigator.locks.request(`wim-notifications:${orgId}`, { signal: ctl.signal }, () => new Promise<void>((resolve) => {
        if (stopped) { resolve(); return; } // granted after unmount (React strict mode): hand the lock straight back
        release = resolve; becomeLeader();
      }))
        .catch(() => { /* aborted on unmount */ });
    } else {
      const renew = () => {
        const d = leaseDecision(parseLease(store.get(leaseKey)), tab, Date.now());
        if (d.lease) store.set(leaseKey, JSON.stringify(d.lease));
        if (d.leader) becomeLeader(); else loseLeader();
      };
      renew();
      leaseTimer = setInterval(renew, LEADER_LEASE_MS / 3);
    }

    const onMsg = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "new" && !leader && Array.isArray(m.items)) deliver(m.items);
      if (m.type === "poke" && leader) void poll();
      if (m.type === "dismiss" && typeof m.id === "string") toastStore.dismiss(m.id);
    };
    ch?.addEventListener("message", onMsg);

    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ orgId?: string }>).detail?.orgId !== orgId) return;
      if (leader) void poll(); else ch?.postMessage({ type: "poke" } satisfies Msg);
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);

    // Focus tracking: the focused tab plays the sound; the leader shows OS popups only when no tab is focused.
    const markFocus = () => {
      if (focusedHere()) store.set(FOCUS_KEY, JSON.stringify({ tab, at: Date.now() }));
      else {
        try { if ((JSON.parse(store.get(FOCUS_KEY) ?? "null") as { tab?: string } | null)?.tab === tab) store.del(FOCUS_KEY); } catch { /* ignore */ }
      }
    };
    const onVisibility = () => { markFocus(); if (leader && document.visibilityState === "visible") void poll(); };
    const focusBeat = setInterval(markFocus, 5_000);
    window.addEventListener("focus", markFocus);
    window.addEventListener("blur", markFocus);
    document.addEventListener("visibilitychange", onVisibility);
    markFocus();

    return () => {
      stopped = true;
      leader = false;
      ctl.abort();
      release?.();
      clearTimeout(timer);
      clearInterval(leaseTimer);
      clearInterval(focusBeat);
      try { if (parseLease(store.get(leaseKey))?.tab === tab) store.del(leaseKey); } catch { /* ignore */ }
      try { if ((JSON.parse(store.get(FOCUS_KEY) ?? "null") as { tab?: string } | null)?.tab === tab) store.del(FOCUS_KEY); } catch { /* ignore */ }
      ch?.removeEventListener("message", onMsg);
      ch?.close();
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", markFocus);
      window.removeEventListener("blur", markFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [orgId, qc]);
}
