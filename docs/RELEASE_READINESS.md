# Release readiness — Phase 4 (assessment and evidence log)

> Started 2026-11-15. Purpose: decide whether SiteSentinel can move from local development to controlled staging and,
> later, production. This file records the **initial assessment (before any code change)** and is then updated with
> evidence. Evidence classes are never interchangeable:
> **LA** local automated · **LR** local real-infrastructure · **CI** CI verified · **ST** staging verified · **PR** production verified.

## 0. Environment facts established before assessment

| Fact | Finding | Consequence |
|---|---|---|
| Version control | The working tree is **not a Git repository** (no `.git`, no remote). `gh` is authenticated to an account, but no repository is linked. | No CI run can be triggered or observed from here. Blocker 4 cannot be closed in this exercise. |
| CI definition | `.github/workflows/ci.yml`: `test` job (build, typecheck, unit, integration, invariants, gitleaks) and `isolation` job (topology in Docker, probes, artifact upload). The isolation job builds **no production image**; the runner container is the stock Playwright image with the repository mounted read-only. | CI does not validate the production `browser-runner` / `worker-browser` images (blocker 1/4 gap). |
| Container tooling | Docker 29.6.1, **linux/arm64** (Apple silicon VM). | Production images can be built and run locally; they are arm64 builds, not the amd64 artifacts a CI pipeline would publish. |
| Orchestrator | `kubectl` installed, **no context configured**; no staging cluster, firewall or cloud account available. | Blocker 2 (staging) cannot be executed. |
| Secret manager | None configured or reachable. | Blocker 6 can be designed and code-guarded, not provisioned. |
| Load infrastructure | Single Docker Postgres / Redis on one laptop. | Blockers 7/8 can only produce local evidence (LR), never production-scale evidence. |
| Customer monitoring defaults | `monitoring.http/browser/deepscan/functional.enabled` all default **false**. | Monitoring stays disabled after deployment until an operator enables it. |

## 1. Initial matrix (before changes)

| # | Blocker | Current implementation | Exact remaining work | Dependencies | Required evidence | Locally resolvable? | Needs staging / external? |
|---|---|---|---|---|---|---|---|
| 1 | Production `worker-browser` / `browser-runner` image | Dockerfiles exist (`infra/docker/*`): runner on the Playwright image as `pwuser`, sandbox on, HEALTHCHECK; seccomp/cap-drop/read-only documented as run flags only. worker-browser on node:24-alpine as `node`. **Never built in this project's history; the isolation suite runs the stock Playwright image with a mounted repo, not the production image.** | Build both images; inspect user, contents (no secrets), size; run the isolation suite **against the built runner image** with the production run flags; run a real browser check through it; record digests. | Docker. | LR: build logs, digests, `docker inspect` of runtime config, isolation results against the image, a browser result produced by it. Closure additionally needs the same in CI (amd64) and staging. | Partially (LR only). | Yes — CI build + staging run for closure. |
| 2 | Staging isolation probes | `run-isolation-tests.sh` + compose topology reproduce production networks locally (170 checks). No staging manifests exist. | Write deployable manifests / NetworkPolicies / firewall rules, and an executable staging procedure (same probes, run inside staging pods). Execute in staging. | A staging cluster or VM network, image registry. | ST: probe report from deployed staging. | No. | **Yes.** |
| 3 | Narrow `wim_browser` role | `wim_browser` has 21 table grants + column grants (incl. `domain_verifications`, `site_installations`, `auth_recipes`, `test_cases`, `check_results`, `feature_flags`, `websites`). **worker-browser does not even use it: it connects with `WORKER_DATABASE_URL` (`wim_worker`, a broad system role).** | Inventory what worker-browser actually does; reduce `wim_browser` to exactly that; give it only the RLS access it needs; switch worker-browser to `BROWSER_DATABASE_URL`; invariants; run the real-browser suites under the restricted role. | None. | LA + LR: grant inventory, invariants, browser suites passing as `wim_browser`. Closure also needs the production login (blocker 6-style provisioning). | **Yes** (code); production login provisioning external. | Provisioning only. |
| 4 | GitHub CI isolation job | Workflow exists; never observed running; no production image build in CI. | Extend the workflow (build production images, isolation against them, fail on failure, retain artifacts, no secret echo); push to a repository; observe a green run. | A Git repository on GitHub with Actions enabled; owner approval to create/push. | CI: run ID + result. | Workflow edits only. | **Yes** (repository + Actions). |
| 5 | Third-party resource authorisation | Gateway enforces for **every** request: hostnames only, ports 80/443, public addresses only (SSRF, private/metadata, rebinding via vetted-IP connect), per-org/per-execution/total connection limits. Browser capability token is **not host-scoped** (any public host reachable during page load). Main-frame navigation confined to the site by the control plane; service workers blocked; QUIC and non-proxied WebRTC disabled. Third-party scripted calls blocked only during interactions (control-plane route). No written model. | Written authorisation model; gateway-enforced third-party policy carried in the signed token (first-party scope, mode allow/deny/allowlist, distinct-host budget); per-website configuration validated server-side; adversarial tests (gateway + real browser). | None. | LA + LR: model doc, gateway tests, real-browser tests. ST for the deployed gateway. | **Yes.** | Staging confirmation only. |
| 6 | Production `wim_scanner` login and secrets | Role exists (dev password in `infra/postgres/init`). No provisioning design, no startup validation, no rotation procedure. | Provisioning/rotation/revocation design using a secret manager; startup validation refusing wrong role, superuser/BYPASSRLS, or development credentials in production; documentation. | Production secret manager + database. | LA for the validation; PR for provisioning. | Design + validation only. | **Yes** (secret manager, prod DB). |
| 7 | Production-limit multi-tenant load test | Local evidence only (4G rollups/polling, 4H ops). | Load harness parameterised by plan limits; run at production-like scale on production-like infrastructure. | Staging-sized infrastructure. | ST (or a dedicated perf environment). | Harness + local smoke only (LR, not closure). | **Yes.** |
| 8 | Dashboard polling / history-merge load test | Local evidence only. | Harness incl. "dashboard load must not starve scheduling"; run at target concurrency on production-like infrastructure. | Same. | ST. | Local measurement only. | **Yes.** |
| 9 | First-party GET side effects (functional tests) | Default off platform-wide; customer acknowledgement; optional `allowedPaths`; GET-only + unsafe-URL + third-party guard; no form submission. **No technical control proves a GET harmless.** Docs/report phrasing about `allowedPaths` is ambiguous. | Investigate technical isolation; strengthen what is enforceable (mandatory explicit destinations, production lock); align `allowedPaths` semantics across code, API, UI and docs; keep disabled by default; classify as unsupported for production if no isolation exists. | Product-owner risk decision. | LA + LR for controls; closure needs isolation (not available) or an explicit accepted-risk decision. | Mitigations only. | Decision, not infrastructure. |

## 2. Additional gaps in scope (from the 4H report)

API and ingest process health (not observed by the evaluator); CPU and disk; deep-scan retention and screenshot
cleanup failures only logged; no timeout-rate alert; pages-per-scan not reconciled; `OPS_FALLBACK_ALERT_EMAILS` not
validated at startup; **no signal for "customer monitoring has silently stopped"** (results stop arriving while
schedules are active) and no platform-level summary distinct from per-worker health.

---

*Sections below are filled in as evidence is produced.*

## 2. Changes made during the exercise

| Area | Change | Files |
|---|---|---|
| Blocker 3 | New least-privilege `wim_browser` (column grants, `browser_access` RLS limited to the browser tier on executions and the ledger, heartbeat rows limited to its own kind); worker-browser connects via `BROWSER_DATABASE_URL`; `assertDatabaseRole()` startup check (browser, scanner); integration harness runs browser workers as `wim_browser`; invariant 1g | `packages/db/sql/160_browser_role.sql`, `packages/db/src/index.ts`, `apps/worker-browser/src/index.ts`, `apps/worker-deepscan/src/index.ts`, `apps/api/test/helpers/browser-monitoring.ts`, `packages/db/tests/invariants.sql`, `.env.example` |
| Blocker 5 | Third-party policy signed into the browser capability (`t`) and enforced by the gateway for CONNECT and plain HTTP before DNS; per-website `thirdParty` config; malformed policy invalidates the token | `packages/netguard/src/gateway.ts`, `apps/egress-gateway/src/index.ts`, `packages/core/src/monitoring/browser.ts`, `apps/worker-browser/src/engine.ts`, contracts |
| Blocker 9 | `allowedPaths` mandatory (API + worker), `/` = home page only, guard refuses every first-party request type outside declared paths unless the passive load already made it; UI/API/docs semantics aligned | `packages/core/src/monitoring/components.ts`, `apps/worker-browser/src/{interact,observe}.ts`, `apps/api/src/monitoring/browser.controller.ts`, web settings tab |
| Blockers 1/4 | Isolation suite can run the **production runner image** (`RUNNER_IMAGE`); CI builds both production images, checks non-root + no secret material, runs isolation against the runner image, keeps artifacts 90 days | `infra/security/isolation/docker-compose.yml`, `.github/workflows/ci.yml` |
| Blocker 2 | Deployable NetworkPolicies, hardened runner Deployment, probe image, executable staging probe script | `infra/staging/*` |
| Blocker 6 | Provisioning/rotation/revocation design; startup refuses wrong role, superuser/BYPASSRLS, dev passwords and non-TLS in production | `docs/SECRETS_AND_CREDENTIALS.md`, `assertDatabaseRole` |
| Blockers 7/8 | Multi-tenant load harness (3 org sizes, real scheduler/workers/browser, dashboard sessions through the real API, retry storm + worker crash, isolation checks) | `apps/api/test/load/monitoring-load.mjs` |
| Operations | `monitoring.stalled` (silent-stop detection), platform verdict vs worker health, API/ingest Redis heartbeats, CPU/disk, timeout rate, cleanup/retention failures recorded, pages-per-scan reconciliation, `OPS_FALLBACK_ALERT_EMAILS` required in production | `packages/core/src/ops/health.ts`, `packages/queue/src/{ops,heartbeat,reconcile,runtime,util}.ts`, API health controller, ingest, worker-notify, admin platform page |

No new migration was required (all changes are SQL-layer grants/policies, idempotent). No Prisma drift.

## 3. Database permission evidence (blocker 3)

**Before:** worker-browser used `wim_worker` (`SELECT/INSERT/UPDATE/DELETE` on every table, every tenant in system
mode). `wim_browser` existed with unused, partly wrong grants (verification, installations, auth recipes, test cases,
HTTP results) and no system policy.

**After (`wim_browser`):** table-level grants only where every column is needed (result tables INSERT only,
`page_components`, `worker_heartbeats` own kind via RLS, `plan_entitlements` read); everything else column-scoped
(executions: 12 columns read / 10 updatable — never `org_id`, `website_id`, `tier`, `queued_at`; no INSERT/DELETE).
RLS `browser_access` on 25 tables; on `monitoring_executions` and `execution_results` restricted to `tier = 'T2_RENDER'`.
Every grant traces to a code path (inventory by static analysis of worker-browser, runtime, facts, incidents,
persist, components) and the real-browser suites were run under the role, collecting every database denial from the
PostgreSQL log until none remained from the worker (the denials that remain in the log come from test assertions that
deliberately probe forbidden access).

**Invariant 1g** (both databases; each injected regression — read `users`, update execution `org_id`, update a recorded
result, see non-browser executions — makes it fail): no access to identity, credentials, sessions, admin, audit,
billing, notification settings, HTTP or deep-scan results; no column access to protected tables; ownership columns
immutable; verdicts and results not rewritable or readable; other tiers invisible and unwritable; nothing visible
outside system mode.

**Real-browser suites run as `wim_browser` (LA/LR):** browser-monitoring 17/17, browser-components 14/14,
browser-monitoring-api 6/6, performance 3/3.

**Remaining for closure:** production login and secret (SECRETS_AND_CREDENTIALS.md §3) and the invariant run against the
staging database (ST).

## 4. worker-browser / browser-runner image evidence (blocker 1) — LR

| Image | Digest (local, linux/arm64) | User | Size | Content checks |
|---|---|---|---|---|
| `wim-browser-runner:rr` | `sha256:835708f1cdd4e1253e6cd6d42c6eb44a1a2f80dea082f0336620eed8c0a6ed45` | `pwuser` (1001) | 989 MB | `/app` = runner dist + prod deps; no `.env`, keys, PEM or dev passwords; HEALTHCHECK; `NODE_ENV=production`, `RUNNER_SANDBOX=true` |
| `wim-worker-browser:rr` | `sha256:41751d8097fbd11a82dbed4c460ed35ca94ba225e890ee1fc98b3009b1978f49` | `node` (1000) | 166 MB | `/app` = worker dist + `@wim/*` + ioredis, playwright-core (no browsers), zod; no secrets |

**Isolation against the production runner image** (`RUNNER_IMAGE=wim-browser-runner:rr`, its own `/app`, production run
flags: read-only root, `cap_drop: ALL`, `no-new-privileges`, Chromium seccomp profile, 1 GiB / 1 CPU / 512 pids, non-root):
**170 checks, 0 violations** — Chromium launched without `--no-sandbox`, renderer in its own user namespace, Chromium's
seccomp-BPF stacked on the container profile, non-root uid 1001, no route to Postgres/Redis (by IP or name), the fixture
site directly, the internet, the metadata address or the Docker host; traffic only via the gateway and attributed to
org/website/execution in the gateway's own log. Browser executions through the same runner code: the real-browser
suites above.

**Not closed:** the image was built locally on arm64; closure needs the CI-built (amd64) image digest and the same
proof in CI and staging. The runner image is large (Playwright base); slimming is optional.

## 5. CI evidence (blocker 4)

**No CI run exists.** The project directory is not a Git repository and has no remote, so the workflow cannot be
triggered or observed. The workflow was extended (build + validate production images, isolation against the runner
image, secret-material check, artifacts retained 90 days; failures fail the job; no secret is echoed) and parses as
valid YAML. **Required:** push to a GitHub repository with Actions, record the run ID and a green result.

## 6. Staging isolation (blocker 2)

**Not executed — no staging environment.** Prepared: `infra/staging/networkpolicies.yaml` (default-deny; runner →
gateway only; gateway → public 80/443 + resolvers; workers → data stores/gateway/runner; data stores accept only their
clients), `browser-runner.deployment.yaml` (non-root, read-only, all caps dropped, no privilege escalation, Localhost
seccomp, no service-account token, no service links, limits), `probe.Dockerfile`, `run-staging-isolation.sh` (runs the
same probes inside the deployed pods' network namespaces via ephemeral containers, captures applied policies, image
IDs and the gateway decision log; pass = 0 violations). Cloud-layer requirements (IMDS, NAT egress) listed in the
manifest header.

## 7. Load evidence (blockers 7/8) — LR only, NOT production-scale

One laptop (Apple silicon, Docker Desktop), all services as single processes, fixture websites behind the real egress
gateway. 19 organisations (12 small × 2 sites, 5 medium × 8 incl. 1 browser, 2 large × 40 incl. 2 browser) = 144
websites, HTTP every 60 s, browser every 300 s. Phases of 300 s.

| Phase | HTTP exec | HTTP wait p50/p95/p99 (ms) | HTTP duration p50/p95/p99 | Browser exec | Errors | Fairness (exec per site, min) | Overdue at end | Isolation mismatches |
|---|---|---|---|---|---|---|---|---|
| A steady | 734 (2.45/s) | 19 / 62 / 93 | 39 / 60 / 71 | 9, all PASSED | 0 | small 5, medium 5, large 5.08 | 0 | 0 / 0 / 0 |
| B + 8 dashboard users | 741 | 18 / 63 / 676 | 40 / 67 / 83 | 9 | 0 | 5 / 5 / 5.15 | 0 | 0 / 0 / 0 |
| C 1/3 sites failing + worker-http SIGKILL at 60 s, restart at 120 s | 728 (275 FAILED verdicts) | 21 / 44 839 / 56 847 | 43 / 257 / 344 | 9 | 0 execution errors | 5 / 5 / 5.03 | 0 | 0 / 0 / 0 |

* **Dashboard (phase B):** 8 concurrent sessions on the two large organisations, full refresh every ~2 s (≈ 7× the
  15 s polling of 8 users), 8 640 API calls, 0 errors. p50/p95/p99 ms: changes 47/102/167, components 50/107/170,
  responsive 52/109/179, 30-day series 53/110/178, performance 59/115/207, history 57/114/204, uptime 71/131/218,
  overview 223/302/441. **Monitoring was not starved:** HTTP p50/p95 wait unchanged vs phase A (p99 676 ms), 0 overdue.
* **Crash (phase C):** the p95/p99 wait of 45–57 s is the executions queued while worker-http was dead (60 s) — all were
  picked up after restart; 0 overdue schedules at the end; a retry storm in the BullMQ sense did not occur because a
  site returning 500 is a valid verdict (FAILED), not an infrastructure error — this is the intended design.
* **Resources:** Postgres ≤ 49 connections, 0 lock waits; Redis ≤ 16 MB, ≤ 258 ops/s; worker-http CPU up to 249 % of a
  core and 463 MB during catch-up; scheduler ≤ 8 %. The new `resources.disk` alert fired correctly (host disk 93–94 %).
* **Deep scans** were not part of this load profile (they are covered by the 4E scale tests); gateway throughput was
  not isolated as a metric.

**Not closed:** production-scale evidence requires the same harness on production-like infrastructure at the plan
limits (DEPLOYMENT.md §25, step 10) with separate hosts for workers, runners, gateway and database.

## 8. Regression evidence (final run of the exercise)

| Suite | Result | Class |
|---|---|---|
| Build / typecheck / lint | 46/46 tasks | LA |
| Unit | all pass (core 274, gateway 34 incl. 7 new third-party/WebSocket tests, netguard 56, queue 14, others) | LA |
| Integration (real Postgres, Redis, Mailpit, Chromium; browser workers as `wim_browser`) | 25 files, 288/289 in the full run; the 1 failure was a test whose timeout-rate denominator depended on other files' data — fixed, file re-run 22/22 | LA/LR |
| Database invariants (incl. new 1g) | pass on `wim` and `wim_test`; 4 injected regressions each detected | LA |
| Prisma drift | none on either database | LA |
| Network isolation (development container) | 170 checks, 0 violations | LR |
| Network isolation (**production runner image**) | 170 checks, 0 violations (run twice) | LR |
| E2E | Phase 4H 4/4, 4G 4/4 (worker-browser as `wim_browser`), Phase 2/3 5/5 | LR |
| Load (§7) | 3 phases, 0 execution errors, 0 isolation mismatches | LR |
| CI | **not run** (no repository) | — |
| Staging / production | **not run** (no environment) | — |

## 9. Final blocker matrix

| # | Blocker | Status | Evidence obtained | Class | Still required for closure |
|---|---|---|---|---|---|
| 1 | Production worker-browser / runner image | **Open** (locally validated) | Both images built; non-root; no secrets; isolation 170/0 against the runner image with production flags | LR | CI-built amd64 digests; same proof in CI and staging |
| 2 | Staging isolation probes | **Open** | Manifests, policies, probe image, executable script | — | Run in staging; archive report |
| 3 | Narrow `wim_browser` | **Resolved in code; deployment confirmation open** | Least-privilege role in use; invariant 1g; all real-browser suites + E2E as the role | LA + LR | Production login via secret manager; invariants on staging DB (ST) |
| 4 | CI isolation job | **Open** | Workflow extended and validated as YAML | — | A green GitHub Actions run ID |
| 5 | Third-party authorisation | **Resolved in code; deployment confirmation open** | Written model (SECURITY.md §35); gateway enforcement; adversarial gateway + real-browser tests incl. gateway decision log | LA + LR | Same tests in CI; staging gateway |
| 6 | `wim_scanner` production credentials | **Open** | Design (SECRETS_AND_CREDENTIALS.md); startup refuses wrong role, dev passwords, non-TLS in production | LA | Provisioning in the production secret manager (PR) |
| 7 | Production-limit load test | **Open** | Harness + local run (§7) | LR | Run on production-like infrastructure at plan limits |
| 8 | Dashboard polling / history load | **Open** | Local run: 8 640 calls, 0 errors, no scheduling impact | LR | Same at target concurrency on production-like infrastructure |
| 9 | Functional-test side effects | **Open — unsupported capability** | Mandatory explicit destinations; every first-party request type outside them refused; tests | LA + LR | Product-owner written risk acceptance, or isolation (staging-URL) feature |

## 10. Readiness decision

* **Production: NOT READY.** Seven blockers open; no CI, staging or production evidence exists.
* **Controlled staging: ready to attempt**, with customer monitoring disabled, following DEPLOYMENT.md §25 — provided a
  repository/CI (blocker 4), a staging cluster with an enforcing CNI (blocker 2) and a secret manager (blocker 6) are
  supplied. Functional testing must remain switched off (blocker 9).

---

# Staging execution attempt (2026-11-15)

## 11. Environment verified before acting

| Resource | Verified state | Consequence |
|---|---|---|
| Git repository | **None existed.** Initialised locally during this step; initial commit `6ed735d507e5d2d9b4babe13fb8a4954ba360942` on `main`. **No remote, nothing pushed.** | CI cannot run |
| GitHub | `gh` authenticated as `sarbeshtiwari-eth`, scopes `repo, workflow, gist, read:org`; **no repository for this project** | Repository creation/push needs the owner's approval (outward-facing) |
| Cloud | `aws` CLI present; configured credentials **rejected** (`InvalidClientTokenId`); no GCP/Azure tooling | No cloud resources reachable |
| Kubernetes | `kubectl` present, **no contexts** | No staging cluster |
| Secret manager | None (AWS credentials invalid; no Vault) | Blocker 6 cannot be provisioned |
| Registry | None configured (CI workflow now publishes to GHCR once a repository exists) | No published digests |
| Container build | Docker 29.6.1 + buildx with `linux/amd64` emulation on an arm64 host | amd64 images can be built locally; runtime under emulation |

### Dependency and execution matrix

| Action | Possible locally | Needs GitHub | Needs cloud/staging | Needs credentials/approval |
|---|---|---|---|---|
| Repository hygiene, secret scan, initial commit | **done** | — | — | — |
| Create remote + push | — | yes | — | **owner approval** (publishes code) |
| CI run, CI-built images, published digests | — | yes | — | Actions enabled; GHCR package write (workflow token) |
| amd64 image build + content checks | **done** (emulated) | — | — | — |
| Native amd64 sandbox/isolation proof | — | yes (CI) | or staging | — |
| Secret provisioning, prod credentials | — | — | yes | secret manager access |
| NetworkPolicies, in-pod probes | — | — | yes (enforcing CNI) | cluster admin |
| Migrations/invariants on staging DB | — | — | yes | DB owner credential |
| Backup + restore drill | **done locally** (logical) | — | production drill on managed PostgreSQL/pgBackRest | — |
| Failure injection, fallback e-mail to a real inbox | done locally in 4H | — | yes | mail provider + recipient addresses |
| Load at plan limits | — | — | yes | sized infrastructure |
| Functional testing enablement | **not permitted** (blocker 9) | — | — | product-owner decision |

## 12. Work performed (all local; classes LA/LR only)

### 12.1 Repository preparation (blocker 4 prerequisite)
* `.gitignore` extended: `test-results/`, `playwright-report/`, `blob-report/`, `.playwright-mcp/`, `.claude/`, `*.dump`,
  `*.sql.gz`, `staging-isolation*/`. Verified the staged set (418 files) contains no `.env`, `.keys/`, PEM/keys, logs,
  build output, `node_modules`, test artifacts or database dumps.
* Secret scan with gitleaks v8.21.2 (the CI tool) over the exact staged tree: 15 findings, **all test fixtures** (test
  passwords, test gateway signing secrets, fake JWT/`sk_live_` strings in the log-redaction test, the isolation test
  topology). Added `.gitleaks.toml` that keeps the default rules everywhere and allowlists only `apps/*/test/`,
  `packages/*/test/`, `tests/e2e/` and `infra/security/isolation/docker-compose.yml`. Re-scan: **no leaks**. Control: a
  realistic key placed in `apps/api/src` is still detected. (Without this, the first CI run would fail its secret scan.)
* Note: `.env.example` contains the documented **development** database passwords used by the Docker dev stack; they
  are refused in production by the startup guard (§12.4).

### 12.2 CI workflow (blockers 1/4)
* `isolation` job now states its architecture (ubuntu-24.04 = linux/amd64), and on `push` to `main` publishes the two
  images **that passed isolation** to `ghcr.io/<owner>/<repo>/wim-{browser-runner,worker-browser}:<commit>` and writes
  `name commit=<sha> <repo>@sha256:…` to `published-digests.txt` in the retained artifact. Pull requests never push.
  Job permissions: `contents: read, packages: write`. Workflow parses as valid YAML. **Not executed.**

### 12.3 amd64 production images (blocker 1) — LR (emulated)

| Image | Digest (local build, linux/amd64) | Runtime user | Content |
|---|---|---|---|
| `wim-browser-runner:amd64` | `sha256:6fcae94bb3a9256a75e6565e85b77f45461e39ab1319dfb2ad50e5a4ae33a5c4` | uid 1001 `pwuser` | no `.env`, keys, PEM, dev passwords |
| `wim-worker-browser:amd64` | `sha256:973a22698db7b4ee02c126faeca87110eb7d616b8da2460b13a00b2eb238f0fd` | uid 1000 `node` | same |

Command: `docker buildx build --platform linux/amd64 -f infra/docker/<image>.Dockerfile --load .`
Isolation against the amd64 runner image (`RUNNER_IMAGE=wim-browser-runner:amd64 RUNNER_WORKDIR=/app
infra/security/run-isolation-tests.sh`, production run flags) under x86 emulation on the arm64 host: **168/170**.
All **network** checks pass (no route to Postgres/Redis/fixture/internet/metadata/Docker host; gateway-only; attributed
traffic). The **2 failures are the sandbox observations** ("renderer in its own user namespace", "seccomp-BPF stacked"):
no renderer process was present to inspect under emulation (Chromium reported only browser/zygote processes). This is
consistent with emulation, but it is **not proven** — the native amd64 run in CI/staging must show 170/170. The same
checks pass 170/170 natively on arm64 (§4). Local digests are **not** release digests (CI must build and publish).

### 12.4 Database roles and credentials (blockers 3/6)
* **wim_scanner tightened** (`packages/db/sql/170_scanner_role.sql`): UPDATE on `monitoring_executions` reduced to the
  runtime lifecycle columns (ownership columns `org_id`, `website_id`, `tier`, `queued_at`, `schedule_id`, `trigger` no
  longer updatable); `scanner_system` RLS on `monitoring_executions` and `execution_results` restricted to `T3_DEEP`;
  no UPDATE/DELETE on verdicts. Review found no access to identity, sessions, admin, audit, credentials, notification
  channels, payments or HTTP/browser results (already true).
* **Invariant 1h** (scanner least-privilege) added; passes on `wim` and `wim_test`; injected regressions (ownership
  UPDATE grant; untiered verdict policy) each detected. (A first version leaked `app.system` into later checks of the
  same transaction and broke invariant 8 — found and fixed before recording.)
* Real deep scans as the tightened role: `deep-scan` **17/17**, `deep-scan-api` **5/5**.
* Startup guard against the real database: scanner role accepted in development; refused in production with the dev
  password ("development credentials … not accepted"), refused without TLS ("must use sslmode=require or stricter"),
  refused when the wrong role is configured.
* **Rotation/revocation mechanics (local PostgreSQL, no secret manager):** old password refused after `ALTER ROLE …
  PASSWORD`, new password accepted; `NOLOGIN` refuses new logins; `pg_terminate_backend` ends existing sessions;
  development credential restored. Not separately observed: an open session surviving the rotation itself (it was
  terminated by the revocation step). The secret-manager part (versions, rolling restart) is untested.
* `wim_browser` unchanged since §3 (CODE RESOLVED); staging verification BLOCKED.

### 12.5 Backup and restoration drill — LR (local, logical)
Environment: dev PostgreSQL 16.6 (Docker), database `wim`. Commands: `pg_dump -Fc` → `CREATE DATABASE
wim_restore_drill` → `pg_restore --exit-on-error` → checks → `DROP DATABASE`.

| Step | Result |
|---|---|
| Backup | 4 889 434 bytes, 1 s |
| Restore | exit 0, 3 s |
| Row counts (12 tables incl. executions 9 928, ledger 9 887, check results 9 634, audit 807, migrations 18) | identical |
| Invariants on the restored copy | **ALL PASSED** (incl. 1g, 1h) |
| Security objects | 66 RLS tables, 191 policies — same as source |
| Audit hash chains (`audit_verify`, 129 streams) | intact on source and restored copy |
| Failures | none |

**Limitations:** a logical dump of a small development database, not the production method (pgBackRest/managed
PITR), not point-in-time, no WAL, no measured RPO; partitions restored as present. The production drill in
DEPLOYMENT.md §25 remains required.

## 13. Final blocker matrix (statuses: RESOLVED · CODE RESOLVED · OPEN · BLOCKED)

| # | Blocker | Status | Evidence (class) | Blocking dependency / remaining |
|---|---|---|---|---|
| 1 | Production worker-browser / runner image | **BLOCKED** | arm64 170/170 (LR); amd64 images built, non-root, clean; amd64 isolation 168/170 under emulation, sandbox checks unverified (LR) | GitHub repo + CI run (native amd64, published digests); staging run |
| 2 | Staging isolation | **BLOCKED** | manifests/script prepared only | staging cluster with enforcing CNI |
| 3 | Narrow `wim_browser` | **CODE RESOLVED** | invariant 1g; all real-browser suites + E2E as the role (LA/LR) | staging DB invariants + production login (blocked) |
| 4 | CI isolation job | **BLOCKED** | local commit `6ed735d…`, secret scan clean, workflow valid | remote repository + owner approval to push; Actions |
| 5 | Third-party authorisation | **CODE RESOLVED** | model + gateway and real-browser adversarial tests (LA/LR) | CI + staging gateway confirmation |
| 6 | Scanner credentials | **BLOCKED** | role tightened + invariant 1h; startup guard; rotation/revocation mechanics (LA/LR) | secret manager + production DB |
| 7 | Production-limit load | **BLOCKED** | local harness run only (§7) | production-like infrastructure |
| 8 | Dashboard load | **BLOCKED** | local run only (§7) | same |
| 9 | Functional-test side effects | **OPEN** | controls in §36 of SECURITY.md; feature disabled by default | technically enforceable isolation or a non-mutating mechanism + approval |

No item is RESOLVED: none has CI, staging or production verification.

## 14. Recommendation

**Staging: BLOCKED.** Not because of a known defect, but because no repository, CI, cluster, registry, secret manager
or valid cloud credential exists. Everything that can be done locally is done and committed locally. Customer
monitoring and functional testing remain disabled by default.

## 15. Needed from the owner (in order)

1. **Approve and create the GitHub repository**, then push, e.g. (private): `gh repo create <owner>/sitesentinel --private --source . --remote origin --push`. Enable Actions. Record the first run URL/ID (`gh run list --limit 1`) and the `isolation-results` artifact (`published-digests.txt`).
2. **Cloud account and valid credentials** (the configured AWS keys are rejected), and a decision on the provider.
3. **Staging cluster** (amd64 nodes) with Calico or Cilium, the Chromium seccomp profile installed at `profiles/chromium.json`, IMDS blocked for pods, and a namespace `sitesentinel`.
4. **Managed PostgreSQL 16 with TLS** + backups/PITR; Redis 7 with AUTH; S3-compatible bucket(s).
5. **Secret manager** with orchestrator integration (External Secrets/CSI) and an operator able to run the provisioning in SECRETS_AND_CREDENTIALS.md §3.
6. **Mail provider** (SPF/DKIM) and **real addresses** for `ops.alerts.recipients` and `OPS_FALLBACK_ALERT_EMAILS`.
7. **External DNS resolver CIDRs** and **mail provider CIDRs** for `infra/staging/networkpolicies.yaml`.
8. **Internal test websites** you control for the monitoring and load gates, and the target plan limits for the load test.
9. **Product decision on functional testing** (blocker 9) — or keep it disabled.

---

# CI execution (2026-11-15) — repository `sarbeshtiwari/sitesentinel`

Branch model: changes land on `stage` (CI on push and PR), then fast-forward to `main` (CI on push). Workflow triggers:
`push`/`pull_request` on `main` and `stage`, plus `workflow_dispatch`.

| Run | Branch / commit | Result | What it established |
|---|---|---|---|
| 43586105632 | main `006eaed` | test ✗ (runner disk full), isolation ✓ | First native linux/amd64 isolation run of the production runner image: passed. Integration suite died with `No space left on device`. |
| 43586815787 | stage `3e1c9b7` | test ✗ (250/289), isolation ✓ | Disk fixed (21 GB free throughout). 39 failures: Chromium could not start (Ubuntu 24.04 restricts unprivileged user namespaces → `BROWSER_UNAVAILABLE`), and the TLS fixture used `openssl -not_before` (OpenSSL ≥ 3.4) on OpenSSL 3.0. |
| 43589303878 | stage `6d2e9c7` | test ✗ (288/289), isolation ✓ | Sandbox works in CI (user namespaces allowed on the runner; the sandbox stays ON); TLS fixture falls back to `openssl ca` (verified locally on Ubuntu 24.04 / OpenSSL 3.0.13). 1 failure: a test counted deep-scan executions platform-wide. |
| **43591319838** | **stage `7308a75`** | **✓ test, ✓ isolation** | **First fully green run.** |
| 43592874983 | main `7308a75` | test ✗ (288/289), isolation ✓, **images published** | Same commit as the green stage run; one intermittent failure in the 5-concurrent-schedulers test (31 vs 30 executions — a website legitimately received its next window; the test asserted an exact count instead of "no duplicate window"). Test fixed to assert the property. |

**Published images (CI-built, linux/amd64, isolation-validated, commit `7308a754438e4b573cd473445c9c5be439d74c81`):**
* `ghcr.io/sarbeshtiwari/sitesentinel/wim-browser-runner@sha256:1fe5fb2200153bb69b42661dbdd84bbd7c846212065c30bc0d3959944e8d0688` (runs as `pwuser`)
* `ghcr.io/sarbeshtiwari/sitesentinel/wim-worker-browser@sha256:9b6780443f79a58c780d8f325a87363b9de9362986ac91b35e1475901897f0a8` (runs as `node`)

**Effect on blockers:** blocker 4 (CI isolation job) — **RESOLVED**: the isolation job runs on every push to `stage`/`main`,
builds the production images, runs the 170-check isolation suite against the production runner image on native amd64,
and passed in every run above (evidence: run IDs, retained `isolation-results` artifact incl. `published-digests.txt`).
Blocker 1 (production image) — **CODE RESOLVED**: CI-built amd64 images exist by digest and pass isolation natively
(including the sandbox checks that could not be confirmed under emulation); staging execution is still outstanding.
Blocker 5 — adversarial tests now also pass in CI; staging confirmation outstanding. Blockers 2, 6, 7, 8 unchanged
(BLOCKED); 9 OPEN.

**New deployment requirement found by CI:** browser-runner nodes must permit unprivileged user namespaces (DEPLOYMENT.md §25).
