import { describe, expect, it } from "vitest";
import {
  advanceMonitorState, emptyMonitorState, evaluateHttp, HttpCheckConfig, parseHttpCheckConfig, statusMatches, uptimeFrom,
  type HttpEvaluation, type ProbeOutcome,
} from "../src/index.js";

const cfg = parseHttpCheckConfig({});
const now = new Date("2026-11-13T12:00:00Z");
const resp = (status: number, extra: Partial<NonNullable<ProbeOutcome["final"]>> = {}): ProbeOutcome =>
  ({ error: null, final: { status, contentType: "text/html", body: Buffer.from("hello SITE-OK"), truncated: false, ...extra }, https: false, tls: null });
const err = (e: string, https = false): ProbeOutcome => ({ error: e, final: null, https, tls: null });

describe("configuration", () => {
  it("safe defaults: GET /, 2xx + 401/403 expected, 15 s timeout, 5 redirects, SSL warnings 30/14/7/3", () => {
    expect(cfg).toMatchObject({ method: "GET", path: "/", expectedStatus: ["200-299", "401", "403"], timeoutMs: 15_000, maxRedirects: 5, sslWarningDays: [30, 14, 7, 3] });
  });
  it("rejects hosts, scheme-relative paths, unknown keys; an invalid stored config falls back to defaults", () => {
    for (const bad of [{ path: "https://x.example/" }, { path: "//x.example" }, { path: "x" }, { headers: {} }, { timeoutMs: 100 }, { expectedStatus: ["2xx"] }]) {
      expect(HttpCheckConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(parseHttpCheckConfig({ path: "https://evil/" })).toEqual(cfg);
  });
  it("status specs", () => {
    expect(statusMatches(204, ["200-299"])).toBe(true);
    expect(statusMatches(404, ["200-299", "404"])).toBe(true);
    expect(statusMatches(301, ["200-299"])).toBe(false);
  });
});

describe("evaluation", () => {
  it.each([
    [resp(200), "PASSED", null, true],
    [resp(204), "PASSED", null, true],
    [resp(401), "PASSED", null, true],
    [resp(403), "PASSED", null, true],
    [resp(404), "FAILED", "HTTP_404", true],
    [resp(429), "FAILED", "HTTP_429", true],
    [resp(500), "FAILED", "HTTP_500", false],
    [resp(503), "FAILED", "HTTP_503", false],
    [err("DNS_FAILURE"), "FAILED", "DNS_FAILURE", false],
    [err("NO_ADDRESSES"), "FAILED", "NO_ADDRESSES", false],
    [err("CONNECT_TIMEOUT"), "FAILED", "CONNECT_TIMEOUT", false],
    [err("RESPONSE_TIMEOUT"), "FAILED", "RESPONSE_TIMEOUT", false],
    [err("TLS_INVALID", true), "FAILED", "TLS_INVALID", false],
    [err("REDIRECT_LOOP"), "FAILED", "REDIRECT_LOOP", true],
    [err("BLOCKED_ADDRESS"), "FAILED", "BLOCKED_ADDRESS", null],
    [err("GATEWAY_UNAVAILABLE"), "INCONCLUSIVE", "GATEWAY_UNAVAILABLE", null],
    [err("EGRESS_RATE_LIMITED"), "INCONCLUSIVE", "EGRESS_RATE_LIMITED", null],
    [err("EGRESS_UNAUTHORIZED"), "INCONCLUSIVE", "EGRESS_UNAUTHORIZED", null],
  ] as const)("%j → %s %s available=%s", (p, status, kind, available) => {
    const e = evaluateHttp(p, cfg, now);
    expect([e.status, e.failureKind, e.available]).toEqual([status, kind, available]);
  });
  it("categorises failures for retries and operators", () => {
    expect(evaluateHttp(err("GATEWAY_UNAVAILABLE"), cfg, now).failureCategory).toBe("GATEWAY_INFRASTRUCTURE");
    expect(evaluateHttp(err("EGRESS_UNAUTHORIZED"), cfg, now).failureCategory).toBe("SECURITY_REJECTION");
    expect(evaluateHttp(err("BLOCKED_ADDRESS"), cfg, now).failureCategory).toBe("INVALID_CONFIGURATION");
    expect(evaluateHttp(resp(503), cfg, now).failureCategory).toBe("TARGET_TEMPORARY");
    expect(evaluateHttp(resp(404), cfg, now).failureCategory).toBe("TARGET_PERMANENT");
  });
  it("a connection-level failure while the egress canary also fails is OUR outage", () => {
    const e = evaluateHttp(err("DNS_FAILURE"), cfg, now, true);
    expect(e).toMatchObject({ status: "INCONCLUSIVE", failureKind: "INFRA_DNS_FAILURE", failureCategory: "GATEWAY_INFRASTRUCTURE", available: null });
    // an HTTP-level failure is never re-attributed
    expect(evaluateHttp(resp(500), cfg, now, true).status).toBe("FAILED");
  });
  it("5xx can be configured as an unexpected status rather than downtime", () => {
    const e = evaluateHttp(resp(500), { ...cfg, serverErrorsAreDowntime: false }, now);
    expect([e.failureKind, e.available, e.verdicts.down]).toEqual(["HTTP_500", true, "PASS"]);
  });
  it("content marker and content type", () => {
    expect(evaluateHttp(resp(200), { ...cfg, contentMarker: "SITE-OK" }, now).status).toBe("PASSED");
    expect(evaluateHttp(resp(200), { ...cfg, contentMarker: "MISSING" }, now).failureKind).toBe("CONTENT_MISMATCH");
    expect(evaluateHttp(resp(200), { ...cfg, expectedContentType: "application/json" }, now).failureKind).toBe("CONTENT_TYPE_MISMATCH");
  });
  it("SSL expiry is a separate verdict that never makes the site 'down'", () => {
    const p: ProbeOutcome = { ...resp(200), https: true, tls: { authorized: true, validTo: new Date(now.getTime() + 10 * 86_400_000).toISOString() } };
    const e = evaluateHttp(p, cfg, now);
    expect([e.status, e.available, e.verdicts.ssl_expiry, e.kinds.ssl_expiry, e.sslDaysRemaining]).toEqual(["PASSED", true, "FAIL", "EXPIRES_IN_10_DAYS", 10]);
    const far = evaluateHttp({ ...p, tls: { authorized: true, validTo: new Date(now.getTime() + 60 * 86_400_000).toISOString() } }, cfg, now);
    expect(far.verdicts.ssl_expiry).toBe("PASS");
  });
});

describe("incident state machine", () => {
  const th = () => ({ failure: 2, recovery: 2 });
  const ssl = { validTo: null, warningDays: [30, 14, 7, 3] };
  const run = (evs: HttpEvaluation[]) => {
    let s = emptyMonitorState();
    const all: string[] = [];
    evs.forEach((ev, i) => {
      const r = advanceMonitorState(s, ev, th, new Date(now.getTime() + i * 60_000), ssl, 3);
      s = r.state;
      all.push(...r.actions.map((a) => `${a.type}${"cls" in a ? `:${a.cls}` : ""}`));
    });
    return { s, all };
  };
  const up = evaluateHttp(resp(200), cfg, now);
  const down = evaluateHttp(resp(500), cfg, now);
  const infra = evaluateHttp(err("GATEWAY_UNAVAILABLE"), cfg, now);
  it("opens after the threshold, records repeats, resolves after the recovery threshold", () => {
    expect(run([down, down, down, up, up]).all).toEqual(["OPEN:down", "OCCUR:down", "RESOLVE:down"]);
  });
  it("an isolated failure opens nothing; a pass in between resets the streak", () => {
    expect(run([down, up, down, up]).all).toEqual([]);
  });
  it("infrastructure (inconclusive) results neither open, resolve nor reset; interruption is announced once", () => {
    const r = run([down, infra, infra, infra, infra, down]);
    expect(r.all).toEqual(["MONITORING_INTERRUPTED", "OPEN:down"]);
    expect(run([down, down, infra, up, infra, up]).all).toEqual(["OPEN:down", "RESOLVE:down"]);
  });
  it("an SSL threshold is announced once per certificate per threshold", () => {
    const validTo = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    const p: ProbeOutcome = { ...resp(200), https: true, tls: { authorized: true, validTo } };
    let s = emptyMonitorState();
    const acts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = advanceMonitorState(s, evaluateHttp(p, cfg, now), th, now, { validTo, warningDays: [30, 14, 7, 3] }, 3);
      s = r.state;
      acts.push(...r.actions.map((a) => (a.type === "SSL_THRESHOLD" ? `SSL:${a.threshold}` : a.type)));
    }
    expect(acts).toEqual(["OPEN", "SSL:14", "OCCUR", "OCCUR"]); // repeats are occurrences (no notification); the notice is sent once
  });
});

describe("uptime", () => {
  it("measured windows only; coverage shows how much was measured; no data → null", () => {
    expect(uptimeFrom({ up: 9, down: 1, scheduled: 12 })).toEqual({ uptimePercent: 90, measuredChecks: 10, upChecks: 9, downChecks: 1, scheduledChecks: 12, coveragePercent: 83.3 });
    expect(uptimeFrom({ up: 0, down: 0, scheduled: 5 }).uptimePercent).toBeNull();
  });
});
