// Idempotent seed, run as the schema owner after migrations + SQL:
//   permissions and system roles from @wim/core (exact sync), and default
//   platform settings (inserted only when missing, so admin edits are kept).
import pg from "pg";
import { PERMISSIONS, SYSTEM_ROLES, SETTINGS } from "@wim/core";

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
  await client.query("COMMIT");
  console.log(`seeded ${Object.keys(PERMISSIONS).length} permissions, ${Object.keys(SYSTEM_ROLES).length} system roles, ${inserted} new settings`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
