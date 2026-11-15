import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { totp } from "../../packages/crypto/dist/index.js";

/**
 * Customer monitoring dashboard end-to-end (approved-4G scope delivered early; the file keeps its original "phase4f"
 * name, under which it was first reported — see PHASE4_PLAN.md §12–§14). Against the REAL stack: API, scheduler, egress gateway, worker-http, worker-deepscan,
 * worker-notify, web and admin apps, Docker Postgres/Redis/Mailpit. The operator enables monitoring through the
 * admin API (as in production); every number in the UI comes from real checks of the controlled website.
 */
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@sitesentinel.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "dev-admin-password-change-me";
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "WLEL5CGLSEMCNNH6O5GZSJCXOJBBYQNY";

test.describe.configure({ mode: "serial" });

/**
 * The customer website is the controlled fault site (apps/scheduler/scripts/fault-env.mjs): HTTPS with a private
 * test CA trusted only in NODE_ENV=test, its own DNS on 127.0.0.1:15353, and a control port for page state and TXT
 * records. The host is fixed per run (E2E_4F_HOST) because the fault site must know it before it starts.
 */
/** The customer's session, saved after sign-up and reused by the following tests (each test has a fresh context). */
const AUTH = `${process.env.TMPDIR ?? "/tmp"}/wim-e2e4f-customer.json`;
const CONTROL = process.env.FAULT_CONTROL_URL ?? "http://127.0.0.1:15999";
const domain = process.env.E2E_4F_HOST ?? "e2e4f.co.in";
let orgUrl = "";
let websiteUrl = "";
const used = new Set<string>();
const control = (path: string) => fetch(`${CONTROL}${path}`).then((r) => r.text());
const healthy = () => control(`/toggle?host=${domain}&state=up`);
const broken = () => control(`/toggle?host=${domain}&state=down`);

test.beforeAll(async () => { await healthy(); });

async function freshCode(): Promise<string> {
  for (;;) {
    const c = totp(ADMIN_TOTP_SECRET);
    if (!used.has(c)) { used.add(c); return c; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function adminLogin(page: Page) {
  for (let attempt = 0; attempt < 3 && !/\/overview/.test(page.url()); attempt++) {
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByLabel("Authenticator code").fill(await freshCode());
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/overview/, { timeout: 10_000 }).catch(() => undefined);
  }
  await expect(page).toHaveURL(/\/overview/);
}
/** Platform settings through the admin API, exactly what the admin Settings page sends. */
async function adminSettings(page: Page, changes: Array<{ key: string; value: unknown }>) {
  const csrf = (await page.context().cookies()).find((c) => c.name.endsWith("wim_admin_csrf"))?.value ?? "";
  // Phase 4H: the request delay is a protected security policy — the Super Admin confirms it explicitly
  const r = await page.request.patch(`${ADMIN}/api/admin/v1/settings`, { data: { changes, reason: "Phase 4F end-to-end verification", confirmProtected: true }, headers: { "x-csrf-token": csrf, origin: ADMIN } });
  expect(r.status(), await r.text()).toBe(200);
}
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
async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `page is ${r.sw}px wide in a ${r.w}px viewport`).toBeLessThanOrEqual(r.w + 1);
}
const api = (req: APIRequestContext, path: string) => req.get(`${WEB}/api/v1${path}`);

test("operator enables HTTP monitoring and deep scans for the platform", async ({ page }) => {
  await adminLogin(page);
  await adminSettings(page, [
    { key: "monitoring.http.enabled", value: true }, { key: "monitoring.http.intervalSec", value: 30 },
    { key: "monitoring.deepscan.enabled", value: true }, { key: "monitoring.deepscan.defaultEntitled", value: true },
    { key: "monitoring.deepscan.minRequestDelayMs", value: 100 }, { key: "monitoring.deepscan.manualCooldownSec", value: 0 },
  ]);
});

test("customer: empty states → add + verify website → live dashboard from real checks", async ({ page }) => {
  test.setTimeout(300_000);
  const email = `e2e4f+${Date.now()}@example.test`;
  const password = "e2e-long-unusual-passphrase-8812";
  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("E2E Monitoring Owner");
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
  await page.getByLabel("Organization name").fill("E2E Monitoring Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/overview/);
  orgUrl = page.url().replace(/\/overview.*$/, "");
  await page.context().storageState({ path: AUTH });

  // ---- empty states (no websites, no incidents, no notifications): no invented numbers
  await expect(page.getByRole("heading", { name: "E2E Monitoring Org" })).toBeVisible();
  await expect(page.getByText(/Monitoring overview · your role: Owner/)).toBeVisible();
  await expect(page.getByText("No websites yet")).toBeVisible();
  await page.goto(`${orgUrl}/incidents`);
  await expect(page.getByText("No active incidents")).toBeVisible();
  await page.goto(`${orgUrl}/notifications`);
  await expect(page.getByText("No notifications yet")).toBeVisible();
  await page.goto(`${orgUrl}/history`);
  await expect(page.getByText("Nothing recorded yet")).toBeVisible();

  // ---- add and verify a website (HTTP origin: the fixture serves plain HTTP)
  await page.goto(`${orgUrl}/websites/new`);
  await page.getByLabel("Website name").fill("E2E Monitored Shop");
  await page.getByLabel("Website URL").fill(`https://${domain}/`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/websites\/[0-9a-f-]{36}\?tab=verification/);
  websiteUrl = page.url().replace(/\?.*$/, "");
  const txtName = (await page.getByTestId("dns-record-name").textContent())!.trim();
  const txtValue = (await page.getByTestId("dns-record-value").textContent())!.trim();
  await control(`/txt?name=${encodeURIComponent(txtName)}&value=${encodeURIComponent(txtValue)}`);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/^Verified (\d+ s ago|in \d+ s)/)).toBeVisible({ timeout: 60_000 });

  // ---- monitor the fault site's switchable page, configured through the Monitoring settings form
  await page.goto(`${websiteUrl}?tab=monitoring-settings`);
  await page.getByLabel("Path", { exact: true }).fill("/toggle");
  await page.getByRole("button", { name: "Save HTTP settings" }).click();
  await expect(page.getByText("HTTP settings saved")).toBeVisible();

  // ---- real checks arrive; the availability tab shows them (backend uptime + coverage)
  await page.goto(`${websiteUrl}?tab=availability`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Check history")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Passed" }).first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 120_000 });
  await expect(page.getByText("Uptime", { exact: true })).toBeVisible();
  await expect(page.getByText("Times in your time zone").first()).toBeVisible();
  // open one check's safe details
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("HTTP status");
  await expect(page.getByRole("dialog")).toContainText("Request credentials, cookies and resolved addresses are never stored or shown.");
  await page.keyboard.press("Escape");

  // overview: healthy only from real data (UI and API agree)
  await page.goto(`${orgUrl}/overview`);
  const row = page.getByRole("row", { name: /E2E Monitored Shop/ });
  await expect(row).toBeVisible();
  const ov = await (await api(page.request, `${new URL(orgUrl).pathname.replace(/^\/o/, "/orgs")}/monitoring/overview`)).json();
  expect(ov.data.websites[0].http.uptime.measuredChecks).toBeGreaterThan(0);
  await expect(row).toContainText(ov.data.websites[0].http.uptime.measuredChecks > 0 ? "checks" : "");
});

test.describe("signed-in customer", () => {
  test.use({ storageState: AUTH });

test("outage → incident → acknowledge → notification → recovery, with history and timeline", async ({ page, context }) => {
  test.setTimeout(420_000);
  void context;
  broken();
  await page.goto(`${orgUrl}/incidents`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("link", { name: /INC-\d+ · / })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 180_000 });
  await expect(page.getByRole("row", { name: /INC-/ })).toContainText("Open");
  await expect(page.getByRole("row", { name: /INC-/ })).toContainText("HTTP availability");

  // live updates: the bell shows the unread in-app notification without a page reload
  await expect(page.getByRole("link", { name: /Notifications, \d+ unread/ })).toBeVisible({ timeout: 45_000 });

  await page.getByRole("link", { name: /INC-\d+ · / }).click();
  await expect(page.getByText("Ongoing problem")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge" }).dblclick(); // a double click acknowledges once
  await expect(page.getByText("Ongoing — acknowledged by your team")).toBeVisible();
  await expect(page.getByText("Acknowledged", { exact: true }).first()).toBeVisible();
  await expect(page.locator("ol li", { hasText: "Acknowledged" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "View result" }).first()).toBeVisible();

  // notifications page: read state
  await page.goto(`${orgUrl}/notifications`);
  await expect(page.getByText("Incident opened").first()).toBeVisible();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText(/0 unread/)).toBeVisible();

  // recovery is decided by the engine
  healthy();
  await page.goto(`${orgUrl}/incidents?status=RESOLVED`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: /INC-/ })).toContainText("Resolved", { timeout: 2000 });
  }).toPass({ timeout: 180_000 });
  await page.getByRole("link", { name: /INC-\d+ · / }).click();
  await expect(page.getByText("Recovered", { exact: true })).toBeVisible();
  await expect(page.locator("ol li", { hasText: "Recovered automatically" })).toHaveCount(1);

  // history: checks and incident events from persisted data, filterable
  await page.goto(`${orgUrl}/history?type=INCIDENT`);
  await expect(page.getByText(/INC-\d+ opened/)).toBeVisible();
  await expect(page.getByText(/INC-\d+ acknowledged/)).toBeVisible();
  await expect(page.getByText(/INC-\d+ recovered/)).toBeVisible();
  await page.goto(`${orgUrl}/history?result=FAILED`);
  await expect(page.getByText("HTTP check: failed").first()).toBeVisible();
});

test("deep scan from the dashboard; usage, settings (audited) and entitlement explanations", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${websiteUrl}?tab=deep-scan`);
  await expect(page.getByRole("heading", { name: "Deep scans" })).toBeVisible();
  // a scheduled scan may already be running; otherwise start one
  const start = page.getByRole("button", { name: "Start scan" });
  if (await start.isVisible().catch(() => false)) await start.click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Every discovered page was checked|Stopped at/)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 180_000 });
  await expect(page.getByText("Completed").first()).toBeVisible();
  await page.getByRole("link", { name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/ }).first().click(); // scan start time, viewer time zone
  await expect(page.getByRole("heading", { name: /Deep scan · / })).toBeVisible();
  await expect(page.getByText("Discovered pages")).toBeVisible();
  await expect(page.getByRole("cell", { name: new RegExp(domain) }).first()).toBeVisible();

  // settings: browser monitoring explains why it is unavailable; intervals can only be slower (server-validated)
  await page.goto(`${websiteUrl}?tab=monitoring-settings`);
  await expect(page.getByText(/Browser monitoring/).first()).toBeVisible();
  await expect(page.getByText(/Unavailable: Not offered on this platform yet/)).toBeVisible();
  await page.getByLabel("Check interval (minutes)").fill("10"); // slower than the plan's 30 s minimum: allowed
  await page.getByRole("button", { name: "Save HTTP settings" }).click();
  await expect(page.getByText("HTTP settings saved")).toBeVisible();
  await page.goto(`${orgUrl}/settings/audit`);
  await expect(page.getByText(/monitoring_schedule_updated|Monitoring schedule updated/).filter({ visible: true }).first()).toBeVisible(); // the list renders as cards on phones and a table on wider screens

  await page.goto(`${orgUrl}/usage`);
  await expect(page.getByRole("heading", { name: "Usage and plan limits" })).toBeVisible();
  await expect(page.getByText("Pages scanned")).toBeVisible();
  await expect(page.getByText(/HTTP check results: \d+ days/)).toBeVisible();
});

test("errors and permissions: unknown and foreign identifiers show a safe not-found state", async ({ page }) => {
  await page.goto(`${orgUrl}/incidents/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText("Not found")).toBeVisible();
  await page.goto(`${websiteUrl}/browser/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText("Not found")).toBeVisible();
  // an organisation the user isn't a member of
  const r = await api(page.request, `/orgs/00000000-0000-4000-8000-000000000000/monitoring/overview`);
  expect([403, 404]).toContain(r.status());
});
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: AUTH });
  test("dashboard pages fit a phone screen", async ({ page }) => {
    for (const p of [`${orgUrl}/overview`, `${orgUrl}/incidents?status=ALL`, `${websiteUrl}?tab=availability`, `${websiteUrl}?tab=deep-scan`, `${orgUrl}/history`, `${orgUrl}/usage`, `${orgUrl}/notifications`]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("h1").first()).toBeVisible();
      await noHorizontalScroll(page);
    }
  });
});

test.describe("tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 }, storageState: AUTH });
  test("dashboard pages fit a tablet screen", async ({ page }) => {
    for (const p of [`${orgUrl}/overview`, `${websiteUrl}?tab=availability`, `${websiteUrl}?tab=monitoring-settings`, `${orgUrl}/incidents?status=ALL`]) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page);
    }
  });
});

test.describe("failure states", () => {
  test.use({ storageState: AUTH });
  test("an API failure shows an error state, not stale or invented numbers", async ({ page }) => {
    await page.route("**/api/v1/orgs/*/monitoring/overview*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "Simulated outage", requestId: "req_test" } }) }));
    await page.goto(`${orgUrl}/overview`);
    await expect(page.getByText("Couldn't load this data")).toBeVisible();
    await expect(page.getByText("Simulated outage")).toBeVisible();
    await expect(page.getByText("HTTP check success")).toHaveCount(0);
    // slow responses show a loading skeleton first
    await page.unroute("**/api/v1/orgs/*/monitoring/overview*");
    await page.route("**/api/v1/orgs/*/monitoring/usage", async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    await page.goto(`${orgUrl}/usage`);
    await expect(page.locator(".animate-pulse").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Usage and plan limits" })).toBeVisible();
    await expect(page.getByText(/HTTP check results: \d+ days/)).toBeVisible();
  });
});

test("admin: monitoring operations page is aggregate-only", async ({ page }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/monitoring`);
  await expect(page.getByText("Aggregate operational data only")).toBeVisible();
  await expect(page.getByRole("cell", { name: "HTTP" }).first()).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toContain(domain);
  expect(text).not.toContain("E2E Monitored Shop");
  await adminSettings(page, [
    { key: "monitoring.http.enabled", value: false }, { key: "monitoring.deepscan.enabled", value: false }, { key: "monitoring.deepscan.defaultEntitled", value: false },
    { key: "monitoring.deepscan.minRequestDelayMs", value: 1000 }, { key: "monitoring.deepscan.manualCooldownSec", value: 900 }, { key: "monitoring.http.intervalSec", value: 60 },
  ]);
});
