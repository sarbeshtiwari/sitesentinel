import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { SDK_MANIFEST, readSdkFile } from "../dist/index.js";

const src = readFileSync(new URL("../src/monitor.js", import.meta.url), "utf8");

describe("SDK build", () => {
  it("is small (< 6 KB gzip) and versioned with a correct SRI hash", () => {
    const code = readSdkFile(`monitor.v${SDK_MANIFEST.major}.js`);
    expect(gzipSync(code).length).toBeLessThan(6 * 1024);
    expect(code).toContain(SDK_MANIFEST.version);
    expect(SDK_MANIFEST.integrity).toBe(`sha384-${createHash("sha384").update(code).digest("base64")}`);
    expect(readSdkFile(`monitor.${SDK_MANIFEST.version}.js`)).toBe(code);
  });

  it("contains no code paths that read form values, cookies, storage secrets or request bodies", () => {
    // Static guarantees on the source: these APIs are never touched.
    // The only ".value" read is the layout-shift PerformanceEntry used for CLS.
    expect(src.match(/\.value\b/g)).toEqual([".value"]);
    expect(src).toContain("cls += e.value");
    for (const forbidden of ["document.cookie", "localStorage", "FormData", "innerText", "textContent", "innerHTML", ".body)", "getAllResponseHeaders", "keydown", "keypress", "input\""]) {
      expect(src.includes(forbidden), forbidden).toBe(false);
    }
    expect(src).toContain('credentials: "omit"');
  });

  it("sends only paths: query strings and fragments are dropped", () => {
    expect(src).toContain("p.pathname");
    expect(src).not.toMatch(/\.search\b/);
    expect(src).not.toMatch(/\.hash\b/);
  });
});
