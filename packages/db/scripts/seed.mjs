// Idempotent seed, run as the schema owner after migrations + SQL:
//   permissions and system roles from @wim/core (exact sync), and default
//   platform settings (inserted only when missing, so admin edits are kept).
import pg from "pg";
import { PERMISSIONS, SYSTEM_ROLES, SETTINGS } from "@wim/core";

const EXAMPLE = "Example pricing (decision B2): edit in Super Admin → Plans before launch.";
/** [interval, currency, amount in minor units (paise / cents)] */
const EXAMPLE_PLANS = [
  { key: "free", name: "Free", description: `${EXAMPLE} One website, basic uptime checks.`, trialEligible: false, priority: 9, sortOrder: 0, prices: [],
    entitlements: { "monitoring.maxWebsites": 1, "monitoring.http.minIntervalSec": 900, "monitoring.browser.entitled": false, "monitoring.deepscan.entitled": false } },
  { key: "starter", name: "Starter", description: `${EXAMPLE} Small sites: HTTP monitoring for a few websites.`, trialEligible: true, priority: 7, sortOrder: 10,
    prices: [["MONTH", "INR", 99_900], ["YEAR", "INR", 999_000], ["MONTH", "USD", 1_500], ["YEAR", "USD", 15_000]],
    entitlements: { "monitoring.maxWebsites": 3, "monitoring.http.minIntervalSec": 300, "monitoring.browser.entitled": false, "monitoring.deepscan.entitled": false } },
  { key: "pro", name: "Pro", description: `${EXAMPLE} Browser checks and deep scans for growing teams.`, trialEligible: true, priority: 5, sortOrder: 20,
    prices: [["MONTH", "INR", 249_900], ["YEAR", "INR", 2_499_000], ["MONTH", "USD", 3_900], ["YEAR", "USD", 39_000]],
    entitlements: { "monitoring.maxWebsites": 10, "monitoring.http.minIntervalSec": 60, "monitoring.browser.entitled": true, "monitoring.browser.maxWebsites": 5,
      "monitoring.deepscan.entitled": true, "monitoring.deepscan.maxWebsites": 3, "monitoring.weight": 2 } },
  { key: "business", name: "Business", description: `${EXAMPLE} Many websites with full browser and deep-scan coverage.`, trialEligible: true, priority: 3, sortOrder: 30,
    prices: [["MONTH", "INR", 799_900], ["YEAR", "INR", 7_999_000], ["MONTH", "USD", 9_900], ["YEAR", "USD", 99_000]],
    entitlements: { "monitoring.maxWebsites": 50, "monitoring.http.minIntervalSec": 60, "monitoring.browser.entitled": true, "monitoring.browser.maxWebsites": 25,
      "monitoring.deepscan.entitled": true, "monitoring.deepscan.maxWebsites": 15, "monitoring.weight": 4, "monitoring.performance.customThresholds": true } },
];

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await client.query(
      `INSERT INTO permissions (key, description) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`, [key, description]);
  }
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const { rows } = await client.query(
      `INSERT INTO roles (key, name, description, is_system, org_id) VALUES ($1, $2, $3, true, NULL)
       ON CONFLICT (key) WHERE org_id IS NULL DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`, [key, role.name, role.description]);
    const roleId = rows[0].id;
    await client.query("DELETE FROM role_permissions WHERE role_id = $1 AND NOT (permission_key = ANY($2))", [roleId, role.permissions]);
    for (const p of role.permissions) {
      await client.query("INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [roleId, p]);
    }
  }
  let inserted = 0;
  for (const [key, def] of Object.entries(SETTINGS)) {
    const r = await client.query(
      `INSERT INTO platform_settings (key, scope, value, version, updated_at) VALUES ($1, 'PLATFORM', $2::jsonb, 1, now())
       ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(def.default)]);
    inserted += r.rowCount;
  }
  // Phase 8: EXAMPLE plans (open decision B2 — real prices and limits are a business decision). Inserted only when the
  // plan key does not exist yet; prices/entitlements only when the plan has none, so admin edits are never overwritten.
  let plansInserted = 0;
  for (const p of EXAMPLE_PLANS) {
    const { rows } = await client.query(
      `INSERT INTO subscription_plans (key, name, description, visible, active, trial_eligible, priority, sort_order, updated_at)
       VALUES ($1, $2, $3, true, true, $4, $5, $6, now()) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [p.key, p.name, p.description, p.trialEligible, p.priority, p.sortOrder]);
    if (!rows.length) continue;
    plansInserted++;
    const planId = rows[0].id;
    for (const [interval, currency, amountMinor] of p.prices) {
      await client.query(
        `INSERT INTO plan_prices (plan_id, interval, currency, amount_minor, version, active) VALUES ($1, $2, $3, $4, 1, true)
         ON CONFLICT (plan_id, interval, currency, version) DO NOTHING`, [planId, interval, currency, amountMinor]);
    }
    for (const [key, value] of Object.entries(p.entitlements)) {
      await client.query(`INSERT INTO plan_entitlements (plan_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING`, [planId, key, JSON.stringify(value)]);
    }
  }
  await client.query("COMMIT");
  console.log(`seeded ${Object.keys(PERMISSIONS).length} permissions, ${Object.keys(SYSTEM_ROLES).length} system roles, ${inserted} new settings, ${plansInserted} new example plans`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
