# syntax=docker/dockerfile:1.7
# SDK delivery (/sdk/monitor.v1.js) + telemetry/heartbeat ingest. Public, hostile-input endpoint; DB role wim_ingest
# (ingest_* functions only). Networks: app (from nginx only) + data. No internet.
# Run with: read_only, cap_drop ALL, no-new-privileges.
# Multi-arch (linux/arm64 + linux/amd64): every stage uses official multi-arch images; nothing is arch-specific.
# Build: docker buildx build --platform linux/arm64 -f infra/docker/ingest.Dockerfile -t wim-ingest .
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/ingest..." \
 && pnpm --filter "@wim/ingest..." run build \
 && pnpm --filter @wim/ingest deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4200
ENV HOST=0.0.0.0 INGEST_PORT=4200
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4200/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
