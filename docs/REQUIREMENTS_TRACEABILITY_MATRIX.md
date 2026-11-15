# SiteSentinel — Requirements Traceability Matrix & Functional Audit

Generated 2026-11-15 by the RTM/functional workstream. Branch `stage` (HEAD `8ce5981` + uncommitted work of other workstreams). Scope: Phase 1 → Phase 4H plus early-delivered items (customer dashboard, Phase 8 billing core).

## 1. Summary

### 1.1 Completion

* **Denominator:** all 170 extracted requirements minus 3 justified N.A. (requirements superseded by a recorded decision) = **167**.
* **Complete (PASS only): 145/167 = 86.8 %.**
* PASS + PARTIAL: 156/167 = 93.4 %.
* Phases 1–4H only (excluding the early Phase 8 billing core): PASS 141/161 = 87.6 %; PASS+PARTIAL 152/161 = 94.4 %.
* PASS means verified at runtime in THIS audit (an integration test executed today against real Postgres/Redis/Mailpit/Chromium/egress gateway, an own runtime check against the local stack, or a read-only check of the running dev stack). Documentation-only evidence is never PASS.

### 1.2 Counts per status and phase

| Phase | PASS | PARTIAL | FAIL | BLOCKED | N.A. | Total |
|---|---|---|---|---|---|---|
| P1 | 5 | 3 | 0 | 0 | 0 | 8 |
| P2 | 26 | 2 | 4 | 0 | 0 | 32 |
| P3 | 27 | 1 | 1 | 0 | 1 | 30 |
| P4A | 2 | 2 | 0 | 1 | 1 | 6 |
| P4B | 9 | 0 | 0 | 0 | 0 | 9 |
| P4C | 11 | 0 | 0 | 0 | 1 | 12 |
| P4D | 9 | 1 | 0 | 1 | 0 | 11 |
| P4E | 16 | 0 | 0 | 0 | 0 | 16 |
| P4F | 10 | 0 | 0 | 1 | 0 | 11 |
| P4G | 16 | 1 | 0 | 1 | 0 | 18 |
| P4H | 10 | 1 | 0 | 0 | 0 | 11 |
| P8 | 4 | 0 | 1 | 1 | 0 | 6 |
| **All** | **145** | **11** | **6** | **5** | **3** | **170** |

### 1.3 How verification was done (exact commands, counts, durations)

**Integration tests (targeted files; isolated database).** The repo's harness drops and recreates `wim_test` in its global setup, which would have destroyed the concurrently running full-suite workstream's database. I therefore ran the *unmodified* test files through a scratchpad wrapper config (`scratchpad/vt/vitest.audit.config.ts`) that only swaps the database name (`wim_audit_test`, created by the repo's own `setup-test-db.mjs` with `TEST_DATABASE_NAME`), Redis db (3) and queue prefix. Command: `cd apps/api && npx vitest run --config <scratchpad>/vitest.audit.config.ts --reporter=verbose test/integration/<files>`.

| Batch | Files | Result | Duration |
|---|---|---|---|
| 1 | auth, mfa, orgs-rbac | **41/41 passed** | 176 s |
| 2 | websites, sdk-installation, transfers-admin, revalidation, tenant-isolation, admin, encryption, monitoring-api | **91/91 passed** | 181 s |
| 3 | http-monitoring, http-monitoring-api, dashboard-api, usage-config, billing, platform-ops | **82/82 passed** | 153 s |
| 4 | browser-monitoring, browser-monitoring-api, browser-components, performance, deep-scan, deep-scan-api, scheduler | **86/86 passed** | 423 s |
| 5 (after fix D1) | deep-scan (+1 new test), deep-scan-api | **23/23 passed** | 119 s |

Total: **300/300** existing integration tests in 24 files passed, 0 skipped, 0 failed; plus the new regression test. Not run (intentionally, load tests): `performance-load.test.ts` (2), `ops-load.test.ts` (4).

**Unit tests** (`npx vitest run` per package): core 290/290, netguard 56/56, queue 14/14, crypto 20/20, sdk 3/3, billing 17/17, email 8/8, logger 2/2, egress-gateway 34/34 → **444/444**.

**Own runtime checks** (`scratchpad/vt/rt.mjs`, `rt3.mjs`, `rt4.mjs`, Node fetch with cookie jar/CSRF/Origin like a browser; throwaway `audit-*@example.test` users; e-mails read from Mailpit `http://127.0.0.1:58025`). The dev API on :4000 returned `429 RATE_LIMITED` (retryAfterSec ≈ 3 096) for registration and for the review account's login, because every audit agent shares 127.0.0.1 and `TRUST_PROXY=false` (correct behaviour). To avoid touching the shared dev database's settings, I started the **same built artifacts** (`apps/api|ingest|worker-notify|worker-http/dist/main.js`) as an isolated instance — API :4100, ingest :4300, own throwaway DB `wim_rt_test`, Redis db 4, queue prefix `wimrt`, the dev egress gateway :8090 and real public DNS resolvers — and raised only that throwaway DB's per-IP auth limits. Results: rt.mjs **35/35**, rt3.mjs **18/19** (the 1 'fail' was my own expectation about error precedence with the platform switch off; behaviour is correct, see P4F-FUN-04), rt4.mjs **1/1** (functional-test switch turned on in the throwaway DB only). The instance, `wim_rt_test`, `wim_audit_test`, Redis dbs 3/4 and the throwaway key ring were removed afterwards.

**Dev stack (read-only):** admin API on :4000 (login with the review admin credentials from env file variables `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_TOTP_SECRET`): `/ops/health`, `/monitoring/health`, `/websites/stats`, `/ops/alerts`, `/ops/config`, `/overview` → 200; customer cookie on an admin route → 401. Dev database `wim` queried with `SET default_transaction_read_only = on`.

**Not re-executed in this workstream** (owned elsewhere or needs infrastructure): Playwright E2E, network-isolation suite (170 checks), DB invariants, Prisma drift, load harness, CI. These are PARTIAL or BLOCKED, never PASS.

## 2. Full matrix

Evidence keys: **IT** integration test executed in this audit · **RT** own runtime check (isolated local instance of the built stack) · **DEV** read-only check of the running dev stack · **UT** unit tests executed in this audit.

### P1 Architecture & database

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P1-ARCH-01 | Architecture/DB/API/Security/Deployment/Roadmap docs delivered | Docs exist and are maintained | docs/*.md | Doc read-through (this audit) | All 6 Phase-1 docs + PHASE4_PLAN, RELEASE_READINESS, BILLING, OPS runbook present; several stale passages (see §4) | **PARTIAL** | Stale statements: PHASE4_PLAN §17 says Phase 8 'not started' (billing core exists); API_DOCUMENTATION still lists Idempotency-Key/ETag/RateLimit headers that do not exist; setting descriptions say 'engine ships in Phase 4C/4D/4E' |
| P1-DB-01 | Prisma schema + SQL layer (partitions, RLS, partial uniques, audit chain, grants) apply cleanly | Migrations + SQL layer + seed apply to a fresh DB | packages/db/prisma, packages/db/sql/*.sql, scripts/setup-test-db.mjs | RT: setup-test-db.mjs created wim_audit_test (5×) and wim_rt_test from scratch | Applied cleanly every time ('seeded 22 permissions, 4 system roles, 140 new settings, 4 new example plans') | **PASS** | — |
| P1-DB-02 | Database invariants (tests/invariants.sql, groups 1–10 incl. 1b–1h) | All invariant groups pass on wim and wim_test | packages/db/tests/invariants.sql | Not re-executed in this workstream (owned by the full-suite/security workstream) | Documented as passing (RELEASE_READINESS §8, §12.5) | **PARTIAL** | Re-run invariants in the final regression run and attach output |
| P1-DB-03 | One live claim per domain identity (partial unique index), race-safe | Concurrent registrations → exactly one claim | 070_websites.sql register_domain_claim() | IT websites.test.ts 'is race-safe: 6 organizations registering the same domain concurrently → exactly one wins' | passed | **PASS** | — |
| P1-DB-04 | One logical result per execution (execution_results ledger, D-54) | Second result for same execution impossible | sql/100, @wim/incidents recordLedger | IT http-monitoring 'processing the same execution twice…'; browser-monitoring 'the same execution processed again…'; DEV dev DB: 0 executions with >1 check_results row (10 073 rows / 14 d) | passed; 0 duplicates in dev data | **PASS** | — |
| P1-DB-05 | Hash-chained, append-only audit log with verification | Tamper-evident chains; verify endpoint | sql audit_verify(), admin audit-logs/verify-chain | IT admin.test.ts 'verifies the platform audit chain'; auth.test.ts 'records security events in the user's hash-chained stream' | passed | **PASS** | — |
| P1-DB-06 | Partition maintenance + retention (14 d raw, rollups 62/400 d) actually runs | Scheduler creates/drops partitions; retention floors enforced | partitions.ensure_all/apply_retention; scheduler; ops retention | IT usage-config 'retention: floors protect audit…'; deep-scan 'retention (as wim_scanner)…' | passed | **PASS** | — |
| P1-DB-07 | Prisma drift: none | prisma migrate diff empty | packages/db | Not re-executed here | Documented empty (RELEASE_READINESS §8) | **PARTIAL** | Re-run in final regression |

### P2 Authentication & sessions

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P2-AUTH-01 | Registration, enumeration-safe (always 202) | 202 VERIFICATION_SENT for new and existing emails; owner gets 'sign-up attempt' notice | apps/api/src/auth/auth.service.ts | RT register new + duplicate; IT auth 'does not reveal whether an email is registered' | new=202, duplicate=202 identical body; 'Sign-up attempt for your account' email observed in Mailpit | **PASS** | — |
| P2-AUTH-02 | Email verification via single-use emailed link (24 h) | Verify succeeds once; reuse fails | auth.service, worker-notify (token issued at send time, D-26) | RT token from Mailpit (:58025) → verify 200, reuse 400; IT auth 'registers, emails a single-use verification link, and verifies' | 200 then 400 | **PASS** | — |
| P2-AUTH-03 | Password policy + current terms version | Weak password and stale terms refused | contracts RegisterInput, auth.service | RT weak pw → 400; stale termsVersion → 409; IT auth 'enforces the password policy and the current terms version' | 400 / 409 | **PASS** | — |
| P2-AUTH-04 | Opaque server session in HttpOnly SameSite=Lax cookie; no token in body (D-09) | Cookie wim_sid HttpOnly; SameSite=Lax; body has no token | auth.controller, session service | RT login → Set-Cookie wim_sid attrs Path=/,HttpOnly,SameSite=Lax; IT auth 'sets an HttpOnly, SameSite=Lax session cookie…' | as expected (Secure/__Host- only when COOKIE_SECURE=true — not exercised locally) | **PASS** | — |
| P2-AUTH-05 | Generic login error; progressive delay; attempts recorded | Unknown email and wrong password indistinguishable | auth.service | RT 401/UNAUTHENTICATED for both; IT auth 'uses one generic error…', 'applies a progressive delay…' | identical | **PASS** | — |
| P2-AUTH-06 | CSRF token + Origin check on every state change | Missing token or foreign Origin → 403 | common/csrf guard | RT logout without x-csrf-token → 403; foreign Origin → 403; IT auth 'rejects state-changing requests without a CSRF token…' | 403 / 403 | **PASS** | — |
| P2-AUTH-07 | Logout revokes server-side; copied cookie dies | Copied cookie → 401 after logout | session service + Redis cache purge | RT cloned cookie jar → /me 401 after logout; IT auth 'logout revokes the session server-side' | 401 | **PASS** | — |
| P2-AUTH-08 | Session list; revoke one; revoke others; effective next request | Revoked device → 401 on next request | auth.controller sessions | RT list (2 sessions) → DELETE other → other device /me 401; IT auth 'lists sessions and revokes another device immediately', "'sign out other sessions' keeps only the current one" | 204 then 401 | **PASS** | — |
| P2-AUTH-09 | Password reset: always 202, single-use 30-min link, revokes all sessions, keeps 2FA | as stated | auth.service, worker-notify | RT forgot 202 (known & unknown) → Mailpit 'Reset your password' → reset 204 → reuse 400 → old session 401 → old password 401; IT auth 'resets via a single-use emailed link…', mfa 'a password reset does not remove the second factor' | all as expected | **PASS** | — |
| P2-AUTH-10 | Change password requires current password; rotates/revokes sessions | as stated | auth.service | IT auth 'change password requires the current password…' | passed | **PASS** | — |
| P2-AUTH-11 | Rate limits on auth (per IP, per account, per session for 2FA) | 429 with Retry-After when exceeded | common/errors.ts RATE_LIMITED + settings | DEV dev API :4000 returned 429 RATE_LIMITED retryAfterSec=3096 to register and to the review login (shared 127.0.0.1 across audit agents); IT mfa 'rate-limits second-factor guesses per session', 'caps second-factor failures per account…' | enforced (Retry-After header set) | **PASS** | API_DOCUMENTATION §1.9 promises RateLimit-Limit/Remaining/Reset headers — not implemented (only Retry-After). Local reviewers sharing one IP get locked out; expected with TRUST_PROXY=false |

### P2 Two-factor authentication

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P2-MFA-01 | TOTP enrolment with encrypted secret; 10 recovery codes shown once | Wrong code rejected; confirm returns 10 codes | auth/mfa.service.ts, @wim/crypto totp | RT enroll 200 (otpauthUrl, secret, qrSvg) → wrong code 400 → confirm 200, 10 codes; IT mfa 'confirms with a valid code, returns 10 recovery codes, stores the secret encrypted…' | as expected | **PASS** | — |
| P2-MFA-02 | Login → partial session; only 2FA endpoints reachable; code replay refused; recovery code single-use | as stated | mfa.service | RT login → SECOND_FACTOR_REQUIRED; partial /me 401; TOTP verify 200; same code in a new partial session 400 (replay); recovery code 200 then reuse 400; IT mfa (4 tests) | as expected | **PASS** | — |
| P2-MFA-03 | Disable needs password + code; regenerate invalidates old codes | as stated | mfa.service | IT mfa 'disabling requires password and a current code', 'regenerating recovery codes invalidates the old set' | passed | **PASS** | — |
| P2-MFA-04 | Lost-device reset: password + email + 72 h wait + cancel link (D-28) | as stated | /auth/2fa/reset/* | IT mfa 'requires password + email confirmation + waiting period…', 'completes after the waiting period…', 'a fully signed-in user cannot use the lost-device flow' | passed | **PASS** | — |

### P2 Organizations, invitations, roles, tenancy

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P2-ORG-01 | Create org requires verified email; creator OWNER; per-org DEK; audited | 201 + OWNER | orgs.service | RT POST /orgs → 201; IT orgs-rbac 'requires a verified email…', 'creates an org with the caller as OWNER, a wrapped data key and an audit entry' | 201 | **PASS** | — |
| P2-ORG-02 | Invitation by email (token issued by worker, single use, addressed email only, resend rotates) | Preview → accept once; reuse fails | orgs.controller /invitations/*, worker-notify | RT invite 201 → Mailpit 'You're invited to …' → preview 200 → accept 200 → reuse 400; IT orgs-rbac 3 invitation tests | as expected | **PASS** | — |
| P2-ORG-03 | Org deletion request with grace period | 202 with scheduled date (purge job Phase 10) | orgs.service | RT POST /orgs/:o/deletion → 202 scheduledFor +14 d; IT websites 'deleting an org releases claims but keeps…' | 202 | **PARTIAL** | Actual purge/hard deletion is Phase 10 — not implemented (as documented) |
| P2-ORG-04 | Ownership transfer; last owner protected (API + DB) | as stated | orgs.service, DB deferred trigger | IT orgs-rbac 'an organization always keeps an owner (API and database)', 'transfers ownership…' | passed | **PASS** | — |
| P2-RBAC-01 | System roles enforced (viewer read-only, member cannot manage) | Viewer PATCH org → 403 | @wim/core rbac + guards + app_enter_org | RT viewer GET org 200, PATCH 403, viewer verify website 403; IT orgs-rbac 'viewers can read but not manage…' | as expected | **PASS** | — |
| P2-RBAC-02 | Custom roles: subset of creator's permissions, never owner-only (API + DB trigger), no escalation | Owner-only permission refused | orgs.service, D-25 triggers | RT custom role with org:delete → 403 FORBIDDEN; IT orgs-rbac 'custom roles…', 'the database refuses owner-only permissions…', 'prevents privilege escalation…' | as expected | **PASS** | — |
| P2-TEN-01 | Tenant isolation at API (404 to non-members) and DB (RLS, app_enter_org, D-23) | Every :orgId route 404 for non-member; RLS hides rows | guards, sql/060_identity.sql | RT outsider → org 404, websites 404; IT tenant-isolation 14 tests (auto-discovered route matrix) | passed | **PASS** | — |
| P2-ENC-01 | Envelope encryption; KEK + pepper outside DB; rotation by re-wrap (D-29) | No key material in DB; rotation keeps data | @wim/crypto, keys.service | IT encryption.test.ts 4/4; UT crypto 20/20 | passed | **PASS** | — |
| P2-SET-01 | DB-backed settings with hot reload (D-30) | Admin change visible without redeploy | SettingsService (30 s cache + Redis pub/sub) | IT admin 'rebrands globally without code changes; change visible immediately…' | passed | **PASS** | — |
| P2-LOG-01 | Log redaction (no secrets in logs) | Redaction test passes | @wim/logger | UT logger 2/2; IT scheduler 'no secrets in queue payloads…', http-monitoring 'results, logs and outbox events contain no credentials…' | passed | **PASS** | — |

### P2 Super Admin foundation

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P2-ADM-01 | Admin login single-step password + TOTP; separate cookie/origin/session (D-27) | Customer session refused on admin routes | admin.controller | DEV admin login on :4000 → 200; customer cookie on /api/admin/v1/ops/health → 401; IT admin 'requires password AND a valid TOTP code…', 'admin sessions use a separate SameSite=Strict cookie…' | as expected | **PASS** | — |
| P2-ADM-02 | Admin sees aggregates/metadata only (privacy; DB-role enforced) | No customer content | wim_admin grants, admin_v_* views | IT admin 'the admin database role cannot read customer content tables'; transfers-admin 'the admin database role still cannot read websites' telemetry…'; DEV /overview and /websites/stats return counts only | passed | **PASS** | — |
| P2-ADM-03 | Every admin mutation audited with reason | Audit entries | admin services | IT admin 'validates values, requires a reason…'; usage-config 'permissions, protected policies… audit with before/after' | passed | **PARTIAL** | Phase 9 exit criterion 'contract test across ALL admin routes' does not exist yet (only per-feature tests) |

### P2 Carried-forward gaps

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P2-GAP-01 | ESLint configured and run in CI (gap 'scheduled Phase 3') | lint task lints code | package.json 'lint': 'turbo run lint' | grep of every apps/*/packages/* package.json | No package defines a `lint` script and no ESLint config exists → `turbo run lint` is a no-op | **FAIL** | RELEASE_READINESS §8 'Build / typecheck / lint 46/46 tasks' overstates: zero lint tasks run. Configure ESLint (incl. security rules) or remove the claim |
| P2-GAP-02 | Org-level 'require 2FA for all members' (SECURITY §23: scheduled Phase 3) | Setting enforced at login/membership | — | grep apps/api/src, packages/core/src | Not implemented | **FAIL** | Silently dropped from Phase 3; re-plan or record as deferred |
| P2-GAP-03 | Email-address change flow (/me/email/change, 'planned Phase 3') | Verified change flow | — | route inventory of apps/api/src | Route absent | **FAIL** | Silently dropped from Phase 3 |
| P2-GAP-04 | Re-authentication window for destructive org actions ('Phase 3') | Recent re-auth required | — | grep 'reauth' | Not implemented (deletion of website needs typed domain only) | **FAIL** | Silently dropped from Phase 3 |

### P3 Website registration & domain identity

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-WEB-01 | Normalisation: scheme/www/case/port/path/query ignored; PSL incl. private suffixes; IDN → punycode | Preview returns one identity | @wim/core domain identity, POST websites/preview | RT 'HTTPS://WWW.<host>:443/shop?x=1#y' → identityKey=<host>; 'bücher-…' → xn--…; UT core 290/290; IT websites 'accepts internationalized domains…' | as expected | **PASS** | — |
| P3-WEB-02 | Reject IP literals, localhost, single-label, reserved TLDs, non-http(s), non-default ports | 400 INVALID_URL | core domain identity | RT 127.0.0.1, localhost, intranet, foo.test, [::1], ftp://, :8443 → all 400 INVALID_URL; IT websites 'rejects invalid, internal and IP addresses…' | all refused | **PASS** | — |
| P3-WEB-03 | Register → PENDING_VERIFICATION claim (72 h), token, site key, audit | 201 with instructions | websites.service, register_domain_claim() | RT 201 status=PENDING_VERIFICATION claim=PENDING; IT websites 'normalizes the URL, creates a pending claim with a 72 h window…' | 201 | **PASS** | — |
| P3-WEB-04 | Duplicate-domain prevention: same org CONFLICT; other org DOMAIN_ALREADY_REGISTERED without owner info; www/scheme variants | 409 both, no owner details | register_domain_claim (advisory lock + partial unique) | RT same org http://www.<host>/x → 409 CONFLICT; other org → 409 DOMAIN_ALREADY_REGISTERED, body contains no owner email/org; IT websites 'rejects duplicates…', race test | as expected | **PASS** | — |
| P3-WEB-05 | Unverified-website limit per org; registration attempts logged | Limit enforced | settings + register_domain_claim | IT websites 'limits how many unverified websites an org may hold'; transfers-admin admin stats | passed | **PASS** | — |
| P3-WEB-06 | Deletion requires typed domain + website:delete; releases claim; history kept | Wrong host refused; other org can re-register | archive_website() | RT confirmHost wrong → 409, correct → 204, other org registers same domain → 201; IT sdk-installation 'deletion requires the typed domain…' | as expected | **PASS** | — |
| P3-WEB-07 | Edit details audited with diff; registration history; audit list | Audited | websites.controller | RT PATCH name → 200; /audit lists entry with new name; /registration-history 200; IT sdk-installation 'edits details with an audited diff…' | as expected | **PASS** | — |
| P3-WEB-08 | ROOT_EXCLUSIVE default policy (B7) incl. subdomain reservation | DNS-verified root reserves subdomains | 070_websites.sql | IT websites 'ROOT_EXCLUSIVE: a DNS-verified root reserves subdomains…' | passed | **PASS** | SUBDOMAIN_INDEPENDENT policy path not covered by a test seen in this audit; B7 still an open business decision |

### P3 Ownership verification

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-VER-01 | DNS TXT verification via explicit public resolvers; exact value; activates trial | VERIFIED only with exact record | apps/worker-http verify, DNS_RESOLVERS | IT websites 'DNS TXT: verifies, activates a 30-day trial, records history and audit' (fixture DNS server); RT real resolvers via gateway :8090 for an unpublished record → FAILED DNS_RECORD_NOT_FOUND (no false verify) | positive path proven only with fixture DNS (no real DNS zone available); negative path proven live | **PASS** | Positive verification against a real public DNS zone needs a controlled domain (staging) — BLOCKED there |
| P3-VER-02 | HTML file at /.well-known/<prefix>-verification.txt (exact line, 200; echoing 404 doesn't count) | as stated | worker-http | IT websites 'HTML file: requires the exact value…'; RT unresolvable host → FAILED HOST_NOT_FOUND | Local fixture site cannot be used at runtime: netguard/gateway refuse loopback/private targets outside NODE_ENV=test (by design) | **PASS** | — |
| P3-VER-03 | HTML <meta> in <head>, parsed without script execution | as stated | worker-http | IT websites 'HTML meta tag: must be in <head>…' | passed | **PASS** | — |
| P3-VER-04 | A merely responding site never verifies | 200 without token ≠ verified | worker-http | IT websites 'a site that simply responds 200 is never verified' | passed | **PASS** | — |
| P3-VER-05 | Token regeneration invalidates old proof; expiry not extended; stale jobs fail TOKEN_ROTATED (D-33) | as stated | regenerate_claim_token() | RT regenerate → new token, claim.expiresAt unchanged; IT websites 'regenerating the token invalidates the old proof' | as expected | **PASS** | — |
| P3-VER-06 | Pending expiry 72 h; restart only while free; attempt limits/brute-force | as stated | restart_website_claim, reserve_verification_attempt | IT websites 'expired claims cannot be verified…', 'restart issues…', 'limits verification attempts…', 'per-token attempt budget…' | passed | **PASS** | — |
| P3-VER-07 | Only the worker can mark VERIFIED; API role cannot (D-32/D-33) | DB refuses | grants | IT websites 'the API role cannot mark claims verified…' | passed | **PASS** | — |
| P3-VER-08 | SSRF-safe verification fetches (metadata, private, mixed answers, redirects off-site, rebinding) | Never contacted | @wim/netguard + gateway | IT websites 3 SSRF tests; UT netguard 56/56, gateway 34/34 | passed | **PASS** | — |
| P3-VER-09 | ARCH §11.5 'SDK beacon' as a 4th verification method; meta 'falls back to T2 for SPAs' | — | — | API contract: methods DNS_TXT\|WELL_KNOWN_FILE\|HTML_META\|ANY | Not implemented: replaced by D-37 (SDK is installation status, never ownership proof) and D-34 (meta via HTML parser, no script execution) | **N.A.** | Changed by documented decision (justified: telemetry Origin is forgeable) |

### P3 Trial activation & domain ledger

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-TRIAL-01 | 30-day trial (no card) at first verified website; race-safe (D-36) | Trial row + ledger consumed | @wim/core decideTrial, worker-http | IT websites 'DNS TXT: verifies, activates a 30-day trial…'; DEV admin websites/stats trials.activatedTotal=162, domainsConsumed=45 | passed | **PASS** | — |
| P3-TRIAL-02 | Second domain in a trialing org covered and marked consumed | as stated | decideTrial | IT websites 'a second verified domain in a trialing org…' | passed | **PASS** | — |
| P3-TRIAL-03 | Delete account/website → new account → same domain → no trial (ledger survives deletion) | No new trial | domain_trial_ledger | IT websites 'deleting a website and re-adding the domain from a brand-new account never grants a new trial'; billing 'trial uses the trial plan's entitlements; delete account → new account → same domain → no trial' | passed | **PASS** | — |
| P3-TRIAL-04 | Hashed abuse signals / risk score (ARCH §12.4–12.5) | Secondary signals evaluated | — | BILLING.md 'Not done' | Not implemented | **FAIL** | Explicitly listed as not done (Phase 8 partial) — not a silent drop, but a Phase-1 requirement still open |

### P3 SDK & ingest

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-SDK-01 | SDK served versioned (major alias 5-min cache, immutable exact versions, SRI) | 200 JS with cache headers | apps/ingest, @wim/sdk | RT ingest :4300 /sdk/monitor.v1.js → 200 application/javascript, cache-control public,max-age=300, 6 731 bytes; IT sdk-installation 'serves versioned SDK with integrity metadata and caching'; UT sdk 3/3 | as expected | **PASS** | — |
| P3-SDK-02 | Remote config only for verified websites with live key; never secrets | Unverified → {enabled:false} | ingest | RT key of an unverified website → {v:1,enabled:false,heartbeat:false}; IT sdk-installation 'returns configuration only for verified websites…' | as expected | **PASS** | — |
| P3-SDK-03 | Collect always 204 (no oracle); heartbeat validation by Origin; replay counted once; spoofing → INVALID_CONFIGURATION | as stated | ingest + ingest_* definer functions (wim_ingest has no table privileges, D-38) | RT valid key/garbage/unknown key → 204/204/204; unverified site stays NOT_INSTALLED; IT sdk-installation 'NOT_INSTALLED → DETECTED → ACTIVE only with heartbeats from the registered origin', 'replayed heartbeats…', 'SDK spoofing…', 'unverified websites cannot become installed', 'invalid site keys…', 'becomes INACTIVE when heartbeats stop' | as expected | **PASS** | — |
| P3-SDK-04 | Key regenerate (24 h grace) / revoke (immediate, snippet hidden; ≤15 s) | as stated | websites.service, ingest lookup cache | RT regenerate → new pk_; revoke → key absent from detail; IT sdk-installation 'regenerate: old key keeps working only during the grace period; revoke: stops immediately' | as expected | **PASS** | — |
| P3-SDK-05 | Telemetry pause/resume; strict SDK config schema; sanitised events only | Unknown capture option → 400 | contracts, ingest | RT pause 200, resume 200, captureErrors 200, captureFormValues → 400; IT sdk-installation 'stores sanitised events only, drops replays, honours pause/resume', 'SDK configuration is validated…' | as expected | **PASS** | — |
| P3-SDK-06 | Server-side installation check (diagnostic only, SSRF-safe) | Diagnostic; refused before verification | websites.service + worker-http | RT unverified → 409 'Verify ownership before checking the installation'; IT sdk-installation 'the server-side installation check finds the script tag…' | as expected | **PASS** | — |
| P3-SDK-07 | SDK privacy (no form values/cookies/storage; consent; GPC) | Static test passes | packages/sdk | UT sdk 3/3 (static source test) | passed | **PASS** | Consent/GPC behaviour in a real browser verified only by the Phase 3 E2E (not re-run here) |

### P3 Transfers

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-XFER-01 | Transfer only against another org's VERIFIED claim; requester DNS proof; owner notified anonymously, may contest; admin decides with reason; no data moves (D-40) | as stated | websites.service, worker-http, admin transfers | RT transfer against a non-verified/own claim → 409; IT transfers-admin 7/7 (approve, reject, contest, API role cannot write transfer state, stats) | passed | **PASS** | Fast-path auto-approval for LAPSED claims (ARCH §11.6) not observed in tests |

### P3 Responsive UI (customer)

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P3-UI-01 | No horizontal overflow at 1366/375 px (Phase 3 check) | No overflow | apps/web | Not re-executed here (owned by UX workstream) | Documented screenshots .playwright-mcp/phase3-* | **PARTIAL** | Re-verify in UX audit |

### P4A Network isolation & revalidation

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4A-NET-01 | Egress gateway: capability tokens, public-only destinations, pinned DNS, port allow-list, per-org caps (D-41) | Forged/expired/host-mismatched tokens refused; private targets refused | apps/egress-gateway, @wim/netguard | UT gateway 34/34, netguard 56/56; IT http-monitoring 'gateway credentials: expired, forged and host-bound tokens are refused…', 'refuses private, IPv6, mapped, metadata…', 'DNS rebinding…' | passed | **PASS** | — |
| P4A-NET-02 | Container-level isolation proof (170 checks) incl. production runner image | 0 violations | infra/security/run-isolation-tests.sh | Not re-executed here (Docker topology; security workstream) | Documented: 170/0 arm64 LR; CI run 43591319838 green on native amd64 (RELEASE_READINESS) | **PARTIAL** | Staging probe run (blocker 2) — BLOCKED: needs staging cluster with enforcing CNI |
| P4A-NET-03 | Isolation enforced in staging/production network (NetworkPolicies) | Probe report from deployed staging | infra/staging/* | — | Not executable: no staging environment | **BLOCKED** | Needs staging cluster (amd64, Calico/Cilium, IMDS blocked), registry, secret manager |
| P4A-NET-04 | Workers fail closed: no gateway in production → refuse start; test allowances refused outside NODE_ENV=test (D-45) | Refuse to start | worker-http index, gateway | IT browser-monitoring 'the runner holds no signing secret…'; platform-ops 'worker-notify refuses to start in production without fallback alert recipients' | partially covered (gateway/test-allowance refusal documented, not re-run here) | **PARTIAL** | No test seen in this audit asserting worker-http refuses production start without EGRESS_GATEWAY_URL |
| P4A-REV-01 | Ownership revalidation OK→FAILING→LAPSED→RELEASED with grace, original method, transient ≠ definitive (D-44) | as stated | @wim/core revalidation, worker-http, sweep | IT revalidation.test.ts 9/9 (healthy re-confirm, SERVFAIL never advances, FAILING→LAPSED→restored, release archives, file method, sweep leasing, concurrency, gateway-down not counted, attributed traffic) | passed | **PASS** | — |
| P4A-REV-02 | ARCH §11.5: weekly re-check, LAPSED after 14 d, LAPSED limited to T1 | — | settings revalidation.* | Settings registry; scheduler test | Changed by D-44: 24 h interval, 72 h grace, release 30 d; LAPSED websites get NO executions (scheduler 'paused/archived/lapsed websites… get no executions') | **N.A.** | Documented change (stricter); keep ARCH §11.5 text in sync |

### P4B Scheduler & queues

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4B-SCH-01 | One schedule per website×tier; default intervals; disabled tiers schedule nothing | as stated | apps/scheduler, @wim/core scheduling | IT scheduler 'creates one schedule per website and tier…' | passed | **PASS** | — |
| P4B-SCH-02 | Exactly one execution per window (DB unique), 5 concurrent schedulers, missed windows counted not back-filled (D-46) | No duplicates | sql/080, scheduler | IT scheduler 'five scheduler instances…', 'the database rejects a second execution…', 'after downtime, missed windows are counted…' | passed | **PASS** | — |
| P4B-SCH-03 | Crash/Redis-loss recovery: reconcile re-enqueues; lease expiry recovers SIGKILLed work | No lost or duplicated work | @wim/queue runtime | IT scheduler 'crash after commit, before enqueue…', 'Redis interruption…', 'worker killed mid-execution (SIGKILL)…' | passed | **PASS** | — |
| P4B-SCH-04 | Fairness: per-cycle quota, per-org + global concurrency, backpressure (D-48) | Large tenant cannot starve small | scheduler, semaphores | IT scheduler 4 fairness/concurrency tests | passed | **PASS** | — |
| P4B-SCH-05 | Eligibility re-check at execution; forged/mistyped payloads rejected, never retried; id-only payloads | as stated | @wim/queue | IT scheduler 'rejects forged, malformed, mistyped and cross-queue jobs…', 'eligibility is re-checked at execution time…', 'no secrets in queue payloads…' | passed | **PASS** | — |
| P4B-SCH-06 | Retries with backoff → DLQ → audited single-use admin replay (never security failures) | as stated | queue + admin monitoring | IT monitoring-api 'replay requires admin:monitoring:replay, audited, single-use…'; scheduler DLQ tests; DEV admin /monitoring/health shows dead-letter counts | passed | **PASS** | — |
| P4B-MON-01 | Customer pause/resume monitoring (cancels queued work), cancel execution, viewers read-only | as stated | websites.controller monitoring/pause, cancel | IT monitoring-api 'pause cancels queued work immediately…', 'cancels a queued execution…', 'shows schedules…; viewers read but cannot pause'; RT pause on an unverified website → 409, schedules [] | passed | **PASS** | — |
| P4B-MON-02 | Admin monitoring health aggregate-only (no domains/identifiers) | No customer identifiers | admin monitoring/health | IT monitoring-api 'health is aggregate-only…'; DEV /api/admin/v1/monitoring/health returns queue/tier aggregates only | as expected | **PASS** | — |
| P4B-USE-01 | Usage accounted per org and monitoring type | Counters written once | @wim/queue usage | IT scheduler 'usage is accounted per organisation and monitoring type' | passed | **PASS** | — |

### P4C HTTP availability monitoring

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4C-HTTP-01 | Gateway-only probe with real DNS/connect/TLS/TTFB/total timings; HEAD→GET; bounded body (D-50) | Timings measured, null when not measured | @wim/netguard probe, worker-http | IT http-monitoring 'evaluates healthy, redirect, auth, client/server error, timeout, DNS and content scenarios'; DEV dev DB: 10 073 check_results in 14 d, dns_ms on 9 569, tls_ms on 9 544, p50 total 24 ms | passed; real timings persisted on dev stack | **PASS** | — |
| P4C-HTTP-02 | Redirect handling: manual, limit, loop detection, every hop re-validated | as stated | probe | IT http-monitoring scenarios + 'refuses … redirects to internal targets'; DEV 12 redirected results persisted | passed | **PASS** | — |
| P4C-HTTP-03 | Content marker + expected content type; expected status (default 2xx+401+403); config validated (path only), audited | as stated | core monitoring/http, monitoring.controller PUT config | IT http-monitoring scenarios; http-monitoring-api 'validates configuration: path only (never a host)…' | passed | **PASS** | — |
| P4C-HTTP-04 | TLS facts and warnings: invalid, expired, self-signed, wrong host, expiring (sslWarningDays) | Classified; SSL incident | worker-http | IT http-monitoring 'collects TLS facts and detects invalid, expired, self-signed, wrong-host and expiring certificates'; DEV 13 TLS_INVALID results, 3 SSL incidents OPEN | passed | **PASS** | — |
| P4C-HTTP-05 | Incidents: threshold to open, grouping, recovery after K passes, reopen; per-class fingerprints (D-52) | One incident per outage | @wim/incidents, core | IT http-monitoring 'opens after the failure threshold, groups repeats, resolves after recovery, reopens, and emits each event once', 'an isolated transient failure does not open an incident…', 'per-website thresholds…' | passed | **PASS** | — |
| P4C-HTTP-06 | Inconclusive (our gateway/resolver down) never opens/resolves; excluded from uptime; canary distinguishes resolver outage | as stated | worker-http canary + circuit | IT http-monitoring 'gateway unavailable: retried, then recorded INCONCLUSIVE, excluded from uptime, no incident…', 'resolver outage…', 'a worker whose gateway credential is rejected…' | passed | **PASS** | — |
| P4C-HTTP-07 | Idempotency: re-processing an execution changes nothing; SIGKILL before/after persist; Redis loss | as stated | persist.ts (ledger gate) | IT http-monitoring 'processing the same execution twice…', 2 SIGKILL crash tests, 'Redis loses the queue…' | passed | **PASS** | — |
| P4C-HTTP-08 | Uptime with coverage from one authoritative calculation (D-71) | uptimePercent null without data; coverage reported | uptimeFrom | IT http-monitoring-api 'reports real persisted state…uptime with coverage…'; dashboard-api 'overview, analytics and the HTTP summary agree…' | passed | **PASS** | — |
| P4C-HTTP-09 | 60 s default interval; stored config never speeds/slows silently | as stated | core scheduling | IT http-monitoring 'a stored HTTP configuration never changes the interval…' | passed | **PASS** | — |
| P4C-NOT-01 | One outage email + one recovery email per incident (outbox, D-53); notification failure never fails monitoring | as stated | outbox relay, worker-notify | IT http-monitoring-api 'one outage email and one recovery email per incident…', 'no recovery email when the outage was never notified…', 'a notification failure never fails monitoring…' | passed (Mailpit) | **PASS** | — |
| P4C-HTTP-10 | ARCH G1: confirm a failure with an immediate retry before failing a check | Retry-confirmed failures | — | check_results.confirmed in dev DB | Not implemented as specified: 0 of 10 073 rows have confirmed=true; replaced by consecutive-failure thresholds (D-52) | **N.A.** | Changed requirement; the `confirmed` column is dead — document or remove |
| P4C-HTTP-11 | Monitoring default OFF platform-wide (monitoring.http.enabled=false) | Disabled after deploy | settings registry | DEV dev DB settings: http=false, browser=false, functional=false | as expected | **PASS** | — |

### P4D Browser monitoring

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4D-BR-01 | Browser jobs only with platform switch AND org entitlement AND website not opted out | as stated | scheduler + resolver | IT browser-monitoring 'browser jobs only with the platform switch AND an org entitlement…' | passed | **PASS** | — |
| P4D-BR-02 | Navigation/readiness (no networkidle reliance), blank page, JS errors grouped, failed requests, broken images, layout | Each fault classified | apps/worker-browser engine | IT browser-monitoring 'navigation, rendering, JavaScript, network, layout and synthetic performance' | passed (real Chromium via runner + gateway) | **PASS** | — |
| P4D-BR-03 | Synthetic FCP/LCP/CLS/TBT/TTFB/load; never INP (D-58) | source=SYNTHETIC | worker-browser | IT same test; browser-monitoring-api 'summary and history are real persisted results, labelled synthetic…' | passed | **PASS** | — |
| P4D-BR-04 | Viewports: presets, rotation within per-run cap; responsive failures only where they occur | as stated | core browser policy | IT browser-monitoring 'viewports: rotation within the per-run cap…' | passed | **PASS** | — |
| P4D-BR-05 | Screenshots: failure-only default, masking (inputs/iframes/selectors), private S3, per-org daily quota, 14-d retention | as stated | worker-browser, @wim/storage | IT browser-monitoring 'screenshot quota…', 'storage outage: the check is recorded without its screenshot…' | passed | **PASS** | Masking correctness is asserted by the suite's fixture pages only; no pixel-level review in this audit |
| P4D-BR-06 | Signed screenshot access: 5-min HMAC link, RLS re-check, tampered/expired/cross-tenant refused, expired → 410 | as stated | browser.controller artifacts/link + artifact-downloads | IT browser-monitoring-api 'screenshots: short-lived signed links…', 'expired screenshots are 410 not 404' | passed | **PASS** | — |
| P4D-BR-07 | Malicious page cannot reach loopback/private/metadata/file:/internal WS; forged capabilities get nothing | as stated | browser-runner + gateway | IT browser-monitoring 'a malicious page can't reach loopback…', 'forged, expired and wrong-secret capabilities…', 'the runner holds no signing secret…' | passed | **PASS** | — |
| P4D-BR-08 | Incidents (blank page etc.) threshold/group/recover; idempotent; crash/cancel/shutdown safe; infra outages ≠ customer outage | as stated | worker-browser + @wim/incidents | IT browser-monitoring 9 lifecycle/crash/outage tests; browser-monitoring-api 'browser incident: one email when it opens, one when it recovers' | passed | **PASS** | — |
| P4D-BR-09 | Least-privilege wim_browser role (blocker 3, D-100) | worker-browser runs as wim_browser | sql/160_browser_role.sql | IT browser suites run as wim_browser (helpers/browser-monitoring.ts); browser-components 'functional rows need the execution's ledger row…; the customer role can only read' | passed locally | **PARTIAL** | Production login via secret manager + invariants on staging DB — BLOCKED (no staging/secret manager) |
| P4D-BR-10 | Third-party policy signed into capability and enforced by gateway (blocker 5, D-99) | all/allowlist/none enforced for every resource type | netguard gateway, worker-browser | IT browser-components 'release readiness (blocker 5): the gateway enforces the website's third-party policy…' | passed | **PASS** | Staging gateway confirmation outstanding |
| P4D-BR-11 | Production browser-runner / worker-browser images (blocker 1) | CI-built amd64 images pass isolation | infra/docker/*, CI | Not re-executed here | Documented: CI-published digests @ 7308a75; staging run outstanding | **BLOCKED** | Staging execution of the published digests |

### P4E Deep scan

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4E-DS-01 | Off by default; only entitled org + platform switch; paused websites excluded (D-68) | as stated | settings + scheduler | IT deep-scan 'only an entitled organisation with the platform switch on gets scans…'; RT manual start on ineligible website → 409 | passed | **PASS** | — |
| P4E-DS-02 | robots.txt + nested sitemaps (index, ≤20, depth ≤3, loops, size caps, no ENTITY), crawl in scope only | as stated | worker-deepscan engine | IT deep-scan 'discovers via robots + nested sitemaps, crawls only in scope…', 'sitemap problems: invalid XML, index loops, oversized sitemaps…' | passed | **PASS** | — |
| P4E-DS-03 | Limits: pages/depth/requests/bytes/duration/daily quota; customers can only lower | Effective limits capped | core deepscan limits | IT deep-scan 'a PARTIAL scan (daily quota)…'; deep-scan-api 'configuration is validated…'; DEV dev DB has PARTIAL/DAILY_QUOTA and COMPLETED/PAGE_LIMIT(complete=false) scans | passed | **PASS** | — |
| P4E-DS-04 | URL normalisation (tracking/sensitive params removed, query modes), scope = verified host (+verified additionalHosts) | as stated | core normalizeUrl, scope | UT core 290/290 (deepscan normalisation tests); IT deep-scan-api 'additional hosts must be separately verified websites of the same organisation' | passed | **PASS** | — |
| P4E-DS-05 | Trap guards (≤50 URLs per numeric template, ≤20 query variants) | Traps bounded | engine pathTemplate | IT deep-scan 'discovers via robots…' fixture includes traps; UT core | passed | **PASS** | No dedicated named trap test seen; covered inside the discovery test |
| P4E-DS-06 | Destructive/unsafe routes never requested (logout, delete, cart, admin, action query strings) (D-64) | Never fetched | core unsafe-route policy | IT deep-scan discovery test (fixture tripwires); UT core | passed | **PASS** | — |
| P4E-DS-07 | SEO, structure, automated a11y findings (labelled automated, not WCAG); forms/search health | Findings with evidence | finalize.ts + html.ts | IT deep-scan 'discovers … and records grouped findings'; deep-scan-api 'manual start, history, coverage, pages, findings…' | passed | **PASS** | — |
| P4E-DS-08 | Partial scans never resolve findings or report removed pages (D-65) | RESOLVED only from COMPLETED | finalize.ts | IT deep-scan 'a PARTIAL scan (daily quota) never resolves findings…'; DEV dev DB: 0 RESOLVED finding events from non-COMPLETED scans (5 RESOLVED total) | passed | **PASS** | — |
| P4E-DS-09 | Findings grouped; one incident per group; inconclusive scans never advance incidents | as stated | finalize.ts incidents block | DEV dev DB: 3 deep-scan incident occurrences linked to INCONCLUSIVE ledger rows (2× NO_PAGE_REACHABLE on 2026-11-14/15, 1× INFRASTRUCTURE 2026-11-13); new IT deep-scan 'a scan that reaches no page adds no occurrence to (and never reopens) an open finding-group incident' — FAILED on the original code, PASSES with the fix | DEFECT found and fixed (see §6 D1) | **PASS** | Fixed in this audit; dev-DB rows created before the fix remain (not repaired) |
| P4E-DS-10 | Gateway failure never becomes customer's broken pages; NO_PAGE_REACHABLE → INCONCLUSIVE (D-66) | as stated | engine + finalize | IT deep-scan 'gateway outage…INCONCLUSIVE', 'gateway dying MID-REQUEST…', 'IPv4-mapped IPv6 and private AAAA answers are refused…' | passed | **PASS** | — |
| P4E-DS-11 | Resumable crawl (SIGKILL), idempotent finalisation, cancellation keeps partial data, one RUNNING scan per site | as stated | deep_scan_urls frontier, ledger | IT deep-scan 4 crash/cancel/concurrency tests; deep-scan-api 'pause stops scheduling and cancels a running scan…' | passed | **PASS** | — |
| P4E-DS-12 | Comparison with previous complete scan / any scan (reliable only if both COMPLETED) | as stated | finalize comparison, compare endpoint | IT deep-scan 'fixing a broken link resolves its finding… comparison shows the recovery'; deep-scan-api | passed | **PASS** | — |
| P4E-DS-13 | Usage: pages/bytes/requests/scans + failed-attempt overhead (not billable) | as stated | finalize usage | IT deep-scan 'gateway outage…' asserts deepscan.failed_attempts=2; deep-scan-api usage | passed | **PASS** | — |
| P4E-DS-14 | Narrow wim_scanner role (D-69); tightened in RR (invariant 1h) | No access outside its tables | sql/110, sql/170 | IT deep-scan 'the scanner's database role can't read other tables…', retention test as wim_scanner | passed | **PASS** | Production credential provisioning (blocker 6) — BLOCKED |
| P4E-DS-15 | Browser-assisted SPA discovery (entitled) through runner + gateway | SPA routes found only when entitled | engine | IT deep-scan 'SPA routes rendered by JavaScript are found only with (entitled) browser-assisted discovery' | passed | **PASS** | — |
| P4E-DS-16 | External links (entitled+enabled) status-only via gateway; IP-literal links never requested | as stated | engine | IT deep-scan 'external links (entitled + enabled)…' | passed | **PASS** | — |

### 4G (delivered early) Customer dashboard

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4G-DASH-01 | Organisation overview: per-website health with reasons; never healthy on thin data (D-72) | NOT_VERIFIED/NO_DATA/INCONCLUSIVE explicit | dashboard.controller | RT unverified site → health NOT_VERIFIED, reason 'Website ownership is not verified', uptimePercent null; IT dashboard-api 'empty organisation: no fabricated numbers', 'thin data never shows as healthy…' | as expected | **PASS** | — |
| P4G-DASH-02 | HTTP analytics (uptime, coverage, downtime, buckets, status distribution) | Matches summary | dashboard.controller analytics | IT dashboard-api 'overview, analytics and the HTTP summary agree…' | passed | **PASS** | — |
| P4G-DASH-03 | Incident list filters + keyset pagination; detail with timeline/occurrences/delivery summary | as stated | monitoring.controller incidents | IT dashboard-api 'filters and keyset pagination over many incidents' | passed | **PASS** | — |
| P4G-DASH-04 | Acknowledge only (definer fn), idempotent, audited, never resolves (D-73) | as stated | acknowledge_incident() | IT dashboard-api 'acknowledge: authorised, audited, idempotent, never resolves; the engine still recovers it' | passed | **PASS** | — |
| P4G-DASH-05 | Unified history (read-time merge, D-76) with pagination | as stated | dashboard.controller history | IT dashboard-api 'history merges persisted checks…' | passed | **PASS** | — |
| P4G-DASH-06 | Per-tier schedule: can only slow down; audited; CSRF + monitoring:write | Faster than plan → 400 | dashboard.controller schedule | RT httpIntervalSec=1 → 400 VALIDATION_FAILED; IT dashboard-api 'schedule: can only slow a tier down…' | as expected | **PASS** | — |
| P4G-DASH-07 | Usage & plan limits page from entitlement system; warnings ≥80 %; customers can't write counters | as stated | dashboard.controller usage | RT /monitoring/usage 200 with limits from resolver; IT dashboard-api 'usage: real counters and limits…' | as expected | **PASS** | — |
| P4G-DASH-08 | In-app notifications, per-user read state, per-channel preferences (D-74) | as stated | notifications.controller, worker-notify | IT dashboard-api 'in-app notifications from the real worker…' | passed | **PASS** | — |
| P4G-DASH-09 | Live updates via authenticated change feed (≤15 s), kinds only, cursor overlap (D-70) | as stated | dashboard.controller changes | IT dashboard-api 'change feed: kinds only, scoped to the tenant and user, cursor-based with overlap' | passed | **PASS** | D-15 realtime WebSocket service replaced by polling (documented change); Phase 7 exit 'critical incident reaches dashboard <3 s p95' not met by design (≤15 s) |
| P4G-DASH-10 | Every dashboard endpoint tenant-isolated; admin aggregates only | 404 cross-tenant | RLS | IT dashboard-api 'every Phase 4F endpoint refuses other tenants…', 'Super Admin: aggregate outcomes…' | passed | **PASS** | — |
| P4G-DASH-11 | Dashboard E2E (Playwright phase4f/4g/4h specs, desktop/mobile/tablet) | Specs pass against prod builds | tests/e2e/*.spec.ts | Not re-executed here | Documented 4G 4/4, 4H 4/4, Phase 2/3 5/5 (RELEASE_READINESS §8) | **PARTIAL** | Re-run E2E in the final regression run |

### P4F Components, functional tests, responsive

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4F-CMP-01 | Component detection (17 types), structural identity, dedupe; second run adds nothing (D-77/78) | Stable inventory | core components, worker-browser | IT browser-components 'detects the page's components with stable identity…'; UT core components tests | passed | **PASS** | — |
| P4F-CMP-02 | Lifecycle: CHANGED/REMOVED (only after 2 complete runs)/RESTORED; failed load never removes (D-79) | as stated | component_events | IT browser-components 'changes, removals (after two complete runs only) and restorations…' | passed | **PASS** | — |
| P4F-CMP-03 | Components API + history, tenant-isolated; customer role read-only | as stated | browser.controller components | IT browser-monitoring-api 'Phase 4F: components, component history, functional and responsive results…'; browser-components ledger/tenancy test | passed | **PASS** | — |
| P4F-FUN-01 | Safe functional tests: search, navigation, non-submitting form validation, safe buttons; destructive controls skipped and never reached | Tripwires never hit | worker-browser interact.ts, core classifyAction | IT browser-components 'search, navigation, forms (never submitted) and safe buttons pass; every destructive control is skipped and never reached' | passed | **PASS** | — |
| P4F-FUN-02 | Broken search/nav/form/button → FAILED and functional incident | as stated | worker-browser | IT browser-components 'broken search, a broken navigation link…all FAIL — and open a functional incident' | passed | **PASS** | — |
| P4F-FUN-03 | Guard: non-GET aborted; deny-listed URLs (any type/frame) and third-party scripted calls blocked (D-80, D-90) | Nothing sent | observe.ts request guard | IT browser-components 'Phase 4G: a safe-looking toggle whose handler fires side-effecting GETs is caught…' | passed | **PASS** | — |
| P4F-FUN-04 | Three keys: website opt-in + platform switch (default off, protected) + customer risk acknowledgement; allowedPaths mandatory (D-98, D-101) | as stated | browser.controller PUT config | RT switch OFF: enable → 409 FEATURE_UNAVAILABLE; switch ON (throwaway DB only): no ack → 400 RISK_ACKNOWLEDGEMENT_REQUIRED, no allowedPaths → 400 VALIDATION_FAILED, client-supplied riskAcknowledgement → 400, valid → 200; IT browser-components 'Phase 4H: no interaction without the platform switch AND the customer's risk acknowledgement…', 'release readiness (blocker 9)…' | as expected | **PASS** | — |
| P4F-FUN-05 | First-party GET side effects technically prevented (blocker 9) | Isolation or accepted risk | — | RELEASE_READINESS §13 | OPEN — no technical control proves a GET harmless; feature unsupported for production, default off | **BLOCKED** | Needs product-owner written risk acceptance or a staging-URL isolation feature |
| P4F-FUN-06 | Attribution: gateway refusals/budgets → SKIPPED/INCONCLUSIVE; gateway death → INCONCLUSIVE (D-82) | Never a website failure | worker-browser | IT browser-components 'gateway refusals and time budgets are SKIPPED / INCONCLUSIVE…', 'the gateway dying during interactions…' | passed | **PASS** | — |
| P4F-RSP-01 | Responsive matrix over 6 viewports incl. landscape; objective vs heuristic verdicts; mobile-menu probe; covered controls (D-83) | as stated | worker-browser layout | IT browser-components 'covers all six viewports; a working mobile menu passes, a broken one fails; covered controls fail; clipped text is a heuristic' | passed | **PASS** | — |
| P4F-IDM-01 | Idempotency/cancellation of the extended browser run | Re-run writes nothing; cancel leaves no rows | worker-browser | IT browser-components 'an execution processed again writes nothing…', 'cancellation during the functional tests…' | passed | **PASS** | — |

### P4G Performance, rollups, dashboard completion

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4G-PERF-01 | Six synthetic metrics; status from p75 of ≥3 samples; INSUFFICIENT_DATA otherwise (D-84) | No 'good' on thin data | core performance, performance.controller | RT website without data → no GOOD status, viewports [], measurement SYNTHETIC_BROWSER; IT performance 'POOR needs N consecutive checks…'; UT core performance tests | as expected | **PASS** | — |
| P4G-PERF-02 | Thresholds: platform defaults, per-website custom only with entitlement, validated, audited before/after | 403 ENTITLEMENT_REQUIRED without entitlement | performance.controller thresholds | IT performance 'defaults are visible; custom bounds need the entitlement…audited with before / after' | passed | **PASS** | — |
| P4G-PERF-03 | Streaks: POOR needs N consecutive; inconclusive never counts; recovery needs M; one incident (D-85) | as stated | advanceClasses | IT performance (same test, real browser executions) | passed | **PASS** | — |
| P4G-PERF-04 | Rollups hourly/daily recompute from raw, idempotent, advisory-locked, backfill, late data via dirty buckets, exact p50/p75/p95 (D-86) | No double counting | scheduler rollups | IT performance '…rollups are exact and idempotent'; DEV dev DB metrics_hourly 1 074 rows (latest bucket 2026-11-14 16:00) | passed | **PASS** | performance-load.test.ts (backfill bound, p95 latency) not re-run here (load test) |
| P4G-PERF-05 | Series with explicit empty buckets; ≤90-day ranges; regressions vs previous period (D-87) | Range >90 d → 400 | performance.controller | RT from 2026-01-01 to 2026-11-15 → 400; IT performance tests | as expected | **PASS** | — |
| P4G-PAGE-01 | Pages view with explicit scope (D-88); components changes/detail; responsive latest/compare (D-89) | as stated | performance.controller pages/components/responsive | IT performance 'pages show monitoring scope honestly; component visibility changes and since-comparison; responsive latest, runs and comparison' | passed | **PASS** | — |
| P4G-PERF-06 | Dashboard polling must not starve scheduling at target concurrency (blocker 8) / production-limit load (blocker 7) | Production-like load evidence | apps/api/test/load/monitoring-load.mjs | Not re-run here | Local LR only (8 640 calls, 0 errors); no production-like infrastructure | **BLOCKED** | Run harness on staging-sized infra at plan limits |

### P4H Platform health, alerts, usage, admin config

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P4H-OPS-01 | Per-component HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN; stale evaluation = UNKNOWN; missing worker ≠ healthy (D-91) | as stated | @wim/core ops/health, scheduler evaluator | IT platform-ops 'an expired heartbeat is UNHEALTHY…', 'no worker registered for an enabled tier… (missing ≠ healthy)', 'Redis unreachable is detected…'; DEV /ops/health snapshotAgeSec=27, snapshotStale=false, components with state + since | passed; live snapshot fresh | **PASS** | — |
| P4H-OPS-02 | Stale heartbeat is never healthy; crashed process flagged; restarts counted | as stated | heartbeat + evaluator | IT platform-ops 'probes report a dead dependency; a crashed process stops heartbeating and is flagged; a restart is counted'; DEV dev heartbeats all <5 s old | passed | **PASS** | — |
| P4H-OPS-03 | Customer-monitoring stalled detection (schedules active but not executed) (D-102) | UNHEALTHY although workers alive | core ops | IT platform-ops 'active schedules that are not being executed make customer monitoring UNHEALTHY…'; DEV customer-monitoring component HEALTHY (T3_DEEP active 18, overdue 0) | passed | **PASS** | — |
| P4H-OPS-04 | Self-alerts: 19 rules, K-of-N, one per fingerprint, cooldown reopen, dependency suppression, storm cap + summary (D-93/94) | as stated | core ops rules, platform_alerts | IT platform-ops 9 alert-lifecycle tests; DEV /ops/alerts shows OPEN alerts with occurrences/notifyState | passed | **PASS** | — |
| P4H-OPS-05 | Alert delivery via outbox/e-mail exactly once; SMTP outage retried + recorded; PostgreSQL-outage direct path (D-95) | as stated | worker-notify | IT platform-ops 'an alert e-mail reaches the operators exactly once…', 'SMTP outage…', 'PostgreSQL unavailable…' | passed (Mailpit) | **PASS** | Real mail provider + real operator inbox — BLOCKED (staging) |
| P4H-OPS-06 | Watchdog evaluator when scheduler is dead; single evaluator per interval (D-92) | as stated | worker-notify watchdog | IT platform-ops 'concurrent evaluators: only one evaluates per interval…' | passed | **PASS** | Chaos run (kill scheduler) documented locally, not re-run |
| P4H-OPS-07 | Ops pages permissioned (admin:ops:alerts etc.), audited; customers refused; admin DB role can't forge alerts | as stated | ops.controller | IT platform-ops 'health, history and alerts are operational-only…', 'the admin database role reads operational tables but cannot forge alerts…'; DEV customer session on /api/admin/v1/ops/health → 401 | passed | **PASS** | — |
| P4H-USE-01 | Usage policy (work/exclusion/overhead/info/gauge); retries never double-count; lost lease not accounted; cancellation = overhead (D-96) | as stated | @wim/queue usage, USAGE_KEYS | IT usage-config 'retries never double-count work…', 'a worker that lost its lease…', 'cancellation while running is overhead…', 'billable usage excludes inconclusive results…' | passed | **PASS** | — |
| P4H-USE-02 | Usage reconciliation vs durable records; discrepancies recorded, never auto-repaired; audited adjustments | as stated | reconcile.ts, ops usage endpoints | IT usage-config 'finds every mismatch against the ledger, repairs nothing by itself; an adjustment fixes it with reason + audit…' | passed | **PASS** | ops-load 'reconciliation of one day with 180 k ledger rows' not re-run (load) |
| P4H-CFG-01 | Admin operations configuration: sections, protected policies (extra permission + confirmation), restart markers, combination checks, retention floors (D-97) | as stated | ops.controller config, settings meta | IT usage-config 'permissions, protected policies, combination checks, restart markers and audit…', 'retention: floors…'; DEV /ops/config returns sections with protected/apply/scope | passed | **PASS** | Setting descriptions are stale ('engine ships in Phase 4C/4D/4E') |
| P4H-HRD-01 | Hardening review (SECURITY §34); chaos tests; load test | Evidence recorded | docs/SECURITY.md §34, RELEASE_READINESS | Doc review | Local (LR) chaos/load evidence documented; production-scale BLOCKED | **PARTIAL** | Blockers 2, 6, 7, 8 BLOCKED; 9 OPEN |

### Phase 8 billing core (delivered early, partial)

| ID | Requirement | Expected behaviour | Implementation | Test performed | Actual result / evidence | Status | Remaining issue |
|---|---|---|---|---|---|---|---|
| P8-BILL-01 | billing.enabled=false by default; checkout/plan change refused; webhooks 503 while off | as stated | apps/api/src/billing, settings | RT GET billing → billingEnabled=false, gatewaysAvailable=[]; checkout → 400; DEV dev billing.enabled=false; IT billing 'is off by default; overview is honest; checkout and webhooks are refused' | as expected | **PASS** | — |
| P8-BILL-02 | Webhook spoofing/replay/out-of-order rejected; idempotent processing | as stated | @wim/billing signature/webhook/process | IT billing 4 webhook tests; UT billing 17/17 | passed (local HTTP fakes) | **PASS** | — |
| P8-BILL-03 | Entitlement resolver; admin entitlement change applies without redeploy | Next resolution sees change | packages/queue facts loadOrgContexts | IT billing 'an admin entitlement change applies on the next resolution…', 'entitlement resolution is unchanged while billing is disabled' | passed | **PASS** | — |
| P8-BILL-04 | Gateway secrets encrypted, write-only, audited without values | as stated | billing-admin.controller | IT billing 'stores gateway secrets encrypted; no admin endpoint ever returns them…' | passed | **PASS** | — |
| P8-BILL-05 | Stripe/Razorpay test-mode E2E (upgrade, downgrade, cancel, failed payment) | E2E in gateway test mode | @wim/billing adapters | — | Not run: no test keys | **BLOCKED** | Needs Stripe + Razorpay test-mode keys and webhook endpoints reachable from the gateways |
| P8-BILL-06 | Dunning emails, portal links, refunds, invoice PDFs, downgrade website-selection, GST invoicing | Implemented | — | BILLING.md 'Not done' | Not implemented | **FAIL** | Billing not ready for payments (per brief: audit as not ready; not extended) |

## 3. Dropped / changed requirements

| # | Requirement (source) | What happened | Recorded? | Assessment |
|---|---|---|---|---|
| 1 | Org-level 'require 2FA for all members' (SECURITY §23, scheduled Phase 3) | Not implemented; absent from Phase 3 deliverables | No — silently dropped | FAIL (P2-GAP-02) |
| 2 | Email-address change `/me/email/change` (API §2.2, 'planned Phase 3') | Route does not exist | Only as 'planned' in API doc | FAIL (P2-GAP-03) |
| 3 | Re-authentication window for destructive org actions (SECURITY §23, Phase 3) | Not implemented | No | FAIL (P2-GAP-04) |
| 4 | ESLint + security lint rules in CI (Phase 2 gap → Phase 3) | No lint script in any package; `turbo run lint` runs zero tasks while RELEASE_READINESS reports 'lint 46/46' | Misreported | FAIL (P2-GAP-01) |
| 5 | API conventions: `Idempotency-Key` (§1.7), `ETag`/`If-Match` (§1.8), `RateLimit-*` headers (§1.9) | None implemented (only `Retry-After` on 429); API doc still states them as the contract | No | Changed silently — doc must be corrected or features built before public API use |
| 6 | ARCH §11.5 SDK-beacon verification method; meta-tag T2 fallback for SPAs | Replaced by D-37 (SDK = installation status only) and D-34 (HTML parser, no JS) | Yes (D-34, D-37) | N.A. — justified |
| 7 | ARCH §11.5 weekly re-verification, 14-day lapse, LAPSED → T1 only | D-44: 24 h interval, 72 h grace, 30 d release; LAPSED → no monitoring at all | Yes (D-44) | N.A. — stricter; ARCH text stale |
| 8 | ARCH G1 immediate confirmation retry before a failed availability check | Replaced by consecutive-failure thresholds (D-52); `check_results.confirmed` never set (0/10 073 rows) | Implicitly (D-52) | N.A. — but remove or document the dead column |
| 9 | D-15 realtime Socket.IO service; Phase 7 exit '< 3 s p95 to open dashboard' | Replaced by authenticated polling change feed (D-70), ≤ 15 s | Yes (D-70) | Changed; Phase 7 exit criterion cannot be met as designed |
| 10 | D-06 Smokescreen egress proxy | Own gateway (D-41) | Yes | N.A. |
| 11 | Phase 1 leader-elected scheduler | Leaderless (D-46) | Yes | N.A. |
| 12 | ARCH §12.4–12.5 hashed abuse signals / risk score | Not implemented (BILLING.md 'Not done') | Yes | FAIL (P3-TRIAL-04) |
| 13 | ARCH §11.6 fast-path auto-approval of transfers for LAPSED claims | No test or evidence found | No | Not verified — treat as not delivered |
| 14 | ARCH G2 per-website maintenance windows; incident escalation; flapping alert | Not implemented (table exists, no code) — Phase 6 scope | Phase 6 | Out of 1–4H scope; note for incident-management phase |
| 15 | Phase 4 dashboard was first reported as '4F' | Relabelled as approved-4G scope delivered early (PHASE4_PLAN §12–§14) | Yes | Traceability correct after relabel |
| 16 | Phase 9 exit: contract test that EVERY admin mutation is audited | Only per-feature audit tests | No | PARTIAL (P2-ADM-03) |
| 17 | PHASE4_PLAN §17: 'Phase 8 (billing): not started' | Billing core exists (off by default) | Doc stale | Documentation fix |

## 4. Functional defects found

### D1 — FIXED: inconclusive / no-page deep scans extended (or could reopen) finding-group incidents

* **Observed:** dev database `wim` (read-only query): 3 `incident_occurrences` of `deepscan.broken_pages` incidents are linked to executions whose ledger outcome is `INCONCLUSIVE` (2 × `PARTIAL / NO_PAGE_REACHABLE` on 2026-11-14 and 2026-11-15, 1 × `PARTIAL / INFRASTRUCTURE` on 2026-11-13). A scan that reached no page re-stamped the incident's `last_detected_at` and occurrence count as if the broken pages had been seen again. Because the block also opens/reopens an incident whenever OPEN findings exist and no incident is active, a scan that observed nothing could also reopen an incident from stale findings. Violates D-52/D-65 ('inconclusive results never open, resolve or reset'; 'a scan that couldn't see something must never be read as…').
* **Cause:** `apps/worker-deepscan/src/finalize.ts` incident block used the website's *current OPEN finding count* per group, not what this scan detected.
* **Fix (4 lines):** only groups actually re-detected by this scan (`found` → `FINDINGS[category].group`) may record an occurrence or open/reopen an incident; resolution logic unchanged (still COMPLETED-only).
* **Regression test:** `apps/api/test/integration/deep-scan.test.ts` → 'a scan that reaches no page adds no occurrence to (and never reopens) an open finding-group incident'. **Fails on the original code** (verified by temporarily reverting the compiled line: `AssertionError: expected [[…]] to deeply equal [[…]]`), passes with the fix. `deep-scan.test.ts` 18/18 + `deep-scan-api.test.ts` 5/5 pass; `tsc --noEmit` clean for worker-deepscan and api.
* **Files changed:** `apps/worker-deepscan/src/finalize.ts`, `apps/api/test/integration/deep-scan.test.ts` (not committed). `apps/worker-deepscan/dist` was rebuilt by another workstream's build after the edit; the running dev `worker-deepscan` process still has the old code loaded until it is restarted (not restarted by me). Existing dev-DB occurrences were not repaired.

### D2 — OPEN: lint is a no-op

No `apps/*` or `packages/*` package defines a `lint` script and there is no ESLint configuration, so `pnpm lint` (`turbo run lint`) executes nothing. RELEASE_READINESS §8 counts 'Build / typecheck / lint 46/46 tasks'. Not fixed (configuration work, not a minimal fix).

### D3 — OPEN (documentation/contract): API conventions not implemented

`Idempotency-Key`, `ETag`/`If-Match` and the `RateLimit-*` headers described in API_DOCUMENTATION §1.7–§1.9 do not exist in `apps/api/src` (only `Retry-After`). Either implement before any public/third-party API use or mark them as planned in the doc.

### Observations (not defects)

* Shared per-IP limits lock out local reviewers when several clients use 127.0.0.1 (dev API answered 429 for ~52 min). Correct with `TRUST_PROXY=false`; for local review sessions use separate accounts sparingly or a dedicated instance as done here.
* With the functional-test platform switch off, `PUT …/browser/config` returns `409 FEATURE_UNAVAILABLE` before validating acknowledgement/allowedPaths — acceptable precedence.
* Dev stack has OPEN platform alerts `resources.disk` (host disk 95 %) and `storage.unavailable` (1 of 1 workers cannot reach object storage) — environment state of the local machine, reported correctly by the evaluator; the storage alert should clear after the S3-key fix once K good evaluations are seen (re-check).
* `platform_settings` descriptions still say 'engine ships in Phase 4C/4D/4E'.

## 5. Items that need infrastructure (BLOCKED)

* **P4A-NET-03** — Isolation enforced in staging/production network (NetworkPolicies): Needs staging cluster (amd64, Calico/Cilium, IMDS blocked), registry, secret manager
* **P4D-BR-11** — Production browser-runner / worker-browser images (blocker 1): Staging execution of the published digests
* **P4F-FUN-05** — First-party GET side effects technically prevented (blocker 9): Needs product-owner written risk acceptance or a staging-URL isolation feature
* **P4G-PERF-06** — Dashboard polling must not starve scheduling at target concurrency (blocker 8) / production-limit load (blocker 7): Run harness on staging-sized infra at plan limits
* **P8-BILL-05** — Stripe/Razorpay test-mode E2E (upgrade, downgrade, cancel, failed payment): Needs Stripe + Razorpay test-mode keys and webhook endpoints reachable from the gateways
* Also blocked inside PASS/PARTIAL rows: positive DNS-TXT verification against a real public zone (P3-VER-01), real mail provider delivery (P4H-OPS-05), wim_browser/wim_scanner production credentials (P4D-BR-09, P4E-DS-14), staging gateway confirmation (P4D-BR-10).

