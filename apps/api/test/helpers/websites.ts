import { QueueEvents, Job } from "bullmq";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { startDnsServer, startSiteServer, type FixtureDns, type FixtureSite } from "@wim/test-fixtures";
import { REVALIDATE_QUEUE, VERIFY_QUEUE } from "@wim/contracts";
import { startVerifyWorker } from "@wim/worker-http";
import { Gateway } from "@wim/egress-gateway";
import { buildIngest } from "@wim/ingest";
import { startHarness, type Client, type Harness } from "./harness.js";
import { WebsitesService } from "../../src/websites/websites.service.js";

/**
 * Phase 3 harness: everything from the Phase 2 harness plus
 *  - a real UDP DNS server (the verification worker's ONLY resolver),
 *  - a real HTTP server standing in for customer websites (all names resolve to 127.0.0.1),
 *  - the verification worker (netguard loopback allowance is test-only and refused outside NODE_ENV=test),
 *  - the SDK ingest service (in-process, Fastify inject).
 */
export const EGRESS_SECRET = "integration-egress-secret-0123456789abcdef";

export interface WebsiteHarness extends Harness {
  gateway: Gateway;
  dns: FixtureDns;
  site: FixtureSite;
  ingest: FastifyInstance;
  waitJob(jobId: string, queue?: "verify" | "revalidate"): Promise<Record<string, unknown>>;
  stopAll(): Promise<void>;
}

export async function startWebsiteHarness(): Promise<WebsiteHarness> {
  const dns = await startDnsServer();
  const site = await startSiteServer();
  const base = await startHarness();
  // All verification traffic goes through a real egress gateway. The only test allowance is on the
  // gateway (fixtures live on 127.0.0.1 and an ephemeral port); the worker itself runs production code paths.
  const gateway = new Gateway({
    resolvers: [dns.server], tokenSecret: EGRESS_SECRET, allowedPorts: [80, 443], maxConnectionsPerOrg: 50, maxConnectionsTotal: 500,
    maxTunnelBytes: 5 * 1024 * 1024, tunnelMaxMs: 30_000, idleMs: 10_000, connectTimeoutMs: 3000,
    testAllowCidrs: ["127.0.0.0/8"], testPortMap: { 80: site.port, 443: site.port },
  });
  await gateway.listen(0, "127.0.0.1");
  const gatewayUrl = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const worker = startVerifyWorker({
    ...process.env,
    EGRESS_GATEWAY_URL: gatewayUrl,
    EGRESS_TOKEN_SECRET: EGRESS_SECRET,
    VERIFY_WORKER_CONCURRENCY: "4",
    REVALIDATION_SWEEP_EVERY_MS: "3600000", // tests trigger sweeps explicitly
  });
  const ingest = await buildIngest(process.env);
  const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const events = new QueueEvents(VERIFY_QUEUE, { connection: conn, prefix: process.env.QUEUE_PREFIX });
  const revEvents = new QueueEvents(REVALIDATE_QUEUE, { connection: conn, prefix: process.env.QUEUE_PREFIX });
  await events.waitUntilReady();
  await revEvents.waitUntilReady();
  const verifyQueue = base.app.get(WebsitesService).verifyQueue;
  const revalidateQueue = base.app.get(WebsitesService).revalidateQueue;
  return {
    ...base,
    gateway, dns, site, ingest,
    async waitJob(jobId, queue = "verify") {
      const q = queue === "revalidate" ? revalidateQueue : verifyQueue;
      for (let i = 0; i < 50; i++) {
        const job = await Job.fromId(q, jobId);
        if (job) return (await job.waitUntilFinished(queue === "revalidate" ? revEvents : events, 30_000)) as Record<string, unknown>;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`job ${jobId} not found`);
    },
    async stopAll() {
      await events.close();
      await revEvents.close();
      conn.disconnect();
      await worker.stop();
      await ingest.close();
      await gateway.close();
      await base.stop();
      await dns.close();
      await site.close();
    },
  };
}

/** A unique public-looking domain (normalization rejects reserved TLDs; DNS is the fixture server). */
export function uniqueDomain(tag: string): string {
  return `${tag}-${randomBytes(4).toString("hex")}.co.in`;
}

/** Map a host (and its www alias) to the fixture site. */
export function serve(h: WebsiteHarness, host: string) {
  h.dns.setA(host, ["127.0.0.1"]);
  h.dns.setA(`www.${host}`, ["127.0.0.1"]);
  h.site.route(host, "/", { body: "<!doctype html><html><head><title>Fixture</title></head><body>Hello</body></html>" });
}

export async function addWebsite(c: Client, orgId: string, url: string, name = "Site") {
  const r = await c.post(`/api/v1/orgs/${orgId}/websites`, { name, url, category: "ECOMMERCE" });
  if (r.status !== 201) throw new Error(`create website failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; hostKey: string; registrableDomain: string; instructions: { value: string; token: string; dns: { hostRecord: { name: string } }; file: { url: string; content: string }; meta: { tag: string } }; install: { siteKey: string } };
}

export async function verifyNow(h: WebsiteHarness, c: Client, orgId: string, websiteId: string, method = "ANY") {
  const r = await c.post(`/api/v1/orgs/${orgId}/websites/${websiteId}/verify`, { method });
  if (r.status !== 202) return { status: r.status, body: r.body, result: null as Record<string, unknown> | null };
  return { status: r.status, body: r.body, result: await h.waitJob(r.body.data.jobId) };
}

/** Register + DNS-verify a website (record published on the fixture DNS). */
export async function verifiedWebsite(h: WebsiteHarness, c: Client, orgId: string, domain: string) {
  serve(h, domain);
  const w = await addWebsite(c, orgId, `https://${domain}`);
  h.dns.setTxt(w.instructions.dns.hostRecord.name, [w.instructions.value]);
  const v = await verifyNow(h, c, orgId, w.id, "DNS_TXT");
  if (v.result?.status !== "VERIFIED") throw new Error(`verification failed ${JSON.stringify(v)}`);
  return { ...w, verification: v.result };
}

/** Send an SDK request to the ingest service as a browser on `origin` would. */
export async function sdkCollect(h: WebsiteHarness, body: Record<string, unknown>, origin: string) {
  const r = await h.ingest.inject({ method: "POST", url: "/v1/collect", headers: { origin, "content-type": "text/plain" }, payload: JSON.stringify(body) });
  return r.statusCode;
}

export function heartbeat(siteKey: string, pageLoad = randomBytes(8).toString("hex"), events: unknown[] = []) {
  return { v: 1, k: siteKey, sv: "1.0.0", pl: pageLoad, hb: true, ctx: { path: "/", vw: 1280, vh: 800, device: "desktop" }, events };
}
