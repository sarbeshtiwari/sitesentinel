#!/bin/sh
# Entrypoint wrapper: the TLS key must be owned by the postgres user with mode 0600, which a read-only bind mount from
# the host cannot guarantee (uid differs between images). Copy it into the container, then hand over to the official
# entrypoint. Certificates are generated on the server by infra/oracle/setup.sh (internal CA, never leaves the host).
set -eu
install -d -o postgres -g postgres -m 700 /var/lib/postgresql/tls
install -o postgres -g postgres -m 600 /tls-src/server.key /var/lib/postgresql/tls/server.key
install -o postgres -g postgres -m 644 /tls-src/server.crt /var/lib/postgresql/tls/server.crt
install -o postgres -g postgres -m 644 /tls-src/ca.crt /var/lib/postgresql/tls/ca.crt
exec docker-entrypoint.sh "$@"
