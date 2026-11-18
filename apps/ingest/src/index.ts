import { hostname } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { Redis } from "ioredis";
import { z } from "zod";
import { isSiteKey, originHostKey, parseSdkConfig } from "@wim/core";
import { loadSettings, createDb } from "@wim/db";
import { createLogger } from "@wim/logger";
import { SDK_MANIFEST, readSdkFile } from "@wim/sdk";

/**
 * SDK delivery + telemetry ingest (ARCHITECTURE.md §13.5). Public, unauthenticated,
 * hostile-input endpoint. Security model:
 *  - the site key is an identifier, never authority: it can only append bounded,
 *    sanitised telemetry for one website, and only from that website's origin;
 *  - the DB role (wim_ingest) has NO table privileges — only ingest_* functions;
 *  - an installation heartbeat counts only for a VERIFIED website, an unrevoked key
 *    and a browser Origin whose identity equals the website's identity;
 *  - per-IP and per-key rate limits, 64 KB bodies, 50 events per request,
 *    page-load and event dedupe (replayed beacons do not inflate counts);
 *  - every rejection returns the same 204 (no key/website oracle).
 * Origin headers can be forged by non-browser clients: telemetry is therefore never
 * used as proof of ownership (DNS/file/meta verification is), and is labelled as
 * client-reported data.
 */

const Env = z.object({
  INGEST_DATABASE_URL: z.string().min(1),
  SETTINGS_DATABASE_URL: z.string().min(1), // read-only settings access (wim_app role is sufficient)
  REDIS_URL: z.string().min(1),
  INGEST_PORT: z.coerce.number().int().default(4200),
  HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

const Event = z.object({
  type: z.enum(["JS_ERROR", "REJECTION", "RESOURCE", "VITALS", "NAV", "API_FAILURE"]),
  seq: z.number().int().min(0).max(10_000),
  path: z.string().max(500).optional(),
  fingerprint: z.string().max(200).optional(),
  t: z.number().optional(),
  data: z.record(z.string().max(40), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).optional(),
}).passthrough();

const Collect = z.object({
  v: z.literal(1),
  k: z.string().max(64),
  sv: z.string().max(20),
  pl: z.string().regex(/^[A-Za-z0-9]{8,40}$/),
  hb: z.boolean().optional(),
  ctx: z.object({ path: z.string().max(500).optional(), vw: z.number().int().min(0).max(20000).optional(), vh: z.number().int().min(0).max(20000).optional(), device: z.enum(["mobile", "tablet", "desktop"]).optional() }).partial().optional(),
  events: z.array(z.unknown()).max(50),
});

// Server-side minimisation repeats the SDK's (a modified or spoofed client is assumed).
const SCRUB: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card]"],
  [/\d{6,}/g, "[n]"],
  [/(?:eyJ|sk_|pk_|Bearer\s+)[A-Za-z0-9._-]{8,}/g, "[t]"],
  [/[A-Za-z0-9_-]{24,}/g, "[t]"],
];
export function scrubValue(s: string, max = 300): string {
  return SCRUB.reduce((acc, [re, rep]) => acc.replace(re, rep), s).slice(0, max);
}
export function sanitizePath(p: string | undefined, masks: RegExp[] = []): string {
  if (!p) return "/";
  let out = p.split(/[?#]/)[0]!.split("/").map((seg) => scrubValue(seg, 80)).join("/") || "/";
  for (const m of masks) out = out.replace(m, "[masked]");
  return out.startsWith("/") || /^https?:\/\//.test(out) ? out.slice(0, 300) : `/${out.slice(0, 299)}`;
}

const ALLOWED_DATA: Record<string, readonly string[]> = {
  JS_ERROR: ["message", "source", "line", "col", "stack"],
  REJECTION: ["message", "stack"],
  RESOURCE: ["tag", "url"],
  VITALS: ["lcp", "fcp", "cls", "inp", "ttfb"],
  NAV: ["to"],
  API_FAILURE: ["method", "url", "status", "ms"],
};

export function sanitizeEvent(raw: unknown, masks: RegExp[]): Record<string, unknown> | null {
  const p = Event.safeParse(raw);
  if (!p.success) return null;
  const e = p.data;
  const data: Record<string, unknown> = {};
  for (const k of ALLOWED_DATA[e.type]!) {
    const v = e.data?.[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") data[k] = Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : 0;
    else if (typeof v === "string") data[k] = k === "url" || k === "to" || k === "source" ? sanitizePath(v, masks) : scrubValue(v, k === "stack" ? 800 : 300);
  }
  return { type: e.type, path: sanitizePath(e.path, masks), fingerprint: e.fingerprint ? scrubValue(e.fingerprint, 64) : null, data };
}

type Lookup = { org_id: string; website_id: string; host_key: string; website_status: string; key_state: string; telemetry_paused: boolean; sdk_config: unknown };

export async function buildIngest(source: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const env = Env.parse(source);
  const log = createLogger("ingest");
  const pool = new pg.Pool({ connectionString: env.INGEST_DATABASE_URL, max: 10 });
  const settingsDb = createDb({ url: env.SETTINGS_DATABASE_URL, max: 2, omitSecrets: true });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  // release readiness: liveness + readiness for the platform health evaluator (Redis key with a 30 s TTL)
  const hbKey = `${source.QUEUE_PREFIX ?? "wim"}:ops:hb:ingest:${hostname()}-${process.pid}`;
  const hbBeat = async () => {
    const postgres = await pool.query("SELECT 1").then(() => true, () => false);
    await redis.set(hbKey, JSON.stringify({ kind: "ingest", id: `${hostname()}-${process.pid}`, at: new Date().toISOString(), checks: { postgres }, rssMb: Math.round(process.memoryUsage().rss / 1048576) }), "PX", 30_000).catch(() => undefined);
  };
  const hbTimer = source.NODE_ENV === "test" ? undefined : setInterval(() => void hbBeat(), 10_000);
  hbTimer?.unref();
  if (hbTimer) void hbBeat();
  let settingsCache: { v: Awaited<ReturnType<typeof loadSettings>>; exp: number } | null = null;
  const settings = async () => {
    if (!settingsCache || settingsCache.exp < Date.now()) settingsCache = { v: await loadSettings(settingsDb), exp: Date.now() + 30_000 };
    return settingsCache.v;
  };
  const lookups = new Map<string, { v: Lookup | null; exp: number }>();
  const lookup = async (k: string): Promise<Lookup | null> => {
    const hit = lookups.get(k);
    if (hit && hit.exp > Date.now()) return hit.v;
    const { rows } = await pool.query<Lookup>("SELECT * FROM ingest_lookup($1)", [k]);
    const v = rows[0] ?? null;
    lookups.set(k, { v, exp: Date.now() + 15_000 }); // short: revocation applies within 15 s
    if (lookups.size > 50_000) lookups.clear();
    return v;
  };
  const limit = async (bucket: string, max: number) => {
    const key = `ing:${bucket}:${Math.floor(Date.now() / 60_000)}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 120);
    return n <= max;
  };

  const app = Fastify({ trustProxy: env.TRUST_PROXY, bodyLimit: 64 * 1024, logger: false });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
  app.options("/*", async (_req, reply) => reply.headers(cors).code(204).send());

  // ---------------------------------------------------------------- SDK files
  const files = new Map(SDK_MANIFEST.files.map((f) => [f, readSdkFile(f)]));
  app.get("/sdk/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const body = files.get(file);
    if (!body) return reply.code(404).send();
    const immutable = file === `monitor.${SDK_MANIFEST.version}.js`;
    return reply.headers({
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "x-sdk-version": SDK_MANIFEST.version,
    }).send(body);
  });

  // ---------------------------------------------------------------- remote config
  app.get("/v1/config/:key", async (req, reply) => {
    reply.headers({ ...cors, "cache-control": "public, max-age=60", "content-type": "application/json" });
    const { key } = req.params as { key: string };
    const off = { v: 1, enabled: false, heartbeat: false };
    if (!isSiteKey(key) || !(await limit(`cfg-ip:${req.ip}`, (await settings())["ingest.perIpPerMinute"]))) return off;
    const l = await lookup(key);
    if (!l || l.website_status !== "ACTIVE" || (l.key_state !== "CURRENT" && l.key_state !== "PREVIOUS")) return off;
    const c = parseSdkConfig(l.sdk_config ?? {});
    // Paused: the heartbeat (installation status) continues, telemetry stops.
    return { v: 1, enabled: !l.telemetry_paused, heartbeat: true, ...c };
  });

  // ---------------------------------------------------------------- collect
  app.post("/v1/collect", async (req, reply) => {
    reply.headers(cors).code(204);
    const s = await settings();
    if (!(await limit(`ip:${req.ip}`, s["ingest.perIpPerMinute"]))) return reply.send();
    let body: unknown;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return reply.send();
    }
    const parsed = Collect.safeParse(body);
    if (!parsed.success || !isSiteKey(parsed.data.k)) return reply.send();
    const msg = parsed.data;
    if (!(await limit(`key:${msg.k}`, s["ingest.perKeyPerMinute"]))) return reply.send();
    const l = await lookup(msg.k);
    if (!l) return reply.send(); // unknown key: nothing to attribute it to

    const origin = String(req.headers.origin ?? "");
    const originKey = originHostKey(origin, { aliasLabels: s["domain.aliasLabels"] });
    let invalid: string | null = null;
    if (l.website_status !== "ACTIVE") invalid = "WEBSITE_NOT_VERIFIED";
    else if (l.key_state === "REVOKED") invalid = "REVOKED_KEY";
    else if (l.key_state === "PREVIOUS_EXPIRED") invalid = "EXPIRED_KEY";
    else if (!originKey) invalid = "ORIGIN_MISSING"; // non-browser sender (bots, link previews, tools): nothing to attribute
    else if (originKey !== l.host_key) invalid = "ORIGIN_MISMATCH";

    if (invalid) {
      // Record (rate-limited) that misconfigured or foreign traffic used this key.
      if (await limit(`inv:${l.website_id}`, 10)) await pool.query("SELECT ingest_heartbeat($1, false, false, $2, $3, $4)", [l.website_id, msg.sv, invalid, origin.slice(0, 255)]);
      return reply.send();
    }

    if (msg.hb) {
      // Replay protection: a page load counts once.
      const fresh = (await redis.set(`ing:pl:${l.website_id}:${msg.pl}`, "1", "EX", 3600, "NX")) === "OK";
      await pool.query("SELECT ingest_heartbeat($1, true, $2, $3, NULL, NULL)", [l.website_id, fresh, msg.sv.replace(/[^0-9a-z.+-]/gi, "")]);
    }
    if (msg.events.length && !l.telemetry_paused) {
      const masks = parseSdkConfig(l.sdk_config ?? {}).maskPatterns.map((p) => new RegExp(p, "g"));
      const out: Array<Record<string, unknown>> = [];
      for (const raw of msg.events) {
        const e = sanitizeEvent(raw, masks);
        if (!e) continue;
        const seq = (raw as { seq?: number }).seq ?? 0;
        // Event dedupe per page load (replayed batches are dropped).
        if ((await redis.set(`ing:ev:${l.website_id}:${msg.pl}:${seq}`, "1", "EX", 3600, "NX")) !== "OK") continue;
        out.push({ ...e, sid: msg.pl, sv: msg.sv, device: msg.ctx?.device, vw: msg.ctx?.vw, vh: msg.ctx?.vh });
      }
      if (out.length) await pool.query("SELECT ingest_events($1, $2::jsonb)", [l.website_id, JSON.stringify(out)]);
    }
    return reply.send();
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.setErrorHandler((err: { message?: string; statusCode?: number }, _req, reply) => {
    log.warn({ err: err.message }, "ingest error");
    void reply.headers(cors).code(err.statusCode === 413 ? 413 : 204).send();
  });
  app.addHook("onClose", async () => {
    clearInterval(hbTimer);
    await redis.del(hbKey).catch(() => undefined);
    await pool.end();
    await settingsDb.$disconnect();
    redis.disconnect();
  });
  return app;
}
