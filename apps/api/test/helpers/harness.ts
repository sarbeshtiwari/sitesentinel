import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { totp, generateTotpSecret, hashPassword, LocalKeyProvider } from "@wim/crypto";
import { createDb } from "@wim/db";
import { startEmailWorker } from "@wim/worker-notify";
import { createApp } from "../../src/app.js";
import { KeysService } from "../../src/crypto/keys.service.js";

export interface Res<T = any> { status: number; body: T; headers: Record<string, string | string[] | undefined> }

/** A browser-like client: cookie jar, CSRF header, Origin header. */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: NestFastifyApplication,
    private readonly opts: { origin: string; csrfCookie: string; csrfPath: string },
  ) {}

  static customer(app: NestFastifyApplication) {
    return new Client(app, { origin: process.env.APP_URL!, csrfCookie: "wim_csrf", csrfPath: "/api/v1/auth/csrf" });
  }

  static admin(app: NestFastifyApplication) {
    return new Client(app, { origin: process.env.ADMIN_URL!, csrfCookie: "wim_admin_csrf", csrfPath: "/api/admin/v1/auth/csrf" });
  }

  get(url: string, extra?: { headers?: Record<string, string> }) {
    return this.request("GET", url, undefined, extra);
  }
  post(url: string, body?: unknown, extra?: { headers?: Record<string, string>; noCsrf?: boolean }) {
    return this.request("POST", url, body ?? {}, extra);
  }
  put(url: string, body?: unknown) {
    return this.request("PUT", url, body);
  }
  patch(url: string, body?: unknown) {
    return this.request("PATCH", url, body ?? {});
  }
  del(url: string) {
    return this.request("DELETE", url);
  }

  async request(method: string, url: string, body?: unknown, extra?: { headers?: Record<string, string>; noCsrf?: boolean }): Promise<Res> {
    if (method !== "GET" && !extra?.noCsrf && !this.cookies.get(this.opts.csrfCookie)) await this.get(this.opts.csrfPath);
    const headers: Record<string, string> = { origin: this.opts.origin, "user-agent": "vitest" };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && !extra?.noCsrf) headers["x-csrf-token"] = this.cookies.get(this.opts.csrfCookie) ?? "";
    if (body !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, extra?.headers);
    const r = await this.app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.cookies as Array<{ name: string; value: string; maxAge?: number; expires?: Date }>) {
      if (c.value === "" || (c.expires && c.expires.getTime() < Date.now()) || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let parsed: unknown = null;
    try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
    return { status: r.statusCode, body: parsed, headers: r.headers as Res["headers"] };
  }

  /** Copy cookies (simulates a stolen/old cookie or a second device sharing nothing). */
  clone(): Client {
    const c = new Client(this.app, this.opts);
    for (const [k, v] of this.cookies) c.cookies.set(k, v);
    return c;
  }
}

// ---------------------------------------------------------------- Mailpit
const MP = () => process.env.MAILPIT_URL!;

export async function waitForEmail(to: string, subjectIncludes: string, opts: { after?: Date; timeoutMs?: number } = {}): Promise<{ subject: string; text: string; html: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const res = await fetch(`${MP()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()) as { messages: Array<{ ID: string; Subject: string; Created: string }> };
    const hit = list.messages.find((m) => m.Subject.includes(subjectIncludes) && (!opts.after || new Date(m.Created) >= opts.after));
    if (hit) {
      const full = (await (await fetch(`${MP()}/api/v1/message/${hit.ID}`)).json()) as { Subject: string; Text: string; HTML: string };
      return { subject: full.Subject, text: full.Text, html: full.HTML };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email "${subjectIncludes}" for ${to} within timeout`);
}

export async function countEmails(to: string, subjectIncludes: string): Promise<number> {
  const res = await fetch(`${MP()}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const list = (await res.json()) as { messages: Array<{ Subject: string }> };
  return list.messages.filter((m) => m.Subject.includes(subjectIncludes)).length;
}

export function tokenFrom(text: string): string {
  const m = /[?&]token=([A-Za-z0-9_-]{20,})/.exec(text);
  if (!m) throw new Error(`No token link in email:\n${text}`);
  return m[1]!;
}

// ---------------------------------------------------------------- environment
export interface Harness {
  app: NestFastifyApplication;
  owner: pg.Client;
  stop(): Promise<void>;
}

let seq = 0;
export function uniqueEmail(tag: string): string {
  return `${tag}.${Date.now().toString(36)}${(seq++).toString(36)}@example.test`.toLowerCase();
}

export const PASSWORD = "correct-horse-battery-staple-42";

export async function startHarness(): Promise<Harness> {
  const app = await createApp();
  const worker = startEmailWorker(process.env);
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  return {
    app, owner,
    async stop() {
      await worker.stop();
      await owner.end();
      await app.close();
    },
  };
}

/** Register, verify the email through the real email, and sign in. */
export async function verifiedUser(app: NestFastifyApplication, tag = "user", name = "Test User") {
  const email = uniqueEmail(tag);
  const c = Client.customer(app);
  const reg = await c.post("/api/v1/auth/register", { email, password: PASSWORD, name, acceptTerms: true, termsVersion: "2026-11-13" });
  if (reg.status !== 202) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  const mail = await waitForEmail(email, "Verify your email");
  const v = await c.post("/api/v1/auth/verify-email", { token: tokenFrom(mail.text) });
  if (v.status !== 200) throw new Error(`verify failed ${v.status}`);
  const login = await c.post("/api/v1/auth/login", { email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed ${login.status} ${JSON.stringify(login.body)}`);
  return { client: c, email, userId: login.body.data.me.id as string };
}

export async function userWithOrg(app: NestFastifyApplication, tag = "owner") {
  const u = await verifiedUser(app, tag);
  const org = await u.client.post("/api/v1/orgs", { name: `${tag} org` });
  if (org.status !== 201) throw new Error(`org create failed ${org.status} ${JSON.stringify(org.body)}`);
  return { ...u, orgId: org.body.data.id as string };
}

/** Invite `email` into the org with `roleKey` and have `invitee` accept via the emailed token. */
export async function inviteAndAccept(inviter: Client, orgId: string, invitee: { client: Client; email: string }, roleKey: string) {
  const roles = await inviter.get(`/api/v1/orgs/${orgId}/roles`);
  const role = roles.body.data.find((r: { key: string }) => r.key === roleKey);
  const after = new Date(Date.now() - 1000);
  const inv = await inviter.post(`/api/v1/orgs/${orgId}/invitations`, { email: invitee.email, roleId: role.id });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const mail = await waitForEmail(invitee.email, "invited", { after });
  const acc = await invitee.client.post("/api/v1/invitations/accept", { token: tokenFrom(mail.text) });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  const members = await inviter.get(`/api/v1/orgs/${orgId}/members`);
  if (members.status !== 200) throw new Error(`members failed ${members.status} ${JSON.stringify(members.body)}`);
  return members.body.data.find((m: { email: string }) => m.email === invitee.email) as { id: string; userId: string };
}

/** Current TOTP code, waiting for a fresh 30 s step when `fresh` (replay protection rejects reuse). */
export async function totpCode(secret: string, fresh = false): Promise<string> {
  if (fresh) {
    const msIntoStep = Date.now() % 30_000;
    await new Promise((r) => setTimeout(r, 30_000 - msIntoStep + 50));
  }
  return totp(secret);
}

/** Create an admin account directly (what the CLI does). */
export async function createAdmin(role: string) {
  const db = createDb({ url: process.env.ADMIN_DATABASE_URL!, max: 1, omitSecrets: true });
  const keys = new KeysService(LocalKeyProvider.fromEnv());
  const id = crypto.randomUUID();
  const email = uniqueEmail(`admin-${role.toLowerCase()}`);
  const password = "admin-test-password-0123456789";
  const secret = generateTotpSecret();
  const totpSecretEnc = await keys.sealPlatform(db, "admin-secrets", secret, `admin_users.totp:${id}`);
  await db.adminUser.create({ data: { id, email, name: `Test ${role}`, role: role as never, passwordHash: await hashPassword(password), totpSecretEnc } });
  await db.$disconnect();
  return { id, email, password, secret };
}
