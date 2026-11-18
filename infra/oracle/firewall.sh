#!/usr/bin/env bash
# SiteSentinel host firewall (Oracle Ubuntu images). Idempotent; re-run any time (setup.sh, the weekly Cloudflare
# refresh timer and sitesentinel-firewall.service at boot all call it).
#
# Why iptables and not ufw:
#   * Oracle's Ubuntu images ship /etc/iptables/rules.v4 (netfilter-persistent): INPUT allows SSH and ends with
#     "REJECT --reject-with icmp-host-prohibited". Oracle advises against ufw on these images, and
#   * Docker-published ports never traverse INPUT (they are DNAT-ed and FORWARDed), so ufw rules would NOT restrict
#     nginx's 80/443 at all. Docker's documented hook for that is the DOCKER-USER chain — used below.
# ufw is therefore not used (its package conflicts with iptables-persistent). Do not install or enable it here.
#
# Rules:
#   INPUT        unchanged Oracle default: SSH (22) from anywhere, everything else rejected. To restrict SSH to your
#                own address, edit /etc/iptables/rules.v4 (the "--dport 22" line: add "-s <your-ip>/32") and reboot,
#                and/or restrict the VCN security list (docs/DEPLOY_ORACLE.md).
#   DOCKER-USER  new connections from the public interface to published ports 80/443 → accepted only from
#                Cloudflare's ranges; any other published port → dropped; containers → link-local metadata
#                (169.254.0.0/16) → dropped. Re-applied at boot by sitesentinel-firewall.service (after Docker).
#   FORWARD      Oracle's image also ends FORWARD with a REJECT; Docker inserts its own FORWARD rules ahead of it when
#                it starts, which is why docker.service is ordered after netfilter-persistent (setup.sh drop-in).
# Never run `netfilter-persistent reload` / `iptables-restore` on this host while Docker runs (it flushes Docker's
# chains); if you did, run `sudo systemctl restart docker && sudo infra/oracle/firewall.sh`.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SITESENTINEL_DIR:-/opt/sitesentinel}"

EXT_IF="${EXT_IF:-$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')}"
[ -n "$EXT_IF" ] || { echo "cannot determine the public interface (set EXT_IF)" >&2; exit 1; }

# Cloudflare ranges: live list, falling back to the last good copy (and finally to the repository snapshot).
CF_CACHE="$APP_DIR/cloudflare-ips.txt"
mkdir -p "$APP_DIR"
fetch() { curl -fsS --max-time 15 "https://www.cloudflare.com/ips-$1"; }
if v4="$(fetch v4)" && v6="$(fetch v6)" && [ "$(printf '%s\n' "$v4" | grep -c /)" -ge 10 ]; then
  printf '%s\n%s\n' "$v4" "$v6" > "$CF_CACHE.tmp" && mv "$CF_CACHE.tmp" "$CF_CACHE"
elif [ ! -s "$CF_CACHE" ]; then
  echo "warning: Cloudflare list unavailable; using the repository snapshot" >&2
  sed -n 's/^set_real_ip_from \(.*\);$/\1/p' "$HERE/nginx/cloudflare-realip.conf" > "$CF_CACHE"
fi
mapfile -t CF4 < <(grep -v : "$CF_CACHE" | grep /)
mapfile -t CF6 < <(grep : "$CF_CACHE" | grep /)
[ "${#CF4[@]}" -ge 10 ] || { echo "Cloudflare IPv4 list looks wrong (${#CF4[@]} entries); not changing the firewall" >&2; exit 1; }

# DOCKER-USER is owned by us (Docker only creates it with a final RETURN and never rewrites it), so it is rebuilt
# from scratch each run in one iptables-restore transaction (no window without the restriction):
#   1. NEW tcp from the internet to published 80/443 (conntrack original port, i.e. before Docker's DNAT)
#      → jump to SS-CLOUDFLARE: RETURN (allow) for Cloudflare ranges, DROP otherwise
#   2. any other NEW connection from the internet to a container → DROP (only nginx publishes ports)
#   3. containers → link-local 169.254.0.0/16 (cloud metadata) → DROP          (IPv4 only)
#   4. RETURN
apply() { # apply <iptables|ip6tables> <ranges...>
  local ipt="$1"; shift
  command -v "$ipt-restore" >/dev/null || return 0
  {
    echo "*filter"
    "$ipt" -S DOCKER-USER >/dev/null 2>&1 || echo ":DOCKER-USER - [0:0]"
    "$ipt" -S SS-CLOUDFLARE >/dev/null 2>&1 || echo ":SS-CLOUDFLARE - [0:0]"
    echo "-F DOCKER-USER"
    echo "-F SS-CLOUDFLARE"
    for r in "$@"; do echo "-A SS-CLOUDFLARE -s $r -j RETURN"; done
    echo "-A SS-CLOUDFLARE -j DROP"
    echo "-A DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW -m conntrack --ctorigdstport 80 -j SS-CLOUDFLARE"
    echo "-A DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW -m conntrack --ctorigdstport 443 -j SS-CLOUDFLARE"
    echo "-A DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW -m conntrack --ctorigdstport 80 -j RETURN"
    echo "-A DOCKER-USER -i $EXT_IF -p tcp -m conntrack --ctstate NEW -m conntrack --ctorigdstport 443 -j RETURN"
    echo "-A DOCKER-USER -i $EXT_IF -m conntrack --ctstate NEW -j DROP"
    [ "$ipt" = iptables ] && echo "-A DOCKER-USER ! -i $EXT_IF -d 169.254.0.0/16 -j DROP"
    echo "-A DOCKER-USER -j RETURN"
    echo "COMMIT"
  } | "$ipt-restore" --noflush
}
apply iptables "${CF4[@]}"
apply ip6tables "${CF6[@]}"

# ufw stays disabled (see header).
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "warning: ufw is active; it does not filter Docker-published ports and conflicts with Oracle's rules. Run: sudo ufw disable" >&2
fi
echo "firewall: 80/443 restricted to ${#CF4[@]} IPv4 + ${#CF6[@]} IPv6 Cloudflare ranges on $EXT_IF; SSH per Oracle default"
