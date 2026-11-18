# syntax=docker/dockerfile:1.7
# worker-http: website verification, revalidation and HTTP availability monitoring (Phase 4C). Every outbound lookup and
# connection goes through the egress gateway with a per-job capability token (fails closed in production).
# Networks: data + http-egress ONLY. Run with: read_only, cap_drop ALL, no-new-privileges.
# Multi-arch (linux/arm64 + linux/amd64): every stage uses official multi-arch images; nothing is arch-specific.
# Build: docker buildx build --platform linux/arm64 -f infra/docker/worker-http.Dockerfile -t wim-worker-http .
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/worker-http..." \
 && pnpm --filter "@wim/worker-http..." run build \
 && pnpm --filter @wim/worker-http deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# Liveness: heartbeat rows in worker_heartbeats (admin → Operations); the process exits on fatal errors and is restarted.
CMD ["node", "--enable-source-maps", "dist/main.js"]
