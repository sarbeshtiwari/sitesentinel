#!/usr/bin/env bash
# Internal TLS for PostgreSQL: a private CA (10 years) and a server certificate for the DNS name "postgres"
# (the compose service name; clients use sslmode=verify-full). Idempotent: existing files are kept.
# The CA private key is only needed to re-issue the server certificate; it never enters a container.
#   infra/oracle/gen-pg-tls.sh /opt/sitesentinel/pg-tls
set -euo pipefail
DIR="${1:?usage: gen-pg-tls.sh <dir>}"
umask 077
mkdir -p "$DIR"
cd "$DIR"
if [ ! -f ca.key ]; then
  openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days 3650 -subj "/CN=SiteSentinel internal PostgreSQL CA" \
    -keyout ca.key -out ca.crt 2>/dev/null
  echo "  created PostgreSQL CA"
fi
if [ ! -f server.crt ] || ! openssl x509 -checkend 2592000 -noout -in server.crt >/dev/null 2>&1; then
  openssl req -new -nodes -newkey rsa:3072 -sha256 -subj "/CN=postgres" -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=DNS:postgres,DNS:sitesentinel-postgres-1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' > server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 -extfile server.ext \
    -out server.crt 2>/dev/null
  rm -f server.csr server.ext
  echo "  issued PostgreSQL server certificate (825 days)"
fi
# ca.crt + server.crt world-readable (mounted read-only into containers running as non-root); keys stay 600.
chmod 644 ca.crt server.crt
chmod 600 ca.key server.key
chmod 755 "$DIR"
