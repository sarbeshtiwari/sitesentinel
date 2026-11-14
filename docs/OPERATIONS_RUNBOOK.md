# Operations runbook (Phase 4H)

> Platform health, self-alerts, usage accounting and operational configuration. Applies to the Super Admin console
> (`apps/admin`) and the processes in DEPLOYMENT.md. Everything here is **aggregate operational data**: no operator
> view shows customer URLs, page content, screenshots, incidents, credentials or telemetry.
>
> Related: [ARCHITECTURE.md](ARCHITECTURE.md) D-91…D-98 · [SECURITY.md](SECURITY.md) §34 · [DEPLOYMENT.md](DEPLOYMENT.md) §24.

## 1. Health model

### States

| State | Meaning |
|---|---|
| **HEALTHY** | Every signal of the component is within its warning threshold. |
| **DEGRADED** | At least one signal is at or above warning (or some, but not all, instances fail). |
| **UNHEALTHY** | At least one signal is at or above critical, or all instances fail. |
| **UNKNOWN** | Nothing proves either way: no data, a feature that is switched off, a queue that could not be read. **Never shown as healthy.** When the evaluation itself is older than 3 intervals the console shows every component as UNKNOWN. |

### What is measured, separately

| Question | Signal | Source |
|---|---|---|
| Is the process **alive**? | heartbeat age ≤ `ops.health.heartbeatStaleSec` (45 s) | `worker_heartbeats.last_seen_at` (every 10 s) |
| Is it **processing**? | jobs waiting longer than `ops.health.processingStallSec` (600 s) and no live worker of that queue busy or finished a job in that window | BullMQ counts + `worker_heartbeats.last_job_at` |
| Can it **reach its dependencies**? | probes every 30 s: Redis (all), egress gateway (HTTP, browser, deep scan), browser runner (browser, deep scan), object storage (browser), SMTP (notifications) | `worker_heartbeats.deps` |
| Does it have **capacity**? | busy / capacity while work waits; memory vs `ops.health.workerMemoryMb` | heartbeat gauges |

Processes that heartbeat: scheduler (`kind=scheduler`), HTTP / browser / deep-scan execution workers (`kind=<queue>`),
notification worker (`kind=email`). The **browser runner** and **egress gateway** are observed through the workers
that use them (probes + infrastructure-failure rates); the gateway and runner have no database access by design.

### Components and rules

| Component | Rules (fingerprint = `rule:subject`) |
|---|---|
| `scheduler` | `scheduler.unavailable` — newest scheduler heartbeat age |
| `workers:<kind>` | `worker.heartbeat_expired`, `worker.not_processing`, `worker.capacity`, `worker.restarts` (starts per hour), `worker.dependency_unreachable`, `resources.utilization` (memory) |
| `queue:<name>` | `queue.backlog` — waiting jobs and age of the oldest |
| `redis` | `redis.unavailable`, `resources.utilization` (memory vs maxmemory) |
| `postgres` | `postgres.unavailable`, `resources.utilization` (connections vs max_connections) |
| `gateway` | `gateway.unavailable` — worker probes + gateway-attributed failures |
| `browser-runner` | `runner.failures` — worker probes + browser infrastructure-failure rate |
| `workers:deep-scan` | `deepscan.failures` — deep-scan infrastructure-failure rate |
| `storage` | `storage.unavailable` — probes + screenshot write failures |
| `dead-letters` | `dead_letters.growth` — dead letters per hour |
| `notifications` | `notifications.failing` — mail-provider probe of the notification workers, delivery failure rate (15 min), unrelayed outbox age, platform-alert delivery failures (15 min) |
| `rollups` | `rollups.lagging` — time since the last performance rollup run |
| `retention` | `retention.failing` — time since the last successful partition maintenance, recorded failures |
| `alerts` | `alerts.storm` — notifications held back by the storm cap |
| `customer-monitoring` | `monitoring.stalled` — ACTIVE schedules overdue by more than an interval + 5 min, per tier (only for tiers switched on). **The "monitoring silently stopped" alarm.** |
| `queue:<name>` | `executions.timeouts` — share of executions ending in TIMEOUT in 15 min |
| `process:api`, `process:ingest` | `process.unavailable` — Redis heartbeat (30 s TTL) missing, or readiness (database) failing |
| `workers:<kind>`, `scheduler` | `resources.cpu`, `resources.disk` — per process CPU (share of one core) and container filesystem use |
| `retention` | `cleanup.failing` — screenshot cleanup / deep-scan retention runs failed (previously silent) |

**Platform verdict vs worker health.** The Platform health page shows a *platform* verdict first: **customer monitoring
on schedule**, **pipeline** (scheduler, queues, workers, gateway, runner, API/ingest) and **dependencies**. Every worker
can be alive while customer monitoring has stalled (e.g. schedules never dispatched) — the verdict then says so.

Thresholds: `ops.alerts.thresholds` (warning/critical per signal; warning must be below critical). Failure
percentages are judged only with at least `minSamples` attempts (1 failure in 2 is not an outage).

## 2. Self-alerts

* **Separate from customer incidents.** Platform alerts live in `platform_alerts` / `platform_alert_events`; they never
  create customer incidents and customers cannot see them.
* **Evaluation** every `ops.health.evaluateEverySec` (30 s) by exactly one process (claim on the `__evaluator` row).
  The scheduler evaluates; the notification worker is a **watchdog** that evaluates only when nobody has for 2.5
  intervals — so a dead scheduler is still detected and alerted; when it evaluates, it also relays the outbox (the
  scheduler normally does), so the alert about the scheduler is actually delivered.
* **Noise protection:** an alert opens after `ops.alerts.openAfterEvaluations` (2) consecutive bad evaluations and
  recovers after `ops.alerts.recoverAfterEvaluations` (2) good ones. UNKNOWN neither opens nor recovers.
* **Dedupe:** at most one unrecovered alert per fingerprint (unique index). Repeats increment `occurrences`.
* **Severity:** UNHEALTHY → CRITICAL, DEGRADED → WARNING; override per rule with `ops.alerts.severity`. An alert that
  gets worse is escalated (event + notification).
* **States:** OPEN → ACKNOWLEDGED (operator, reason, audited; stops repeat notifications) → RECOVERED (automatic).
* **Cooldown / flapping:** a fingerprint that fails again within `ops.alerts.cooldownMin` (30) of recovering reopens the
  same alert (`reopen_count`), and is not re-sent if it was notified within the cooldown.
* **Repeat:** unacknowledged CRITICAL alerts are re-sent every `ops.alerts.renotifyCriticalMin` (120; 0 = never).
* **Storm protection:**
  1. *Shared dependencies* — while PostgreSQL, Redis, the gateway, the scheduler or storage is failing, alerts that it
     explains (see `ALERT_DEPENDENCIES`) are recorded with `suppressed_by` and **not sent**. One root cause, one e-mail.
  2. *Cap* — at most `ops.alerts.maxNotificationsPer10Min` (10) notifications per 10 minutes; the rest are recorded as
     `NOTIFY_SUPPRESSED` and a single `alerts.storm` CRITICAL summary is sent (cannot be disabled). Recoveries are never
     held back.
  3. *Catch-up* — alerts that are still open but were never sent (held by the cap, or suppressed by a root cause that
     has since recovered) are sent on a later evaluation, oldest first; nothing stays silently unsent.
* **Delivery:** through the existing transactional outbox (`platform.alert` topic) → `email` queue → worker-notify →
  provider, with `ops.alerts.delivery` attempts and backoff, provider idempotency keys and per-recipient dedupe (a
  duplicate job never sends twice). Recipients: `ops.alerts.recipients` or, if empty, all active Super Admins and
  operators (`ops.alert_recipients()`; the worker has no other access to admin accounts).
* **Delivery failure is durable and visible:** each failed attempt is a `NOTIFY_FAILED` event, the alert's
  `notify_state` becomes `FAILED`, the exhausted e-mail job is recorded in `job_failures` (not replayable from the
  console — it is not a monitoring execution), and `notifications.failing` turns DEGRADED.
* **PostgreSQL down:** nothing can be written there. The evaluating process logs the alert, queues a direct e-mail on
  the `email` queue (Redis) to `OPS_FALLBACK_ALERT_EMAILS` (environment of worker-notify; one per outage hour), and when
  the database is back records the outage as a RECOVERED alert with its real start time and sends the recovery.
* **Redis down:** alerts are still evaluated and stored in PostgreSQL; their outbox events wait (unrelayed) and are
  delivered when Redis is back. Workers keep heartbeating and report Redis as unreachable.

## 3. Failure response procedures

| Alert | First checks | Recovery |
|---|---|---|
| `scheduler.unavailable` | Is any scheduler process running? Last log lines? Database reachable from it? | Restart the scheduler (leaderless; any number of replicas). Missed windows are skipped, not replayed in bulk. |
| `worker.heartbeat_expired` | Process / container state, restarts, OOM kills. | Restart. In-flight executions are recovered after `scheduler.leaseSec` by another worker (attempt counted). |
| `worker.not_processing` | Worker alive but idle with jobs waiting: Redis reachability from the worker, BullMQ worker errors in logs, per-org concurrency semaphores. | Restart the worker; if Redis keys are corrupt, the scheduler's reconcile re-enqueues stuck executions. |
| `worker.dependency_unreachable` | Which dependency (detail in the worker row). Network policy, DNS, credentials. | Fix the dependency; the probe recovers within 30 s. |
| `worker.restarts` | Crash loop: logs before exit, memory, configuration changes (audit log). | Roll back the last configuration change; restart. |
| `queue.backlog` / `worker.capacity` | Arrival rate vs capacity (Platform health → workers), backpressure events, a slow customer site? | Add workers or raise concurrency (queue policy needs a worker restart). Never raise per-request timeouts to clear a backlog. |
| `dead_letters.growth` | Queues & executions → dead letters: failure categories. | Fix the cause, then replay (re-checks current authorisation and eligibility; security failures are never replayed). |
| `redis.unavailable` | Redis container, memory, persistence. | Restore Redis. Executions are reconciled from PostgreSQL; nothing is lost from the ledger. |
| `postgres.unavailable` | Database host, disk, connections. | Restore. Workers retry; leases protect against double work. |
| `gateway.unavailable` | Gateway processes, its DNS resolvers, network policy. | Restore. Checks during the outage are INCONCLUSIVE (not customer failures, not billable). |
| `runner.failures` | Runner sessions vs capacity, Chromium crashes, sandbox flag in the worker detail. | Restart runners; **never disable the sandbox** to recover. |
| `storage.unavailable` | Object storage endpoint and credentials. | Restore; screenshots are skipped meanwhile, checks continue. |
| `notifications.failing` | Provider status, SMTP probe, suppression list, unrelayed outbox age. | Restore the provider; queued notifications are retried; dead-lettered ones are listed. |
| `rollups.lagging` | Scheduler running? `monitoring.rollups.enabled`? Rollup errors in scheduler logs. | Fix; the next run recomputes all dirty buckets since the watermark. Backfill if needed. |
| `retention.failing` | Partition maintenance errors (scheduler logs), disk. | Fix; maintenance runs hourly and is idempotent. |
| `monitoring.stalled` | Highest priority: customers are not being monitored. Scheduler running and cycling? Queue backlog? Workers of that tier alive and processing? Gateway reachable? | Fix the stage that stopped; the scheduler re-dispatches overdue windows (missed ones are skipped, not replayed in bulk). |
| `process.unavailable` | API/ingest pods running? Readiness (database) failing? | Restart; check database connectivity from that pod. |
| `executions.timeouts` | Slow customer sites vs our capacity; runner saturation; gateway latency. | Do not raise timeouts blindly; add capacity or investigate the gateway. |
| `cleanup.failing` | Object storage reachable and credentials valid (screenshots); deep-scan retention errors in worker logs. | Fix; both jobs are idempotent and retried (10 min / hourly). Disk/bucket growth meanwhile. |
| `resources.cpu` / `resources.disk` | Which process; sustained or a spike; logs filling the disk? | Scale out / raise limits; rotate logs. |
| `alerts.storm` | Look at the alerts list, not the inbox. Find the shared cause. | Acknowledge after triage; the summary recovers 10 minutes after the storm ends. |

## 4. Usage accounting

### Rules

| Kind | Examples | Billable? |
|---|---|---|
| **work** | `http.checks`, `browser.executions`, `browser.screenshots`, `browser.screenshot_bytes`, `browser.functional_tests`, `deepscan.scans`, `deepscan.pages` | yes, minus exclusions |
| **exclusion** | `http.inconclusive`, `browser.inconclusive` | subtracted: our infrastructure could not decide |
| **overhead** | `exec.<tier>.failed`, `.retries`, `.cancelled`, `.skipped`, `browser.retry_ms`, `browser.infra_failures`, `deepscan.failed_attempts`, `deepscan.overhead_requests` | never |
| **info** | bytes, durations, redirects, components changed, `exec.<tier>.ok` | no (detail) |
| **gauge** | `websites.registered`, `websites.verified`, `storage.screenshot_bytes` | levels written hourly as the day's value (not summed) |

* **Once per logical result.** Work counters are written in the same transaction as the execution ledger row
  (`execution_results`, primary key = execution); a retry, a duplicate delivery or a crash-and-retry cannot add them
  twice. Since 4H the runtime also accounts an execution's completion only if the worker still owned it (a worker
  whose lease was taken over does not account it — measured by `queue/lease_lost_on_success`).
* **Cancelled** executions: overhead only. **Failed infrastructure** attempts: overhead only. **Inconclusive** results:
  recorded, not billable.
* **Periods:** daily UTC buckets per organisation; a period is the sum of its days (gauges: the latest day).
* **Limits** are enforced server-side by the component doing the work (deep-scan pages per day, screenshot bytes per day,
  websites per plan, concurrency) from plan entitlements and overrides.

### Reconciliation procedure

1. Runs automatically for yesterday after 01:00 UTC (`ops.usage.reconcileDaily`), or on request (Usage accounting →
   *Reconcile a day…*, any finished day; audited).
2. Compares per organisation: work counters vs ledger rows, inconclusive counters vs ledger outcomes, screenshot
   counters vs stored artifacts, deep-scan counters vs finished scans, `exec.*.ok/.cancelled` vs execution records, and
   ledger rows without their persisted result (integrity).
3. Each difference becomes an OPEN discrepancy. **Nothing is corrected automatically.**
4. An operator with `admin:usage:adjust` (Super Admin) either **adjusts** the counter (delta, reason ≥ 10 characters;
   counter change + adjustment record + discrepancy resolution + audit entry in one transaction; usage can never go
   negative) or **accepts** the difference with a reason. Adjustments are append-only.
5. Re-run the day: a corrected day reconciles cleanly.

Known benign difference: results recorded within a second of midnight UTC can land on either side of the boundary
(the counter uses its own transaction time); the daily run waits until 01:00.

## 5. Operational configuration

* **Where:** Super Admin → Operations config (sections) and Settings (all keys). Retention: Operations config →
  History retention.
* **Who:** read — `admin:settings:read` (Super Admin, operator, support); change — `admin:settings:write`
  (Super Admin); **protected** security policies (authentication, admin sessions, ingest, verification, domain and
  transfer policy, SDK, the functional-test switch, external links, request delay, alert enablement / recipients /
  disabled rules, maintenance mode) — additionally `admin:settings:protected` (Super Admin) and an explicit
  confirmation.
* **Validation:** every value by its schema; the resulting configuration as a whole by `validateSettingsCombination`
  (e.g. backoff base ≤ max, per-worker concurrency ≤ global, perCycleQuota ≤ maxOutstandingJobs, processing stall ≥
  2 × heartbeat staleness, the storm summary cannot be disabled). Retention: never below the per-table floor (security
  events 365 d, login attempts 90 d, delivery logs / health logs / incident occurrences 30 d, executions 14 d,
  daily metrics 90 d), at most 1095 d.
* **Audit:** `admin.setting_changed` with previous and new value, version, `protected` and `apply`; `admin.retention_changed`
  with before/after; reason mandatory. Settings history is append-only.
* **Apply:** `live` settings reach every process within ~30 s (Redis notification + cache TTL); queue policies are
  marked **restart required** (read when a worker starts).
* **Scope:** all settings are global. Per-organisation limits are plan entitlements / entitlement overrides.
* **Not here, by design:** secrets, database credentials, network policy, environment variables, SQL. There is no
  generic configuration endpoint.

## 6. Operational recovery steps (common)

* **Restart a worker:** safe at any time; graceful shutdown hands in-flight work back without consuming an attempt;
  a killed worker's executions are recovered after the lease.
* **Restart the scheduler:** safe; leaderless with database-level window uniqueness.
* **Redis lost its data:** the scheduler reconciles executions stuck in QUEUED/RETRYING from PostgreSQL and re-enqueues
  them (`scheduler.reconcileAfterSec`).
* **Replay dead letters:** Queues & executions → dead letters; replays re-check current authorisation; e-mail and
  security failures are not replayable.
* **Functional tests emergency stop:** set `monitoring.functional.enabled = false` (protected). Within ~10 s no
  interaction runs anywhere, whatever websites configured; passive detection continues.
