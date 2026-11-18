// Creates a fresh, isolated integration-test database (default: wim_test) on the
// Docker Postgres, then applies migrations, the SQL layer and the seed.
// Only ever touches a database whose name ends in "_test".
import pg from "pg";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
const testDb = process.env.TEST_DATABASE_NAME ?? "wim_test";
if (!testDb.endsWith("_test")) throw new Error(`refusing to recreate non-test database ${testDb}`);

const admin = new pg.Client({ connectionString: Object.assign(new URL(base), { pathname: "/postgres" }).toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${testDb}"`);
await admin.end();

const url = Object.assign(new URL(base), { pathname: `/${testDb}` }).toString();
const env = { ...process.env, MIGRATION_DATABASE_URL: url };
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules", ".bin");
execFileSync(join(bin, "prisma"), ["migrate", "deploy"], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
// Applied twice: production re-applies the (idempotent) SQL layer on every deploy, so tests and the invariants
// must see the database a redeploy leaves behind, not only a first install (grants on views drifted that way).
for (let i = 0; i < 2; i++) {
  execFileSync("node", ["scripts/apply-sql.mjs"], { cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "inherit"] });
}
execFileSync("node", ["scripts/seed.mjs"], { cwd: root, env, stdio: "inherit" });
console.log(`test database ready: ${testDb}`);
