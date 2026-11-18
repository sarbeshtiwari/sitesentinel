#!/usr/bin/env bash
# SiteSentinel — one-time host setup for an Oracle Cloud Ampere A1 VM (Ubuntu 22.04/24.04, arm64; also works on amd64).
# Run as a sudo-capable user from a checkout of the repository (docs/DEPLOY_ORACLE.md §5):
#   sudo infra/oracle/setup.sh
# Idempotent: safe to re-run (it never overwrites existing secrets, certificates or data).
#
# What it does:
#   1. apt upgrade, unattended security upgrades, base tools (git, curl, jq, gnupg, awscli, fail2ban, iptables-persistent)
#   2. Docker Engine + compose plugin from Docker's apt repository; json-file log rotation; live-restore
#   3. 4 GB swap file (vm.swappiness=10)
#   4. Firewall: SSH from anywhere (tighten later), 80/443 ONLY from Cloudflare (infra/oracle/firewall.sh);
#      Oracle's default iptables REJECT rule is handled; Docker-published ports are filtered in DOCKER-USER
#   5. fail2ban for sshd
#   6. /opt/sitesentinel: .env with strong random secrets (600), internal PostgreSQL TLS CA + cert, certs/ placeholder,
#      backups/; systemd timers for daily backups and weekly Cloudflare range refresh
# Secrets are generated with openssl and written only to /opt/sitesentinel/.env — never printed.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo: sudo $0" >&2; exit 1; fi
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO/infra/oracle"
APP_DIR="${SITESENTINEL_DIR:-/opt/sitesentinel}"
DEPLOY_USER="${SUDO_USER:-ubuntu}"
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------------------------------------- 1. packages
step "System packages and unattended security upgrades"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
# iptables-persistent (shipped on Oracle images) keeps Oracle's rules.v4; it conflicts with the ufw package, and ufw
# cannot filter Docker-published ports anyway — the firewall is plain iptables (firewall.sh). Don't save the current
# (Docker-modified) ruleset on install.
echo 'iptables-persistent iptables-persistent/autosave_v4 boolean false' | debconf-set-selections
echo 'iptables-persistent iptables-persistent/autosave_v6 boolean false' | debconf-set-selections
apt-get install -y -q ca-certificates curl gnupg git jq openssl fail2ban unattended-upgrades \
  apt-listchanges iptables iptables-persistent netfilter-persistent unzip
# AWS CLI v2 (backups to S3). Ubuntu 24.04 dropped the awscli deb; use the official arm64/x86_64 bundle.
if ! command -v aws >/dev/null 2>&1; then
  arch="$(uname -m)"; tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "$tmp/awscliv2.zip"
  unzip -q "$tmp/awscliv2.zip" -d "$tmp" && "$tmp/aws/install" --update >/dev/null
  rm -rf "$tmp"
fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Security updates only, automatic reboot at 03:30 (IST is UTC+5:30 → set your server TZ if you prefer) when needed.
cat > /etc/apt/apt.conf.d/51sitesentinel-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

# ---------------------------------------------------------------------------------------------- 2. docker
step "Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true,
  "default-address-pools": [{ "base": "172.30.0.0/16", "size": 24 }]
}
EOF
  systemctl restart docker
fi
# Start Docker after Oracle's saved iptables rules are restored, so Docker's FORWARD rules sit ahead of Oracle's
# final "FORWARD -j REJECT" (otherwise published ports and container egress break after a reboot).
mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nAfter=netfilter-persistent.service\n' > /etc/systemd/system/docker.service.d/10-after-netfilter.conf
systemctl daemon-reload
systemctl enable --now docker >/dev/null
# The deploy user may run docker (equivalent to root — only give this to the server owner).
usermod -aG docker "$DEPLOY_USER" || true

# ---------------------------------------------------------------------------------------------- 3. swap
step "4 GB swap"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-sitesentinel.conf
echo 'net.ipv4.conf.all.rp_filter=1' >> /etc/sysctl.d/90-sitesentinel.conf
sysctl -q --system

# ---------------------------------------------------------------------------------------------- 4. firewall
step "Firewall (SSH open, 80/443 from Cloudflare only)"
SITESENTINEL_DIR="$APP_DIR" "$HERE/firewall.sh"

# ---------------------------------------------------------------------------------------------- 5. fail2ban
step "fail2ban for sshd"
cat > /etc/fail2ban/jail.d/sitesentinel-sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

# ---------------------------------------------------------------------------------------------- 6. app directory
step "Application directory $APP_DIR"
install -d -m 755 "$APP_DIR"
install -d -m 755 "$APP_DIR/certs"
install -d -m 750 "$APP_DIR/backups"
"$HERE/gen-secrets.sh" "$APP_DIR/.env"
# The real deployment paths (not the local test values).
sed -i "s#^SITESENTINEL_DIR=.*#SITESENTINEL_DIR=${APP_DIR}#" "$APP_DIR/.env"
chown root:root "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
"$HERE/gen-pg-tls.sh" "$APP_DIR/pg-tls"
if [ ! -f "$APP_DIR/certs/origin.pem" ]; then
  cat > "$APP_DIR/certs/README.txt" <<'EOF'
Put the Cloudflare Origin Certificate here (docs/DEPLOY_ORACLE.md §4):
  origin.pem  — the certificate (PEM)          chmod 644
  origin.key  — the private key (PEM)          chmod 644 is required: nginx runs as uid 101 inside its container.
                                               The directory itself is root-only writable; the key never leaves it.
Optional: cloudflare-origin-pull-ca.pem for Authenticated Origin Pulls (nginx/snippets/tls.conf).
EOF
fi
[ -f "$APP_DIR/cloudflare-realip.conf" ] || install -m 644 "$HERE/nginx/cloudflare-realip.conf" "$APP_DIR/cloudflare-realip.conf"
echo "$REPO" > "$APP_DIR/repo-path"

# ---------------------------------------------------------------------------------------------- 7. timers
step "systemd: firewall at boot, daily encrypted backup, weekly Cloudflare range refresh"
for unit in sitesentinel-firewall.service sitesentinel-backup.service sitesentinel-backup.timer sitesentinel-cf-ips.service sitesentinel-cf-ips.timer; do
  sed -e "s#@REPO@#${REPO}#g" -e "s#@APP_DIR@#${APP_DIR}#g" "$HERE/systemd/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable sitesentinel-firewall.service >/dev/null
systemctl enable --now sitesentinel-backup.timer sitesentinel-cf-ips.timer >/dev/null

step "Done"
cat <<EOF
Next steps (docs/DEPLOY_ORACLE.md):
  1. Copy the Cloudflare Origin Certificate to $APP_DIR/certs/origin.pem and origin.key
  2. sudo nano $APP_DIR/.env   → fill in the TODO lines (S3 keys + bucket, backup bucket, email, OPS_FALLBACK_ALERT_EMAILS)
     When migrating from Render: replace KEK_RING_JSON with the value from the Render API service.
  3. Log out and back in (docker group), then: sudo infra/oracle/deploy.sh
EOF
