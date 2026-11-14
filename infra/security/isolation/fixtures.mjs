// Fixture "internet" for the isolation tests: a DNS server whose answers include deliberately
// hostile records, and a website. Runs inside the fakenet containers.
import { startDnsServer, startSiteServer } from "../../../packages/test-fixtures/dist/index.js";

const role = process.argv[2];
if (role === "dns") {
  const dns = await startDnsServer(53, "0.0.0.0");
  const A = {
    "public-site.co.in": ["10.250.77.10"],          // the only legitimate destination
    "www.public-site.co.in": ["10.250.77.10"],
    "redis-alias.attacker.co.in": ["10.250.10.10"], // internal Redis
    "pg-alias.attacker.co.in": ["10.250.10.11"],    // internal Postgres
    "gateway-self.attacker.co.in": ["10.250.30.2"], // the gateway's own internal interface
    "metadata.attacker.co.in": ["169.254.169.254"],
    "loopback.attacker.co.in": ["127.0.0.1"],
    "docker-host.attacker.co.in": ["192.168.65.254"],
    "mixed.attacker.co.in": ["10.250.77.10", "10.250.10.10"],
  };
  for (const [n, ips] of Object.entries(A)) dns.setA(n, ips);
  dns.zone.aaaa.set("v6-loopback.attacker.co.in", ["::1"]);
  dns.zone.aaaa.set("v6-metadata.attacker.co.in", ["fd00:ec2::254"]);
  dns.zone.aaaa.set("v6-mapped.attacker.co.in", ["::ffff:10.250.10.10"]);
  let n = 0;
  dns.setA("rebind.attacker.co.in", () => (n++ % 2 === 0 ? ["10.250.77.10"] : ["10.250.10.10"]));
  console.log("fixture dns on :53");
} else {
  const site = await startSiteServer(80, "0.0.0.0");
  const page = (t) => ({ body: `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1></body></html>` });
  site.route("public-site.co.in", "/", page("PUBLIC-SITE-OK"));
  site.route("public-site.co.in", "/redirect-to-redis", { status: 302, body: "", headers: { location: "http://redis-alias.attacker.co.in:6379/" } });
  site.route("public-site.co.in", "/redirect-to-metadata", { status: 302, body: "", headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  site.route("public-site.co.in", "/download", { body: "MZ-not-really-an-exe", type: "application/octet-stream", headers: { "content-disposition": "attachment; filename=evil.exe" } });
  site.route("public-site.co.in", "/attack", page("ATTACK-PAGE"));
  site.route("rebind.attacker.co.in", "/", page("REBIND-FIRST-ANSWER"));
  console.log("fixture site on :80");
}
