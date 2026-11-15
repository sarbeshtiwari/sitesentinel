# SiteSentinel final audit: test & build execution, database / data integrity

Auditor workstream: tests + DB. Date 2026-11-15. Repo `./`, branch `stage`, HEAD `8ce5981` plus an uncommitted working tree. Other workstreams were editing the tree during this run (UI files, `apps/worker-deepscan/src/finalize.ts`, `apps/api/test/integration/deep-scan.test.ts`). Those edits are not mine.
Host: macOS (Darwin 27), Node v25.9.0 (CI uses Node 24), pnpm 10.33.2, Docker 29.6.1 (linux/aarch64).
Infra: the local Docker `wim-dev` stack: Postgres 127.0.0.1:55432, Redis 56379, SeaweedFS S3 58333, Mailpit 51025/58025.
Raw logs are in `<audit scratch>`: `typecheck-force.log`, `unit.log`, `integration.log`, `integration-rerun-scheduler.log`, `integration-postfix.log`, `invariants-*.log`, `build.log`, `lint.log`, `ci-runs.txt`, `schema-*.sql`, `privs-*.txt`.

Nothing in this workstream touched Render or live. I killed no process. Every query on dev `wim` ran in a session with `default_transaction_read_only = on`; `db:invariants` runs inside `BEGIN … ROLLBACK`.

---

## 1. Test execution table

| # | Command | Env | Result | Duration | Evidence |
|---|---|---|---|---|---|
| 1 | `pnpm -s typecheck` (turbo, cached) | local | **PASS**: 45/45 tasks (29 cached) | 12 s | exit 0 |
| 1b | `pnpm -s turbo run typecheck --force` (no cache) | local | **PASS**: 45/45 tasks, 0 `error TS` | 26 s | `typecheck-force.log` |
| 2 | `pnpm -s turbo run test:unit --force` | local, no infra | **PASS**: 32/32 turbo tasks; **452 tests passed, 0 failed, 0 skipped** across 20 files | 15 s | `unit.log` |
| 3 | `pnpm --filter @wim/api test:integration` (run 1) | real PG `wim_test`, Redis db1, Mailpit, SeaweedFS, real Chromium | **FAIL**: 26 files (1 failed / 25 passed); **306 tests: 305 passed, 1 failed, 0 skipped** | 987 s | `integration.log` |
| 3b | rerun of the failed file: `vitest run test/integration/scheduler.test.ts` | same | **PASS**: 24/24 | 55 s | `integration-rerun-scheduler.log` |
| 3c | full integration suite again (after the DB fix in §5, with `wim_test` rebuilt by the new double-apply setup) | same | **PASS**: 26/26 files; **307/307 tests passed, 0 skipped** (+1 test added to `deep-scan.test.ts` by another workstream during the audit) | 990 s | `integration-postfix.log` |
| 4 | `pnpm -s db:invariants` (dev `wim`, rolled back), before the new check | dev `wim` | **PASS**: 19 PASS notices, "ALL DATABASE INVARIANTS PASSED" | 1 s | `invariants-wim.log` |
| 4b | `pnpm -s db:invariants` with the new invariant 1i (see §5) | dev `wim` | **FAIL** (real defect): `wim_app holds privileges on view admin_v_domain_transfers` | 1 s | `invariants-wim-after-newcheck.log` |
| 4c | invariants on the rebuilt `wim_test` (fixed SQL applied twice) | `wim_test` | **PASS**: 20 PASS notices incl. "no runtime tenant/worker role holds an owner-privileged view" | 1 s | `invariants-wim_test-fixed.log` |
| 5 | `pnpm -s turbo run build --force` (all 24 packages/apps incl. `next build` for web + admin) | local | **PASS**: 24/24 tasks, 0 cached; web 15 static + dynamic routes, admin 18 | 24 s | `build.log` |
| 6 | `pnpm lint` | local | exit 0, but **NOT A LINT**: no package defines a `lint` script and there is no ESLint/Biome config anywhere in the repo (`eslint.config.*`, `.eslintrc*`, `biome.json` all absent). Turbo only ran the `^build` dependencies (21 tasks, 20 cached). Static checking is `tsc --noEmit` only. | 3 s | `lint.log` |
| 7 | Network-isolation suite (`infra/security/run-isolation-tests.sh`) | n/a | **BLOCKED locally** (reason below); **PASS in CI** | n/a | CI job `isolation` |
| 8 | CI history `gh run list --repo sarbeshtiwari/sitesentinel --limit 15` | GitHub Actions | 14 success, 1 failure (43682505197, stage, 05:46Z) | 19–24 min/run | `ci-runs.txt` |

Unit test counts per package (vitest output, `--force`):

| Package | Files | Tests |
|---|---|---|
| @wim/core | 10 | 290 |
| @wim/netguard | 1 | 56 |
| @wim/egress-gateway | 1 | 34 |
| @wim/crypto | 1 | 20 |
| @wim/billing | 1 | 17 |
| @wim/queue | 1 | 14 |
| @wim/email | 1 | 8 |
| @wim/worker-deepscan | 1 | 6 |
| @wim/sdk | 1 | 3 |
| @wim/storage | 1 | 2 |
| @wim/logger | 1 | 2 |
| **Total** | **20** | **452** (0 fail, 0 skip) |

Integration suite: 26 files under `apps/api/test/integration`, run file-serially (`fileParallelism:false`). No `.skip`, `.todo`, `skipIf` or `runIf` exists in any integration file (grep), and vitest reported 0 skipped. The browser*, performance* and deep-scan* suites ran with real Chromium and local SeaweedFS and passed.

**Isolation suite (item 7), BLOCKED locally.** The script brings up a Compose topology that bind-mounts the repo, runs `node:24-alpine` and Playwright `noble` images, and in CI uses production images built from `infra/docker/*.Dockerfile` for **linux/amd64**. This host is linux/aarch64 Docker Desktop. The local `wim-*:amd64` images would need emulation, and the probes rely on Linux-host kernel/seccomp behaviour (the CI job sets the user-namespace sysctl). CI documents the job as proof "on a Linux Docker host". It would not touch 8091/3301: it uses internal-only 10.250.x networks and publishes no ports. It was not run, so that no misleading aarch64/emulated result gets reported as proof. Evidence used instead: CI run 43701390673 (stage, HEAD-equivalent `8ce5981`) `isolation` job PASS, "170 checks, 0 violations; gateway recorded 60 refusals", with non-vacuity checks PASS (20 ALLOWED decisions; runner-attributed 3; deep-scan attributed 6, 0 internal). CI run 43703272806 (main merge) also PASS for both `isolation` and `test`. The `test` job on main shows unit 452/452, integration "26 passed (26) / 306 passed (306)" and "ALL DATABASE INVARIANTS PASSED".

**CI failure 43682505197** (stage, 05:46Z): `platform-ops.test.ts > a healthy platform evaluates healthy and opens nothing` failed because the CI runner's real CPU reading (`worker-notify … CPU 146% of one core`) tripped `resources.cpu`. Commit 43684404831 ("healthy-platform check ignores the CI runner's real CPU/disk load") fixed it, and every later run is green. It was an environment-sensitive test, not a product defect.

---

## 2. Failures with analysis

### F1. `scheduler.test.ts > dispatches one execution per website per window …`: **FLAKY (timing), not a product bug**
- Run 1: `expected … to have a length of 3 but got 4` at `scheduler.test.ts:102`, after the second `s.runCycle()` ("the same window again: nothing new").
- Run 2 (file alone): 24/24 PASS. Run 3 (full suite after the fix): PASS.
- Cause: the test assumes both `runCycle()` calls fall in the same 60 s jitter-aligned window. The scheduler advances `next_run_at` to the next window start (`packages/queue/src/scheduler.ts:169`). If wall-clock time crosses that boundary between the two cycles, a 4th execution for the new window is correct behaviour. Run 1 overlapped with another audit workstream's concurrent vitest run (separate `wim_audit_test` DB, Redis db 3, prefix `wimaudit`), so CPU contention made the crossing more likely. The DB-level guarantee held: `monitoring_executions UNIQUE(schedule_id, slot, queued_at)`, and there were 0 duplicate (schedule, slot) rows for scheduled executions on dev `wim` (see §4).
- Recommendation, not applied: make the test deterministic. Freeze or inject `now`, or assert that the second cycle created no execution for the *same* window. I did not weaken the assertion.

### F2. `db:invariants` on dev `wim` with the new invariant 1i: **DETERMINISTIC REAL DEFECT (fixed in repo, see §5)**

No other failures.

---

## 3. Coverage gaps (critical requirement → covering tests)

| Requirement | Covering tests (runtime-verified in this run) | Assessment |
|---|---|---|
| Tenant isolation | `tenant-isolation.test.ts` (auto-discovers every `:orgId` route: 404 to non-members, foreign ids 404, RLS as `wim_app`: no-context = 0 rows, cross-tenant write refused, user-scoped rows), per-feature cross-tenant tests in websites/sdk/dashboard/billing/browser/deep-scan; invariants §4/§8 | Strong. **Gap (found + fixed here):** nothing checked privileges on owner-privileged **views**, or the state after the SQL layer is re-applied, which is what every deploy does. |
| Auth / sessions | `auth.test.ts` (15): CSRF/origin, HttpOnly SameSite cookie, generic errors, progressive delay, logout revocation, list/revoke sessions, reset revokes all, change password rotates | Good. **Gap:** no test of idle/absolute session **expiry** (`auth.session.absoluteDays`), i.e. that an expired session is refused. Grep found no expiry test in `apps/api/test`. |
| 2FA | `mfa.test.ts` (13): TOTP enroll, replay, per-session and per-account guess caps, recovery codes single-use, lost-device delayed reset; `admin.test.ts` admin TOTP | Good |
| Verification methods | `websites.test.ts` (25): DNS TXT, HTML file, meta tag, regeneration, expiry, attempt budgets, ROOT_EXCLUSIVE, SSRF/rebinding; `revalidation.test.ts` (9) | Good |
| HTTP monitoring / incidents | `http-monitoring.test.ts` (17), `http-monitoring-api.test.ts`, `dashboard-api.test.ts`; invariant: one active incident per fingerprint | Good |
| Browser monitoring | `browser-monitoring.test.ts` (17, real Chromium via gateway), `browser-monitoring-api.test.ts` | Good |
| Deep scan | `deep-scan.test.ts` (17→18), `deep-scan-api.test.ts`; invariants 1c, 1h | Good |
| Components | `browser-components.test.ts` (14); invariant 1d | Good |
| Functional-test safety | `browser-components.test.ts`: destructive controls skipped, forms never submitted, side-effect GET guard, blocker 5/9 path confinement, platform switch AND customer acknowledgement | Good |
| Performance rollups | `performance.test.ts` (3), `performance-load.test.ts` (2); invariant 1e | Adequate (rollups exact and idempotent are asserted) |
| Platform health | `platform-ops.test.ts` (22), `ops-load.test.ts` | Good |
| Usage reconciliation | `usage-config.test.ts` (7) | Good |
| Billing webhooks | `billing.test.ts` (17): spoofing, replay, idempotency, ordering, cross-org metadata; invariant 10 | Good for the core. Billing is not payment-ready by design (`billing.enabled=false`). |

Critical paths with **no meaningful test**:
1. **Organization deletion purge.** `POST /orgs/:id/deletion` sets `PENDING_DELETION` and writes `data_requests(kind=DELETE_ORG)`, and the UI promises "Deletion happens after a 14-day grace period". **No code processes `data_requests`.** Grep for `DELETE_ORG` / `dataRequest` finds only the writer in `apps/api/src/orgs/orgs.service.ts`, and the comment there says "purge runs in the maintenance worker, Phase 10". Only RBAC on the endpoint is tested (`orgs-rbac.test.ts:120`). This is a functional/privacy gap, not only a test gap.
2. **Partition maintenance / retention drop** (`partitions.ensure_all()` / `apply_retention()` via `partitionMaintenance` in `packages/queue/src/maintenance.ts`). No integration test calls it. Only retention *settings and floors* are tested (`usage-config.test.ts`), and invariant 1 checks that current partitions are routable.
3. **Session expiry** (above).
4. **Cleanup of expired rows in non-partitioned tables.** `user_sessions`, `email_verification_tokens`, `password_reset_tokens` and `outbox_events` (published rows) have no purge code and no test. On dev `wim`, all 377 outbox rows are published and retained. This becomes a growth issue over time.
5. Tables with no application code at all, so there is nothing to test: `maintenance_windows`, `break_glass_requests` (only the DB invariant), `email_suppressions`, `incident_comments`, `report_jobs`.
6. **Lint**: none configured (see §1).

---

## 4. Database audit

| Item | Status | Evidence |
|---|---|---|
| `prisma migrate status`, dev `wim` | **PASS** | "18 migrations found … Database schema is up to date!" |
| `prisma migrate status`, `wim_test` | **PASS** | same |
| Drift DB → schema.prisma (`migrate diff --from-config-datasource --to-schema … --exit-code`) | **PASS** | `wim`: empty migration, exit 0; `wim_test`: "No difference detected", exit 0 |
| Drift migrations → schema (`--from-migrations`) | **BLOCKED** | Needs `datasource.shadowDatabaseUrl` in `prisma.config.ts`, which is not configured. Covered indirectly: a fresh `wim_test` built from the migrations shows no diff against the schema. |
| `wim` vs `wim_test` structural diff (`pg_dump --schema-only`, excluding the `partitions` schema) | **PARTIAL** | Same DDL. Differences: `pg_stat_statements` extension exists only in `wim`, and **view grants to wim_app/wim_worker exist only in `wim`** (the defect below). |
| FKs | **PASS** (with design notes) | 58 FKs, 0 unvalidated. 47 tables carry `org_id` without an FK to `organizations`. This is by design for partitioned and child tables (documented in schema.prisma), and SQL triggers enforce child-tenant consistency where it matters (060/110/130). Data check on dev `wim`: 0 org mismatches between websites and api_endpoints, incidents, monitored_pages, deep_scans, schedules and execution_results; 0 orphan incidents and 0 orphan results. 14 FK columns have no leading index (e.g. `maintenance_windows.website_id`, `email_verification_tokens.user_id`). That is minor cascade-performance work. |
| Unique constraints | **PASS** | `domain_claims_one_live_claim` (partial), `incidents_one_active_per_fingerprint (org_id,fingerprint) WHERE active`, `incidents(org_id,number)`, `deep_scans_one_running_per_website`, `trials(org_id)`, `domain_trial_ledger` PK `registrable_domain`, `payment_webhook_events(gateway,event_id)`, `platform_alerts_one_open`, `usage_discrepancies_unique`. Dev data: 0 duplicate active incidents, 0 duplicate live claims, 0 orgs with more than one trial, 0 sites with more than one running scan. |
| Execution-result idempotency | **PASS** | `execution_results` PK `execution_id`; `result_requires_ledger` trigger on all 5 result parents and every partition; `deep_scan_final_needs_ledger`; `monitoring_executions UNIQUE(schedule_id, slot, queued_at)`. Dev data: the only (schedule, slot) group with more than one row is `slot=NULL` with 7 `MANUAL`-trigger rows, which is expected because manual runs have no slot. Invariant 1b PASS. |
| Partitioning (`010_partitions`) | **PASS** | 16 range-partitioned parents. Daily parents have 11 partitions (2026-11-12 → 11-22, premake 7); monthly parents have 3 (2026-11 → 2027-01). No DEFAULT partitions. Children live in schema `partitions` with no grants to runtime roles (access only through parents). Invariant 1 PASS. |
| Retention jobs present | **PARTIAL** | Present and scheduled: `partitionMaintenance` (hourly, advisory-locked, failure recorded as a health signal) via `apps/scheduler`; deep-scan retention in `apps/worker-deepscan`; retention floors (`ops.set_retention`, 150_operations). Missing: purge for `data_requests` (org deletion), expired sessions/tokens and published `outbox_events`. No integration test exercises the partition drop. |
| Role flags | **PASS** | `wim_app, wim_worker, wim_admin, wim_browser, wim_scanner, wim_ingest, wim_readonly, wim_breakglass`: all `rolsuper=f, rolbypassrls=f, createrole=f, createdb=f`. `wim_owner` is superuser + BYPASSRLS. That is acceptable for local dev and is the migration role only. On managed PG it is not a superuser (160/170 handle that). No role memberships. Runtime roles have no CREATE on `public`, `partitions` or `ops`; no TRUNCATE/TRIGGER/REFERENCES. All 43 SECURITY DEFINER functions pin `search_path`. |
| Role grants on views | **FAIL on dev `wim` → fixed in repo** | See defect D1. |
| RLS enabled on tenant tables | **PASS** (by documented design) | 66 tables have RLS enabled with policies. 4 `org_id` tables have no RLS: `data_requests`, `outbox_events`, `security_events`, `job_failures`. These are documented exceptions in `020_rls.sql:25-27` and DATABASE_SCHEMA.md §7, protected by grants (`outbox_events` is SELECT-only for `wim_app`; `job_failures` is not granted to `wim_app`). **Note:** `wim_app` has full SELECT/INSERT/UPDATE/DELETE on `data_requests` and `security_events` with no RLS, so tenant scoping depends on app code alone ("API scopes in app layer"). That is acceptable per design, but it is defence-in-depth gap G1. |
| FORCE RLS | **PARTIAL** (design choice) | 0/66 tables have `relforcerowsecurity`. `020_rls.sql:10` deliberately leaves the owner unaffected. Runtime roles are not owners, so RLS applies to them (invariant 4 PASS). SECURITY.md threat E's mitigation column lists "`FORCE ROW LEVEL SECURITY`", but it is not applied. This is a doc/implementation mismatch. |
| Audit log append-only + hash chain | **PASS** | Triggers `audit_logs_chain` (BEFORE INSERT), `audit_logs_immutable` (BEFORE UPDATE/DELETE), `audit_logs_no_truncate`. Runtime roles have INSERT+SELECT only. `audit_verify()` over **all 161 streams / 1,156 rows on dev `wim`: 0 broken streams**. Invariant 6 PASS (tamper detected at seq 2). `platform_setting_history` has the `append_only` trigger. |
| Trial-ledger invariants | **PASS** | `wim_app` SELECT only on `domain_trial_ledger` (UPDATE/DELETE revoked); `trials.org_id` unique; data: 0 rows with `registration_count < 1`. Ledger survives org deletion (websites/billing tests). Note: `wim_admin` has UPDATE on all ledger columns (needed for admin reset, audited in app). |
| Admin privacy | **PASS** | Invariant 7: admin cannot read incidents or credentials; `wim_admin` lost `websites.canonical_origin` (150_operations). |

### Defect D1 (critical, security): every redeploy grants the tenant runtime roles cross-tenant read access through `admin_v_*` views
- `packages/db/sql/050_grants.sql` runs `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wim_app` and the same for `wim_worker`. In PostgreSQL, "ALL TABLES" includes **views**. On a fresh database (CI, `wim_test`) the views are created *later*, in 050/060/…/150, so they are not covered and CI is green. `apply-sql.mjs` re-runs every SQL file on **every deploy** (`migrate:deploy` = `prisma migrate deploy && apply-sql && seed`, DEPLOYMENT.md step 4). From the second application on, `wim_app` and `wim_worker` receive `arwd` on all 17 `admin_v_*` views and on `pg_stat_statements`.
- Views execute with the owner's (`wim_owner`) privileges, so they **bypass RLS**. I reproduced this on `wim_test` (rolled back, `SET LOCAL ROLE wim_app`, no org context): `organizations` returned 0 rows, while `admin_v_organizations` returned 36 orgs (names, slugs, plan, masked owner email), `admin_v_websites` returned 185 rows, and `UPDATE admin_v_usage_daily …` updated 51 rows. `admin_v_usage_daily` is an auto-updatable simple view over `usage_counters`, so the API role could rewrite any tenant's usage counters.
- On dev `wim` right now, `has_table_privilege('wim_app', <each admin_v_*>, 'SELECT'|'UPDATE') = true` for all 17 views. Deployed environments that ran `migrate:deploy` more than once are very likely in the same state. **I did not check this and must not check Render.** The owner should run the read-only query below on staging/production and re-deploy the fix:
  `select relname from pg_class where relkind='v' and relnamespace='public'::regnamespace and has_table_privilege('wim_app', oid, 'SELECT');`
- Exploitability requires code running as `wim_app` to query these views (SQL injection or a bug in a code path). App code never references `admin_v_*` outside the admin controllers, which use the admin DB. The flaw still defeats the RLS defence-in-depth layer that SECURITY.md relies on.

### Gap G1 (low): `data_requests` / `security_events` writable by `wim_app` without RLS (documented design; consider org-scoped policies)
### Gap G2 (doc): SECURITY.md threat E cites FORCE RLS, but it is not applied.

---

## 5. Defects fixed

**D1, fixed minimally, with a regression check. Not committed.**

Files changed:
1. `packages/db/sql/050_grants.sql`: right after the `wim_worker` "ALL TABLES" grant, a `DO` block now revokes all privileges on every `public` view and matview from `wim_app` and `wim_worker`. The explicit `GRANT SELECT … TO wim_admin, wim_readonly` statements later in the SQL layer re-grant the admin views exactly as before. No production default and no admin access was changed. Verified after the rebuild: `wim_admin` and `wim_readonly` SELECT on `admin_v_organizations` = t, `wim_admin` on `admin_v_usage_daily` = t, `wim_app` = f.
2. `packages/db/tests/invariants.sql`: new invariant **1i**. No `wim_app`, `wim_worker`, `wim_browser`, `wim_scanner` or `wim_ingest` may hold SELECT/INSERT/UPDATE/DELETE on any non-extension view in `public`.
3. `packages/db/scripts/setup-test-db.mjs`: applies the SQL layer **twice**, so `wim_test` (and therefore the integration suite and the CI invariants step, which runs against `wim_test`) reflects the state a redeploy leaves behind.

Verification:
- Without the fix, after a double apply: invariant 1i **fails** on `wim_test` (`wim_app holds privileges on view admin_v_registration_daily`) and on dev `wim` (`… admin_v_domain_transfers`).
- With the fix: `setup-test-db.mjs` ran OK (34 s); invariants on `wim_test` **ALL PASSED** (20 notices); the full integration suite **26/26 files, 307/307 passed** (990 s); `tsc` for `apps/api` exit 0.
- Dev `wim` was **not** modified, because this audit is read-only there. It keeps failing invariant 1i until the owner re-applies the SQL layer (`pnpm db:migrate`). Every deployed environment needs the same re-deploy.

Housekeeping: `next build` rewrote `apps/web/next-env.d.ts` and `apps/admin/next-env.d.ts` (`.next/dev/types` → `.next/types`). I restored both with `git checkout`, so no side effect remains.

---

## Addendum — end-to-end (Playwright) suite, final audit run (2026-11-15)

Environment: local Docker infrastructure; production builds of web/admin (`next start`); each spec against the stack it
needs (fixture DNS/HTTPS fault site, test CA, sandboxed Chromium for 4G). Live workers on the same machine were verified
untouched before/after (process list identical).

| Spec | Run 1 | Run 2 (after fix) | Notes |
|---|---|---|---|
| phase2 (auth, org, admin) | 2 passed, **1 failed** | **3/3 passed** | Real regression from the sidebar redesign: the customer "Settings" group (incl. Audit log) was collapsed by default, hiding the link. Fixed: group open by default (still collapsible). |
| phase3 (websites, verification, SDK, transfers) | **2/2 passed** | — | |
| phase4f (dashboard, HTTP monitoring, deep scan, usage) | **9/9 passed** | — | |
| phase4g (real browser checks, performance, components, responsive, pages) | **4/4 passed** | — | |
| phase4h (platform health, alerts, usage accounting, ops config, functional-test acknowledgement) | **1 failed, 3 not run** | **1 failed, 3 not run** | Run 1: scheduler shown unhealthy because the test machine's disk reports 96 % (correct behaviour; environment). Run 2 (temporary local disk threshold, restored afterwards — verified `{"crit": 95, "warn": 85}`): the precondition "no open deep-scan heartbeat alert" timed out because heartbeat-expired alerts and stale heartbeat rows were left by stopping/restarting stacks between runs. Environmental, but **not passed in this audit**; the same spec passed 4/4 on 2026-11-15 early morning on a clean state. |

**E2E total in this audit: 20 of 22 passed (after one product fix); phase4h not passed (environment state).** The E2E
suite is not part of CI.
