# Website Monitoring & Incident Management Platform

A multi-tenant SaaS for centralized website monitoring: uptime, browser-based page and component testing, responsive and performance checks, API monitoring, a real-user JavaScript SDK, incident management with smart grouping, real-time alerts, subscriptions, and a privacy-preserving Super Admin panel.

**Status:** Phases 1 (architecture), 2 (foundation: auth, 2FA, orgs/teams, RBAC, tenant isolation, encryption, dashboard shells) and 3 (website registration, domain verification, trials, JavaScript SDK, installation verification, transfers) are implemented and verified. Phase 4 (monitoring engine) is in progress: 4A (egress isolation, ownership revalidation) 4B (scheduler and queues), 4C (HTTP availability monitoring), 4D (browser monitoring), 4E (deep website scanning) 4F (component detection, safe functional tests, responsive matrix) 4G (performance thresholds, trends, rollups, customer dashboard completion) and 4H (platform health, self-alerts, usage reconciliation, operations configuration, hardening) are implemented and verified locally (not production-ready: see DEPLOYMENT.md §24); the customer monitoring dashboard (approved-4G scope) was delivered early and is partially complete (not production-ready: see the release checklist in DEPLOYMENT.md §20); see [PHASE4_PLAN.md](docs/PHASE4_PLAN.md). Provisional product name: **SiteSentinel** (configurable at runtime). See [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Contradictions resolved, decisions (D-01…D-59), topology, modules, folder structure, check tiers and cost model, workers, monitoring, incident, domain identity, billing and anti-abuse flows, risks |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | ER diagrams, spec-entity mapping, constraints, partitioning, RLS, roles, audit chain |
| [API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | REST conventions, every customer and admin endpoint, WebSocket protocol, queue contracts |
| [SECURITY.md](docs/SECURITY.md) | Threat model (STRIDE), SSRF and browser isolation, auth, tenant isolation, encryption, privacy, security testing plan |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS-first topology, Compose networks, Nginx, Postgres, Redis, backups and restore, CI/CD, runbooks, env vars |
| [BILLING.md](docs/BILLING.md) | Phase 8: plans and entitlements, subscription state machine, gateways, webhook security, configuration, what is verified |
| [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) | Phases, dependencies, exit criteria, open business decisions |
| [CHANGELOG.md](CHANGELOG.md) | Changes by date |

## Local development

Requirements: Node ≥ 22, pnpm 10, Docker.

```bash
cp .env.example .env
pnpm install
pnpm keys:init           # dev key ring at .keys/kek.json (outside the database, git-ignored)
pnpm infra:up            # Postgres 16 :55432 · Redis 7.4 :56379 · S3 (SeaweedFS) :58333 · Mailpit UI :58025
pnpm build
cd packages/db && set -a && . ../../.env && set +a && PATH="$PWD/node_modules/.bin:$PATH" pnpm migrate:deploy && cd ../..
```

Run the stack (each in its own terminal, with `.env` exported: `set -a && . ./.env && set +a`):

```bash
(cd apps/api && node dist/main.js)             # API on :4000
(cd apps/worker-notify && node dist/main.js)   # email worker → Mailpit
(cd apps/worker-http && node dist/main.js)     # verification worker (DNS_RESOLVERS)
(cd apps/ingest && node dist/main.js)          # SDK + telemetry on :4200
(cd apps/egress-gateway && node dist/main.js)  # egress gateway on :8080 (set EGRESS_TOKEN_SECRET; workers use EGRESS_GATEWAY_URL)
(cd apps/scheduler && node dist/main.js)       # monitoring scheduler + notification outbox relay (tiers stay off until enabled in admin settings)
# HTTP checks: worker-http consumes them when EGRESS_GATEWAY_URL is set; enable with the admin setting monitoring.http.enabled
# Browser checks: browser-runner + worker-browser (see infra/compose/docker-compose.browser-ops.yml); needs monitoring.browser.enabled AND a per-org entitlement
# Deep scans: (cd apps/worker-deepscan && node dist/main.js) with SCANNER_DATABASE_URL (role wim_scanner) + EGRESS_GATEWAY_URL;
#   needs monitoring.deepscan.enabled AND a per-org entitlement (see infra/compose/docker-compose.deepscan-ops.yml)
pnpm dev:web                                   # customer app on :3000
pnpm dev:admin                                 # Super Admin on :3001
pnpm admin:create -- --email you@example.com --name "You"   # prints one-time password + TOTP URL
```

Host ports are offset so they don't collide with a native Postgres/Redis. The API only accepts state-changing requests
from `APP_URL` / `ADMIN_URL`; if port 3000 is busy, run the web app elsewhere and set `APP_URL` accordingly. Next.js
rewrite targets (`API_INTERNAL_URL`) are resolved at **build** time for `next start`.

## Tests

```bash
pnpm test:unit                      # crypto, logger, core (RBAC + settings), email providers
pnpm test:integration               # API against Docker Postgres (isolated wim_test DB), Redis db 1, Mailpit
pnpm db:invariants                  # Phase 1 database invariants (rolled-back transaction)
infra/security/run-isolation-tests.sh  # network isolation proof in Docker (170 checks, incl. the sandboxed browser runner and the deep-scan crawler)
WEB_URL=… ADMIN_URL=… pnpm test:e2e # Playwright against a running stack (phase4f.spec.ts needs the fault environment: DEPLOYMENT.md §21)
```

**End-to-end tests (Phase 3)** need the verification worker pointed at the test fixtures that the spec starts itself
(DNS on 127.0.0.1:15353, customer site on 127.0.0.1:14300); the loopback allowance is refused unless `NODE_ENV=test`:

```bash
(cd apps/worker-http && NODE_ENV=test DNS_RESOLVERS=127.0.0.1:15353 NETGUARD_ALLOW_LOOPBACK_FOR_TESTS=true \
   NETGUARD_LOOPBACK_PORT_FOR_TESTS=14300 node dist/main.js)
```

## Repository layout (target)

```
apps/       web · admin · api · realtime · ingest · scheduler · worker-{http,browser,deepscan,incident,notify,billing,maintenance}
packages/   db · contracts · core · netguard · test-engine · payments · crypto · queue · logger · email-templates · ui · sdk
infra/      compose · docker · nginx · smokescreen · postgres · seaweedfs · ci
docs/       architecture and operations documentation
```

Built so far: `apps/{api,worker-notify,worker-http,ingest,web,admin}`, `packages/{db,contracts,core,crypto,logger,email,ui,netguard,sdk,test-fixtures}`, `infra/`, `tests/e2e`. The rest arrive in Phases 3–10 (see ARCHITECTURE.md §5).
