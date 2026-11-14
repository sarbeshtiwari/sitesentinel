-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Production roles are created by infra/postgres/roles.sql with secrets from the vault;
-- the passwords below are for local development only.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- wim_owner (POSTGRES_USER) owns the schema and runs migrations.
-- Runtime roles are NOT owners and have no BYPASSRLS, so RLS applies to them.
CREATE ROLE wim_app    LOGIN PASSWORD 'wim_app_dev_password'    NOBYPASSRLS; -- api, realtime, ingest
CREATE ROLE wim_worker LOGIN PASSWORD 'wim_worker_dev_password' NOBYPASSRLS; -- scheduler + workers
CREATE ROLE wim_admin  LOGIN PASSWORD 'wim_admin_dev_password'  NOBYPASSRLS; -- admin API (views only)
CREATE ROLE wim_readonly LOGIN PASSWORD 'wim_readonly_dev_password';          -- BI / support read replica

GRANT CONNECT ON DATABASE wim TO wim_app, wim_worker, wim_admin, wim_readonly;
GRANT USAGE ON SCHEMA public TO wim_app, wim_worker, wim_admin, wim_readonly;

-- Browser workers get a narrower role: read job config, write results only (SECURITY.md §browser isolation).
CREATE ROLE wim_browser LOGIN PASSWORD 'wim_browser_dev_password' NOBYPASSRLS;
-- Owner of break-glass SECURITY DEFINER functions (Phase 9). Never used to log in.
CREATE ROLE wim_breakglass NOLOGIN NOBYPASSRLS;

GRANT CONNECT ON DATABASE wim TO wim_browser;
GRANT USAGE ON SCHEMA public TO wim_browser;

-- New databases (Prisma's shadow DB, the integration-test DB) are created from
-- template1, so give it the extensions the schema needs.
\connect template1
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- SDK ingest endpoint: executes ingest_* functions only, no table privileges (070_websites.sql).
\connect wim
CREATE ROLE wim_ingest LOGIN PASSWORD 'wim_ingest_dev_password' NOBYPASSRLS;
GRANT CONNECT ON DATABASE wim TO wim_ingest;
GRANT USAGE ON SCHEMA public TO wim_ingest;
