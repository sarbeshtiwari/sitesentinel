# SiteSentinel: security and multi-tenant isolation audit

Date: 2026-11-15 · Branch `stage` (HEAD 8ce5981) · Auditor workstream: security
Target: the local dev stack only (API :4000, web :3000, admin :3001, ingest :4200, gateway :8090, runner :3300, Postgres 55432, Mailpit 58025). Render/live was not touched, no stack process was killed, and no secrets are printed here. Tokens and cookies are redacted; IDs are local dev UUIDs.

## 1. Scope and method

* Read: docs/SECURITY.md (§§7–11, 19, 25, 36), docs/RELEASE_READINESS.md (blocker matrix + CI log), docs/SECRETS_AND_CREDENTIALS.md.
* Throwaway identities were created through the real API. Each user went register → Mailpit verification link → `POST /auth/verify-email` → login:
  * `sec-a-1794739348@example.test`: owner of **SecOrg A** `ec9cd842…`, website `4ffa7c4a…`
  * `sec-b-…`: owner of **SecOrg B** `7d8bfa5c…`, website `b48ab655…`
  * `sec-m-…`: member of Org A with custom role `ReadOnlySec` = {website:read, org:read}, invited by email and accepted
  * `sec-u-…`: never verified
  * Admins: `sec-adm-admin-support-…` (ADMIN_SUPPORT) and `sec-adm-admin-auditor-…` (ADMIN_AUDITOR), created with `pnpm admin:create`. Logins used password and TOTP; the TOTP came from the one-time enrolment output and was not printed.
* Victim tenant with real data: org `bbfc8afc…` (website `7d94737e…`, 8 scan findings, deep scan `b5da45ed…`, T2 browser execution `1f643268…`, screenshot artifact `8fa29a61…`, incident, component, member, notification, role). IDs were read from the DB as `wim_owner`.
* Scripts: Python `requests` for API probes, a raw-socket client for the gateway, and Playwright (playwright-core from worker-browser) for rendering and runner probes. They are in `…/60fedc81…/scratchpad/sec/` (`lib.py`, `idor.py`, `authz2.py`, `auth3-5.py`, `gw.py`, `sdk.sh`, `dbroles.sh`, `runner.mjs`, `xss*.mjs`).

## 2. Results table

| Area | Test | Result | Status |
|---|---|---|---|
| Tenant isolation (API) | Attacker A (owner of Org A) runs 117 read and write requests against victim org `bbfc8afc`. Two shapes: (a) `/orgs/{victim}/…` and (b) `/orgs/{A}/…` with victim resource IDs. Covers websites (get/patch/delete/pause/verify/site-key/sdk-config/audit/history), monitoring http/browser/schedule/analytics/history/usage, incidents (+acknowledge), deep-scan (status/config/start/cancel/scans/scan/compare/pages/findings/finding/usage), performance/pages/components/responsive, artifact link, org get/patch, members patch/delete, invitations, roles, billing (+cancel), notifications (+read), audit-logs, domain-transfers | **117/117** refused with 404 (or 400 on a malformed ID). No response body contained any victim ID | **PASS** |
| Session revocation (cross-user) | B sends `DELETE /auth/sessions/{A's session id}` | 404; A still signed in | PASS |
| Artifact download links | Cross-org `GET /orgs/{A}/artifacts/{victim artifact}/link` → 404. Forged token on `/artifact-downloads` → 404. Code check: the token is HMAC-signed, valid 5 min, and re-checked under `withTenant(o)` with `orgId=o` | Negative paths pass. No positive download was exercised (no artifact exists in a test org) | PARTIAL |
| Unauthenticated | All 161 non-public routes (from controller metadata), no cookie | 79 GETs → 401. 82 writes → 403 CSRF_INVALID (CSRF check runs first). 0 returned data | PASS |
| Role permissions | Custom role {website:read, org:read}: 2 allowed reads → 200. 17 forbidden actions → 403: website patch/delete/create, browser config, deep-scan start, site-key regenerate, members, invite, role create, role escalate (PATCH own role to add role:manage), org patch, audit, billing get/cancel, org deletion, incidents, transfer-ownership | 19/19 as expected | PASS |
| Admin API vs customer session | Customer cookie on `/api/admin/v1/{me,overview,customers,settings}` → 401. PATCH admin settings (`monitoring.functional.enabled=true`) with the customer cookie → 403 | Refused | PASS |
| Customer API vs admin session | Admin cookie on `/api/v1/me`, `/orgs`, `/orgs/{victim}/websites` → 401 | Refused | PASS |
| Admin RBAC | SUPPORT: audit-logs, ops/usage, billing/plans → 403; PATCH settings, verify-chain, PUT gateways → 403. AUDITOR: customers, settings → 403 | As designed | PASS |
| Admin responses are aggregates | overview, websites/stats and monitoring/health are counts only. customers shows org name, slug and masked owner email (`s***@e***.test`). dead-letters shows orgId/executionId and error text | Aggregates/metadata only | PASS |
| Admin responses are aggregates | `GET /api/admin/v1/audit-logs?stream=org:{id}` (AUDITOR) | Returns **unmasked customer emails** (actor and invitee) and customer free text (names/descriptions) in `changes`. See F-3 | **FAIL** (Medium) |
| Admin 2FA / TOTP replay | Wrong TOTP → 401. Reusing the same 30 s step for a second login → 401 (replay rejected). Admin login rate limit observed: 429 | Enforced | PASS |
| Admin logout | Old admin cookie after logout → 401 | Rejected | PASS |
| Email verification | Verification token reused → 400 INVALID_TOKEN. Unverified user can sign in, but `POST /orgs` → 403 EMAIL_NOT_VERIFIED | Gated | PASS |
| Session revocation | Second login. `DELETE /auth/sessions/{id}` → 204; `DELETE /auth/sessions` → `{revoked:6}`. Revoked cookie → 401 | Rejected | PASS |
| Logout | `POST /auth/logout` → 204; replaying the old cookie → 401 | Rejected | PASS |
| Password reset | forgot (existing) and forgot (unknown) give the same 202 body. Reset → 204. Token reuse → 400. Pre-reset session → 401. Forged token → 400 | Single-use; sessions revoked | PASS |
| 2FA (customer) | Enrol, confirm with wrong code → 400, then correct code → 200. New login → `SECOND_FACTOR_REQUIRED`. `/me` and org data with the partial session → 401 SECOND_FACTOR_REQUIRED. 7 wrong codes → `400×5, 429, 429`. Correct code while limited → 429 | Enforced | PASS |
| Org-level "require 2FA" | Not implemented (SECURITY.md §23 lists it as scheduled) | n/a | NOT IMPLEMENTED (documented) |
| Rate limiting | login per IP (20/15 min) → 429 observed several times. Per account: 5 wrong passwords → 429 with 30 s progressive delay. register per IP (5/h) → 429. forgot per IP → 429. 2FA → 429. admin login → 429 | Observed | PASS (but see F-1 for proxy deployments) |
| CSRF | On public forgot and on an authenticated `PATCH /orgs/A`: no token, wrong token, no Origin/Referer, evil Origin, admin Origin, `null` Origin, evil Referer, `localhost:3000.evil.test` Referer → all 403 CSRF_INVALID. Good Referer only → 202 | Enforced | PASS |
| Cookies (local, COOKIE_SECURE=false) | `wim_sid`: HttpOnly; SameSite=Lax. `wim_csrf`: not HttpOnly (by design). `wim_admin_sid`: HttpOnly; SameSite=Strict | As designed | PASS |
| Cookies (production config) | `SessionService`/`AdminSessionService.setCookies` with COOKIE_SECURE=true → `__Host-wim_sid` (Secure, HttpOnly, Lax, Path=/, no Domain), `__Host-wim_admin_sid` (Secure, HttpOnly, Strict). `loadEnv(NODE_ENV=production, COOKIE_SECURE=false)` is refused | Correct in-process. No HTTPS deployment observed | PARTIAL |
| Security headers: API | helmet sets CSP `default-src 'none'`, COOP/CORP same-origin, nosniff, `Referrer-Policy: no-referrer`, XFO SAMEORIGIN, `Cache-Control: no-store` on authenticated responses. HSTS only when COOKIE_SECURE (code) | Good | PASS |
| Security headers: web/admin | XFO DENY, nosniff, Referrer-Policy, Permissions-Policy. Per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`. `'unsafe-eval'` and `ws:` appear only when NODE_ENV=development (code). **No HSTS, COOP or CORP** on pages. Admin `Referrer-Policy` is `strict-origin-when-cross-origin` (doc: `no-referrer`). `img-src https:` and `style-src 'unsafe-inline'` are broader than SECURITY.md §10 | Partly diverges from the doc. See F-7 | PARTIAL (Low) |
| CORS | API preflight from `https://evil.test` → 404 with no ACAO. GET with an evil Origin → no ACAO. Ingest `/v1/events` preflight → ACAO `*`, `GET, POST`, content-type, no credentials | Matches §11.2 | PASS |
| XSS (stored) | Stored `<img src=x onerror=…>`, `<script>…</script>' OR 1=1--` in website name/description, org name and role name. Rendered in Chromium: web websites list, website detail, overview, settings/roles, settings/general, settings/audit; admin customers and websites | `window.__xss` unset, 0 dialogs, 0 injected `<img>`; payload shown as text | PASS |
| SQL injection | `' OR 1=1--` in website search and cursor → 200 with own data only. `cursor` and `limit=100000` on audit-logs → 400 validation. Injection in orgId path → 404. Code: no `$queryRawUnsafe`/`$executeRawUnsafe` in app code; raw `pool.query` calls are parameterised | Inert | PASS |
| URL validation | preview rejects `javascript:`, `file:`, IP literals (v4, v6, ULA, mapped, hex, decimal), non-443/80 ports, userinfo, `.internal`, `.local`, `.localhost`, `metadata.google.internal` | 17/20 rejected | PASS |
| URL validation | `127.0.0.1.nip.io`, `10.1.2.3.nip.io`, `localtest.me` (DNS resolves to private) are accepted at registration. The verification attempt was refused by the gateway: `BLOCKED_DESTINATION / BLOCKED_ADDRESS` (gateway log, org A, kind verify) | No SSRF. Junk claim possible. See F-8 | PASS (Low note) |
| SSRF gateway (live :8090) | 28 probes with locally signed capabilities: no/forged/expired cap → 407. IP literals (127/8, 10/8, 169.254.169.254, ::1, fd00::1, ::ffff:127.0.0.1, decimal, hex) → 403. `localhost`, `localtest.me`, `*.nip.io` to 127/10/169.254 → 403. Ports 22, 6379, 8443 → 421. Plain-HTTP proxying to `127.0.0.1:4000`, `localhost:4000` → 421; to metadata → 403. Host-bound cap to another host → 407. Controls: example.org CONNECT and plain → 200 | All internal targets refused | PASS |
| netguard / gateway unit tests | `packages/netguard`: 56/56 passed (1.40 s). `apps/egress-gateway`: 34/34 passed (2.20 s) | Pass | PASS |
| Browser runner (local) | Runner bound to 127.0.0.1:3300, sandbox on. `POST /v1/sessions` with **no authentication and a junk token** → 201 plus a WS endpoint. Through that endpoint: default context to `127.0.0.1:4000` → 407 (gateway, proxy enforced). Context with `proxy:{server:'http://127.0.0.1:9', bypass:'127.0.0.1'}` → **reached API, 200**. `DELETE /v1/sessions/{id}` without auth → 200 | The control API has no auth, and a context-level proxy override bypasses the gateway. See F-5 | FAIL (Low, defence in depth) |
| Browser isolation (CI) | Run 43703272806 (main, 2026-11-15): job `isolation` passed, 170 `PASS` lines against the production runner image. Includes "browser WITHOUT proxy" blocked, runner control API via loopback/IP blocked, metadata/redis blocked, WebRTC 0 candidates. Job `test`: unit suites + integration 306/306, gitleaks "no leaks found" | CI evidence | PASS (CI) / staging BLOCKED |
| SDK ingest | Valid active key + forged wrong Origin → `ORIGIN_MISMATCH`, heartbeat unchanged. No Origin → mismatch. Referer only (correct host) → mismatch. Look-alike `host.evil-sec.test` → mismatch. Revoked key → `REVOKED_KEY`, unchanged. Unverified website → `WEBSITE_NOT_VERIFIED`, unchanged. Unknown key → 204 (no oracle). Correct Origin forged by curl → heartbeat +1 (documented: telemetry is never ownership proof) | As designed | PASS |
| Ownership proof | Verification methods are only DNS_TXT, WELL_KNOWN_FILE, HTML_META (contracts). No code path in api/worker-http/core reads Origin/Referer except the CSRF guard | Origin is not used as ownership proof | PASS |
| DB: RLS on/off | 63 tables with `org_id` have RLS enabled but **not FORCE** (owner `wim_owner` bypasses, which is normal for the owner). `data_requests`, `outbox_events`, `security_events` and `job_failures` (have org_id) have **no RLS** | Inventory | INFO |
| DB: cross-tenant (wim_app) | No context → websites/scan_findings/audit_logs/sessions = 0. INSERT into incidents → permission denied. **`SELECT set_config('app.current_org_id','<victim>',true)` with no membership → 1 website and 8 findings of the victim are visible** | RLS only isolates when the app sets the context correctly. See F-2 | PARTIAL (Medium) |
| DB: wim_browser / wim_scanner | Without app.system: 0 rows; users/audit/sessions/scan_findings denied. With `set_config('app.system','on')`: **842 websites (all tenants)** readable; UPDATE websites denied; DELETE scan_findings as scanner → 0 rows | Writes narrowed. Reads are cross-tenant once the role sets the GUC itself | PARTIAL |
| DB: wim_ingest | Every table → permission denied (functions only) | As documented | PASS |
| DB: wim_admin | Column grants on websites (no URL/config). users, artifacts, incidents, scan_findings, sessions denied. UPDATE websites denied. Reads all 1166 audit_logs | Mostly as designed. Audit-log exposure is F-3 | PASS/see F-3 |
| DB: wim_worker | Full SELECT/INSERT/UPDATE/DELETE on `users` (no RLS: 99 rows, no context needed), `user_sessions`, `recovery_codes`, `password_reset_tokens`, `email_verification_tokens`, `platform_settings`, `platform_data_keys`, `org_encryption_keys`, `payment_gateway_configs`, `api_credentials`, `auth_recipes`. Used by worker-http, scheduler, worker-notify | **Contradicts SECURITY.md §3 B3** ("no access to auth tables, admin settings or gateway secrets"). See F-4 | FAIL (Medium) |
| Secrets: repo | `gitleaks git` over 50 commits → no leaks. `gitleaks dir` → 84 hits, **all in git-ignored local files**: `.env`, `apps/*/.next` build caches, `.claude/worktrees/agent-a88cd…` (a full copy including `.env` and an `aws-access-token` match). `git ls-files` shows `.env`, `.keys` and `.local` are untracked | No committed secrets | PASS (local hygiene note) |
| Secrets: dev passwords in production | `assertDatabaseRole` refuses dev password, non-TLS and superuser/BYPASSRLS. Proved: run against `wim_app` with production=true → "development credentials … not accepted". **It is only called by worker-browser and worker-deepscan.** API, ingest, scheduler, worker-http and worker-notify never call it. `loadEnv(NODE_ENV=production, COOKIE_SECURE=true)` with the dev DB passwords and no sslmode → accepted | Gap. See F-6 | FAIL (Medium) |
| Logging redaction | Searched all 11 `.local/logs/*.log` for the test password, `wim_sid=`, CSRF tokens, `cap:` proxy auth, `pk_…` site keys, and plaintext test emails → 0 hits. The API logs route, status and requestId only (no query strings or bodies) | Clean | PASS |
| Functional testing: default | `platform_settings monitoring.functional.enabled = false` (registry default false, protected). `PUT …/browser/config {functional:{enabled:true,allowedPaths:['/products']}, acknowledgeFunctionalRisk:true}` → 409 FEATURE_UNAVAILABLE. Forged `riskAcknowledgement` → 400. Worker re-checks `functionalBlockedReason(cfg, platformSwitch)` | Off by default; cannot be enabled | PASS |
| Functional testing: allowlist + guard | API and worker refuse an empty `allowedPaths`. Guard aborts every non-GET, aborts off-site navigations, and aborts first-party requests outside the prefixes unless they are in the baseline or on the same page | Implemented | PASS (code + unit tests in CI) |
| Functional testing: GET side effects (blocker 9) | Applied the guard decision (`urlIsUnsafe` + samePage + `pathAllowed`) from `@wim/core` dist, start `/`, allowed `['/products']`. **ALLOWED**: `/?add_to_wishlist=12`, `/?rate=5&post=9`, `/?newsletter_email=…`, `/?empty-cart=1`, `/?mark_read=all`, `/products/42/wishlist-toggle`, `/products/42?quantity=3&update=1`, `/products/42/rate?stars=1`. Blocked: `/?add-to-cart=12`, `…/delete`, `/account/delete` | **A declared GET path, or any query string on the monitored page itself, can still change data.** samePage compares the pathname only | **NOT SAFE: blocker 9 stays OPEN** (High if enabled) |

## 3. Findings by severity

No Critical findings. Tenant isolation held for every API path tested.

### High

**F-0. Functional testing can mutate customer data through GET requests (release blocker 9; conditional, because the feature is off).**
Repro: run `node` with `urlIsUnsafe` and `pathAllowed` imported from `packages/core/dist`, and evaluate the guard in `apps/worker-browser/src/interact.ts:24-60`. Use start URL `https://shop.example.org/` and `allowedPaths=['/products']`. The results are in the table above. Two patterns get through:
* State-changing GETs whose query names the deny-list does not know (wishlist, rate, empty-cart, mark_read, update).
* Any query string on the monitored page itself. `samePage` compares the pathname only, so `/?anything` is allowed even outside `allowedPaths`.

The deny-list is a heuristic, which SECURITY.md §36 admits. Today this is only a risk because `monitoring.functional.enabled=false`, and that was verified at runtime. **Do not enable it.** If it is ever enabled:
* Make the same-page exception exact-URL, not pathname.
* Disallow query strings outside the passive baseline.
* Keep the "staging URL only" option from §36.

### Medium

**F-1. With `TRUST_PROXY=true` (the documented setting behind Nginx), every per-IP rate limit can be bypassed by spoofing `X-Forwarded-For`.**
`apps/api/src/app.ts:15` and `apps/ingest/src/index.ts:136` pass a boolean `trustProxy`. With `true`, Fastify trusts every hop and `req.ip` becomes the left-most, client-supplied value. Repro (in-process): `Fastify({trustProxy:true})` with XFF `6.6.6.6, 203.0.113.9` from socket 10.0.0.2 gives `req.ip=6.6.6.6`.

Affected limits: login per IP, registration per IP (5/h → unlimited account creation), forgot per IP, admin login per IP, ingest per IP, and billing webhook per prefix. Per-account limits still apply.

The opposite setting also fails: with `false` behind a proxy, every client shares one bucket, so 20 logins per 15 minutes are spread across all users (login DoS).

Fix: accept a hop count or trusted CIDR list (`trustProxy: 1` or `'10.0.0.0/8'`), set it per environment, and document it in DEPLOYMENT.md. Not fixed here: the right value depends on the deployment topology (Render/Nginx), which I was told not to touch.

**F-2. RLS is not a boundary against a compromised or injected service connection.**
Any service role can set the tenant GUCs itself. Repro:
```
psql "$DATABASE_URL" -c "begin; select set_config('app.current_org_id','<other org>',true); select count(*) from scan_findings; rollback"
```
This returned 8 rows of a foreign tenant. The same works for `app.system='on'` as wim_browser (842 websites across tenants) and wim_scanner.

`app_enter_org()` checks membership, but nothing forces callers to use it. The guard comment ("verified by the database (app_enter_org), not only here") overstates the guarantee. Application-layer isolation held in every test, so this is a defence-in-depth gap: impact needs SQL injection or service compromise.

Options:
* Sign the context, e.g. HMAC'd GUC checked by a `SECURITY DEFINER` accessor.
* Or set it only through a `SECURITY DEFINER` function, and have policies use a function that validates the membership row for `current_setting('app.current_user_id')`.
* Restrict `app.system` to a role attribute, e.g. `pg_has_role`, instead of a GUC.

**F-3. Admin auditors see unmasked customer PII and free text in org/user audit streams.**
Repro: sign in as ADMIN_AUDITOR, then `GET /api/admin/v1/audit-logs?stream=org:ec9cd842…&limit=100`. The response contains `actorLabel` = customer email, `invitation.created.changes.email` = the invitee email, and `website.updated.changes.description` = customer free text. The admin UI exposes this through the Stream selector.

SECURITY.md §19 says owner emails are masked and unmasking needs an audited reason. The reads are not audited. Fix: mask emails and free text in org/user streams for admins (or require break-glass), and audit admin reads of customer streams.

**F-4. `wim_worker` has full DML on authentication and secret tables, contrary to SECURITY.md §3 B3.**
`users` has no RLS at all, so the worker reads all 99 users without any context. With `app.system` it also reads `user_sessions` (174 rows), plus `recovery_codes`, `password_reset_tokens`, `platform_settings`, `platform_data_keys`, `org_encryption_keys`, `payment_gateway_configs` and `api_credentials`, all with INSERT/UPDATE/DELETE.

worker-http processes hostile HTTP responses and connects as this role. SECRETS_AND_CREDENTIALS.md does admit it is "broad by design", but SECURITY.md claims the opposite. Fix: narrow `wim_worker` (or split per worker, as was done for wim_browser and wim_scanner), and correct the docs now.

**F-6. The production startup guard against dev credentials and non-TLS connections covers only 2 of 7 DB-using services.**
`assertDatabaseRole` is called only in `apps/worker-browser/src/index.ts:59` and `apps/worker-deepscan/src/index.ts:48`. These services never call it: api (wim_app, plus ADMIN_DATABASE_URL as wim_admin and SETTINGS_DATABASE_URL), ingest (wim_ingest), scheduler, worker-http and worker-notify (wim_worker).

Proved:
* `loadEnv({NODE_ENV:'production', COOKIE_SECURE:'true', …dev .env})` is accepted.
* The same guard run on the wim_app URL refuses it ("development credentials for wim_app are not accepted in production").

So a production API would run with `wim_app_dev_password` and no TLS. Fix: call `assertDatabaseRole` for each role at startup of every service. Not applied here because the call would also take effect on the live deployment's next boot, which I was told not to touch.

### Low

**F-5. browser-runner control API has no authentication, and Playwright clients can override the per-context proxy.**
Locally, `POST /v1/sessions` with a junk token returned 201 plus a WS endpoint. A new context with `proxy.bypass='127.0.0.1'` then reached the API directly (200).

In the intended topology only worker-browser can reach the runner (`browser-control` network), and CI shows that Chromium without the proxy has no route (isolation run 43703272806). So this depends on network isolation, which is proven in CI only. Staging enforcement is still blocker 2.

Options: a shared-secret header on `/v1/sessions`, and refusing context-level proxy overrides through a Chromium policy or the `--proxy-server` flag combined with `--proxy-bypass-list=<-loopback>` (contexts can still override). Network isolation remains the real control.

**F-7. Web/admin header deviations from SECURITY.md §10/§11.**
* No HSTS, COOP or CORP on pages. The doc expects Nginx to set them, but `infra/nginx/` does not exist in the repo.
* Admin `Referrer-Policy` is `strict-origin-when-cross-origin`; the doc says `no-referrer`.
* CSP `img-src https:` (doc: the object-storage host only) and `style-src 'unsafe-inline'` (doc: nonce).

Repro: `curl -I http://localhost:3001/login`. Fix in `apps/*/next.config.ts` and `apps/*/src/proxy.ts`, or ship the Nginx config.

**F-8. Registration accepts hostnames whose DNS resolves to private addresses** (`127.0.0.1.nip.io`, `localtest.me`, `10.1.2.3.nip.io`). This is not exploitable: every fetch goes through the gateway, which refused it (verification → `BLOCKED_DESTINATION`). Optional: resolve at preview time and reject private-only answers, to avoid junk domain claims.

**F-9. Local hygiene: `.claude/worktrees/agent-a88cd84018ac67884/` holds a full copy of `.env`** (gitleaks: generic-api-key and aws-access-token matches). It is git-ignored and was never committed. Delete the worktree, and if the AWS key was ever valid, rotate it.

**F-10. Org-level "require 2FA for all members" is not implemented.** It is documented as scheduled in SECURITY.md §23.

**F-11. No HTTP-level test of the production cookie attributes.** The integration env forces `COOKIE_SECURE=false`. I checked the attributes in-process only (table above). Add one integration case with `COOKIE_SECURE=true`.

## 4. Blocked items (need infrastructure)

* **Network isolation of runner/gateway in staging (blocker 2)**: needs a cluster with an enforcing CNI. Only the CI Docker topology is proven (run 43703272806, 170/170).
* **HTTPS/HSTS/`__Host-` cookies end to end**: needs a TLS deployment. Only the in-process check was done.
* **Production DB TLS and secret-manager credentials (blocker 6)**: no managed DB or secret manager.
* **Real client IP behind the production proxy (F-1)**: needs the actual proxy chain to choose the hop count.
* **Positive artifact download**: no artifact in a tenant whose credentials I control. Negative paths pass.
* **Rate limits at the Nginx layer** (§7.3 "Nginx + Redis"): no Nginx config exists. Only the app-level Redis limits were verified.

## 5. Fixes made

None. Every defect found is either a design or documentation mismatch (F-2, F-3, F-4), or it depends on the deployment and would change live behaviour on the next deploy (F-1, F-6). Per the brief these are reported, not changed. No repository files were modified.

Test data left in the local dev DB (safe to delete):
* Users `sec-{a,b,m,u}-1794739348@example.test`
* Orgs SecOrg A and SecOrg B, with websites, including one for `127.0.0.1.nip.io`
* Custom roles `ReadOnlySec` and an XSS-named role
* Admin users `sec-adm-admin-support-…` and `sec-adm-admin-auditor-…`
* Test user `sec-m` has TOTP enabled
* The org name and website name of SecOrg A contain the XSS payload strings
