# syntax=docker/dockerfile:1.7
# worker-notify: email + in-app notifications, platform watchdog (direct alerts while PostgreSQL is down).
# Networks: data + outbound (email provider API / SMTP). Run with: read_only, cap_drop ALL, no-new-privileges.
# Multi-arch (linux/arm64 + linux/amd64): every stage uses official multi-arch images; nothing is arch-specific.
# Build: docker buildx build --platform linux/arm64 -f infra/docker/worker-notify.Dockerfile -t wim-worker-notify .
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/worker-notify..." \
 && pnpm --filter "@wim/worker-notify..." run build \
 && pnpm --filter @wim/worker-notify deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# Liveness: heartbeat rows in worker_heartbeats (admin → Operations); the process exits on fatal errors and is restarted.
CMD ["node", "--enable-source-maps", "dist/main.js"]
