import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger, scrubText } from "../src/index.js";

function captured() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
  return { lines, logger: createLogger("test", { level: "info" }, stream) };
}

describe("log redaction", () => {
  it("never writes known secret fields or secret-shaped strings", () => {
    const { lines, logger } = captured();
    logger.info(
      {
        password: "hunter2hunter2",
        user: { token: "tok_abc", name: "ok" },
        req: { headers: { authorization: "Bearer abcdefghijkl", cookie: "wim_sid=xyz" } },
      },
      "login for user",
    );
    logger.info("calling https://x.test/cb?token=SUPERSECRETVALUE&x=1 with Bearer abcdefghijklmnop");
    const out = lines.join("\n");
    for (const secret of ["hunter2hunter2", "tok_abc", "abcdefghijkl", "wim_sid=xyz", "SUPERSECRETVALUE", "abcdefghijklmnop"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"name":"ok"');
    expect(out).toContain("[REDACTED]");
  });

  it("scrubText masks bearer tokens, JWTs, secret query params and API keys", () => {
    expect(scrubText("Authorization: Bearer abc.def.ghijklmno")).not.toContain("abc.def");
    expect(scrubText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl")).toBe("[REDACTED_JWT]");
    expect(scrubText("?password=pw123&next=/")).toBe("?password=[REDACTED]&next=/");
    expect(scrubText("key sk_live_1234567890abcdef")).toBe("key [REDACTED_KEY]");
  });
});
