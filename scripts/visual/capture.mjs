#!/usr/bin/env node
// Visual review: signs in through the real API and screenshots every main route at several viewports.
// Usage: node scripts/visual/capture.mjs <outDir> [--only=customer|admin|auth]
// Env: WEB_URL (http://localhost:3000), ADMIN_URL, REVIEW_EMAIL/REVIEW_PASSWORD (customer), REVIEW_ORG, REVIEW_ORG2,
//      REVIEW_SITE, REVIEW_INCIDENT, ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_TOTP_SECRET (optional, for admin screens)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../tests/e2e/", import.meta.url));
const { chromium } = require("@playwright/test");

const out = process.argv[2] ?? "screens";
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ADMIN = process.env.ADMIN_URL ?? "http://localhost:3001";
const org = process.env.REVIEW_ORG, org2 = process.env.REVIEW_ORG2, site = process.env.REVIEW_SITE, inc = process.env.REVIEW_INCIDENT;
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, laptop: { width: 1280, height: 800 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 } };
const which = (process.env.VIEWPORTS ?? "desktop,mobile").split(",");
mkdirSync(out, { recursive: true });

const pick = (process.env.ROUTES ?? "").split(",").filter(Boolean);
const sel = (rs) => (pick.length ? rs.filter(([n]) => pick.includes(n)) : rs);
const customer = [
  ["overview", `/o/${org}/overview`], ["websites", `/o/${org}/websites`], ["website-overview", `/o/${org}/websites/${site}`],
  ["website-performance", `/o/${org}/websites/${site}?tab=performance`], ["website-browser", `/o/${org}/websites/${site}?tab=browser`],
  ["website-components", `/o/${org}/websites/${site}?tab=components`], ["website-responsive", `/o/${org}/websites/${site}?tab=responsive`],
  ["website-deepscan", `/o/${org}/websites/${site}?tab=deep-scan`], ["website-settings", `/o/${org}/websites/${site}?tab=monitoring-settings`],
  ["website-new", `/o/${org}/websites/new`], ["incidents", `/o/${org2}/incidents`], ["incident", `/o/${org2}/incidents/${inc}`],
  ["history", `/o/${org2}/history`], ["notifications", `/o/${org}/notifications`], ["usage", `/o/${org}/usage`],
  ["team", `/o/${org}/settings/team`], ["roles", `/o/${org}/settings/roles`], ["general", `/o/${org}/settings/general`],
  ["audit", `/o/${org}/settings/audit`], ["profile", `/account/profile`], ["security", `/account/security`],
];
const auth = [["login", "/login"], ["register", "/register"], ["forgot", "/forgot-password"]];
const admin = [["a-overview", "/overview"], ["a-platform", "/platform"], ["a-alerts", "/alerts"], ["a-monitoring", "/monitoring"], ["a-usage", "/usage"], ["a-operations", "/operations"], ["a-customers", "/customers"], ["a-websites", "/websites"], ["a-settings", "/settings"], ["a-audit", "/audit"]];

const browser = await chromium.launch();
async function shoot(ctx, base, routes, vp) {
  const page = await ctx.newPage();
  for (const [name, path] of routes) {
    try {
      await page.goto(base + path, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${vp}-${name}.png`, fullPage: vp !== "mobile" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${vp}-${name}${overflow > 1 ? `  ⚠ horizontal overflow ${overflow}px` : ""}`);
    } catch (e) { console.log(`${vp}-${name} FAILED ${e.message.split("\n")[0]}`); }
  }
  await page.close();
}
for (const vp of which) {
  if (!only || only === "auth") { const ctx = await browser.newContext({ viewport: VIEWPORTS[vp] }); await shoot(ctx, WEB, sel(auth), vp); await ctx.close(); }
  if ((!only || only === "customer") && process.env.REVIEW_EMAIL) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[vp] });
    const r = ctx.request;
    await r.get(`${WEB}/api/v1/auth/csrf`);
    const csrf = (await ctx.cookies()).find((c) => c.name.endsWith("wim_csrf"))?.value;
    const login = await r.post(`${WEB}/api/v1/auth/login`, { data: { email: process.env.REVIEW_EMAIL, password: process.env.REVIEW_PASSWORD }, headers: { "x-csrf-token": csrf, origin: WEB } });
    if (login.status() !== 200) throw new Error(`login ${login.status()}`);
    await shoot(ctx, WEB, sel(customer), vp);
    await ctx.close();
  }
  if ((!only || only === "admin") && process.env.ADMIN_TOTP_SECRET) {
    const { totp } = await import(new URL("../../packages/crypto/dist/index.js", import.meta.url));
    // TOTP codes are single-use (replay protection): wait for a fresh 30 s window before each admin sign-in.
    await new Promise((r) => setTimeout(r, (30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 500));
    const ctx = await browser.newContext({ viewport: VIEWPORTS[vp] });
    await ctx.request.get(`${ADMIN}/api/admin/v1/auth/csrf`);
    const csrf = (await ctx.cookies()).find((c) => c.name.endsWith("wim_admin_csrf"))?.value;
    const login = await ctx.request.post(`${ADMIN}/api/admin/v1/auth/login`, { data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, code: totp(process.env.ADMIN_TOTP_SECRET) }, headers: { "x-csrf-token": csrf, origin: ADMIN } });
    if (login.status() !== 200) console.log(`admin login ${login.status()}`); else await shoot(ctx, ADMIN, sel(admin), vp);
    await ctx.close();
  }
}
await browser.close();
