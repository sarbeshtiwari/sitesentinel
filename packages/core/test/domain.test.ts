import { describe, expect, it } from "vitest";
import {
  normalizeWebsiteUrl, originHostKey, DomainError, generateVerificationToken, isVerificationToken, generateSiteKey, isSiteKey,
  verificationInstructions, decideTrial, parseSdkConfig, installationState, defaultSettings,
} from "../src/index.js";

const n = (u: string, o = {}) => normalizeWebsiteUrl(u, o);
const code = (u: string, o = {}) => { try { n(u, o); return "OK"; } catch (e) { return (e as DomainError).code; } };

describe("domain normalization", () => {
  it.each([
    ["example.co.in", "example.co.in"],
    ["https://example.co.in", "example.co.in"],
    ["http://example.co.in/", "example.co.in"],
    ["HTTPS://WWW.Example.CO.IN/shop/?a=1#top", "example.co.in"],
    ["www.example.co.in.", "example.co.in"],
    ["https://example.co.in:443/", "example.co.in"],
    ["http://example.co.in:80", "example.co.in"],
  ])("%s → %s (scheme, www, trailing slash/dot, path, default port ignored)", (input, key) => {
    expect(n(input).identityKey).toBe(key);
  });

  it("keeps subdomains distinct and computes the registrable domain", () => {
    const s = n("https://shop.example.co.uk");
    expect(s).toMatchObject({ hostKey: "shop.example.co.uk", registrableDomain: "example.co.uk", isRoot: false });
    expect(n("blog.shop.example.co.uk").registrableDomain).toBe("example.co.uk");
    expect(n("example.co.uk").isRoot).toBe(true);
  });

  it("strips only leading alias labels and never past the registrable domain", () => {
    expect(n("www.www.example.com.au").hostKey).toBe("example.com.au");
    expect(n("shop.www.example.com.au").hostKey).toBe("shop.www.example.com.au");
    expect(n("m.example.com.au", { aliasLabels: ["www", "m"] }).hostKey).toBe("example.com.au");
    expect(n("www.co.uk.example.org.uk").hostKey).toBe("co.uk.example.org.uk");
  });

  it("converts internationalized domains to punycode and shows unicode", () => {
    const i = n("https://bücher.de");
    expect(i.hostKey).toBe("xn--bcher-kva.de");
    expect(i.displayHost).toBe("bücher.de");
    expect(n("https://BÜCHER.de").identityKey).toBe(n("xn--bcher-kva.de").identityKey);
    expect(n("пример.рф").hostKey).toMatch(/^xn--/);
  });

  it("treats PSL private suffixes as separate owners", () => {
    expect(n("alice.github.io").registrableDomain).toBe("alice.github.io");
    expect(n("bob.github.io").registrableDomain).toBe("bob.github.io");
    expect(n("myapp.vercel.app").isRoot).toBe(true);
  });

  it("applies platform-added public suffixes", () => {
    expect(n("tenant1.hosting.example.net.in", { extraSuffixes: ["hosting.example.net.in"] }).registrableDomain).toBe("tenant1.hosting.example.net.in");
  });

  it.each([
    ["", "EMPTY"],
    ["ftp://example.com.au", "UNSUPPORTED_SCHEME"],
    ["javascript:alert(1)", "INVALID_URL"],
    ["http://127.0.0.1", "IP_ADDRESS"],
    ["http://2130706433", "IP_ADDRESS"],
    ["http://0x7f.1", "IP_ADDRESS"],
    ["http://[::1]", "IP_ADDRESS"],
    ["localhost", "RESERVED_NAME"],
    ["intranet", "RESERVED_NAME"],
    ["printer.local", "RESERVED_NAME"],
    ["app.internal", "RESERVED_NAME"],
    ["site.test", "RESERVED_NAME"],
    ["example.com", "RESERVED_NAME"],
    ["https://example.com.au:8443", "NON_DEFAULT_PORT"],
    ["https://user:pw@example.com.au", "CREDENTIALS_IN_URL"],
    ["co.uk", "NO_REGISTRABLE_DOMAIN"],
    ["github.io", "NO_REGISTRABLE_DOMAIN"],
    ["exa mple.com", "INVALID_URL"],
  ])("rejects %j (%s)", (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it("allows .test only in test mode", () => {
    expect(code("shop.example.test")).toBe("RESERVED_NAME");
    expect(n("shop.example.test", { allowReservedForTests: true }).registrableDomain).toBe("example.test");
  });

  it("maps Origin headers to the same identity", () => {
    expect(originHostKey("https://www.example.co.in")).toBe("example.co.in");
    expect(originHostKey("http://shop.example.co.in:3000")).toBe("shop.example.co.in");
    expect(originHostKey("null")).toBeNull();
    expect(originHostKey("chrome-extension://abc")).toBeNull();
  });
});

describe("tokens and keys", () => {
  it("verification tokens are 256-bit, url-safe and unique", () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateVerificationToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(isVerificationToken(t)).toBe(true);
  });
  it("site keys have a fixed public format and are unguessable", () => {
    const keys = new Set(Array.from({ length: 1000 }, generateSiteKey));
    expect(keys.size).toBe(1000);
    for (const k of keys) expect(isSiteKey(k)).toBe(true);
    expect(isSiteKey("pk_short")).toBe(false);
    expect(isSiteKey("sk_" + "a".repeat(32))).toBe(false);
  });
  it("builds DNS, file and meta instructions with the configurable prefix", () => {
    const i = verificationInstructions({ token: "T".repeat(43), hostKey: "shop.example.co.in", registrableDomain: "example.co.in", prefix: "sitesentinel" });
    expect(i.dns.hostRecord.name).toBe("_sitesentinel-verification.shop.example.co.in");
    expect(i.dns.rootRecord.name).toBe("_sitesentinel-verification.example.co.in");
    expect(i.file.path).toBe("/.well-known/sitesentinel-verification.txt");
    expect(i.meta.tag).toContain('name="sitesentinel-verification"');
    expect(i.value).toBe(`sitesentinel-verification=${"T".repeat(43)}`);
  });
});

describe("trial eligibility", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  const later = new Date("2026-12-01T00:00:00Z");
  const earlier = new Date("2026-10-01T00:00:00Z");
  it.each([
    [{ trialsEnabled: true, domainTrialConsumed: false, orgTrial: null }, "ACTIVATED", true],
    [{ trialsEnabled: true, domainTrialConsumed: true, orgTrial: null }, "DOMAIN_PREVIOUSLY_TRIALED", false],
    [{ trialsEnabled: true, domainTrialConsumed: false, orgTrial: { status: "ACTIVE", endsAt: later } }, "COVERED_BY_ACTIVE_TRIAL", true],
    [{ trialsEnabled: true, domainTrialConsumed: true, orgTrial: { status: "ACTIVE", endsAt: later } }, "DOMAIN_PREVIOUSLY_TRIALED", false],
    [{ trialsEnabled: true, domainTrialConsumed: false, orgTrial: { status: "EXPIRED", endsAt: earlier } }, "ORG_TRIAL_ALREADY_USED", false],
    [{ trialsEnabled: true, domainTrialConsumed: false, orgTrial: { status: "ACTIVE", endsAt: earlier } }, "ORG_TRIAL_ALREADY_USED", false],
    [{ trialsEnabled: false, domainTrialConsumed: false, orgTrial: null }, "TRIALS_DISABLED", false],
  ] as const)("%j → %s", (facts, outcome, mark) => {
    expect(decideTrial({ ...facts, now } as never)).toEqual({ outcome, markDomainConsumed: mark });
  });
  it("defaults are 30 days, no card, at first verified website", () => {
    const d = defaultSettings();
    expect([d["trial.days"], d["trial.requiresCard"], d["trial.activation"], d["trial.enabled"]]).toEqual([30, false, "FIRST_VERIFIED_WEBSITE", true]);
  });
});

describe("SDK configuration", () => {
  it("fills privacy-preserving defaults", () => {
    expect(parseSdkConfig({})).toMatchObject({ captureErrors: true, captureApiFailures: false, requireConsent: false, respectGlobalPrivacyControl: true, maskPatterns: [] });
  });
  it("rejects unknown keys, out-of-range sampling and unsafe patterns", () => {
    expect(() => parseSdkConfig({ captureFormValues: true })).toThrow();
    expect(() => parseSdkConfig({ errorSampleRate: 1.5 })).toThrow();
    expect(() => parseSdkConfig({ maskPatterns: ["(a+)+$"] })).toThrow();
    expect(() => parseSdkConfig({ maskPatterns: ["[unclosed"] })).toThrow();
    expect(parseSdkConfig({ maskPatterns: ["^/orders/\\d+$"] }).maskPatterns).toHaveLength(1);
  });
});

describe("installation state", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const h = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);
  const base = { firstSeenAt: null, lastSeenAt: null, heartbeatCount: 0, lastInvalidAt: null, lastInvalidReason: null, keyRevoked: false };
  const st = (f: Partial<typeof base>) => installationState({ ...base, ...f }, { now, activeWindowHours: 24, minHeartbeats: 2 });
  it("derives each state", () => {
    expect(st({})).toBe("NOT_INSTALLED");
    expect(st({ firstSeenAt: h(1), lastSeenAt: h(1), heartbeatCount: 1 })).toBe("DETECTED");
    expect(st({ firstSeenAt: h(5), lastSeenAt: h(1), heartbeatCount: 3 })).toBe("ACTIVE");
    expect(st({ firstSeenAt: h(50), lastSeenAt: h(30), heartbeatCount: 9 })).toBe("INACTIVE");
    expect(st({ lastInvalidAt: h(1), lastInvalidReason: "ORIGIN_MISMATCH" })).toBe("INVALID_CONFIGURATION");
    expect(st({ lastSeenAt: h(2), heartbeatCount: 5, lastInvalidAt: h(1) })).toBe("INVALID_CONFIGURATION");
    expect(st({ lastSeenAt: h(1), heartbeatCount: 5, lastInvalidAt: h(2) })).toBe("ACTIVE");
    expect(st({ lastSeenAt: h(1), heartbeatCount: 5, lastInvalidAt: h(30) })).toBe("ACTIVE");
    expect(st({ lastSeenAt: h(1), heartbeatCount: 5, keyRevoked: true })).toBe("INVALID_CONFIGURATION");
    expect(st({ keyRevoked: true })).toBe("NOT_INSTALLED");
  });
});
