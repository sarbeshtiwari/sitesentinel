// Production role bootstrap for the Oracle single-server stack (replaces infra/postgres/init/*.sql, which carries
// development passwords and must never be used outside local development).
//
// Runs as the bootstrap superuser (POSTGRES_USER of the postgres container), idempotently, before every migration:
//   - wim_owner: LOGIN, NOT superuser, CREATEROLE; owns the database and schema `public`; runs migrations/SQL/seed.
//     (Same shape as managed Postgres, so packages/db/sql is exercised exactly as on Render.)
//   - runtime roles, each NOSUPERUSER NOBYPASSRLS with its own password from the environment:
//     wim_app (api, ingest settings), wim_admin (admin API), wim_worker (scheduler, worker-http, worker-notify),
//     wim_browser (worker-browser), wim_scanner (worker-deepscan), wim_ingest (ingest_* functions only),
//     wim_readonly (BI/support), wim_breakglass (NOLOGIN; owns break-glass functions).
//   - wim_owner gets ADMIN OPTION (without membership) on the runtime roles so packages/db/sql can `ALTER ROLE … SET`.
//   - extensions citext, pgcrypto (public) and pg_stat_statements (schema `extensions`); CONNECT only for these roles.
// Passwords are never logged (statement logging is switched off for this session).
import { createRequire } from "node:module";

const require = createRequire("/src/packages/db/package.json");
const pg = require("pg");

const url = process.env.BOOTSTRAP_DATABASE_URL;
if (!url) throw new Error("BOOTSTRAP_DATABASE_URL is required");
const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new Error("unexpected database name");

const LOGIN_ROLES = {
  wim_app: "PG_APP_PASSWORD",
  wim_admin: "PG_ADMIN_PASSWORD",
  wim_worker: "PG_WORKER_PASSWORD",
  wim_browser: "PG_BROWSER_PASSWORD",
  wim_scanner: "PG_SCANNER_PASSWORD",
  wim_ingest: "PG_INGEST_PASSWORD",
  wim_readonly: "PG_READONLY_PASSWORD",
};
const secret = (name) => {
  const v = process.env[name] ?? "";
  if (v.length < 24) throw new Error(`${name} must be set (at least 24 characters)`);
  if (/_dev_password$|CHANGE_ME/.test(v)) throw new Error(`${name} is a development/placeholder value`);
  return v;
};
const ownerPassword = secret("PG_OWNER_PASSWORD");
const passwords = Object.fromEntries(Object.entries(LOGIN_ROLES).map(([role, env]) => [role, secret(env)]));

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (text, values) => client.query(text, values);
// Server-side quoting (format %I / %L): role names and passwords are never concatenated into SQL here.
const exec = async (fmt, ...args) => {
  const params = args.map((_, i) => `, $${i + 2}::text`).join("");
  const { rows } = await q(`SELECT format($1::text${params}) AS sql`, [fmt, ...args]);
  await q(rows[0].sql);
};
const exists = async (role) => (await q("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount > 0;

try {
  await q("SET log_statement = 'none'");
  await q("SET log_min_duration_statement = -1");
  const { rows: [me] } = await q("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  if (!me?.rolsuper) throw new Error("BOOTSTRAP_DATABASE_URL must connect as the bootstrap superuser");

  // owner
  if (!(await exists("wim_owner"))) await q("CREATE ROLE wim_owner LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS");
  await exec("ALTER ROLE wim_owner WITH LOGIN NOSUPERUSER CREATEROLE NOREPLICATION PASSWORD %L", ownerPassword);
  await exec("ALTER DATABASE %I OWNER TO wim_owner", dbName);
  await q("ALTER SCHEMA public OWNER TO wim_owner");

  for (const ext of ["citext", "pgcrypto"]) await q(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
  // pg_stat_statements (query statistics for operators) lives in its own schema: its functions are superuser-owned,
  // and packages/db/sql revokes "ALL FUNCTIONS IN SCHEMA public" as the non-superuser owner (as on managed Postgres).
  await q("CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION postgres");
  await q("REVOKE ALL ON SCHEMA extensions FROM PUBLIC");
  const { rows: pss } = await q("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'");
  if (!pss.length) await q("CREATE EXTENSION pg_stat_statements SCHEMA extensions");
  else if (pss[0].nspname !== "extensions") await q("ALTER EXTENSION pg_stat_statements SET SCHEMA extensions");

  // runtime roles: created BY wim_owner (PG16 then grants it ADMIN OPTION automatically), otherwise granted explicitly
  for (const role of [...Object.keys(LOGIN_ROLES), "wim_breakglass"]) {
    if (!(await exists(role))) {
      await q("SET ROLE wim_owner");
      await exec("CREATE ROLE %I NOLOGIN NOBYPASSRLS", role);
      await q("RESET ROLE");
    }
    await exec("GRANT %I TO wim_owner WITH ADMIN OPTION, INHERIT FALSE, SET FALSE", role);
  }
  for (const [role, pw] of Object.entries(passwords)) {
    await exec("ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L", role, pw);
  }
  await q("ALTER ROLE wim_breakglass WITH NOLOGIN NOSUPERUSER NOBYPASSRLS");

  // connect/usage only for our roles
  await exec("REVOKE ALL ON DATABASE %I FROM PUBLIC", dbName);
  for (const role of Object.keys(LOGIN_ROLES)) {
    await exec("GRANT CONNECT ON DATABASE %I TO %I", dbName, role);
    await exec("GRANT USAGE ON SCHEMA public TO %I", role);
  }
  await q("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  console.log(`roles ok: wim_owner + ${Object.keys(LOGIN_ROLES).length} runtime roles + wim_breakglass`);
} finally {
  await client.end();
}
