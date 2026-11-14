# Billing and trials (Phase 8)

> Status 2026-11-15: implemented and tested against local fakes of the gateways. **Not verified against Stripe or
> Razorpay test mode** (no test keys were available). Billing ships **off** (`billing.enabled = false`).

## 1. What is where

| Concern | Location |
|---|---|
| Subscription state machine, dunning schedule, plan-change classification (pure) | `packages/core/src/billing/subscription.ts` |
| Which plan's entitlements apply (pure, D-43) and entitlement key registry | `packages/core/src/billing/entitlements.ts` |
| Entitlement resolver used by every worker | `packages/queue/src/facts.ts` → `loadOrgContexts` (worker code unchanged) |
| Gateway interface, Stripe and Razorpay adapters (REST over `fetch`, no SDK) | `packages/billing/src/{types,stripe,razorpay}.ts` |
| Webhook signature verification | `packages/billing/src/signature.ts` |
| Webhook handling (verify → normalise → claim event id → apply, one transaction) | `packages/billing/src/{webhook,process}.ts` |
| Daily reconciliation | `packages/billing/src/reconcile.ts`, called from `apps/scheduler` |
| Customer API + webhook endpoints | `apps/api/src/billing/` |
| Super Admin API (plans, prices, entitlements, overrides, gateways) | `apps/api/src/admin/billing-admin.controller.ts` |
| DB: org resolver, invoice sequence, grants | `packages/db/sql/180_billing.sql` (no Prisma migration: the Phase 1 schema already had every billing table) |
| Example plans | `packages/db/scripts/seed.mjs` (`EXAMPLE_PLANS`) |
| UI | `apps/web/.../o/[orgId]/settings/billing`, `apps/admin/.../(admin)/plans`, `apps/admin/.../(admin)/gateways` |

## 2. Configuration (platform settings, hot-reloaded, no redeploy)

| Setting | Default | Meaning |
|---|---|---|
| `billing.enabled` | `false` | Master switch. While off: checkout, plan change, cancel/resume are refused (409), webhooks get 503 (gateways retry later), the reconciliation job makes no gateway call, and entitlement resolution is exactly the pre-Phase-8 behaviour. Protected setting (Super Admin + confirmation). |
| `billing.gatewayByCurrency` | `{INR: RAZORPAY, USD: STRIPE}` | Gateway used for checkout in each currency. |
| `billing.graceDays` | 7 | Service continues this long after a failed renewal (PAST_DUE), then EXPIRED. |
| `billing.dunning.reminderDays` | `[0,3,6]` | Reminder days within the grace period (schedule computed by `dunningSchedule`; see §8). |
| `billing.webhookToleranceSec` | 300 | Stripe signature timestamp window. |
| `billing.freePlanKey` | `null` | Plan for orgs with no subscription and no active trial (null: monitoring stops after the trial). |
| `billing.reconcileDaily` | `true` | Daily reconciliation job. |
| `trial.planKey` | `"pro"` | Plan whose entitlements apply during the trial (billing enabled only). |
| `billing.tax.mode` | `GATEWAY` | Decision B4b default. `GATEWAY` turns on Stripe automatic tax at checkout; `GST` records the 18 % (`billing.tax.gstRatePct`) included share on Razorpay invoices. |

Gateway credentials are configured in **Super Admin → Payment gateways** (permission `admin:gateways:write`, Super Admin
only). The secret key and webhook secret are sealed with a platform data key (`platform-config` purpose, KEK outside the
database) into `payment_gateway_configs.secrets_enc`, AAD `payment_gateway_configs.secrets:<GATEWAY>`. They are
write-only: Prisma omits the column globally (`packages/db` `SECRET_OMIT`), no API returns it, the audit entry records
only `secretsReplaced: true`, and the admin sees "configured" plus a hint (`sk_test_…ab12`). Register the webhook URL
`<API origin>/api/v1/billing/webhooks/stripe` (or `/razorpay`) at the gateway.

Gateway prices are linked per price version in **Super Admin → Plans** (`stripePriceId` = `price_…`, `razorpayPlanId` =
`plan_…`). A version without a link for the currency's gateway cannot be bought (the customer page says so).

## 3. Plans, prices and entitlements

- **Example plans (decision B2 is open):** Free, Starter, Pro, Business with INR + USD monthly/annual prices. Every
  description starts with "Example pricing (decision B2)". The seed inserts a plan only if its key does not exist and never
  overwrites admin edits.
- Prices are immutable versions (`plan_prices UNIQUE(plan, interval, currency, version)`); a new amount is a new version
  and retires the previous active one. Gateway ids can be linked once, never re-pointed.
- Entitlements are the `monitoring.*` registry keys (`ENTITLEMENT_KEY_TYPES`), validated by type on write. Per-org
  overrides (`entitlement_overrides`, optional expiry) win over the plan.
- Resolution (`selectPlanSource`): subscription → active trial → free plan → platform defaults, then overrides on top.
  With billing disabled: subscription plan or platform defaults (unchanged). Everything is read from the database on every
  scheduler cycle / job start, so an admin change applies on the next cycle — well under 60 s (integration test asserts
  it on the next resolution).

## 4. Subscription state machine

```
TRIALING ─▶ ACTIVE ─▶ PAST_DUE ──(grace elapsed, daily job)──▶ EXPIRED
    │         │ ▲        │
    │         ▼ │        ▼
    └─────▶ CANCELING ──(period end, daily job)──▶ CANCELED
```

- Facts: `SNAPSHOT` (the gateway's view: status, period, price, cancel-at-period-end), `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`.
- **Out-of-order guard:** each fact carries the gateway's event time; anything older than `subscriptions.gateway_updated_at`
  is ignored (`STALE_EVENT`). A delayed failure can never undo a later success.
- CANCELED / EXPIRED are terminal; subscribing again creates a new row (partial unique index: one current subscription per org).
- PAST_DUE sets `grace_ends_at = first failure + billing.graceDays` (kept across retries); recovery clears it.
- Upgrades apply immediately; proration is the gateway's. Razorpay downgrades are scheduled for the cycle end
  (`pending_plan_price_id`); Stripe downgrades apply immediately with Stripe's proration credit (no subscription schedules).
- Customer-initiated changes are applied optimistically from the gateway's API response **without** advancing
  `gateway_updated_at`, so the gateway's own webhook still applies afterwards.

## 5. Webhook security

1. **Raw body.** Nest is created with `rawBody: true`; verification uses `req.rawBody`, never a re-serialised object
   (unit test: a whitespace-only change fails).
2. **Signatures.** Stripe: `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 over `t.rawBody`, any `v1` may match (rotation),
   `|now − t| ≤ billing.webhookToleranceSec`. Razorpay: `X-Razorpay-Signature` = hex HMAC-SHA256(rawBody). Constant-time
   comparison. Failures → 400 and a `WEBHOOK_SIG_INVALID` security event (no payload stored).
3. **Replay.** Stripe: the timestamp window. Both: `payment_webhook_events UNIQUE(gateway, event_id)` (rule #11) — the
   event id is claimed inside the processing transaction; a second delivery (even freshly signed) returns 200
   `DUPLICATE` and changes nothing. Razorpay signs no delivery time and retries for ~24 h with the original
   `created_at`, so its signed `created_at` must be at most 3 days old.
4. **Tenant binding.** The organisation comes from `billing_resolve_org` (SECURITY DEFINER, returns only an id) for known
   subscriptions/customers, else from the org id we attached at checkout (Stripe metadata/client_reference_id, Razorpay
   notes — covered by the signature). If both exist and differ the event is refused (`FAILED`). All writes then run in
   `withTenant(org)` — RLS stays on; the API role has no system context.
5. **One transaction.** Claiming the event, the state transition, payments and invoices commit together; on error
   everything rolls back, the event is recorded `FAILED`, and a re-delivery retries it.
6. **Public route hygiene.** The webhook routes are `@Infra` (no session, no CSRF — authenticity is the signature), rate
   limited to 300/min per gateway per source /24, 64 KiB body limit, and answer 503 while billing or the gateway is off.
7. **Data minimisation.** `payment_webhook_events.payload` keeps identifiers only (type, ids, status), not the gateway payload.

## 6. Customer API (`/api/v1/orgs/:orgId/billing`)

`GET /` overview (plan, trial, entitlement source, limits, usage), `GET /plans`, `GET /invoices` — `billing:read`.
`POST /checkout`, `/change-plan`, `/cancel`, `/resume` — `billing:manage` (owners), rate limited per org, audited in the
org stream. All non-member access is a 404 (covered automatically by `tenant-isolation.test.ts`).

## 7. Admin API (`/api/admin/v1`)

`billing/plans` (GET, POST), `billing/plans/:id` (PATCH), `billing/plans/:id/entitlements` (PUT, full replacement),
`billing/plans/:id/prices` (POST), `billing/prices/:id` (PATCH), `billing/entitlement-keys`, `billing/gateways` (GET),
`billing/gateways/:gateway` (PUT), `customers/:orgId/entitlement-overrides` (GET, PUT, POST `/remove`). Permissions:
`admin:billing:read`, `admin:billing:write` (Super Admin, Billing admin), `admin:gateways:write` (Super Admin). Every
mutation requires a reason and writes a platform audit entry in the same transaction.

## 8. Daily reconciliation (scheduler)

Checked every 10 minutes, runs once per 23 h platform-wide (`pg_try_advisory_xact_lock` + run marker in
`system_health_logs`): CANCELING past period end → CANCELED; PAST_DUE past grace → EXPIRED; trials of paying orgs →
CONVERTED; and, only when billing is enabled, a gateway is configured and the scheduler has the key ring
(`KEK_RING_FILE`/`KEK_RING_JSON`), each current gateway subscription is fetched and applied through the state machine
(`reconcile_corrected` health metric per correction).

## 9. Trials and abuse (rule #2)

Unchanged from Phase 3 and now tied to billing: the trial starts at the first verified website, `domain_trial_ledger`
has no FK to organisations and is never deleted, so deleting the account and signing up again with the same domain
yields `DOMAIN_PREVIOUSLY_TRIALED`, no trial and no entitlement (integration test). With billing enabled the trial uses
`trial.planKey` entitlements.

## 10. What is verified and what is not

Verified (2026-11-15, Docker Postgres 16 / Redis 7.4 / Mailpit):
- Unit: state machine, dunning, plan-change classification, plan-source selection, entitlement validation (core, 16 new);
  signature verification — valid, tampered body, re-serialised body, wrong secret, expired and future timestamps,
  malformed/missing headers — and adapter request/parse shapes against a fake transport (billing, 17).
- Integration (`apps/api/test/integration/billing.test.ts`, 17 tests, real API/DB/RLS, gateways are local HTTP fakes):
  billing-off behaviour; spoofed, tampered, stale and replayed webhooks rejected; idempotency; out-of-order events;
  org-mismatch refusal; Razorpay charge → subscription, payment, numbered invoice with GST share; checkout/RBAC;
  tenant isolation of billing endpoints and RLS as `wim_app`; cancel/resume/upgrade; admin entitlement change applied on
  the next resolution; reconciliation (expiry, cancellation, drift correction, single runner); delete account → new
  account → same domain → no trial; no admin endpoint returns gateway secrets.
- `packages/db/tests/invariants.sql` billing block (RLS, UNIQUE(gateway,event_id), grants, definer resolver).

**Not verified / not done:**
- **Stripe and Razorpay test-mode end-to-end** (roadmap exit criterion): not run — no test keys, and no external
  accounts were created. The adapters follow the documented REST shapes (Stripe API version `2025-03-31.basil` pinned
  in requests); expect small payload fixes during the first test-mode run.
- Dunning **emails**: the schedule is computed but no reminder email is sent yet (the gateways' own dunning emails
  should be enabled meanwhile).
- Customer portal (payment-method update) links, refunds and credit notes, invoice PDFs, abuse signals / risk score at
  checkout (card fingerprint), and a downgrade "choose which websites stay monitored" flow (today the oldest websites
  stay within the limit, as before).
- Super Admin UI for per-organisation entitlement overrides (the API exists; the customer detail page is Phase 9).
- The API's global 64 KiB body limit also applies to webhooks; unusually large Stripe invoice events (many line items)
  would be refused with 413 and retried by Stripe — raise the limit for the webhook routes if that shows up.
- GST invoicing details (place of supply, CGST/SGST vs IGST split, seller GSTIN on invoices, gapless numbering —
  `invoice_number_seq` can skip a number on rollback) wait for decision B4b.
