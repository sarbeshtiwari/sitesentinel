import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { totp } from "../../packages/crypto/dist/index.js";

/**
 * Phase 4G end-to-end with REAL browser executions: API, scheduler (incl. rollups), egress gateway, worker-http,
 * browser-runner (sandboxed Chromium) + worker-browser, worker-notify, web and admin, against the HTTPS fault site
 * (fault-env.mjs; the runner trusts its test CA only under NODE_ENV=test). Every number on the dashboard comes from
 * real checks of the controlled website.
 *
 * Test lever (development only): browser checks run every 5 minutes at the fastest, so the test makes the browser
 * schedule due again by moving it to a new window through the database (`dueNow`) — the scheduler, workers and
 * rollups then run unmodified.
 */
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const CONTROL = process.env.FAULT_CONTROL_URL ?? "http://127.0.0.1:15999";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@sitesentinel.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "dev-admin-password-change-me";
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "WLEL5CGLSEMCNNH6O5GZSJCXOJBBYQNY";
const domain = process.env.E2E_4G_HOST ?? "e2e4g.co.in";
const AUTH = `${process.env.TMPDIR ?? "/tmp"}/wim-e2e4g-customer.json`;
test.describe.configure({ mode: "serial" });

let orgUrl = "";
let websiteUrl = "";
let websiteId = "";
const used = new Set<string>();
const control = (path: string) => fetch(`${CONTROL}${path}`).then((r) => r.text());
const sql = (q: string) => execFileSync("docker", ["compose", "-f", "infra/compose/docker-compose.dev.yml", "exec", "-T", "postgres", "psql", "-U", "wim_owner", "-d", "wim", "-Atc", q], { encoding: "utf8" }).trim();
const browserResults = () => Number(sql(`SELECT count(*) FROM execution_results WHERE website_id = '${websiteId}' AND tier = 'T2_RENDER'`));
/** Make the website's browser schedule due in a NEW window (shifting the jitter), so the scheduler dispatches a real check. */
const dueNow = () => sql(`UPDATE monitoring_schedules SET jitter_sec = (jitter_sec + 61) % interval_sec, next_run_at = now() - interval '1 second', state_window_at = NULL WHERE website_id = '${websiteId}' AND tier = 'T2_RENDER'`);
async function browserChecks(n: number) {
  const target = browserResults() + n;
  for (let i = 0; i < 60 && browserResults() < target; i++) {
    const before = browserResults();
    dueNow();
    for (let j = 0; j < 30 && browserResults() === before; j++) await new Promise((r) => setTimeout(r, 2000));
  }
  expect(browserResults()).toBeGreaterThanOrEqual(target);
}

async function freshCode(): Promise<string> {
  for (;;) { const c = totp(ADMIN_TOTP_SECRET); if (!used.has(c)) { used.add(c); return c; } await new Promise((r) => setTimeout(r, 1000)); }
}
async function adminLogin(page: Page) {
  for (let a = 0; a < 3 && !/\/overview/.test(page.url()); a++) {
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByLabel("Authenticator code").fill(await freshCode());
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/overview/, { timeout: 10_000 }).catch(() => undefined);
  }
  await expect(page).toHaveURL(/\/overview/);
}
async function adminSettings(page: Page, changes: Array<{ key: string; value: unknown }>) {
  const csrf = (await page.context().cookies()).find((c) => c.name.endsWith("wim_admin_csrf"))?.value ?? "";
  const r = await page.request.patch(`${ADMIN}/api/admin/v1/settings`, { data: { changes, reason: "Phase 4G end-to-end verification" }, headers: { "x-csrf-token": csrf, origin: ADMIN } });
  expect(r.status(), await r.text()).toBe(200);
}
async function tokenFromEmail(to: string, subject: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json() as { messages: Array<{ ID: string; Subject: string }> };
    const hit = s.messages.find((m) => m.Subject.includes(subject));
    if (hit) { const m = /token=([A-Za-z0-9_-]+)/.exec(((await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Text: string }).Text); if (m) return m[1]!; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}

test("operator enables HTTP and browser monitoring with custom performance thresholds", async ({ page }) => {
  await adminLogin(page);
  await adminSettings(page, [
    { key: "monitoring.http.enabled", value: true }, { key: "monitoring.browser.enabled", value: true }, { key: "monitoring.browser.defaultEntitled", value: true },
    { key: "monitoring.performance.customThresholdsDefault", value: true }, { key: "monitoring.browser.maxViewportsPerRun", value: 2 }, { key: "monitoring.rollups.enabled", value: true },
  ]);
});

test("customer: website with real browser checks → performance, components, responsive and pages dashboards", async ({ page }) => {
  test.setTimeout(900_000);
  await control(`/toggle?host=${domain}&state=up`);
  const email = `e2e4g+${Date.now()}@example.test`, password = "e2e-long-unusual-passphrase-8812";
  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("E2E Performance Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(`${WEB}/verify-email?token=${await tokenFromEmail(email, "Verify your email")}`);
  await page.goto(`${WEB}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Organization name").fill("E2E Performance Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/overview/);
  orgUrl = page.url().replace(/\/overview.*$/, "");
  await page.context().storageState({ path: AUTH });
  await page.goto(`${orgUrl}/websites/new`);
  await page.getByLabel("Website name").fill("E2E Perf Shop");
  await page.getByLabel("Website URL").fill(`https://${domain}/`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/websites\/[0-9a-f-]{36}\?tab=verification/);
  websiteUrl = page.url().replace(/\?.*$/, "");
  websiteId = websiteUrl.split("/").pop()!;
  await control(`/txt?name=${encodeURIComponent((await page.getByTestId("dns-record-name").textContent())!.trim())}&value=${encodeURIComponent((await page.getByTestId("dns-record-value").textContent())!.trim())}`);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/^Verified (\d+ s ago|in \d+ s)/)).toBeVisible({ timeout: 60_000 });

  // browser monitoring of the shop page, two viewports, configured in the UI
  await page.goto(`${websiteUrl}?tab=monitoring-settings`);
  await page.getByLabel("Page path").fill("/c/shop");
  const mobile = page.getByLabel("Mobile small");
  if (!(await mobile.isChecked())) await mobile.check();
  await page.getByRole("button", { name: "Save browser settings" }).click();
  await expect(page.getByText("Browser settings saved")).toBeVisible();
  sql(`UPDATE monitoring_configurations SET browser_check = browser_check || '{"extraViewportsPerRun":1}' WHERE website_id = '${websiteId}'`);
  sql(`UPDATE monitoring_schedules SET next_run_at = now() WHERE website_id = '${websiteId}'`);

  // 4 real browser checks; rollups run in the scheduler every minute
  await browserChecks(4);
  await page.goto(`${websiteUrl}?tab=performance`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/p75 · [1-9]\d* samples?/).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 150_000 });
  await expect(page.getByText("synthetic · desktop")).toBeVisible();
  await expect(page.getByText(/buckets have measurements/)).toBeVisible();
  // custom thresholds through the UI (server-validated): an impossible TTFB bound and alerting on TTFB
  await page.getByLabel("TTFB good").fill("300");
  await page.getByLabel("TTFB poor").fill("800");
  await page.getByLabel("Alert on TTFB").check();
  await page.getByLabel("Poor checks in a row before an incident").fill("2");
  await page.getByRole("button", { name: "Save thresholds" }).click();
  await expect(page.getByText("Performance thresholds saved")).toBeVisible();
  await page.getByLabel("TTFB good").fill("900");
  await page.getByRole("button", { name: "Save thresholds" }).click();
  await expect(page.getByText(/Some fields are invalid|Invalid performance thresholds/).first()).toBeVisible(); // rejected by the server

  // a real slowdown of the site → TTFB poor on two consecutive real checks → one performance incident
  await control(`/toggle?host=${encodeURIComponent(`${domain}#perf`)}&state=slow`);
  await browserChecks(2);
  await page.goto(`${orgUrl}/incidents`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("link", { name: /Synthetic performance below threshold/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await control(`/toggle?host=${encodeURIComponent(`${domain}#perf`)}&state=fast`);

  // components, responsive, pages, overview, history — all from those real checks
  await page.goto(`${websiteUrl}?tab=components`);
  await expect(page.getByRole("button", { name: /^Search/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Navigation/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Search/ }).first().click();
  await expect(page.getByText(/Visibility by viewport \(last observed\):.*\bdesktop: visible/)).toBeVisible(); // viewports rotate: order varies
  await page.goto(`${websiteUrl}?tab=responsive`);
  await expect(page.getByRole("cell", { name: /desktop 1366×768/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /mobile-small 375×812/ })).toBeVisible();
  await expect(page.getByText("Menu opens")).toBeVisible();
  await page.goto(`${websiteUrl}?tab=pages`);
  await expect(page.getByRole("row", { name: /\/c\/shop/ })).toContainText("Browser");
  await page.goto(`${orgUrl}/overview`);
  await expect(page.getByRole("row", { name: /E2E Perf Shop/ })).toBeVisible();
  await page.goto(`${orgUrl}/history?type=CONFIG`);
  await expect(page.getByText(/Performance thresholds updated/).first()).toBeVisible();
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: AUTH });
  test("4G dashboards fit a phone screen", async ({ page }) => {
    for (const t of ["performance", "components", "responsive", "pages"]) {
      await page.goto(`${websiteUrl}?tab=${t}`);
      await page.waitForLoadState("networkidle");
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
      expect(r.sw, `${t}: ${r.sw}px in ${r.w}px`).toBeLessThanOrEqual(r.w + 1);
    }
  });
});

test("operator switches monitoring off again", async ({ page }) => {
  await adminLogin(page);
  await adminSettings(page, [
    { key: "monitoring.http.enabled", value: false }, { key: "monitoring.browser.enabled", value: false }, { key: "monitoring.browser.defaultEntitled", value: false },
    { key: "monitoring.performance.customThresholdsDefault", value: false },
  ]);
});
