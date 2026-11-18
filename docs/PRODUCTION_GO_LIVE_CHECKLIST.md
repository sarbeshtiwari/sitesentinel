# Production go-live checklist

Companion to `FINAL_PRODUCTION_READINESS_AUDIT.md` (2026-11-15). Tick an item only with evidence (run ID, query
output, screenshot). Items are ordered: **do the "Immediately" block before anything else.**

## Immediately (live system, today)

- [ ] **Apply the view-grant fix** (critical). Deploy `main` ≥ `a03617b`, then run the SQL layer as the owner:
      `for f in packages/db/sql/*.sql; do psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f" || break; done`.
      Verify (must print 0 for both):
      `select count(*) from pg_class where relkind='v' and relnamespace='public'::regnamespace and has_table_privilege('wim_app', oid, 'SELECT');`
      and the same for `wim_worker`. Live currently: **17 / 17** (failing).
- [ ] **Turn off functional testing** — Super Admin → Settings → `monitoring.functional.enabled = false`
      (currently `true` on live; release blocker 9 is open, see SECURITY_AUDIT_REPORT "High").
- [ ] **Turn off billing** — `billing.enabled = false` (currently `true` on live; Phase 8 is incomplete).
- [ ] **Rotate every credential that appeared in chat, `.env` or `text.txt`**: Postgres owner password and all
      `wim_*` role passwords, Redis password, `KEK_RING_JSON` (re-wrap data keys — see SECRETS_AND_CREDENTIALS.md),
      `EGRESS_TOKEN_SECRET`, AWS S3 keys (scope the new key to the one bucket), the generated customer password.
      Then delete those values from `.env` and `text.txt`; keep them only in the secret store / `~/.sitesentinel/live.env`.
- [ ] Restart live workers on the new code (`scripts/live/run-workers.sh`) so the deep-scan occurrence fix is active.

## Before limited production (internal / approved test websites)

- [ ] Workers on an always-on host near the database (not a laptop); browser runner on a Linux node with user
      namespaces and the documented seccomp/cap-drop flags (DEPLOYMENT.md §24–25).
- [ ] Every service refuses development passwords and non-TLS DB URLs in production (finding F-6: add
      `assertDatabaseRole` to API, ingest, scheduler, worker-http, worker-notify) — and set `?sslmode=require`
      on every Render `*_DATABASE_URL` **first**, or the services will refuse to start.
- [ ] Decide the proxy hop count and set rate-limit IP extraction accordingly (finding F-1); verify 429 cannot be
      bypassed with a forged `X-Forwarded-For`.
- [ ] HSTS + COOP on web/admin; align CSP/Referrer-Policy with SECURITY.md (F-7).
- [ ] Real email provider (Resend/SES) with a verified sender domain (SPF/DKIM/DMARC); `OPS_FALLBACK_ALERT_EMAILS` set.
- [ ] Object storage bucket policy private; screenshot download works end to end with a signed URL.
- [ ] Backups: automated Postgres backups with a timed restore drill on the production-like database.
- [ ] Monitoring of the platform itself reaches a human (platform alerts → email/pager).
- [ ] Lint actually runs (add ESLint config or remove the claim from RELEASE_READINESS.md).

## Before public commercial launch

- [ ] Release blockers 1, 2, 6, 7, 8 closed with staging/production evidence (see the blocker table in the audit).
- [ ] Blocker 9: functional testing stays **unsupported** in production unless an isolation mechanism exists or the
      product owner signs a written risk acceptance.
- [ ] Tighten `wim_worker` to least privilege (F-4) and decide on RLS hardening for compromised-credential cases (F-2).
- [ ] Admin auditor access to org audit streams masked and itself audited (F-3).
- [ ] Missing Phase-3 account features: org-level "require 2FA", email change, re-authentication window.
- [ ] Organisation deletion actually executed after the grace period (today: request recorded only); retention
      purges for expired sessions/tokens and published outbox rows.
- [ ] Billing (Phase 8) completed and verified: Stripe and Razorpay test-mode E2E (upgrade, downgrade, cancel,
      failed payment), dunning, invoices with final GST rules (decision B4b), real prices (decision B2), refunds,
      downgrade website selection, abuse/risk signals.
- [ ] Legal: terms, privacy policy, domain-ledger retention disclosure reviewed (decision B8).
- [ ] Production load test at plan limits and dashboard polling at target concurrency (blockers 7/8).
