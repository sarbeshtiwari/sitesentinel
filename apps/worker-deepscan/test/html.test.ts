import { describe, expect, it } from "vitest";
import { analyzeHtml, parseSitemap } from "../src/html.js";

describe("static HTML analysis", () => {
  it("extracts metadata, links, resources and structural / accessibility facts without executing scripts", () => {
    const { facts, out } = analyzeHtml(`<!doctype html><html lang="en"><head><title> A  page </title>
      <meta name="description" content="d"><link rel="canonical" href="/a"><meta name="viewport" content="x"><meta property="og:title" content="t">
      <meta name="robots" content="NOINDEX"><link rel="stylesheet" href="/s.css"><script src="/a.js"></script>
      <script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{broken</script><script>document.write("<a href='/x'>")</script></head>
      <body><main><h1>One</h1><h3>skip</h3><a href="/b">B</a><a href="/c"><img src="/i.png" alt="Logo"></a><a href="/d"></a><a href="javascript:void(0)">js</a>
      <button aria-label="Close"></button><button></button><img src="/n.png"><label>Name <input name="n"></label><input id="e"><label for="e">E</label><input name="q">
      <div id="x"></div><span id="x"></span></main></body></html>`);
    expect(facts).toMatchObject({ title: "A page", titleCount: 1, description: "d", canonical: "/a", robots: "noindex", lang: "en", viewport: true, openGraph: true,
      h1: 1, headingSkips: 1, hasMain: true, imgMissingAlt: 1, emptyLinks: 1, emptyButtons: 1, unlabelledControls: 1, duplicateIds: 1, jsonLd: { blocks: 2, invalid: 1 } });
    expect(out.links.map((l) => l.href)).toEqual(["/b", "/c", "/d"]); // not the document.write string; javascript: counted as malformed
    expect(out.malformedLinks).toBe(1);
    expect(out.resources.map((r) => `${r.type}:${r.href}`)).toEqual(["stylesheet:/s.css", "script:/a.js", "image:/i.png", "image:/n.png"]);
  });
  it("content hash ignores the title; structure hash follows headings and landmarks", () => {
    const a = analyzeHtml("<title>A</title><main><h1>x</h1><p>same text</p></main>").facts;
    const b = analyzeHtml("<title>B</title><main><h1>x</h1><p>same text</p></main>").facts;
    const c = analyzeHtml("<title>B</title><main><h2>x</h2><p>same text</p></main>").facts;
    expect(a.textHash).toBe(b.textHash);
    expect(b.structureHash).not.toBe(c.structureHash);
  });
  it("describes forms statically: method, action, search field, submit button, password", () => {
    const { facts } = analyzeHtml(`<body>
      <form role="search" action="/search"><input type="search" name="q"><button>Go</button></form>
      <form method="post" action="http://shop.example/login"><input name="user"><input type="password" name="pw"></form>
      <form><input type="search" aria-label="Search"></form>
      <form action="/find"><input name="query"><input type="submit" value="Find"></form>
      <form method="POST"><button type="button">Not a submit</button></form></body>`);
    expect(facts.forms).toEqual([
      { method: "GET", action: "/search", search: true, queryField: "q", submit: true, password: false },
      { method: "POST", action: "http://shop.example/login", search: false, queryField: null, submit: false, password: true },
      { method: "GET", action: null, search: true, queryField: null, submit: false, password: false },
      { method: "GET", action: "/find", search: true, queryField: "query", submit: true, password: false },
      { method: "POST", action: null, search: false, queryField: null, submit: false, password: false },
    ]);
    expect(analyzeHtml(`<body>${"<form></form>".repeat(50)}</body>`).facts.forms).toHaveLength(20); // capped
  });
  it("bounded output for pathological pages", () => {
    const { out } = analyzeHtml(`<body>${'<a href="/x">x</a>'.repeat(10_000)}</body>`, 100, 10);
    expect(out.links).toHaveLength(100);
  });
});

describe("sitemap parsing", () => {
  it("urlset and index, bad lastmod counted", () => {
    expect(parseSitemap(`<?xml version="1.0"?><urlset xmlns="x"><url><loc> http://s/a </loc><lastmod>2026-01-02</lastmod></url><url><loc>http://s/b</loc><lastmod>yesterday</lastmod></url></urlset>`, 10))
      .toEqual({ kind: "urlset", locs: ["http://s/a", "http://s/b"], badLastmod: 1, truncated: false });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>http://s/1.xml</loc></sitemap></sitemapindex>`, 10).kind).toBe("index");
  });
  it("invalid XML, entity expansion (billion laughs) and caps", () => {
    expect(parseSitemap(`<urlset><url><loc>http://s/a</loc></url><url><loc>`, 10).kind).toBe("invalid");
    expect(parseSitemap(`<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><urlset><url><loc>&lol2;</loc></url></urlset>`, 10).kind).toBe("invalid");
    const many = `<urlset>${Array.from({ length: 50 }, (_, i) => `<url><loc>http://s/${i}</loc></url>`).join("")}</urlset>`;
    expect(parseSitemap(many, 10)).toMatchObject({ kind: "urlset", truncated: true });
    expect(parseSitemap(many, 10).locs).toHaveLength(10);
    expect(parseSitemap(`<urlset><url><loc>http://s/a</loc></url><url><loc>http://s/b`, 10, true)).toMatchObject({ kind: "urlset", locs: ["http://s/a"], truncated: true });
  });
});
