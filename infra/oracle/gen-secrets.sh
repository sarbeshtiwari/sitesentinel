#!/usr/bin/env bash
# Create (or complete) the SiteSentinel env file with strong random secrets. Idempotent: existing non-placeholder
# values are kept, only missing/placeholder secrets are generated. Never prints a secret.
#   infra/oracle/gen-secrets.sh /opt/sitesentinel/.env
set -euo pipefail
ENV_FILE="${1:?usage: gen-secrets.sh <env-file>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
umask 077

if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/env.example" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1" | tr -d '\n'; }
kek_ring() {
  local key pepper
  key="$(b64 32)"; pepper="$(b64 32)"
  printf '{"current":"oracle-1","keys":{"oracle-1":"%s"},"hmacPepper":"%s"}' "$key" "$pepper" | openssl base64 -A
}

# set_secret NAME VALUE — replace NAME=GENERATED_BY_SETUP (or empty / missing) without echoing the value.
set_secret() {
  local name="$1" value="$2" current tmp
  current="$(grep -E "^${name}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  if [ -n "$current" ] && [ "$current" != "GENERATED_BY_SETUP" ]; then
    return 0
  fi
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  if grep -qE "^${name}=" "$ENV_FILE"; then
    # value contains only [A-Za-z0-9+/=]: safe for awk without escaping
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n {print n "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"; printf '%s=%s\n' "$name" "$value" >> "$tmp"
  fi
  chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
  echo "  generated $name"
}

for v in PG_SUPERUSER_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD PG_ADMIN_PASSWORD PG_WORKER_PASSWORD \
         PG_BROWSER_PASSWORD PG_SCANNER_PASSWORD PG_INGEST_PASSWORD PG_READONLY_PASSWORD REDIS_PASSWORD; do
  set_secret "$v" "$(hex 32)"
done
set_secret EGRESS_TOKEN_SECRET "$(hex 32)"
set_secret BACKUP_PASSPHRASE "$(hex 32)"
set_secret KEK_RING_JSON "$(kek_ring)"

left="$(grep -cE '=(GENERATED_BY_SETUP)$' "$ENV_FILE" || true)"
[ "$left" = "0" ] || { echo "error: $left secrets still unset in $ENV_FILE" >&2; exit 1; }
todo="$(grep -E '^[A-Z0-9_]+=TODO' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
[ -z "$todo" ] || echo "  still to fill in by hand: $todo"
