import { isIP } from "node:net";
import type { Redis } from "ioredis";
import {
  displayUrl, effectiveScanLimits, normalizeUrl, parseDeepScanConfig, parseRobots, pathTemplate, robotsAllows, scopeDecision, SEARCH_PROBE_TERM,
  type EffectiveScanLimits, type Robots, type Scope, type SettingsSnapshot, type UrlNormalizeOptions,
} from "@wim/core";
import { loadSettings, withSystem, type Db, type Tx } from "@wim/db";
import type { Logger } from "@wim/logger";
import { httpProbe, signCapability } from "@wim/netguard";
import { addUsage, loadOrgContexts, SecurityError, TransientError, type ExecutionContext, type ExecutionResult } from "@wim/queue";
import { openSession } from "@wim/worker-browser";
import { EGRESS_BUDGET_EXHAUSTED, fetchChain, type FetchResult } from "./fetch.js";
import { finalizeScan } from "./finalize.js";
import { looksClientRendered, selectBrowserPages } from "./discovery.js";
import { MAX_JS_SEARCHES_PER_SCAN, revealLinks, type FoundBy } from "./reveal.js";
import { candidates, FRONTIER_STATE, FRONTIER_UPSERT, FrontierPlan, linkedFileType, usageArrays, usageUpsert, type FrontierState } from "./frontier.js";
import { analyzeHtml, parseSitemap, type HtmlForm } from "./html.js";

export interface DeepScanDeps {
  db: Db;
  redis: Redis;
  log: Logger;
  gatewayUrl: string;
  tokenSecret: string;
  /** browser runner (only used when browser-assisted discovery is entitled AND enabled) */
  runnerUrl: string | null;
  /** NODE_ENV=test only: extra CA for the controlled HTTPS fixture website (the startup refuses it otherwise) */
  testCa?: string;
  jobTimeoutMs: () => Promise<number>;
  hooks?: { afterPage?: (executionId: string, n: number) => void | Promise<void>; beforeFinalize?: (executionId: string) => void | Promise<void> };
}

export const SCANNER_AGENT = "SiteSentinel";
/** One harmless query per distinct search form (no personal data, nothing that could trigger an action). */
const MAX_SEARCH_PROBES = 3;
/** resources / external links claimed per query in the status-check phase */
const RESOURCE_BATCH = 25;
/** browser-assisted discovery: runner session lifetime; no page is rendered with less than BROWSER_MIN_REMAINING_MS left before the deadline */
const BROWSER_SESSION_MS = 240_000;
const BROWSER_MIN_REMAINING_MS = 60_000;
/** no page is started in a runner session with less than this of its lifetime left (load + interactions + compare) */
const BROWSER_SESSION_RESERVE_MS = 80_000;
/** client-rendered pages found by the crawl are rendered in batches of this size (one session per batch) */
const BROWSER_BATCH = 5;
/**
 * Our infrastructure failing (retried / INFRASTRUCTURE). EGRESS_RATE_LIMITED here is the gateway's concurrency caps;
 * the crawl's own lifetime budget being used up arrives as EGRESS_BUDGET_EXHAUSTED and stops it as REQUEST_BUDGET.
 */
const INFRA = new Set(["GATEWAY_UNAVAILABLE", "EGRESS_RATE_LIMITED", "GATEWAY_ERROR"]);
/** Connection-level failures: the site's problem only if OUR path (worker → gateway → internet) is healthy. */
const CONNECTION_LEVEL = new Set(["CONNECTION_FAILED", "CONNECT_TIMEOUT", "RESPONSE_TIMEOUT", "PROTOCOL_ERROR", "DNS_FAILURE"]);

export interface ScanSnapshot {
  scope: Scope;
  /** In scope only as redirect/link targets of the same website (www ⇄ apex); never probed on their own. */
  aliasHosts?: string[];
  norm: UrlNormalizeOptions;
  limits: EffectiveScanLimits;
  respectRobots: boolean;
  checkResources: boolean;
  origin: string;
  startPaths: string[];
  sitemaps: string[];
  deadline: number;
  severityOverrides: Record<string, string>;
  incidentGroups: string[];
}

/**
 * Tier C deep-scan engine (Phase 4E). Runs in worker-deepscan (DB role wim_scanner; networks data + http-egress).
 * The 4B runtime has validated the job, the tenant binding and current eligibility. Every request goes through
 * the gateway with a host-bound capability; every URL is re-validated against the scan's scope before every fetch.
 */
export function createDeepScanEngine(d: DeepScanDeps) {
  let cached: { at: number; s: SettingsSnapshot } | null = null;
  let health: { at: number; ok: boolean } | null = null; // our own egress path (shared by this worker's scans)
  const settings = async () => {
    if (!cached || Date.now() - cached.at > 10_000) cached = { at: Date.now(), s: await loadSettings(d.db) };
    return cached.s;
  };

  return async function handle(ctx: ExecutionContext): Promise<ExecutionResult> {
    const s = await settings();
    const jobStarted = Date.now();
    const [done] = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ outcome: string }>>`SELECT outcome FROM execution_results WHERE execution_id = ${ctx.executionId}::uuid`);
    if (done) return { summary: { duplicate: true, outcome: done.outcome } };

    // ---- scan row: create (snapshot of scope + limits) or resume
    const scan = await withSystem(d.db, (tx) => openScan(tx, ctx, s));
    if (scan.status !== "RUNNING") return { summary: { scan: scan.status, note: "scan already ended" } };
    const snap = scan.config as unknown as ScanSnapshot;
    const jobBudgetEnd = jobStarted + (await d.jobTimeoutMs()) - 30_000;
    const hardDeadline = Math.min(snap.deadline, jobBudgetEnd);
    let requests = scan.requests;
    let infraStreak = 0;
    /** the gateway refused: this execution's crawl used up its lifetime connection budget (stop REQUEST_BUDGET) */
    let budgetExhausted = false;
    let overheadRequests = 0; // this attempt's requests that failed on OUR infrastructure (results never committed)
    const fd = {
      gatewayUrl: d.gatewayUrl, tokenSecret: d.tokenSecret, cap: { o: ctx.orgId, w: ctx.websiteId, e: ctx.executionId },
      timeoutMs: 20_000, maxBytes: snap.limits.maxResponseBytes, signal: ctx.signal, onRequest: () => { requests++; }, testCa: d.testCa,
    };
    let lastRequestAt = 0;
    let crawlDelay = snap.limits.requestDelayMs;
    const polite = async () => {
      const wait = lastRequestAt + crawlDelay - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
    };
    const aborted = () => ctx.signal.aborted;
    let robotsFor: (u: URL) => Robots | null = () => null;
    const abortReason = () => String((ctx.signal.reason as { reason?: string } | undefined)?.reason ?? "");
    // browser-assisted discovery: ONE scan-wide budget (browserPages) for the pre-crawl pages and the crawl's renders
    const browser = {
      enabled: snap.limits.browserPages > 0 && Boolean(d.runnerUrl),
      rendered: new Set<string>(), queue: [] as Array<{ url: string; depth: number }>,
      spa: [] as Array<{ page: string; links: number; foundBy?: Partial<Record<FoundBy, number>> }>, unavailable: false,
      /** pages interacted with, actions taken (by kind), requests the guard refused, navigations it stopped */
      interaction: { pages: 0, actions: 0, scroll: 0, loadMore: 0, toggle: 0, details: 0, hover: 0, carousel: 0, carousels: 0, search: 0, searchNavigations: 0, refused: 0, navigationsRefused: 0 },
      /** hover triggers already hovered in this attempt (site menus repeat on every page) */
      hovered: new Set<string>(),
    };

    try {
      // ---- 1. discovery (robots + sitemaps + start pages), once per scan
      let discovery = scan.discovery as { robots: Record<string, Robots | null>; browserDone?: boolean; hostAliases?: Record<string, string>; spa?: Array<{ page: string; links: number }>; browserRendered?: string[]; browserInteraction?: Record<string, number> } | null;
      if (!discovery) discovery = await discover();
      if (discovery.hostAliases) snap.norm = { ...snap.norm, hostAliases: discovery.hostAliases }; // resumed scan
      robotsFor = (u: URL) => discovery!.robots[u.hostname] ?? null;
      const robotsDelay = Math.max(0, ...Object.values(discovery.robots).map((r) => (r ? robotsAllows(r, SCANNER_AGENT, new URL(snap.origin)).crawlDelaySec ?? 0 : 0)));
      crawlDelay = Math.max(snap.limits.requestDelayMs, Math.min(30_000, robotsDelay * 1000));

      // ---- 2. optional browser-assisted discovery (SPA routes, listing pages), once per scan
      for (const x of discovery.browserRendered ?? []) browser.rendered.add(x); // resumed scan: the budget already used
      browser.spa.push(...(discovery.spa ?? []));
      if (discovery.browserInteraction) Object.assign(browser.interaction, discovery.browserInteraction);
      if (!discovery.browserDone && browser.enabled) await browserDiscovery();
      if (browser.enabled) {
        // resumed scan: client-rendered pages the previous attempt crawled but did not render yet
        const pending = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ url: string; depth: number }>>`
          SELECT url, depth FROM deep_scan_urls WHERE execution_id = ${ctx.executionId}::uuid AND kind = 'PAGE' AND state = 'DONE' AND (facts ->> 'clientRendered') = 'true'
           ORDER BY depth, id LIMIT ${snap.limits.browserPages}`);
        for (const q of pending) if (!browser.rendered.has(q.url) && browser.rendered.size + browser.queue.length < snap.limits.browserPages) browser.queue.push(q);
      }

      // ---- 3. crawl pages
      let stop: string | null = null;
      let n = 0;
      for (;;) {
        if (aborted()) break;
        if (Date.now() > hardDeadline) { stop = "DURATION"; break; }
        if (requests >= snap.limits.maxRequests || budgetExhausted) { stop = "REQUEST_BUDGET"; break; }
        // today's page quota and the next page, in one statement
        const [next] = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ used: bigint | null; id: bigint | null; url: string; depth: number; in_sitemap: boolean }>>`
          SELECT (SELECT value FROM usage_counters WHERE org_id = ${ctx.orgId}::uuid AND period_start = (now() AT TIME ZONE 'UTC')::date AND key = 'deepscan.pages') AS used,
                 u.id, u.url, u.depth, u.in_sitemap
            FROM (SELECT 1) one LEFT JOIN LATERAL (
                   SELECT id, url, depth, in_sitemap FROM deep_scan_urls WHERE execution_id = ${ctx.executionId}::uuid AND kind = 'PAGE' AND state = 'QUEUED'
                    ORDER BY depth, id LIMIT 1) u ON true`);
        if (snap.limits.pagesPerDay - Number(next?.used ?? 0) <= 0) { stop = "DAILY_QUOTA"; break; }
        // client-rendered pages are rendered in batches between pages (and before the frontier counts as exhausted)
        if (browser.queue.length && (browser.queue.length >= BROWSER_BATCH || next?.id == null)) { await renderQueued(); if (aborted()) break; continue; }
        if (next?.id == null) break; // frontier exhausted
        const row = { id: next.id, url: next.url, depth: next.depth, in_sitemap: next.in_sitemap };
        const r = await crawlPage(row);
        if (r === "BUDGET") { stop = "REQUEST_BUDGET"; break; } // the page stays QUEUED: not checked, not failed
        if (r === "INFRA") {
          infraStreak++;
          overheadRequests++;
          if (infraStreak >= 3) {
            if (ctx.attempt < ctx.maxAttempts) throw new TransientError("monitoring infrastructure unavailable during the deep scan; resuming later");
            stop = "INFRASTRUCTURE";
            break;
          }
          await new Promise((res) => setTimeout(res, 1000));
        } else infraStreak = 0;
        await d.hooks?.afterPage?.(ctx.executionId, ++n);
      }
      if (aborted()) return await interrupted();

      // ---- 4. first-party resources and (if enabled) external links: status only, never parsed or followed
      if (!stop) {
        // No URL is added in this phase, so the queue is claimed in batches (same order); each row stays guarded by
        // its QUEUED → checked transition, and the budget / abort checks still run before every request.
        let batch: Array<{ id: bigint; url: string; kind: string }> = [];
        resources: for (;;) {
          if (!batch.length) {
            batch = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ id: bigint; url: string; kind: string }>>`
              SELECT id, url, kind FROM deep_scan_urls WHERE execution_id = ${ctx.executionId}::uuid AND kind IN ('RESOURCE', 'EXTERNAL') AND state = 'QUEUED'
               ORDER BY kind DESC, id LIMIT ${RESOURCE_BATCH}`);
            if (!batch.length) break;
          }
          while (batch.length) {
            if (aborted()) return await interrupted();
            if (Date.now() > hardDeadline || requests >= snap.limits.maxRequests || budgetExhausted) break resources; // resources are best-effort within the budget
            const res = batch.shift()!;
            const rc = await checkResource(res);
            if (rc === "BUDGET") { stop = "REQUEST_BUDGET"; break resources; } // the gateway refused: the row stays QUEUED
            if (rc === "INFRA") {
              overheadRequests++;
              if (++infraStreak >= 3) { if (ctx.attempt < ctx.maxAttempts) throw new TransientError("monitoring infrastructure unavailable"); break resources; }
            } else infraStreak = 0;
          }
        }
      }

      if (stop === "INFRASTRUCTURE") {
        await withSystem(d.db, (tx) => addUsage(tx, ctx.orgId, { "deepscan.failed_attempts": 1, "deepscan.overhead_requests": overheadRequests })).catch(() => undefined);
      }
      await d.hooks?.beforeFinalize?.(ctx.executionId);
      // ---- 5. finalise: findings, incidents, comparison, inventory, ledger and usage in ONE transaction
      const out = await withSystemLong(d.db, (tx) => finalizeScan(tx, {
        executionId: ctx.executionId, orgId: ctx.orgId, websiteId: ctx.websiteId, windowStart: ctx.windowStart, attempt: ctx.attempt,
        stopReason: stop, requests, snap, durationMs: Date.now() - scan.started_at.getTime(),
      }));
      d.log.info({ execution: ctx.executionId, status: out.status, findings: out.findings }, "deep scan finished");
      return { summary: out };
    } catch (e) {
      if (aborted()) return await interrupted();
      // Failed-attempt overhead: requests whose results were never committed (not billable, tracked separately).
      if (e instanceof TransientError) {
        await withSystem(d.db, (tx) => addUsage(tx, ctx.orgId, { "deepscan.failed_attempts": 1, "deepscan.overhead_requests": overheadRequests })).catch(() => undefined);
      }
      if (e instanceof TransientError && ctx.attempt >= ctx.maxAttempts) {
        // Last attempt and our infrastructure is still failing: record what was checked (never resolving anything).
        const out = await withSystemLong(d.db, (tx) => finalizeScan(tx, {
          executionId: ctx.executionId, orgId: ctx.orgId, websiteId: ctx.websiteId, windowStart: ctx.windowStart, attempt: ctx.attempt,
          stopReason: "INFRASTRUCTURE", requests, snap, durationMs: Date.now() - scan.started_at.getTime(),
        }));
        await withSystem(d.db, (tx) => tx.systemHealthLog.create({ data: { component: "deep-scan", metric: "infra_failure", value: 1 } })).catch(() => undefined);
        return { summary: { ...out, note: "monitoring infrastructure unavailable" } };
      }
      throw e;
    }

    // ------------------------------------------------------------------ helpers (closures over the scan)
    async function interrupted(): Promise<ExecutionResult> {
      // Shutdown: leave the scan RUNNING (the same execution resumes on another worker). Cancel: keep the partial data.
      if (abortReason() !== "SHUTDOWN") {
        await withSystem(d.db, (tx) => tx.$executeRaw`
          UPDATE deep_scans SET status = 'CANCELLED', stop_reason = 'CANCELLED', requests = ${requests}, finished_at = now(), updated_at = now()
           WHERE execution_id = ${ctx.executionId}::uuid AND status = 'RUNNING'`).catch(() => undefined);
      } else {
        await withSystem(d.db, (tx) => tx.$executeRaw`UPDATE deep_scans SET requests = ${requests}, updated_at = now() WHERE execution_id = ${ctx.executionId}::uuid`).catch(() => undefined);
      }
      throw new Error("aborted"); // the runtime decides (CANCELLED / handed back on shutdown)
    }

    async function guardedFetch(u: URL, opts: { method?: "GET" | "HEAD"; readBody: boolean }): Promise<FetchResult> {
      await polite();
      const r = await fetchChain(u, fd, snap.scope, snap.norm, { ...opts, maxRedirects: 10 });
      if (r.error === EGRESS_BUDGET_EXHAUSTED) budgetExhausted = true;
      // A gateway that dies mid-request surfaces as a timeout / protocol error, not "unavailable": never record
      // that as the customer's broken page. Re-classify as infrastructure when our own path is unhealthy.
      if (r.error && CONNECTION_LEVEL.has(r.error) && !(await pathHealthy(u.hostname))) return { ...r, error: "GATEWAY_UNAVAILABLE" };
      return r;
    }

    /** Gateway reachable (and, if configured, the HTTP canary passes through it). Cached 10 s. */
    async function pathHealthy(targetHost: string): Promise<boolean> {
      if (health && Date.now() - health.at < 10_000) return health.ok;
      let ok = await fetch(new URL("/health", d.gatewayUrl), { signal: AbortSignal.timeout(3000) }).then((x) => x.ok, () => false);
      const canaryUrl = s["monitoring.http.canaryUrl"];
      if (ok && canaryUrl) {
        try {
          const host = new URL(canaryUrl).hostname.toLowerCase();
          if (host !== targetHost) {
            const c = await httpProbe({ url: canaryUrl, method: "HEAD", timeoutMs: 8000, maxRedirects: 3, maxBodyBytes: 1024,
              gateway: { url: d.gatewayUrl, token: (h) => signCapability(d.tokenSecret, { o: null, w: null, e: "canary", k: "canary", h }, 60) } });
            ok = c.error === null;
          }
        } catch { /* invalid canary URL: gateway health alone */ }
      }
      health = { at: Date.now(), ok };
      return ok;
    }

    async function discover() {
      const robots: Record<string, Robots | null> = {};
      const issues: Array<{ category: string; subject: string; evidence: Record<string, unknown> }> = [];
      const sitemapQueue: Array<{ url: URL; declared: boolean; depth: number }> = [];
      const sitemapSeen = new Set<string>();
      const pageRows: Array<{ url: URL; source: string; inSitemap: boolean; depth: number }> = [];
      let sitemapCount = 0, sitemapUrls = 0, outOfScope = 0, badLastmod = 0;
      const aliases = new Set(snap.aliasHosts ?? []);
      const hostAliases: Record<string, string> = {};
      // Does the site serve itself from its alias (example.com → www.example.com)? Then every URL on the registered
      // host is crawled on the alias directly: one page per path instead of a redirect + a duplicate per page.
      if (aliases.size) {
        const home = new URL(snap.origin);
        const r = await guardedFetch(new URL("/", home), { method: "HEAD", readBody: false });
        if (r.error && INFRA.has(r.error)) { overheadRequests++; throw new TransientError(`gateway unavailable (${r.error})`); }
        if (r.error === "EGRESS_UNAUTHORIZED") throw new SecurityError("egress gateway rejected the scanner's capability");
        if (r.finalUrl.hostname !== home.hostname && aliases.has(r.finalUrl.hostname)) {
          hostAliases[home.hostname] = r.finalUrl.hostname;
        } else {
          // Both hosts answer without redirecting (or the alias redirects here): the alias is the same site, so its
          // URLs are crawled on the registered host. Otherwise every page is checked twice and halves the page budget.
          for (const a of aliases) hostAliases[a] = home.hostname;
        }
        snap.norm = { ...snap.norm, hostAliases };
      }
      for (const host of snap.scope.hosts.filter((h) => !aliases.has(h))) {
        const robotsUrl = new URL(`${new URL(snap.origin).protocol}//${host}/robots.txt`);
        const r = await guardedFetch(robotsUrl, { readBody: true });
        if (r.error && INFRA.has(r.error)) { overheadRequests++; throw new TransientError(`gateway unavailable (${r.error})`); }
        if (r.error === "EGRESS_UNAUTHORIZED") throw new SecurityError("egress gateway rejected the scanner's capability");
        robots[host] = r.status === 200 && r.body ? parseRobots(r.body.toString("utf8").slice(0, 512 * 1024)) : null;
        // robots.txt answered on the registered host applies to the alias the site is served from (and vice versa via redirect)
        if (r.finalUrl.hostname !== host && aliases.has(r.finalUrl.hostname)) robots[r.finalUrl.hostname] = robots[host];
        if (hostAliases[host] && !(hostAliases[host]! in robots)) robots[hostAliases[host]!] = robots[host];
        for (const sm of robots[host]?.sitemaps ?? []) {
          const u = normalizeUrl(sm, robotsUrl, snap.norm);
          if (!u || scopeDecision(u, { ...snap.scope, includePatterns: [], excludePatterns: [] }) !== "OK") {
            issues.push({ category: "SITEMAP_URL_OUT_OF_SCOPE", subject: "robots.txt", evidence: { declared: displayUrl(sm), reason: "sitemap on another site is not authorised" } });
            continue;
          }
          sitemapQueue.push({ url: u, declared: true, depth: 0 });
        }
      }
      sitemapQueue.push({ url: new URL("/sitemap.xml", snap.origin), declared: false, depth: 0 });
      for (const p of snap.sitemaps) sitemapQueue.push({ url: new URL(p, snap.origin), declared: true, depth: 0 });
      while (sitemapQueue.length && sitemapCount < 20 && Date.now() < hardDeadline) {
        const sm = sitemapQueue.shift()!;
        if (sitemapSeen.has(sm.url.href)) {
          if (sm.depth > 0) issues.push({ category: "SITEMAP_LOOP", subject: displayUrl(sm.url), evidence: { note: "referenced again by a sitemap index" } });
          continue;
        }
        sitemapSeen.add(sm.url.href);
        sitemapCount++;
        const r = await guardedFetch(sm.url, { readBody: true });
        if (r.error && INFRA.has(r.error)) { overheadRequests++; throw new TransientError(`gateway unavailable (${r.error})`); }
        if (r.error === EGRESS_BUDGET_EXHAUSTED) break; // not the sitemap's fault; the crawl stops as REQUEST_BUDGET
        if (r.status !== 200 || !r.body) {
          if (sm.declared || sm.depth > 0) issues.push({ category: "SITEMAP_UNREACHABLE", subject: displayUrl(sm.url), evidence: { status: r.status, error: r.error } });
          continue;
        }
        // a sitemap cut at the size limit is "too large", not "invalid": the entries read so far are used
        const parsed = parseSitemap(r.body.toString("utf8"), 50_000, r.truncated);
        badLastmod += parsed.badLastmod;
        if (parsed.kind === "invalid") { issues.push({ category: "SITEMAP_INVALID", subject: displayUrl(sm.url), evidence: { bytes: r.bytes, truncated: r.truncated } }); continue; }
        if (r.truncated || parsed.truncated) issues.push({ category: "SITEMAP_TOO_LARGE", subject: displayUrl(sm.url), evidence: { bytesRead: r.bytes, entriesUsed: parsed.locs.length } });
        for (const loc of parsed.locs) {
          const u = normalizeUrl(loc, sm.url, snap.norm);
          if (!u) continue;
          const decision = scopeDecision(u, snap.scope);
          if (parsed.kind === "index") {
            if (decision === "OK" || decision === "NOT_INCLUDED" || decision === "EXCLUDED") {
              if (snap.scope.hosts.includes(u.hostname)) { if (sm.depth < 3) sitemapQueue.push({ url: u, declared: true, depth: sm.depth + 1 }); continue; }
            }
            outOfScope++;
            continue;
          }
          sitemapUrls++;
          if (!snap.scope.hosts.includes(u.hostname)) { outOfScope++; continue; }
          if (decision !== "OK") continue;
          pageRows.push({ url: u, source: "SITEMAP", inSitemap: true, depth: 0 });
        }
      }
      if (outOfScope) issues.push({ category: "SITEMAP_URL_OUT_OF_SCOPE", subject: "sitemap", evidence: { urls: outOfScope } });
      if (badLastmod) issues.push({ category: "SITEMAP_BAD_LASTMOD", subject: "sitemap", evidence: { entries: badLastmod } });
      for (const p of snap.startPaths) {
        const u = normalizeUrl(p, snap.origin, snap.norm);
        if (u && scopeDecision(u, snap.scope) === "OK") pageRows.unshift({ url: u, source: "START", inSitemap: false, depth: 0 });
      }
      const disc = { robots, issues, sitemaps: { fetched: sitemapCount, urls: sitemapUrls, outOfScope }, browserDone: false, hostAliases };
      // Dedupe and cap BEFORE touching the database: a 50,000-entry sitemap must not become 50,000 statements.
      const unique = new Map<string, (typeof pageRows)[number]>();
      for (const p of pageRows) {
        const prev = unique.get(p.url.href);
        if (!prev) unique.set(p.url.href, p);
        else prev.inSitemap ||= p.inSitemap;
      }
      const all = [...unique.values()];
      await withSystem(d.db, async (tx) => {
        const [{ pages }] = await tx.$queryRaw<Array<{ pages: number }>>`SELECT count(*)::int AS pages FROM deep_scan_urls WHERE execution_id = ${ctx.executionId}::uuid AND kind = 'PAGE'`;
        const room = Math.max(0, snap.limits.maxPages - pages);
        const plan = new FrontierPlan();
        for (const p of all.slice(0, room)) plan.add(p.url, "PAGE", p.source, p.depth, null, p.inSitemap);
        // one statement: the start/sitemap pages, what didn't fit, and the discovery record
        await tx.$queryRawUnsafe(`
          WITH ins AS (${FRONTIER_UPSERT})
          UPDATE deep_scans SET pages_dropped = pages_dropped + $14::int, discovery = $15::jsonb, requests = $16::int, updated_at = now(),
                 -- every page the scan knows about (start page, sitemap, links, browser) — not only pages found through links
                 pages_discovered = pages_discovered + (SELECT count(*)::int FROM ins WHERE inserted AND kind = 'PAGE' AND source <> 'SEARCH')
           WHERE execution_id = $1::uuid RETURNING 1`,
          ctx.executionId, ctx.orgId, ctx.websiteId, ...plan.arrays(), Math.max(0, all.length - room), JSON.stringify(disc), requests);
      });
      return disc;
    }

    /**
     * Render pages in the browser, one runner session per group (a new session when one's lifetime is used up).
     * Every rendered page counts against the scan-wide `browserPages` budget (also when it fails) and is never rendered
     * twice. Rendering stops when the budget is spent, fewer than BROWSER_MIN_REMAINING_MS remain before the scan's
     * deadline, the scan is aborted, or the runner is unavailable. Returns each page's rendered in-scope links.
     */
    async function renderPages(items: Array<{ u: URL; depth: number }>, opts: { done?: boolean } = {}): Promise<URL[]> {
      const t0 = Date.now();
      const found: URL[] = [];
      const todo = items.filter((x) => !browser.rendered.has(x.u.href));
      const canRender = () => !aborted() && !browser.unavailable && browser.rendered.size < snap.limits.browserPages && hardDeadline - Date.now() >= BROWSER_MIN_REMAINING_MS;
      while (todo.length && canRender()) {
        const before = todo.length;
        const sessionStart = Date.now();
        const sessionLeft = () => Date.now() < sessionStart + BROWSER_SESSION_MS - BROWSER_SESSION_RESERVE_MS;
        const token = signCapability(d.tokenSecret, { o: ctx.orgId, w: ctx.websiteId, e: ctx.executionId, k: "deepscan-browser" }, 300);
        try {
          const sess = await openSession(d.runnerUrl!, token, BROWSER_SESSION_MS, ctx.executionId);
          try {
            while (todo.length && canRender() && sessionLeft()) {
              const { u, depth } = todo.shift()!;
              if (browser.rendered.has(u.href)) continue;
              browser.rendered.add(u.href);
              found.push(...(await renderOne(sess.browser, u, depth)));
            }
          } finally {
            await sess.close();
          }
        } catch (e) {
          if (aborted()) break;
          browser.unavailable = true; // no further sessions in this attempt
          d.log.warn({ err: (e as Error).message.slice(0, 120) }, "browser-assisted discovery unavailable; continuing without it");
        }
        if (todo.length === before) break; // no progress in this session
      }
      const ms = Date.now() - t0;
      const rec = { ...(opts.done ? { browserDone: true } : {}), spa: browser.spa, browserRendered: [...browser.rendered], browserInteraction: browser.interaction };
      await withSystem(d.db, async (tx) => {
        await tx.$executeRaw`
          UPDATE deep_scans SET discovery = discovery || ${JSON.stringify(rec)}::jsonb, browser_ms = browser_ms + ${ms}, updated_at = now()
           WHERE execution_id = ${ctx.executionId}::uuid`;
        await addUsage(tx, ctx.orgId, { "deepscan.browser_ms": ms });
      });
      return found;
    }

    /** Render one page, reveal links behind safe interactions, add its rendered-only in-scope links (depth + 1). */
    async function renderOne(b: Awaited<ReturnType<typeof openSession>>["browser"], u: URL, depth: number): Promise<URL[]> {
      const c = await b.newContext({ acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true });
      try {
        const page = await c.newPage();
        const baseline = new Set<string>();
        page.on("request", (r) => { if (baseline.size < 5000) baseline.add(r.url()); });
        await polite();
        await page.goto(u.href, { waitUntil: "load", timeout: 20_000 });
        // listing pages often fetch their entries after load: wait (briefly) for the network to settle
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
        const seen = new Map<string, FoundBy>();
        for (const h of await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href).slice(0, 2000))) seen.set(h, "render");
        // links behind tabs / accordions, carousels, "load more", infinite scroll, hover menus and one JavaScript search
        // (at most MAX_JS_SEARCHES_PER_SCAN per scan) — every interaction behind the request guard
        const stats = await revealLinks(c, page, {
          firstParty: (x) => { try { return snap.scope.hosts.includes(new URL(x).hostname); } catch { return false; } },
          baseline, end: hardDeadline - BROWSER_MIN_REMAINING_MS / 2, polite, links: seen,
          searchAllowed: browser.interaction.search < MAX_JS_SEARCHES_PER_SCAN, hovered: browser.hovered,
        });
        const bi = browser.interaction;
        if (stats.actions) bi.pages++;
        bi.actions += stats.actions; bi.scroll += stats.scroll; bi.loadMore += stats.loadMore; bi.toggle += stats.toggle; bi.details += stats.details; bi.refused += stats.refused;
        bi.hover += stats.hover; bi.carousel += stats.carousel; bi.carousels += stats.carousels; bi.search += stats.search;
        if (stats.searchNavigated) bi.searchNavigations++;
        if (stats.navigationRefused) bi.navigationsRefused++;
        await c.close().catch(() => undefined); // nothing runs in the page while we compare with the static HTML
        const staticLinks = new Set<string>();
        await polite();
        const st = await fetchChain(u, fd, snap.scope, snap.norm, { readBody: true, maxRedirects: 10 });
        // no static HTML to compare with: nothing can be labelled render-only (the crawl stops before its next page)
        if (st.error === EGRESS_BUDGET_EXHAUSTED) { budgetExhausted = true; return []; }
        if (st.body) for (const l of analyzeHtml(st.body.toString("utf8")).out.links) { const x = normalizeUrl(l.href, st.finalUrl, snap.norm); if (x) staticLinks.add(x.href); }
        const unique = new Map<string, { x: URL; via: FoundBy }>();
        for (const [h, via] of seen) { const x = normalizeUrl(h, u, snap.norm); if (x && scopeDecision(x, snap.scope) === "OK" && !unique.has(x.href)) unique.set(x.href, { x, via }); }
        const rendered = [...unique.values()];
        // links in the HTML are found by the crawl itself; only the ones JavaScript added are new
        const onlyRendered = rendered.filter((r) => !staticLinks.has(r.x.href) && !linkedFileType(r.x));
        if (onlyRendered.length && depth + 1 <= snap.limits.maxDepth) {
          const [hs, ts, ps] = candidates(onlyRendered.map((r) => r.x));
          await withSystem(d.db, async (tx) => {
            const [fs] = await tx.$queryRawUnsafe<FrontierState[]>(FRONTIER_STATE, ctx.executionId, hs, ts, ps);
            const plan = new FrontierPlan(fs);
            for (const { x } of onlyRendered) {
              if (plan.count.PAGE >= snap.limits.maxPages) break;
              if (plan.trapped(x)) continue;
              plan.add(x, "PAGE", "BROWSER", depth + 1, displayUrl(u), false);
            }
            await writePlan(tx, plan);
          });
        }
        if (onlyRendered.length) {
          const foundBy: Partial<Record<FoundBy, number>> = {};
          for (const r of onlyRendered) foundBy[r.via] = (foundBy[r.via] ?? 0) + 1;
          browser.spa.push({ page: displayUrl(u), links: onlyRendered.length, foundBy });
        }
        return rendered.map((r) => r.x);
      } catch (e) {
        if (aborted()) throw e;
        d.log.debug({ page: displayUrl(u), err: (e as Error).message.slice(0, 120) }, "browser-assisted discovery: page not rendered");
        return [];
      } finally {
        await c.close().catch(() => undefined);
      }
    }

    /** Before the crawl: the start pages, then top-level listing pages (sitemap, then the start pages' rendered links). */
    async function browserDiscovery() {
      const limit = snap.limits.browserPages;
      const starts = snap.startPaths.map((p) => normalizeUrl(p, snap.origin, snap.norm)).filter(renderable);
      const startLinks = await renderPages(selectBrowserPages(starts, [], [], limit).map((u) => ({ u, depth: 0 })));
      // the sitemap's pages are read from the frontier, so a resumed attempt sees them too
      const rows = await withSystem(d.db, (tx) => tx.$queryRaw<Array<{ url: string; depth: number }>>`
        SELECT url, depth FROM deep_scan_urls WHERE execution_id = ${ctx.executionId}::uuid AND kind = 'PAGE' AND in_sitemap ORDER BY id LIMIT 5000`);
      const depthOf = new Map(rows.map((r) => [r.url, r.depth]));
      const sitemap = rows.map((r) => normalizeUrl(r.url, null, snap.norm)).filter(renderable);
      const listings = selectBrowserPages(starts, sitemap, startLinks.filter(renderable), limit).slice(starts.length);
      await renderPages(listings.map((u) => ({ u, depth: depthOf.get(u.href) ?? 1 })), { done: true });
    }

    /** During the crawl: render a batch of queued client-rendered pages. */
    async function renderQueued() {
      const batch = browser.queue.splice(0, BROWSER_BATCH);
      if (browser.unavailable) { browser.queue.length = 0; return; }
      const items = batch.flatMap((q) => { const u = normalizeUrl(q.url, null, snap.norm); return renderable(u) && u.href === q.url ? [{ u, depth: q.depth }] : []; });
      await renderPages(items);
      if (browser.rendered.size >= snap.limits.browserPages || hardDeadline - Date.now() < BROWSER_MIN_REMAINING_MS) browser.queue.length = 0;
    }

    function renderable(u: URL | null): u is URL {
      if (!u || scopeDecision(u, snap.scope) !== "OK") return false;
      const rb = snap.respectRobots ? robotsFor(u) : null;
      return !rb || robotsAllows(rb, SCANNER_AGENT, u).allowed;
    }

    /** Is a crawled page client-rendered? Then it is queued for rendering (when the budget has room). */
    function maybeQueueRender(u: URL, depth: number, analysed: ReturnType<typeof analyzeHtml>, links: Array<URL | null>): boolean {
      if (!browser.enabled) return false;
      let contentLinks = 0;
      analysed.out.links.forEach((l, i) => { const x = links[i]; if (!l.chrome && x && x.href !== u.href && scopeDecision(x, snap.scope) === "OK") contentLinks++; });
      if (!looksClientRendered({ framework: analysed.facts.clientShell.framework, contentLinks, emptyContainers: analysed.facts.clientShell.emptyContainers })) return false;
      if (!browser.unavailable && !browser.rendered.has(u.href) && browser.rendered.size + browser.queue.length < snap.limits.browserPages && !browser.queue.some((q) => q.url === u.href)) {
        browser.queue.push({ url: u.href, depth });
      }
      return true;
    }

    async function crawlPage(row: { id: bigint; url: string; depth: number; in_sitemap: boolean }): Promise<"DONE" | "INFRA" | "SKIPPED" | "BUDGET"> {
      // Re-validate the stored URL from trusted scan state before every fetch.
      const u = normalizeUrl(row.url, null, snap.norm);
      let skip: string | null = !u || u.href !== row.url ? "INVALID_URL" : scopeDecision(u, snap.scope);
      if (skip === "OK" && row.depth > snap.limits.maxDepth) skip = "DEPTH_LIMIT";
      if (skip === "OK" && snap.respectRobots) { const rb = robotsFor(u!); if (rb && !robotsAllows(rb, SCANNER_AGENT, u!).allowed) skip = "ROBOTS_DISALLOWED"; }
      if (skip !== "OK") {
        await withSystem(d.db, (tx) => markSkipped(tx, row.id, skip!));
        return "SKIPPED";
      }
      const r = await guardedFetch(u!, { readBody: true });
      if (r.error === "EGRESS_UNAUTHORIZED") throw new SecurityError("egress gateway rejected the scanner's capability");
      if (r.error === "ABORTED") throw new Error("aborted");
      if (r.error === EGRESS_BUDGET_EXHAUSTED) return "BUDGET";
      if (r.error && INFRA.has(r.error)) return "INFRA";
      // A redirecting URL gets redirect findings only; its target is crawled (and analysed) as its own page.
      const redirected = r.chain.length > 0;
      const html = !redirected && r.status !== null && r.status >= 200 && r.status < 300 && r.body && /^(text\/html|application\/xhtml\+xml)/i.test(r.contentType ?? "");
      const analysed = html ? analyzeHtml(r.body!.toString("utf8")) : null;
      const blocked = r.error && /^BLOCKED_|^NO_ADDRESSES$/.test(r.error) ? r.error : null;
      const state = blocked ? "SKIPPED" : r.error && r.error !== "REDIRECT_LOOP" && r.error !== "TOO_MANY_REDIRECTS" ? "FAILED" : r.status !== null && r.status >= 400 ? "FAILED" : "DONE";
      const facts = analysed ? { ...analysed.facts, template: pathTemplate(u!), xRobots: r.xRobots, lastModified: r.lastModified, malformedLinks: analysed.out.malformedLinks, truncated: r.truncated } : { template: pathTemplate(u!), xRobots: r.xRobots };
      // Outgoing URLs, normalised in memory; the frontier is read once and written once for the whole page.
      const ok = state === "DONE";
      const referrer = displayUrl(u!);
      const base = r.finalUrl;
      const redirectTarget = redirected && ok && scopeDecision(r.finalUrl, snap.scope) === "OK" ? r.finalUrl : null;
      const links = analysed && ok ? analysed.out.links.map((l) => normalizeUrl(l.href, base, snap.norm)) : [];
      if (analysed && ok && !redirected && maybeQueueRender(u!, row.depth, analysed, links)) (facts as Record<string, unknown>).clientRendered = true;
      const probes = analysed && ok ? searchProbes(analysed.facts.forms, base) : [];
      const resources = analysed && ok && snap.checkResources ? analysed.out.resources.map((x) => ({ x: normalizeUrl(x.href, base, snap.norm), type: x.type })) : [];
      const [hashes, templates, paths] = candidates([redirectTarget, ...links, ...probes, ...resources.map((x) => x.x)]);
      await withSystem(d.db, async (tx) => {
        // the state guard makes the page (and its usage) count exactly once, even if a crash replays it
        const [st] = await tx.$queryRawUnsafe<Array<FrontierState & { won: number }>>(`
          WITH won AS (
            UPDATE deep_scan_urls SET state = $5::text, skip_reason = $6::text, status_code = $7::int, final_url = $8::text, redirect_chain = $9::jsonb,
                   content_type = $10::text, bytes = $11::int, duration_ms = $12::int, facts = $13::jsonb, error = $14::text, checked_at = now()
             WHERE id = $15::bigint AND state = 'QUEUED' RETURNING id)
          SELECT (SELECT count(*)::int FROM won) AS won, s.* FROM (${FRONTIER_STATE}) s`,
          ctx.executionId, hashes, templates, paths,
          state, blocked, r.status, displayUrl(r.finalUrl), JSON.stringify(r.chain), r.contentType?.slice(0, 100) ?? null, r.bytes, r.durationMs,
          JSON.stringify({ ...facts, outOfScopeRedirect: r.outOfScopeRedirect }), r.error, row.id);
        if (!st?.won) return;
        // Plan with exactly the per-link rules (applied in link order against the counts as they grow).
        const plan = new FrontierPlan(st);
        let external = 0, dropped = 0;
        if (redirectTarget && plan.count.PAGE < snap.limits.maxPages) plan.add(redirectTarget, "PAGE", "CRAWL", row.depth, referrer, false);
        for (const x of links) {
          if (!x) continue;
          const decision = scopeDecision(x, snap.scope);
          if (!snap.scope.hosts.includes(x.hostname)) {
            external++;
            // IP-literal links (routers, metadata, mapped IPv6…) are never requested, not even via the gateway
            if (isIP(x.hostname.replace(/^\[|\]$/g, ""))) continue;
            if (snap.limits.externalLinks && plan.count.EXTERNAL < snap.limits.maxExternalLinks) plan.add(x, "EXTERNAL", "CRAWL", row.depth + 1, referrer, false);
            continue;
          }
          if (decision !== "OK") continue;
          // beyond the depth, in a trap, or beyond maxPages: a URL not yet in the frontier counts as dropped
          // a link to an image / document / media file is a resource, not a page: it must not use up the page budget
          const fileType = linkedFileType(x);
          if (fileType) { if (plan.count.RESOURCE < snap.limits.maxPages * 5) plan.add(x, "RESOURCE", "CRAWL", row.depth + 1, referrer, false, fileType); continue; }
          if (row.depth + 1 > snap.limits.maxDepth || plan.trapped(x) || plan.count.PAGE >= snap.limits.maxPages) { if (!plan.has(x)) dropped++; continue; }
          plan.add(x, "PAGE", "CRAWL", row.depth + 1, referrer, false);
        }
        // Site search: each distinct GET search form once with a harmless test query (read-only, like any crawled
        // link; POST forms are never submitted). Its result page is crawled as a SEARCH page.
        for (const probe of probes) {
          if (plan.count.SEARCH >= MAX_SEARCH_PROBES) break;
          plan.add(probe, "PAGE", "SEARCH", row.depth + 1, referrer, false);
        }
        for (const { x, type } of resources) {
          if (!x || !snap.scope.hosts.includes(x.hostname)) continue; // third-party resources are not ours to probe
          if (plan.count.RESOURCE >= snap.limits.maxPages * 5) break;
          plan.add(x, "RESOURCE", "CRAWL", row.depth + 1, referrer, false, type);
        }
        // one statement: frontier rows, scan progress (incl. dropped / discovered), usage
        const [keys, values] = usageArrays({ "deepscan.pages": state === "SKIPPED" ? 0 : 1, "deepscan.bytes": r.bytes, "deepscan.requests": 1 + r.chain.length, "deepscan.external_links_seen": external });
        await tx.$queryRawUnsafe(`
          WITH ins AS (${FRONTIER_UPSERT}),
          scan AS (
            UPDATE deep_scans SET pages_completed = pages_completed + $14::int, pages_failed = pages_failed + $15::int, pages_skipped = pages_skipped + $16::int,
                   pages_discovered = pages_discovered + (SELECT count(*)::int FROM ins WHERE inserted AND kind = 'PAGE' AND source <> 'SEARCH'),
                   pages_dropped = pages_dropped + $17::int, requests = $18::int, bytes = bytes + $19::bigint, updated_at = now()
             WHERE execution_id = $1::uuid RETURNING 1),
          usage AS (${usageUpsert(20, 21)})
          SELECT count(*)::int AS n FROM ins`,
          ctx.executionId, ctx.orgId, ctx.websiteId, ...plan.arrays(),
          state === "DONE" ? 1 : 0, state === "FAILED" ? 1 : 0, state === "SKIPPED" ? 1 : 0, dropped, requests, r.bytes, keys, values);
      });
      return state === "SKIPPED" ? "SKIPPED" : "DONE";
    }

    /** The probe URL of each distinct GET search form that can be submitted without JavaScript, in page order. */
    function searchProbes(forms: HtmlForm[], base: URL): URL[] {
      const out: URL[] = [];
      for (const fm of forms) {
        if (!fm.search || fm.method !== "GET" || !fm.queryField) continue;
        const target = normalizeUrl(fm.action?.trim() ? fm.action : base.href, base, snap.norm);
        if (!target || scopeDecision(target, snap.scope) !== "OK") continue;
        target.searchParams.set(fm.queryField, SEARCH_PROBE_TERM);
        const probe = normalizeUrl(target.href, null, snap.norm);
        if (!probe || probe.searchParams.get(fm.queryField) !== SEARCH_PROBE_TERM) continue; // query params ignored by config
        out.push(probe);
      }
      return out;
    }

    async function checkResource(row: { id: bigint; url: string; kind: string }): Promise<"DONE" | "INFRA" | "BUDGET"> {
      const u = normalizeUrl(row.url, null, snap.norm);
      if (!u || (row.kind === "RESOURCE" && !snap.scope.hosts.includes(u.hostname))) {
        await withSystem(d.db, (tx) => markSkipped(tx, row.id, "OUT_OF_SCOPE"));
        return "DONE";
      }
      // external links: status only, host-bound capability, never followed beyond redirects, never parsed
      const r = await guardedFetch(u, { method: "HEAD", readBody: false });
      if (r.error === EGRESS_BUDGET_EXHAUSTED) return "BUDGET";
      if (r.error && INFRA.has(r.error)) return "INFRA";
      const state = r.error ? (/^BLOCKED_/.test(r.error) ? "SKIPPED" : "FAILED") : r.status !== null && r.status >= 400 ? "FAILED" : "DONE";
      const [keys, values] = usageArrays({ "deepscan.resources": 1, "deepscan.requests": 1 });
      // one statement: the result, scan progress and usage, all guarded by the QUEUED → checked transition
      await withSystem(d.db, (tx) => tx.$queryRaw`
        WITH won AS (
          UPDATE deep_scan_urls SET state = ${state}, status_code = ${r.status}, final_url = ${displayUrl(r.finalUrl)}, content_type = ${r.contentType?.slice(0, 100) ?? null},
                 bytes = ${r.bytes}, duration_ms = ${r.durationMs}, error = ${r.error}, skip_reason = ${state === "SKIPPED" ? r.error : null}, checked_at = now()
           WHERE id = ${row.id} AND state = 'QUEUED' RETURNING id),
        scan AS (
          UPDATE deep_scans SET resources_checked = resources_checked + 1, requests = ${requests}, updated_at = now()
           WHERE execution_id = ${ctx.executionId}::uuid AND EXISTS (SELECT 1 FROM won) RETURNING 1),
        usage AS (
          INSERT INTO usage_counters (org_id, period_start, key, value, updated_at)
          SELECT ${ctx.orgId}::uuid, (now() AT TIME ZONE 'UTC')::date, k, v, now() FROM unnest(${keys}::text[], ${values}::bigint[]) AS u(k, v)
           WHERE EXISTS (SELECT 1 FROM won)
          ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = now())
        SELECT count(*)::int AS won FROM won`);
      return "DONE";
    }

    // ---- frontier SQL (all scoped to this execution)
    /** Write a plan (no other effect); for discovery paths that run once per scan. */
    async function writePlan(tx: Tx, plan: FrontierPlan) {
      if (plan.rows.size) await tx.$queryRawUnsafe(`WITH ins AS (${FRONTIER_UPSERT})
        UPDATE deep_scans SET pages_discovered = pages_discovered + (SELECT count(*)::int FROM ins WHERE inserted AND kind = 'PAGE' AND source <> 'SEARCH'), updated_at = now()
         WHERE execution_id = $1::uuid RETURNING 1`, ctx.executionId, ctx.orgId, ctx.websiteId, ...plan.arrays());
    }
    async function markSkipped(tx: Tx, id: bigint, reason: string) {
      await tx.$queryRaw`
        WITH s AS (UPDATE deep_scan_urls SET state = 'SKIPPED', skip_reason = ${reason}, checked_at = now() WHERE id = ${id} AND state = 'QUEUED' RETURNING 1)
        UPDATE deep_scans SET pages_skipped = pages_skipped + 1, updated_at = now() WHERE execution_id = ${ctx.executionId}::uuid AND EXISTS (SELECT 1 FROM s) RETURNING 1`;
    }
  };

  /**
   * Alias hosts of the same website (domain.aliasLabels, default "www"): example.com ⇄ www.example.com are one website
   * everywhere else (identity, SDK origin check), so a site that redirects between them stays crawlable.
   */
  function aliasHosts(host: string, labels: readonly string[]): string[] {
    const lead = labels.find((l) => host.startsWith(`${l}.`) && host.split(".").length > 2);
    return lead ? [host.slice(lead.length + 1)] : labels.map((l) => `${l}.${host}`);
  }

  /** Create the scan (scope + limits snapshot) or resume it. One RUNNING scan per website (DB index). */
  async function openScan(tx: Tx, ctx: ExecutionContext, s: SettingsSnapshot) {
    const existing = await tx.$queryRaw<Array<ScanRow>>`SELECT * FROM deep_scans WHERE execution_id = ${ctx.executionId}::uuid FOR UPDATE`;
    if (existing[0]) return existing[0];
    const [w] = await tx.$queryRaw<Array<{ origin: string; deep_scan: unknown; max_pages: number | null; max_depth: number | null; include_patterns: string[]; exclude_patterns: string[]; query_param_mode: string; query_param_allowlist: string[]; respect_robots: boolean | null; trigger: string }>>`
      SELECT w.canonical_origin AS origin, mc.deep_scan, mc.max_pages, mc.max_depth, mc.include_patterns, mc.exclude_patterns, mc.query_param_mode,
             mc.query_param_allowlist, mc.respect_robots, e.trigger
        FROM websites w LEFT JOIN monitoring_configurations mc ON mc.website_id = w.id
        JOIN monitoring_executions e ON e.id = ${ctx.executionId}::uuid AND e.queued_at = ${ctx.windowStart}
       WHERE w.id = ${ctx.websiteId}::uuid AND w.org_id = ${ctx.orgId}::uuid`;
    if (!w) throw new SecurityError("website not found for the execution's organisation");
    const origin = new URL(w.origin);
    const cfg = parseDeepScanConfig(w.deep_scan);
    const limits = (await loadOrgContexts(tx, [ctx.orgId], s)).get(ctx.orgId)!.limits.deepscan;
    // Additional hosts: only hosts of OTHER verified, active websites of the SAME organisation.
    const extra = cfg.additionalHosts.length ? await tx.$queryRaw<Array<{ host: string }>>`
      SELECT lower(split_part(split_part(w.canonical_origin, '://', 2), '/', 1)) AS host FROM websites w JOIN domain_claims c ON c.id = w.domain_claim_id
       WHERE w.org_id = ${ctx.orgId}::uuid AND w.status = 'ACTIVE' AND w.archived_at IS NULL AND c.status = 'VERIFIED'
         AND lower(split_part(split_part(w.canonical_origin, '://', 2), '/', 1)) = ANY(${cfg.additionalHosts}::text[])` : [];
    const eff = effectiveScanLimits(limits, cfg, { maxPages: w.max_pages, maxDepth: w.max_depth });
    const aliasHostList = aliasHosts(origin.hostname, s["domain.aliasLabels"]);
    const snap: ScanSnapshot = {
      scope: { hosts: [...new Set([origin.hostname, ...aliasHostList, ...extra.map((x) => x.host)])], includePatterns: [...cfg.includePatterns, ...(w.include_patterns ?? [])], excludePatterns: [...cfg.excludePatterns, ...(w.exclude_patterns ?? [])] },
      norm: { queryParamMode: cfg.queryParamMode, queryParamAllowlist: [...cfg.queryParamAllowlist, ...(w.query_param_allowlist ?? [])], excludedQueryParams: cfg.excludedQueryParams },
      aliasHosts: aliasHostList.filter((h) => h !== origin.hostname), limits: eff, respectRobots: cfg.respectRobots && (w.respect_robots ?? true), checkResources: cfg.checkResources, origin: origin.origin,
      startPaths: cfg.startPaths, sitemaps: cfg.sitemaps, deadline: Date.now() + eff.maxDurationSec * 1000,
      severityOverrides: cfg.severityOverrides, incidentGroups: cfg.incidentGroups,
    };
    // A RUNNING scan of an execution that is already terminal (dead-lettered / cancelled) can't block the website forever.
    await tx.$executeRaw`
      UPDATE deep_scans s SET status = 'CANCELLED', stop_reason = 'ABANDONED', finished_at = now(), updated_at = now()
        FROM monitoring_executions e
       WHERE s.website_id = ${ctx.websiteId}::uuid AND s.status = 'RUNNING' AND e.id = s.execution_id
         AND e.status::text NOT IN ('SCHEDULED', 'QUEUED', 'RUNNING', 'RETRYING')`;
    const [busy] = await tx.$queryRaw<Array<{ execution_id: string }>>`SELECT execution_id FROM deep_scans WHERE website_id = ${ctx.websiteId}::uuid AND status = 'RUNNING'`;
    if (busy) throw new TransientError("another deep scan of this website is running");
    await tx.$executeRaw`
      INSERT INTO deep_scans (execution_id, org_id, website_id, trigger, config) VALUES (${ctx.executionId}::uuid, ${ctx.orgId}::uuid, ${ctx.websiteId}::uuid, ${w.trigger}, ${JSON.stringify(snap)}::jsonb)`;
    const [row] = await tx.$queryRaw<Array<ScanRow>>`SELECT * FROM deep_scans WHERE execution_id = ${ctx.executionId}::uuid`;
    return row!;
  }
}

interface ScanRow { execution_id: string; status: string; config: unknown; discovery: unknown; requests: number; started_at: Date }

/** System context with a longer budget for finalisation (findings for thousands of pages in one transaction). */
async function withSystemLong<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.system', 'on', true)`;
    return fn(tx);
  }, { timeout: 300_000, maxWait: 30_000 });
}
