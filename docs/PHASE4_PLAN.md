# Phase 4 implementation plan — production website monitoring engine

> Status: plan (2026-11-13). Subphases 4A → 4H are delivered in order; each ends with type-check, unit,
> integration, browser and invariant runs plus documentation. Nothing customer-facing runs real browser
> jobs before 4A (network isolation) and 4B (scheduler) are proven.

## 1. Inspection results

### Reusable as-is
| Existing piece | Reused for |
|---|---|
| `monitoring_schedules` (per website × tier, `next_run_at`, jitter, priority, region) | DB-driven scheduler (D-04) |
| `monitoring_executions` (partitioned, `UNIQUE(schedule_id, slot, queued_at)`) | Scheduling ledger: queued/started/finished/status/worker/attempt/duration |
| `check_results`, `page_test_results`, `component_test_results`, `responsive_test_results`, `performance_metrics` (all daily partitions, 14-day raw) | Tier A/B/C results |
| `discovered_pages`, `monitored_pages`, `page_components`, `test_cases`, `monitoring_configurations`, `maintenance_windows`, `auth_recipes` | Discovery, component identity, configuration, safe journeys, authenticated pages |
| `metrics_hourly` / `metrics_daily` (monthly partitions), `partitions.ensure_all/apply_retention` | Aggregation and 60-day retention |
| `worker_heartbeats`, `job_failures`, `system_health_logs`, `usage_counters`, `artifacts` | Worker health, DLQ ledger, platform alerts, usage accounting, screenshots |
| `@wim/netguard` (deny list, pinned DNS, redirect re-validation, 49 tests) | Shared destination policy for the egress gateway and workers |
| `apps/worker-http` (verification worker), `@wim/test-fixtures` (real DNS + HTTP servers) | Revalidation, Tier A, controlled test sites |
| RLS + `withSystem` (wim_worker), settings registry + hot reload, audit chain, admin aggregate views | Tenant isolation of jobs, Super Admin configuration, auditing |

### Missing infrastructure
1. **An egress gateway enforced by the network.** Phase 1 designed Smokescreen, but no proxy exists and every
   service runs on the host. Workers currently reach the internet directly (application-level checks only).
2. **Browser isolation boundary.** The Phase 1 deployment sketch put `worker-browser` on the `data` network
   (Postgres/Redis protected by ACLs only). **This does not meet the Phase 4 requirement** that a compromised
   browser cannot reach the database or Redis. Changed below (D-42).
3. Periodic ownership revalidation (claims never leave `VERIFIED`).
4. Scheduler process, queue topology, fairness, DLQ handling, heartbeats, platform self-monitoring.
5. Plans/entitlements don't exist until Phase 8 → monitoring limits come from **platform settings defaults**
   (`monitoring.*`), applied per org, and are replaced by plan entitlements later without code changes in workers.
6. A permanent controlled test website.

## 2. How the security design is enforced at the network level (4A)

```
                          ┌──────────── outbound (internet) ────────────┐
                          │                                              │
   ┌──────────────┐  egress-http (internal)  ┌─────────────────┐         │
   │ worker-http  │─────────────────────────▶│ egress-gateway  │─────────┘
   │ (Tier A,     │                          │  CONNECT/HTTP   │
   │  revalidation│                          │  proxy + DNS API│
   └──────┬───────┘                          └────────▲────────┘
          │ data (internal)                           │ browser-egress (internal)
   ┌──────▼───────┐  browser-control (internal) ┌─────┴──────────┐
   │ Postgres     │      ┌──────────────┐        │ browser-runner │  Playwright server + Chromium
   │ Redis        │◀─────│worker-browser│───────▶│ (no data net,  │  cap_drop ALL, read-only rootfs,
   └──────────────┘ data └──────────────┘  ws    │  no internet)  │  pids/mem/cpu limits, tmpfs
                                                 └────────────────┘
```

* **No internal network has a gateway** (`internal: true`): containers on them can reach only peers on the same
  network. Monitoring workers and the browser are never on `outbound`.
* **The browser runs in its own container** (Playwright `run-server`) attached only to `browser-control` and
  `browser-egress`. It cannot route to Postgres, Redis, the API, the Docker host or metadata at all — even if
  Chromium is compromised or ignores its proxy flag. `worker-browser` (the BullMQ consumer with DB/Redis access)
  drives it over the Playwright protocol and never executes page content itself.
* **egress-gateway** (new, `apps/egress-gateway`) is the only process with internet access on the monitoring path.
  It validates every destination **independently** of the worker: resolves DNS itself with configured resolvers,
  rejects the host if any answer is in the deny list (IPv4/IPv6 private, loopback, link-local, CGNAT, documentation,
  multicast, reserved, ULA, NAT64, IPv4-mapped, 6to4, metadata), allows ports 80/443 only, pins the validated
  address (no rebinding), caps bytes/time/connections, and requires a short-lived signed **capability token**
  (org, website, execution, expiry) on every request — the gateway refuses anonymous use and attributes usage.
  It also serves a constrained DNS API (TXT/A/AAAA) so verification and revalidation never need raw UDP egress.
* Docker internal DNS is never used for targets: workers send hostnames to the gateway, which resolves them with
  public resolvers, so service names like `redis` don't resolve and container IPs (private ranges) are denied.
* Chromium flags: `--proxy-server=http://egress-gateway:8080`, `--disable-quic`,
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, `--no-pings`, service workers blocked, downloads
  disabled (`acceptDownloads: false`), `file:`/`chrome:` navigations blocked. All UDP is unroutable anyway.
* **Fail closed:** if the gateway can't resolve or validate a destination, or is unavailable, the job fails with
  `DESTINATION_UNVERIFIED` / `EGRESS_UNAVAILABLE` (an infrastructure error, never a customer "site down").
* **Proof:** `infra/security/run-isolation-tests.sh` builds the topology and runs probes **inside** each container
  that deliberately try: direct TCP to Postgres/Redis/API/host gateway/metadata/public IPs, UDP DNS to 8.8.8.8,
  IPv6 loopback/ULA, and, through the gateway, private/metadata/IPv6/IPv4-mapped/rebinding/redirect/odd-port
  destinations — plus a real Chromium in `browser-runner` navigating to internal targets. Every blocked attempt
  must fail; the fixture "public" site must succeed. Test-only allowances are narrow and refused outside
  `NODE_ENV=test`.

## 3. Subphases

| Sub | Deliverables | Exit evidence |
|---|---|---|
| **4A** | `apps/egress-gateway` (proxy + DNS API + capability tokens); netguard client for the gateway; worker-http forced through the gateway in production; `infra/compose/docker-compose.monitoring.yml` + Dockerfiles + isolation test harness; ownership revalidation (24 h, original method, transient vs definitive failures, grace → LAPSED → released, notifications, history, distributed + rate-limited + lock per claim); SECURITY.md network architecture | unit + integration (real gateway, real fixtures), container isolation probes, invariants |
| **4B ✅** | `apps/scheduler` (leaderless; `SKIP LOCKED` claiming, durable window dedupe in PostgreSQL, jitter, fair dispatch, schedule sync), `@wim/queue` (registry, execution runtime, eligibility re-check, semaphores, DLQ, replay), queues `http-monitoring`, `browser-monitoring`, `deep-scan`, `dead-letter` + reused `revalidate`, heartbeats, cancellation, graceful shutdown | scheduler/queue integration tests (24), API tests (5), crash/recovery, Redis outage/loss, isolation (101 checks) — see §6 |
| **4C ✅** | Tier A HTTP monitoring through the gateway (DNS/TCP/TLS/HTTP timings, cert expiry warnings 30/14/7/3 d, expected statuses incl. 401/403, keyword/regex, HEAD/GET), result processor | controlled site: healthy/500/slow/expired-cert/redirect loop |
| **4D** | Tier B browser monitoring via browser-runner (isolated contexts, readiness strategy not relying on networkidle, console/page errors, failed requests, broken images, blank page, metrics FCP/LCP/CLS/TBT/TTFB, screenshots on failure), artifacts in S3 | controlled site: js-error/broken-image/blank/slow |
| **4E** | Deep scan + discovery (sitemap, robots, BFS, canonicalisation, query policy, traps, quotas, incremental), page prioritisation | controlled site with sitemap, broken internal links, traps |
| **4F** | Component detection engine + safe functional tests (search, forms non-submitting, navigation, buttons with destructive deny-list) + responsive matrix | controlled site: broken search, invalid form validation, overflow, overlap |
| **4G** | Performance thresholds + trends, rollups, customer dashboard (overview, history, pages, components, responsive, performance) | E2E against controlled site |
| **4H** | Worker health in admin, platform self-alerts (no workers, queue depth, failure rate, scheduler stall, latency), usage accounting, admin monitoring configuration pages, hardening | chaos tests (kill workers/scheduler), load test |

## 4. Decisions taken for Phase 4 (recorded in ARCHITECTURE §24 as they land)

* **D-41** Own egress gateway instead of Smokescreen: shares the tested netguard policy, adds port allow-list,
  per-job capability tokens/accounting and a DNS API; Smokescreen remains a drop-in alternative for the proxy part.
* **D-42** Browser in a separate container without database/Redis networks (supersedes the Phase 1 sketch).
* **D-43** Until plans exist (Phase 8), monitoring limits are platform settings applied per org; workers read
  resolved limits through one function so plan entitlements replace them without worker changes.
* **D-44** Revalidation states: `VERIFIED` → (definitive failure) `REVALIDATION_FAILING` within grace (monitoring
  continues, customer notified) → `LAPSED` (grace exhausted: monitoring suspended) → `RELEASED` (lapse period over:
  ownership lost). Transient failures and our own outages never advance the state.

---

## 5. Phase 4B implementation plan — scheduler and queue infrastructure

### 5.1 Reused (not rebuilt)
| Existing | Role in 4B |
|---|---|
| `monitoring_schedules` (website × tier, `next_run_at`, jitter, priority, status) | One durable schedule per website and tier, synchronised from website/org/entitlement state |
| `monitoring_executions` (daily partitions, `UNIQUE(schedule_id, slot, queued_at)`) | **The durable idempotency key.** `queued_at` becomes the deterministic *window start* and `slot` its epoch, so (org, website, tier, window) can be inserted once, ever, across all scheduler instances — enforced by PostgreSQL, not Redis |
| `revalidate` queue + lease sweep (4A) | Kept as the domain-revalidation queue (already distributed, rate-limited, locked); registered in the queue registry with the same policy fields as the new queues |
| `job_failures` | Dead-letter ledger (extended with execution, website, job type, failure category, replay columns) |
| `worker_heartbeats`, `system_health_logs`, `usage_counters` | Worker/scheduler health and per-org usage accounting |
| `plan_entitlements`, `entitlement_overrides`, platform settings | Effective limits: setting default ⊕ plan entitlement ⊕ org override (one resolver, D-43) |
| RLS `withSystem` (wim_worker), egress gateway, isolation topology | Unchanged; the scheduler joins only the `data` network |

### 5.2 Queue topology
| Queue | Producer | Consumer | Default state |
|---|---|---|---|
| `http-monitoring` | scheduler | worker-http | consumer runs; tier **disabled** by setting until 4C ships the engine |
| `browser-monitoring` | scheduler | worker-browser (4D) | tier **disabled**; no consumer exists yet |
| `deep-scan` | scheduler | worker-browser (4E) | tier **disabled**; no consumer exists yet |
| `revalidate` (domain revalidation) | revalidation sweep, API | worker-http | enabled (4A) |
| `dead-letter` | every execution worker | admin replay → scheduler | — |

Every queue has its own concurrency, rate limit, attempts, backoff (exponential + full jitter), job timeout and
retention, from settings with code defaults. Payloads carry **ids only** (`executionId`, `windowStart`); tenant,
website, URL and policy are always re-read from the database by the consumer.

### 5.3 Scheduler (`apps/scheduler`, leaderless)
Each cycle: (1) **sync** schedules from website/claim/org/entitlement state (create, activate, pause with reason,
cancel outstanding work); (2) **claim** due schedules fairly — per-org round-robin rank (`ROW_NUMBER() OVER
(PARTITION BY org_id)`), capped by the org's per-cycle quota and outstanding-job limit, then `FOR UPDATE SKIP LOCKED`;
(3) **insert** the execution for the current window `ON CONFLICT DO NOTHING` and advance `next_run_at` in the same
transaction; (4) **enqueue** with `jobId = executionId`; (5) **reconcile**: re-enqueue executions left `SCHEDULED`
(crash between commit and enqueue, Redis outage), re-queue `QUEUED` executions whose Redis job vanished (Redis data
loss), expire leases of crashed `RUNNING` executions; (6) process admin replay requests. Any number of instances can
run; correctness never depends on a leader. Missed windows after downtime are not back-filled: the next run is the
current window (count recorded).

### 5.4 Lifecycle (all execution queues)
`SCHEDULED → QUEUED → RUNNING → SUCCEEDED | FAILED | RETRYING → … | CANCELLED | SKIPPED (ineligible at start) |
DEAD_LETTERED`. Before running, the worker re-reads the execution and re-checks eligibility (website active, ownership
not lapsed, org active, entitled, tier enabled, not cancelled); a forged or mismatched payload is a security failure
(never retried). Cancellation: pending work is cancelled in the database and removed from Redis; running work sees a
cancel flag through an `AbortSignal`; graceful shutdown stops taking jobs, aborts in-flight work as `RETRYING` (not
lost) and closes.

### 5.5 Database changes (migration `phase4b_scheduler`)
`ExecutionStatus` += `SCHEDULED`, `RETRYING`, `DEAD_LETTERED`; `monitoring_executions` += `enqueued_at`,
`lease_expires_at`, `failure_category`, `cancel_requested_at`; `monitoring_schedules` += `paused_reason`;
`job_failures` += `execution_id`, `website_id`, `job_type`, `failure_category`, `replay_requested_at`,
`replay_requested_by_id`, `replay_execution_id`. `sql/080_scheduler.sql`: `set_website_monitoring_paused()` (the API
can only toggle ACTIVE↔PAUSED), aggregate admin views for queues/executions.

### 5.6 Acceptance tests (real PostgreSQL + Redis)
Intervals and admin changes; entitlement enforcement (expired trial, override, plan); paused/suspended/deleted/lapsed;
missed cycles and restart recovery; N concurrent scheduler instances → zero duplicate executions; crash between
commit and enqueue; Redis disconnect via a cuttable TCP proxy; worker SIGKILL mid-job (child process); fairness
(large vs small tenants; per-org and global concurrency; backpressure); forged/malformed/invalid payloads; replay
re-checks eligibility; secrets absent from payloads, failure records and logs; pause/delete while queued; cancel
while processing; graceful shutdown; retry exhaustion → DLQ → replay. Docker operational run of scheduler + worker
against the dev stack (incl. Redis restart) and the 4A isolation suite extended with a scheduler container.

## 6. Phase 4B status — implemented (2026-11-13)

Implemented as planned in §5 with these refinements found during implementation:
* **Leaderless, not leader-elected.** Correctness rests on PostgreSQL (unique window index, `SKIP LOCKED`,
  per-org transaction advisory locks); a leader would only add a failover gap. Schedule *sync* takes a
  transaction-level advisory lock so one instance writes schedule state per cycle.
* Queue names follow the Phase 4B prompt (`http-monitoring`, `browser-monitoring`, `deep-scan`, `dead-letter`)
  rather than the earlier `monitor.*` sketch; `revalidate` (4A) is reused as the domain-revalidation queue.
* Error text is stripped of URLs at the source, so customer domains never reach failure records or admin views.
* Evidence and limitations: DEVELOPMENT_ROADMAP.md (Phase 4B) and SECURITY.md §27.

---

## 7. Phase 4C implementation plan — HTTP availability engine

### 7.1 Reused (nothing duplicated)
| Existing | Use in 4C |
|---|---|
| `http-monitoring` queue, `createExecutionWorker` (4B) | Job consumption, eligibility re-check, leases, retries, DLQ |
| Egress gateway + capability tokens (4A) | Every request; gains per-tunnel timing headers and optional **host binding** (`h` claim) |
| `check_results` (daily partitions) | The result table — keyed by execution: unique `(execution_id, checked_at)` with `checked_at` = window start |
| `monitoring_schedules` (website × tier) | Per-website monitor state (consecutive counters, open incident ids) in a `state` column, updated under the row lock |
| `incidents`, `incident_occurrences`, `incident_events`, one-active-per-fingerprint index, `incident_rules` | Incident lifecycle (first writer of these tables); thresholds from website config → incident rules → settings |
| `outbox_events` → email queue → `worker-notify`, `notification_preferences`, `notification_delivery_logs`, `notifications` | Notifications (outbox written in the result transaction; relay in the scheduler) |
| `monitoring_configurations` | Website HTTP check config (`http_check` JSON) |
| `partitions.ensure_all/apply_retention` | Now actually run (scheduler, hourly, advisory-locked); `check_results` retention 14 → 62 days |

### 7.2 Modules
`@wim/netguard/probe` (gateway-only HTTP client: CONNECT per hop, TLS inspection, redirects, HEAD→GET fallback,
byte/time caps) · `@wim/core/monitoring/http` (config schema, response evaluator, failure classification, incident
state machine, uptime rules — pure) · `@wim/incidents` (incident store + outbox, shared with 4D+) · `worker-http/monitor/*`
(consumer, target resolution, infra classifier with canary + circuit breaker, persistence, metrics) · scheduler
(outbox relay, partition maintenance) · `worker-notify` (monitoring notices) · API (status, history, config,
incidents) · admin aggregate HTTP health.

### 7.3 Idempotency
One transaction per result: `INSERT check_results … ON CONFLICT (execution_id, checked_at) DO NOTHING`; only when the
row is new are counters, incidents, occurrences, outbox events and usage written. A re-run of the same execution (crash,
lease expiry, duplicate delivery) re-probes but changes nothing. Outbox rows carry a unique `dedupe_key`; email jobs use
`jobId = outbox id`; provider idempotency key per recipient.

## 8. Phase 4C status — implemented (2026-11-13)

As planned in §7, plus: the gateway gained **per-hop host binding** in capability tokens and returns its DNS and
connect timings in the CONNECT response; a **canary** distinguishes our resolver/egress outages from customers'; a
fleet-wide **circuit** stops retry storms during infrastructure outages; partition maintenance now actually runs
(scheduler, hourly). Found during the operational run: `monitoring_configurations.t1_interval_sec` had a Phase 1
default of 300 that would have silently slowed every configured website to 5-minute checks — now nullable (NULL =
entitled default), with a regression test. Evidence: DEVELOPMENT_ROADMAP.md (4C).

---

## 9. Phase 4D inspection and plan — browser monitoring

### 9.1 Finding: `check_results` did not enforce one result per execution
Actual indexes: PK `(id, checked_at)`, unique `(execution_id, checked_at)`. A partitioned table can only enforce
uniqueness *including* the partition key, so a second row for the same execution with a different `checked_at` was
accepted (demonstrated with a rolled-back insert). The 4C guarantee rested on application code always writing
`checked_at = window start`. `monitoring_executions` has the same property (PK `(id, queued_at)`).
**Fix (first step of 4D):** a non-partitioned ledger `execution_results (execution_id PRIMARY KEY, tier, org, website,
window_start, outcome)` shared by every engine; every result row (`check_results`, browser results) must reference a
ledger row of its tier with `window_start = its timestamp` (trigger), and the ledger insert is the idempotency gate.

### 9.2 Reused
4B scheduler/queue/runtime (`browser-monitoring` queue, eligibility re-check, per-org/global semaphores, leases,
DLQ, replay); 4C incident state machine (generalised to any check-class set), `@wim/incidents`, outbox + notify;
4A gateway, isolation topology and probes; Phase 1 tables `page_test_results`, `performance_metrics`,
`responsive_test_results`, `artifacts` (made usable without deep-scan pages: `monitored_page_id` nullable + `page_path`);
SeaweedFS S3; partition retention.

### 9.3 Topology and authorization
```
scheduler ─(redis)─► worker-browser  [data + browser-control]   trusted control plane: validates execution, resolves
                         │                                       target, mints capability, uploads artifacts, persists
                         │ HTTP control + Playwright WS (browser-control, internal)
                         ▼
                    browser-runner   [browser-control + browser-egress]  no DB, no Redis, no S3, no secrets
                         │ Chromium (sandbox ON, custom seccomp), proxy fixed by the runner = gateway
                         ▼
                    egress-gateway   [browser-egress + outbound]
```
* The runner launches **one Chromium per execution** (`launchServer`, random WS path), with fixed hardened args and the
  gateway as proxy taken from *its own* config; the worker only supplies a capability token. A hard kill timer and
  disconnect handling guarantee no process survives the job.
* Capability (worker-minted, `k=browser`): org, website, execution, expiry = job timeout + margin (≤ 15 min). Not
  host-bound (pages load third-party subresources), so the gateway enforces public-only destinations plus a new
  **per-execution connection budget**; the main document is restricted to the website's registrable domain by the
  engine. The runner and Chromium never see the signing secret.

### 9.4 Results and artifacts
Ledger row + one `page_test_results` row per viewport (navigation, rendering, JS, network, failure class),
`performance_metrics` (synthetic, labelled), `responsive_test_results`; all written in one transaction only when the
ledger row is new. Screenshots (failure-only by default, masked) → S3 `orgs/<org>/websites/<site>/executions/<exec>/…`,
`artifacts` rows with expiry, per-org daily byte quota; customers get short-lived HMAC-signed download links through
the API; admin endpoints never touch artifacts.

### 9.5 Acceptance tests
Unit (evaluation, grouping, state machine); integration with real Chromium (in-process runner service, same protocol),
real gateway, Postgres, Redis, SeaweedFS against a controlled browser fault site (all §16 routes); isolation suite with the
real runner container (sandbox verified by namespaces); Docker operational run; CI job for the isolation suite.

## 10. Phase 4D status — implemented (2026-11-13)

As planned in §9. Refinements: the runner refuses caller-supplied launch options (proxy, flags) and removes Chromium's
implicit loopback proxy bypass (`<-loopback>`), so page content can't reach the runner's control API; tunnel failures
(which Chromium reports without the gateway's reason) are classified by a host-bound gateway probe; viewport rotation
counts completed runs; cancellation is polled every ≤ 5 s regardless of the lease length. Issues found and fixed along
the way are listed in DEVELOPMENT_ROADMAP.md (4D).

---

## 11. Phase 4E plan — deep website scanning

**Status (2026-11-13): implemented** as planned, with the deviations recorded in ARCHITECTURE.md D-60…D-69 (notably D-65 completeness and D-66 gateway-failure classification). Release checklist: DEPLOYMENT.md §20.

### 11.1 Reused
4B `deep-scan` queue, T3 schedules, runtime (eligibility re-check, leases, retries, DLQ, cancellation, semaphores);
`execution_results` ledger (tier `T3_DEEP`); 4C gateway-only `httpProbe` (per-hop host-bound capabilities, manual redirects,
bounded bodies) and failure classification; incident store + outbox + notify; 4D runner sessions (browser-assisted
discovery only, off by default); Phase 1 `discovered_pages` (site inventory) and `monitoring_configurations` crawl columns
(`max_pages`, `max_depth`, include/exclude patterns, query-parameter mode, `respect_robots`); usage counters; settings.

### 11.2 New
* `apps/worker-deepscan` — dedicated worker (own DB role `wim_scanner`: grants only on the tables it needs; no users,
  sessions, credentials, payments, audit, SDK or artifact access). Networks: `data` + `http-egress` (+ `browser-control`
  only if browser-assisted discovery is enabled).
* Pure policy in `@wim/core/monitoring/deepscan`: URL normalisation, scope, unsafe-route rules, robots.txt, finding rules,
  comparison.
* Tables (not partitioned; retention by scan age): `deep_scans` (one per execution: progress, coverage, config snapshot,
  comparison), `deep_scan_urls` (the resumable frontier + per-URL facts), `scan_findings` (identity
  `(website_id, fingerprint)`), `scan_finding_events`. DB guarantees: scan must match its execution (org, website, tier);
  at most one RUNNING scan per website; a final status needs the ledger row; a page is counted once (state guard).
* Incidents: one per finding *group* per website (broken pages, broken resources, sitemap), opened from confirmed findings,
  resolved only after a COMPLETE scan; SEO/accessibility are findings, not incidents (configurable).

### 11.3 Crawl
Robots → sitemaps (index/nesting, size/count/loop limits) → BFS over the frontier with per-origin delay/concurrency, depth,
page, request, byte, duration and per-org daily page budgets; every URL re-validated (scheme, port, scope, unsafe routes,
robots, include/exclude) before every fetch; each page committed with its outgoing frontier and usage in one transaction.
Crash → resume from the frontier; infrastructure errors → retry the same execution; incomplete scans never resolve.

## 12. Customer monitoring dashboard (delivered early; approved-4G scope — originally mislabelled "Phase 4F")

**Status correction (2026-11-14):** this section was written under the label "4F" by mistake. Its content is
**approved-4G scope (customer dashboard), delivered early and partially** — see §13 / §14. The work itself is kept.
Decisions D-70…D-76 in ARCHITECTURE.md §26.

**Inspection findings (2026-11-13).** The customer web app (`apps/web`, Next 16 + React Query + `@wim/ui`) has real
pages for organisations, team, roles, audit and websites (registration, verification, installation), but the
monitoring sections (Overview card, Incidents, Notifications, Analytics) are placeholders. The backend already has:
HTTP summary/results/config, incident list/detail, browser summary/results/config, screenshot links + download,
the full deep-scan API, website monitoring status (`/websites/:id/monitoring`) with pause, admin monitoring health.
Missing: incident acknowledgement, notification centre and preferences APIs, range analytics (uptime/coverage/series),
browser execution detail and filters, a unified history, an organisation usage/entitlement view, per-tier interval
settings, a change feed for live updates. **There is no realtime service** (`apps/realtime` was designed in Phase 1
but never built), so live updates use an authenticated cursor-based change feed with polling and backoff
(see D-70) rather than an unreliable WebSocket built only for effect.

1. **Reuse:** `@wim/ui` (cards, tables, tabs, badges, dialogs, stat cards, empty states), `lib/api` + React Query
   conventions, the website detail page and its tab pattern, all 4C/4D/4E endpoints, `withMember` RLS, `AuditService`,
   `resolveMonitoringLimits`/`loadOrgContexts`, `uptimeFrom`, the incident engine, worker-notify, the outbox.
2. **New pages:** organisation monitoring overview; website tabs Availability, Browser, Deep scan, Monitoring settings
   (the Overview tab gets the real health summary); browser execution detail; deep-scan scan detail (pages,
   comparison) and finding detail; incident list + detail; unified history; notification centre + preferences; usage
   and plan limits; header bell with unread count.
3. **Existing APIs integrated:** all of section 1 above.
4. **New APIs:** `GET /orgs/:o/monitoring/overview`, `GET …/websites/:w/monitoring/http/analytics?from&to`,
   result filters (`from`/`to`), `GET …/monitoring/browser/results/:executionId` + browser filters,
   `PUT …/websites/:w/monitoring/schedule` (per-tier interval; can only slow down), `POST /orgs/:o/incidents/:i/acknowledge`,
   incident list filters (status, severity, source, website, range, cursor), `GET /orgs/:o/monitoring/history`,
   `GET /orgs/:o/monitoring/usage`, `GET/PUT /orgs/:o/notification-preferences`, notifications list / unread count /
   read / read-all, `GET /orgs/:o/changes?since=` (change feed). Admin: richer aggregate monitoring health.
5. **UI architecture:** client components under `app/(app)/o/[orgId]/…`; one typed hook module per area
   (`lib/monitoring.ts`); dependency-free SVG charts fed by server-aggregated series; URL-synced filters; React Query
   with `AbortSignal` cancellation, keyset pagination, debounced search; a single change-feed poller that invalidates
   the affected queries.
6. **Security:** every read under `withMember` (RLS); writes need `monitoring:write` / `incident:write`; acknowledgement
   is a conditional transition (never resolves; idempotent; audited); preferences are per user; notifications are per
   user + org; usage, results, ledger remain read-only to `wim_app`; screenshots only through the existing signed-link
   path; no execution IDs where a stable public reference suffices; admin aggregates only.
7. **Testing:** API integration tests (real Postgres/Redis, seeded results through the real engines where practical,
   cross-tenant and forged-ID checks, audit events, pagination over large histories, change-feed isolation);
   worker-notify preference routing; Playwright E2E for the pages (desktop and mobile viewport, empty/loading/error
   states); all earlier suites, invariants, drift, isolation.

## 13. Roadmap reconciliation and the approved Phase 4F (2026-11-14)

**Discrepancy.** §3 defines 4F as *component detection + safe functional tests + responsive matrix* and 4G as
*performance thresholds/trends, rollups and the customer dashboard*. The work delivered and reported as "Phase 4F" on
2026-11-14 (§12) was the customer monitoring dashboard — approved-4G scope — built from a prompt that used the 4F
label. The phase definitions in §3 are unchanged; §12 is kept as the record of what was built and is relabelled
"4G (partial, delivered early)" in §14 below.

**Inspection (before coding).**
* Component detection: **none.** Phase 1 tables exist (`monitored_pages`, `page_components`, `test_cases`,
  `component_test_results`, enum `ComponentType`) — all empty, no code reads or writes them.
* Safe functional tests: **none.** `test_cases` (step DSL, `SAFE / REQUIRES_APPROVAL`) unused.
* Responsive: 4D records horizontal overflow and off-screen text per observed viewport in `responsive_test_results`
  (columns `overlaps`, `clipped_text`, `nav_state`, `oversized_images` exist but are never filled); 5 viewport presets,
  no landscape; viewports rotate (primary + N extra per run).
* Grants: the customer role (`wim_app`) can write `page_components`, `component_test_results`, `monitored_pages`,
  `test_cases` (Phase 1 defaults). `worker-browser` connects as the broad `wim_worker` (release blocker 3, unchanged).

**Plan (implemented in the existing Tier B browser execution — no second browser system).**
1. `@wim/core/monitoring/components`: component taxonomy, stable fingerprints, change detection (removal only after
   two consecutive complete runs), cross-viewport comparison, the action classifier with the destructive deny-list,
   functional and responsive evaluation — pure and unit-tested.
2. In-page read-only detection and layout inspection scripts (same mechanism as the 4D collector); functional
   interactions driven by worker-browser through Playwright in the runner's sandboxed Chromium, behind a request guard
   that aborts every non-GET request and every navigation to an unsafe or off-site URL.
3. Persistence in the existing result transaction (ledger-gated): `page_components` (+ status, detail, history via
   new `component_events`), `component_test_results` (ledger trigger added), `responsive_test_results` (all columns).
4. Responsive matrix: + `mobile-landscape`; overlap, clipped content, obscured/off-screen controls, navigation state
   (incl. mobile menu toggle), cross-viewport disappearance.
5. Evaluation: new `functional` class; `layout` extended with objective responsive failures; infrastructure and
   unsafe-skip outcomes never count as website failures.
6. Read API for components, history, functional results; minimal UI on existing pages (the full component /
   responsive dashboard is approved-4G scope and is **not** built here).
7. Tests: unit (classifier, fingerprints, diffs), real-Chromium integration via the production runner and gateway,
   fixture pages for each behaviour, a server-side "danger" tripwire proving no destructive request is ever sent.

## 14. Phase status after the reconciliation (2026-11-14)

### 4F — component detection, safe functional tests, responsive matrix: **implemented (this section's scope)**
| Approved requirement | Status | Evidence |
|---|---|---|
| Component detection engine | Done: 17 component types, structural keys (no positions / text), in-run dedupe, inventory + history (`component_events`), removal only after 2 complete runs, cross-viewport comparison | unit (`components.test.ts`), real-Chromium integration (`browser-components.test.ts`) |
| Safe functional tests: search, navigation, non-submitting forms | Done (opt-in per website) | integration: passing and broken variants of each |
| Button testing with a destructive-action deny-list | Done: deny-list classifier + network guard aborting every non-GET request and unsafe/off-site navigations | unit (classifier), integration tripwires (no destructive endpoint or POST ever reached) |
| Responsive test matrix | Done: 6 viewports incl. landscape phone, overflow / clipped text / overlaps / covered & off-screen controls / navigation state incl. mobile-menu probe / cross-viewport disappearance | integration on fixture pages |

### 4G — performance thresholds and trends, rollups, customer dashboard
| Requirement | Status |
|---|---|
| Customer dashboard: overview | **Done early** (§12) |
| Customer dashboard: history | **Done early** (§12, unified history) |
| Customer dashboard: pages | **Partial**: deep-scan discovered pages per scan; no page-centric view across monitoring types |
| Customer dashboard: components | **Minimal** (4F): inventory + recent changes on the Browser tab; no dedicated component dashboard, filters or per-component history page |
| Customer dashboard: responsive | **Minimal** (4F): per-execution responsive matrix on the browser execution page; no trends or matrix over time |
| Customer dashboard: performance | **Partial**: per-execution synthetic metrics (4D) only |
| Performance thresholds | **Partial**: LCP / CLS warn & critical thresholds exist since 4D (per website); no thresholds for FCP / TBT / TTFB, no budgets per page |
| Performance trends | **Not done** (no time series of synthetic metrics; HTTP response-time series exist from §12) |
| Rollups (`metrics_hourly`, `metrics_daily`) | **Not done**: tables exist since Phase 1, nothing writes them |

### 4H — worker health in admin, self-alerts, usage accounting, admin monitoring configuration, hardening
| Requirement | Status |
|---|---|
| Worker health in admin | **Partial**: aggregate monitoring page (§12) shows heartbeats, queues, outcomes; no per-worker drill-down or history |
| Platform self-alerts | **Not done** |
| Usage accounting | **Largely done** in 4B–4E (counters per tier, overhead, quotas) + customer usage page (§12); no reconciliation or export |
| Admin monitoring configuration pages | **Not done** (settings are edited through the generic admin settings page) |
| Hardening | **Not done** (chaos and load tests outstanding — see the release blockers) |

## 15. Phase 4G — audit and implementation map (2026-11-14, before coding)

Scope verified unchanged in §3: *performance thresholds + trends, rollups, customer dashboard (overview, history,
pages, components, responsive, performance)*.

| Requirement | Found | Classification | Plan |
|---|---|---|---|
| Synthetic metrics FCP / LCP / CLS / TBT / TTFB / load | `performance_metrics` per execution × viewport (4D), `source = SYNTHETIC`, INP never produced | Complete & verified (4D tests) | Reuse as the raw source |
| Thresholds | LCP / CLS warn & crit (platform settings + per-website override in `browser_check.performance`); critical LCP / CLS fails the `performance` class | Partial | All six metrics with good / poor bounds, defaults as a platform setting, customer override gated by an entitlement, validated server-side, history via audit before/after, good / needs-improvement / poor / insufficient-data, which metrics may alert, performance-specific consecutive failures / recovery passes |
| Noise protection, dedupe, recovery | Generic class streaks (`advanceClasses`), one open incident per fingerprint, INCONCLUSIVE ignored | Complete, insufficiently tested for performance | Reuse; add performance-specific thresholds; integration tests with real browser results |
| Trends | HTTP response-time series only (dashboard); nothing for synthetic metrics | Missing | Rollup-backed series per website / page / viewport / metric, gaps explicit, previous-period comparison, regressions |
| Rollups | `metrics_hourly` / `metrics_daily` (Phase 1, partitioned, PK per bucket + subject + metric, retention 62 / 400 days) — nothing writes them | Missing (schema exists) | Reuse these tables; incremental, idempotent recomputation from raw for dirty buckets, watermark, advisory lock, backfill, run by the scheduler |
| Overview | Per-website health, availability, browser, deep scan, incidents | Complete & verified | Add performance status per website and recent changes / regressions |
| History | Checks, incidents, config, verification, interruptions | Partial | Add component changes, failed functional tests, objective responsive failures, threshold changes; retention boundary indicator |
| Pages | Deep-scan pages per scan only | Missing (page-centric view) | Discovered pages with monitoring scope flags, deep-scan status, browser / perf / components / responsive for the monitored page(s), regressions |
| Components | Inventory + 20 recent changes on the Browser tab (4F) | Partial | Dedicated tab: filters by type / page / status, per-component history, comparison with an earlier date, responsive visibility changes (new) |
| Responsive | Per-execution matrix on the execution page (4F) | Partial | Dedicated tab: latest per viewport, daily outcomes over a range, run-to-run comparison, objective vs heuristic |
| Performance dashboard | Per-execution synthetic metrics | Missing | Status, metric cards with thresholds, time series with sample counts, page comparison, regressions, data quality |
| Real-browser E2E | Dashboard E2E used HTTP checks only | Missing for browser data | Run worker-browser + browser-runner in the E2E stack against the fixture site (test-only TLS allowance for the fixture CA, refused outside `NODE_ENV=test`) |
| 4F security condition (GET is not harmless) | Guard blocks non-GET and unsafe / off-site main-frame navigations | Partially addressed | Block unsafe-URL requests of any type and frame, third-party fetch / XHR / beacon / WebSocket during interactions; tests; residual risk recorded as a blocker |

## 16. Phase 4G — status after implementation (2026-11-14)

| Requirement | Status |
|---|---|
| Six synthetic metrics, statuses incl. insufficient data | **Done** (unit + integration) |
| Thresholds per entitlement, defaults, validation, history/audit | **Done** (integration + real-browser E2E) |
| No incidents from inconclusive, noise protection, dedupe, recovery | **Done** (integration with real browser executions; E2E opens a real performance incident) |
| Trends: website / page, comparisons, ranges, regressions, explicit gaps | **Done** |
| Rollups hourly / daily, website + page, counts + percentiles, idempotent, backfill, indexes | **Done** (integration + local load test) |
| Dashboard: overview, history, pages, components, responsive, performance | **Done** (E2E with real browser results) |
| 4F security condition (GET not harmless) | **Partially resolved** — guard hardened with tests; residual risk is blocker #9 |
| Production blockers 1–8 | **Open** (unchanged) |

4H: **not started.**

## 17. Phase 4H — audit map (before coding) and status (2026-11-15)

| Requirement | Found before 4H | Classification | Delivered in 4H |
|---|---|---|---|
| Worker health in admin | Aggregate page: queue counts, executions, heartbeats (alive only), scheduler cycles | Partial | Per-worker processed/failed/timeouts/last job, dependency probes, memory, restarts; component states with since; history; stale-evaluation = UNKNOWN; scheduler/notify heartbeats |
| Platform self-alerts | Nothing (enum values only) | Missing | Evaluator + 19 rules, dedupe, K-of-N open/recover, cooldown reopen, escalation, ack, storm control, outbox delivery, DB-outage path, watchdog |
| Usage accounting | Counters per org/day, ledger-gated work counters, quotas | Complete for recording; no policy, reconciliation or adjustments | Explicit policy (`USAGE_KEYS`), lease-owner check, gauges, reconciliation, audited adjustments, admin usage page |
| Admin monitoring configuration | Generic settings page (object values broken), no protection levels | Partial | Operations config page, protected policies, restart markers, combination checks, retention floors |
| Hardening | — | — | Review table in SECURITY.md §34; admin grants narrowed; history append-only; notification/maintenance failures recorded; functional-test kill switch, acknowledgement, destination policy |
| Production blockers 1–9 | Open | — | All **open** (DEPLOYMENT.md §24); 9 mitigated |

4H: **implemented and verified locally.** Phase 8 (billing): **not started** — requires separate review and approval.

