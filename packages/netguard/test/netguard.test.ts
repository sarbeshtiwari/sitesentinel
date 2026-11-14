import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDnsServer, startSiteServer, type FixtureDns, type FixtureSite } from "@wim/test-fixtures";
import { createDnsClient, isPublicAddress, resolvePublic, safeFetch, NetguardError, type DnsClient } from "../src/index.js";

let dns: FixtureDns;
let site: FixtureSite;
let client: DnsClient;
const testPolicy = () => ({ allowLoopbackForTests: true, loopbackPortForTests: site.port });
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof NetguardError ? e.code : `OTHER:${(e as Error).message}`; } };

beforeAll(async () => {
  dns = await startDnsServer();
  site = await startSiteServer();
  client = createDnsClient([dns.server], 2000);
});
afterAll(async () => { await dns.close(); await site.close(); });

describe("address policy", () => {
  it.each([
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.1.2.3", "0.0.0.0",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.7", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1", "64:ff9b::a00:1", "::ffff:10.0.0.1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "2002:a00:1::1", "100::1",
    "::a00:1", "::ffff:10", "::ffff:0:a00:1", "fec0::1", "3fff::1", "4000::1", "e000::1",
  ])("denies %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "13.235.0.1", "2606:4700:4700::1111", "2404:6800:4009:80b::200e"])("allows public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it("loopback is only reachable with the explicit test policy, other ranges never", () => {
    expect(isPublicAddress("127.0.0.1", { allowLoopbackForTests: true })).toBe(true);
    expect(isPublicAddress("10.0.0.1", { allowLoopbackForTests: true })).toBe(false);
    expect(isPublicAddress("169.254.169.254", { allowLoopbackForTests: true })).toBe(false);
  });
  it("rejects non-IP strings", () => {
    expect(isPublicAddress("localhost")).toBe(false);
  });
});

describe("DNS resolution checks (real DNS server)", () => {
  it("blocks a host resolving to the cloud metadata address", async () => {
    dns.setA("metadata.attacker.test", ["169.254.169.254"]);
    expect(await code(resolvePublic("metadata.attacker.test", client, testPolicy()))).toBe("BLOCKED_ADDRESS");
  });
  it("blocks when ANY record is private (mixed public/private answer)", async () => {
    dns.setA("mixed.attacker.test", ["8.8.8.8", "10.0.0.5"]);
    expect(await code(resolvePublic("mixed.attacker.test", client))).toBe("BLOCKED_ADDRESS");
  });
  it("blocks loopback without the test policy", async () => {
    dns.setA("loop.attacker.test", ["127.0.0.1"]);
    expect(await code(resolvePublic("loop.attacker.test", client))).toBe("BLOCKED_ADDRESS");
  });
  it("reports unresolvable hosts", async () => {
    expect(await code(resolvePublic("nope.attacker.test", client))).toBe("NO_ADDRESSES");
  });
  it("reads chunked TXT records per resolver", async () => {
    const long = "x".repeat(300);
    dns.setTxt("_v.example.test", [long, "short"]);
    const out = await client.txt("_v.example.test");
    expect(out[0]!.records).toEqual([long, "short"]);
  });
});

describe("safeFetch", () => {
  it("fetches a public (test-mapped) site and pins the validated address", async () => {
    dns.setA("ok.example.test", ["127.0.0.1"]);
    site.route("ok.example.test", "/hello", { body: "hi", type: "text/plain" });
    const r = await safeFetch("http://ok.example.test/hello", { dns: client, policy: testPolicy() });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("hi");
    expect(r.chain[0]!.address).toBe("127.0.0.1");
  });

  it("DNS rebinding: an answer that flips to a private address after the first lookup can never be connected to", async () => {
    let n = 0;
    // First answer allowed (loopback under the test policy), every later answer is the metadata IP.
    dns.setA("rebind.attacker.test", () => (n++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]));
    site.route("rebind.attacker.test", "/", { status: 302, body: "", headers: { location: "http://rebind.attacker.test/again" } });
    const outcome = await code(safeFetch("http://rebind.attacker.test/", { dns: client, policy: testPolicy() }));
    // The redirect forces a second resolution, which now answers 169.254.169.254: blocked before connecting.
    expect(outcome).toBe("BLOCKED_ADDRESS");
    const hops = site.hits.filter((h) => h.host === "rebind.attacker.test");
    expect(hops.map((h) => h.path)).toEqual(["/"]);
  });

  it("re-validates redirect targets (metadata IP, private hostname, IP literal)", async () => {
    dns.setA("redir.example.test", ["127.0.0.1"]);
    dns.setA("internal.attacker.test", ["10.1.2.3"]);
    site.route("redir.example.test", "/meta", { status: 302, body: "", headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    site.route("redir.example.test", "/private", { status: 301, body: "", headers: { location: "http://internal.attacker.test/" } });
    site.route("redir.example.test", "/port", { status: 302, body: "", headers: { location: "http://redir.example.test:6379/" } });
    site.route("redir.example.test", "/file", { status: 302, body: "", headers: { location: "file:///etc/passwd" } });
    expect(await code(safeFetch("http://redir.example.test/meta", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch("http://redir.example.test/private", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch("http://redir.example.test/port", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_PORT");
    expect(await code(safeFetch("http://redir.example.test/file", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_SCHEME");
  });

  it("enforces the caller's redirect rule and the redirect limit", async () => {
    dns.setA("hop.example.test", ["127.0.0.1"]);
    dns.setA("elsewhere.example.test", ["127.0.0.1"]);
    site.route("hop.example.test", "/away", { status: 302, body: "", headers: { location: "http://elsewhere.example.test/" } });
    site.route("hop.example.test", "/loop", { status: 302, body: "", headers: { location: "http://hop.example.test/loop" } });
    const sameHost = (a: URL, b: URL) => a.hostname === b.hostname;
    expect(await code(safeFetch("http://hop.example.test/away", { dns: client, policy: testPolicy(), allowRedirect: sameHost }))).toBe("REDIRECT_NOT_ALLOWED");
    expect(await code(safeFetch("http://hop.example.test/loop", { dns: client, policy: testPolicy(), maxRedirects: 3 }))).toBe("TOO_MANY_REDIRECTS");
  });

  it("rejects IP-literal URLs, odd ports and credentials up front", async () => {
    expect(await code(safeFetch("http://127.0.0.1/", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch("http://[::1]/", { dns: client }))).toBe("BLOCKED_ADDRESS");
    expect(await code(safeFetch("http://ok.example.test:8080/", { dns: client, policy: testPolicy() }))).toBe("BLOCKED_PORT");
    expect(await code(safeFetch("http://u:p@ok.example.test/", { dns: client, policy: testPolicy() }))).toBe("INVALID_URL");
    expect(await code(safeFetch("gopher://ok.example.test/", { dns: client }))).toBe("BLOCKED_SCHEME");
  });

  it("truncates large bodies and times out slow servers", async () => {
    dns.setA("big.example.test", ["127.0.0.1"]);
    site.route("big.example.test", "/big", { body: "a".repeat(100_000), type: "text/plain" });
    const r = await safeFetch("http://big.example.test/big", { dns: client, policy: testPolicy(), maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
    dns.setA("slow.example.test", ["127.0.0.1"]);
    site.route("slow.example.test", "/slow", (_req, res) => { setTimeout(() => { res.end("late"); }, 3000); });
    expect(await code(safeFetch("http://slow.example.test/slow", { dns: client, policy: testPolicy(), timeoutMs: 500 }))).toMatch(/TIMEOUT|CONNECTION_FAILED/);
  });
});
