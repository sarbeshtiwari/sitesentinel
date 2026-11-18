import { describe, expect, it } from "vitest";
import {
  BrowserCheckConfig, blockingOverlay, classifyDismissControl, describeBrowserFailure, describeOverlayItem, evaluateBrowser, overlayFacts, parseBrowserCheckConfig,
  PopupConfig, scrubDialogMessage, type OverlayItem, type ViewportObservation,
} from "../src/index.js";

const cfg = parseBrowserCheckConfig({});
const perf = { lcpWarnMs: 2500, lcpCritMs: 4000, clsWarn: 0.1, clsCrit: 0.25 };
const obs = (patch: Partial<ViewportObservation> = {}): ViewportObservation => ({
  viewport: "desktop", width: 1366, height: 768, navError: null, mainStatus: 200, finalUrl: "http://a.example/", redirects: 0,
  readiness: { strategy: "load", met: true, ms: 10 }, durationMs: 900,
  rendering: { textLength: 120, meaningfulElements: 3, contentCoverage: 0.4, brokenImages: [], failedStylesheets: 0, failedFonts: 0 },
  scripts: { exceptions: [], rejections: [], consoleErrors: [] },
  network: { failed: [], httpErrors: [], requests: 10, transferBytes: 1000 },
  layout: { overflowPx: 0, offscreenText: 0, firstViewportVisible: true, obscuredControls: 0, offscreenControls: 0, navState: "VISIBLE" },
  perf: { ttfbMs: 50, fcpMs: 300, lcpMs: 900, cls: 0.01, tbtMs: 0, longTasks: 0, loadMs: 600 }, ...patch,
});
const item = (p: Partial<OverlayItem> = {}): OverlayItem => ({ kind: "COOKIE_CONSENT", selector: "#cookie", label: "We use cookies", dismissed: true, method: "REJECT", control: "Reject all", attempted: true, reason: null, blocksPage: true, ...p });

describe("popup configuration", () => {
  it("defaults keep existing configurations working: close popups, no selector", () => {
    expect(cfg.popups).toEqual({ dismiss: true, closeSelector: null });
    expect(parseBrowserCheckConfig({ path: "/x" }).popups).toEqual({ dismiss: true, closeSelector: null });
  });
  it("accepts plausible CSS selectors, rejects script URLs, markup, declaration blocks, unbalanced input and > 200 chars", () => {
    for (const ok of ["#newsletter .close", "button[aria-label='Close']", ".modal .x-btn:nth-of-type(2)", "[data-dismiss=modal]", ".modal > .close"]) expect(PopupConfig.safeParse({ closeSelector: ok }).success, ok).toBe(true);
    for (const bad of ["javascript:alert(1)", "<img src=x>", "div{color:red}", "a[href='x'", "x".repeat(201), "a;b", "a\\b", "url(x)"]) {
      expect(BrowserCheckConfig.safeParse({ popups: { closeSelector: bad } }).success, bad).toBe(false);
    }
    expect(BrowserCheckConfig.safeParse({ popups: { dismiss: "yes" } }).success).toBe(false);
    expect(BrowserCheckConfig.safeParse({ popups: { dismiss: false, extra: 1 } }).success).toBe(false);
  });
});

describe("which controls may close a popup", () => {
  it("cookie banners: reject / necessary-only is preferred; accept is never clicked", () => {
    for (const t of ["Reject all", "Reject", "Decline", "Necessary only", "Only necessary", "Deny", "Refuse", "REJECT ALL", "Alle ablehnen", "Continue without accepting"]) {
      expect(classifyDismissControl({ tag: "BUTTON", text: t }).role, t).toBe("REJECT");
    }
    for (const t of ["Accept all", "Accept", "I agree", "Allow all", "Got it", "Accept and pay", "OK"]) expect(classifyDismissControl({ tag: "BUTTON", text: t }).role, t).toBeNull();
  });
  it("close controls by text, aria-label or a close class on an icon button", () => {
    for (const t of ["Close", "✕", "×", "x", "Dismiss", "No thanks", "Not now", "Maybe later", "Skip"]) expect(classifyDismissControl({ tag: "BUTTON", text: t }).role, t).toBe("CLOSE");
    expect(classifyDismissControl({ tag: "BUTTON", text: "", ariaLabel: "Close dialog" }).role).toBe("CLOSE");
    expect(classifyDismissControl({ tag: "SPAN", text: "", className: "modal-close icon" }).role).toBe("CLOSE");
    expect(classifyDismissControl({ tag: "A", text: "Close", href: "#" }).role).toBe("CLOSE");
  });
  it("never: form submits, sign up / subscribe / buy / log in, links to another page, form fields", () => {
    expect(classifyDismissControl({ tag: "BUTTON", text: "Close", inForm: true })).toMatchObject({ role: null, reason: "submits a form" });
    expect(classifyDismissControl({ tag: "INPUT", inputType: "submit", text: "No thanks", inForm: true }).role).toBeNull();
    expect(classifyDismissControl({ tag: "BUTTON", inputType: "button", text: "Close", inForm: true }).role).toBe("CLOSE");
    for (const t of ["Sign up", "Subscribe", "Buy now", "Log in", "Register", "Subscribe and close"]) expect(classifyDismissControl({ tag: "BUTTON", text: t }).role, t).toBeNull();
    expect(classifyDismissControl({ tag: "A", text: "No thanks", href: "/offers" })).toMatchObject({ role: null, reason: "link to another page" });
    expect(classifyDismissControl({ tag: "INPUT", inputType: "email" }).role).toBeNull();
  });
  it("the configured close button skips the label check, never the hard rules", () => {
    expect(classifyDismissControl({ tag: "DIV", text: "" }, { configured: true }).role).toBe("CLOSE");
    expect(classifyDismissControl({ tag: "BUTTON", text: "Subscribe" }, { configured: true }).role).toBeNull();
    expect(classifyDismissControl({ tag: "A", text: "", href: "https://other.example/" }, { configured: true }).role).toBeNull();
    expect(classifyDismissControl({ tag: "BUTTON", text: "", inForm: true }, { configured: true }).role).toBeNull();
  });
});

describe("dialog messages", () => {
  it("are bounded and scrubbed", () => {
    const m = scrubDialogMessage(`Welcome back bob@example.com! token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk key sk_live_abcdefghijklmnopqrstuvwxyz card 4111111111111111 see https://a.example/x?session=abc ${"z ".repeat(200)}`);
    expect(m.length).toBeLessThanOrEqual(200);
    expect(m).not.toMatch(/bob@example\.com|eyJ|sk_live|4111111111111111|session=abc/);
    expect(m).toContain("[email]");
  });
});

describe("evaluation", () => {
  it("a closed cookie banner is a warning, not a failure", () => {
    const ev = evaluateBrowser([obs({ overlay: overlayFacts([item()], 0, 300) })], cfg, perf);
    expect(ev.status).toBe("PASSED");
    expect(ev.warnings).toContain(`desktop: A cookie banner covered the page on load; closed with "Reject all"`);
  });
  it("Escape / configured selector wording", () => {
    expect(describeOverlayItem(item({ kind: "MODAL", method: "ESCAPE", control: null }))).toBe("A popup dialog covered the page on load; closed with the Escape key");
    expect(describeOverlayItem(item({ kind: "MODAL", method: "CLOSE_SELECTOR", control: "✕" }))).toMatch(/configured close button/);
  });
  it("an overlay that could not be closed fails the viewport with OVERLAY_BLOCKING and suppresses CONTROLS_OBSCURED", () => {
    const stuck = item({ kind: "OVERLAY", dismissed: false, method: null, control: null, reason: "NO_SAFE_CONTROL" });
    const ev = evaluateBrowser([obs({ overlay: overlayFacts([stuck], 0, 4000), layout: { overflowPx: 0, offscreenText: 0, firstViewportVisible: true, obscuredControls: 3, navState: "VISIBLE" } })], cfg, perf);
    expect(ev.status).toBe("FAILED");
    expect(ev.failureKind).toBe("OVERLAY_BLOCKING_DESKTOP");
    expect(ev.perViewport[0]!.kinds).toEqual(["OVERLAY_BLOCKING_DESKTOP"]);
    expect(describeBrowserFailure("OVERLAY_BLOCKING_MOBILE_SMALL")).toMatch(/mobile-small viewport and could not be closed — real visitors are blocked too/);
    expect(blockingOverlay(overlayFacts([stuck], 0, 1))).toBe(stuck);
  });
  it("other layout failures still count next to a blocking overlay", () => {
    const stuck = item({ dismissed: false, reason: "NO_SAFE_CONTROL", method: null });
    const ev = evaluateBrowser([obs({ overlay: overlayFacts([stuck], 0, 1), layout: { overflowPx: 300, offscreenText: 0, firstViewportVisible: true } })], cfg, perf);
    expect(ev.perViewport[0]!.kinds).toEqual(["OVERLAY_BLOCKING_DESKTOP", "HORIZONTAL_OVERFLOW_DESKTOP"]);
  });
  it("closing switched off: warning only, never a failure", () => {
    const off = item({ dismissed: false, attempted: false, reason: "DISABLED", method: null, control: null });
    const ev = evaluateBrowser([obs({ overlay: overlayFacts([off], 0, 5) })], cfg, perf);
    expect(ev.status).toBe("PASSED");
    expect(ev.warnings.join(" ")).toMatch(/closing popups is switched off/);
  });
  it("a small banner that can't be closed without accepting, or one inside a frame, is a warning", () => {
    for (const it of [item({ dismissed: false, reason: "NO_SAFE_CONTROL", method: null, blocksPage: false }), item({ dismissed: false, reason: "IN_FRAME", method: null })]) {
      const ev = evaluateBrowser([obs({ overlay: overlayFacts([it], 0, 5) })], cfg, perf);
      expect(ev.status, it.reason!).toBe("PASSED");
      expect(ev.warnings.length).toBe(1);
    }
  });
  it("controls covered by something else still fail as CONTROLS_OBSCURED after a popup was closed", () => {
    const ev = evaluateBrowser([obs({ overlay: overlayFacts([item()], 0, 5), layout: { overflowPx: 0, offscreenText: 0, firstViewportVisible: true, obscuredControls: 2, navState: "VISIBLE" } })], cfg, perf);
    expect(ev.failureKind).toBe("CONTROLS_OBSCURED_DESKTOP");
  });
  it("JavaScript dialogs are warnings with their type and message", () => {
    const ev = evaluateBrowser([obs({ dialogs: { count: 2, items: [{ type: "alert", message: "Hello visitor" }, { type: "confirm", message: "Leave?" }] } })], cfg, perf);
    expect(ev.status).toBe("PASSED");
    expect(ev.warnings).toContain(`desktop: the page opened 2 JavaScript dialog(s) (alert, confirm) — dismissed: "Hello visitor"`);
  });
  it("results without overlay facts (older runs, nothing found) evaluate as before", () => {
    expect(evaluateBrowser([obs()], cfg, perf)).toMatchObject({ status: "PASSED", warnings: [] });
    expect(evaluateBrowser([obs({ overlay: overlayFacts([], 0, 5) })], cfg, perf).warnings).toEqual([]);
  });
});
