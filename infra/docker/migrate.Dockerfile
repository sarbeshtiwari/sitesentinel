# syntax=docker/dockerfile:1.7
# One-shot database migrator for the Oracle single-server stack (infra/oracle/docker-compose.prod.yml, service `migrate`).
#   1. infra/oracle/migrate/roles.mjs   — as the bootstrap superuser: owner + runtime roles, passwords, extensions (idempotent)
#   2. prisma migrate deploy            — as the schema owner wim_owner (NOT a superuser, like managed Postgres)
#   3. packages/db/scripts/apply-sql.mjs — packages/db/sql/*.sql in order (RLS, grants, functions; idempotent)
#   4. packages/db/scripts/seed.mjs      — permissions, system roles, default settings, example plans (idempotent)
# Holds a full workspace install of @wim/db (the Prisma CLI is a dev dependency); never runs as a long-lived service.
# Networks: data only. Multi-arch: Prisma downloads the schema engine for the build platform (linux-arm64 / linux-amd64).
# Build: docker buildx build --platform linux/arm64 -f infra/docker/migrate.Dockerfile -t wim-migrate .
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl: Prisma's schema engine detects the libssl version at runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/db..." \
 && pnpm --filter "@wim/db..." run build \
 && rm -rf apps tests scripts/visual docs

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PATH=/src/packages/db/node_modules/.bin:$PATH \
    PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1
WORKDIR /src
COPY --from=build --chown=node:node /src /src
COPY --chown=node:node infra/oracle/migrate/ /migrate/
USER node
CMD ["sh", "/migrate/migrate.sh"]
