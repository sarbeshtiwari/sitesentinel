import { describe, expect, it } from "vitest";
import { candidates, FrontierPlan, PER_PATH_QUERY_CAP, PER_TEMPLATE_CAP, sha, usageArrays } from "../src/frontier.js";

const U = (p: string) => new URL(p, "http://site.example");

describe("FrontierPlan (one batch = the old per-link statements, in order)", () => {
  it("a URL seen twice is one row: referrers add up, first referrer kept, in_sitemap ORed; only the first is new", () => {
    const plan = new FrontierPlan({ pages: 1 });
    expect(plan.add(U("/a"), "PAGE", "CRAWL", 1, "http://site.example/", false)).toBe(true);
    expect(plan.add(U("/a"), "PAGE", "CRAWL", 1, "http://site.example/", false)).toBe(false);
    expect(plan.add(U("/a"), "RESOURCE", "CRAWL", 1, "http://site.example/", true, "image")).toBe(false);
    expect(plan.count).toMatchObject({ PAGE: 2, RESOURCE: 0 });
    expect([...plan.rows.values()]).toEqual([expect.objectContaining({ url: "http://site.example/a", kind: "PAGE", referrers: 3, inSitemap: true, firstReferrer: "http://site.example/", template: "/a" })]);
  });

  it("existing rows are merged (referrers), never counted again", () => {
    const plan = new FrontierPlan({ pages: 5, existing: [sha(U("/old").href)] });
    expect(plan.has(U("/old"))).toBe(true);
    expect(plan.add(U("/old"), "PAGE", "CRAWL", 1, "r", false)).toBe(false);
    expect(plan.add(U("/old"), "PAGE", "CRAWL", 1, "r", false)).toBe(false);
    expect(plan.count.PAGE).toBe(5);
    expect(plan.rows.get(sha(U("/old").href))!.referrers).toBe(2);
  });

  it("trap counts start from the database and grow with new PAGE rows only", () => {
    const plan = new FrontierPlan({ tpl: { "/item/{n}": PER_TEMPLATE_CAP - 1 }, q: { "http://site.example/q": PER_PATH_QUERY_CAP - 1 } });
    expect(plan.trapped(U("/item/7"))).toBe(false);
    plan.add(U("/item/7"), "PAGE", "CRAWL", 1, null, false);
    expect(plan.trapped(U("/item/8"))).toBe(true);
    expect(plan.trapped(U("/q"))).toBe(false); // the query-variant cap applies to URLs with a query only
    expect(plan.trapped(U("/q?x=1"))).toBe(false);
    plan.add(U("/q?x=1"), "RESOURCE", "CRAWL", 1, null, false); // resources don't count
    expect(plan.trapped(U("/q?x=2"))).toBe(false);
    plan.add(U("/q?x=2"), "PAGE", "CRAWL", 1, null, false);
    expect(plan.trapped(U("/q?x=3"))).toBe(true);
  });

  it("search probes count by source; arrays keep first-seen order", () => {
    const plan = new FrontierPlan({ searches: 2 });
    plan.add(U("/b"), "PAGE", "CRAWL", 1, null, false);
    plan.add(U("/s?q=test"), "PAGE", "SEARCH", 1, "r", false);
    expect(plan.count.SEARCH).toBe(3);
    const [hashes, urls, kinds, , depths, sources, sitemap, refs] = plan.arrays() as unknown[][];
    expect(urls).toEqual(["http://site.example/b", "http://site.example/s?q=test"]);
    expect(hashes).toEqual([sha("http://site.example/b"), sha("http://site.example/s?q=test")]);
    expect([kinds, depths, sources, sitemap, refs]).toEqual([["PAGE", "PAGE"], [1, 1], ["CRAWL", "SEARCH"], [false, false], [0, 1]]);
  });

  it("candidates are unique; usage arrays drop zero entries", () => {
    expect(candidates([U("/a/1"), U("/a/1"), null, U("/a/2?x=1")])).toEqual([[sha("http://site.example/a/1"), sha("http://site.example/a/2?x=1")], ["/a/{n}"], ["http://site.example/a/1", "http://site.example/a/2"]]);
    expect(usageArrays({ a: 1, b: 0, c: 2.6 })).toEqual([["a", "c"], [1, 3]]);
  });
});
