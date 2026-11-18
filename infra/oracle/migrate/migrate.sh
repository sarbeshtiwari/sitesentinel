#!/bin/sh
# One-shot migration (service `migrate` in infra/oracle/docker-compose.prod.yml). Idempotent: safe on every deploy.
set -eu
echo "[migrate] roles and extensions (bootstrap superuser)"
node /migrate/roles.mjs
cd /src/packages/db
echo "[migrate] prisma migrate deploy (wim_owner)"
prisma migrate deploy
echo "[migrate] packages/db/sql/*.sql (wim_owner)"
node scripts/apply-sql.mjs
echo "[migrate] seed (wim_owner)"
node scripts/seed.mjs
echo "[migrate] done"
