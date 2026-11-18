import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/index.js";

describe("parseTrustProxy (audit F-1)", () => {
  it("keeps the boolean forms", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
  });
  it("rejects a bare hop count (ambiguous behind Cloudflare; list the proxy address instead)", () => {
    expect(() => parseTrustProxy("1")).toThrow();
  });
  it("accepts proxy addresses and CIDRs", () => {
    expect(parseTrustProxy("10.253.10.0/24")).toEqual(["10.253.10.0/24"]);
    expect(parseTrustProxy("10.253.10.5, 127.0.0.1")).toEqual(["10.253.10.5", "127.0.0.1"]);
    expect(parseTrustProxy("::1,fd00::/8")).toEqual(["::1", "fd00::/8"]);
  });
  it("rejects anything else", () => {
    expect(() => parseTrustProxy("yes")).toThrow();
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow();
    expect(() => parseTrustProxy("nginx")).toThrow();
  });
});
