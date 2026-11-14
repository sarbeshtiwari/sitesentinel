/**
 * Browser-side guards shared by the browser engine and the isolation tests.
 * The network (internal-only Docker networks + egress gateway) is the real boundary;
 * these close the non-network paths and reduce attack surface.
 */

/** Chromium flags: no QUIC/UDP, no non-proxied WebRTC, no background or ping traffic. */
export const BROWSER_LAUNCH_ARGS = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--no-pings",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-default-browser-check",
  "--no-first-run",
] as const;

/** Only absolute http(s) URLs with a hostname may be opened by the engine (never file:, data:, chrome:, javascript:, …). */
export function assertBrowserUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("BROWSER_URL_INVALID");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`BROWSER_SCHEME_BLOCKED:${u.protocol}`);
  if (!u.hostname || u.username || u.password) throw new Error("BROWSER_URL_INVALID");
  return u;
}

/** page.goto that refuses anything but http(s). Use for EVERY engine navigation. */
export function guardedGoto<R>(page: { goto(url: string, opts?: Record<string, unknown>): Promise<R> }, url: string, opts?: Record<string, unknown>): Promise<R> {
  try {
    assertBrowserUrl(url);
  } catch (e) {
    return Promise.reject(e);
  }
  return page.goto(url, opts);
}
