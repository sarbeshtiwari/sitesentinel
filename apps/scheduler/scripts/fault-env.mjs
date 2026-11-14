// Phase 4C operational check (development only): fixture DNS + the controlled fault website
// (HTTP and HTTPS with a private test CA) + a control endpoint to flip a host up/down.
// Never exposed beyond 127.0.0.1. Refuses to run in production.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createTestPki, startDnsServer, startFaultSite } from "@wim/test-fixtures";

if (process.env.NODE_ENV === "production") throw new Error("fault environment is not allowed in production");
const hosts = (process.env.FAULT_HOSTS ?? "").split(",").filter(Boolean);
const bind = process.env.FAULT_BIND ?? "127.0.0.1";
const answer = process.env.FAULT_ANSWER ?? "127.0.0.1"; // the address fixture names resolve to (the container's IP in Docker)
const dns = await startDnsServer(Number(process.env.FAULT_DNS_PORT ?? 15353), bind);
const pki = createTestPki();
const site = await startFaultSite(pki, bind, { http: Number(process.env.FAULT_HTTP_PORT ?? 0), https: Number(process.env.FAULT_HTTPS_PORT ?? 0) });
for (const h of hosts) { dns.setA(h, [answer]); site.issueCert(h); }
if (process.env.FAULT_CA_FILE) writeFileSync(process.env.FAULT_CA_FILE, pki.caPem);
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/toggle") site.toggles.set(u.searchParams.get("host"), u.searchParams.get("state"));
  // DNS TXT record (ownership-verification tests): /txt?name=…&value=…
  if (u.pathname === "/txt") dns.setTxt(u.searchParams.get("name"), [u.searchParams.get("value")]);
  res.end(JSON.stringify({ toggles: Object.fromEntries(site.toggles), hits: site.hits.length }));
}).listen(Number(process.env.FAULT_CONTROL_PORT ?? 15999), bind);
console.log(JSON.stringify({ dns: dns.server, httpPort: site.httpPort, httpsPort: site.httpsPort }));
