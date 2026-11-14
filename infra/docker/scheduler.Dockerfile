# Monitoring scheduler (Phase 4B). Leaderless: run 2+ replicas for availability.
# Network: `data` only (Postgres + Redis). No egress, browser or gateway networks; holds no egress secret.
# Build: docker build -f infra/docker/scheduler.Dockerfile -t wim-scheduler .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wim/scheduler..." \
 && pnpm --filter "@wim/scheduler..." run build \
 && pnpm --filter @wim/scheduler deploy --prod --legacy /out \
 && rm -rf /out/scripts

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# Liveness: the process updates worker_heartbeats every cycle; orchestrators check the admin health API.
# Run with: read_only, cap_drop ALL, no-new-privileges, networks: data.
CMD ["node", "--enable-source-maps", "dist/main.js"]
