# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Real-time notifications in the web app: toasts, desktop notifications and sound (2026-11-18)
- **Toasts:** new in-app notifications pop up top-right (bottom on phones) with severity colour and icon, title, body, website and time; max 3 visible (+N more → Notifications); non-critical close after 8 s (paused on hover / focus), CRITICAL stays until dismissed; announced via polite / assertive live regions; reduced motion respected. Clicking opens the notification's link and marks it read.
- **Desktop (OS) notifications** via the Web Notifications API from the open tab (no push service, no service worker, no third-party calls): shown when no tab of the app is focused (optionally also when focused); CRITICAL requires interaction, others close after 10 s; silent (own sound). Permission is requested only from an "Enable desktop notifications" button (bell menu, Notifications, Preferences).
- **Sound:** short Web Audio chime (distinct three-pulse tone for CRITICAL), played by one tab only, per the IN_APP `soundEnabled` / `soundMinSeverity` preference; quick per-browser mute in the bell menu; "Test notification" / "Test critical" in Preferences (local only). Quiet hours (start / end / time zone / still alert for critical) suppress sound and desktop popups.
- **Multi-tab:** one leader tab per organisation (Web Locks, localStorage-lease fallback) polls `notifications?since=` (5 s visible, 15 s hidden, immediately when the change feed reports a notification) and shares new items over BroadcastChannel; nothing old is replayed on load.
- **Bell menu** in the top bar: live unread badge, latest 5, mark all read, mute, enable desktop notifications.
- **API:** `GET /orgs/:orgId/notifications` accepts `since` (ISO) and returns `websiteId` / `websiteName` (resolved in-org only); notification preferences expose and accept `soundEnabled`, `soundMinSeverity`, `quietHours` (optional on PUT — omitted keeps the stored value, `null` clears). No migration.
- **Tests:** `packages/core/test/notifications-realtime.test.ts` (36), `apps/api/test/integration/notifications-realtime.test.ts`.

- **Deep scan faster against a distant database (2026-11-18):** a page's links, search probes and resources are now planned in memory with the same limits (maxPages, depth, trap caps, external / resource / search-probe caps, referrer merges) and written in one set-based statement; claim + daily quota, result + progress + usage, and the findings / inventory writes in finalisation are single statements — a page with 121 outgoing URLs went from 342 database round trips to 13, a small page from 17 to 9, finalisation of a 100-page scan from 122 to 15 (`apps/worker-deepscan/src/frontier.ts`, test `deep-scan-frontier.test.ts`). No migration.

### Changed — Pages tab lists every page, with a score and a page detail (2026-11-18)
- **All pages listed:** the customer Pages tab now shows discovered pages plus every page URL the latest deep scan(s) found but didn't fetch (e.g. a scan stopped at its 10-minute limit with pages still queued), failed or skipped — marked *Not checked yet*, *HTTP 404*, *Skipped* with the reason, and "found via sitemap / link from …". A notice explains when the last scan was partial and how many pages are waiting.
- **Page score (0–100)** per page, computed server-side: not checked → no score; page doesn't load → 0; otherwise 100 − open findings (critical 25, high 15, medium 8, low 3, info 0), floored at 0. Coloured badge (≥ 90 good, 50–89 needs work, < 50 poor) with the formula as tooltip; severity chips per page.
- **Table:** numbered pagination with page size 10 / 25 / 50 / 100, total "N pages", filter (with findings / not checked / failed / skipped), search by URL or title, sort by page, score or findings by clicking the headers.
- **Page detail** `/o/:orgId/websites/:websiteId/pages/:pageId`: status, HTTP code, source, referrer, first / last seen and last checked; score breakdown; every OPEN finding with what it means, how to fix it, sanitised evidence, first / last seen and occurrences (linked to the finding page); findings fixed in the last 30 days; site-wide findings involving the page. "Open page" opens the URL with `rel="noopener noreferrer"`.
- **API:** `GET …/pages` now uses offset pagination (`page`, `pageSize`, `search`, `sort`, `filter`; returns `total`, `pages`, `summary`, `latestScan`); new `GET …/pages/:pageId` (discovered page uuid or `url-<sha256>`; ownership checked under RLS, 404 across websites and organisations). No migration.
- **UI kit:** `Pagination` gained a numbered mode (`page`, `pages`, `onPage`, `trailing`); the cursor mode is unchanged.
- **Tests:** `apps/api/test/integration/pages.test.ts` (union, totals, filters, sort, score, detail, tenant isolation); `packages/core/test/page-score.test.ts`.

### Added — Popups, cookie banners and JavaScript dialogs in browser monitoring (2026-11-18)
- **Fixed false alarms:** a cookie banner, newsletter modal or interstitial shown on load no longer fails the layout check with `CONTROLS_OBSCURED_*` or functional tests with `BUTTON_NOT_CLICKABLE`. After performance is measured on the untouched load, the overlay is detected (dialogs, `aria-modal`, common CMP containers, covering fixed/sticky layers) and closed safely: configured close button → Escape → "Reject" / "Necessary only" on cookie banners (never "Accept") → close control; ≤ 3 clicks, ≤ 5 s per viewport; no new request may leave the browser while closing (SECURITY.md §37).
- **New result facts** per viewport (`details.overlay`, `details.dialogs`, jsonb — no migration) and on the browser run page ("Popup on load", "JavaScript dialogs"). A closed popup is a warning; one that blocks the page and can't be closed fails as `OVERLAY_BLOCKING_<VIEWPORT>` (and is not reported again as `CONTROLS_OBSCURED`).
- **Per-website setting** `popups: { dismiss (default true), closeSelector }` in the browser check configuration, validated server-side; Monitoring settings → Browser monitoring: "Close popups and cookie banners before checking" and "Popup close button (CSS selector)".
- **JavaScript dialogs** (alert / confirm / prompt / beforeunload), previously auto-dismissed silently by Playwright, are now dismissed explicitly (never accepted) and recorded as warnings with a scrubbed message.
- **Tests:** fixture pages `/c/popup-cookie`, `/c/popup-modal`, `/c/popup-stuck`, `/c/js-alert`; real-Chromium integration suite `browser-popups.test.ts`; unit tests `packages/core/test/overlay.test.ts`.

### Added — Phase 8: billing and trials (2026-11-15, partial — see docs/BILLING.md)
- **Off by default:** new protected setting `billing.enabled` (false) gates checkout, plan changes, cancellation and every payment-gateway call; webhooks answer 503 while it is off; entitlement resolution is unchanged while it is off.
- **Plans and entitlements:** example Free/Starter/Pro/Business plans with INR and USD monthly/annual prices (decision B2, clearly marked); entitlement resolver (subscription → trial plan → free plan → platform defaults, overrides on top) inside `loadOrgContexts` with no worker change; Super Admin plans, immutable price versions, entitlement sets and per-organisation overrides, all audited with a reason.
- **Subscriptions:** pure state machine (TRIALING/ACTIVE/PAST_DUE/CANCELING/CANCELED/EXPIRED) with an out-of-order guard, grace period and dunning schedule from settings; daily advisory-locked reconciliation in the scheduler.
- **Gateways:** new `@wim/billing` package — PaymentGateway interface, Stripe and Razorpay REST adapters (no SDK dependency), raw-body webhook signatures (Stripe timestamped HMAC with tolerance, Razorpay HMAC), replay protection through `UNIQUE(gateway, event_id)`, processing in one transaction under the organisation's RLS context; gateway secrets sealed with a platform data key, write-only.
- **UI:** customer Billing page; Super Admin Plans and Payment gateways pages.
- **Database:** `sql/180_billing.sql` (definer org resolver for verified webhooks, invoice sequence, narrowed grants); invariants block 10. No Prisma migration.
- **Not verified:** Stripe/Razorpay test-mode end-to-end (no test keys).

### Release readiness exercise (2026-11-15) — see docs/RELEASE_READINESS.md
- **Security:** worker-browser now runs as the least-privilege `wim_browser` role (column grants, tier-restricted RLS, invariant 1g); third-party resource policy signed into the browser capability and enforced by the egress gateway; functional tests require explicit safe destinations and refuse every undeclared first-party request type while interacting; startup validation of worker database roles (and of production credentials/TLS).
- **Operations:** "customer monitoring stalled" detection and a platform verdict separate from worker health; API/ingest liveness; CPU, disk and timeout-rate signals; screenshot-cleanup and deep-scan-retention failures recorded; pages-per-scan reconciliation; `OPS_FALLBACK_ALERT_EMAILS` mandatory in production.
- **Release tooling:** CI builds and validates production images and runs isolation against the runner image; staging NetworkPolicies, runner Deployment, probe image and script; load harness; staging deployment plan; credential provisioning design.

### Added — Phase 4H: platform operations, self-monitoring, usage accounting, admin configuration, hardening (2026-11-15)
- **Platform health:** explicit HEALTHY / DEGRADED / UNHEALTHY / UNKNOWN per component; heartbeats from every execution worker, the scheduler and the notification worker with work done, dependency probes (Redis, gateway, runner, storage, SMTP), capacity and memory; restarts; history. Super Admin → Platform health.
- **Self-alerts:** 19 rules, one alert per fingerprint, K-of-N open/recover, cooldown reopen, escalation, acknowledgement (audited), shared-dependency suppression and a storm cap with one summary, delivery through the existing outbox/e-mail path with retries, durable failure records, a watchdog evaluator and a PostgreSQL-outage path. Super Admin → Platform alerts.
- **Usage accounting:** explicit policy (work / exclusion / overhead / info / gauge), daily gauges, reconciliation against the ledger, artifacts, scans and executions; audited, append-only adjustments; Super Admin → Usage accounting.
- **Operations configuration:** sections, protected security policies (extra permission + confirmation), restart-required markers, whole-configuration safety checks, retention with floors; generic settings page now edits object-valued settings.
- **Functional tests:** platform switch (default off), customer risk acknowledgement, `allowedPaths` destination policy.
- **Found by the real-infrastructure chaos run and fixed:** the watchdog now relays the outbox itself (with the scheduler dead nobody else did — the "scheduler down" e-mail arrived only after the scheduler returned); alerts held back by the storm cap or by a recovered root cause are sent later instead of never; recovery notifications are never held back by the cap; the mail-provider probe feeds the notifications component; one PostgreSQL outage seen by two evaluators is recorded once.
- **Fixed / hardened:** usage double-count after a lost lease; exhausted notifications and failed partition maintenance are recorded; `wim_admin` lost the customer-origin column and settings-history edits; IP addresses stripped from operator-visible errors.

### Added — Phase 4G: performance intelligence, trends, rollups, dashboard completion (2026-11-14)
- **Performance policy** for six synthetic metrics (FCP, LCP, CLS, TBT, TTFB, load; never INP): good / needs improvement / poor / insufficient data from p75 of ≥ 3 samples; platform defaults; per-website thresholds and alerting metrics behind the `monitoring.performance.customThresholds` entitlement; server validation; audit history; performance-specific consecutive-failure and recovery counts.
- **Rollups** into `metrics_hourly` / `metrics_daily` (website and page × metric × viewport; count, sum, min, max, exact p50/p75/p95, histogram), incremental with watermark and advisory lock, idempotent recompute from raw, backfill; run by the scheduler.
- **APIs:** performance summary / series / pages / thresholds, pages, component changes and detail, responsive latest / compare; overview performance + recent changes; history component / functional / responsive events and retention.
- **Dashboard:** website tabs Performance, Pages, Components, Responsive; overview performance column and recent changes; history filters and retention note.
- **Security:** interaction guard blocks deny-listed URLs for all request types and frames and third-party scripted requests; broader deny-lists; test-only TLS trust in browser-runner (refused outside `NODE_ENV=test`).
- **Fixed:** hidden mobile search excused only when inside a toggled menu; first save of browser settings with a null nested field (400); thresholds form overwritten by background refresh.

### Added — Phase 4F (approved scope): component detection, safe functional tests, responsive matrix (2026-11-14)
- **Component detection:** read-only detection in the existing browser check across 17 types (header, navigation, footer, search, forms, buttons, calls to action, media, dropdowns, dialogs, tabs, accordions, sliders, pagination, tables, mobile-menu toggle, repeated content).
  - Identity uses structural keys, never positions or text, with in-run deduplication.
  - The inventory is `page_components` (+ status, detail, viewports) with change history in the new `component_events`.
  - Change kinds: ADDED, CHANGED, REMOVED (only after 2 complete runs), RESTORED. An incomplete run never counts as removal.
- **Safe functional tests** (opt-in per website, `browser_check.functional`):
  - Covered: GET search; navigation links; form validation without ever submitting (password, payment and file fields untouched); safe buttons and toggles.
  - Outcomes PASSED / FAILED / SKIPPED / INCONCLUSIVE with reasons.
  - **Safety:** a destructive-action deny-list classifier, plus a request guard aborting every non-GET request and every unsafe or off-site navigation. Anything not confidently safe is skipped.
  - **Attribution:** gateway refusals, our outages and time budgets are never website failures; connection-level failures are re-checked against the start page.
  - New incident class `browser.functional`.
- **Responsive matrix:**
  - `mobile-landscape` viewport (6 presets; `maxViewportsPerRun` up to 6).
  - Objective failures: horizontal overflow, broken or unreachable navigation (mobile-menu probe), controls covered by other elements or off-screen.
  - Heuristics: clipped text, overlapping controls, oversized images, components visible on wide screens but missing on narrow ones.
  - Every `responsive_test_results` column is now filled.
- **API:** `GET …/websites/:id/components`, `GET …/components/history`; browser execution detail adds `functional` and `responsive`.
- **UI:** functional and responsive sections on the browser execution page; detected components and recent changes on the Browser tab; functional-test settings.
- **Database:**
  - Migration `phase4f_components`.
  - `sql/130_components.sql`: ledger trigger on `component_test_results`, tenancy triggers on monitored pages, components and events, customer role read-only, admin no access.
  - Invariant 1d.
- **Tests:** `browser-components.test.ts` (10, real Chromium through the runner and gateway, with destructive-endpoint tripwires); a component API / tenant test; `core/test/components.test.ts` (34).

### Fixed — Phase 4F (approved scope)
- The customer role could write `page_components`, `component_test_results`, `monitored_pages` and `test_cases` (Phase 1 grants).
- `maxViewportsPerRun` was clamped to 5 in the resolver; viewport rotation could never reach 6.
- `overlaps` is a reserved word in PostgreSQL; unquoted, it dead-lettered every browser result (caught by the integration tests before release).

### Added — Customer monitoring dashboard (2026-11-14; approved-4G scope delivered early, originally labelled "Phase 4F")
- **Customer dashboard** (`apps/web`):
  - Monitoring overview: per-website health with reasons; never "healthy" on thin data; infrastructure failures shown as such.
  - Website tabs:
    - Availability: backend uptime, coverage and downtime; response-time, status and failure charts; check history with safe details.
    - Browser: filtered history; execution detail with viewports, diagnostics, synthetic metrics and on-demand screenshots.
    - Deep scan: status, findings, history, scan detail with discovered pages and comparison against any scan, finding detail.
    - Monitoring settings: HTTP, browser and deep scan, with entitlement explanations and per-tier intervals.
  - Incidents: filters, cursor pagination, detail with timeline, linked occurrences, delivery summary and acknowledgement.
  - Unified history, notification centre and preferences, usage and plan limits, header bell with live unread count.
  - Responsive at phone and tablet widths.
- **API:**
  - New endpoints: `monitoring/overview`, `http/analytics`, `monitoring/schedule`, `incidents/:id/acknowledge`, `monitoring/history`, `monitoring/usage`, `notifications` (list, read, read-all), `notification-preferences`, `changes` (live-update feed), browser `results/:executionId`, deep-scan `compare`.
  - Extended filters on incidents, HTTP and browser results, and deep-scan findings.
  - 410 `ARTIFACT_EXPIRED` for expired screenshots.
  - Richer admin aggregates.
- **worker-notify:** per-channel preferences (EMAIL / IN_APP with an on/off switch); event types by incident source; in-app notices for certificate warnings and monitoring interruptions; recovery notices respect opt-outs.
- **Admin:** `/monitoring` operations page (aggregate only).
- **Database:**
  - Migration `phase4f_dashboard` (indexes, `notification_preferences.enabled`).
  - `sql/120_dashboard.sql`: `acknowledge_incident()`, narrowed `wim_app` grants, retention function, aggregate admin views.
- **Tests:** `dashboard-api.test.ts` (12) and a new browser detail / filters / expiry test; Playwright `phase4f.spec.ts` (9: desktop, mobile, tablet, failure states, admin privacy).
- **Test fixtures:** `fault-env.mjs` can publish DNS TXT records; worker-deepscan accepts a test-only CA (`NODE_ENV=test`).

### Fixed — customer monitoring dashboard (labelled "Phase 4F" at the time)
- The customer role could write `incidents`, `incident_events`, `notifications` and `notification_delivery_logs` directly (Phase 1 grants). Now it has the acknowledge function and `read_at` only.
- The monitoring settings form lost a user's typing when a background refresh arrived (found by the E2E run).
- Schema comments described `t2_interval_sec` NULL as "tier disabled"; the scheduler has always treated NULL as the plan default.
- An E2E stack-start mistake (duplicate workers holding stale CA files) produced false TLS failures. Documented the start procedure.

### Added — Phase 4E: Deep website scanning (2026-11-13)
- `apps/worker-deepscan`: bounded, resumable, gateway-only site crawler on the 4B runtime (tier DEEPSCAN, `deep-scan` queue), running as the new narrow `wim_scanner` database role.
  - Discovery: robots.txt, sitemap indexes and nested sitemaps, link crawl; optional browser-assisted SPA discovery through the 4D runner (entitlement-gated).
  - Static HTML analysis: broken pages, resources and redirects; SEO metadata, duplicates, canonical, indexing directives, JSON-LD; structure and automated accessibility checks (labelled as automated checks, not WCAG certification).
  - Grouped findings with history, and incidents per finding group (source `DEEP_SCAN`).
  - Comparison with the previous complete scan. Partial scans never resolve findings or report removed pages.
- `@wim/core`: deep-scan configuration schema, URL normalisation, scope and unsafe-route policy, robots.txt parser, finding catalogue, effective limits; `monitoring.deepscan.*` settings (off by default).
- Database: `deep_scans`, `deep_scan_urls`, `scan_findings`, `scan_finding_events`, `monitoring_configurations.deep_scan`.
  - `sql/110_deep_scan.sql`: role, ownership and final-state triggers, one running scan per website, `request_deep_scan()`, admin view.
  - New database invariant 1c.
- Usage: pages, bytes, requests, resources, scans, partial scans, duration, browser time, and failed-attempt overhead (not billable).
- Runtime: per-organisation-per-tier concurrency semaphore (`monitoring.deepscan.maxConcurrentScans`).
- API: deep-scan summary, config, start, pause, cancel, scan history, pages, findings with history, usage; admin `deepScans` aggregates.
- `infra/docker/worker-deepscan.Dockerfile`; `infra/compose/docker-compose.deepscan-ops.yml`; isolation suite extended with a `deepscan` container (real fetch path, hostile redirects, DNS and misconfigured scope).

### Changed — Phase 4E
- `monitoring_configurations.max_pages` / `max_depth` are nullable (NULL = plan limit). The Phase 1 defaults (25 / 3) silently capped every plan and were reset.
- `query_param_mode` defaults to `KEEP_MEANINGFUL`.
- `wim_app` can no longer write `usage_counters`.
- The probe exposes the raw `Location` to the gateway-only client (never persisted); `last-modified` and `x-robots-tag` added to the safe headers.

### Fixed — Phase 4E (found during this phase)
- A gateway dying mid-request (timeouts and resets rather than "unavailable") was recorded as the customer's broken pages. Found in the Docker run; connection-level failures are now re-checked against the gateway health and canary.
- A scan that could reach no page (all destinations refused) was marked complete.
- Partial scans wrote ledger outcome PASSED.
- Sitemap entries cut off at the size limit were used.
- Large sitemaps inserted row by row (a 60 000-entry sitemap timed out).
- Redirecting URLs were analysed as pages.
- Scan comparisons counted resolved accessibility findings as newly detected.

### Added — Phase 4D: Browser monitoring (2026-11-13)
- Synthetic browser monitoring with real Chromium:
  - navigation and readiness strategies;
  - blank and rendering checks, JavaScript exceptions, rejections and console errors (grouped);
  - first-party and third-party resource failures, broken images, fonts;
  - responsive viewports (presets, cost-aware rotation);
  - synthetic FCP/LCP/CLS/TBT/TTFB (no INP);
  - masked failure screenshots.
- `apps/browser-runner` (Chromium sandbox on, custom seccomp profile) and `apps/worker-browser` (control plane); Dockerfiles; `infra/security/seccomp/chromium.json`.
- `execution_results` ledger: one logical result per execution, enforced by the database for all engines.
- Incidents for browser check classes; usage accounting for browser time, screenshots and retry overhead; screenshot quota and expiry cleanup.
- API: browser status, history and config; signed screenshot links and download; admin browser aggregates.
- Gateway per-execution connection budget; isolation suite covers the real runner (sandbox verified by namespaces and seccomp filters); CI isolation job.

### Fixed — Phase 4D
- Gateway plain-HTTP: connect timeout no longer cuts slow responses.
- Isolation proof: gateway decisions logged at info (the internal-ALLOWED check was vacuous at warn).
- Execution cancellation now takes effect within 5 seconds regardless of lease length.
- A second result row for one execution with a different timestamp was accepted by `check_results`.

### Added — Phase 4C: HTTP availability monitoring (2026-11-13)
- HTTP availability engine in `worker-http` (gateway-only probe, DNS/connect/TLS/TTFB/total measurements, TLS certificate facts, redirects, HEAD→GET fallback, content and content-type assertions, bounded reads).
- Incident lifecycle (`@wim/incidents`): per-class thresholds, grouping, auto-resolve, reopen, occurrences, timeline; transactional outbox with dedupe keys.
- Notifications: outage, recovery, certificate expiring, monitoring interrupted (email + in-app), deduplicated per incident transition and recipient.
- APIs: website HTTP status/uptime/history/config; incidents list/detail; admin HTTP aggregates.
- Gateway: per-hop host-bound capability tokens; DNS/connect timings in CONNECT responses.
- Test fixtures: controlled fault website (HTTP + HTTPS), test PKI.
- Migrations `phase4c_http_monitoring`, `phase4c_interval_default`; `sql/090_http_monitoring.sql`.

### Fixed — Phase 4C
- `monitoring_configurations.t1_interval_sec` default 300 removed (it silently overrode the 60 s default).
- Partition maintenance is now executed (scheduler) and permitted for the worker role.

### Added — Phase 4B: Scheduler and queue infrastructure (2026-11-13)
- `apps/scheduler`: leaderless monitoring scheduler (schedule sync, fair weighted round-robin dispatch, durable window dedupe, reconcile, dead-letter replay); Dockerfile.
- `@wim/queue`: queue registry (`http-monitoring`, `browser-monitoring`, `deep-scan`, `dead-letter`, reused `revalidate`), per-queue policies, execution runtime (strict id-only payloads, eligibility re-check, per-org/global semaphores, leases, cancellation, graceful shutdown, full-jitter retries, failure categories, DLQ), usage accounting, heartbeats.
- `@wim/core`: scheduling policy (windows, jitter, effective limits from settings ⊕ plan ⊕ overrides, entitlement, eligibility, backoff, fair order); settings `monitoring.*`, `scheduler.*`, `queue.*` (all monitoring tiers disabled by default).
- Migration `phase4b_scheduler`, `sql/080_scheduler.sql` (pause/cancel functions, admin aggregate views, narrowed grants).
- API: website monitoring status, pause/resume, execution cancel; admin monitoring health, dead letters, replay (`admin:monitoring:read|replay`).
- Isolation suite: scheduler container probes (101 checks).

### Added — Phase 4A: Network isolation and ownership revalidation (2026-11-13)
- `apps/egress-gateway`: SSRF-safe CONNECT/HTTP egress proxy + DNS API with signed per-job capability tokens, port allow-list, pinned connections, per-org caps, byte/time limits, metadata-only decision log; production Dockerfile.
- `@wim/netguard`: gateway client (`signCapability`, `createGatewayDnsClient`, `safeFetch({ egress })`), IPv6 global-unicast allow-list, `BROWSER_LAUNCH_ARGS`, `guardedGoto`.
- `infra/security/`: isolation topology and in-container probes (83 checks, incl. real Chromium with and without proxy); `browser-runner` Dockerfile.
- Ownership revalidation: `@wim/core` policy, `revalidate` queue + worker + sweep, transactional effects (incl. inherited subdomains), emails, `claim.revalidation` in the API, customer UI banners; migration `phase4a_revalidation`; settings `revalidation.*`.
- `docs/PHASE4_PLAN.md`.

### Changed — Phase 4A
- `worker-http` routes all verification traffic through the gateway; refuses to start in production without it.
- Test fixtures: DNS server supports SERVFAIL and embedded-IPv4 AAAA records; servers can bind any host.

### Added — Phase 3: Website registration, verification and SDK (2026-11-13)
- Website registration with domain identity normalization (scheme, `www`, path, port, IDN/punycode, PSL incl. private suffixes, reserved/internal/IP rejection), live preview, categories, monitoring timezone.
- Database-enforced duplicate prevention and claim lifecycle (`sql/070_websites.sql`): `register_domain_claim()` under per-domain advisory locks, 72 h pending expiry, ROOT_EXCLUSIVE subdomain reservation, pending-claim limit, registration-attempt log.
- Ownership verification by DNS TXT, `/.well-known` file and `<meta>` tag in `apps/worker-http`; attempt limits, token regeneration, restart after expiry, verification history and audit.
- `@wim/netguard`: SSRF-safe DNS and HTTP (deny-list incl. metadata, IPv4-mapped/NAT64, pinned connections, re-validated same-identity redirects).
- Trial activation at first verification (30 days, no card, configurable), race-safe; deleted accounts can't reset a domain's trial.
- `@wim/sdk` v1.0.0 (~3 KB gzip, privacy-first) and `apps/ingest` (SDK delivery, remote config, heartbeats, sanitised telemetry) using the table-less `wim_ingest` role.
- Installation states derived from heartbeats (NOT_INSTALLED, DETECTED, ACTIVE, INACTIVE, INVALID_CONFIGURATION); server-side diagnostic check; key regenerate (24 h grace) and revoke; telemetry pause/resume; SDK privacy configuration.
- Domain ownership transfers (requester DNS proof → owner notice/contest → Super Admin decision → worker applies; no data moves) with emails.
- Customer UI: websites list, add website, detail (overview, verification, installation with 7 framework guides, settings, history, audit), transfers. Admin UI: website statistics, transfer review.
- Tests: 98 new unit (core 46, netguard 49, sdk 3), 48 new integration, 2 new E2E (real verification worker, real SDK in Chromium).

### Changed — Phase 3
- `admin.login.perIpPer15Min` is now a setting (default 10, unchanged).
- Phase 1 invariant test: two assertions scoped to their fixture tenants (they assumed an empty database).

### Added — Phase 2: Foundation (2026-11-13)
- Monorepo: pnpm + Turborepo, strict TypeScript 5.9, ESM throughout; CI workflow (`.github/workflows/ci.yml`, not yet run — no remote repository).
- `apps/api` (NestJS 12 / Fastify): registration (enumeration-safe), email verification, login with per-IP and per-account brute-force protection, opaque revocable sessions, CSRF + Origin checks, password reset/change, TOTP 2FA with recovery codes, per-account 2FA failure cap, delayed lost-device 2FA reset, organizations, invitations, members, custom roles, ownership transfer, org deletion request, audit endpoints, public branding config, health probes; Super Admin auth (password + TOTP), aggregate overview, customer metadata, audit viewer + chain verification, audited hot-reloaded settings; `admin:create` CLI.
- `apps/worker-notify`: BullMQ email worker; issues verification/reset/invitation/recovery tokens at send time.
- `apps/web` and `apps/admin` (Next.js 16) on a shared `packages/ui` design system; nonce-based CSP (no `unsafe-inline` scripts).
- Packages: `@wim/crypto` (envelope encryption, external key ring, Argon2id, RFC 6238 TOTP), `@wim/logger` (redaction), `@wim/core` (RBAC + escalation policy, typed settings registry with SiteSentinel defaults), `@wim/contracts`, `@wim/email` (SMTP, Resend, SES).
- Database: migration `phase2_auth`; `sql/060_identity.sql` (DB-enforced membership entry `app_enter_org`, user-scoped RLS, audit read policies, pre-auth lookup functions, RBAC integrity triggers, platform statistics views); seed script; isolated test-database setup.
- Tests: 43 unit, 70 integration (real Postgres/Redis/Mailpit), 3 Playwright E2E, Phase 1 invariants re-verified.

### Changed — Phase 2
- `infra/postgres/init` also installs `citext`/`pgcrypto` in `template1` (Prisma shadow DB, test DB).
- `apply-sql.mjs` passes the environment through; `prisma.config.ts` no longer requires a database URL for `prisma generate`.
- `NODE_ENV` removed from `.env.example` (it broke `next build`); the API defaults to development.

### Added — Phase 1: Architecture (2026-11-13)
- Architecture documentation: `docs/ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `API_DOCUMENTATION.md`, `SECURITY.md`, `DEPLOYMENT.md`, `DEVELOPMENT_ROADMAP.md`.
- `packages/db`: a Prisma 7 schema (85 tables), an initial migration with 16 range-partitioned high-volume tables, and an idempotent SQL layer:
  - partition management and retention (`partitions.ensure_all`, `partitions.apply_retention`)
  - row-level security with tenant and system contexts, plus `resolve_site_key()`
  - partial unique indexes: one live claim per domain, one active incident per fingerprint, one current subscription per org
  - CHECK constraints, including break-glass dual control
  - a hash-chained, append-only audit log with `audit_verify()`
  - per-role grants with write-only secret columns, and metadata-only `admin_v_*` views for the Super Admin
- `packages/db/tests/invariants.sql`: database invariant tests (11 groups, all passing).
- Docker dev infrastructure (`infra/compose/docker-compose.dev.yml`): Postgres 16, Redis 7.4 (AOF, noeviction), SeaweedFS S3, Mailpit. Runtime DB roles are created on init.

### Notes
- MinIO was replaced by SeaweedFS for local S3 because MinIO no longer publishes public container images.
- Prisma is pinned to 7.10.1. npm `latest` currently points to an 8.0 release candidate.
