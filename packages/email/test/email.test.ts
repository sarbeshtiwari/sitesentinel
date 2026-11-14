import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ResendEmailProvider, SesEmailProvider, EmailSendError, templates, esc, createEmailProvider } from "../src/index.js";

const branding = { productName: "SiteSentinel", primaryColor: "#2563eb", supportEmail: "help@example.test", logoUrl: null };
const msg = { to: "a@example.test", from: "SiteSentinel <no-reply@example.test>", subject: "s", html: "<p>h</p>", text: "t", idempotencyKey: "k1" };

describe("templates", () => {
  it("escape all interpolated values (no HTML injection from names/org names)", () => {
    const r = templates.invitation(branding, {
      orgName: "<script>alert(1)</script>", inviterName: "Eve\"'", roleName: "Admin",
      url: "https://app.test/i?t=1&x=2", expiresAt: "2026-11-20",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("https://app.test/i?t=1&amp;x=2");
    expect(r.text).toContain("https://app.test/i?t=1&x=2");
    expect(r.subject).toContain("SiteSentinel");
  });
  it("use configurable branding", () => {
    const r = templates.verifyEmail({ ...branding, productName: "Acme Watch" }, { name: "Ana", url: "https://x.test/v", ttlHours: 24 });
    expect(r.subject).toBe("Verify your email address – Acme Watch");
    expect(r.html).toContain("Acme Watch");
  });
  it("esc", () => expect(esc(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;"));
});

describe("ResendEmailProvider", () => {
  let server: Server;
  let url = "";
  let last: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> } | undefined;
  let status = 200;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        last = { headers: req.headers, body: JSON.parse(data) };
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "re_123" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("posts the message with auth and idempotency headers", async () => {
    status = 200;
    const out = await new ResendEmailProvider("re_test_key", url).send(msg);
    expect(out).toEqual({ provider: "resend", providerMessageId: "re_123" });
    expect(last!.headers.authorization).toBe("Bearer re_test_key");
    expect(last!.headers["idempotency-key"]).toBe("k1");
    expect(last!.body).toMatchObject({ from: msg.from, to: [msg.to], subject: "s", html: "<p>h</p>", text: "t" });
  });
  it("classifies 4xx as permanent and 5xx/429 as retryable", async () => {
    status = 422;
    await expect(new ResendEmailProvider("k", url).send(msg)).rejects.toMatchObject({ retryable: false });
    status = 503;
    await expect(new ResendEmailProvider("k", url).send(msg)).rejects.toMatchObject({ retryable: true });
    status = 429;
    await expect(new ResendEmailProvider("k", url).send(msg)).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe("SesEmailProvider", () => {
  it("builds a SESv2 SendEmail command", async () => {
    let input: Record<string, unknown> | undefined;
    const client = { send: async (cmd: { input: Record<string, unknown> }) => { input = cmd.input; return { MessageId: "ses-1" }; } };
    const out = await new SesEmailProvider(client as never, "cfg").send(msg);
    expect(out.providerMessageId).toBe("ses-1");
    expect(input).toMatchObject({ FromEmailAddress: msg.from, Destination: { ToAddresses: [msg.to] }, ConfigurationSetName: "cfg" });
  });
  it("maps throttling to retryable", async () => {
    const client = { send: async () => { throw Object.assign(new Error("x"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } }); } };
    await expect(new SesEmailProvider(client as never).send(msg)).rejects.toMatchObject({ retryable: true });
  });
});

describe("createEmailProvider", () => {
  it("selects providers from env and rejects unknown ones", () => {
    expect(createEmailProvider({ EMAIL_PROVIDER: "smtp" }).name).toBe("smtp");
    expect(createEmailProvider({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }).name).toBe("resend");
    expect(() => createEmailProvider({ EMAIL_PROVIDER: "resend" })).toThrow();
    expect(() => createEmailProvider({ EMAIL_PROVIDER: "pigeon" })).toThrow();
  });
});
