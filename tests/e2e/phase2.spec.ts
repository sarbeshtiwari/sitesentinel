import { expect, test, type Page } from "@playwright/test";
import { totp } from "../../packages/crypto/dist/index.js";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@sitesentinel.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "dev-admin-password-change-me";
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "WLEL5CGLSEMCNNH6O5GZSJCXOJBBYQNY";

/** Poll Mailpit for a message to `to` whose subject contains `subject`; return the token from its link. */
async function tokenFromEmail(to: string, subject: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json() as { messages: Array<{ ID: string; Subject: string }> };
    const hit = search.messages.find((m) => m.Subject.includes(subject));
    if (hit) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json() as { Text: string };
      const m = /token=([A-Za-z0-9_-]+)/.exec(msg.Text);
      if (m) return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}

/** A TOTP code for a step not used before (codes are single-use per 30 s step). */
async function freshCode(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const c = totp(secret);
    if (!used.has(c)) { used.add(c); return c; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${WEB}/login`);
  await page.locator("#email").fill(email);
  // The password label also contains the "Forgot password?" link, so target the input directly.
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("customer: register → verify email → sign in → create organization", async ({ page }) => {
  const email = `e2e+${Date.now()}@example.test`;
  const password = "e2e-long-unusual-passphrase-4417";

  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("E2E Tester");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const token = await tokenFromEmail(email, "Verify your email");
  await page.goto(`${WEB}/verify-email?token=${token}`);
  await expect(page.getByText("Your email address is verified.")).toBeVisible();

  // The same link can't be used twice.
  await page.goto(`${WEB}/verify-email?token=${token}`);
  await expect(page.getByText("We couldn't verify your email")).toBeVisible();

  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organization name").fill("E2E Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/overview/);
  await expect(page.getByRole("heading", { name: "E2E Org" })).toBeVisible();
  await expect(page.getByText("Owner").first()).toBeVisible();

  // The org's audit log records its creation.
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("cell", { name: "Organization created" })).toBeVisible();
});

test("customer: wrong password is rejected without revealing whether the account exists", async ({ page }) => {
  await signIn(page, `nobody+${Date.now()}@example.test`, "definitely-not-the-password");
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect email or password" })).toBeVisible();
});

test("admin: sign in with password + TOTP → aggregate overview", async ({ page }) => {
  // TOTP codes are single-use per 30 s step (replay protection). If this step's code was already
  // used (e.g. by a previous run), the login is rejected; retry once with the next step's code.
  const used = new Set<string>();
  for (let attempt = 0; attempt < 2 && !/\/overview/.test(page.url()); attempt++) {
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByLabel("Authenticator code").fill(await freshCode(ADMIN_TOTP_SECRET, used));
    await page.getByRole("button", { name: "Sign in" }).click();
    await Promise.race([
      page.waitForURL(/\/overview/, { timeout: 10_000 }).catch(() => undefined),
      page.getByRole("alert").filter({ hasText: "Incorrect email or password" }).waitFor({ timeout: 10_000 }).catch(() => undefined),
    ]);
  }
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByText("Aggregate platform statistics only")).toBeVisible();
  const users = page.locator('[data-metric="Users"] [data-metric-value]');
  await expect(users).toHaveText(/^\d[\d,]*$/);
  expect(Number((await users.textContent())!.replace(/,/g, ""))).toBeGreaterThan(0);

  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();
  // Owner emails are masked in the admin console.
  await expect(page.locator("tbody td.font-mono").first()).toHaveText(/^[^@]\*\*\*@[^.]\*\*\*/);
});
