import { describe, expect, it } from "vitest";
import { linkedFileType } from "../src/frontier.js";

describe("links to files are resources, not pages", () => {
  it("classifies by path extension, ignoring the query string", () => {
    expect(linkedFileType(new URL("https://a.example/images/news/x.JPG"))).toBe("image");
    expect(linkedFileType(new URL("https://a.example/img/y.webp?w=300"))).toBe("image");
    expect(linkedFileType(new URL("https://a.example/brochure.pdf"))).toBe("other");
    expect(linkedFileType(new URL("https://a.example/v/intro.mp4"))).toBe("other");
  });
  it("leaves pages alone", () => {
    for (const u of ["https://a.example/", "https://a.example/about-us", "https://a.example/projects?type=Residential", "https://a.example/blog.html", "https://a.example/jpg-guide"]) expect(linkedFileType(new URL(u)), u).toBeNull();
  });
});
