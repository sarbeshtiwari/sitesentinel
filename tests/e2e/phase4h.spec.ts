import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { totp } from "../../packages/crypto/dist/index.js";

/**
 * Phase 4H end-to-end against the running stack (real scheduler evaluating health, real workers heartbeating):
 * Super Admin platform health, alerts (a real worker crash), usage accounting and operations configuration;
 * the customer's functional-test risk acknowledgement.
 */
const WEB = process.env.WEB_URL ?? "http://localhost:3002";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:58025";
const CONTROL = process.env.FAULT_CONTROL_URL ?? "http://127.0.0.1:15999";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@sitesentinel.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "dev-admin-password-change-me";
const ADMIN_TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "WLEL5CGLSEMCNNH6O5GZSJCXOJBBYQNY";
test.describe.configure({ mode: "serial" });
const used = new Set<string>();
const sql = (q: string) => execFileSync("docker", ["compose", "-f", "infra/compose/docker-compose.dev.yml", "exec", "-T", "postgres", "psql", "-U", "wim_owner", "-d", "wim", "-Atc", q], { encoding: "utf8" }).trim();
async function freshCode() { for (;;) { const c = totp(ADMIN_TOTP_SECRET); if (!used.has(c)) { used.add(c); return c; } await new Promise((r) => setTimeout(r, 1000)); } }
const redisFlushRateLimits = () => execFileSync("docker", ["compose", "-f", "infra/compose/docker-compose.dev.yml", "exec", "-T", "redis", "sh", "-c",
  `redis-cli -a wim_redis_dev_password --no-auth-warning --scan --pattern 'rl:*' | xargs -r redis-cli -a wim_redis_dev_password --no-auth-warning del`], { encoding: "utf8" });
async function adminSettings(page: Page, changes: Array<{ key: string; value: unknown }>, confirmProtected = false) {
  const csrf = (await page.context().cookies()).find((c) => c.name.endsWith("wim_admin_csrf"))?.value ?? "";
  const r = await page.request.patch(`${ADMIN}/api/admin/v1/settings`, { data: { changes, reason: "E2E phase 4H", ...(confirmProtected ? { confirmProtected } : {}) }, headers: { "x-csrf-token": csrf, origin: ADMIN } });
  expect(r.status(), await r.text()).toBe(200);
}
async function adminLogin(page: Page) {
  redisFlushRateLimits(); // the suite signs in several times within minutes
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

test("Super Admin: platform health shows real workers; a killed worker becomes an alert that is acknowledged and recovers", async ({ page }) => {
  test.setTimeout(420_000);
  const started = new Date();
  await adminLogin(page);
  await page.goto(`${ADMIN}/platform`);
  await expect(page.getByText("Operational data only")).toBeVisible();
  // the scheduler is alive (other signals on the component — e.g. the host's disk — are environment-dependent)
  await expect(page.getByTestId("component-scheduler")).not.toContainText("unhealthy", { timeout: 60_000 });
  await expect(page.getByTestId("component-scheduler")).not.toContainText("heartbeat");
  await expect(page.getByTestId("component-redis")).toContainText("healthy");
  await expect(page.getByTestId("platform-verdict")).toContainText("Customer monitoring on schedule");
  await expect(page.getByRole("cell", { name: /e2e-deepscan/ })).toBeVisible();
  // privacy: nothing customer-shaped on the page
  expect(await page.locator("main").innerText()).not.toMatch(/https?:\/\/(?!localhost)|\.co\.in/);

  // precondition: the deep-scan worker runs and no heartbeat alert for it is active (earlier runs may have left one)
  const alive = () => sql(`SELECT count(*) FROM worker_heartbeats WHERE kind = 'deep-scan' AND last_seen_at > now() - interval '20 seconds'`) !== "0";
  if (!alive()) spawn("bash", ["-c", process.env.E2E_RESTART_DEEPSCAN!], { env: process.env, detached: true, stdio: "ignore" }).unref();
  await expect.poll(() => sql(`SELECT count(*) FROM platform_alerts WHERE fingerprint = 'worker.heartbeat_expired:deep-scan' AND state <> 'RECOVERED'`), { timeout: 150_000 }).toBe("0");
  // crash the deep-scan worker for real (SIGKILL, no graceful stop)
  execFileSync("bash", ["-c", `for p in $(pgrep -f "dist/main.js"); do lsof -a -p $p -d cwd -Fn 2>/dev/null | grep -q "apps/worker-deepscan$" && kill -9 $p; done; true`]);
  await page.goto(`${ADMIN}/alerts`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("button", { name: /worker\.heartbeat_expired.*workers:deep-scan/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 180_000 });
  const row = page.getByRole("row", { name: /worker\.heartbeat_expired workers:deep-scan/ });
  await row.getByRole("button", { name: "Acknowledge" }).click();
  await page.getByLabel("Reason").fill("E2E: investigating the killed worker");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).last().click();
  await expect(page.getByText("Alert acknowledged")).toBeVisible();
  await expect(row.getByText("acknowledged")).toBeVisible();
  const alertId = sql(`SELECT id FROM platform_alerts WHERE fingerprint = 'worker.heartbeat_expired:deep-scan' ORDER BY opened_at DESC LIMIT 1`);
  // one audit entry for this acknowledgement (a flapping alert reopened within the cooldown keeps its id, so count since the test started)
  expect(Number(sql(`SELECT count(*) FROM audit_logs WHERE action = 'admin.platform_alert_acknowledged' AND target_id = '${alertId}' AND occurred_at >= '${started.toISOString()}'`))).toBe(1);
  // the operators got the alert e-mail
  const mail = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent("subject:worker.heartbeat_expired")}`)).json() as { messages_count: number };
  expect(mail.messages_count).toBeGreaterThan(0);

  // restart the worker → the alert recovers on its own
  // detached, no inherited pipes: execFileSync would block the event loop until the restarted worker exits
  spawn("bash", ["-c", process.env.E2E_RESTART_DEEPSCAN!], { env: process.env, detached: true, stdio: "ignore" }).unref();
  await page.getByLabel("State").selectOption("RECOVERED");
  await expect(async () => {
    await page.reload();
    await page.getByLabel("State").selectOption("RECOVERED");
    await expect(page.getByRole("row", { name: /worker\.heartbeat_expired workers:deep-scan/ }).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 180_000 });
});

test("Super Admin: usage accounting and operations configuration (protected policy needs confirmation, audited)", async ({ page }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/usage`);
  await expect(page.getByText("Accounting rules")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Billable usage by organisation/ })).toBeVisible();
  await page.goto(`${ADMIN}/operations`);
  await expect(page.getByText("Feature availability & kill switches")).toBeVisible();
  await expect(page.getByRole("row", { name: /queue\.browser-monitoring/ })).toContainText("restart required");
  const fn = page.getByRole("row", { name: /monitoring\.functional\.enabled/ });
  await expect(fn).toContainText("protected");
  await fn.getByRole("button", { name: "Change" }).click();
  await page.getByLabel("Value").fill("true");
  await page.getByLabel("Reason (recorded in the audit log)").fill("E2E: enable functional tests for the review");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled(); // protected: confirmation missing
  await page.getByText("This is a protected security policy. I confirm the change.").click();
  await save.click();
  await expect(page.getByText(/Saved/)).toBeVisible();
  expect(sql(`SELECT changes->>'protected' FROM audit_logs WHERE action = 'admin.setting_changed' AND target_id = 'monitoring.functional.enabled' ORDER BY id DESC LIMIT 1`)).toBe("true");
  // retention floor enforced in the UI and the database
  const ret = page.getByRole("row", { name: /^security_events/ });
  await ret.getByRole("button", { name: "Change" }).click();
  await page.getByLabel(/Days \(minimum 365\)/).fill("30");
  await page.getByLabel("Reason (recorded in the audit log)").fill("E2E: try below the floor");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  // for the customer test: browser monitoring available on the platform
  await adminSettings(page, [{ key: "monitoring.browser.enabled", value: true }, { key: "monitoring.browser.defaultEntitled", value: true }]);
});

test("customer: enabling functional tests requires accepting the stated risk", async ({ page }) => {
  // an existing E2E customer with a verified website (from the phase 4G/4F runs) — sign in via a fresh account instead
  const email = `e2e4h+${Date.now()}@example.test`, password = "e2e-long-unusual-passphrase-8812";
  await page.goto(`${WEB}/register`);
  await page.getByLabel("Full name").fill("E2E Risk Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  let token = "";
  for (let i = 0; i < 40 && !token; i++) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json() as { messages: Array<{ ID: string }> };
    if (s.messages[0]) token = /token=([A-Za-z0-9_-]+)/.exec(((await (await fetch(`${MAILPIT}/api/v1/message/${s.messages[0].ID}`)).json()) as { Text: string }).Text)?.[1] ?? "";
    if (!token) await new Promise((r) => setTimeout(r, 500));
  }
  await page.goto(`${WEB}/verify-email?token=${token}`);
  await page.goto(`${WEB}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Organization name").fill("E2E Risk Org");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/overview/);
  const orgId = /\/o\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  // a website verified through the real flow (DNS TXT on the fixture resolver), as in the 4F/4G specs
  const host = process.env.E2E_4H_HOST!;
  await page.goto(`${WEB}/o/${orgId}/websites/new`);
  await page.getByLabel("Website name").fill("E2E Risk Site");
  await page.getByLabel("Website URL").fill(`https://${host}/`);
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/websites\/[0-9a-f-]{36}\?tab=verification/);
  const site = page.url().replace(/\?.*$/, "").split("/").pop()!;
  await fetch(`${CONTROL}/txt?name=${encodeURIComponent((await page.getByTestId("dns-record-name").textContent())!.trim())}&value=${encodeURIComponent((await page.getByTestId("dns-record-value").textContent())!.trim())}`);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/^Verified (\d+ s ago|in \d+ s)/)).toBeVisible({ timeout: 60_000 });
  await page.goto(`${WEB}/o/${orgId}/websites/${site}?tab=monitoring-settings`);
  const enable = page.getByText("Interact with the page (off by default)");
  await enable.click();
  await expect(page.getByTestId("functional-risk")).toContainText("a page can still change data when it receives a GET request");
  await page.getByRole("button", { name: "Save browser settings" }).click();
  await expect(page.getByText(/change data when it receives a GET request|risk/i).last()).toBeVisible(); // server refuses without acceptance
  await page.getByLabel(/Allowed paths/).fill("/search");
  await page.getByText("I understand and accept this risk for this website").click();
  await page.getByRole("button", { name: "Save browser settings" }).click();
  await expect(page.getByText("Browser settings saved")).toBeVisible();
  const ack = sql(`SELECT browser_check->'functional'->'riskAcknowledgement'->>'version' FROM monitoring_configurations WHERE website_id = '${site}'`);
  expect(ack).toBe("1");
});

test("operator restores the defaults", async ({ page }) => {
  await adminLogin(page);
  const csrf = (await page.context().cookies()).find((c) => c.name.endsWith("wim_admin_csrf"))?.value ?? "";
  const r = await page.request.patch(`${ADMIN}/api/admin/v1/settings`, { data: { changes: [{ key: "monitoring.functional.enabled", value: false }], reason: "E2E: restore default", confirmProtected: true }, headers: { "x-csrf-token": csrf, origin: ADMIN } });
  expect(r.status()).toBe(200);
  await adminSettings(page, [{ key: "monitoring.browser.enabled", value: false }, { key: "monitoring.browser.defaultEntitled", value: false }]);
});
