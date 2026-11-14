# worker-browser (Phase 4D): the trusted control plane for browser monitoring. Consumes browser-monitoring, validates
# executions against the database, mints per-execution capability tokens, drives browser-runner over browser-control,
# uploads screenshots to private object storage and persists results. Never runs Chromium itself.
# Networks: data + browser-control (+ http-egress only for the gateway's classification probe). Not on browser-egress.
# Build: docker build -f infra/docker/worker-browser.Dockerfile -t wim-worker-browser .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wim/worker-browser..." \
 && pnpm --filter "@wim/worker-browser..." run build \
 && pnpm --filter @wim/worker-browser deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# Run with: read_only, cap_drop ALL, no-new-privileges.
CMD ["node", "--enable-source-maps", "dist/main.js"]
