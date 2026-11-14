# Database credentials and secret provisioning (release readiness, blockers 3 and 6)

> Status: **design + startup enforcement implemented; production provisioning NOT performed** (no production secret
> manager or database was available). Nothing in this file is a real credential.

## 1. Roles and who uses them

| Role | Used by | Environment variable | Least-privilege source |
|---|---|---|---|
| `wim_app` | API (customer requests) | `DATABASE_URL` | RLS per organisation (`sql/020`, `050`) |
| `wim_admin` | API (Super Admin) | `ADMIN_DATABASE_URL` | views + column grants (`050`, `150`) |
| `wim_worker` | scheduler, worker-http, worker-notify | `WORKER_DATABASE_URL` | system policies (broad by design; candidates for later narrowing) |
| **`wim_browser`** | **worker-browser** | **`BROWSER_DATABASE_URL`** | `sql/160_browser_role.sql`, invariant 1g |
| **`wim_scanner`** | **worker-deepscan** | **`SCANNER_DATABASE_URL`** | `sql/110_deep_scan.sql` |
| `wim_ingest` | ingest | `INGEST_DATABASE_URL` | `sql/060` |
| `wim_owner` | migrations only (CI/CD job, never a running service) | `MIGRATION_DATABASE_URL` | owner |

Development passwords (`<role>_dev_password`) exist only in `infra/postgres/init` and `.env`/`.env.example` for the
Docker development database. They must never exist in staging or production.

## 2. Startup enforcement (implemented)

`assertDatabaseRole()` (`packages/db`) runs when worker-browser and worker-deepscan start. The process refuses to
start when:

* the connection is not the expected role (`current_user`) — e.g. a broad worker URL handed to the browser worker;
* the role is `SUPERUSER` or `BYPASSRLS`;
* in production (`NODE_ENV=production`): the password equals the development password, or the URL does not use
  `sslmode=require|verify-ca|verify-full`.

worker-browser additionally refuses `WORKER_DATABASE_URL` as a fallback in production. Errors never include the URL or
password.

## 3. Provisioning (production / staging) — to be executed by the platform operator

Prerequisites: a secret manager (e.g. AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault) reachable by the
orchestrator; the orchestrator injects secrets as environment variables or files at pod start (External Secrets
Operator / CSI driver). Secrets are never committed, never baked into images, never logged.

1. **Create the login** (as the database owner, via the migration job's connection, not interactively from a laptop):
   ```sql
   ALTER ROLE wim_scanner WITH LOGIN PASSWORD :'generated';   -- 32+ random bytes from the secret manager's generator
   ALTER ROLE wim_browser WITH LOGIN PASSWORD :'generated';
   ALTER ROLE wim_scanner CONNECTION LIMIT 40;  ALTER ROLE wim_browser CONNECTION LIMIT 60;
   ```
   Use `psql -v generated=…` from the provisioning job so the value never appears in shell history or job logs.
2. **Store** the full URL (`postgresql://wim_scanner:<pw>@<host>:5432/wim?sslmode=verify-full`) in the secret manager
   under a per-environment path (`/sitesentinel/<env>/db/scanner`). Access policy: only the worker-deepscan service
   identity may read it (and the provisioning role may write it).
3. **Inject** into worker-deepscan as `SCANNER_DATABASE_URL` (worker-browser: `BROWSER_DATABASE_URL`) via the
   orchestrator's secret mechanism. No other workload mounts it.
4. **Verify**: the worker logs `database role verified {role}` at startup; invariants 1g (browser) and the
   deep-scan invariants pass against the environment; `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles` reviewed.

## 4. Rotation (every 90 days, or immediately on suspicion)

Postgres has one password per role, so rotate with two roles or a short overlap:
1. Generate a new password in the secret manager (new version, previous version kept).
2. `ALTER ROLE wim_scanner PASSWORD …new…` — existing connections stay valid; new connections need the new value.
3. Roll the workers (rolling restart) so they read the new secret version; confirm `database role verified` from every
   new pod and no authentication failures in the database log.
4. Disable the previous secret version after all pods restarted.
For zero-risk rotation use a pair of login roles (`wim_scanner_a/_b`, both `IN ROLE wim_scanner` with identical grants
via `GRANT wim_scanner TO …`) and switch between them.

## 5. Revocation (compromise)

1. `ALTER ROLE wim_scanner NOLOGIN;` then `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'wim_scanner';`
   (deep scans stop; executions are reconciled and retried later — monitoring of other tiers continues).
2. Rotate (§4) and re-enable `LOGIN`.
3. Review `pg_stat_activity`/database logs for the window, and the audit trail of the secret manager.

## 6. Separation from development

* Development credentials are only in the Docker init script and local `.env` (git-ignored; `.dockerignore` excludes
  `.env*` and `.keys`, verified in the production images, see RELEASE_READINESS.md §4).
* Startup refuses development passwords in production (§2). The CI secret scan (gitleaks) runs on every push.

## 7. Execution record (2026-11-15)

* No secret manager or production database was available; nothing was provisioned (blocker 6 BLOCKED).
* `wim_scanner` was tightened to match `wim_browser` (`sql/170_scanner_role.sql`, invariant 1h); deep-scan suites pass.
* Rotation (§4) and revocation (§5) **mechanics** were exercised against the local PostgreSQL: old password refused after
  rotation, new accepted, `NOLOGIN` blocks new logins, `pg_terminate_backend` ends sessions; development password
  restored. Correction to §4 wording: the survival of already-open connections across a password change is PostgreSQL
  behaviour but was **not** observed in this test — observe it in staging during the first rotation.
* The production startup guard was verified against the real database (dev password, non-TLS and wrong role refused).
