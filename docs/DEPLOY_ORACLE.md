# Deploying SiteSentinel on Oracle Cloud (Always Free) behind Cloudflare

> Status: deployment kit for the first always-on production host · Last updated 2026-11-18
>
> Kit: [`infra/oracle/`](../infra/oracle) · Related: [DEPLOYMENT.md](DEPLOYMENT.md) · [SECURITY.md](SECURITY.md) (§25 network isolation, §29 browser sandbox) · [SECRETS_AND_CREDENTIALS.md](SECRETS_AND_CREDENTIALS.md)

One Oracle Cloud **Ampere A1** virtual machine (ARM, 4 cores, 24 GB RAM — free forever) runs the complete
platform in Docker: PostgreSQL, Redis, the API, both web apps, ingest, the scheduler, every worker, the sandboxed
browser and the egress gateway. Cloudflare sits in front (DNS, TLS, DDoS protection). Screenshots stay in the
existing AWS S3 bucket. Cost: **₹0 per month** for Oracle and Cloudflare (S3 and email are billed as today).

| Hostname | Serves |
|---|---|
| `sentinel-client.ziptat.in` | Customer app (web, `/api/*` → API on the same origin) |
| `sentinel-admin.ziptat.in` | Super Admin app (`/api/admin/*` → API) |
| `sentinel-api.ziptat.in` | API: health, payment webhooks, screenshot download links |
| `sentinel-ingest.ziptat.in` | SDK script `/sdk/monitor.v1.js`, telemetry and heartbeats from customer sites |

`ziptat.in` and `www.ziptat.in` stay on Vercel. Nothing here changes them.

**Time needed:** about 2 hours the first time, plus waiting for Oracle to have free ARM capacity.

---

## Contents

1. [What you get and the limits](#1-what-you-get-and-the-limits)
2. [Create the Oracle account](#2-create-the-oracle-account)
3. [Create the VM](#3-create-the-vm)
4. [Cloudflare: DNS, TLS, origin certificate, WAF](#4-cloudflare-dns-tls-origin-certificate-waf)
5. [Prepare the server (setup.sh)](#5-prepare-the-server-setupsh)
6. [Fill in the remaining settings](#6-fill-in-the-remaining-settings)
7. [Deploy (deploy.sh)](#7-deploy-deploysh)
8. [Create the first Super Admin](#8-create-the-first-super-admin)
9. [Verify every URL](#9-verify-every-url)
10. [Backups and the restore drill](#10-backups-and-the-restore-drill)
11. [Moving from Render (data migration and cut-over)](#11-moving-from-render-data-migration-and-cut-over)
12. [Day-2 operations](#12-day-2-operations)
13. [Troubleshooting](#13-troubleshooting)
14. [Security notes (what the kit enforces)](#14-security-notes-what-the-kit-enforces)

---

## 1. What you get and the limits

**Always Free (no expiry) — what this deployment uses**

| Resource | Free allowance | Used here |
|---|---|---|
| Ampere A1 compute | 4 OCPU + 24 GB RAM total (3,000 OCPU-hours + 18,000 GB-hours / month) | 1 VM, 4 OCPU, 24 GB |
| Boot/block volume | 200 GB total | 100 GB boot volume (enough for years of monitoring data at launch scale) |
| Outbound data | 10 TB / month | far below |
| Public IPv4 | 1 reserved (or ephemeral) | 1 |
| Cloudflare Free | DNS, proxy, Universal SSL (covers `*.ziptat.in` one level deep), Origin CA | 4 proxied records |

**Memory budget** (container limits, set in `docker-compose.prod.yml`): PostgreSQL 5 GB, Redis 1 GB, browser-runner 1 GB,
API 1 GB, web 768 MB, admin 512 MB, ingest 512 MB, worker-http / worker-deepscan / worker-browser 768 MB each,
egress-gateway 512 MB, scheduler / worker-notify 384 MB each, nginx 256 MB — about 14 GB worst case; actual use at rest is
far lower (≈1.4 GB measured at rest, see §9). The rest is page cache for PostgreSQL plus a 4 GB swap file.

**Limits to know**
- **Single server**: no automatic failover. A VM reboot (kernel update at 03:30 IST when needed) means ~1–2 minutes of
  downtime. Backups go to S3 daily; worst-case data loss is 24 hours (see §10 to tighten).
- **Idle reclamation**: Oracle may reclaim Always Free VMs that stay almost idle for 7 days (CPU, network and memory all
  under ~20%). SiteSentinel's checks keep it busy; upgrading the account to *Pay As You Go* (still ₹0 if you stay
  within the free shapes) removes the reclamation rule entirely — recommended (§2).
- **Capacity**: popular regions often have no free ARM capacity at the moment you ask. See §13.
- **Region choice is permanent** for the free tier (your *home region*). Choose **India South (Hyderabad)** or
  **India West (Mumbai)**.

## 2. Create the Oracle account

1. Go to <https://signup.cloud.oracle.com>, choose **Free Tier**.
2. Use your real name and address; a **credit/debit card is needed for identity verification** (a small temporary
   authorisation is reversed). Virtual/prepaid cards are usually refused.
3. **Home region**: *India South (Hyderabad)* or *India West (Mumbai)*. It cannot be changed later.
4. After sign-in: *Billing & Cost Management → Upgrade and Manage Payment → Pay As You Go* (optional, recommended).
   PAYG accounts keep everything in Always Free at ₹0, are not subject to idle reclamation and get ARM capacity more
   easily. To be sure nothing is ever billed: *Billing → Budgets → Create budget* of ₹1 with an email alert, and only
   ever create resources labelled **Always Free-eligible**.
5. Turn on MFA for the Oracle account (*Profile → Security*).

## 3. Create the VM

**SSH key (on your Mac)**: `ssh-keygen -t ed25519 -f ~/.ssh/sitesentinel-oracle -C sitesentinel` (set a passphrase).

1. *Networking → Virtual Cloud Networks → Start VCN Wizard → Create VCN with Internet Connectivity*. Name `sitesentinel`;
   defaults are fine (10.0.0.0/16).
2. Open the VCN → *Security Lists → Default Security List* → *Add Ingress Rules*:
   | Source CIDR | Protocol | Port | Why |
   |---|---|---|---|
   | `0.0.0.0/0` | TCP | 22 | SSH (already present). Later: replace with your own IP `/32` for extra safety |
   | `0.0.0.0/0` | TCP | 80 | HTTP → redirect (the VM firewall only lets Cloudflare in) |
   | `0.0.0.0/0` | TCP | 443 | HTTPS (same) |
   Optionally, instead of `0.0.0.0/0` for 80/443, add one rule per Cloudflare range from <https://www.cloudflare.com/ips-v4>.
3. *Compute → Instances → Create instance*:
   - Name `sitesentinel-prod`.
   - **Image**: *Canonical Ubuntu 24.04* (22.04 also works). Not "Minimal" (it lacks tools the setup expects).
   - **Shape**: *Change shape → Ampere → VM.Standard.A1.Flex*, **4 OCPU, 24 GB**. It must show *Always Free-eligible*.
   - Networking: the `sitesentinel` VCN, public subnet, **Assign a public IPv4 address**.
   - SSH keys: *Paste public key* → contents of `~/.ssh/sitesentinel-oracle.pub`.
   - Boot volume: *Specify a custom size* **100 GB** (free up to 200 GB total).
   - Create. If you get **"Out of capacity for shape VM.Standard.A1.Flex"**, see §13.
4. Note the **public IP** (Instance details). Optional but recommended: *Networking → Reserved Public IPs* and attach
   one, so the IP survives stopping/starting the VM (free while attached).
5. Connect: `ssh -i ~/.ssh/sitesentinel-oracle ubuntu@<PUBLIC_IP>`.

## 4. Cloudflare: DNS, TLS, origin certificate, WAF

All in the Cloudflare dashboard for `ziptat.in`.

**DNS** → *Add record*, four times — type **A**, **Proxied (orange cloud)**, TTL Auto:

| Name | IPv4 address |
|---|---|
| `sentinel-client` | `<PUBLIC_IP>` |
| `sentinel-admin` | `<PUBLIC_IP>` |
| `sentinel-api` | `<PUBLIC_IP>` |
| `sentinel-ingest` | `<PUBLIC_IP>` |

Leave the existing `ziptat.in` / `www` records (Vercel) exactly as they are. First-level names like these are covered
by the free Universal SSL certificate; deeper names (`a.b.ziptat.in`) would not be.

**SSL/TLS → Overview**: encryption mode **Full (strict)**. (The zone-wide mode also applies to the Vercel apex, which
serves a valid certificate, so this is safe. If you prefer to leave the zone setting alone, create a *Configuration
Rule* for the four `sentinel-*` hostnames with SSL = Full (strict).)

**SSL/TLS → Edge Certificates**: *Always Use HTTPS* on; *Minimum TLS Version* 1.2; HSTS can stay off here (nginx
sends HSTS for the `sentinel-*` hosts only).

**SSL/TLS → Origin Server → Create Certificate**: *Generate private key and CSR with Cloudflare*, key type RSA (2048),
hostnames `*.ziptat.in` and `ziptat.in`, validity 15 years → Create. Keep this page open: copy the **Origin
Certificate** and the **Private Key** (shown only once) — you will paste them on the server in §6.

**Authenticated Origin Pulls (optional, extra protection)**: *SSL/TLS → Origin Server → Authenticated Origin Pulls* →
On, then on the server download the CA
(`curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem | sudo tee /opt/sitesentinel/certs/cloudflare-origin-pull-ca.pem`),
uncomment the two `ssl_client_certificate` / `ssl_verify_client` lines in `infra/oracle/nginx/snippets/tls.conf`, and
`sudo infra/oracle/deploy.sh`. With it, nginx refuses any TLS client that is not Cloudflare, even if the firewall were
misconfigured. (Enable it on Cloudflare first, then nginx — the other order causes a few minutes of 400 errors.)

**Security → Bots**: *Bot Fight Mode* **Off** (it challenges non-browser clients). Customer websites send
heartbeats/telemetry to `sentinel-ingest` with `fetch`/`sendBeacon` — a challenge page would silently drop them. If you
want Bot Fight Mode for the rest of the zone, use Super Bot Fight Mode (Pro) with a skip, or keep it off.

**Security → WAF → Custom rules → Create rule** "SiteSentinel ingest skip":
`(http.host eq "sentinel-ingest.ziptat.in")` → action **Skip** → tick *All remaining custom rules*, *Rate limiting
rules*, *Super Bot Fight Mode*, *Browser Integrity Check*… (whatever is offered on your plan). Also skip *Security
Level* / *Browser Integrity Check* for the same host via *Configuration Rules* if challenges appear. Payment webhooks
on `sentinel-api.ziptat.in/api/v1/billing/webhooks/*` need the same treatment once billing is enabled.

**Caching**: default is fine (Cloudflare caches `/sdk/monitor.v1.js` and `/_next/static/*` per their headers, never
HTML or `/api`).

## 5. Prepare the server (setup.sh)

On the VM (`ssh ubuntu@<PUBLIC_IP>`):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/sarbeshtiwari/sitesentinel.git ~/sitesentinel
cd ~/sitesentinel
git checkout main            # the branch you deploy
sudo infra/oracle/setup.sh   # 5–10 minutes; safe to re-run
```

`setup.sh` (idempotent, `set -euo pipefail`):

- updates Ubuntu, enables **unattended security upgrades** (automatic reboot at 03:30 if a kernel update needs it);
- installs **Docker Engine + compose plugin** (from Docker's repository), log rotation, AWS CLI v2, fail2ban;
- adds a **4 GB swap file**;
- **firewall**: keeps Oracle's iptables rules (SSH 22 open, everything else rejected) and adds rules in Docker's
  `DOCKER-USER` chain so that **80/443 only accept Cloudflare's IP ranges** and no other container port is reachable
  from the internet; containers cannot reach the cloud metadata address. (`ufw` is deliberately not used: it cannot
  filter Docker-published ports and conflicts with Oracle's `iptables-persistent`. See the header of
  `infra/oracle/firewall.sh`.) Ranges refresh weekly (`sitesentinel-cf-ips.timer`);
- **fail2ban** for SSH (5 failures in 10 minutes → 1 hour ban);
- creates `/opt/sitesentinel/` with `.env` (mode 600) holding **freshly generated random secrets** — every database
  role password, the Redis password, `EGRESS_TOKEN_SECRET`, the encryption key ring `KEK_RING_JSON`, the backup
  passphrase. Nothing is printed. It also creates a private CA + TLS certificate for PostgreSQL (`pg-tls/`);
- installs the daily backup timer and the boot-time firewall service.

Log out and back in once (so your user is in the `docker` group).

**Restrict SSH later (recommended)**: in the VCN security list, change the port 22 source from `0.0.0.0/0` to
`<your-home-ip>/32`. If your IP changes, use Oracle's *Cloud Shell* (browser) to fix it.

## 6. Fill in the remaining settings

**Origin certificate** (from §4):
```bash
sudo nano /opt/sitesentinel/certs/origin.pem     # paste the Origin Certificate
sudo nano /opt/sitesentinel/certs/origin.key     # paste the Private Key
sudo chmod 644 /opt/sitesentinel/certs/origin.pem /opt/sitesentinel/certs/origin.key
```
(nginx runs as an unprivileged user inside its container, so the key must be readable; the directory is only
writable by root and nothing else mounts it.)

**Settings**: `sudo nano /opt/sitesentinel/.env` and replace every `TODO`:

| Variable | What to put |
|---|---|
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_ARTIFACTS` | The existing AWS bucket for screenshots (same values as on Render). `S3_ENDPOINT` is already `https://s3.eu-north-1.amazonaws.com` — change the region part if the bucket lives elsewhere |
| `BACKUP_S3_BUCKET`, `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION` | Where encrypted database backups go. Best: a separate IAM user allowed only `s3:PutObject/GetObject/ListBucket/DeleteObject` on that bucket + prefix. Turn on *Block all public access* and versioning on the bucket |
| `EMAIL_PROVIDER` + `RESEND_API_KEY` (or SMTP_*) | Same as the Render workers. `EMAIL_FROM_DOMAIN` must be verified at the provider |
| `OPS_FALLBACK_ALERT_EMAILS` | Your email(s), comma-separated — **required** (alerts while the database is down) |
| `REGION` | `ap-hyderabad-1` or `ap-mumbai-1` (a label) |
| `KEK_RING_JSON` | **Only when migrating from Render**: replace the generated value with the one from the Render API service's environment (§11). Never paste it anywhere else |

Write down `BACKUP_PASSPHRASE` from the same file in your password manager — without it backups cannot be decrypted.

## 7. Deploy (deploy.sh)

```bash
cd ~/sitesentinel
sudo infra/oracle/deploy.sh          # first build: ~15–25 minutes on the A1; later deploys ~5 minutes
```

It checks the settings, pulls the latest commit, builds all images for ARM (`docker compose build --pull`), starts
PostgreSQL + Redis, runs the one-shot **migrate** service (database roles → `prisma migrate deploy` →
`packages/db/sql/*.sql` → seed; all idempotent), starts everything, waits until every container reports healthy, then
calls each hostname through nginx. Expected end:

```
  ok   https://sentinel-api.ziptat.in/health/ready (200)
  ok   https://sentinel-client.ziptat.in/login (200)
  ok   https://sentinel-client.ziptat.in/api/v1/public/config (200)
  ok   https://sentinel-admin.ziptat.in/login (200)
  ok   https://sentinel-ingest.ziptat.in/sdk/monitor.v1.js (200)
  ok   https://sentinel-ingest.ziptat.in/health/live (200)
deployed 1a2b3c4d5e6f
```

Deploy a specific version (also the **rollback** command): `sudo infra/oracle/deploy.sh v1.2.3` (any tag, branch or
commit). Database migrations are forward-only; check CHANGELOG before rolling back across one.

## 8. Create the first Super Admin

Admins are never created through a public page. On the server:

```bash
cd ~/sitesentinel
C="docker compose -p sitesentinel --env-file /opt/sitesentinel/.env -f infra/oracle/docker-compose.prod.yml"
sudo $C run --rm --no-deps api node dist/cli/create-admin.js --email you@example.com --name "Your Name"
```

It prints a **one-time password** and a **TOTP** setup key + QR code (2FA is mandatory for admins). Store the password in
your password manager, add the key to your authenticator app, then sign in at <https://sentinel-admin.ziptat.in>.
(The QR image file it mentions lives in the throw-away container and disappears with it — use the key or the terminal QR.)

*Migrating from Render?* Your existing admins come along with the database (§11); skip this step.

## 9. Verify every URL

From your Mac (through Cloudflare):

```bash
curl -s https://sentinel-api.ziptat.in/health/ready            # {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}
curl -sI https://sentinel-client.ziptat.in/login | head -1      # HTTP/2 200
curl -sI https://sentinel-admin.ziptat.in/login | head -1       # HTTP/2 200
curl -sI https://sentinel-ingest.ziptat.in/sdk/monitor.v1.js | head -1   # HTTP/2 200, content-type javascript
curl -sI http://<PUBLIC_IP>/                                    # must FAIL (timeout): only Cloudflare may connect
```

In the browser: register / sign in at `sentinel-client`, add a website, run a check. In **Super Admin → Operations**
every worker (scheduler, worker-http, worker-deepscan, worker-notify, worker-browser) should show a recent heartbeat,
and browser-runner `sandbox: true`.

On the server: `docker stats --no-stream` shows real memory use (measured ≈1.4 GB for the whole stack at rest with an
empty database; it grows with PostgreSQL's cache and while browser checks run, ~450 MB per Chromium session).

## 10. Backups and the restore drill

**Daily** at 03:00 IST (`sitesentinel-backup.timer`): `pg_dump` (custom format, compressed) → encrypted with
`gpg` AES-256 using `BACKUP_PASSPHRASE` → uploaded to `s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/` → only the newest
**14** kept. The newest 3 also stay in `/opt/sitesentinel/backups`. Each backup is verified (decrypt + list) before upload.

```bash
sudo infra/oracle/backup.sh                       # run one now
systemctl list-timers sitesentinel-backup.timer   # next run
journalctl -u sitesentinel-backup -n 50           # last result
```

**Restore drill (do it once after setup, then monthly)** — restores the newest S3 backup into a scratch database next
to production, prints row counts and drops it; production is not touched:

```bash
sudo TARGET_DB=wim_restore_test infra/oracle/restore.sh latest
```

**Real restore** (replaces production data; stops the apps, restores, re-applies roles/grants/RLS, starts again):

```bash
sudo infra/oracle/restore.sh latest                                   # or s3://…/wim-20261118T213000Z.dump.gpg
```

Also keep **off-server copies of**: `/opt/sitesentinel/.env` (in your password manager: at least `KEK_RING_JSON` and
`BACKUP_PASSPHRASE` — a backup without the key ring has unreadable encrypted columns) and the Origin certificate
(re-creatable in Cloudflare at any time).

Want less than 24 h of potential loss? Run the timer more often (`OnCalendar=*-*-* 00/6:00:00` in
`/etc/systemd/system/sitesentinel-backup.timer`, then `sudo systemctl daemon-reload`).

## 11. Moving from Render (data migration and cut-over)

Goal: same data, same encryption keys, new host; customers' SDK snippets move to the new ingest hostname.
Plan ~30 minutes of monitoring downtime. Do steps 1–7 of this guide first (stack running and verified, empty).

1. **Copy the key ring.** In the Render dashboard open the API service → *Environment* → copy `KEK_RING_JSON` yourself
   and put it into `/opt/sitesentinel/.env` on the server (replacing the generated value). Don't paste it into chat or
   tickets.
2. **Announce** a short maintenance window if you have customers.
3. **Stop the Mac workers** (they write to the Render database):
   `scripts/live/stop-workers.sh` on the Mac, then check nothing is left: `pgrep -fl "apps/.*/dist/main.js"`.
4. **Stop writes on Render**: suspend the Render API, web and ingest services (*Settings → Suspend*), or at least the
   API + ingest.
5. **Dump Render** from your Mac (external URL of the owner user with `?sslmode=require`; your own credentials):
   ```bash
   pg_dump "$RENDER_DB_URL" -Fc -Z 6 --no-owner --no-privileges -f ~/render-final.dump
   pg_restore --list ~/render-final.dump | head          # sanity check
   scp -i ~/.ssh/sitesentinel-oracle ~/render-final.dump ubuntu@<PUBLIC_IP>:/tmp/
   ```
   (Use `pg_dump` 16 or newer: `brew install postgresql@16`.)
6. **Restore on Oracle**:
   ```bash
   sudo infra/oracle/restore.sh --plain /tmp/render-final.dump   # type: restore wim
   rm /tmp/render-final.dump
   ```
   The script recreates the database, restores as `wim_owner`, then re-runs `migrate` (roles, grants, RLS, any newer
   migrations, seed) and starts the stack. Then on the Mac: `rm ~/render-final.dump`.
7. **Check**: sign in at <https://sentinel-client.ziptat.in> with an existing account (2FA must still work — proves the
   key ring is right), open a website's dashboard, *Super Admin → Operations* all green, a manual check succeeds.
8. **Switch the SDK on customer sites.** Each site's install snippet points at the old host. Replace
   `https://sitesentinel-ingest.onrender.com/sdk/monitor.v1.js` with
   `https://sentinel-ingest.ziptat.in/sdk/monitor.v1.js` (the app already shows the new snippet, from `SDK_URL`).
   **Keep the Render ingest service running (un-suspend it) until every site is switched**: sites still on the old
   snippet then keep loading the script without errors. Note that what they send goes to the old Render database,
   which is no longer read — so heartbeats/telemetry from not-yet-switched sites are not counted, and the
   installation check (which looks for the new URL) shows them as "not installed" until their snippet is updated.
   Update your own sites first, then ask customers. Once Render ingest gets no more traffic (Render metrics), suspend it.
9. **Update links** that point at the old hosts (bookmarks, payment gateway webhook URL →
   `https://sentinel-api.ziptat.in/api/v1/billing/webhooks/<provider>` when billing is enabled, email templates use
   `APP_URL` automatically).
10. **Decommission Render** after a week of stable running and a successful restore drill (§10): download a last
    dump for the archive, then delete the Render services, Postgres and Key Value. Remove `~/.sitesentinel/live.env`
    on the Mac (it holds Render credentials). Rotate any credential that was ever shared in chat (see
    DEPLOY_CHECKLIST_RENDER.md §5).

## 12. Day-2 operations

```bash
cd ~/sitesentinel
C="docker compose -p sitesentinel --env-file /opt/sitesentinel/.env -f infra/oracle/docker-compose.prod.yml"
sudo $C ps                                  # status + health
sudo $C logs -f --tail 100 api              # logs of one service (rotated: 5 × 20 MB per container)
sudo $C restart worker-http                 # restart one service
sudo infra/oracle/deploy.sh                 # update to the latest commit
sudo $C exec postgres psql -U wim_owner wim # SQL console (as schema owner)
```

- **Rotate a database/Redis password or `EGRESS_TOKEN_SECRET`**: edit `.env`, `sudo infra/oracle/deploy.sh` (migrate
  re-applies role passwords; every service restarts with the new value). For `PG_SUPERUSER_PASSWORD`, also run
  `sudo $C exec postgres psql -U postgres -c "\password postgres"`.
- **Rotate the KEK**: follow SECURITY.md §12 (add a new key to the ring, make it current, re-wrap) — never just replace it.
- **Disk**: `df -h /` and `docker system df`; `docker builder prune -f` frees build cache.
- **Admin IP allowlist**: list your addresses in `infra/oracle/nginx/snippets/admin-allowlist.conf`, then
  `sudo $C restart nginx`.
- **Browser capacity**: `RUNNER_MAX_SESSIONS` (default 2) and `RUNNER_MEM_LIMIT` in `.env`; ~450 MB per session.

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| **"Out of capacity for shape VM.Standard.A1.Flex"** | Common in Indian regions. Retry at different times (early morning IST works best); try each *Availability Domain*; or create a smaller VM (1 OCPU / 6 GB) and resize it later (*Edit → Shape*) when capacity frees. Upgrading to Pay As You Go (still ₹0) gives priority. Avoid "capacity scripts" that hammer the API |
| **VM reclaimed / stopped by Oracle** | Only free-tier (non-PAYG) accounts with a near-idle VM. Upgrade to PAYG (§2). Data on the boot volume survives a stop; restart the instance |
| **Cloudflare 521 / 522** | The VM firewall or nginx: `sudo $C ps nginx`, `sudo iptables -S DOCKER-USER` (must list `SS-CLOUDFLARE`), VCN security list has 80/443. After a manual `iptables-restore`/`netfilter-persistent reload`: `sudo systemctl restart docker && sudo infra/oracle/firewall.sh` |
| **Cloudflare 525 / 526** | TLS between Cloudflare and nginx: origin cert/key missing or mismatched in `/opt/sitesentinel/certs`, or SSL mode not *Full (strict)* with an Origin CA cert |
| **`migrate` failed** | `sudo $C logs migrate`. Usually a bad `PG_*` password or a SQL error from a new migration; fix and rerun deploy |
| **A service keeps restarting** | `sudo $C logs --tail 50 <service>`. Production guards refuse unsafe config on purpose (e.g. worker-notify without `OPS_FALLBACK_ALERT_EMAILS`, workers with a non-TLS DB URL, test allowances) — the message names the variable |
| **ARM image problems** (`exec format error`, missing Chromium) | All images are built on the VM for its own architecture; never copy images built on an x86 machine. The browser image is `mcr.microsoft.com/playwright:v1.65.0-noble`, which ships arm64 Chromium. If a dependency lacks an arm64 build, `docker compose build --no-cache <service>` shows it |
| **Browser checks fail, runner shows `sandbox: false` or crashes** | The seccomp profile must load: `sudo $C config | grep seccomp`. Ubuntu 24.04 AppArmor user-namespace restriction does not apply inside the container (the profile allows the sandbox's clone/unshare) |
| **Real visitor IPs show as Cloudflare IPs** | `/opt/sitesentinel/cloudflare-realip.conf` outdated: `sudo infra/oracle/update-cloudflare-ips.sh` |
| **Logins rate-limited for everyone** | The API must see real client IPs: `TRUST_PROXY=10.253.10.2` (nginx) in compose and the realip list current |
| **Out of memory** | `docker stats`; lower `RUNNER_MAX_SESSIONS`, PostgreSQL `shared_buffers` in the compose file |

## 14. Security notes (what the kit enforces)

- **Only nginx is exposed** (80/443), and the host firewall only accepts Cloudflare there. PostgreSQL and Redis have no
  published ports; reach them with `docker exec` or an SSH tunnel.
- **Network isolation** mirrors SECURITY.md §25 (`infra/security/isolation`): monitoring traffic (worker-http,
  worker-deepscan, Chromium) leaves only through the **egress gateway**; `browser-runner` is reachable only from
  `worker-browser` (browser-control network), has no database access, no secrets and no internet route; it runs with
  the Chromium seccomp profile, all capabilities dropped, read-only root, 512 PIDs, 1 GB. All app containers run as
  non-root, read-only, `no-new-privileges`, `cap_drop: ALL`.
- **Least-privilege database roles**: each service has its own role (`wim_app`, `wim_admin`, `wim_worker`,
  `wim_browser`, `wim_scanner`, `wim_ingest`; `wim_readonly` for humans), none superuser or BYPASSRLS; the schema owner
  `wim_owner` is not a superuser either and is only used by migrations, backups and restores.
- **TLS to PostgreSQL** even on the internal network: `pg_hba.conf` rejects non-TLS connections; every service connects
  with `sslmode=verify-full` against the private CA created by `setup.sh` (the workers' production startup guard requires
  TLS). Redis is password-protected, `noeviction`, dangerous commands disabled.
- **Client IP / rate limits (audit F-1)**: Cloudflare puts the visitor's address in `CF-Connecting-IP`; nginx accepts it
  only from Cloudflare's ranges (`set_real_ip_from`), then **overwrites** `X-Forwarded-For` with that single address —
  anything a client sends in `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP` is discarded. The API and ingest
  trust `X-Forwarded-For` only from nginx's fixed address (`TRUST_PROXY=10.253.10.2`; the setting now accepts proxy
  IPs/CIDRs, not just true/false), so per-IP limits cannot be bypassed by forging the header.
- **Secrets** live only in `/opt/sitesentinel/.env` (root, 600), generated on the server; each container receives only
  its own variables. Backups are encrypted before they leave the host.
- **Cookies** are host-only (`__Host-`, `Secure`) per hostname; the customer API and the admin API are only routed on
  their own hosts (`/api/admin/*` returns 404 on `sentinel-client` and `sentinel-api`).
