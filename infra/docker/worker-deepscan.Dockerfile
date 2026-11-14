# worker-deepscan (Phase 4E): bounded, resumable site crawler. Consumes deep-scan, re-validates each execution in the
# database (as the narrow wim_scanner role), mints per-execution, per-host capability tokens and sends EVERY request
# through the egress gateway. Never parses anything but HTML/XML/robots, never executes page scripts itself; optional
# browser-assisted discovery goes through browser-runner. Stores no artifacts (no S3 credentials).
# Networks: data + http-egress (+ browser-control only if browser-assisted discovery is offered). Never browser-egress.
# Build: docker build -f infra/docker/worker-deepscan.Dockerfile -t wim-worker-deepscan .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wim/worker-deepscan..." \
 && pnpm --filter "@wim/worker-deepscan..." run build \
 && pnpm --filter @wim/worker-deepscan deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
# Run with: read_only, cap_drop ALL, no-new-privileges.
CMD ["node", "--enable-source-maps", "dist/main.js"]
