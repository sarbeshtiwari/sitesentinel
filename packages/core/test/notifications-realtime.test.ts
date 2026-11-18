import { describe, expect, it } from "vitest";
import {
  baselineCursor, deliveryDecision, inQuietHours, leaseDecision, minutesInZone, notificationHref, osNotificationPolicy, parseCursor,
  parseLease, quietHoursSuppress, resumableCursor, safeNotificationLink, selectFresh, severityAtLeast, soundKind, toastPolicy, truncate,
  visibleToasts, CURSOR_RESUME_MS, CURSOR_SEEN_MAX, type DeliveryContext,
} from "../src/index.js";

const ORG = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("notification link validation", () => {
  it("accepts same-organisation relative paths and drops the fragment", () => {
    expect(safeNotificationLink(`/o/${ORG}/incidents?incident=abc`, ORG)).toBe(`/o/${ORG}/incidents?incident=abc`);
    expect(safeNotificationLink(`/o/${ORG}/websites/x?tab=monitoring#evt-123`, ORG)).toBe(`/o/${ORG}/websites/x?tab=monitoring`);
    expect(safeNotificationLink(`/o/${ORG.toUpperCase()}/incidents`, ORG)).toBe(`/o/${ORG.toUpperCase()}/incidents`);
  });
  it.each([
    ["absolute URL", `https://evil.example/o/${ORG}/incidents`],
    ["protocol-relative", `//evil.example/o/${ORG}/incidents`],
    ["backslash", `/\\evil.example/o/${ORG}/x`],
    ["javascript:", `javascript:alert(1)`],
    ["other organisation", `/o/${OTHER}/incidents`],
    ["dot segments escaping the org", `/o/${ORG}/../${OTHER}/incidents`],
    ["org prefix only", `/o/${ORG}/`],
    ["org id prefix of a longer segment", `/o/${ORG}x/incidents`],
    ["non-org path", `/admin/users`],
    ["control characters", `/o/${ORG}/inc\nidents`],
    ["empty", ""],
  ])("rejects %s", (_l, link) => {
    expect(safeNotificationLink(link, ORG)).toBeNull();
  });
  it("rejects null / invalid org and falls back to the notifications page", () => {
    expect(safeNotificationLink(null, ORG)).toBeNull();
    expect(safeNotificationLink(`/o/${ORG}/incidents`, "not-a-uuid")).toBeNull();
    expect(notificationHref(`https://evil.example/`, ORG)).toBe(`/o/${ORG}/notifications`);
    expect(notificationHref(`/o/${ORG}/incidents`, ORG)).toBe(`/o/${ORG}/incidents`);
  });
});

describe("severity → toast, OS notification and sound rules", () => {
  it("orders severities and treats unknown as INFO", () => {
    expect(severityAtLeast("CRITICAL", "HIGH")).toBe(true);
    expect(severityAtLeast("MEDIUM", "HIGH")).toBe(false);
    expect(severityAtLeast("HIGH", "HIGH")).toBe(true);
    expect(severityAtLeast(null, "LOW")).toBe(false);
    expect(severityAtLeast("bogus", "INFO")).toBe(true);
  });
  it("critical toasts are sticky and assertive; others auto-close after 8 s", () => {
    expect(toastPolicy("CRITICAL")).toEqual({ sticky: true, durationMs: null, assertive: true });
    expect(toastPolicy("HIGH")).toEqual({ sticky: false, durationMs: 8000, assertive: false });
    expect(toastPolicy(null).durationMs).toBe(8000);
  });
  it("critical OS notifications require interaction; others close after 10 s; always silent", () => {
    expect(osNotificationPolicy("CRITICAL")).toEqual({ requireInteraction: true, autoCloseMs: null, silent: true });
    expect(osNotificationPolicy("LOW")).toEqual({ requireInteraction: false, autoCloseMs: 10000, silent: true });
  });
  it("distinct sound for critical", () => {
    expect(soundKind("CRITICAL")).toBe("critical");
    expect(soundKind("HIGH")).toBe("alert");
  });
  it("max 3 visible toasts with an overflow count", () => {
    expect(visibleToasts([1, 2, 3, 4, 5])).toEqual({ visible: [1, 2, 3], overflow: 2 });
    expect(visibleToasts([1])).toEqual({ visible: [1], overflow: 0 });
  });
  it("truncates and collapses whitespace", () => {
    expect(truncate("a  b\n c", 10)).toBe("a b c");
    expect(truncate("abcdefghijkl", 5)).toBe("abcd…");
  });
});

describe("quiet hours", () => {
  const at = (iso: string) => new Date(iso);
  it("computes the local time in the zone (UTC fallback)", () => {
    expect(minutesInZone(at("2026-11-18T10:30:00Z"), "UTC")).toBe(630);
    expect(minutesInZone(at("2026-11-18T10:30:00Z"), "Asia/Kolkata")).toBe(16 * 60);
    expect(minutesInZone(at("2026-11-18T10:30:00Z"), "Not/AZone")).toBe(630);
  });
  it("handles windows that wrap midnight and same-day windows", () => {
    const night = { start: "22:00", end: "07:00", tz: "UTC" };
    expect(inQuietHours(night, at("2026-11-18T23:15:00Z"))).toBe(true);
    expect(inQuietHours(night, at("2026-11-18T06:59:00Z"))).toBe(true);
    expect(inQuietHours(night, at("2026-11-18T07:00:00Z"))).toBe(false);
    expect(inQuietHours(night, at("2026-11-18T12:00:00Z"))).toBe(false);
    const day = { start: "09:00", end: "17:00", tz: "UTC" };
    expect(inQuietHours(day, at("2026-11-18T09:00:00Z"))).toBe(true);
    expect(inQuietHours(day, at("2026-11-18T17:00:00Z"))).toBe(false);
  });
  it("respects the time zone", () => {
    // 23:00 in Kolkata = 17:30 UTC
    expect(inQuietHours({ start: "22:00", end: "07:00", tz: "Asia/Kolkata" }, at("2026-11-18T17:30:00Z"))).toBe(true);
    expect(inQuietHours({ start: "22:00", end: "07:00", tz: "UTC" }, at("2026-11-18T17:30:00Z"))).toBe(false);
  });
  it("malformed or empty windows are never quiet", () => {
    expect(inQuietHours(null, new Date())).toBe(false);
    expect(inQuietHours({ start: "25:00", end: "07:00" }, new Date())).toBe(false);
    expect(inQuietHours({ start: "08:00", end: "08:00" }, new Date())).toBe(false);
  });
  it("exceptCritical lets critical notifications through", () => {
    const q = { start: "00:00", end: "23:59", tz: "UTC", exceptCritical: true };
    const t = at("2026-11-18T12:00:00Z");
    expect(quietHoursSuppress(q, "CRITICAL", t)).toBe(false);
    expect(quietHoursSuppress(q, "HIGH", t)).toBe(true);
    expect(quietHoursSuppress({ ...q, exceptCritical: false }, "CRITICAL", t)).toBe(true);
  });
});

describe("delivery decision (one tab plays sound / shows the OS popup)", () => {
  const base: DeliveryContext = {
    severity: "HIGH", prefs: { soundEnabled: true, soundMinSeverity: "HIGH", quietHours: null }, muted: false, permission: "granted",
    focusedHere: false, anyTabFocused: false, leader: true, osWhenFocused: false, now: new Date("2026-11-18T12:00:00Z"),
  };
  it("background leader: sound + OS notification", () => {
    expect(deliveryDecision(base)).toEqual({ toast: true, sound: true, os: true });
  });
  it("focused tab: toast + sound, no OS popup (unless opted in)", () => {
    expect(deliveryDecision({ ...base, focusedHere: true, anyTabFocused: true })).toEqual({ toast: true, sound: true, os: false });
    expect(deliveryDecision({ ...base, focusedHere: true, anyTabFocused: true, osWhenFocused: true }).os).toBe(true);
  });
  it("leader while another tab is focused: silent toast only; follower background tab: toast only", () => {
    expect(deliveryDecision({ ...base, anyTabFocused: true })).toEqual({ toast: true, sound: false, os: false });
    expect(deliveryDecision({ ...base, leader: false })).toEqual({ toast: true, sound: false, os: false });
  });
  it("sound respects preference, minimum severity and the per-browser mute", () => {
    expect(deliveryDecision({ ...base, prefs: { ...base.prefs!, soundEnabled: false } }).sound).toBe(false);
    expect(deliveryDecision({ ...base, severity: "MEDIUM" }).sound).toBe(false);
    expect(deliveryDecision({ ...base, muted: true })).toEqual({ toast: true, sound: false, os: true });
    expect(deliveryDecision({ ...base, prefs: null }).sound).toBe(false);
  });
  it("OS popup needs granted permission", () => {
    expect(deliveryDecision({ ...base, permission: "default" }).os).toBe(false);
    expect(deliveryDecision({ ...base, permission: "unsupported" }).os).toBe(false);
  });
  it("quiet hours silence sound and OS popups except critical with exceptCritical", () => {
    const quietHours = { start: "00:00", end: "23:59", tz: "UTC", exceptCritical: true };
    const prefs = { ...base.prefs!, quietHours };
    expect(deliveryDecision({ ...base, prefs })).toEqual({ toast: true, sound: false, os: false });
    expect(deliveryDecision({ ...base, prefs, severity: "CRITICAL" })).toEqual({ toast: true, sound: true, os: true });
  });
});

describe("cursor and dedupe", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const n = (id: string, secAgo: number, read = false) => ({ id, createdAt: new Date(now - secAgo * 1000).toISOString(), read });
  it("baseline starts from the newest existing notification (nothing replays) or the epoch", () => {
    const c = baselineCursor([n("b", 10), n("a", 100)], now);
    expect(c.since).toBe(n("b", 10).createdAt);
    expect(c.seen).toEqual(["b", "a"]);
    expect(baselineCursor([], now).since).toBe("1970-01-01T00:00:00.000Z");
    expect(selectFresh([n("b", 10), n("a", 100)], c, now).fresh).toEqual([]);
  });
  it("selects unseen, unread, recent items oldest first and advances the cursor", () => {
    const c = baselineCursor([n("a", 100)], now);
    const r = selectFresh([n("d", 1), n("c", 5), n("r", 3, true), n("a", 100)], c, now);
    expect(r.fresh.map((x) => x.id)).toEqual(["c", "d"]);
    expect(r.cursor.since).toBe(n("d", 1).createdAt);
    expect(selectFresh([n("d", 1), n("c", 5)], r.cursor, now).fresh).toEqual([]); // overlapping poll: no duplicates
  });
  it("same timestamp, different ids: both delivered once", () => {
    const c = baselineCursor([n("a", 5)], now);
    const r = selectFresh([n("a", 5), n("b", 5)], c, now);
    expect(r.fresh.map((x) => x.id)).toEqual(["b"]);
  });
  it("never pops up very old notifications", () => {
    const c = baselineCursor([], now);
    expect(selectFresh([n("old", 3600), n("new", 2)], c, now).fresh.map((x) => x.id)).toEqual(["new"]);
  });
  it("bounded seen list; stored cursors parsed defensively and resumed only when recent", () => {
    const many = Array.from({ length: 150 }, (_, i) => n(`id${i}`, 1));
    expect(selectFresh(many, baselineCursor([], now), now).cursor.seen).toHaveLength(CURSOR_SEEN_MAX);
    expect(parseCursor("not json")).toBeNull();
    expect(parseCursor(JSON.stringify({ since: "nope", seen: [], savedAt: 1 }))).toBeNull();
    const c = parseCursor(JSON.stringify({ since: n("a", 1).createdAt, seen: ["a", 5], savedAt: now }));
    expect(c).toEqual({ since: n("a", 1).createdAt, seen: ["a"], savedAt: now });
    expect(resumableCursor(c, now + 1000)).toEqual(c);
    expect(resumableCursor(c, now + CURSOR_RESUME_MS + 1)).toBeNull();
    expect(resumableCursor(null, now)).toBeNull();
  });
});

describe("leader lease", () => {
  it("takes a free / expired / own lease, follows a live foreign one", () => {
    expect(leaseDecision(null, "t1", 1000)).toEqual({ leader: true, lease: { tab: "t1", exp: 9000 } });
    expect(leaseDecision({ tab: "t2", exp: 5000 }, "t1", 1000)).toEqual({ leader: false, lease: null });
    expect(leaseDecision({ tab: "t2", exp: 500 }, "t1", 1000).leader).toBe(true);
    expect(leaseDecision({ tab: "t1", exp: 5000 }, "t1", 1000).leader).toBe(true);
    expect(parseLease("{")).toBeNull();
    expect(parseLease(JSON.stringify({ tab: "t", exp: 1 }))).toEqual({ tab: "t", exp: 1 });
  });
});
