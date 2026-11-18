import { describe, expect, it } from "vitest";
import { suggestReplacement } from "../src/finalize.js";

describe("suggested replacement for a broken sitemap URL", () => {
  const working = ["https://s.example/projects/jewel-farms", "https://s.example/projects/jewel-of-india", "https://s.example/construction-updates/jewel-farms/", "https://s.example/about-us"];
  it("same last segment wins, shortest path first", () => {
    expect(suggestReplacement("https://s.example/jewel-farms", working)).toBe("https://s.example/projects/jewel-farms");
  });
  it("matches the stem of a phase/number suffix", () => {
    expect(suggestReplacement("https://s.example/jewel-of-india-phase-2", working)).toBe("https://s.example/projects/jewel-of-india");
  });
  it("no plausible match → null", () => {
    expect(suggestReplacement("https://s.example/careers", working)).toBeNull();
    expect(suggestReplacement("https://s.example/", working)).toBeNull();
  });
});
