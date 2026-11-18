# SiteSentinel — Final production-readiness audit (2026-11-15)

**Purpose:** prove, with runtime evidence, whether SiteSentinel is ready — not to assert it. Code at `main` / `stage`
`a03617b` + the audit's final commit. Detailed evidence lives in the companion documents:

| Document | Content |
|---|---|
| `REQUIREMENTS_TRACEABILITY_MATRIX.md` | 170 requirements (Phase 1 → 4H, early dashboard, billing core) with location, test, evidence, status |
| `SECURITY_AUDIT_REPORT.md` | Runtime negative tests, findings with severity and reproduction |
| `UI_UX_AUDIT_REPORT.md` | 68 routes × 4 viewports (+ dark), brand, shell, components, fixes |
| `TEST_EXECUTION_REPORT.md` | Every suite: command, environment, counts, duration; database audit; E2E addendum |
| `PRODUCTION_GO_LIVE_CHECKLIST.md` | Ordered remediation and go-live steps |

## 1. Overall verdict

| Decision | Verdict |
|---|---|
| **A. Internal / staging readiness** | **CONDITIONALLY APPROVED** |
| **B. Limited production** (internal or explicitly approved test websites) | **NOT APPROVED today → CONDITIONALLY APPROVED once the "Immediately" block of the checklist is done** |
| **C. Public commercial launch** | **NOT APPROVED** |

The application is functionally strong and tenant isolation held under every negative test at the API layer. It is not
ready for public customers: a critical database-grant defect is **live in the deployed database right now**, two
unsafe settings are switched on in live, credentials were exposed and are not yet rotated, five historical blockers
need infrastructure, and billing is incomplete.

## 2. Method and environment (honest scope)

* **Local verification (LA/LR):** local Docker Postgres/Redis/SeaweedFS/Mailpit; full local stack; production builds of
  web/admin for E2E; Playwright/Chromium. This is where every PASS in this audit was earned.
* **CI evidence:** GitHub Actions on `sarbeshtiwari/sitesentinel` — 14 of the last 15 runs green; run 43701390673:
  integration 306/306 and network isolation 170 checks / 0 violations against the production runner image (linux/amd64).
* **Live (Render) — read-only only:** settings, role flags, view grants. No writes were made to live during the audit.
* **Not available:** staging cluster, production-like load infrastructure, secret manager, real payment test keys,
  verified email domain. Everything that depends on these is **BLOCKED**, never PASS.
* Local laptop measurements are not production capacity and are not extrapolated.

## 3. Requirements completion

Denominator: **167** requirements (170 extracted; 3 N.A. replaced by recorded decisions). Only runtime-verified PASS
counts as complete.

| Measure | Result |
|---|---|
| PASS | **145 / 167 = 86.8 %** |
| PASS + PARTIAL | 156 / 167 = 93.4 % |
| Phases 1–4H only, PASS | 141 / 161 = 87.6 % |
| Status totals | 145 PASS · 11 PARTIAL · 6 FAIL · 5 BLOCKED · 3 N.A. |

**Dropped without a record (FAIL):** org-level "require 2FA", email-change flow, re-authentication window (Phase 3);
abuse/risk signals; billing items (dunning, refunds, invoice PDFs, downgrade selection, GST invoicing).
**Changed by recorded decisions:** WebSocket realtime → polling change feed (now 5 s); weekly → 24 h revalidation;
immediate retry → consecutive-failure thresholds; SDK-beacon verification method removed.

## 4. Test results (this audit)

| Suite | Result |
|---|---|
| Typecheck (no cache) | 45/45 tasks, 0 errors |
| Unit | 452/452 passed (20 files) |
| API integration (real Postgres/Redis/Mailpit/S3) | run 1: 305/306 (1 time-window flake, passed 24/24 on rerun); **after fix: 307/307**, 0 skipped |
| Database invariants | pass; new check **1i** added (fails on any database where the grant defect is present — dev `wim` and live until migrated) |
| Production builds | 24/24 tasks |
| Lint | **no-op** — no ESLint/Biome config exists (RELEASE_READINESS's "lint 46/46" is not evidence) |
| Network isolation | BLOCKED locally (arm64 host); **CI: 170/0** |
| E2E (Playwright, not in CI) | **20/22 passed**; phase4h not passed in this audit (environment state — see TEST_EXECUTION_REPORT addendum) |
| Security probes (runtime) | 117 cross-tenant requests → all 404; 161 protected routes → 401/403; 28 SSRF probes refused; CSRF 8/8 rejected; XSS inert in 10 pages |
| UI | 583 page loads / 68 routes / 4 viewports + dark: 0 horizontal overflow, 0 broken images, 0 dead links |
| Local API latency (laptop, 8 concurrent, n=120/endpoint) | p50 9–73 ms, p95 28–194 ms (overview slowest), p99 ≤ 234 ms, 0 errors |

## 5. Issues by severity

### Critical
| # | Issue | Status |
|---|---|---|
| C-1 | **View grants on redeploy.** `050_grants.sql` grants "ALL TABLES" (which includes views) on every deploy, so `wim_app` and `wim_worker` gain SELECT on all 17 owner-privileged `admin_v_*` views (they bypass RLS → cross-tenant data) and UPDATE on `admin_v_usage_daily`. **Verified on the live Render database: 17/17 views readable by both roles.** | **Fixed in code (`a03617b`) + invariant 1i + test DB applies the SQL layer twice. Not yet applied to live — checklist item 1.** Code paths using these views: admin only (verified), so the revoke is safe. |

### High
| # | Issue | Status |
|---|---|---|
| H-1 | **Functional testing can mutate customer data** (release blocker 9): the request guard allows any query string on the monitored page (`/?empty-cart=1`, `/products/42/rate?stars=1`). **Enabled in live** (`monitoring.functional.enabled = true`, set by an admin 06:28 UTC). | Open. Disable in live now; capability stays unsupported for production. |
| H-2 | **Billing enabled in live** (`billing.enabled = true`, Stripe + Razorpay configured in test mode) while Phase 8 is incomplete and never tested end to end. | Open. Disable in live now. |
| H-3 | **Exposed credentials**: database owner and role passwords, Redis password, the live `KEK_RING_JSON`, `EGRESS_TOKEN_SECRET`, AWS keys appeared in chat / `.env` / `text.txt`. (Live KEK differs from the dev key — correct — but is exposed.) | Open. Rotate (checklist). |

### Medium
F-1 forged `X-Forwarded-For` bypasses per-IP rate limits with `TRUST_PROXY=true` · F-2 RLS does not contain a
compromised service credential (session-variable based) · F-3 admin auditors read org audit streams with customer
emails, unaudited (contradicts SECURITY.md §19) · F-4 `wim_worker` far broader than documented (users, sessions,
secrets) · F-6 only 2 of 7 services refuse dev passwords / non-TLS in production · forced RLS documented but not applied ·
organisation deletion never executed (request recorded only) · no purge of expired sessions/tokens/outbox · workers run
on a laptop (live) · lint no-op · API conventions in docs (Idempotency-Key, ETag/If-Match, RateLimit-*) not implemented.

### Low
Missing HSTS/COOP on web/admin; CSP/Referrer-Policy differ from docs; browser-runner control API unauthenticated
(network isolation is the control — proven in CI, not in staging); private-IP websites registrable (verification still
blocked); missing org-level 2FA; no HTTP-level cookie-flag test; a few admin labels below AA contrast; `/favicon.ico`
404 (declared icons work); one non-reproducible hydration warning in dev; stale docs ("billing not started", "engine
ships in Phase 4C").

### Fixed during the audit (with regression tests, committed)
C-1 view grants · deep-scan inconclusive scans recorded incident occurrences / could reopen incidents · 8 UI defects
(WCAG AA contrast for badges, secondary text, dark-mode buttons/links; retry panels; og:image base URL; admin tables;
time formats) · sidebar regression hiding "Audit log" (found by E2E).

## 6. Historical blocker reconciliation (none removed)

| # | Blocker | Previous | Current | New evidence | Remaining dependency | Closed? |
|---|---|---|---|---|---|---|
| 1 | Production worker-browser / runner image | BLOCKED (amd64 emulated) | **PARTIAL** | CI builds and publishes amd64 images; isolation 170/0 against the runner image in CI | Run the published digests in staging/production | No |
| 2 | Staging network isolation | BLOCKED | **BLOCKED** | — (no staging) | Staging cluster with an enforcing CNI | No |
| 3 | Narrow `wim_browser` | CODE RESOLVED | **CODE RESOLVED** | Live role: not superuser, no BYPASSRLS; browser checks ran live as `wim_browser` | Invariants on a staging DB; secret-manager provisioning | No |
| 4 | GitHub CI isolation job | BLOCKED | **RESOLVED** | Green runs incl. 43701390673 (isolation 170/0) | — | **Yes** |
| 5 | Third-party resource authorisation | CODE RESOLVED | **CODE RESOLVED** | Gateway/browser adversarial tests pass in CI | Staging gateway confirmation | No |
| 6 | Production `wim_scanner` credentials | BLOCKED | **PARTIAL** | Live login works with TLS; but passwords were set by hand and exposed; no secret manager | Secret manager + rotation | No |
| 7 | Production-limit load test | BLOCKED | **BLOCKED** | Local latency sample only | Production-like infrastructure | No |
| 8 | Dashboard polling / history load | BLOCKED | **BLOCKED** | Poll interval reduced 15 s → 5 s (3× request rate) — load assumption worsened | Production-like infrastructure | No |
| 9 | Functional-test side effects | OPEN | **OPEN — and enabled in live** | Mutating GETs demonstrated | Isolation mechanism or written risk acceptance; disable now | No |

**New blockers:** C-1 (until applied to live), H-1/H-2 live settings, H-3 credential rotation, workers on a laptop,
no backups/restore drill on the deployed database, no verified email provider.

## 7. Database, infrastructure, performance

* **Database:** migrations/schema/DB consistent (18 migrations, no drift); no runtime role is superuser/BYPASSRLS
  (local and live); RLS on 66 tenant tables (4 documented exceptions); audit hash chain intact (161 streams, 1 156 rows);
  uniqueness/idempotency constraints hold; 16 partitioned tables current. Gaps: C-1, forced RLS, retention purges,
  org deletion.
* **Infrastructure (deployed):** Render web services for API, web, admin, ingest; Postgres and Key Value in Virginia;
  **all background workers (scheduler, HTTP, deep scan, notify, browser runner/worker) run on the owner's laptop** in
  India — monitoring stops when it sleeps; ~250 ms per query made deep scans take ~10 min and required raised
  transaction limits. No Nginx config in the repo (DEPLOYMENT.md assumes one); no backup schedule or restore drill on
  the deployed database; email provider not configured (notifications are in-app only).
* **Performance:** only the local sample in §4; no production-capacity claim is made.

## 8. Billing (Phase 8) readiness

A billing core exists (plans/entitlements resolver, subscription state machine, Stripe/Razorpay adapters, webhook
signature/replay/idempotency, admin plans and gateways, customer billing page — 17 integration tests). **Not ready to
accept payments:** no gateway test-mode E2E (no keys), no dunning emails, no refunds/credit notes, no invoice PDFs,
GST place-of-supply and gapless numbering open (decision B4b), real prices open (decision B2), no downgrade
website-selection flow, no abuse/risk signals. Entitlement enforcement and usage accounting are reliable enough to
build on (usage reconciliation tests pass).

## 9. Production deployment recommendation

1. Today: apply C-1 to live, disable functional testing and billing, rotate exposed credentials (checklist "Immediately").
2. Move workers to an always-on Linux host near the database; add backups + a restore drill; configure email.
3. Fix F-1 and F-6 (with `sslmode=require` on every deployed DB URL first), F-4, HSTS.
4. Then operate as **limited production** for internal / approved websites.
5. Public paid launch only after blockers 1, 2, 6–9 are closed with staging/production evidence, Phase 8 is completed
   and tested in gateway test modes, and the dropped Phase 3 account features are built or formally de-scoped.
