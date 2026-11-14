import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { totp } from "../../packages/crypto/dist/index.js";
import { startDnsServer, startSiteServer, type FixtureDns, type FixtureSite } from "../../packages/test-fixtures/dist/index.js";

/**
 * Phase 3 end-to-end, against the REAL stack: API, verification worker, ingest, email
 * worker, web and admin apps, Docker Postgres/Redis/Mailpit — plus fixture servers:
 *   - DNS on 127.0.0.1:15353 (the worker's only resolver: DNS_RESOLVERS=127.0.0.1:15353)
 *   - customer website on 127.0.0.1:14300 (worker: NETGUARD_LOOPBACK_PORT_FOR_TESTS=14300)
 * The browser maps *.co.in to 127.0.0.1, so the real SDK runs on http://<domain>:14300 and
 * sends real heartbeats to ingest with Origin http://<domain>:14300.
 * See README "End-to-end tests" for the exact processes and environment.
 */
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const SITE_PORT = 14300;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@sitesentinel.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "dev-admin-password-change-me";
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "WLEL5CGLSEMCNNH6O5GZSJCXOJBBYQNY";

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.co.in 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

let dns: FixtureDns;
let site: FixtureSite;
const domain = `e2e-${randomBytes(4).toString("hex")}.co.in`;

test.beforeAll(async () => {
  dns = await startDnsServer(15353);
  site = await startSiteServer(SITE_PORT);
  dns.setA(domain, ["127.0.0.1"]);
  dns.setA(`www.${domain}`, ["127.0.0.1"]);
  site.route(domain, "/", { body: "<!doctype html><html><head><title>Shop</title></head><body>Shop</body></html>" });
});
test.afterAll(async () => {
  await dns?.close();
  await site?.close();
});

async function tokenFromEmail(to: string, subject: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json() as { messages: Array<{ ID: string; Subject: string }> };
    const hit = s.messages.find((m) => m.Subject.includes(subject));
    if (hit) {
      const m = /token=([A-Za-z0-9_-]+)/.exec(((await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Text: string }).Text);
      if (m) return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}

async function signUpWithOrg(page: Page) {
  const email = `e2e3+${Date.now()}@example.test`;
  const password = "e2e-long-unusual-passphrase-8812";
  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("E2E Website Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(`${WEB}/verify-email?token=${await tokenFromEmail(email, "Verify your email")}`);
  await expect(page.getByText("Your email address is verified.")).toBeVisible();
  await page.goto(`${WEB}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organization name").fill("E2E Websites Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/overview/);
}

test("customer: add website → verify via DNS → install SDK → installation active → edit → revoke key", async ({ page, context }) => {
  test.setTimeout(240_000);
  await signUpWithOrg(page);

  // ---- add website (live preview normalizes www + path)
  await page.getByRole("link", { name: "Websites" }).first().click();
  await expect(page.getByRole("heading", { name: "Websites" })).toBeVisible();
  await page.getByRole("link", { name: "Add website" }).first().click();
  await page.getByLabel("Website name").fill("E2E Shop");
  await page.getByLabel("Website URL").fill(`https://www.${domain}/catalog?ref=e2e`);
  await expect(page.getByTestId("website-preview")).toContainText(domain);
  await expect(page.getByTestId("website-preview")).toContainText("Available");
  await page.getByLabel("Category").selectOption("ECOMMERCE");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/websites\/[0-9a-f-]{36}\?tab=verification/);

  // ---- complete verification: publish the TXT record shown in the UI, then verify
  const name = (await page.getByTestId("dns-record-name").textContent())!.trim();
  const value = (await page.getByTestId("dns-record-value").textContent())!.trim();
  expect(name).toBe(`_sitesentinel-verification.${domain}`);
  dns.setTxt(name, [value]);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/^Verified (\d+ s ago|in \d+ s)/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();

  // ---- install the SDK: serve a page containing the exact snippet from the UI
  await page.getByRole("tab", { name: "Installation" }).click();
  const snippet = (await page.getByTestId("install-snippet").textContent())!.trim();
  expect(snippet).toContain("data-site-key=\"pk_");
  await expect(page.getByTestId("install-state")).toHaveText("Not installed");
  site.route(domain, "/", { body: `<!doctype html><html><head><title>Shop</title>${snippet}</head><body>Shop</body></html>` });

  // Two real page loads in the browser on the customer's domain.
  const shop = await context.newPage();
  for (let i = 0; i < 2; i++) {
    const hb = shop.waitForRequest((r) => r.url().endsWith("/v1/collect") && r.method() === "POST", { timeout: 20_000 });
    await shop.goto(`http://${domain}:${SITE_PORT}/?visit=${i}`);
    await hb;
  }
  await shop.close();

  // ---- verify installation: status comes from the heartbeats
  await expect(async () => {
    await page.reload();
    await page.getByRole("tab", { name: "Installation" }).click();
    await expect(page.getByTestId("install-state")).toHaveText("Active", { timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("1.0.0")).toBeVisible();

  // Server-side diagnostic check finds the tag and the matching key.
  await page.getByRole("button", { name: "Check installation" }).click();
  const checks = page.getByTestId("install-check");
  await expect(checks.getByText("Monitoring script tag found")).toBeVisible({ timeout: 45_000 });
  await expect(checks.locator("li", { hasText: "Site key matches this website" })).toContainText("Pass");
  await expect(checks.locator("li", { hasText: "Monitoring script tag found" })).toContainText("Pass");

  // ---- view details
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByText("Registrable domain")).toBeVisible();
  await expect(page.getByText("Free trial started by this website")).toBeVisible();

  // ---- edit
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByLabel("Website name").fill("E2E Shop Renamed");
  await page.getByLabel("Category").selectOption("SAAS");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Website updated")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Shop Renamed" })).toBeVisible();

  // ---- revoke the site key (with confirmation)
  await page.getByRole("tab", { name: "Installation" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Site key revoked" })).toBeVisible();
  await expect(page.getByTestId("install-snippet")).toHaveCount(0);
  await expect(page.getByTestId("install-state")).toHaveText("Invalid configuration");

  // The website list reflects the final state.
  await page.goto(page.url().replace(/\/websites\/.*$/, "/websites"));
  await expect(page.getByRole("link", { name: "E2E Shop Renamed" })).toBeVisible();
});

test("admin: website statistics are aggregate-only", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${ADMIN}/login`);
  const used = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    let code = totp(ADMIN_TOTP_SECRET);
    while (used.has(code)) { await new Promise((r) => setTimeout(r, 1000)); code = totp(ADMIN_TOTP_SECRET); }
    used.add(code);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByLabel(/code/i).fill(code);
    await page.getByRole("button", { name: /sign in/i }).click();
    try { await expect(page).toHaveURL(/\/overview/, { timeout: 5000 }); break; } catch { /* code already used this step: retry on the next step */ }
  }
  await page.getByRole("link", { name: "Websites & domains" }).click();
  await expect(page.getByText("Aggregate counts only")).toBeVisible();
  const websites = page.locator("div", { has: page.getByText("Websites", { exact: true }) }).locator("p.text-2xl").first();
  await expect(websites).not.toHaveText("0");
  await expect(page.locator("body")).not.toContainText(domain);
  await page.getByRole("link", { name: "Domain transfers" }).click();
  await expect(page.getByRole("heading", { name: "Domain transfers" })).toBeVisible();
});
