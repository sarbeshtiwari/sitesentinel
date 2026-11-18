/**
 * Real-time in-app notification delivery rules for the customer web app (toast, OS notification, sound).
 * Pure functions only: no DOM, no storage, no clock reads (callers pass `now`) so they are unit-tested here and
 * used unchanged by apps/web.
 */

export const NOTIFICATION_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

const RANK: Record<NotificationSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

/** Unknown / missing severity counts as INFO (the least urgent). */
export function normalizeSeverity(s: string | null | undefined): NotificationSeverity {
  return s && s in RANK ? (s as NotificationSeverity) : "INFO";
}
export function severityAtLeast(s: string | null | undefined, min: string | null | undefined): boolean {
  return RANK[normalizeSeverity(s)] >= RANK[normalizeSeverity(min ?? "INFO")];
}

// ---------------------------------------------------------------- link validation
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A notification's link is followed only when it is a same-origin relative path inside the organisation being
 * viewed (`/o/<orgId>/…`). Absolute URLs, protocol-relative (`//host`), backslash tricks, `javascript:`, control
 * characters, dot-segments escaping the org prefix and other organisations' paths are all rejected (→ null).
 * The internal `#fragment` (worker idempotency key) is dropped.
 */
export function safeNotificationLink(link: string | null | undefined, orgId: string): string | null {
  if (typeof link !== "string" || !UUID.test(orgId)) return null;
  if (link.length > 2000 || !link.startsWith("/") || link.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(link)) return null;
  let u: URL;
  try {
    u = new URL(link, "https://app.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://app.invalid") return null;
  const prefix = `/o/${orgId.toLowerCase()}/`;
  if (!u.pathname.toLowerCase().startsWith(prefix) || u.pathname.length <= prefix.length) return null;
  return `${u.pathname}${u.search}`;
}

/** Where clicking a notification goes: its validated link, otherwise the organisation's notifications page. */
export function notificationHref(link: string | null | undefined, orgId: string): string {
  return safeNotificationLink(link, orgId) ?? `/o/${orgId}/notifications`;
}

// ---------------------------------------------------------------- presentation rules
export const TOAST_DURATION_MS = 8_000;
export const OS_NOTIFICATION_CLOSE_MS = 10_000;
export const MAX_VISIBLE_TOASTS = 3;

/** CRITICAL toasts stay until dismissed (durationMs null); others auto-close after 8 s (paused on hover/focus). */
export function toastPolicy(s: string | null | undefined): { sticky: boolean; durationMs: number | null; assertive: boolean } {
  const critical = normalizeSeverity(s) === "CRITICAL";
  return { sticky: critical, durationMs: critical ? null : TOAST_DURATION_MS, assertive: critical };
}

/** CRITICAL OS notifications require interaction; others are closed by us after 10 s. Always silent (own sound). */
export function osNotificationPolicy(s: string | null | undefined): { requireInteraction: boolean; autoCloseMs: number | null; silent: true } {
  const critical = normalizeSeverity(s) === "CRITICAL";
  return { requireInteraction: critical, autoCloseMs: critical ? null : OS_NOTIFICATION_CLOSE_MS, silent: true };
}

export function soundKind(s: string | null | undefined): "critical" | "alert" {
  return normalizeSeverity(s) === "CRITICAL" ? "critical" : "alert";
}

/** `{visible, overflow}` for a newest-first list of active toasts. */
export function visibleToasts<T>(toasts: readonly T[], max = MAX_VISIBLE_TOASTS): { visible: T[]; overflow: number } {
  return { visible: toasts.slice(0, max), overflow: Math.max(0, toasts.length - max) };
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

// ---------------------------------------------------------------- quiet hours
export interface QuietHours { start: string; end: string; tz?: string | null; exceptCritical?: boolean }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (v: string) => { const m = HHMM.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Minutes since midnight of `now` in `tz` (IANA); an invalid / missing zone falls back to UTC. */
export function minutesInZone(now: Date, tz: string | null | undefined): number {
  const fmt = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try { parts = fmt(tz || "UTC"); } catch { parts = fmt("UTC"); }
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0), m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** True inside [start, end) — windows may wrap midnight (22:00–07:00). start === end or malformed → never quiet. */
export function inQuietHours(q: QuietHours | null | undefined, now: Date): boolean {
  if (!q) return false;
  const s = minutes(q.start), e = minutes(q.end);
  if (s === null || e === null || s === e) return false;
  const t = minutesInZone(now, q.tz);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Quiet hours silence this notification (critical ones pass when `exceptCritical` is on). */
export function quietHoursSuppress(q: QuietHours | null | undefined, severity: string | null | undefined, now: Date): boolean {
  if (!inQuietHours(q, now)) return false;
  return !(q?.exceptCritical && normalizeSeverity(severity) === "CRITICAL");
}

// ---------------------------------------------------------------- delivery decision
export interface DeliveryContext {
  severity: string | null | undefined;
  /** the member's IN_APP preference (sound + quiet hours) */
  prefs: { soundEnabled: boolean; soundMinSeverity: string; quietHours?: QuietHours | null } | null | undefined;
  /** per-browser quick mute (sound only) */
  muted: boolean;
  permission: "granted" | "denied" | "default" | "unsupported";
  /** this tab is visible and has focus */
  focusedHere: boolean;
  /** some tab of the app (this or another) is visible and focused */
  anyTabFocused: boolean;
  /** this tab is the single tab elected to show OS notifications when no tab is focused */
  leader: boolean;
  /** also show OS notifications while the app is focused (per-browser setting, default off) */
  osWhenFocused: boolean;
  now: Date;
}

/**
 * Every open tab shows the toast. Exactly one tab plays the sound: the focused one, or — when no tab is focused —
 * the leader. The OS notification is shown by the leader only, when permission is granted and no tab is focused
 * (unless the member opted in to OS notifications while focused). Quiet hours silence sound and OS popups.
 */
export function deliveryDecision(c: DeliveryContext): { toast: true; sound: boolean; os: boolean } {
  const quiet = quietHoursSuppress(c.prefs?.quietHours, c.severity, c.now);
  const soundTab = c.focusedHere || (c.leader && !c.anyTabFocused);
  const sound = !quiet && !c.muted && Boolean(c.prefs?.soundEnabled) && severityAtLeast(c.severity, c.prefs?.soundMinSeverity ?? "HIGH") && soundTab;
  const os = !quiet && c.permission === "granted" && c.leader && (!c.anyTabFocused || c.osWhenFocused);
  return { toast: true, sound, os };
}

// ---------------------------------------------------------------- cursor + dedupe
export interface NotificationCursor {
  /** createdAt (ISO) of the newest notification already handled */
  since: string;
  /** ids already handled (ring buffer; equal timestamps and overlapping polls) */
  seen: string[];
  /** when the cursor was last written (ms) — older cursors are not resumed (no replay after a long absence) */
  savedAt: number;
}

export const CURSOR_SEEN_MAX = 100;
/** A stored cursor is resumed (reload, leader hand-over) only when it was written this recently. */
export const CURSOR_RESUME_MS = 10 * 60_000;
/** Never pop up anything older than this, whatever the cursor says. */
export const NOTIFICATION_MAX_AGE_MS = 15 * 60_000;

/** Parses a stored cursor (untrusted JSON from browser storage); invalid → null. */
export function parseCursor(raw: string | null | undefined): NotificationCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<NotificationCursor>;
    if (typeof v.since !== "string" || Number.isNaN(Date.parse(v.since)) || typeof v.savedAt !== "number" || !Array.isArray(v.seen)) return null;
    return { since: v.since, seen: v.seen.filter((x): x is string => typeof x === "string").slice(-CURSOR_SEEN_MAX), savedAt: v.savedAt };
  } catch {
    return null;
  }
}

/** The stored cursor when it is recent enough to resume, otherwise null (→ start from "now", replay nothing). */
export function resumableCursor(stored: NotificationCursor | null, now: number, maxIdleMs = CURSOR_RESUME_MS): NotificationCursor | null {
  return stored && now - stored.savedAt >= 0 && now - stored.savedAt <= maxIdleMs ? stored : null;
}

/** Baseline when starting fresh: the newest existing notification (or the epoch when there is none) — nothing replays. */
export function baselineCursor(newest: Array<{ id: string; createdAt: string }>, now: number): NotificationCursor {
  const top = [...newest].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return { since: top?.createdAt ?? new Date(0).toISOString(), seen: newest.map((n) => n.id).slice(0, CURSOR_SEEN_MAX), savedAt: now };
}

/**
 * New notifications in a poll result (`createdAt >= since` from the API): not seen before, not already read, not
 * older than the max age. Returned oldest first; the cursor advances to the newest createdAt.
 */
export function selectFresh<T extends { id: string; createdAt: string; read?: boolean }>(items: readonly T[], cursor: NotificationCursor, now: number, maxAgeMs = NOTIFICATION_MAX_AGE_MS): { fresh: T[]; cursor: NotificationCursor } {
  const seen = new Set(cursor.seen);
  const sinceMs = Date.parse(cursor.since);
  const fresh = items
    .filter((n) => !seen.has(n.id) && Date.parse(n.createdAt) >= sinceMs && !n.read && now - Date.parse(n.createdAt) <= maxAgeMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let since = cursor.since;
  for (const n of items) if (Date.parse(n.createdAt) > Date.parse(since)) since = n.createdAt;
  const ids = [...cursor.seen, ...items.map((n) => n.id).filter((id) => !seen.has(id))];
  return { fresh, cursor: { since, seen: [...new Set(ids)].slice(-CURSOR_SEEN_MAX), savedAt: now } };
}

// ---------------------------------------------------------------- tab leadership (localStorage lease)
export interface LeaderLease { tab: string; exp: number }
export const LEADER_LEASE_MS = 8_000;

export function parseLease(raw: string | null | undefined): LeaderLease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LeaderLease>;
    return typeof v.tab === "string" && typeof v.exp === "number" ? { tab: v.tab, exp: v.exp } : null;
  } catch {
    return null;
  }
}

/** Take (or renew) the lease when it is free, expired or already ours; otherwise follow the current holder. */
export function leaseDecision(current: LeaderLease | null, tab: string, now: number, ttlMs = LEADER_LEASE_MS): { leader: boolean; lease: LeaderLease | null } {
  if (!current || current.exp <= now || current.tab === tab) return { leader: true, lease: { tab, exp: now + ttlMs } };
  return { leader: false, lease: null };
}
