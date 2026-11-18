import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Db } from "@wim/db";
import { createLogger } from "@wim/logger";
import { createExecutionWorker } from "@wim/queue";
import { createDeepScanEngine } from "@wim/worker-deepscan";
import { resetMonitoringSettings, seedOrg } from "../helpers/monitoring.js";
import { EGRESS_SECRET_4C, PREFIX_4C } from "../helpers/http-monitoring.js";
import { DEEPSCAN_QUEUE_POLICY, deepSettings, deepSite, entitleDeep, scanNow, startDeepEnv, type DeepEnv } from "../helpers/deep-scan.js";

/**
 * Deep-scan frontier limits with set-based (batched) link processing, against the ds-wide fixture: one home page with
 * 3× the same link, 60 links of one numeric template, 25 query variants of one path, 39 more pages, 5 external links
 * plus an IP literal, 5 GET search forms and 16 images (one pointing at a page URL). Every limit must hold exactly as
 * with one statement per link; the engine's database round trips are counted (reported on stdout).
 */
let env: DeepEnv;
let c: pg.Client;
let parked: string[] = [];
const orgs: string[] = [];
const stats = { rt: 0, tx: 0, maxTx: 0, maxCrawlTx: 0, finalizeTx: 0, finalizing: false, marks: [] as number[] };
let stopWorker: (() => Promise<void>) | null = null;

/** Count every statement the engine sends (+2 per transaction for BEGIN / COMMIT). */
function countingDb(db: Db): Db {
  const raw = /^\$(query|execute)Raw/;
  const wrapTx = (tx: object, cur: { n: number }) => new Proxy(tx, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof p === "string" && raw.test(p) && typeof v === "function") return (...a: unknown[]) => { stats.rt++; cur.n++; return v.apply(t, a); };
      return v;
    },
  });
  return new Proxy(db, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "$transaction") {
        return async (fn: (tx: object) => Promise<unknown>, opts?: unknown) => {
          stats.rt += 2; stats.tx++;
          const cur = { n: 2 };
          try { return await (v as Function).call(t, (tx: object) => fn(wrapTx(tx, cur)), opts); } finally {
            stats.maxTx = Math.max(stats.maxTx, cur.n);
            if (stats.finalizing) stats.finalizeTx = Math.max(stats.finalizeTx, cur.n); else stats.maxCrawlTx = Math.max(stats.maxCrawlTx, cur.n);
          }
        };
      }
      if (typeof p === "string" && raw.test(p) && typeof v === "function") return (...a: unknown[]) => { stats.rt++; return v.apply(t, a); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Db;
}

beforeAll(async () => {
  env = await startDeepEnv();
  c = env.owner;
  parked = (await c.query<{ id: string }>(`UPDATE organizations SET status = 'SUSPENDED' WHERE status = 'ACTIVE' RETURNING id`)).rows.map((x) => x.id);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE deep_scans SET status = 'CANCELLED' WHERE status = 'RUNNING'`);
  await resetMonitoringSettings(c);
  await deepSettings(env, { "monitoring.deepscan.maxExternalLinks": 3 });
  for (let i = 1; i <= 5; i++) env.dns.setA(`ext${i}.example`, ["127.0.0.1"]);
  const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const log = createLogger("frontier-test", { level: "silent" });
  const w = createExecutionWorker({
    db: env.scannerDb, connection: conn, prefix: PREFIX_4C, tier: "DEEPSCAN", log, workerId: `deep-count-${randomBytes(3).toString("hex")}`,
    lockDurationMs: 4000, stalledIntervalMs: 2000, heartbeatEveryMs: 1000, settingsTtlMs: 200,
    handler: createDeepScanEngine({
      db: countingDb(env.scannerDb), redis: conn, log, gatewayUrl: env.gatewayUrl, tokenSecret: EGRESS_SECRET_4C, runnerUrl: null,
      jobTimeoutMs: async () => DEEPSCAN_QUEUE_POLICY.timeoutMs,
      hooks: { afterPage: () => { stats.marks.push(stats.rt); }, beforeFinalize: () => { stats.finalizing = true; } },
    }),
  });
  await w.start();
  stopWorker = async () => { await w.stop(); conn.disconnect(); };
}, 120_000);

afterAll(async () => {
  await stopWorker?.();
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  await c.query(`UPDATE monitoring_executions SET status = 'CANCELLED' WHERE status IN ('SCHEDULED','QUEUED','RUNNING','RETRYING')`);
  await c.query(`UPDATE organizations SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [parked]);
  await resetMonitoringSettings(c);
  for (const q of Object.values(env.queues)) await q.obliterate({ force: true });
  await env.close();
});

async function newOrg() {
  await c.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = ANY($1::uuid[])`, [orgs]);
  const o = await seedOrg(c, 0, { tag: "ds-frontier" });
  orgs.push(o.orgId);
  await entitleDeep(env, o.orgId, { "monitoring.deepscan.externalLinks": true });
  return o.orgId;
}
const rowsOf = async (exec: string) => (await c.query(`SELECT * FROM deep_scan_urls WHERE execution_id = $1 ORDER BY id`, [exec])).rows as Array<Record<string, any>>;
const path = (x: Record<string, any>) => { const u = new URL(x.url); return `${u.pathname}${u.search}`; };
const usageOf = async (org: string) => Object.fromEntries((await c.query(`SELECT key, value::int FROM usage_counters WHERE org_id = $1`, [org])).rows.map((r) => [r.key, r.value]));

describe("frontier limits with batched link processing", () => {
  it("maxPages, trap template cap, query-variant cap, external cap, search probes and referrer merges", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "wide", { checkExternalLinks: true });
    const before = { rt: stats.rt, tx: stats.tx, marks: stats.marks.length };
    stats.maxTx = 0; stats.maxCrawlTx = 0; stats.finalizeTx = 0; stats.finalizing = false;
    const [scan] = await scanNow(env, [s.id]);
    const after = { rt: stats.rt, tx: stats.tx };
    expect(scan).toMatchObject({ status: "COMPLETED", complete: false, stop_reason: "PAGE_LIMIT" });
    const rows = await rowsOf(scan!.execution_id);
    const pages = rows.filter((r) => r.kind === "PAGE");
    const crawl = pages.filter((r) => r.source === "CRAWL").map(path);
    // maxPages 100 counts every PAGE row except search probes (start page + 99 crawled links)
    expect(pages.filter((r) => r.source !== "SEARCH")).toHaveLength(100);
    expect(crawl.filter((p) => p.startsWith("/item/"))).toEqual(Array.from({ length: 50 }, (_, i) => `/item/${i + 1}`)); // template cap 50
    expect(crawl.filter((p) => p.startsWith("/q?"))).toEqual(Array.from({ length: 20 }, (_, i) => `/q?x=${i + 1}`)); // 20 query variants per path
    expect(crawl.filter((p) => p.startsWith("/w/"))).toEqual(Array.from({ length: 29 }, (_, i) => `/w/${i + 1}`)); // then maxPages
    expect(scan!.pages_dropped).toBe(10 + 5 + 11);
    expect(scan!.pages_discovered).toBe(100); // every page row except search probes (start page + 99 crawled)
    // the same link three times + an <img> to the same URL: one row, four referrers
    const w1 = rows.find((r) => path(r) === "/w/1")!;
    expect(w1).toMatchObject({ kind: "PAGE", referrers: 4, depth: 1 });
    expect(w1.first_referrer).toMatch(/\/$/);
    const home = rows.find((r) => path(r) === "/")!;
    // every other page links home, but only after maxPages was reached: links to known pages are not merged then (as before)
    expect(home).toMatchObject({ source: "START", referrers: 0, first_referrer: null });
    // search probes: at most 3, one per distinct form, never counted against maxPages
    expect(pages.filter((r) => r.source === "SEARCH").map(path)).toEqual(["/s1?q=test", "/s2?q=test", "/s3?q=test"]);
    // external cap (3 of 5), IP literal never stored; every external link seen is counted
    expect(rows.filter((r) => r.kind === "EXTERNAL").map((r) => new URL(r.url).hostname)).toEqual(["ext1.example", "ext2.example", "ext3.example"]);
    expect((await usageOf(org))["deepscan.external_links_seen"]).toBe(6);
    expect(rows.filter((r) => r.kind === "RESOURCE").map(path)).toEqual(Array.from({ length: 15 }, (_, i) => `/r/${i + 1}.png`));
    expect(rows.every((r) => r.state !== "QUEUED")).toBe(true);
    expect(rows.filter((r) => r.kind === "PAGE" && r.source === "CRAWL").every((r) => r.facts?.template)).toBe(true);

    const checked = pages.filter((r) => r.state === "DONE" || r.state === "FAILED").length;
    const marks = stats.marks.slice(before.marks);
    const perSmallPage = (marks.at(-1)! - marks[0]!) / (marks.length - 1);
    process.stdout.write(`[deep-scan round trips] scan total=${after.rt - before.rt} transactions=${after.tx - before.tx} pages checked=${checked} ` +
      `largest crawl transaction=${stats.maxCrawlTx} (the home page: ${rows.length} frontier rows touched; +4 for the claim) per small page=${perSmallPage.toFixed(1)} ` +
      `finalize transaction=${stats.finalizeTx}\n`);
  }, 240_000);

  it("resource cap (maxPages × 5) and maxPages 2: everything beyond is dropped, not inserted", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "wide", { checkExternalLinks: true, maxPages: 2 });
    const [scan] = await scanNow(env, [s.id]);
    const rows = await rowsOf(scan!.execution_id);
    expect(rows.filter((r) => r.kind === "PAGE" && r.source !== "SEARCH").map(path)).toEqual(["/", "/w/1"]);
    expect(scan!.pages_dropped).toBe(60 + 25 + 39);
    expect(rows.filter((r) => r.kind === "RESOURCE").map(path)).toEqual(Array.from({ length: 10 }, (_, i) => `/r/${i + 1}.png`));
    expect(rows.find((r) => path(r) === "/w/1")).toMatchObject({ kind: "PAGE", referrers: 2 }); // at the cap, repeats of a known link are not merged (as before)
    expect(rows.filter((r) => r.source === "SEARCH")).toHaveLength(3);
    expect(rows.filter((r) => r.kind === "EXTERNAL")).toHaveLength(3);
  }, 240_000);

  it("maxDepth 0: every in-scope link occurrence counts as dropped; externals, probes and resources are still recorded", async () => {
    const org = await newOrg();
    const s = await deepSite(env, org, "wide", { checkExternalLinks: true, maxDepth: 0 });
    const [scan] = await scanNow(env, [s.id]);
    const rows = await rowsOf(scan!.execution_id);
    expect(rows.filter((r) => r.kind === "PAGE" && r.source !== "SEARCH").map(path)).toEqual(["/"]);
    expect(scan!.pages_dropped).toBe(3 + 60 + 25 + 39);
    expect(rows.filter((r) => r.source === "SEARCH").map((r) => [path(r), r.state, r.skip_reason])).toEqual(
      ["/s1?q=test", "/s2?q=test", "/s3?q=test"].map((p) => [p, "SKIPPED", "DEPTH_LIMIT"]));
    // the <img src="/w/1"> is a resource now: the page link to it was dropped, never inserted
    expect(rows.filter((r) => r.kind === "RESOURCE").map(path)).toEqual(["/w/1", ...Array.from({ length: 15 }, (_, i) => `/r/${i + 1}.png`)]);
    expect(rows.filter((r) => r.kind === "EXTERNAL")).toHaveLength(3);
  }, 240_000);
});
