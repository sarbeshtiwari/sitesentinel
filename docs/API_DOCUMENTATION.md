# API Documentation

> Status: **Phase 1 — Proposed contract** · Last updated 2026-11-13
>
> Source of truth once implemented: Zod schemas in `packages/contracts` (OpenAPI 3.1 generated from them at build time, served at `/api/v1/openapi.json` in non-production). This document is the design-time contract. See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind each decision.

---

## 1. Conventions

### 1.1 Base paths

| Surface | Base | Origin | Consumers |
|---|---|---|---|
| Customer API | `/api/v1` | `app.<domain>` (same origin as the web app) | `apps/web` |
| Admin API | `/api/admin/v1` | `admin.<domain>` only (Nginx rejects admin paths on other hosts) | `apps/admin` |
| Telemetry ingest | `/v1` | `ingest.<domain>` | `monitor.js` SDK |
| Webhooks | `/webhooks/{provider}` | `api.<domain>` | Stripe, Razorpay, email provider |
| Realtime | `/ws` (Socket.IO path) | `app.<domain>` | `apps/web` |
| Health | `/health/live`, `/health/ready` | internal network only | Docker / orchestrator |

### 1.2 Authentication

- **Customer:** an opaque session token in the `wim_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). The server stores the SHA-256 hash in the DB and caches it in Redis. Idle timeout is 7 days, the absolute limit is 30 days, and the session rotates on login, 2FA change, and password change.
- **Admin:** cookie `wim_admin_session` scoped to `admin.<domain>`, 8 h absolute and 30 min idle. **2FA is mandatory**: a session is `PARTIAL` until TOTP or WebAuthn passes, and only `/auth/2fa/*` is allowed in that state.
- **CSRF:** double-submit. The `wim_csrf` cookie (not HttpOnly) must be echoed in the `X-CSRF-Token` header on every non-GET request. `Origin` must match the expected host. Webhooks and ingest are exempt (they use signature verification and a public site key, respectively).
- **SDK ingest:** a public site key (`pk_live_…`) in the body. It grants write-only telemetry for one website and nothing else.

### 1.3 Tenant scoping

All tenant resources are nested under `/orgs/:orgId`. The org guard verifies membership and role, then sets the RLS context. **A resource belonging to another org returns `404 NOT_FOUND`, never `403`** (no existence oracle). Organization IDs, and all other IDs, are UUIDv7.

### 1.4 Permissions (org roles → permissions)

| Permission | OWNER | ADMIN | MEMBER | VIEWER |
|---|:-:|:-:|:-:|:-:|
| `org:read` | ✓ | ✓ | ✓ | ✓ |
| `org:update` | ✓ | ✓ | | |
| `org:delete`, `org:transfer_ownership` | ✓ | | | |
| `member:read` | ✓ | ✓ | ✓ | ✓ |
| `member:manage` | ✓ | ✓ | | |
| `website:read` | ✓ | ✓ | ✓ | ✓ |
| `website:write` (create/update/pause/verify) | ✓ | ✓ | ✓ | |
| `website:delete` | ✓ | ✓ | | |
| `monitoring:write` (config, pages, test cases, API endpoints) | ✓ | ✓ | ✓ | |
| `secret:write` (credentials, auth recipes) | ✓ | ✓ | ✓ | |
| `journey:approve` | ✓ | ✓ | | |
| `incident:read` | ✓ | ✓ | ✓ | ✓ |
| `incident:write` (transition, comment) | ✓ | ✓ | ✓ | |
| `notification:manage` (org channels/recipients) | ✓ | ✓ | | |
| `analytics:read`, `report:create` | ✓ | ✓ | ✓ | ✓ |
| `billing:read` | ✓ | ✓ | | |
| `billing:manage` | ✓ | | | |
| `audit:read` | ✓ | ✓ | | |
| `data:export` | ✓ | | | |

In the endpoint tables below, **Perm** shows the required permission. `public` means no session is needed. `session` means any authenticated user, with no org context.

Admin permissions (admin roles `SUPER_ADMIN`, `ADMIN_OPERATOR`, `ADMIN_BILLING`, `ADMIN_SUPPORT`, `ADMIN_AUDITOR`) are listed in §3.

### 1.5 Request and response format

- JSON only (`Content-Type: application/json`), UTF-8. Timestamps are ISO-8601 UTC (`2026-11-13T10:00:00.000Z`). Durations are in integer seconds (`intervalSec`) or milliseconds (`…Ms`).
- Single resource response: `{ "data": {...} }`.
- List response: `{ "data": [...], "nextCursor": "opaque" | null }`.
- **Pagination:** `?limit=` (default 25, max 100) and `?cursor=` (an opaque base64 of the sort key + ID). There is no offset pagination.
- **Sorting:** `?sort=field` or `?sort=-field` (descending), with an allowlist per endpoint.
- **Filtering:** explicit query parameters per endpoint (e.g. `?status=OPEN,ACKNOWLEDGED&severity=CRITICAL`). Multiple values are comma-separated. Free text is `?q=`.
- **Time ranges:** `?range=24h|7d|30d|60d` or `?from=&to=`. The server **clamps** ranges to the org's `retention.days`. When clamping happens, the response includes `meta: { clampedFrom, retentionDays }`.
- **Secrets are write-only.** Responses show `{ "configured": true, "last4": "…a9f2", "updatedAt": … }` and never the value.

### 1.6 Error envelope

```json
{ "error": { "code": "ENTITLEMENT_EXCEEDED", "message": "Your plan allows 5 websites.", "details": { "entitlement": "websites.max", "limit": 5, "current": 5 }, "requestId": "req_01J…" } }
```

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod validation failed. `details.issues[] = {path, message}`. |
| 400 | `INVALID_URL` | The URL could not be normalized (bad scheme, IP literal, reserved TLD, non-default port). |
| 401 | `UNAUTHENTICATED` | No session, or the session expired or was revoked |
| 401 | `SECOND_FACTOR_REQUIRED` | The session is partial, so 2FA must be completed |
| 403 | `FORBIDDEN` | Authenticated, but the role lacks the permission (only within the user's own org) |
| 403 | `CSRF_INVALID` | Missing or mismatched CSRF token, or the Origin check failed |
| 403 | `ACCOUNT_SUSPENDED` | The org or user was suspended by an admin |
| 403 | `EMAIL_NOT_VERIFIED` | The action requires a verified email |
| 404 | `NOT_FOUND` | The resource doesn't exist **or belongs to another tenant** |
| 409 | `CONFLICT` | Version conflict (`If-Match` mismatch) or an invalid state transition |
| 409 | `DOMAIN_ALREADY_REGISTERED` | An active claim exists for this identity. No owner info is disclosed. `details.transferAllowed`. |
| 409 | `DOMAIN_PENDING_CLAIM` | Another pending claim exists (it expires at `details.expiresAt`, which is only shown if it is the caller's own claim) |
| 409 | `INVALID_STATE_TRANSITION` | E.g. resolving an incident that is already resolved. `details.from`, `details.allowed[]`. |
| 402 | `ENTITLEMENT_EXCEEDED` | A quota limit was reached. `details.entitlement`, `limit`, `current`. |
| 402 | `FEATURE_NOT_IN_PLAN` | A feature flag is not in the plan. `details.feature`. |
| 402 | `SUBSCRIPTION_INACTIVE` | The org is read-only (expired or canceled) |
| 403 | `DOMAIN_BLOCKED` | The domain was blocked by the platform |
| 403 | `TRIAL_INELIGIBLE` | The domain has already consumed a trial (policy `REJECT` while trialing) |
| 403 | `OWNERSHIP_NOT_VERIFIED` | The action requires a verified website (deep scan, robots override, journeys) |
| 422 | `SSRF_BLOCKED_DESTINATION` | The URL resolves to a denied address range (private, loopback, link-local, metadata, …) |
| 422 | `HOST_NOT_AUTHORIZED` | The API endpoint host is not under a verified domain, not host-verified, and not allowlisted |
| 422 | `INTERVAL_BELOW_PLAN_MINIMUM` | The requested frequency is faster than the plan's minimum for that tier |
| 422 | `UNSAFE_TEST_STEP` | The test case contains a destructive step without approval |
| 422 | `JOURNEY_NOT_APPROVED` | The journey was edited after approval, or was never approved |
| 422 | `PAYMENT_GATEWAY_ERROR` | The gateway rejected the request. `details.gateway`, `gatewayCode`. |
| 429 | `RATE_LIMITED` | `Retry-After` header set. `details.limit`, `windowSec`. |
| 400 | `WEBHOOK_SIGNATURE_INVALID` | Webhooks only |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key with a different request body |
| 503 | `MAINTENANCE_MODE` | The platform is in maintenance (reads may still work) |
| 500 | `INTERNAL` | An unexpected error. The message is generic, and `requestId` enables log lookup. |

### 1.7 Idempotency

`Idempotency-Key: <uuid>` is **required** on: checkout creation, plan change apply, cancel and resume, refund (admin), "check now", report creation, and transfer requests. It is **optional** on other POSTs. Keys are stored for 24 h per `(orgId|adminId, route, key)` together with a request hash. A replay returns the stored response. A different body returns `409 IDEMPOTENCY_KEY_REUSED`.

### 1.8 Concurrency

Mutable config resources return an `ETag` (row version). A `PATCH` with `If-Match` rejects stale writes with `409 CONFLICT`. Without `If-Match` the write is last-write-wins. The admin UI always sends `If-Match`.

### 1.9 Rate limits (defaults; admin-configurable)

| Group | Limit | Key |
|---|---|---|
| `auth.login` | 5 / 15 min per account and 20 / 15 min per IP; progressive delay; lockout notice email after 10 | account + IP |
| `auth.register`, `auth.forgot` | 5 / hour per IP | IP |
| `auth.2fa` | 5 / 5 min per session | session |
| Customer API (reads) | 600 / min per user | user |
| Customer API (writes) | 120 / min per user | user |
| `check-now` | 10 / min per org, plus the plan's monthly execution quota | org |
| `verify` | 10 / hour per website | website |
| `reports` | 20 / day per org | org |
| Ingest | 100 req / min per IP; per site key: plan-derived events per minute and month | site key + IP |
| Admin API | 300 / min per admin | admin |
| Webhooks | 1000 / min per provider (Nginx) | provider |

The response headers are `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (IETF draft), plus `Retry-After` on 429.

### 1.10 Versioning

The URI major version is `/v1`. Additive changes (new fields or endpoints) are non-breaking, and clients must ignore unknown fields. Breaking changes ship as `/v2`, with `v1` supported for ≥ 6 months and `Deprecation` and `Sunset` headers added. The SDK protocol is versioned independently (`ingest /v1`, payload `"v": 1`).

---

## 2. Customer API (`/api/v1`)

### 2.1 Auth — implemented in Phase 2

> Status legend for this and the following Phase 2 sections: everything listed is **implemented and covered by
> `apps/api/test/integration/*`** unless marked *(planned)*. Deviations from the Phase 1 draft are listed in §2.0.

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/auth/csrf` | public | Issue (or return) the pre-session CSRF cookie `wim_csrf` |
| POST | `/auth/register` | public | Create a user. **Always 202** `{status:"VERIFICATION_SENT"}`; an existing email gets an "account exists" email instead (no enumeration) |
| POST | `/auth/verify-email` | public | `{token}` — single-use, 24 h (setting `auth.emailVerification.ttlHours`) |
| POST | `/auth/verify-email/resend` | session | 3 / hour per user |
| POST | `/auth/login` | public | `{email,password}` → `{status:"AUTHENTICATED", me}` or `{status:"SECOND_FACTOR_REQUIRED", mfaReset}` (partial session, 10 min) |
| POST | `/auth/logout` | partial or full | Revokes the current session server-side |
| POST | `/auth/2fa/verify` | partial | `{code}` (TOTP) **or** `{recoveryCode}` → rotates the session token, returns `me` |
| POST | `/auth/2fa/totp/enroll` | session | Returns `{otpauthUrl, secret, qrSvg}`; the pending secret is stored encrypted |
| POST | `/auth/2fa/totp/confirm` | session | `{code}` → `{recoveryCodes: string[10]}` (shown once); signs out other sessions |
| POST | `/auth/2fa/disable` | session | `{password, code}`; signs out other sessions |
| POST | `/auth/2fa/recovery-codes/regenerate` | session | `{code}`; previous codes stop working |
| GET | `/auth/2fa/reset` | partial or full | Lost-device reset status: `null` or `{id, status: PENDING_EMAIL|WAITING|READY, eligibleAt}` |
| POST | `/auth/2fa/reset/request` | **partial only** | Start the lost-authenticator reset (password already proven); emails a confirmation link |
| POST | `/auth/2fa/reset/confirm` | public | `{token}` from the email → waiting period starts (setting `auth.mfaReset.delayHours`, default 72 h); a notice with a cancel link is emailed |
| POST | `/auth/2fa/reset/cancel` | public / session | `{token}` from the notice email, or no body when signed in |
| POST | `/auth/2fa/reset/complete` | partial | After `eligibleAt`: removes the second factor, signs out everywhere else, signs in |
| POST | `/auth/password/forgot` | public | **Always 202**; 3 emails / hour per address |
| POST | `/auth/password/reset` | public | `{token, password}` — single-use, 30 min; revokes **all** sessions; 2FA stays on |
| POST | `/auth/password/change` | session | `{currentPassword, newPassword}`; revokes other sessions and rotates the current one |
| GET | `/auth/sessions` | session | Active sessions `{id, current, userAgent, ipPrefix, createdAt, lastSeenAt, expiresAt}` |
| DELETE | `/auth/sessions/:sessionId` | session | Revoke one session (effective on the next request) |
| DELETE | `/auth/sessions` | session | Revoke all except the current one → `{revoked}` |

```ts
// POST /auth/register
Req  { email, password: string(12..128; settings min length; not common; no email local part; HIBP k-anonymity check),
       name: string(1..100), acceptTerms: true, termsVersion: string /* must equal legal.termsVersion */, timezone?: IANA }
Res 202 { data: { status: "VERIFICATION_SENT" } }
// Errors: VALIDATION_FAILED, WEAK_PASSWORD, CONFLICT (terms version changed), REGISTRATION_CLOSED, RATE_LIMITED
```

**Login protection.** Per IP: `auth.login.perIpPer15Min`. Per account (keyed HMAC of the email, so unknown emails behave
identically): after `auth.login.failuresBeforeDelay` failures, exponential delay (30 s, 60 s, … ≤ 15 min, `429` +
`Retry-After`); after `auth.login.lockThreshold24h` failures in 24 h, a temporary lock (`auth.login.lockMinutes`) and an email
notice. Unknown emails run a dummy Argon2 verification so timing does not reveal registration.

### 2.0 Changes from the Phase 1 draft

| Draft | Implemented | Why |
|---|---|---|
| Register also creates the first org (`orgName`) | Register creates the user only; the org is created after email verification (`POST /orgs`) | Org creation requires a verified email; keeps registration enumeration-safe (always 202) |
| `POST /invitations/:token/accept` | `POST /invitations/accept {token}` or `{invitationId}` | Tokens never appear in URL paths (proxy/access logs). `invitationId` works only for the invitee's verified email (DB function) |
| Cookies `wim_session` / `__Host-wim_sid` | `wim_sid` / `wim_csrf` in dev; `__Host-` prefix when `COOKIE_SECURE=true` | One naming scheme for both environments |
| Admin login is two steps (partial session, then `/auth/2fa/verify`) | One step: `{email, password, code}` | Admins never hold a partially authenticated session |
| 2FA reset was unspecified | `/auth/2fa/reset/*` delayed, notified, cancellable flow | Required "account recovery workflow" without bypassing 2FA |

### 2.2 Me

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/me` | session | `{id, email, name, emailVerified, timezone, locale, twoFactor: {enabled, recoveryCodesRemaining}, orgs[]}` |
| PATCH | `/me` | session | `{name?, timezone?, locale?}` (audited) |
| GET | `/me/invitations` | session | Pending invitations for my **verified** email |
| GET | `/me/activity` | session | My security audit stream (logins, 2FA, password, sessions), cursor-paginated |
| POST | `/me/email/change` | session | *(planned, Phase 3)* |
| GET/PUT | `/me/notification-preferences…` | session | *(planned, Phase 7)* — shape below |

```ts
NotificationPreference {
  inApp: { minSeverity: Severity, enabled: boolean },
  sound: { minSeverity: Severity, enabled: boolean, volume: 0..1, repeatUntilAck: boolean },
  email: { minSeverity: Severity, enabled: boolean, digest: 'NONE'|'HOURLY'|'DAILY' },
  events: { created: bool, escalated: bool, resolved: bool, reopened: bool, sslExpiry: bool, billing: bool },
  quietHours?: { start: 'HH:mm', end: 'HH:mm', timezone, allowCritical: boolean }
}
Severity = 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'INFO'
```

### 2.3 Organizations

| Method | Path | Perm | Description |
|---|---|---|---|
| POST | `/orgs` | session + verified email | `{name, timezone?}` → caller becomes OWNER; a per-org data key is created; 10 / day |
| GET | `/orgs` | session | Orgs I belong to (with my role) |
| GET | `/orgs/:orgId` | org:read | Org details and `myRole {id, key, name, permissions[]}` |
| PATCH | `/orgs/:orgId` | org:update | `{name?, timezone?, supportAccess?}` — audited with a before/after diff |
| POST | `/orgs/:orgId/deletion` | org:delete | Schedule deletion (14-day grace; purge job is Phase 10) |
| DELETE | `/orgs/:orgId/deletion` | org:delete | Cancel scheduled deletion |
| POST | `/orgs/:orgId/transfer-ownership` | org:transfer_ownership | `{memberId}` → target becomes OWNER, caller becomes ADMIN |
| POST/GET | `/orgs/:orgId/exports…` | data:export | *(planned, Phase 10)* |

### 2.4 Members, invitations and roles

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/members` | member:read | `{id, userId, name, email, twoFactorEnabled, role, joinedAt, isMe}` |
| PATCH | `/orgs/:orgId/members/:memberId` | member:manage | `{roleId}`; escalation rules below |
| DELETE | `/orgs/:orgId/members/:memberId` | member:manage | Remove a member |
| POST | `/orgs/:orgId/leave` | any member | Leave (blocked for the last owner: `LAST_OWNER`) |
| GET | `/orgs/:orgId/invitations` | member:manage | Pending invitations |
| POST | `/orgs/:orgId/invitations` | member:manage | `{email, roleId}`; 50 / day per org; the email worker issues the token |
| POST | `/orgs/:orgId/invitations/:invitationId/resend` | member:manage | Re-send with a **new** token (old links stop working) |
| DELETE | `/orgs/:orgId/invitations/:invitationId` | member:manage | Revoke |
| GET | `/invitations/preview?token=` | public | `{orgName, roleName, email, expiresAt}` |
| POST | `/invitations/accept` | session + verified email | `{token}` or `{invitationId}`; invitation email must equal my verified email |
| POST | `/invitations/decline` | session | Same body |
| GET | `/permissions` | session | Permission catalog `{key, description}[]` |
| GET | `/orgs/:orgId/roles` | member:read | System + custom roles with permissions and member counts |
| POST | `/orgs/:orgId/roles` | role:manage | `{name, description?, permissions[]}` → key `custom:<slug>` |
| PATCH | `/orgs/:orgId/roles/:roleId` | role:manage | Custom roles only (system roles → 404) |
| DELETE | `/orgs/:orgId/roles/:roleId` | role:manage | Only when unused (409 otherwise) |

**Escalation rules** (`@wim/core` `rbac/policy.ts`, enforced in the API; the starred ones also in the database):
nobody assigns OWNER except through ownership transfer; you cannot grant a permission you do not hold; admins cannot
change or remove an owner; nobody changes their own role; custom roles never carry owner-only permissions (`org:delete`,
`org:transfer_ownership`, `billing:manage`, `data:export`)\*; a member can only hold a system role or a role of the same
org\*; an org always keeps at least one owner\*.

### 2.5 Websites, verification, SDK installation and transfers — implemented in Phase 3

All routes are under `/api/v1/orgs/:orgId`, enter the tenant through `app_enter_org` (DB-enforced membership), and
return `404` for websites of other organizations. Every mutation is audited in the org stream (`website.*`, `transfer.*`).

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/websites` | website:read | `WebsiteSummaryDto[]`: name, displayHost, verification, installation state, trial outcome, created, last activity |
| POST | `/websites/preview` | website:write | `{url}` → normalized identity, notes (www alias / subdomain / IDN), availability `AVAILABLE|YOURS|CLAIMED_ELSEWHERE|PENDING_ELSEWHERE|BLOCKED` (never who holds it) |
| POST | `/websites` | website:write + verified email | `{name, url, description?, category, monitoringTimezone?}` → `WebsiteDetailDto` (pending claim, 72 h window, verification instructions, site key, snippet). 20 / h per org |
| GET | `/websites/:websiteId` | website:read | `WebsiteDetailDto` (claim, instructions while pending, installation, pending incoming transfer, org trial) |
| PATCH | `/websites/:websiteId` | website:write | `{name?, description?, category?, monitoringTimezone?}` (audited diff) |
| POST | `/websites/:websiteId/delete` | website:delete | `{confirmHost}` must equal the domain. Archives the website, releases the claim, revokes the site key. History and the trial ledger are kept |
| POST | `/websites/:websiteId/verify` | website:write | `{method: DNS_TXT|WELL_KNOWN_FILE|HTML_META|ANY}` → `202 {jobId, queue}`. Pending claims: verification (`queue: "verify"`). **Failing or lapsed** claims (Phase 4A): an immediate ownership re-check with the original method (`queue: "revalidate"`); success restores monitoring. 10 / h per website and 50 per token |
| POST | `/websites/:websiteId/verification/token` | website:write | New token; the previous proof stops working; the expiry is **not** extended |
| POST | `/websites/:websiteId/verification/restart` | website:write | Only after expiry, only if the identity is still free → new claim, token and window |
| GET | `/websites/:websiteId/verifications` | website:read | Verification history `{method, status, failureReason, detail, scopeGranted, requestedAt}` |
| GET | `/websites/:websiteId/registration-history` | website:read | This org's claims and registration attempts for the identity |
| GET | `/websites/:websiteId/audit` | audit:read | Audit entries targeting the website |
| POST | `/websites/:websiteId/installation/check` | website:write | Server-side diagnostic: fetches the home page (SSRF-safe), looks for the SDK tag and key, probes the SDK URL → stored as `install.lastCheck`. **Never** marks the SDK installed |
| POST | `/websites/:websiteId/site-key/regenerate` | website:write | New key; previous key accepted for `sdk.keyRotationGraceHours` (default 24 h) |
| POST | `/websites/:websiteId/site-key/revoke` | website:write | Revoke immediately (no grace); snippet hidden until regenerated |
| POST | `/websites/:websiteId/telemetry/pause` / `resume` | website:write | Pause SDK event storage (heartbeats continue so installation status stays correct) |
| PATCH | `/websites/:websiteId/sdk-config` | website:write | Strict schema: `captureErrors, captureResourceErrors, captureVitals, captureApiFailures, errorSampleRate, vitalsSampleRate, requireConsent, respectGlobalPrivacyControl, maskPatterns[]` (unknown keys → 400) |
| GET | `/domain-transfers` | website:read | Transfers **requested by** this org, with the DNS record to publish |
| POST | `/domain-transfers` | website:write + verified email | `{url}` — only against another org's **verified** claim. 5 / day per org |
| POST | `/domain-transfers/:transferId/verify` | website:write | Check the requester's DNS record (`_<prefix>-verification.<host>` TXT `<prefix>-transfer=<token>`); on success → `PENDING_ADMIN`, owner notified |
| POST | `/domain-transfers/:transferId/cancel` | website:write | Requester cancels |
| GET | `/domain-transfers/incoming` | website:read | Requests against this org's domains: status, deadline — **no requester identity** |
| POST | `/domain-transfers/incoming/:transferId/contest` | website:write | Current owner contests (shown to the reviewing admin) |

**Ownership revalidation (Phase 4A).** `WebsiteDetailDto.claim.revalidation` (verified/lapsed claims):
`{state: OK|FAILING|LAPSED, lastCheckedAt, lastOutcome, nextCheckAt, failingSince, lapsesAt, releaseAt}`. While a claim is
FAILING or LAPSED, `instructions` are returned again so the customer can restore the original proof. Website `status`
becomes `LAPSED` (monitoring suspended) and returns to `ACTIVE` on success.

**Registration outcomes.** `201` created (or `INHERITED_VERIFIED` when the org already DNS-verified the registrable domain and
policy is `ROOT_EXCLUSIVE`); `409 CONFLICT` (already yours, `details.websiteId`); `409 DOMAIN_ALREADY_REGISTERED` (another org,
or the registrable domain's namespace is reserved; `details.canRequestTransfer`); `403 DOMAIN_BLOCKED`; `429 WEBSITE_LIMIT`
(`websites.maxPendingPerOrg` unverified websites); `400 INVALID_URL` (`details.reason`: `IP_ADDRESS`, `RESERVED_NAME`,
`NON_DEFAULT_PORT`, `UNSUPPORTED_SCHEME`, `CREDENTIALS_IN_URL`, `NO_REGISTRABLE_DOMAIN`, …).

**Verification failure reasons** (`domain_verifications.failure_reason`): `DNS_RECORD_NOT_FOUND`, `DNS_PROPAGATING` (some
resolvers see it), `DNS_UNAVAILABLE`, `HTTP_<status>`, `TOKEN_NOT_FOUND_IN_FILE`, `META_TAG_NOT_FOUND`, `META_TOKEN_MISMATCH`,
`BLOCKED_DESTINATION` (resolves to a private/reserved/metadata address), `REDIRECTS_OFF_SITE`, `HOST_NOT_FOUND`,
`SITE_UNREACHABLE`, `TOKEN_ROTATED`, `VERIFICATION_EXPIRED`, `CLAIM_CHANGED`.

```ts
// Verification instructions (pending claims only)
{ value: "sitesentinel-verification=<43-char token>", token,
  dns:  { hostRecord: { type: "TXT", name: "_sitesentinel-verification.<host>", value },
          rootRecord: { type: "TXT", name: "_sitesentinel-verification.<registrable domain>", value } }, // root also reserves subdomains
  file: { url: "https://<host>/.well-known/sitesentinel-verification.txt", content: value },             // exact line
  meta: { tag: '<meta name="sitesentinel-verification" content="<token>">' } }                         // inside <head>

// Installation states (derived from heartbeats, never from script downloads)
NOT_INSTALLED | DETECTED (valid heartbeat, < sdk.minHeartbeatsForActive page loads) | ACTIVE |
INACTIVE (no valid heartbeat within sdk.activeWindowHours) | INVALID_CONFIGURATION (latest signal rejected: ORIGIN_MISMATCH, REVOKED_KEY, EXPIRED_KEY, WEBSITE_NOT_VERIFIED)
```

### 2.5a SDK ingest (`INGEST_URL`, apps/ingest) — implemented in Phase 3

| Method | Path | Description |
|---|---|---|
| GET | `/sdk/monitor.v1.js`, `/sdk/monitor.<x.y.z>.js` | SDK (major alias: 5 min cache; exact version: immutable; SRI hash in `@wim/sdk` manifest) |
| GET | `/v1/config/:siteKey` | Remote config `{v, enabled, heartbeat, …SdkConfig}`; `{enabled:false, heartbeat:false}` for unknown/unverified/revoked keys |
| POST | `/v1/collect` | `text/plain` JSON `{v:1, k, sv, pl, hb, ctx, events[≤50]}`, ≤ 64 KB. **Always `204`** (no key/website oracle) |

A heartbeat is accepted only if the key is current (or within rotation grace), the website is verified, and the browser
`Origin` normalizes to the website's identity (`www.` alias allowed, port ignored, other subdomains rejected). Page loads
(`pl`) and events (`pl`+`seq`) are deduplicated for 1 h. Events are re-sanitised server-side (emails, card-like numbers,
long digit runs, token-like strings masked; query strings dropped; per-type field allow-list). Rate limits: `ingest.perIpPerMinute`,
`ingest.perKeyPerMinute`. The `Origin` header can be forged by non-browser clients, so telemetry is never accepted as proof
of ownership.

### 2.6 Monitoring configuration

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/monitoring-config` | website:read | Effective config plus `limits` (resolved entitlements) for UI bounds. `ETag`. |
| PATCH | `/orgs/:orgId/websites/:websiteId/monitoring-config` | monitoring:write | Partial update, validated against entitlements. Applies on the next scheduler tick. |
| POST | `/orgs/:orgId/websites/:websiteId/monitoring-config/reset` | monitoring:write | Reset to the plan-recommended defaults |
| GET | `/orgs/:orgId/websites/:websiteId/maintenance-windows` | website:read | List |
| POST | `/orgs/:orgId/websites/:websiteId/maintenance-windows` | monitoring:write | One-off or recurring (RRULE). Org-wide windows: `/orgs/:orgId/maintenance-windows`. |
| PATCH/DELETE | `/orgs/:orgId/websites/:websiteId/maintenance-windows/:windowId` | monitoring:write | Update or delete |
| GET | `/orgs/:orgId/websites/:websiteId/auth-recipes` | website:read | List login recipes (secrets masked) |
| POST | `/orgs/:orgId/websites/:websiteId/auth-recipes` | secret:write | Requires the `features.authenticatedMonitoring` entitlement + a verified website |
| PATCH/DELETE | `/orgs/:orgId/websites/:websiteId/auth-recipes/:recipeId` | secret:write | Update (secrets replaced only if provided) or delete (crypto-shred) |
| POST | `/orgs/:orgId/websites/:websiteId/auth-recipes/:recipeId/test` | secret:write | Run the login once in a browser. Returns 202 `{ executionId }`. |
| GET/PUT | `/orgs/:orgId/websites/:websiteId/incident-rules` | website:read / monitoring:write | Per-website overrides of incident rules (requires the `incidents.customRules` entitlement) |

```ts
MonitoringConfig {
  tier1: { enabled: boolean, intervalSec: int, urls: Url[] (same identity, ≤ plan), keyword?: { mustContain?: string, mustNotContain?: string },
           timeoutMs: 1000..30000, confirmRetry: boolean },
  ssl:   { enabled: boolean, warnDays: int[] /* default [30,14,7,1] */ },
  tier2: { enabled: boolean, intervalSec: int, pageSelection: 'AUTO'|'PINNED_ONLY', maxPages: int, viewport: ViewportId },
  tier3: { enabled: boolean, intervalSec: int, viewports: ViewportId[], componentTests: boolean, responsiveTests: boolean,
           journeys: boolean, captureArtifacts: 'ON_FAILURE'|'NEVER' },
  crawl: { respectRobotsTxt: boolean /* false only if ownership verified */, maxDepth: 1..10, maxPages: int,
           include: Pattern[], exclude: Pattern[], queryParams: 'IGNORE_ALL'|'KEEP_ALL'|{ allowlist: string[] },
           extraTrackingParams: string[], seedUrls: Url[], followSitemaps: boolean },
  performance: { thresholds: { lcpMs: {good, poor}, fcpMs: {...}, cls: {...}, tbtMs: {...}, ttfbMs: {...}, pageWeightKb?: int, requestCount?: int } },
  privacy: { maskSelectors: string[] /* applied to screenshots */, storeResponseSamples: boolean },
  destructiveDenyList: { extraPatterns: string[] }   // added to platform defaults; cannot remove defaults
}
ViewportId = 'mobile-375'|'mobile-390'|'tablet-768'|'laptop-1366'|'desktop-1920'|{ custom: { width, height, deviceScaleFactor, isMobile } }   // >1 viewport or custom requires features.responsiveTests
Pattern    = { type: 'GLOB'|'REGEX'|'PREFIX', value: string(max 500) }   // REGEX validated with re2 (no catastrophic backtracking)
// PATCH errors: INTERVAL_BELOW_PLAN_MINIMUM, FEATURE_NOT_IN_PLAN, ENTITLEMENT_EXCEEDED(pages.maxPerWebsite), OWNERSHIP_NOT_VERIFIED (robots override)

AuthRecipe (POST) {
  name, loginUrl: Url (same identity), steps: TestStep[] /* DSL, fill uses {{secret:username}} refs */,
  secrets: { username: string, password: string, totpSeed?: string } /* write-only, encrypted */,
  successCheck: { selector?: string, urlMatches?: Pattern }, appliesTo: Pattern[]
}
```

### 2.7 Pages

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/pages` | website:read | Monitored pages with latest status per tier, LCP, error count. Filters: `status, q, template`. |
| GET | `/orgs/:orgId/websites/:websiteId/pages/discovered` | website:read | All discovered pages (source: sitemap / crawl / manual, depth, firstSeen, lastSeen, `STALE` flag, `monitored`) |
| POST | `/orgs/:orgId/websites/:websiteId/pages` | monitoring:write | Manually add URLs `{ urls: Url[] ≤ 100 }` (same identity; counts toward the limit) |
| POST | `/orgs/:orgId/websites/:websiteId/pages/:pageId/pin` | monitoring:write | Pin: always monitored, prioritized for T2 |
| DELETE | `/orgs/:orgId/websites/:websiteId/pages/:pageId/pin` | monitoring:write | Unpin |
| POST | `/orgs/:orgId/websites/:websiteId/pages/:pageId/exclude` | monitoring:write | Stop monitoring and add to crawl exclusions |
| GET | `/orgs/:orgId/websites/:websiteId/pages/:pageId` | website:read | Page detail: latest results per viewport, components, performance trend, open incidents |
| GET | `/orgs/:orgId/websites/:websiteId/pages/:pageId/results` | website:read | Result history (raw ≤ 14 d, then rollups). `?tier=&viewport=&range=`. |
| GET | `/orgs/:orgId/websites/:websiteId/pages/:pageId/results/:resultId` | website:read | Full result: console errors, failed requests, vitals, responsive findings, artifact links (presigned, 5 min) |
| POST | `/orgs/:orgId/websites/:websiteId/discovery/run` | monitoring:write | Trigger discovery crawl now (`Idempotency-Key`; counts toward the execution quota) |

### 2.8 Components, test cases and journeys

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/components` | website:read | Detected component instances `{ type, selector, confidence, evidence[], pages[], lastResult, coverage: 'TESTED'|'DETECTED_NOT_TESTED' }` |
| PATCH | `/orgs/:orgId/websites/:websiteId/components/:componentId` | monitoring:write | Confirm (`confidence→1`), mark as false positive, set importance (affects severity), disable tests |
| POST | `/orgs/:orgId/websites/:websiteId/components` | monitoring:write | Declare a component by selector `{ type, selector, pagePattern, importance }` |
| GET | `/orgs/:orgId/websites/:websiteId/test-cases` | website:read | Built-in (read-only, toggleable) + custom test cases |
| POST | `/orgs/:orgId/websites/:websiteId/test-cases` | monitoring:write | Create a custom test case (DSL). Destructive steps → `safety: REQUIRES_APPROVAL`. |
| PATCH/DELETE | `/orgs/:orgId/websites/:websiteId/test-cases/:testCaseId` | monitoring:write | Edit (resets approval if the steps hash changes) or delete |
| POST | `/orgs/:orgId/websites/:websiteId/test-cases/:testCaseId/approve` | journey:approve | `{ stepsHash, allowedHosts: string[], acknowledgement: literal('I confirm these steps are safe to run repeatedly against the listed hosts') }` |
| DELETE | `/orgs/:orgId/websites/:websiteId/test-cases/:testCaseId/approve` | journey:approve | Revoke approval |
| POST | `/orgs/:orgId/websites/:websiteId/test-cases/:testCaseId/run` | monitoring:write | Dry-run now → 202 `{ executionId }` |
| GET | `/orgs/:orgId/websites/:websiteId/test-cases/:testCaseId/results` | website:read | Result history |

```ts
TestCase {
  name, appliesTo: { componentType?: ComponentType, selector?: string, pagePattern?: Pattern, journey?: { startUrl: Url } },
  steps: TestStep[] (≤ 50),
  assertions: TestAssertion[],
  severityOnFail: Severity, enabled: boolean
}
TestStep =
  | { op: 'goto', url: Url /* same identity or approved host */ }
  | { op: 'click' | 'hover', selector } | { op: 'fill', selector, value: TestValue } | { op: 'press', key }
  | { op: 'select', selector, value: string } | { op: 'waitFor', selector?, ms?: ≤ 10000 }
  | { op: 'expectVisible' | 'expectHidden', selector } | { op: 'expectUrl', pattern: Pattern }
  | { op: 'expectText', selector, contains: string } | { op: 'expectCount', selector, min?, max? } | { op: 'screenshot', name }
TestValue = { literal: string(max 200) } | { generator: 'email'|'name'|'phone'|'text' } | { secretRef: string }
// Server rejects: javascript:/data: URLs, steps targeting submit buttons/destructive deny-list without approval (UNSAFE_TEST_STEP).
```

### 2.9 API endpoints

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/api-endpoints` | website:read | List (`?websiteId=&status=`) with latest status, uptime over 24 h, p95 |
| POST | `/orgs/:orgId/api-endpoints` | monitoring:write | Create (checks the `api.maxEndpoints` entitlement, host authorization, SSRF) |
| GET | `/orgs/:orgId/api-endpoints/:endpointId` | website:read | Detail (secrets masked) |
| PATCH | `/orgs/:orgId/api-endpoints/:endpointId` | monitoring:write | Update (`If-Match`) |
| DELETE | `/orgs/:orgId/api-endpoints/:endpointId` | monitoring:write | Delete (crypto-shreds credentials) |
| POST | `/orgs/:orgId/api-endpoints/:endpointId/pause` / `resume` | monitoring:write | Pause or resume |
| PUT | `/orgs/:orgId/api-endpoints/:endpointId/credentials` | secret:write | Write-only credential set or replace |
| DELETE | `/orgs/:orgId/api-endpoints/:endpointId/credentials` | secret:write | Remove credentials |
| POST | `/orgs/:orgId/api-endpoints/:endpointId/test` | monitoring:write | Run now → 202 `{ executionId }` (`Idempotency-Key`). Poll the execution or wait for the WS event. |
| POST | `/orgs/:orgId/api-endpoints/test-draft` | monitoring:write | Run an unsaved definition once (same validation; credentials inline, never stored) |
| GET | `/orgs/:orgId/api-endpoints/:endpointId/results` | website:read | Result history: status, timings, assertion outcomes (redacted) |
| GET | `/orgs/:orgId/api-endpoints/:endpointId/results/:resultId` | website:read | Full result (response sample only if `storeResponseSamples`) |
| GET | `/orgs/:orgId/api-hosts` | website:read | Host authorization status for hosts in use |
| POST | `/orgs/:orgId/api-hosts` | monitoring:write | Start host verification for a third-party host (`{ host }` → DNS/well-known token) |
| POST | `/orgs/:orgId/api-hosts/:hostId/verify` | monitoring:write | Check host verification |

```ts
// POST /orgs/:orgId/api-endpoints
Req {
  websiteId: uuid, name: string(1..100),
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',
  url: Url /* https recommended; http allowed */, query?: Record<string,string>,
  headers?: { name: string, value: string, secret?: boolean }[] (≤ 30; Host/Content-Length/Connection rejected),
  body?: { type: 'JSON', json: unknown } | { type: 'FORM', fields: Record<string,string> } | { type: 'RAW', contentType: string, text: string(max 64KB) },
  auth?: { type: 'NONE' } | { type: 'BEARER' } | { type: 'BASIC' } | { type: 'API_KEY', in: 'HEADER'|'QUERY', name: string }
       | { type: 'OAUTH2_CLIENT_CREDENTIALS', tokenUrl: Url, scope?: string },
  credentials?: { token?: string, username?: string, password?: string, apiKey?: string, clientId?: string, clientSecret?: string }, // write-only
  intervalSec: int, timeoutMs: 1000..30000, retry: { attempts: 0..3, backoffMs: 500..10000 },
  followRedirects: boolean, maxResponseBytes?: ≤ 2MB,
  assertions: Assertion[] (≤ 20),
  mutatingAcknowledged?: boolean   // required true for non-GET to a non-owned host
}
Assertion =
  | { type: 'STATUS', in: int[] } | { type: 'NOT_SERVER_ERROR' }
  | { type: 'RESPONSE_TIME', lessThanMs: int }
  | { type: 'HEADER', name, op: 'EQUALS'|'CONTAINS'|'EXISTS', value? }
  | { type: 'BODY_CONTAINS', value: string(max 500) }
  | { type: 'JSON_PATH', path: string /* JSONPath subset */, op: 'EXISTS'|'NOT_EXISTS'|'EQUALS'|'CONTAINS'|'MATCHES'|'GT'|'LT'|'TYPE', value? }
  | { type: 'JSON_SCHEMA', schema: object (≤ 32KB, draft 2020-12) }          // requires features.apiAdvancedAssertions
Res 201 { data: ApiEndpoint /* credentials → { configured: true, fields: ['token'], updatedAt } */ }
// Errors: SSRF_BLOCKED_DESTINATION, HOST_NOT_AUTHORIZED, ENTITLEMENT_EXCEEDED(api.maxEndpoints), INTERVAL_BELOW_PLAN_MINIMUM, FEATURE_NOT_IN_PLAN
```

### 2.10 Executions

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/executions` | website:read | Execution ledger: `?websiteId=&kind=PROBE_HTTP|PROBE_API|BROWSER_RENDER|DEEP_SCAN|VERIFY|DISCOVERY&status=&range=` |
| GET | `/orgs/:orgId/executions/:executionId` | website:read | Detail: timing (queued/started/finished), attempt, worker region, summary counters, linked results, emitted signals |
| POST | `/orgs/:orgId/websites/:websiteId/check-now` | website:write | `{ kind: 'PROBE_HTTP'|'BROWSER_RENDER'|'DEEP_SCAN', pageIds?: uuid[] }` → 202 `{ executionIds }` (`Idempotency-Key`; quota-checked) |
| POST | `/orgs/:orgId/executions/:executionId/cancel` | website:write | Cancel a queued or running execution (removes it from the queue or signals a running worker) |

`Execution.status = 'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'TIMED_OUT'|'CANCELLED'|'SKIPPED'`. `FAILED` means **the platform** failed to run the check. A target failure is `SUCCEEDED` with `outcome: 'FAIL'`.

### 2.11 Incidents

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/incidents` | incident:read | Filters: `status, severity, category, websiteId, apiEndpointId, pageId, q, flapping, range, sort=-lastSeenAt` |
| GET | `/orgs/:orgId/incidents/summary` | incident:read | Counts by status and severity (dashboard badges) |
| GET | `/orgs/:orgId/incidents/:incidentId` | incident:read | Full incident: fingerprint, affected scope, occurrence count, first/last seen, severity history, diagnostics (redacted), related executions |
| GET | `/orgs/:orgId/incidents/:incidentId/timeline` | incident:read | Ordered events: CREATED, OCCURRENCE (aggregated per hour), ESCALATED, ACKNOWLEDGED, STATUS_CHANGED, COMMENTED, NOTIFIED, RESOLVED, REOPENED, FLAPPING_STARTED/ENDED |
| GET | `/orgs/:orgId/incidents/:incidentId/occurrences` | incident:read | Paginated occurrences (execution ID, page, viewport, observedAt, details) |
| POST | `/orgs/:orgId/incidents/:incidentId/transitions` | incident:write | Change status (see below). `If-Match` supported. |
| PATCH | `/orgs/:orgId/incidents/:incidentId` | incident:write | Severity override, assignee (member ID), title |
| GET | `/orgs/:orgId/incidents/:incidentId/comments` | incident:read | List comments |
| POST | `/orgs/:orgId/incidents/:incidentId/comments` | incident:write | `{ body: markdown(max 10k) }`. Rendered server-side with sanitization. |
| PATCH/DELETE | `/orgs/:orgId/incidents/:incidentId/comments/:commentId` | incident:write (author or ADMIN) | Edit or delete (soft delete; the event is kept) |
| POST | `/orgs/:orgId/incidents/bulk-transitions` | incident:write | `{ incidentIds: uuid[] ≤ 100, action, note? }` → per-item results |
| GET | `/orgs/:orgId/incidents/export` | report:create | CSV stream of a filtered list (clamped to retention) |

```ts
// POST /orgs/:orgId/incidents/:incidentId/transitions
Req { action: 'ACKNOWLEDGE'|'INVESTIGATE'|'RESOLVE'|'IGNORE'|'REOPEN', note?: string(max 2000),
      ignore?: { scope: 'THIS_INCIDENT'|'FINGERPRINT', until?: datetime } }
Res 200 { data: { incident: Incident, event: IncidentEvent } }

Allowed transitions (else 409 INVALID_STATE_TRANSITION):
  OPEN          → ACKNOWLEDGED | INVESTIGATING | RESOLVED | IGNORED
  ACKNOWLEDGED  → INVESTIGATING | RESOLVED | IGNORED
  INVESTIGATING → RESOLVED | IGNORED
  REOPENED      → ACKNOWLEDGED | INVESTIGATING | RESOLVED | IGNORED
  RESOLVED      → REOPENED (manual)            // automatic reopen is done by worker-incident
  IGNORED       → OPEN (un-ignore)
Manual RESOLVE marks resolution 'MANUAL'; if the next check fails within the reopen window the incident auto-reopens.
ACKNOWLEDGE stops repeat sound alerts for all members.
```

### 2.12 Notifications

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/notifications` | org:read | My in-app notifications (`?unread=true`) |
| GET | `/orgs/:orgId/notifications/unread-count` | org:read | Badge count |
| POST | `/orgs/:orgId/notifications/:notificationId/read` | org:read | Mark read |
| POST | `/orgs/:orgId/notifications/read-all` | org:read | Mark all read |
| GET | `/orgs/:orgId/notification-channels` | notification:manage | Org-level channels (email recipient lists now; Slack/Teams/SMS/WhatsApp later) |
| POST | `/orgs/:orgId/notification-channels` | notification:manage | `{ kind: 'EMAIL', name, targets: email[], minSeverity, websiteIds?: uuid[], events }`. Recipient count ≤ `notifications.maxRecipients`. External recipients get a confirmation email before they receive alerts. |
| PATCH/DELETE | `/orgs/:orgId/notification-channels/:channelId` | notification:manage | Update or delete |
| POST | `/orgs/:orgId/notification-channels/:channelId/test` | notification:manage | Send a test notification (rate limited) |
| GET | `/orgs/:orgId/notification-deliveries` | notification:manage | Delivery logs: `?status=SENT|FAILED|BOUNCED|SUPPRESSED&channelId=&incidentId=` |
| GET | `/notification-unsubscribe/:token` / POST | public | One-click unsubscribe for external email recipients (RFC 8058) |

### 2.13 Analytics

All analytics endpoints accept `range` or `from`/`to`, clamped to retention (`meta.clampedFrom`). Responses state their `granularity` (`RAW|HOUR|DAY`), chosen per ARCHITECTURE §15.

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/analytics/overview` | analytics:read | Total websites, online, with issues, monitored pages, APIs, open/critical incidents, overall uptime, average response time, recent alerts (10), latest activity (10) |
| GET | `/orgs/:orgId/websites/:websiteId/analytics/uptime` | analytics:read | Uptime %, downtime duration, outage list, time series (`buckets[] {t, up, total, downtimeSec}`) |
| GET | `/orgs/:orgId/websites/:websiteId/analytics/response-time` | analytics:read | avg/p50/p95/max series, slowest URLs |
| GET | `/orgs/:orgId/websites/:websiteId/analytics/performance` | analytics:read | Web vitals series per metric and viewport (`?metric=LCP,CLS&viewport=`), synthetic vs RUM (`source=SYNTHETIC|RUM`) |
| GET | `/orgs/:orgId/websites/:websiteId/analytics/pages` | analytics:read | Per-page availability, error counts, most problematic pages |
| GET | `/orgs/:orgId/websites/:websiteId/analytics/checks` | analytics:read | Successful vs failed checks by tier |
| GET | `/orgs/:orgId/analytics/apis` | analytics:read | Per endpoint: uptime, p50/p95, failure rate, status distribution (`?websiteId=&endpointId=`) |
| GET | `/orgs/:orgId/api-endpoints/:endpointId/analytics` | analytics:read | Endpoint-level series and status histogram |
| GET | `/orgs/:orgId/analytics/errors` | analytics:read | Total/open/resolved/recurring incidents, critical count, frequency series, top pages, top APIs, top JS error fingerprints (SDK + synthetic) |
| GET | `/orgs/:orgId/websites/:websiteId/health-score` | analytics:read | Current score with breakdown |
| GET | `/orgs/:orgId/websites/:websiteId/health-score/history` | analytics:read | Score series |
| GET | `/health-score/methodology` | session | Current platform methodology (weights, curves, bands, version), for display |

```ts
// GET …/health-score
Res { data: {
  score: 96 | null, band: 'HEALTHY'|'DEGRADED'|'UNHEALTHY'|'INSUFFICIENT_DATA', cappedByCriticalIncident: boolean,
  window: { from, to }, configVersion: 7, coveragePct: 86,
  components: [ { key: 'availability', score: 100, weight: 30, effectiveWeight: 35.3, samples: 288, included: true },
                { key: 'responsive',   score: null, weight: 10, included: false, reason: 'NOT_IN_PLAN' }, … ],
  computedAt
}}
```

### 2.14 Reports

| Method | Path | Perm | Description |
|---|---|---|---|
| POST | `/orgs/:orgId/reports` | report:create | `{ type: 'WEBSITE_HEALTH'|'UPTIME'|'API_HEALTH'|'INCIDENTS'|'PERFORMANCE'|'MONTHLY_SUMMARY', format: 'PDF'|'CSV', websiteIds?: uuid[], range }` → 202 `{ reportId }` (`Idempotency-Key`; PDF requires `features.reportsPdf`) |
| GET | `/orgs/:orgId/reports` | analytics:read | List generated reports (they expire after 30 days) |
| GET | `/orgs/:orgId/reports/:reportId` | analytics:read | Status `QUEUED|RENDERING|READY|FAILED` |
| GET | `/orgs/:orgId/reports/:reportId/download` | analytics:read | 302 to a presigned URL (5 min) |
| GET/PUT | `/orgs/:orgId/report-schedules` | report:create | Optional scheduled monthly summary emailed to recipients |

### 2.15 Billing

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/plans` | public | Visible, active plans with prices (by currency) and entitlement highlights |
| GET | `/orgs/:orgId/subscription` | billing:read | Status, plan, price, period, trial (start/end/days left), grace period end, cancel-at-period-end, gateway |
| GET | `/orgs/:orgId/usage` | billing:read | Usage vs entitlements: websites, pages, APIs, members, recipients, browser-minutes, SDK events, executions this period |
| GET | `/orgs/:orgId/entitlements` | org:read | Resolved entitlements (also used for UI gating; the backend enforces them regardless) |
| POST | `/orgs/:orgId/billing/checkout` | billing:manage | Start a subscription purchase (`Idempotency-Key`) |
| POST | `/orgs/:orgId/billing/change-plan/preview` | billing:manage | `{ planPriceId }` → proration amount, effective date, limit violations (for downgrades: lists of items to deselect) |
| POST | `/orgs/:orgId/billing/change-plan` | billing:manage | `{ planPriceId, keep?: { websiteIds, apiEndpointIds } }` (`Idempotency-Key`). Upgrades are immediate; downgrades apply at period end by default. |
| POST | `/orgs/:orgId/billing/cancel` | billing:manage | `{ atPeriodEnd: true (default), reason?, feedback? }` |
| POST | `/orgs/:orgId/billing/resume` | billing:manage | Undo a pending cancellation |
| GET | `/orgs/:orgId/billing/invoices` | billing:read | Invoices (number, date, amount, tax, status) |
| GET | `/orgs/:orgId/billing/invoices/:invoiceId/download` | billing:read | Gateway-hosted PDF or our generated PDF (presigned) |
| GET | `/orgs/:orgId/billing/payment-methods` | billing:read | Brand, last4, expiry (from the gateway; no PAN ever) |
| POST | `/orgs/:orgId/billing/portal` | billing:manage | Stripe Billing Portal URL, or the Razorpay card-update flow (`{ redirectUrl }`) |
| PATCH | `/orgs/:orgId/billing/details` | billing:manage | Billing name, address, tax ID (GSTIN/VAT), billing email |

```ts
// POST /orgs/:orgId/billing/checkout
Req { planPriceId: uuid, couponCode?: string, returnUrl: relative path }
Res 200 { data:
   { gateway: 'stripe', mode: 'REDIRECT', redirectUrl: 'https://checkout.stripe.com/…' }
 | { gateway: 'razorpay', mode: 'CLIENT', subscriptionId: 'sub_…', keyId: 'rzp_live_…' /* public key id only */, prefill: { name, email } } }
// Access is granted ONLY when the verified webhook arrives; the UI polls GET /subscription or waits for WS `subscription.updated`.
// Errors: PAYMENT_GATEWAY_ERROR, CONFLICT (already subscribed → use change-plan), VALIDATION_FAILED
```

### 2.16 Audit

| Method | Path | Perm | Description |
|---|---|---|---|
| GET | `/orgs/:orgId/audit-logs` | audit:read | Org audit trail: actor (member or "Platform support (break-glass)"), action, target, IP prefix, timestamp. Filters: `action, actorId, range`. |
| GET | `/orgs/:orgId/audit-logs/export` | audit:read | CSV *(planned, Phase 10)* |
| GET | `/orgs/:orgId/support-access` | org:read | Break-glass requests affecting this org (pending, approved, active, history) |
| POST | `/orgs/:orgId/support-access/:requestId/consent` | org:update | `{ decision: 'APPROVE'|'DENY' }` |

### 2.17 Account data (user-level)

| Method | Path | Perm | Description |
|---|---|---|---|
| POST | `/me/export` | session | Export my personal data (profile, memberships, preferences, my audit events) |
| POST | `/me/deletion` | session | Delete my user account (`{ password }`). Blocked if I'm the sole OWNER of an org with other members (transfer first). If I'm the sole member, my org's deletion is scheduled too. Response includes the retention disclosure. |
| DELETE | `/me/deletion` | session | Cancel within the grace period |

---

## 3. Admin API (`/api/admin/v1`)

Phase 2 implements §3.1 and the endpoints marked *(implemented)* below; the rest are scheduled for Phase 9. All admin requests require a full (2FA-passed) admin session. **Every mutating admin request requires `reason: string(5..500)`** in the body (or the `X-Admin-Reason` header for DELETE), which is written to the audit log. Every mutation is audited (requirement #12).

Admin role abbreviations: **SA** = SUPER_ADMIN, **OP** = ADMIN_OPERATOR, **BI** = ADMIN_BILLING, **SU** = ADMIN_SUPPORT (read-only), **AU** = ADMIN_AUDITOR.

### 3.1 Admin auth — implemented in Phase 2

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/auth/csrf` | public | Issue the admin CSRF cookie `wim_admin_csrf` (SameSite=Strict) |
| POST | `/auth/login` | public | `{email, password, code}` — password **and** TOTP in one step; replayed codes rejected; 10 failures lock for 1 h; failures logged as `security_events` |
| POST | `/auth/logout` | any | Revoke the admin session |
| GET | `/me` | any | `{id, email, name, role, permissions[]}` |
| POST | `/auth/webauthn/*` | any | *(planned, Phase 9)* |

Admin accounts are created only with the CLI (`pnpm admin:create -- --email … --name … --role SUPER_ADMIN`), which
prints a one-time password and the TOTP enrollment URL. Admin sessions: separate table, cookie `wim_admin_sid`
(SameSite=Strict), 30 min idle / 8 h absolute (settings `admin.session.*`), and the `wim_admin` database role.

### 3.2 Overview, workers and queues

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/websites/stats` *(implemented, Phase 3)* | SA OP BI SU | Aggregate website/claim/verification/SDK/trial/duplicate/transfer counts and a 30-day series (`admin_v_website_stats`, `admin_v_registration_daily`) — no domains, keys or telemetry |
| GET | `/domain-transfers` *(implemented, Phase 3)* | SA OP BI SU | Transfer review queue: domain, org names, status, owner response, current claim status |
| POST | `/domain-transfers/:transferId/decision` *(implemented, Phase 3)* | SA OP | `{decision: APPROVE|REJECT, reason}`; only `PENDING_ADMIN` (DNS-verified) transfers; approval is applied by the verification worker |
| GET | `/overview` *(implemented: users, orgs, subscriptions, websites, incidents, executions, failed jobs, workers, 30-day signups — all aggregate counts from `admin_v_platform_stats`; revenue in Phase 8)* | SA OP BI SU | Users, active customers, trialing, paid, expired, websites (total, active), executions (24 h/30 d), incidents (total, open critical), failed jobs, platform uptime, revenue (MRR, ARR, by plan and currency), subscription funnel |
| GET | `/workers` | SA OP SU | Heartbeats: kind, region, version, active jobs, capacity, last seen, health |
| GET | `/queues` | SA OP SU | Per queue: waiting, active, delayed, failed, p95 wait, throughput; scheduler lag |
| POST | `/queues/:queue/pause` / `resume` | SA | Pause or resume consumption |
| GET | `/dlq` | SA OP | Dead-lettered jobs (metadata and error only; payload secrets never included) |
| POST | `/dlq/:jobId/retry` | SA OP | Re-enqueue |
| POST | `/dlq/:jobId/discard` | SA OP | Discard (audited) |
| GET | `/system-incidents` | SA OP SU | Platform self-monitoring incidents (scheduler lag, notification failures, …) |

### 3.3 Customers (organizations and users; metadata only)

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/customers` *(implemented: `?q=&limit=&cursor=` over `admin_v_organizations`)* | SA OP BI SU | Orgs: name, plan, status, trial state, website count, created, last active, owner email **masked**. Filters: `status, plan, trial, q (org name or domain)`. |
| GET | `/customers/:orgId` | SA OP BI SU | Metadata: members count, domains, subscription, trial history, usage, entitlement overrides, risk flags |
| GET | `/customers/:orgId/audit` | SA OP SU AU | Org audit events (metadata) |
| POST | `/customers/:orgId/suspend` | SA OP | `{ reason, notifyCustomer: boolean }`. Revokes sessions and pauses monitoring. |
| POST | `/customers/:orgId/activate` | SA OP | Lift suspension |
| POST | `/customers/:orgId/change-plan` | SA BI | `{ planPriceId, effective: 'NOW'|'PERIOD_END', chargeCustomer: boolean, reason }` |
| POST | `/customers/:orgId/extend-trial` | SA BI OP | `{ days: 1..90, reason }` |
| PUT | `/customers/:orgId/entitlement-overrides` | SA BI | `{ overrides: { key, value, expiresAt? }[], reason }` (validated against the entitlement registry types) |
| POST | `/customers/:orgId/reset-config` | SA OP | `{ scope: 'MONITORING'|'NOTIFICATIONS'|'SDK', reason }` resets to defaults |
| POST | `/customers/:orgId/reveal-owner-email` | SA OP SU | `{ reason }` → the unmasked email, valid for display for 5 min. Audited, and visible to the customer. |
| POST | `/registrations/blocklist` | SA OP | Block a registration signal (email domain, IP prefix) `{ kind, value, reason, expiresAt? }` |
| GET | `/users` | SA OP SU | Users (masked email, verified, 2FA, last login, org count, locked) |
| POST | `/users/:userId/unlock` / `revoke-sessions` | SA OP | Security operations |

### 3.4 Websites and domains

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/websites` | SA OP SU | All websites: domain, org, verification, monitoring status, plan, health score, counts. Filters: `q, status, verification, policyScope`. |
| GET | `/websites/:websiteId` | SA OP SU | Metadata + monitoring stats (no results content) |
| POST | `/websites/:websiteId/suspend-monitoring` | SA OP | `{ reason }` |
| POST | `/websites/:websiteId/resume-monitoring` | SA OP | |
| GET | `/domains` | SA OP SU | Domain registry: identity, registrable domain, current claim state, first registered/verified |
| GET | `/domains/:registryId/history` | SA OP SU AU | Claim history (org IDs → current org name or "deleted org"), transfers, verifications |
| POST | `/domains/block` | SA OP | `{ identityOrRegistrable, scope: 'EXACT'|'REGISTRABLE', reason }`. Stops monitoring on any matching websites. |
| DELETE | `/domains/block/:blockId` | SA OP | Unblock |
| GET | `/domain-registration-attempts` | SA OP SU | Duplicate and blocked attempts (identity, attempting org, time, outcome) |
| GET | `/domain-transfers` | SA OP | Transfer queue with both parties' verification evidence |
| POST | `/domain-transfers/:transferId/approve` | SA OP | `{ reason }` |
| POST | `/domain-transfers/:transferId/reject` | SA OP | `{ reason, messageToRequester? }` |
| GET | `/trial-ledger` | SA BI OP SU | `?q=domain`. Ledger rows (no personal data). |
| POST | `/trial-ledger/:ledgerId/reset` | SA | `{ reason }` clears `trial_consumed`, so the domain can trial again |
| PATCH | `/trial-ledger/:ledgerId/flags` | SA OP | Set or clear `ABUSE_SUSPECTED` |
| GET/PUT | `/domain-policy` | SA | Registration policy (`ROOT_EXCLUSIVE`\|`SUBDOMAIN_INDEPENDENT`), alias labels (`www`, `m`), custom public suffixes, pending claim TTL, lapse thresholds, auto-approve-lapsed |

### 3.5 Plans, prices and entitlements

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/plans` | SA BI SU | All plans, including archived |
| POST | `/plans` | SA BI | Create |
| GET | `/plans/:planId` | SA BI SU | Details + subscriber count per price version |
| PATCH | `/plans/:planId` | SA BI | Name, description, visibility, sort, trial eligibility, active |
| POST | `/plans/:planId/archive` | SA BI | Hide for new subscribers. Existing ones keep it. (Hard delete only if never subscribed.) |
| PUT | `/plans/:planId/entitlements` | SA BI | Replace the entitlement set (typed). Takes effect for all subscribers on cache invalidation. The response lists orgs that would exceed new limits. |
| POST | `/plans/:planId/prices` | SA BI | New price version `{ interval, currency, amount (minor units), gateways: ['stripe','razorpay'] }`. Creates gateway objects. |
| POST | `/plans/:planId/prices/:priceId/deactivate` | SA BI | Stop selling. Existing subscribers stay. |
| POST | `/plans/:planId/prices/:priceId/migrate-subscribers` | SA BI | `{ toPriceId, effective: 'NEXT_RENEWAL', notifyDays: ≥ 30 }` |
| POST | `/plans/:planId/prices/:priceId/sync` | SA BI | Re-sync to the gateways (idempotent) |
| GET | `/entitlement-registry` | SA BI SU | All keys with type, default, and description (drives the admin form) |
| GET/PUT | `/billing-settings` | SA BI | Trial duration, card-required-for-trial, grace period days, dunning schedule, cancellation policy, downgrade policy, trial policy for consumed domains (`REJECT`\|`REQUIRE_PAID`), risk score threshold, tax settings |
| GET | `/subscriptions` | SA BI SU | Subscription list and history (`?status=&planId=&gateway=`) |
| POST | `/payments/:paymentId/refund` | SA BI | `{ amount?, reason }` (`Idempotency-Key`) |

```ts
// POST /plans
Req { key: slug (unique, immutable), name, description, visibility: 'PUBLIC'|'HIDDEN'|'INVITE_ONLY', trialEligible: boolean, sortOrder: int,
      entitlements: { key: EntitlementKey, value: number|boolean|string[]|{ seconds } }[],
      prices?: { interval: 'MONTH'|'YEAR', currency: ISO4217, amountMinor: int ≥ 0 }[], reason }
Res 201 { data: Plan & { prices: PlanPrice[] & { gatewaySync: { stripe?: 'SYNCED'|'FAILED', razorpay?: … } } } }
```

### 3.6 Monitoring engine, incident rules and health score

| Method | Path | Roles | Description |
|---|---|---|---|
| GET/PUT | `/engine-config` | SA OP | Global intervals list, default page limits, worker concurrency per kind, retry counts, request and browser timeouts, browser recycle thresholds, per-host rate, crawl caps, default performance thresholds, destructive deny-list defaults, tracking params, viewport presets, retention periods (raw, rollups, artifacts, SDK), scheduler tick and batch size |
| GET/POST/PATCH/DELETE | `/maintenance-windows` | SA OP | Platform-wide maintenance windows (suppress alerts globally or per region) |
| GET/PUT | `/incident-rules` | SA OP | Platform default rules per category (threshold, window, consecutive, severity, reopen window, recovery passes, escalation, flap parameters) |
| GET/PUT | `/health-score-config` | SA OP | Weights, curves, bands, minimum samples, critical cap. `PUT` creates a new `configVersion`. |
| GET/POST/DELETE | `/api-host-allowlist` | SA OP | Curated public API hosts allowed without host verification |
| GET/PUT | `/egress-policy` | SA | Extra denied CIDRs and ports (the defaults cannot be removed) |

### 3.7 Payment gateways

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/payment-gateways` | SA BI | Config per gateway: active, mode (test/live), currencies, routing rule, credential status (masked: `{ configured, last4, updatedAt }`), webhook URL to paste into the gateway dashboard |
| PUT | `/payment-gateways/:gateway` | SA | `{ active, mode, currencies, credentials?: { secretKey, publishableKey/keyId, webhookSecret }, reason }`. Credentials are write-only and encrypted. |
| POST | `/payment-gateways/:gateway/test-connection` | SA BI | Validate the credentials with a harmless API call |
| GET | `/payment-webhook-events` | SA BI | Event log: gateway, type, event ID, signature valid, processed status, error, received at (no raw payment data beyond IDs) |
| POST | `/payment-webhook-events/:eventId/reprocess` | SA BI | Re-run processing (idempotent) |
| GET | `/payments` | SA BI | Payments and failed payment records |

### 3.8 Notification configuration

| Method | Path | Roles | Description |
|---|---|---|---|
| GET/PUT | `/email-provider` | SA | `{ kind: 'SMTP'|'SES'|'POSTMARK'|'RESEND', from, replyTo, smtp?: { host, port, secure, username, password(write-only) }, apiKey?(write-only) }` |
| POST | `/email-provider/test` | SA OP | Send a test email to the admin's address |
| GET | `/email-templates` | SA OP | Template list (key, locale, version) |
| GET/PUT | `/email-templates/:key/:locale` | SA OP | Subject + body (MJML/React Email source with an allowlisted variable set). `PUT` creates a version. |
| POST | `/email-templates/:key/:locale/preview` | SA OP | Render with sample variables |
| GET/PUT | `/notification-settings` | SA OP | Retry schedule, dedupe intervals, digest timing, default sound file and allowed custom sounds, rate caps |
| GET | `/notification-deliveries` | SA OP SU | Delivery logs (recipient **masked**, status, provider ID, error) |
| GET | `/email-suppressions` / DELETE `/email-suppressions/:id` | SA OP | Bounce and complaint suppression list |

### 3.9 Platform settings and feature flags

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/settings` *(implemented)* | SA OP SU | All typed settings (secrets masked), grouped: branding (name, logo, favicon), support email, legal (terms and privacy versions + content), maintenance mode, default timezone and currency, registration open/closed/invite-only, trial settings, retention |
| PATCH | `/settings` *(implemented)* | SA | `{ changes: { key, value }[], reason }`. Validated per key. Returns new versions. Hot-reloaded. |
| GET | `/settings/:key/history` | SA AU | Version history with actor and reason |
| POST | `/assets` | SA | Upload a logo or favicon (`multipart`; PNG/SVG/ICO ≤ 512 KB; SVG sanitized; served from the CDN) |
| GET | `/feature-flags` | SA OP SU | Flags |
| POST/PATCH/DELETE | `/feature-flags/:key` | SA | `{ enabled, rolloutPct, orgAllowlist, planKeys, reason }` |

### 3.10 Audit and security

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/audit-logs` *(implemented: `?stream=platform|org:<id>|user:<id>`)* | SA AU | All audit entries. Filters: `stream (PLATFORM|ORG:<id>|ADMIN), actorType, action, range`. |
| POST | `/audit-logs/verify-chain` *(implemented: `{stream}` → `{valid, checked, firstBrokenSeq, reason}`)* | SA AU | `{ stream, from?, to? }` → `{ valid, checked, firstBrokenSeq?, anchorMatches }` |
| GET | `/audit-anchors` | SA AU | Daily anchors (head hash, object storage key, object-lock retention) |
| GET | `/security-events` | SA AU OP | Failed logins, lockouts, 2FA failures, CSRF failures, webhook signature failures, SSRF blocks, rate-limit bursts, suspicious registrations |
| GET | `/login-history` | SA AU | Customer and admin logins (IP prefix, UA family, result) |
| GET | `/admin-activity` | SA AU | Admin actions (a view over the audit log) |

### 3.11 Break-glass

| Method | Path | Roles | Description |
|---|---|---|---|
| POST | `/break-glass` | SA OP SU | Request access |
| GET | `/break-glass` | SA OP SU AU | List requests |
| POST | `/break-glass/:requestId/approve` | SA (≠ requester) | Second-admin approval |
| POST | `/break-glass/:requestId/deny` | SA | |
| POST | `/break-glass/:requestId/revoke` | SA, requester | End early |
| GET | `/break-glass/:requestId/incidents` | requester, while ACTIVE | Redacted incident details for the scoped org |
| GET | `/break-glass/:requestId/executions/:executionId` | requester, while ACTIVE | Redacted results + artifacts (presigned 5 min) |

```ts
// POST /break-glass
Req { orgId: uuid, scope: ('INCIDENT_DIAGNOSTICS'|'EXECUTION_RESULTS'|'ARTIFACTS')[], resourceIds?: uuid[],
      purpose: string(20..1000), ticketRef: string, durationMinutes: 15..240, reason }
Res 201 { data: { id, status: 'PENDING_APPROVAL' | 'PENDING_CUSTOMER_CONSENT', requiresCustomerConsent: boolean } }
State: PENDING_APPROVAL → (PENDING_CUSTOMER_CONSENT) → ACTIVE → EXPIRED | REVOKED ;  any → DENIED
// Never grants: credentials, auth recipes, API response samples beyond redacted form, SDK raw events, passwords/tokens.
// Every read through break-glass writes an audit entry to both the PLATFORM and ORG:<id> streams (visible to the customer).
```

### 3.12 Admin users

| Method | Path | Roles | Description |
|---|---|---|---|
| GET | `/admin-users` | SA | List |
| POST | `/admin-users` | SA | Invite `{ email, roles[], reason }`. The invitee must set a password and 2FA before first use. |
| PATCH | `/admin-users/:adminId` | SA | Roles, IP allowlist, active. A Super Admin cannot remove their own SA role if they are the last one. |
| POST | `/admin-users/:adminId/reset-2fa` | SA (≠ target) | Forces re-enrollment |
| DELETE | `/admin-users/:adminId` | SA (≠ target) | Deactivate |

---

## 4. SDK ingest (`ingest.<domain>/v1`)

CORS: `Access-Control-Allow-Origin: *`, no credentials. Accepted methods are `GET` (config) and `POST` (events). `text/plain` content type is accepted (sendBeacon) and parsed as JSON.

| Method | Path | Description |
|---|---|---|
| GET | `/config/:siteKey` | Remote config `{ v, enabled, capture: { errors, resources, network, vitals, navigation, interactions }, sampleRates: { [eventType]: 0..1 }, maskPatterns: string[], urlQueryAllowlist: string[], consentMode, flushIntervalMs, maxBatch }`. `Cache-Control: max-age=600`. Unknown or inactive key: `{ enabled: false }` with 200 (does not reveal validity to scanners via status). |
| POST | `/events` | Batch of events (≤ 64 KB, ≤ 50 events). Always responds `204` quickly. Rejections are counted server-side, not reported to the page. |

```ts
EventBatch { v: 1, k: siteKey, s: sessionId(random, per page), sdk: '1.2.0',
  ctx: { url: sanitizedUrl, ref?: sanitizedUrl, vw, vh, dpr, dt: 'mobile'|'tablet'|'desktop', conn?: '4g'|… , lang? },
  e: Event[] }
Event =
 | { t: 'js_error', ts, msg: masked(max 500), type?, stack?: frames(max 10, file:fn:line:col), src?: 'onerror'|'unhandledrejection' }
 | { t: 'resource_error', ts, tag: 'img'|'script'|'link'|'other', url: sanitizedUrl }
 | { t: 'http_error', ts, method, url: sanitizedUrl, status: int | 0, durMs, kind: 'fetch'|'xhr' }
 | { t: 'vital', ts, name: 'LCP'|'CLS'|'INP'|'FCP'|'TTFB', value: number, rating: 'good'|'ni'|'poor' }
 | { t: 'nav', ts, route: sanitizedPath, durMs? }
 | { t: 'form_fail', ts, form: hash, status?: int, invalidFields?: { [fieldName]: count } }   // never values
 | { t: 'search_fail', ts, form: hash, reason: 'NO_RESULTS_CONTAINER'|'HTTP_ERROR' }
 | { t: 'click_error', ts, el: { tag, role?, textHash? }, errRef: index into js_error events }
// The server re-applies masking, drops unknown fields, parses UA from the request header (then discards the raw UA).
```

---

## 5. Webhooks (`api.<domain>/webhooks`)

Common pipeline: raw body (max 1 MB) → signature verification → insert into `payment_webhook_events` / `email_provider_events` with `UNIQUE(provider, event_id)` → `200` → asynchronous processing in `worker-billing` / `worker-notify`. An invalid signature returns `400 WEBHOOK_SIGNATURE_INVALID` and is logged as a security event. A duplicate returns `200` and does nothing.

| Method | Path | Verification | Handled events (mapped to canonical domain events) |
|---|---|---|---|
| POST | `/webhooks/stripe` | `Stripe-Signature` (HMAC-SHA256 with `t=` timestamp, tolerance 300 s, multiple `v1` signatures for secret rotation) | `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `charge.refunded`, `payment_method.attached/detached` |
| POST | `/webhooks/razorpay` | `X-Razorpay-Signature` = HMAC-SHA256(rawBody, webhookSecret). The event ID comes from the `x-razorpay-event-id` header. | `subscription.authenticated/activated/charged/pending/halted/cancelled/completed/paused/resumed`, `payment.captured/failed`, `invoice.paid`, `refund.processed` |
| POST | `/webhooks/email/:provider` | Provider signature (SES SNS signature, Postmark basic auth + IP list, Resend Svix signature) | `delivered`, `bounced` (hard → suppress), `complained` (suppress), `deferred` |

Canonical billing events: `SUBSCRIPTION_ACTIVATED`, `SUBSCRIPTION_RENEWED`, `PAYMENT_FAILED`, `PAYMENT_RECOVERED`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_ENDED`, `PLAN_CHANGED`, `REFUNDED`, `INVOICE_AVAILABLE`, `PAYMENT_METHOD_UPDATED`. Out-of-order protection: apply an event only if `gatewayObject.updatedAt ≥ subscription.gatewayUpdatedAt`.

---

## 6. Health endpoints (internal only)

| Method | Path | Description |
|---|---|---|
| GET | `/health/live` | 200 if the process is up |
| GET | `/health/ready` | 200 if Postgres, Redis (and, for workers, the queue connection and browser launch capability) are ready. Otherwise 503 with failing checks. |
| GET | `/metrics` | Prometheus exposition (internal network; Nginx denies it publicly) |

---

## 7. WebSocket protocol (`/ws`, Socket.IO)

**Handshake.** A same-origin connection carries the `wim_session` cookie automatically. The client sends `auth: { orgId, csrf }`. The server validates the session, verifies membership of `orgId`, and joins the rooms `org:{orgId}` and `user:{userId}`. A failed handshake gets `connect_error` `{ code: 'UNAUTHENTICATED'|'NOT_FOUND' }`. Switching org means disconnecting and reconnecting with the new `orgId`. On session revocation the server force-disconnects (`session.revoked`).

**Server → client events** (minimal payloads; the client invalidates the React Query cache and refetches):

| Event | Room | Payload |
|---|---|---|
| `incident.created` | org | `{ id, websiteId, severity, category, title, firstSeenAt, sound: boolean }` |
| `incident.updated` | org | `{ id, status, severity, occurrenceCount, lastSeenAt, changedBy? }` |
| `incident.escalated` | org | `{ id, fromSeverity, toSeverity, sound: boolean }` |
| `incident.resolved` | org | `{ id, resolution: 'AUTO'|'MANUAL', resolvedAt }` |
| `incident.reopened` | org | `{ id, severity, sound: boolean }` |
| `incident.acknowledged` | org | `{ id, by: memberId }` (stops repeat sound on all clients) |
| `website.status_changed` | org | `{ websiteId, status: 'UP'|'DOWN'|'DEGRADED'|'PAUSED'|…, at }` |
| `execution.completed` | org | `{ executionId, websiteId, kind, outcome: 'PASS'|'FAIL', finishedAt }` (debounced to ≤ 1/5 s per website) |
| `health.updated` | org | `{ websiteId, score, band }` |
| `notification.created` | user | `{ id, title, severity, link }` |
| `subscription.updated` | org (billing roles only) | `{ status, planKey, trialEndsAt? }` |
| `verification.completed` | org | `{ websiteId, attemptId, status }` |
| `session.revoked` | user | `{}` |

Each event carries `{ eventId, ts }`. **Client → server:** `ack { eventId }` (optional, for delivery metrics), `subscribe.website { websiteId }` / `unsubscribe.website` to receive high-frequency `execution.completed` for the website currently being viewed (the server verifies ownership), and `ping` handled by Socket.IO. **Resume:** on reconnect the client sends `lastEventId`. The server replays from the Redis Stream for up to 5 min, after which the client does a full refetch.

**Sound rules (client):** play only if armed by a user gesture, the user preference allows the severity, the tab is not muted, and `sound: true` (the server sets this false for maintenance windows, flapping, and ignored incidents). Repeat every 60 s until acknowledged, if `repeatUntilAck` is set.

---

## 7a. Monitoring schedules and executions (Phase 4B)

Customer (`/api/v1/orgs/:orgId`):

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/websites/:websiteId/monitoring` | website:read | `{monitoringPaused, schedules: [{tier: HTTP\|BROWSER\|DEEPSCAN, status, pausedReason, intervalSec, nextRunAt, lastEnqueuedAt}], executions: [{id, tier, status, trigger, attempt, windowStart, startedAt, finishedAt, durationMs, failureCategory}]}` (last 7 days, max 50). No infrastructure details |
| POST | `/websites/:websiteId/monitoring/pause` | website:write | `{paused: boolean}`. Pause cancels pending executions and asks running ones to stop, in one transaction; `409` if not active / not paused. Audited `website.monitoring_paused/resumed` |
| POST | `/websites/:websiteId/executions/:executionId/cancel` | website:write | `{status: CANCELLED\|CANCEL_REQUESTED}`; `409` when already finished. Audited |

Other tenants receive `404` (no existence oracle).

Admin (`/api/admin/v1`):

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/monitoring/health` | admin:monitoring:read | Aggregates only: BullMQ counts per queue, execution health per tier, schedule counts by status/reason, worker heartbeats (availability, utilisation), last successful scheduling cycle, dead-letter and security-rejection counts. No org, website or domain |
| GET | `/monitoring/dead-letters?status=OPEN\|RESOLVED\|ALL&limit=` | admin:monitoring:read | Ids, queue, job type, category, attempts, sanitised error (no URLs), replay state |
| POST | `/monitoring/dead-letters/:id/replay` | admin:monitoring:replay | `{reason}` → `202`. Request only; the scheduler re-checks current eligibility. `409` if resolved, already requested, or a security failure. Audited |

Roles: `admin:monitoring:read` — SUPER_ADMIN, ADMIN_OPERATOR, ADMIN_SUPPORT; `admin:monitoring:replay` — SUPER_ADMIN, ADMIN_OPERATOR.

## 7b. HTTP availability monitoring and incidents (Phase 4C)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/websites/:websiteId/monitoring/http` | website:read | `{state: UP\|DOWN\|DEGRADED\|UNKNOWN\|PAUSED\|NOT_MONITORED, latest, lastSuccessfulCheckAt, lastFailedCheckAt, uptime: {h24, d7, d30}, responseTime24h: {avgMs, p50Ms, p95Ms, samples}, ssl, openIncidents, config, measurement: "SYNTHETIC_HTTP"}`. Uptime: `{uptimePercent (null without data), measuredChecks, upChecks, downChecks, scheduledChecks, coveragePercent}` — methodology in DATABASE_SCHEMA.md §14 |
| GET | `/websites/:websiteId/monitoring/http/results?before=&outcome=&limit=` | website:read | History, newest first; `nextBefore` cursor. Each: outcome, available, failureKind/Category/Description, method, url, finalUrl, httpStatus, redirects, timings `{dnsMs, connectMs, tlsMs, ttfbMs, totalMs}` (null = not measured), bytes, contentType, allow-listed headers, tls |
| PUT | `/websites/:websiteId/monitoring/http/config` | monitoring:write | Partial `HttpCheckConfig`; `null` clears a field. `method` GET\|HEAD, `path` (path only), `expectedStatus` (codes/ranges; default 2xx + 401 + 403), `timeoutMs` 1–60 s, `maxRedirects` 0–10, `contentMarker`, `expectedContentType`, `serverErrorsAreDowntime`, `sslWarningDays`, `failureThreshold`, `recoveryThreshold`. Audited |
| GET | `/incidents?status=ACTIVE\|RESOLVED\|ALL&websiteId=&limit=` | incident:read | Summaries incl. occurrenceCount, first/last detected, resolvedAt, durationSec |
| GET | `/incidents/:incidentId` | incident:read | + diagnostics, events timeline, last 50 occurrences |

Admin `/monitoring/health` gains `httpChecks` (aggregates: checks/passed/failed/inconclusive 1 h, infrastructure
failures, security rejections and blocked destinations 24 h, p50/p95 total and p95 gateway time, last completed check).

## 7c. Browser monitoring and screenshots (Phase 4D)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/browser` | website:read | `{state, pausedReason, latest: {executionId, windowStart, outcome, attempt, viewports: [...]}, lastSuccessfulCheckAt, lastFailedCheckAt, openIncidents, config, measurement: "SYNTHETIC_BROWSER"}`. Per viewport: outcome, failureKind/Description, navigation, rendering, scripts (grouped), network (grouped), layout, `syntheticPerformance` (TTFB, FCP, LCP, CLS, TBT, load, requests, bytes — **no INP**), warnings, artifact references |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/browser/results?before=&limit=` | website:read | History by execution, newest first |
| PUT | `/orgs/:orgId/websites/:websiteId/monitoring/browser/config` | monitoring:write | Partial `BrowserCheckConfig`: `enabled`, `path` (path only), `readiness {strategy load\|domcontentloaded\|networkquiet\|selector\|fixed, selector, quietMs, settleMs ≤ 10 s}`, `navigationTimeoutMs` 5–60 s, `maxRedirects`, `primaryViewport`, `viewports` (presets), `extraViewportsPerRun`, `screenshots {onFailure, onSuccess, fullPage, mask[]}`, `consoleErrorsAreFailures`, `thirdPartyFailuresAreFailures`, `performance {lcpWarnMs, lcpCritMs, clsWarn, clsCrit}`, thresholds. Audited |
| GET | `/orgs/:orgId/artifacts/:artifactId/link` | website:read | `{url, expiresAt (≤ 5 min), contentType, bytes}` |
| GET | `/artifact-downloads?token=` | public bearer link | Streams the PNG from private storage; tampered/unknown 404, expired 410 |

Viewport presets: `mobile-small` 375×812, `mobile-large` 390×844, `tablet` 768×1024, `desktop` 1366×768,
`desktop-large` 1920×1080. Admin `/monitoring/health` gains `browserChecks` (aggregates only).

## 7d. Deep website scanning (Phase 4E)

All routes are under `/api/v1`, tenant-scoped (another organisation's website, scan or finding → 404), and read only
persisted results. Customers can't write scans, findings, results or usage (database grants, tested).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan` | website:read | `{entitled, enabled, pausedReason, intervalSec, nextRunAt, config, effectiveLimits, latestScan, openFindings: [{group, severity, count}], measurement: "AUTOMATED_CHECKS"}` |
| PUT | `/orgs/:orgId/websites/:websiteId/deep-scan/config` | monitoring:write | Partial `DeepScanConfig` (strict; unknown keys → 400): `startPaths`, `sitemaps` (paths only), `additionalHosts` (must be verified active websites of the same org), `maxPages`, `maxDepth`, `maxDurationSec`, `requestDelayMs`, `includePatterns`, `excludePatterns`, `excludedQueryParams`, `queryParamMode` (KEEP_MEANINGFUL \| IGNORE_ALL \| ALLOWLIST), `queryParamAllowlist`, `respectRobots`, `checkResources`, `checkExternalLinks`, `browserDiscovery`, `severityOverrides`, `incidentGroups`. Limits above the plan are accepted but capped (see `effectiveLimits`). Audited. |
| POST | `/orgs/:orgId/websites/:websiteId/deep-scan/start` | monitoring:write | 202 `{executionId}`. 409 when not eligible (not entitled, paused, website not verified/active), already queued/running, or within the manual cooldown (`monitoring.deepscan.manualCooldownSec`). Audited. |
| POST | `/orgs/:orgId/websites/:websiteId/deep-scan/pause` | monitoring:write | `{paused: boolean}`. Pausing cancels a queued or running scan (partial data kept, nothing resolved). Audited. |
| POST | `/orgs/:orgId/websites/:websiteId/deep-scan/scans/:executionId/cancel` | monitoring:write | `{status}`; 409 if already final. Audited. |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/scans?limit=` | website:read | History, newest first: `{executionId, trigger, status, complete, stopReason, coverage: {pagesDiscovered, pagesChecked, pagesFailed, pagesSkippedByPolicy, pagesNotCrawledLimits, pagesInconclusive, resourcesChecked}, requests, bytes, findingsOpened, findingsResolved, startedAt, finishedAt, baselineExecutionId}` |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/scans/:executionId` | website:read | One scan + `discovery {sitemaps, sitemapIssues, robotsFound, spa}` + `comparison` with the previous COMPLETED scan (`baselineComplete, currentComplete, newPages, removedPages, notObservedThisScan, statusChanged, newBrokenPages, recoveredPages, newRedirects, removedRedirects, titleChanged, descriptionChanged, canonicalChanged, contentChanged, structureChanged` as `{count, items ≤ 50}`, and `accessibility {newlyDetected, resolved}`). A page is listed as removed only when the current scan was `complete` and no longer discovered it; otherwise it is `notObservedThisScan`. |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/scans/:executionId/pages?state=&kind=&limit=&after=` | website:read | Frontier rows (keyset pagination via `nextAfter`): URL (query values shown as `…`), kind, state, skip reason, depth, source, `linkedFrom`, `linkCount`, status, final URL, redirect chain, content type, bytes, duration |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/findings?status=OPEN\|RESOLVED\|ALL&group=&severity=&limit=` | website:read | `{id, category, group, severity, status, subject, title, impact, recommendation, evidence, detectionMethod, automated, confirmed, occurrenceCount, firstDetectedAt, lastDetectedAt, resolvedAt}` |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/findings/:findingId` | website:read | Finding + `history: [{type: OPENED\|RECURRED\|REOPENED\|RESOLVED, executionId, at}]` |
| GET | `/orgs/:orgId/deep-scan/usage` | website:read | `{entitled, limits, quota: {pagesPerDay, pagesUsedToday}, usage: {pages, bytes, requests, scans, resources, duration_ms, …: {today, last30Days}}}` |

Finding groups: `broken_pages`, `broken_resources`, `sitemap`, `seo`, `accessibility`, `structure`. Accessibility
findings are automated checks only, never a WCAG conformance claim. Admin `/monitoring/health` gains `deepScans`
(running scans; completed / partial / cancelled / inconclusive scans, pages, requests, bytes and p95 duration over
24 h; open findings count — no URLs, hosts, organisations or finding text).

## 7e. Customer dashboard (approved-4G scope, delivered early; originally labelled "Phase 4F")

All routes under `/api/v1`, tenant-scoped (RLS; another organisation's ids → 404), read-only unless stated. Times are ISO 8601 UTC.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/orgs/:orgId/monitoring/overview?from=&to=` | website:read | Per website: `health` (HEALTHY / DEGRADED / DOWN / INCONCLUSIVE / NO_DATA / DISABLED / NOT_VERIFIED) with `reasons`, HTTP uptime and coverage for the range, last check / success / failure, browser state, deep-scan state and open findings, active incidents; totals; `entitlements` per tier with the reason when unavailable. Range ≤ 90 days, default 24 h. |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/http/analytics?from=&to=` | website:read | Uptime + coverage, checks (passed / failed / inconclusive / scheduled / missing), downtime (availability incidents), response time avg / p95 / max, timing averages, status-class distribution, failure categories, bucketed series (hour ≤ 2 d, 6 h ≤ 14 d, else day), incidents in range. |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/http/results?from=&before=&outcome=&limit=` | website:read | (4C) now with `from`. |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/browser/results?from=&before=&outcome=&viewport=&problem=&limit=` | website:read | (4D) now filterable; `problem` = NAVIGATION / RENDERING / JAVASCRIPT / NETWORK / LAYOUT / PERFORMANCE; limit ≤ 50. |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/browser/results/:executionId` | website:read | One browser execution with all viewports and artifact references. |
| GET | `/orgs/:orgId/artifacts/:artifactId/link` | website:read | (4D) now **410 `ARTIFACT_EXPIRED`** for the organisation's own screenshot past retention (404 for unknown / other tenants). |
| GET / PUT | `/orgs/:orgId/websites/:websiteId/monitoring/schedule` | website:read / monitoring:write | `{httpIntervalSec, browserIntervalSec, deepScanIntervalSec}` (null = plan default). An interval faster than the plan's minimum → 400. Audited (`website.monitoring_schedule_updated`). GET also returns `entitlements`. |
| GET | `/orgs/:orgId/incidents?status=&severity=&source=&websiteId=&from=&to=&cursor=&limit=` | incident:read | status ACTIVE (default) / OPEN / ACKNOWLEDGED / REOPENED / RESOLVED / ALL; source HTTP / BROWSER / DEEP_SCAN; `{data, nextCursor}`; rows carry `websiteName`, `source`, `acknowledgedAt`, `autoResolved`, `durationSec`. |
| GET | `/orgs/:orgId/incidents/:id` | incident:read | (4C) + occurrence `link` to the detecting result, `notifications` (delivery counts per event / channel / status — never recipients), `notifiedMe`. |
| POST | `/orgs/:orgId/incidents/:id/acknowledge` | incident:write | `{status, acknowledgedAt, changed}`; idempotent (`changed: false` on repeat); 409 when not OPEN / REOPENED. Never resolves. Audited (`incident.acknowledged`). |
| GET | `/orgs/:orgId/monitoring/history?websiteId=&type=&source=&result=&from=&to=&cursor=&limit=` | website:read | Merged timeline: CHECK (ledger), INCIDENT (opened / reopened / acknowledged / resolved / recovered), CONFIG and VERIFICATION (audit, no actor details), INTERRUPTION. `{data: [{id, at, type, source, websiteId, websiteName, title, result, link}], nextCursor}`. |
| GET | `/orgs/:orgId/monitoring/usage` | website:read | Websites per tier, limits from the entitlement system, usage counters today / 30 days, screenshot storage, result retention, warnings at ≥ 80 %. |
| GET | `/orgs/:orgId/notifications?unread=&cursor=&limit=` | org:read | The signed-in user's notifications in this org; `{data, nextCursor, unread}`; links are app paths. |
| POST | `/orgs/:orgId/notifications/:id/read`, `/orgs/:orgId/notifications/read-all` | org:read | Own notifications only (another user's id → 404). Idempotent. |
| GET / PUT | `/orgs/:orgId/notification-preferences` | org:read | Per channel EMAIL / IN_APP: `enabled`, `minSeverity`, `eventTypes` (INCIDENT_OPENED, INCIDENT_RESOLVED, SSL_EXPIRING, BROWSER_FAILURE, DEEP_SCAN_FINDINGS, MONITORING_INTERRUPTED; empty = all), `websiteIds` (must be the org's; empty = all). Audited. |
| GET | `/orgs/:orgId/changes?since=` | org:read | Change feed for live updates: `{cursor, changes: [{kind, websiteId, at}], unreadNotifications}`. |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/findings?…&category=&url=&firstDetectedFrom=&lastDetectedFrom=` | website:read | (4E) additional filters. |
| GET | `/orgs/:orgId/websites/:websiteId/deep-scan/scans/:executionId/compare?base=` | website:read | Page-by-page comparison with any other scan of the website; `reliable` false unless both are COMPLETED; unseen pages are `notObservedThisScan`, never removed. |

Admin `GET /api/admin/v1/monitoring/health` adds `outcomes` (per tier: results, failure / inconclusive rates, retries), `gateway` (infrastructure failures, security rejections, p95 — derived from outcomes; the API has no network path to the gateway) and platform `usage` totals.

## 7f. Components, functional tests, responsive matrix (Phase 4F, approved scope)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/orgs/:orgId/websites/:websiteId/components?status=PRESENT\|REMOVED\|ALL&type=&limit=` | website:read | Detected components of the monitored page: `{id, type, label, status, pagePath, detail, viewports, firstSeenAt, lastSeenAt, removedAt, occurrences}` |
| GET | `/orgs/:orgId/websites/:websiteId/components/history?cursor=&limit=` | website:read | `{data: [{id, at, type: ADDED\|CHANGED\|REMOVED\|RESTORED, componentId, componentType, label, before, after, executionId}], nextCursor}` |
| GET | `/orgs/:orgId/websites/:websiteId/monitoring/browser/results/:executionId` | website:read | Now also `functional: [{kind, componentType, target, viewport, outcome PASSED\|FAILED\|SKIPPED\|INCONCLUSIVE, reason, safety SAFE\|UNSAFE\|UNKNOWN, steps, durationMs}]` and `responsive: [{viewport, width, height, status, navState, overflowPx, clippedText, overlaps, obscuredControls, offscreenControls, offscreenText, oversizedImages, objective, heuristic, samples}]` |
| PUT | `/orgs/:orgId/websites/:websiteId/monitoring/browser/config` | monitoring:write | New keys: `components: {detect}` and `functional: {enabled (default false), search, navigation, forms, buttons, searchQuery (letters/digits), maxNavigationLinks ≤ 10, maxButtons ≤ 10, maxForms ≤ 5, budgetMs 5000–120000}`; `viewports` may include `mobile-landscape` (844×390). Validated server-side; audited. |

Typed form values and page text are never stored; `target` is the control's label or the destination path.

## 8. Queue payload contracts (`packages/queue`, Zod-validated on both ends)

> **Phase 4B (implemented):** monitoring execution jobs on `http-monitoring`, `browser-monitoring` and `deep-scan`
> are `ExecutionJob { v: 1, executionId: uuid, windowStart: ISO datetime }` (strict) with job name `EXECUTE` and
> `jobId = executionId`; dead-letter notifications are `{ v: 1, jobFailureId }`. Everything else (tenant, website,
> target, configuration) is loaded by the consumer from the database. The envelopes below are the original design
> and are superseded for monitoring executions.

```ts
// Common envelope on every job
JobEnvelope<T> { v: 1, jobKind, orgId, executionId?, correlationId, enqueuedAt, payload: T }

ProbeHttpJob      { scheduleId, slot, websiteId, url, timeoutMs, keyword?, confirmRetry, collectSsl: boolean, suppressAlerts }
ProbeApiJob       { scheduleId?, slot?, apiEndpointId, configVersion, suppressAlerts }          // worker loads + decrypts config itself; no secrets in Redis
BrowserRenderJob  { scheduleId, slot, websiteId, pageIds: uuid[], viewport, configVersion, suppressAlerts }
DeepScanJob       { scheduleId, slot, websiteId, configVersion, discovery: boolean, checkpoint?: { donePageIds: uuid[] } }
VerifyJob         { websiteId, attemptId, method, token }
TestCaseRunJob    { websiteId, testCaseId, stepsHash, approvalId? }
SignalBatchJob    { websiteId, signals: Signal[] }                     // grouped per website (see ARCHITECTURE §10.1)
NotifyDispatchJob { outboxId, eventType, orgId, incidentId?, templateKey, severity, dedupeKey }
BillingWebhookJob { webhookEventId }                                   // raw event stays in Postgres
BillingCronJob    { kind: 'TRIAL_EXPIRY'|'GRACE_END'|'DUNNING'|'RECONCILE', orgId? }
MaintJob          { kind: 'ROLLUP_HOURLY'|'ROLLUP_DAILY'|'PARTITION_CREATE'|'PARTITION_DROP'|'RETENTION_PURGE'|'ARTIFACT_EXPIRE'
                         |'ACCOUNT_PURGE'|'TELEMETRY_FLUSH'|'AUDIT_ANCHOR'|'HEALTH_SCORE'|'REVERIFY_DOMAINS', period?: string, orgId? }
ReportRenderJob   { reportId }
DlqEntry          { originalQueue, jobId, jobKind, orgId?, attemptsMade, lastError: { name, message (redacted) }, failedAt }
```

Rules: **no secrets in job payloads.** Workers load the config by ID and decrypt at execution. Payloads are ≤ 16 KB. `jobId` is deterministic for scheduled work (`{scheduleId}:{slot}`) and for singleton maintenance work (`maint:{kind}:{period}`).

## 7g. Phase 4G: performance, pages, components, responsive

All routes: `/api/v1/orgs/:orgId/websites/:websiteId/…`, member of the organisation (RLS), `monitoring:read` unless noted;
ranges `from`/`to` ISO-8601, `to − from ≤ 90 days` (400 otherwise); `viewport` one of the configured viewports.

| Method | Path | Notes |
|---|---|---|
| GET | `performance` | Status, per-metric p50/p75/p95/avg, samples, sufficiency (≥ 3), thresholds, alerting flag, previous-period change (`REGRESSION` / `IMPROVEMENT` / `STABLE` / `INSUFFICIENT_DATA`), viewports, data quality (scheduled / recorded / inconclusive / failed checks), latest measurement |
| GET | `performance/series?metric=&pageId=` | Buckets `{t, samples, p50, p75, p95}`; empty buckets explicit; `grain` hour (≤ 7 d) or day |
| GET | `performance/pages` | p75 + samples + status per monitored page and metric |
| GET | `performance/thresholds` | Effective, platform, `customAllowed`, `alertOn`, noise settings, audit history |
| PUT | `performance/thresholds` | `monitoring:write`; `thresholds` / `alertOn` → 403 `ENTITLEMENT_REQUIRED` without `monitoring.performance.customThresholds`; validated (good < poor, bounded); audited `website.performance_thresholds_updated` (before/after) |
| GET | `pages?search=&cursor=&limit=` | Discovered pages with `monitoring {browser, deepScan}`, deep-scan state, open findings, LCP p75 24 h, components, responsive; `scope.note` |
| GET | `components/changes?since=` | Added / removed / changed / visibility since a date; `complete` false when history starts later |
| GET | `components/:componentId` | Detail, per-viewport visibility, event history |
| GET | `responsive` | Latest per viewport, daily pass/fail, last 30 runs |
| GET | `responsive/compare?a=&b=` | Per viewport: `comparable` (checked in both), new / fixed problems |

Extended: `monitoring/overview` → `websites[].performance {status, samples, lcpP75, regressions}` (only when browser
monitoring is active) and `recentChanges[]`; `monitoring/history` → types `COMPONENT`, `FUNCTIONAL`, `RESPONSIVE`, and
`retention {checksDays, browserDays, incidentOccurrencesDays}`.

## 7h. Phase 4H: Super Admin operations (`/api/admin/v1/ops`, admin session + CSRF)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `ops/health` | `admin:monitoring:read` | Component states (UNKNOWN when the evaluation is stale), every worker (alive, state, busy/capacity, processed/failed/timeouts, last job, dependency probes, memory), open alert counts |
| GET | `ops/history?hours=1..168` | `admin:monitoring:read` | State transitions, worker samples (10-minute buckets), restarts |
| GET | `ops/alerts?state=ACTIVE\|OPEN\|ACKNOWLEDGED\|RECOVERED\|ALL&limit≤200` | `admin:monitoring:read` | |
| GET | `ops/alerts/:id` | `admin:monitoring:read` | With event history |
| POST | `ops/alerts/:id/acknowledge` `{reason}` | `admin:ops:alerts` | 409 unless OPEN; audited `admin.platform_alert_acknowledged` |
| GET | `ops/usage?from&to(≤92 d)&orgId?&limit≤500` | `admin:usage:read` | Totals with kind/unit/label, billable per organisation (counts only), policy text |
| GET/POST | `ops/usage/reconciliations` `{day, reason}` | `admin:usage:read` | POST: finished days only, 202, audited |
| GET | `ops/usage/reconciliations/:id` | `admin:usage:read` | Discrepancies |
| POST | `ops/usage/adjustments` `{orgId, day, key, delta, reason≥10, discrepancyId?}` | `admin:usage:adjust` | Atomic counter change + record + audit; never negative; 409 for another org's discrepancy |
| POST | `ops/usage/discrepancies/:id/accept` `{reason}` | `admin:usage:adjust` | |
| GET | `ops/usage/adjustments` | `admin:usage:read` | |
| GET | `ops/config` | `admin:settings:read` | Sections with protected / apply / scope, retention table with floors, alert rules |
| PUT | `ops/config/retention/:table` `{days, reason}` | `admin:settings:write` | Floors enforced in the database; audited before/after |

Changed: `PATCH settings` accepts `confirmProtected` (required for protected keys, which also need
`admin:settings:protected`), rejects unsafe combinations, and records `protected`/`apply` in the audit entry;
`GET settings` rows carry `section`, `protected`, `apply`, `scope`. Dead letters of the `email` queue are listed with
`replayable: false`.

Customer API: `PUT …/monitoring/browser/config` accepts `acknowledgeFunctionalRisk: true`; enabling functional tests
without a current acknowledgement → 400 `RISK_ACKNOWLEDGEMENT_REQUIRED` (message = the risk statement); enabling while
the platform switch is off → 409 `FEATURE_UNAVAILABLE`; `functional.riskAcknowledgement` cannot be sent;
`functional.allowedPaths` (1–20 path prefixes, **required** to enable functional tests — 400 `VALIDATION_FAILED` on
`functional.allowedPaths` otherwise; semantics in SECURITY.md §36). `thirdParty` `{ mode: all|allowlist|none,
allowedDomains ≤ 50, maxHosts 0–500 }` — enforced by the egress gateway (SECURITY.md §35).

New roles/permissions: `admin:ops:alerts` (Super Admin, operator), `admin:usage:read` (Super Admin, operator, billing),
`admin:usage:adjust` and `admin:settings:protected` (Super Admin).
