import { createHash } from "node:crypto";
import { pathTemplate } from "@wim/core";

/**
 * Set-based frontier writes. A page's outgoing links, search probes and resources are planned IN MEMORY against one
 * snapshot of the frontier (counts + which candidate URLs already exist), applying exactly the rules the engine used
 * to apply with one statement per link; the plan is then written with ONE INSERT … SELECT FROM unnest(…) ON CONFLICT.
 * The plan reproduces the sequential semantics: a URL seen twice is one row whose referrers add up, in_sitemap ORs and
 * first_referrer keeps the first non-null one; counts (pages per kind, per trap template, per path's query variants,
 * search probes) grow only for rows that are new.
 */
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const PER_TEMPLATE_CAP = 50; // trap guard: at most N URLs per numeric path template
export const PER_PATH_QUERY_CAP = 20; // trap guard: at most N query variants per path

export type UrlKind = "PAGE" | "RESOURCE" | "EXTERNAL";
interface PlannedRow { hash: string; url: string; kind: UrlKind; resourceType: string | null; depth: number; source: string; inSitemap: boolean; referrers: number; firstReferrer: string | null; template: string }

/** What one statement reads before a page's links are planned (see {@link frontierStateSql}). */
export interface FrontierState { pages: number; externals: number; resources: number; searches: number; existing: string[]; tpl: Record<string, number>; q: Record<string, number> }

export const pathKey = (u: URL) => `${u.origin}${u.pathname}`;

export class FrontierPlan {
  readonly rows = new Map<string, PlannedRow>();
  readonly count: Record<UrlKind | "SEARCH", number>;
  private readonly known: Set<string>;
  private readonly tpl: Map<string, number>;
  private readonly q: Map<string, number>;

  constructor(st: Partial<FrontierState> = {}) {
    this.count = { PAGE: st.pages ?? 0, EXTERNAL: st.externals ?? 0, RESOURCE: st.resources ?? 0, SEARCH: st.searches ?? 0 };
    this.known = new Set(st.existing ?? []);
    this.tpl = new Map(Object.entries(st.tpl ?? {}));
    this.q = new Map(Object.entries(st.q ?? {}));
  }

  /** the URL is already in the frontier (any kind), or planned in this batch */
  has(u: URL) { return this.known.has(sha(u.href)); }

  /** crawler-trap guard: bounded PAGE rows per numeric path template and per path's query variants */
  trapped(u: URL) {
    return (this.tpl.get(pathTemplate(u)) ?? 0) >= PER_TEMPLATE_CAP || Boolean(u.search && (this.q.get(pathKey(u)) ?? 0) >= PER_PATH_QUERY_CAP);
  }

  /** Same contract as one INSERT … ON CONFLICT merge: true when the row is new. */
  add(u: URL, kind: UrlKind, source: string, depth: number, referrer: string | null, inSitemap: boolean, resourceType: string | null = null): boolean {
    const hash = sha(u.href);
    const ref = referrer ? 1 : 0;
    const planned = this.rows.get(hash);
    if (planned) {
      planned.referrers += ref;
      planned.inSitemap ||= inSitemap;
      planned.firstReferrer ??= referrer;
      return false;
    }
    const isNew = !this.known.has(hash);
    // a merge into an existing row only changes referrers / in_sitemap / first_referrer (the other values are ignored)
    this.rows.set(hash, { hash, url: u.href, kind, resourceType, depth, source, inSitemap, referrers: ref, firstReferrer: referrer, template: pathTemplate(u) });
    if (!isNew) return false;
    this.known.add(hash);
    this.count[kind]++;
    if (source === "SEARCH") this.count.SEARCH++;
    if (kind === "PAGE") {
      const t = pathTemplate(u), p = pathKey(u);
      this.tpl.set(t, (this.tpl.get(t) ?? 0) + 1);
      this.q.set(p, (this.q.get(p) ?? 0) + 1);
    }
    return true;
  }

  /** the unnest(…) column arrays, in first-seen order (ids, and so crawl order, follow it) */
  arrays(): unknown[] {
    const r = [...this.rows.values()];
    return [
      r.map((x) => x.hash), r.map((x) => x.url), r.map((x) => x.kind), r.map((x) => x.resourceType), r.map((x) => x.depth), r.map((x) => x.source),
      r.map((x) => x.inSitemap), r.map((x) => x.referrers), r.map((x) => x.firstReferrer), r.map((x) => x.template),
    ];
  }
}

/**
 * The frontier upsert, as a CTE body. Parameters: $1 execution, $2 org, $3 website, $4…$13 the plan's arrays.
 * RETURNING kind/source of the stored row and whether it was inserted.
 */
export const FRONTIER_UPSERT = `
  INSERT INTO deep_scan_urls (execution_id, org_id, website_id, url_hash, url, kind, resource_type, depth, source, in_sitemap, referrers, first_referrer, facts)
  SELECT $1::uuid, $2::uuid, $3::uuid, t.h, t.u, t.k, t.rt, t.d, t.s, t.sm, t.r, t.fr, jsonb_build_object('template', t.tpl)
    FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[], $10::bool[], $11::int[], $12::text[], $13::text[])
         WITH ORDINALITY AS t(h, u, k, rt, d, s, sm, r, fr, tpl, ord)
   ORDER BY t.ord
  ON CONFLICT (execution_id, url_hash) DO UPDATE
    SET referrers = LEAST(deep_scan_urls.referrers + EXCLUDED.referrers, 1000000),
        in_sitemap = deep_scan_urls.in_sitemap OR EXCLUDED.in_sitemap,
        first_referrer = coalesce(deep_scan_urls.first_referrer, EXCLUDED.first_referrer)
  RETURNING kind, source, (xmax = 0) AS inserted`;

/**
 * What planning a page needs, as one SELECT: counts per kind, which candidates already exist, trap counts.
 * Parameters: $1 execution, $2 candidate hashes, $3 candidate templates, $4 candidate paths (origin + pathname).
 */
export const FRONTIER_STATE = `
  SELECT c.pages, c.externals, c.resources, c.searches,
         (SELECT coalesce(array_agg(url_hash), '{}') FROM deep_scan_urls WHERE execution_id = $1::uuid AND url_hash = ANY($2::text[])) AS existing,
         (SELECT coalesce(jsonb_object_agg(t, n), '{}'::jsonb) FROM (
            SELECT facts ->> 'template' AS t, count(*)::int AS n FROM deep_scan_urls
             WHERE execution_id = $1::uuid AND kind = 'PAGE' AND facts ->> 'template' = ANY($3::text[]) GROUP BY 1) x) AS tpl,
         (SELECT coalesce(jsonb_object_agg(p, n), '{}'::jsonb) FROM (
            SELECT split_part(url, '?', 1) AS p, count(*)::int AS n FROM deep_scan_urls
             WHERE execution_id = $1::uuid AND kind = 'PAGE' AND split_part(url, '?', 1) = ANY($4::text[]) GROUP BY 1) y) AS q
    FROM (SELECT count(*) FILTER (WHERE kind = 'PAGE')::int AS pages, count(*) FILTER (WHERE kind = 'EXTERNAL')::int AS externals,
                 count(*) FILTER (WHERE kind = 'RESOURCE')::int AS resources, count(*) FILTER (WHERE source = 'SEARCH')::int AS searches
            FROM deep_scan_urls WHERE execution_id = $1::uuid) c`;

/** Candidate URLs of a plan: their hashes, templates and paths (the keys {@link FRONTIER_STATE} looks up). */
export function candidates(urls: Iterable<URL | null | undefined>): [string[], string[], string[]] {
  const h = new Set<string>(), t = new Set<string>(), p = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    h.add(sha(u.href)); t.add(pathTemplate(u)); p.add(pathKey(u));
  }
  return [[...h], [...t], [...p]];
}

/** addUsage as a CTE body: $2 org, then the key / value arrays at the given parameter positions. */
export const usageUpsert = (keys: number, values: number) => `
  INSERT INTO usage_counters (org_id, period_start, key, value, updated_at)
  SELECT $2::uuid, (now() AT TIME ZONE 'UTC')::date, k, v, now() FROM unnest($${keys}::text[], $${values}::bigint[]) AS u(k, v)
  ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = now()`;

/** Usage entries as unnest arrays (zero entries dropped, values rounded), like addUsage. */
export function usageArrays(entries: Record<string, number>): [string[], number[]] {
  const keys = Object.keys(entries).filter((k) => entries[k]);
  return [keys, keys.map((k) => Math.round(entries[k]!))];
}

/** File links that are resources, not pages (by path extension). */
const FILE_TYPES: Array<[RegExp, string]> = [
  [/\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?)$/i, "image"],
  [/\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|gz)$/i, "other"],
  [/\.(mp4|webm|mov|m4v|mp3|wav|ogg)$/i, "other"],
];
export function linkedFileType(u: URL): string | null {
  for (const [re, t] of FILE_TYPES) if (re.test(u.pathname)) return t;
  return null;
}
