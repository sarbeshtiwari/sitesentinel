# Render deploy checklist (2026-11-15)

Deploy branch: **`main`**. All steps use your own credentials; never paste them into chat or commit them.
`$DB` = the Render **external** database URL of the owner user, with `?sslmode=require`.

## 1. Database (once, from your Mac, repo root on `main`)
```bash
git checkout main && git pull
for f in packages/db/sql/*.sql; do echo "$f"; psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | grep -v "no privileges could be revoked" || break; done
MIGRATION_DATABASE_URL="$DB" node packages/db/scripts/seed.mjs
```
Expect no `ERROR`; the seed prints the example plans it added. (`pnpm db:migrate` does the same but drops
connections to Render more often.)

## 2. Render services → Branch `main` → Manual Deploy → Clear build cache & deploy
| Service | Check after deploy |
|---|---|
| API | `curl https://<api>/health/ready` → `{"status":"ok",…}` |
| Web | `/login` loads; signed in, pages work |
| Ingest | `https://<ingest>/sdk/monitor.v1.js` returns JavaScript |

Billing stays **off** (`billing.enabled = false`) — no payment provider is called until you enable it in admin.

## 3. Background workers (on your Mac until an always-on host exists)
```bash
mkdir -p ~/.sitesentinel && cp scripts/live/live.env.example ~/.sitesentinel/live.env
# fill in the values, then:
chmod 600 ~/.sitesentinel/live.env
# stop the old terminals (Ctrl+C in each), then:
pnpm -s turbo run build --filter=@wim/egress-gateway... --filter=@wim/worker-http... --filter=@wim/worker-deepscan... --filter=@wim/worker-notify... --filter=@wim/scheduler...
scripts/live/run-workers.sh
caffeinate -s   # keep the Mac awake
```
All five must show ✓ — including **worker-notify** (it was never running: that is why a down site
produced no notifications).

## 4. Verify the fixes on the live site
1. **Notifications:** `psql "$DB" -v host=ziptat.in -f scripts/live/diagnose.sql` — outbox events must get a
   `published_at` once worker-notify runs. In-app notifications work without an email provider.
2. **Down → incident:** an incident opens after `monitoring.http.failureThreshold` (default 2) **FAILED** checks in a
   row. INCONCLUSIVE checks (our network, not your site) never open one — the diagnose output shows which you got.
3. **Deep scan:** Start scan on ziptat.in → ~19 pages, Forms & search findings appear if any apply.
4. **Email** (optional today): set `EMAIL_PROVIDER`/`RESEND_API_KEY`/`EMAIL_FROM_DOMAIN` in `live.env` with a domain
   verified at Resend, rerun `scripts/live/run-workers.sh`.

## 5. Security clean-up (do before sharing the URL)
- Rotate the `sitesentinel_db_user` password and the `CHANGE_ME_*`-era role passwords if any are still in use.
- Replace `KEK_RING_JSON` if the value in `.env` line 52 was the production key (it appeared in chat); remove it from `.env`.
- Change the starestate@starestate.com password that was generated in chat.
- Tighten the Redis inbound rule to your current IP.
